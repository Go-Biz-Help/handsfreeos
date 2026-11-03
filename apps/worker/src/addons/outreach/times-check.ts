/**
 * Before a message with times goes (docs/outreach.md, decision 149; ./times.ts). Once it's OK'd, on its own or by the
 * person, it waits off Today while this checks its times again (`outreach.times.check`): a reply that books one makes
 * the booking, through the person's demo link so it counts as their demo, with them when they're free on that
 * calendar (3a); one that offers times goes when every one is still open. A time taken has the message written again
 * with fresh times, up to `TIME_REDRAFTS_MOST` times, waiting for the person again when they'd OK'd it; a booking
 * refused for another reason waits for them, with why (`outreach.times.settle`).
 *
 * The web's Today books the time in a reply the person copies to send themselves (`outreach.times.book`), as they copy
 * it.
 */
import { demoRef } from '@hfos/core/addons/outreach/demos';
import {
  isTimeKind,
  KeptTime,
  TIME_REDRAFTS_MOST,
  TIME_WORDS,
  TimeBooking,
  TimesBookInput,
  type TimesBookOutput,
  type TimesSettleInput,
} from '@hfos/core/addons/outreach/meeting-times';
import type { TodayDraftOutput } from '@hfos/core/addons/outreach/today';
import { timesSettle } from '@hfos/core/addons/outreach/ops/meeting-times';
import {
  appointmentBookOnline,
  calendarAvailability,
  executeCommand,
  executeQuery,
  HfosError,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { MAX_ATTEMPTS } from '../../outbox';
import type { AddonEventContext, AddonScopeContext, AddonWorkerAction } from '../types';
import { todayDraft } from './today';

export const TIMES_BOOK_ACTION = 'outreach.times.book';

/** A message's times, with the message they go with. */
type OfferRow = {
  id: string;
  user_id: string;
  profile_id: string;
  calendar_id: string;
  host_user_id: string | null;
  times: unknown;
  booking: unknown;
  send_id: string | null;
  state: string;
  redrafts: number;
  send_state: string | null;
  send_kind: string | null;
  chat_id: string | null;
};

const OFFER_COLUMNS = sql`o.id, o.user_id, o.profile_id, o.calendar_id, o.host_user_id, o.times, o.booking,
  o.send_id, o.state, o.redrafts, s.state as send_state, s.kind as send_kind, s.chat_id`;

/** How a booking came out: made, the time taken, or refused for another reason (with why, in the person's words). */
type Booked =
  | { readonly state: 'booked'; readonly appointmentId: string }
  | { readonly state: 'taken' }
  | { readonly state: 'failed'; readonly why: string };

/** Whether each time is still open on the calendar, with the person when they're the host. */
async function stillOpen(
  ctx: AddonScopeContext,
  offer: Pick<OfferRow, 'calendar_id' | 'host_user_id'>,
  ats: readonly number[],
): Promise<boolean> {
  if (!ats.length) return true;
  if (ats.some((at) => at <= Date.now())) return false;
  const out = await executeQuery(
    ctx.db,
    calendarAvailability,
    {
      workspaceId: ctx.scope.workspaceId,
      calendarId: offer.calendar_id,
      from: new Date(Math.min(...ats)).toISOString(),
      to: new Date(Math.max(...ats) + 86_400_000).toISOString(),
      serviceId: null,
    },
    ctx.actor,
    ctx.meta,
  );
  const open = new Set(
    out.slots
      .filter((s) => !offer.host_user_id || s.userIds.includes(offer.host_user_id))
      .map((s) => Date.parse(s.startsAt)),
  );
  return ats.every((at) => open.has(at));
}

/** Why a booking was refused, in the person's words: what the calendar said, or what to look at. */
function whyNot(e: HfosError): string {
  if (e.rule === 'calendar_not_bookable' || e.code === 'not_found')
    return 'that calendar isn’t taking bookings right now.';
  if (e.code === 'validation')
    return 'the calendar needs more than a name and an email or number to book it.';
  if (e.status === 429) return 'they’ve booked a lot in the last hour.';
  return 'the calendar refused it.';
}

/** Books the time a reply confirms (2a), once: a check run again finds the booking it made (`clientId`). */
async function book(
  ctx: AddonScopeContext,
  offer: Pick<OfferRow, 'id' | 'user_id' | 'profile_id' | 'calendar_id' | 'host_user_id'>,
  booking: TimeBooking,
): Promise<Booked> {
  // With the person (3a): taken when they're no longer free then, though someone else is.
  if (offer.host_user_id) {
    const open = await stillOpen(ctx, offer, [Date.parse(booking.at)]).catch((e: unknown) => {
      if (e instanceof HfosError && e.status < 500) return false;
      throw e;
    });
    if (!open) return { state: 'taken' };
  }
  const [firstName = '', ...rest] = booking.name.trim().split(/\s+/);
  try {
    const { output } = await executeCommand(
      ctx.db,
      appointmentBookOnline,
      {
        workspaceId: ctx.scope.workspaceId,
        calendarId: offer.calendar_id,
        startsAt: booking.at,
        sessionId: booking.sessionId,
        partySize: 1,
        withUserId: offer.host_user_id,
        customer: {
          firstName,
          lastName: rest.join(' '),
          phone: booking.phone,
          email: booking.email,
        },
        smsConsent: false,
        intake: {},
        notes: 'Booked in a Social Outreach chat.',
        // The person's demo link's: it counts as their demo, and gets its reminder (decisions 24 and 106).
        linkRef: demoRef(offer.user_id, offer.profile_id),
        clientId: offer.id,
      },
      ctx.actor,
      ctx.meta,
    );
    return { state: 'booked', appointmentId: output.appointmentId };
  } catch (e) {
    if (!(e instanceof HfosError) || e.status >= 500) throw e;
    if (e.rule === 'slot_taken') return { state: 'taken' };
    return { state: 'failed', why: whyNot(e) };
  }
}

/**
 * The message written again with fresh times, as Draft a message writes it now: its first draft, and the new draft's
 * own times. Null when it's been written again enough, or can't be.
 */
async function rewritten(
  ctx: AddonScopeContext,
  offer: OfferRow,
): Promise<{ readonly text: string; readonly offerId: string | null } | null> {
  if (offer.redrafts >= TIME_REDRAFTS_MOST || !offer.send_kind || !isTimeKind(offer.send_kind))
    return null;
  try {
    const out = (await todayDraft.run(
      { ...ctx, userId: offer.user_id },
      { kind: offer.send_kind, profileId: offer.profile_id, chatId: offer.chat_id },
    )) as TodayDraftOutput;
    const text = out.drafts[0];
    return text ? { text, offerId: out.meeting?.offerId ?? null } : null;
  } catch (e) {
    // The AI busy or out of budget: it waits for the person instead.
    ctx.log.warn({ err: e, offerId: offer.id }, 'outreach: writing a message again failed');
    return null;
  }
}

/** `outreach.times.check`: an OK'd message's times checked again, its booking made, then it goes or waits. */
export async function timesCheck(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { offerId?: string };
  if (!p.offerId) return;
  const ws = ctx.scope.workspaceId;
  const [offer] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<OfferRow>(
      tx,
      sql`select ${OFFER_COLUMNS} from addon_outreach.time_offers o
          left join addon_outreach.sends s on s.id = o.send_id
          where o.workspace_id = ${ws} and o.id = ${p.offerId}`,
    ),
  );
  // Settled already, or not OK'd yet.
  if (!offer || offer.state !== 'checking') return;
  const settle = (input: Omit<TimesSettleInput, 'workspaceId' | 'offerId'>) =>
    executeCommand(
      ctx.db,
      timesSettle,
      { workspaceId: ws, offerId: offer.id, ...input },
      ctx.actor,
      ctx.meta,
    );
  // Its message skipped, sent or gone meanwhile.
  if (!offer.send_id || offer.send_state !== 'approved') {
    await settle({ state: 'dropped' });
    return;
  }
  try {
    const booking = TimeBooking.safeParse(offer.booking ?? undefined);
    const outcome: Booked | { readonly state: 'ready' } = booking.success
      ? await book(ctx, offer, booking.data)
      : (await stillOpen(
            ctx,
            offer,
            z
              .array(KeptTime)
              .catch([])
              .parse(offer.times)
              .map((t) => Date.parse(t.at)),
          ).catch((e: unknown) => {
            // The calendar gone or off: written again, it goes with the link instead.
            if (e instanceof HfosError && e.status < 500) return false;
            throw e;
          }))
        ? { state: 'ready' }
        : { state: 'taken' };
    if (outcome.state === 'booked')
      await settle({ state: 'booked', appointmentId: outcome.appointmentId });
    else if (outcome.state === 'failed') await settle({ state: 'failed', why: outcome.why });
    else if (outcome.state === 'ready') await settle({ state: 'ready' });
    else await settle({ state: 'taken', rewrite: await rewritten(ctx, offer) });
  } catch (e) {
    // Something on HandsFreeOS's side: tried again, and on the last try it waits for the person, so it's never stuck.
    if (ctx.attempt < MAX_ATTEMPTS) throw e;
    ctx.log.error({ err: e, offerId: offer.id }, 'outreach: checking a message’s times failed');
    await settle({ state: 'failed', why: 'something went wrong on our side.' });
  }
}

