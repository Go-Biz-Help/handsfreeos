/**
 * Waitlist offers for a freed 1:1 time, the worker's side: making the offer (never during quiet hours: then
 * at their end), telling the customer by text or email with the offer's link, and moving on when the offer
 * runs out, and ending a wait for a window of time once it has passed. The core commands hold the rules
 * (waitlist.offer, waitlist.expire); a seat freed in a session is booked straight away by waitlist.promote
 * instead (handlers/waitlist.ts).
 */
import { eq } from 'drizzle-orm';
import {
  automationOn,
  executeCommand,
  HfosError,
  loadCalendar,
  loadCatalogService,
  parseWaitlistOffer,
  scheduleJob,
  waitlistExpire,
  waitlistOffer,
  workspaceMessaging,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { people, waitlistEntries } from '@hfos/db/schema';
import type { JobHandler } from '../jobs';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import { clientIdFor, quietEndAt, reachOf, sendEmail, sendText, wasSent } from './deliver';
import { waitlistUrlFor } from './links';
import { offerEmail, offerText } from './messages';
import { businessOf } from './visit';

export const offerExpireKey = (entryId: string): string => `waitlist-offer:${entryId}`;
/** The job that ends a wait for a window of time when the window ends (handlers/waitlist.ts arms it). */
export const WINDOW_END_JOB = 'waitlist.window_end';
export const windowEndKey = (entryId: string): string => `waitlist-window:${entryId}`;

/** Offers a freed 1:1 time to the next person waiting for it, and tells them; in quiet hours, when they end. */
export async function offerFreedTime(
  s: WorkerServices,
  scope: TenantScope,
  appointmentId: string,
  meta: RequestMeta,
  now: number,
): Promise<void> {
  const m = await asWorker(s.db, scope, (tx) => workspaceMessaging(tx, scope.workspaceId));
  // Settings → Automations: "Waitlist slot opened" is off, so the time just stays open for anyone to book.
  if (!automationOn(m.rawSettings, 'waitlist')) return;
  const end = quietEndAt(m.settings.quietHours, m.timezone, now);
  if (end !== null) {
    await asWorker(s.db, scope, (tx) =>
      scheduleJob(tx, {
        kind: 'waitlist.offer',
        dedupeKey: `waitlist-offer-next:${appointmentId}`,
        runAt: new Date(end),
        payload: { appointmentId },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      }),
    );
    return;
  }
  const { output } = await executeCommand(
    s.db,
    waitlistOffer,
    { workspaceId: scope.workspaceId, appointmentId },
    systemActor(scope),
    meta,
  );
  if (!output.entryId || !output.expiresAt) return;
  const entryId = output.entryId;
  await asWorker(s.db, scope, (tx) =>
    scheduleJob(tx, {
      kind: 'waitlist.offer_expire',
      dedupeKey: offerExpireKey(entryId),
      runAt: new Date(output.expiresAt!),
      payload: { entryId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    }),
  );
  await tellOffer(s, scope, entryId, meta, now);
}

/** Tells a customer about their offer: a text when they agreed to texts, else an email. */
export async function tellOffer(
  s: WorkerServices,
  scope: TenantScope,
  entryId: string,
  meta: RequestMeta,
  now: number,
): Promise<void> {
  const found = await asWorker(s.db, scope, async (tx) => {
    const [e] = await tx.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId));
    const offer = e ? parseWaitlistOffer(e.offer) : null;
    if (!e || e.status !== 'offered' || !e.offerExpiresAt || !offer) return null;
    const [p] = await tx
      .select({ firstName: people.firstName, smsConsent: people.smsConsent })
      .from(people)
      .where(eq(people.id, e.personId));
    const calendar = await loadCalendar(tx, scope.workspaceId, e.calendarId);
    const service = offer.serviceId
      ? await loadCatalogService(tx, scope.workspaceId, offer.serviceId)
      : null;
    return {
      e,
      offer,
      until: e.offerExpiresAt.getTime(),
      firstName: (p?.firstName ?? '').trim(),
      timeZone: calendar.timeZone,
      title: service?.name ?? calendar.name,
      business: await businessOf(tx, s, scope.workspaceId, calendar),
      url: await waitlistUrlFor(tx, s.bookingLinks, e.id),
      reach: await reachOf(
        tx,
        scope.workspaceId,
        {
          phone: e.contactPhoneE164,
          email: e.contactEmail,
          smsOk: e.smsOk,
          personConsent: p?.smsConsent ?? 'unknown',
        },
        { text: true, email: true },
      ),
    };
  });
  if (!found?.url) return;
  const f = found;
  const input = {
    title: f.title,
    startsAt: Date.parse(f.offer.startsAt),
    endsAt: Date.parse(f.offer.endsAt),
    timeZone: f.timeZone,
    until: f.until,
    now,
    url: f.url!,
    business: f.business,
    firstName: f.firstName,
  };
  const clientId = clientIdFor('offer', entryId, f.offer.offeredAt);
  if (f.reach.text === null) {
    const sent = await sendText(
      s,
      scope,
      f.e.contactPhoneE164!,
      offerText({ ...input, first: f.reach.firstText }),
      clientId,
      meta,
    );
    if (wasSent(sent)) return;
  }
  if (f.reach.email === null)
    await sendEmail(
      s,
      scope,
      f.e.contactEmail!,
      offerEmail({ ...input, first: false }),
      clientId,
      meta,
    );
}

/** An offer deferred past quiet hours. */
export const waitlistOfferJob: JobHandler = async (ctx) => {
  const appointmentId = String(ctx.job.payload['appointmentId'] ?? '');
  if (!appointmentId) return;
  await offerFreedTime(
    ctx,
    tenantOf(ctx.scope),
    appointmentId,
    workerMeta(null, ctx.job.id),
    ctx.now,
  );
};

/**
 * An offer's time is up: it lapses, and the time goes to the next person waiting when it's still free. The same
 * job ends a wait for a window of time once the window is over (WINDOW_END_JOB): the entry expires, quietly. A
 * window that ends while its offer still stands waits for the offer.
 */
export const waitlistOfferExpire: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const entryId = String(ctx.job.payload['entryId'] ?? '');
  const meta = workerMeta(null, ctx.job.id);
  let output;
  try {
    ({ output } = await executeCommand(
      ctx.db,
      waitlistExpire,
      { workspaceId: scope.workspaceId, entryId },
      systemActor(scope),
      meta,
    ));
  } catch (e) {
    // Removed along with its session or calendar: nothing left to expire.
    if (e instanceof HfosError && e.code === 'not_found') return;
    throw e;
  }
  if (!output.expired)
    return output.expiresAt ? { rescheduleAt: new Date(output.expiresAt) } : undefined;
  if (output.status === 'expired' && output.fromAppointmentId)
    await offerFreedTime(ctx, scope, output.fromAppointmentId, meta, ctx.now);
};
