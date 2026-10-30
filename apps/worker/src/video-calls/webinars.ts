/**
 * A webinar's messages (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, the owner's 24), each through message.send as
 * the system, so quiet hours, STOP and the conversation work as for any message: a text when one may go, else an
 * email. Each has a fixed clientId, so a retry sends once.
 *
 * - **Starting now** (`webinar.starting`, every minute for the whole server): at a webinar's start, everyone booked
 *   who isn't in the call yet gets their own Join link. The call keeps when it went (`video_call.starting_told`), so
 *   it goes once. Off with the calendar's `webinar.startingNow`.
 * - **Missed it** (`webinar.missed`, from `attendee.no_show`): someone marked a no-show is told when the next session
 *   on the same calendar with seats is, with its link anyone can use, or that they'll hear about the next one. Waits
 *   out quiet hours. Off with the calendar's `webinar.missedFollowUp`.
 * - **Their own Join link again** (`webinar.join_link`): someone already on file used the link anyone can use, so
 *   their own Join link goes to the phone or email the business has for them, never back to the page.
 */
import {
  fmtAt,
  webinarDoorPath,
  webinarJoinLinkWords,
  webinarMissedWords,
  webinarStartingWords,
} from '@hfos/core';
import {
  executeCommand,
  loadCalendar,
  scheduleJob,
  videoCallStartingTold,
  workspaceMessaging,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { joinUrlFor } from '../booking/links';
import { STOP_WORDING } from '../booking/messages';
import { clientIdFor, quietEndAt, reachOf, sendEmail, sendText, wasSent } from '../booking/deliver';
import { businessOf } from '../booking/visit';
import type { EventHandler } from '../handlers/types';
import { publicOrigin } from '../hosting/origin';
import type { JobContext, JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { payloadOf, str } from '../push/moment';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';

export const WEBINAR_STARTING_JOB = 'webinar.starting';
export const WEBINAR_STARTING_KEY = 'webinar:starting';
export const WEBINAR_MISSED_JOB = 'webinar.missed';
export const WEBINAR_JOIN_LINK_JOB = 'webinar.join_link';
const EVERY_MS = 60_000;
const BATCH = 50;
/** Their own Join link goes again at most this often, however many times the form is sent. */
const JOIN_LINK_EVERY_MS = 10 * 60_000;
/** Each message has its own switch on the calendar, so it may go either way. */
const ALL_CHANNELS = { text: true, email: true } as const;

interface Person {
  readonly attendeeId: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly smsOk: boolean;
  readonly personConsent: 'unknown' | 'opted_in' | 'opted_out';
  readonly firstName: string | null;
}

interface Words {
  readonly text: string;
  readonly subject: string;
  readonly email: string;
}

type Told =
  { readonly sent: 'sms' | 'email' } | { readonly quietUntil: number } | { readonly not: string };

/**
 * One message to one person: a text when one may go and it isn't quiet hours, else an email. With `waitOutQuiet`, a
 * text that would land in quiet hours waits for them to end instead (the caller runs again then).
 */
async function tell(
  s: WorkerServices,
  scope: TenantScope,
  who: Person,
  words: Words,
  clientId: string,
  meta: RequestMeta,
  opts: { readonly now: number; readonly waitOutQuiet?: boolean },
): Promise<Told> {
  const { reach, m } = await asWorker(s.db, scope, async (tx) => ({
    reach: await reachOf(tx, scope.workspaceId, who, ALL_CHANNELS),
    m: await workspaceMessaging(tx, scope.workspaceId),
  }));
  let why = reach.text;
  if (why === null) {
    const quiet = quietEndAt(m.settings.quietHours, m.timezone, opts.now);
    if (quiet !== null && opts.waitOutQuiet) return { quietUntil: quiet };
    if (quiet === null) {
      const body = reach.firstText ? `${words.text} ${STOP_WORDING}` : words.text;
      const sent = await sendText(s, scope, who.phone!, body, clientId, meta);
      if (wasSent(sent)) return { sent: 'sms' };
      why = sent.refused;
    } else why = 'quiet_hours';
  }
  if (reach.email === null) {
    const sent = await sendEmail(
      s,
      scope,
      who.email!,
      { subject: words.subject, body: words.email },
      clientId,
      meta,
    );
    if (wasSent(sent)) return { sent: 'email' };
    return { not: sent.refused };
  }
  return { not: why ?? 'no_contact' };
}

const personRow = (r: {
  attendee_id: string;
  phone: string | null;
  email: string | null;
  sms_ok: boolean;
  sms_consent: 'unknown' | 'opted_in' | 'opted_out';
  first_name: string | null;
}): Person => ({
  attendeeId: r.attendee_id,
  phone: r.phone,
  email: r.email,
  smsOk: r.sms_ok,
  personConsent: r.sms_consent,
  firstName: r.first_name,
});

/**
 * The people booked on a session (or marked a no-show, with `status`), with how to reach each; `notIn` leaves out
 * anyone in its call right now.
 */
async function bookedOn(
  tx: Tx,
  appointmentId: string,
  opts: {
    readonly attendeeId?: string;
    readonly notIn?: string;
    readonly status?: 'booked' | 'no_show';
  } = {},
): Promise<Person[]> {
  const list = await rows<{
    attendee_id: string;
    phone: string | null;
    email: string | null;
    sms_ok: boolean;
    sms_consent: 'unknown' | 'opted_in' | 'opted_out';
    first_name: string | null;
  }>(
    tx,
    sql`select aa.id as attendee_id, aa.contact_phone_e164 as phone, aa.contact_email as email, aa.sms_ok,
          p.sms_consent, p.first_name
        from app.appointment_attendees aa
        join app.people p on p.id = aa.person_id
        where aa.appointment_id = ${appointmentId} and aa.status = ${opts.status ?? 'booked'}::app.attendee_status
          and aa.bin_item_id is null
          and (${opts.attendeeId ?? null}::uuid is null or aa.id = ${opts.attendeeId ?? null}::uuid)
          and (${opts.notIn ?? null}::uuid is null or not exists (
            select 1 from app.video_call_people v
            where v.video_call_id = ${opts.notIn ?? null}::uuid and v.attendee_id = aa.id
              and v.last_joined_at is not null and (v.left_at is null or v.left_at < v.last_joined_at)))
        order by aa.created_at, aa.id`,
  );
  return list.map(personRow);
}

// ---------- starting now ----------

export const webinarStarting: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      call_id: string;
      appointment_id: string;
      workspace_id: string;
      organization_id: string;
    }>(tx, sql`select * from private.webinars_starting(${BATCH})`),
  );
  for (const d of due) {
    const scope = { workspaceId: d.workspace_id, organizationId: d.organization_id };
    try {
      await tellStarting(ctx, scope, d.call_id, d.appointment_id);
    } catch (e) {
      // One webinar's trouble never holds up the rest; it's still due at the next run, and the sent ones dedupe.
      ctx.log.warn(
        { callId: d.call_id, err: errorMessage(e) },
        'could not say a webinar is starting',
      );
    }
  }
  return { rescheduleAt: new Date(ctx.now + EVERY_MS) };
};