/**
 * `outreach.times.book`: the web's Today books the time in a reply the person copies to send themselves, the one of
 * their drafts for them with these words. Booked, or nothing to book; a time just taken is refused, to draft again.
 */
export const timesBook: AddonWorkerAction<z.input<typeof TimesBookInput>> = {
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_book_time',
    description:
      'Book the time a drafted reply confirms, as copying that reply on Today does: on the playbook’s booking page, with the email or number they gave in the chat, counted as the person’s demo. Give the reply’s words exactly as drafted. Refused when the time was just taken: draft the reply again for fresh times.',
    autonomy: 'confirm',
    keywords: ['book the time', 'book the call', 'book the demo'],
  },
  input: TimesBookInput,
  async run(ctx, raw): Promise<z.output<typeof TimesBookOutput>> {
    const input = TimesBookInput.parse(raw);
    const ws = ctx.scope.workspaceId;
    const [offer] = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<OfferRow>(
        tx,
        // The person's own, drafted in the last two days and not queued: the extension's are booked as they go.
        sql`select ${OFFER_COLUMNS} from addon_outreach.time_offers o
            left join addon_outreach.sends s on s.id = o.send_id
            where o.workspace_id = ${ws} and o.user_id = ${ctx.userId} and o.profile_id = ${input.profileId}
              and o.state = 'drafted' and o.send_id is null and o.booking is not null
              and o.created_at > now() - interval '2 days' and ${input.text} = any (o.drafts)
            order by o.created_at desc limit 1`,
      ),
    );
    const booking = TimeBooking.safeParse(offer?.booking ?? undefined);
    if (!offer || !booking.success) return { booked: null };
    const outcome = await book(ctx, offer, booking.data);
    await executeCommand(
      ctx.db,
      timesSettle,
      {
        workspaceId: ws,
        offerId: offer.id,
        state: outcome.state,
        appointmentId: outcome.state === 'booked' ? outcome.appointmentId : null,
        why: outcome.state === 'failed' ? outcome.why : null,
      },
      ctx.actor,
      ctx.meta,
    );
    if (outcome.state === 'taken')
      throw HfosError.rule('outreach_time_taken', 409, TIME_WORDS.takenNow(booking.data.says));
    if (outcome.state === 'failed')
      throw HfosError.rule(
        'outreach_time_not_booked',
        409,
        TIME_WORDS.notBooked(booking.data.says, outcome.why),
      );
    return { booked: booking.data.says };
  },
};
