/**
 * Times to meet, in the chat (docs/outreach.md, decision 149; ../meeting-times.ts). A drafted message that offers
 * times on a booking page's calendar, or books one, keeps them (`outreach.times.keep`, by the worker as it drafts).
 * The message queued from one of its drafts takes them (`attachTimes`, in `outreach.send.queue`), and once it's OK'd,
 * on its own or by the person (`approveTimes`, in `outreach.send.approve`), it waits while the worker checks the times
 * again and makes the booking (`outreach.times.check`), then goes, or is written again with fresh times
 * (`outreach.times.settle`). Each person's own.
 */
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import { outreachAddon } from '../manifest';
import {
  TIME_WORDS,
  TimesKeepInput,
  TimesKeepOutput,
  TimesSettleInput,
  TimesSettleOutput,
} from '../meeting-times';
import { profiles, sends, timeOffers } from '../tables';
import { inWorkspace } from './common';

/** How long a draft's times wait to be queued: a draft older than this is never sent as it is. */
const DRAFT_KEPT_MS = 2 * 86_400_000;

async function askForCheck(
  ctx: CommandContext,
  offer: { readonly id: string; readonly userId: string; readonly profileId: string },
): Promise<void> {
  await ctx.emit({
    type: 'outreach.times.check',
    entityType: 'outreach_profile',
    entityId: offer.profileId,
    payload: { offerId: offer.id, userId: offer.userId },
  });
}

/**
 * The message just queued takes the times of the draft it is: the person's latest drafted for them with these words.
 * Going on its own, its times are checked (and its booking made) before it goes.
 */
export async function attachTimes(
  ctx: CommandContext,
  me: string,
  send: {
    readonly sendId: string;
    readonly profileId: string;
    readonly text: string;
    readonly goes: boolean;
  },
): Promise<void> {
  const ws = ctx.scope.workspaceId!;
  const at = changeMoment(ctx.meta);
  const [offer] = await ctx.tx
    .select({ id: timeOffers.id })
    .from(timeOffers)
    .where(
      and(
        eq(timeOffers.workspaceId, ws),
        eq(timeOffers.userId, me),
        eq(timeOffers.profileId, send.profileId),
        eq(timeOffers.state, 'drafted'),
        isNull(timeOffers.sendId),
        gt(timeOffers.createdAt, new Date(at.getTime() - DRAFT_KEPT_MS)),
        sql`${send.text} = any (${timeOffers.drafts})`,
      ),
    )
    .orderBy(desc(timeOffers.createdAt))
    .limit(1);
  if (!offer) return;
  await ctx.tx
    .update(timeOffers)
    .set({ sendId: send.sendId, state: send.goes ? 'checking' : 'drafted', updatedAt: at })
    .where(eq(timeOffers.id, offer.id));
  if (send.goes) await askForCheck(ctx, { id: offer.id, userId: me, profileId: send.profileId });
}

/** Messages the person OK'd: their times are checked (and bookings made) before they go. */
export async function approveTimes(
  ctx: CommandContext,
  me: string,
  sendIds: readonly string[],
): Promise<void> {
  if (!sendIds.length) return;
  const at = changeMoment(ctx.meta);
  const offers = await ctx.tx
    .update(timeOffers)
    .set({ state: 'checking', approvedByPerson: true, updatedAt: at })
    .where(
      and(
        eq(timeOffers.workspaceId, ctx.scope.workspaceId!),
        eq(timeOffers.userId, me),
        inArray(timeOffers.sendId, [...sendIds]),
        eq(timeOffers.state, 'drafted'),
      ),
    )
    .returning({ id: timeOffers.id, userId: timeOffers.userId, profileId: timeOffers.profileId });
  for (const o of offers) await askForCheck(ctx, o);
}