async function tellStarting(
  ctx: JobContext,
  scope: TenantScope,
  callId: string,
  appointmentId: string,
): Promise<void> {
  const meta = workerMeta(null, ctx.job.id);
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [a] = await rows<{ title: string; calendar_id: string; starts_at: Date | string }>(
      tx,
      sql`select title, calendar_id, starts_at from app.appointments where id = ${appointmentId}`,
    );
    if (!a) return null;
    const calendar = await loadCalendar(tx, scope.workspaceId, a.calendar_id);
    if (!calendar.config.locations.webinar.startingNow) return { off: true as const };
    const business = await businessOf(tx, ctx, scope.workspaceId, calendar);
    const people = await bookedOn(tx, appointmentId, { notIn: callId });
    const links = new Map<string, string>();
    for (const p of people) {
      const link = await joinUrlFor(tx, ctx.bookingLinks, p.attendeeId);
      if (link) links.set(p.attendeeId, link);
    }
    return {
      off: false as const,
      title: a.title,
      startIso: new Date(a.starts_at).toISOString(),
      business: business.name,
      people,
      links,
    };
  });
  let sent = 0;
  if (found && !found.off) {
    for (const p of found.people) {
      const link = found.links.get(p.attendeeId);
      if (!link) continue;
      const told = await tell(
        ctx,
        scope,
        p,
        webinarStartingWords({
          title: found.title,
          business: found.business,
          firstName: p.firstName,
          link,
        }),
        clientIdFor('webinar-starting', p.attendeeId, found.startIso),
        meta,
        { now: ctx.now },
      );
      if ('sent' in told) sent += 1;
    }
  }
  await executeCommand(
    ctx.db,
    videoCallStartingTold,
    { workspaceId: scope.workspaceId, callId, sent },
    systemActor(scope),
    meta,
  );
}

// ---------- missed it ----------

