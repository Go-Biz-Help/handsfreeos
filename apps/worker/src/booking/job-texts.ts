/**
 * What the customer hears as their job moves along (M18 step 4): a text on every status change — on the way
 * (with when to expect them, from the driving time), started, waiting on parts, done — and when the team changes
 * the note they may see. Only to a number that agreed and never said STOP, never in quiet hours (a status text
 * that would wait until morning is stale by then, so it doesn't go), once per change (a fixed clientId).
 */
import { asc, eq } from 'drizzle-orm';
import type { JobStatus } from '@hfos/core/server';
import { sql } from '@hfos/db/client';
import { appointmentAttendees, jobs } from '@hfos/db/schema';
import { placeOf } from '../geo/geocoder';
import type { EventHandler } from '../handlers/types';
import { tenantOf, workerMeta } from '../services';
import { clientIdFor, reachOf, sendText, wasSent } from './deliver';
import { inSentence, joinNames, STOP_WORDING } from './messages';
import { loadBooking } from './visit';
import { clock } from './when';

type Payload = Record<string, unknown>;

export interface JobTextInput {
  readonly business: string;
  readonly title: string;
  readonly status: JobStatus;
  /** Only the note changed. */
  readonly noteOnly: boolean;
  readonly note: string | null;
  /** First names of who's coming, the host first. */
  readonly staff: readonly string[];
  /** On the way: minutes out and the clock time, in the business's zone. */
  readonly eta: { readonly minutes: number; readonly at: string } | null;
  readonly first: boolean;
}

/** The text for a job's change, or null when this change doesn't get one. */
export function jobText(i: JobTextInput): string | null {
  const t = inSentence(i.title);
  const who = i.staff.length ? joinNames(i.staff) : 'Our tech';
  const line = i.noteOnly
    ? i.note
      ? `${i.business}: An update on your ${t}: ${i.note}`
      : null
    : {
        scheduled: null,
        on_the_way: `${i.business}: ${who} ${i.staff.length > 1 ? 'are' : 'is'} on the way for your ${t}${
          i.eta ? `, arriving around ${i.eta.at} (about ${i.eta.minutes} min)` : ''
        }.`,
        in_progress: `${i.business}: ${who} ${i.staff.length > 1 ? 'have' : 'has'} started your ${t}.`,
        waiting_on_parts: `${i.business}: Your ${t} is waiting on parts. We'll let you know when we're back.`,
        done: `${i.business}: Your ${t} is done. Thank you!`,
        cancelled: null,
      }[i.status];
  if (!line) return null;
  return [
    line,
    !i.noteOnly && i.note ? `Note from us: ${i.note}` : null,
    i.first ? STOP_WORDING : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** `job.status_changed`: the text for the customer of the visit it was set on. */
export const onJobStatusChanged: EventHandler = async (ctx) => {
  const p = (ctx.event.payload ?? {}) as Payload;
  const appointmentId = ctx.event.entityId;
  const jobId = typeof p['jobId'] === 'string' ? p['jobId'] : null;
  if (!appointmentId || !jobId || p['notify'] === false) return;
  if (!p['statusChanged'] && !p['noteChanged']) return;
  const [job] = await ctx.tx.select().from(jobs).where(eq(jobs.id, jobId));
  // Moved on again before this ran: the newer change sends its own text.
  if (!job || (p['statusChanged'] && job.status !== p['status'])) return;
  const [attendee] = await ctx.tx
    .select({ id: appointmentAttendees.id })
    .from(appointmentAttendees)
    .where(eq(appointmentAttendees.appointmentId, appointmentId))
    .orderBy(asc(appointmentAttendees.createdAt), asc(appointmentAttendees.id))
    .limit(1);
  if (!attendee) return;
  const booking = await loadBooking(ctx.tx, ctx, attendee.id);
  if (!booking || booking.attendee.status !== 'booked') return;
  const ws = booking.appt.workspaceId;
  const reach = await reachOf(
    ctx.tx,
    ws,
    {
      phone: booking.attendee.contactPhoneE164,
      email: booking.attendee.contactEmail,
      smsOk: booking.attendee.smsOk,
      personConsent: booking.person.smsConsent,
    },
    { text: true, email: false },
  );
  const status = job.status as JobStatus;
  const eta = status === 'on_the_way' && !p['noteChanged'] ? await etaOf(ctx, p, booking) : null;
  if (eta)
    await ctx.tx.execute(
      sql`update app.jobs set eta_at = ${new Date(eta.atMs).toISOString()} where id = ${job.id}`,
    );
  if (reach.text) {
    ctx.log.info({ jobId, why: reach.text }, 'no text for a job’s change');
    return;
  }
  const body = jobText({
    business: booking.business.name,
    title: booking.visit.title,
    status,
    noteOnly: !p['statusChanged'],
    note: job.customerNote,
    staff: booking.visit.staff,
    eta: eta ? { minutes: eta.minutes, at: clock(eta.atMs, booking.visit.timeZone) } : null,
    first: reach.firstText,
  });
  if (!body) return;
  const sent = await sendText(
    ctx,
    tenantOf(ctx.scope),
    booking.attendee.contactPhoneE164!,
    body,
    clientIdFor('job_status', ctx.event.id, attendee.id),
    workerMeta(ctx.event.correlationId, ctx.event.id),
  );
  if (!wasSent(sent)) ctx.log.info({ jobId, why: sent.refused }, 'a job’s text didn’t go');
};

/** On the way: minutes from where the tech tapped to the visit's address, and when that lands. */
async function etaOf(
  ctx: Parameters<EventHandler>[0],
  p: Payload,
  booking: NonNullable<Awaited<ReturnType<typeof loadBooking>>>,
): Promise<{ minutes: number; atMs: number } | null> {
  const origin = p['origin'] as { lat?: unknown; lng?: unknown } | undefined;
  if (typeof origin?.lat !== 'number' || typeof origin.lng !== 'number') return null;
  if (booking.visit.locationKind !== 'customer_address' || !booking.visit.address) return null;
  const place = await placeOf(ctx.tx, ctx.geocoder, booking.visit.address);
  if (!place) return null;
  const minutes = await ctx.driving.minutes({ lat: origin.lat, lng: origin.lng }, place);
  if (minutes === null) return null;
  return { minutes, atMs: ctx.event.createdAt.getTime() + minutes * 60_000 };
}