export const timesKeep = defineAddonCommand(outreachAddon, {
  name: 'outreach.times.keep',
  description:
    'Worker: the open times a drafted message offers on a booking page’s calendar, and the booking a reply makes, kept for the message queued from one of its drafts.',
  risk: 0,
  input: TimesKeepInput,
  output: TimesKeepOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    if (!input.times.length && !input.booking) return { offerId: null };
    const [profile] = await ctx.tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, input.profileId)));
    const [calendar] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.calendars where workspace_id = ${ws} and id = ${input.calendarId}`,
    );
    if (!profile || !calendar) return { offerId: null };
    const at = changeMoment(ctx.meta);
    const [row] = await ctx.tx
      .insert(timeOffers)
      .values({
        workspaceId: ws,
        userId: input.userId,
        profileId: profile.id,
        calendarId: calendar.id,
        hostUserId: input.hostUserId,
        zone: input.zone,
        times: input.times,
        booking: input.booking,
        drafts: input.drafts,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: timeOffers.id });
    return { offerId: row!.id };
  },
});

export const timesSettle = defineAddonCommand(outreachAddon, {
  name: 'outreach.times.settle',
  description:
    'Worker: how the check of an OK’d message’s times came out. Still open, or booked: it goes. A time taken: it goes as written again with fresh times, waiting for the person again when they had OK’d it. Not booked for another reason: it waits for the person, with why.',
  risk: 0,
  input: TimesSettleInput,
  output: TimesSettleOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.times.check', 'outreach.send.queued'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [offer] = await ctx.tx
      .select()
      .from(timeOffers)
      .where(and(eq(timeOffers.workspaceId, ws), eq(timeOffers.id, input.offerId)));
    // Settled once: a second check of the same message changes nothing.
    if (!offer || (offer.state !== 'drafted' && offer.state !== 'checking'))
      return { settled: false };
    await ctx.tx
      .update(timeOffers)
      .set({
        state: input.state,
        appointmentId: input.appointmentId,
        why: input.why,
        updatedAt: at,
        // Written again, its message takes the new draft's times instead.
        ...(input.state === 'taken' && input.rewrite?.offerId ? { sendId: null } : {}),
      })
      .where(eq(timeOffers.id, offer.id));
    if (input.state !== 'taken' && input.state !== 'failed') return { settled: true };
    const [send] = offer.sendId
      ? await ctx.tx
          .select()
          .from(sends)
          .where(and(eq(sends.workspaceId, ws), eq(sends.id, offer.sendId)))
      : [];
    if (!send || (send.state !== 'approved' && send.state !== 'waiting')) return { settled: true };
    const says = offer.booking?.says ?? offer.times[0]?.says ?? 'that time';
    const rewrite = input.state === 'taken' ? input.rewrite : null;
    // Waits for the person: they OK'd what it said before, or it couldn't be booked or written again.
    const needsYou =
      input.state === 'failed'
        ? TIME_WORDS.notBooked(says, input.why ?? 'the calendar refused it.')
        : !rewrite
          ? TIME_WORDS.takenWaits(says)
          : offer.approvedByPerson
            ? TIME_WORDS.rewritten
            : null;
    await ctx.tx
      .update(sends)
      .set({
        ...(rewrite ? { text: rewrite.text, drafted: rewrite.text } : {}),
        ...(needsYou
          ? { state: 'waiting' as const, approvedAt: null, handedOver: true, needsYou }
          : {}),
        updatedAt: at,
      })
      .where(eq(sends.id, send.id));
    if (rewrite?.offerId) {
      // The new draft's times go with the message: checked again at once when it goes on its own, else at its OK.
      const [next] = await ctx.tx
        .update(timeOffers)
        .set({
          sendId: send.id,
          state: needsYou ? 'drafted' : 'checking',
          redrafts: offer.redrafts + 1,
          updatedAt: at,
        })
        .where(
          and(
            eq(timeOffers.workspaceId, ws),
            eq(timeOffers.id, rewrite.offerId),
            eq(timeOffers.state, 'drafted'),
            isNull(timeOffers.sendId),
          ),
        )
        .returning({
          id: timeOffers.id,
          userId: timeOffers.userId,
          profileId: timeOffers.profileId,
        });
      if (next && !needsYou) await askForCheck(ctx, next);
    }
    // Back with the person: it pushes to their phone at once, as a reply handed over does.
    if (needsYou)
      await ctx.emit({
        type: 'outreach.send.queued',
        entityType: 'outreach_profile',
        entityId: send.profileId,
        payload: {
          kind: send.kind,
          waits: true,
          userId: send.userId,
          handOver: true,
          why: needsYou,
        },
      });
    return { settled: true };
  },
});

export const meetingTimeCommands = [timesKeep, timesSettle] as const;