/** Someone missed a session: when it was a webinar's, the follow-up is queued (and waits out quiet hours). */
export const onWebinarNoShow: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const attendeeId = str(p['attendeeId']);
  const appointmentId = str(p['appointmentId']);
  if (!attendeeId || !appointmentId) return;
  const [call] = await rows<{ id: string }>(
    ctx.tx,
    sql`select id from app.video_calls where appointment_id = ${appointmentId} and format = 'webinar'`,
  );
  if (!call) return;
  const scope = tenantOf(ctx.scope);
  await scheduleJob(ctx.tx, {
    kind: WEBINAR_MISSED_JOB,
    dedupeKey: `webinar-missed:${attendeeId}`,
    runAt: new Date(),
    payload: { attendeeId, appointmentId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
};

export const webinarMissed: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const attendeeId = str(ctx.job.payload['attendeeId']);
  const appointmentId = str(ctx.job.payload['appointmentId']);
  if (!attendeeId || !appointmentId) return;
  const found = await asWorker(ctx.db, scope, async (tx) => {
    // Still a no-show (marked as having come after all, or cancelled: nothing to say).
    const [who] = await bookedOn(tx, appointmentId, { attendeeId, status: 'no_show' });
    if (!who) return null;
    const [a] = await rows<{
      title: string;
      calendar_id: string;
      starts_at: Date | string;
      person_id: string;
    }>(
      tx,
      sql`select a.title, a.calendar_id, a.starts_at, aa.person_id
          from app.appointment_attendees aa join app.appointments a on a.id = aa.appointment_id
          where aa.id = ${attendeeId} and a.id = ${appointmentId}`,
    );
    if (!a) return null;
    const calendar = await loadCalendar(tx, scope.workspaceId, a.calendar_id);
    if (!calendar.config.locations.webinar.missedFollowUp) return null;
    // Booked on a later one already: they're coming, so nothing to ask.
    const later = await rows(
      tx,
      sql`select 1 from app.appointment_attendees aa join app.appointments a on a.id = aa.appointment_id
          where aa.person_id = ${a.person_id} and aa.status = 'booked' and a.calendar_id = ${a.calendar_id}
            and a.status = 'scheduled' and a.starts_at > now() and a.bin_item_id is null
          limit 1`,
    );
    if (later.length) return null;
    const [next] = await rows<{ starts_at: Date | string; door_key: string }>(
      tx,
      sql`select a.starts_at, c.door_key
          from app.appointments a join app.video_calls c on c.appointment_id = a.id
          where a.calendar_id = ${a.calendar_id} and a.kind = 'session' and a.status = 'scheduled'
            and a.bin_item_id is null and a.starts_at > now() and a.seats_taken < a.capacity
            and c.format = 'webinar' and c.door_key is not null
          order by a.starts_at limit 1`,
    );
    const business = await businessOf(tx, ctx, scope.workspaceId, calendar);
    const origin = next ? await publicOrigin(tx, scope.workspaceId, ctx.bookingLinks.webUrl) : null;
    return {
      title: a.title,
      startIso: new Date(a.starts_at).toISOString(),
      business: business.name,
      who,
      next: next
        ? {
            when: fmtAt(new Date(next.starts_at).getTime(), calendar.timeZone),
            link: `${origin}${webinarDoorPath(next.door_key)}`,
          }
        : null,
    };
  });
  if (!found) return;
  const told = await tell(
    ctx,
    scope,
    found.who,
    webinarMissedWords({
      title: found.title,
      business: found.business,
      firstName: found.who.firstName,
      next: found.next,
    }),
    clientIdFor('webinar-missed', attendeeId, found.startIso),
    workerMeta(null, ctx.job.id),
    { now: ctx.now, waitOutQuiet: true },
  );
  if ('quietUntil' in told) return { rescheduleAt: new Date(told.quietUntil) };
  if ('not' in told)
    ctx.log.info({ attendeeId, why: told.not }, 'a webinar’s missed-it message didn’t go');
};

// ---------- their own Join link again ----------

/** Queues their own Join link, at most once every ten minutes however often the form is sent. */
export async function queueJoinLink(
  tx: Tx,
  scope: TenantScope,
  attendeeId: string,
  now: number,
): Promise<void> {
  await scheduleJob(tx, {
    kind: WEBINAR_JOIN_LINK_JOB,
    dedupeKey: `webinar-join:${attendeeId}:${Math.floor(now / JOIN_LINK_EVERY_MS)}`,
    runAt: new Date(now),
    payload: { attendeeId, bucket: Math.floor(now / JOIN_LINK_EVERY_MS) },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
}

export const webinarJoinLink: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const attendeeId = str(ctx.job.payload['attendeeId']);
  if (!attendeeId) return;
  const bucket = String(ctx.job.payload['bucket'] ?? '');
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [a] = await rows<{
      id: string;
      title: string;
      calendar_id: string;
      starts_at: Date | string;
      ends_at: Date | string;
    }>(
      tx,
      sql`select a.id, a.title, a.calendar_id, a.starts_at, a.ends_at
          from app.appointment_attendees aa join app.appointments a on a.id = aa.appointment_id
          where aa.id = ${attendeeId} and a.status = 'scheduled'`,
    );
    if (!a) return null;
    const [who] = await bookedOn(tx, a.id, { attendeeId });
    const link = await joinUrlFor(tx, ctx.bookingLinks, attendeeId);
    if (!who || !link) return null;
    const calendar = await loadCalendar(tx, scope.workspaceId, a.calendar_id);
    const business = await businessOf(tx, ctx, scope.workspaceId, calendar);
    return {
      who,
      words: webinarJoinLinkWords({
        title: a.title,
        business: business.name,
        firstName: who.firstName,
        when: fmtAt(new Date(a.starts_at).getTime(), calendar.timeZone),
        link,
      }),
    };
  });
  if (!found) return;
  const told = await tell(
    ctx,
    scope,
    found.who,
    found.words,
    clientIdFor('webinar-join', attendeeId, bucket),
    workerMeta(null, ctx.job.id),
    { now: ctx.now },
  );
  if ('not' in told) ctx.log.info({ attendeeId, why: told.not }, 'a webinar’s Join link didn’t go');
};
