/**
 * Each person's conversations (../conversation.ts, docs/outreach.md decisions 65 to 67): what a step, a follow-up, a
 * check-in or a reply going does to one (`noteSent`), and what the AI read in their answer (`noteAnswer`). Kept in
 * `follow_ups`, one per person and profile, each person's own. Today reads it (./today.ts).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { mainOffers } from '@hfos/db/schema';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { scopeCan } from '../../../kernel/execute';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import type { MessageKind } from '../automation';
import {
  AnswerNoteInput,
  AnswerNoteOutput,
  checkInAfter,
  ConversationNoteInput,
  ConversationNoteOutput,
  ConversationStopInput,
  ConversationStopOutput,
  JUDGE_AFTER_MESSAGES,
  nextAfter,
  OfferVersionsInput,
  OfferVersionsOutput,
  STEP_OF_KIND,
  type Answer,
} from '../conversation';
import { outreachAddon } from '../manifest';
import { paceOf, type Pace } from '../playbooks';
import { followUps, playbooks, profiles, stages } from '../tables';
import { EVER } from './activity';
import { inWorkspace, type Ctx } from './common';
import { numbersIn } from './tracking';

/**
 * The pace a conversation keeps: the first playbook in use with one, by name, as Today's demo link is picked; the
 * starting pace with none.
 */
export async function conversationPace(ctx: Ctx): Promise<Pace> {
  const [first] = await ctx.tx
    .select({ details: playbooks.details })
    .from(playbooks)
    .where(
      and(eq(playbooks.workspaceId, ctx.scope.workspaceId!), sql`${playbooks.archivedAt} is null`),
    )
    .orderBy(asc(playbooks.name))
    .limit(1);
  const details = first?.details as { pace?: unknown } | undefined;
  return paceOf(details?.pace ?? null);
}

/** The main offer's version a message to them goes with: the one they were first pitched with, else the live one. */
export async function offerVersionFor(
  ctx: Ctx,
  me: string,
  profileId: string,
): Promise<number | null> {
  const ws = ctx.scope.workspaceId!;
  const [kept] = await ctx.tx
    .select({ version: followUps.offerVersion })
    .from(followUps)
    .where(
      and(
        eq(followUps.workspaceId, ws),
        eq(followUps.userId, me),
        eq(followUps.profileId, profileId),
      ),
    );
  if (kept?.version) return kept.version;
  const [offer] = await ctx.tx
    .select({ live: mainOffers.liveVersion })
    .from(mainOffers)
    .where(eq(mainOffers.workspaceId, ws));
  return offer?.live ?? null;
}

async function kept(ctx: Ctx, me: string, profileId: string) {
  const [row] = await ctx.tx
    .select()
    .from(followUps)
    .where(
      and(
        eq(followUps.workspaceId, ctx.scope.workspaceId!),
        eq(followUps.userId, me),
        eq(followUps.profileId, profileId),
      ),
    )
    .for('update');
  return row ?? null;
}

/**
 * A message went to someone (sent by the extension, or copied from a draft): a step starts their conversation over
 * at it, with follow-ups to come; a follow-up counts one more; a check-in waits a month; a reply after their answer
 * starts the follow-ups again, or a check-in a month on when they said not now. A step, or a reply to anything but a
 * no, goes on with a conversation the person stopped (`outreach.conversation.stop`). Reconnect leaves it be: its
 * messages carry no pitch.
 */
export async function noteSent(
  ctx: Ctx,
  me: string,
  sent: {
    readonly profileId: string;
    readonly kind: MessageKind;
    readonly at: Date;
    readonly offerVersion: number | null;
  },
): Promise<void> {
  if (sent.kind === 'reconnect') return;
  const ws = ctx.scope.workspaceId!;
  const at = sent.at;
  const row = await kept(ctx, me, sent.profileId);
  const step = STEP_OF_KIND[sent.kind];
  const pace = await conversationPace(ctx);
  if (step) {
    const set = {
      step,
      stepAt: at,
      sent: 0,
      lastAt: at,
      ...nextAfter(pace, 0, at),
      answer: null,
      answeredAt: null,
      // A step sent goes on with a conversation the person stopped.
      stoppedAt: null,
      // Anyone pitched keeps their version: the first step's.
      offerVersion: row?.offerVersion ?? sent.offerVersion,
      updatedAt: at,
    };
    await ctx.tx
      .insert(followUps)
      .values({ workspaceId: ws, userId: me, profileId: sent.profileId, ...set })
      .onConflictDoUpdate({
        target: [followUps.workspaceId, followUps.userId, followUps.profileId],
        set,
      });
    return;
  }
  if (sent.kind === 'follow_up') {
    // A follow-up in a chat that started another way starts its conversation, at the first step.
    if (!row) {
      await ctx.tx.insert(followUps).values({
        workspaceId: ws,
        userId: me,
        profileId: sent.profileId,
        step: 'first',
        stepAt: at,
        sent: 1,
        lastAt: at,
        ...nextAfter(pace, 1, at),
        offerVersion: sent.offerVersion,
        updatedAt: at,
      });
      return;
    }
    await ctx.tx
      .update(followUps)
      .set({ sent: row.sent + 1, lastAt: at, ...nextAfter(pace, row.sent + 1, at), updatedAt: at })
      .where(eq(followUps.id, row.id));
    return;
  }
  if (!row) return;
  if (sent.kind === 'check_in') {
    await ctx.tx
      .update(followUps)
      .set({ lastAt: at, ...checkInAfter(at), updatedAt: at })
      .where(eq(followUps.id, row.id));
    return;
  }
  if (sent.kind === 'reply') {
    const later = row.answer === 'later';
    await ctx.tx
      .update(followUps)
      .set({
        lastAt: at,
        ...(later
          ? { sent: pace.followUps, ...checkInAfter(at) }
          : { sent: 0, ...nextAfter(pace, 0, at) }),
        // Answering them goes on with a conversation the person stopped; one a no stopped stays stopped.
        ...(row.answer === 'no' ? {} : { stoppedAt: null }),
        updatedAt: at,
      })
      .where(eq(followUps.id, row.id));
  }
}

/** Keeps a stage row's columns for one person and profile: a row made the first time. */
async function keepStage(
  ctx: Ctx,
  me: string,
  profileId: string,
  set: Partial<
    Pick<typeof stages.$inferInsert, 'mark' | 'markedBy' | 'why' | 'markedAt' | 'positiveAt'>
  >,
): Promise<void> {
  await ctx.tx
    .insert(stages)
    .values({ workspaceId: ctx.scope.workspaceId!, userId: me, profileId, ...set })
    .onConflictDoUpdate({ target: [stages.workspaceId, stages.userId, stages.profileId], set });
}

/**
 * What the AI read in someone's answer to the person's last step: kept, and the follow-ups wait for the person to
 * answer back. A yes is a positive reply, kept the first time (`stages.positive_at`); a no stops the conversation and
 * marks them not a fit, as the chat read's no does, unless the person marked them themselves.
 */
export async function noteAnswer(
  ctx: Ctx,
  me: string,
  read: {
    readonly profileId: string;
    readonly answer: Answer;
    readonly at: Date;
    /** When they wrote it, when known: an answer older than the person's last message, or read before, is let be. */
    readonly writtenAt?: Date | null;
  },
): Promise<void> {
  const at = read.at;
  const row = await kept(ctx, me, read.profileId);
  const written = read.writtenAt ?? at;
  if (row && (row.lastAt > written || (row.answeredAt !== null && row.answeredAt >= written)))
    return;
  if (row)
    await ctx.tx
      .update(followUps)
      .set({
        answer: read.answer,
        answeredAt: at,
        // Theirs to answer back now: no follow-up until the person writes.
        next: null,
        dueAt: null,
        ...(read.answer === 'no' ? { stoppedAt: at } : {}),
        updatedAt: at,
      })
      .where(eq(followUps.id, row.id));
  const [stage] = await ctx.tx
    .select()
    .from(stages)
    .where(
      and(
        eq(stages.workspaceId, ctx.scope.workspaceId!),
        eq(stages.userId, me),
        eq(stages.profileId, read.profileId),
      ),
    )
    .for('update');
  if (read.answer === 'yes' && !stage?.positiveAt)
    await keepStage(ctx, me, read.profileId, { positiveAt: at });
  if (read.answer === 'no' && stage?.markedBy !== 'person')
    await keepStage(ctx, me, read.profileId, {
      mark: 'lost',
      markedBy: 'ai',
      why: 'Said no',
      markedAt: at,
    });
}

/** Back in play (the person's): a conversation a no stopped can go on. */
export async function restartConversation(ctx: Ctx, me: string, profileId: string, at: Date) {
  await ctx.tx
    .update(followUps)
    .set({ stoppedAt: null, updatedAt: at })
    .where(
      and(
        eq(followUps.workspaceId, ctx.scope.workspaceId!),
        eq(followUps.userId, me),
        eq(followUps.profileId, profileId),
        sql`${followUps.stoppedAt} is not null`,
      ),
    );
}

export const conversationNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.conversation.note',
  description:
    'The person copied a message draft to send themselves: a first message, the video, a follow-up, a check-in or a reply. It’s noted as sent, so their follow-ups come at the playbook’s pace. Copying the link is noted by marking them pitched.',
  risk: 0,
  input: ConversationNoteInput,
  output: ConversationNoteOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [profile] = await ctx.tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        and(eq(profiles.workspaceId, ctx.scope.workspaceId!), eq(profiles.id, input.profileId)),
      );
    if (!profile)
      throw HfosError.notFound('That person isn’t kept here anymore. Reload your list.');
    await noteSent(ctx, me, {
      profileId: profile.id,
      kind: input.kind,
      at: changeMoment(ctx.meta),
      offerVersion: await offerVersionFor(ctx, me, profile.id),
    });
    return { noted: true };
  },
});

export const answerNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.answer.note',
  description:
    'Worker: what the AI read in someone’s answer to the person’s last step while drafting the reply (yes, a question, not now, no). A yes is a positive reply and moves them to the next step; a no ends the conversation and marks them not a fit.',
  risk: 0,
  input: AnswerNoteInput,
  output: AnswerNoteOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const [profile] = await ctx.tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        and(eq(profiles.workspaceId, ctx.scope.workspaceId!), eq(profiles.id, input.profileId)),
      );
    if (!profile) return { noted: false };
    await noteAnswer(ctx, input.userId, {
      profileId: profile.id,
      answer: input.answer,
      at: changeMoment(ctx.meta),
      writtenAt: input.writtenAt ? new Date(input.writtenAt) : null,
    });
    return { noted: true };
  },
});

export const conversationStop = defineAddonCommand(outreachAddon, {
  name: 'outreach.conversation.stop',
  description:
    'Stop the follow-ups and monthly check-ins to someone. None come until the person sends them the next step or answers them.',
  risk: 0,
  input: ConversationStopInput,
  output: ConversationStopOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const stopped = await ctx.tx
      .update(followUps)
      .set({ stoppedAt: at, next: null, dueAt: null, updatedAt: at })
      .where(
        and(
          eq(followUps.workspaceId, ctx.scope.workspaceId!),
          eq(followUps.userId, me),
          eq(followUps.profileId, input.profileId),
          sql`${followUps.stoppedAt} is null`,
        ),
      )
      .returning({ id: followUps.id });
    return { stopped: stopped.length > 0 };
  },
});

export const conversationCommands = [conversationNote, answerNote, conversationStop] as const;

/**
 * How each version of the main offer is doing in Social Outreach (decision 67): the first messages sent with it, the
 * yeses and the calls booked from them. The main offer's page shows the live one's (too new to judge before
 * `JUDGE_AFTER_MESSAGES`). Owners and admins see everyone's counts; anyone else their own.
 */
export const offerVersions = defineAddonQuery(outreachAddon, {
  name: 'outreach.offer.versions',
  description:
    'How each version of the business’s main offer is doing in Social Outreach: first messages sent with it, the yeses and the calls booked from them. Everyone’s counts for owners and admins; the person’s own otherwise.',
  input: OfferVersionsInput,
  output: OfferVersionsOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person sees how the offer is doing.');
    const everyone = scopeCan(ctx.scope, 'outreach.manage' as Permission);
    // Counted as Results counts them (./tracking.ts): everyone's answers are each person's own.
    const counted = await numbersIn(ctx, { me, everyone }, EVER, 'infinity');
    const byVersion = new Map<number, { messages: number; positive: number; booked: number }>();
    for (const c of counted) {
      if (c.offer_version === null) continue;
      const n = byVersion.get(c.offer_version) ?? { messages: 0, positive: 0, booked: 0 };
      byVersion.set(c.offer_version, {
        messages: n.messages + c.messages,
        positive: n.positive + c.positive,
        booked: n.booked + c.booked,
      });
    }
    const [offer] = await ctx.tx
      .select({ live: mainOffers.liveVersion })
      .from(mainOffers)
      .where(eq(mainOffers.workspaceId, ctx.scope.workspaceId!));
    return {
      versions: [...byVersion.entries()]
        .sort(([a], [b]) => b - a)
        .map(([version, n]) => ({ version, ...n })),
      everyone,
      judgeAfter: JUDGE_AFTER_MESSAGES,
      live: offer?.live ?? null,
    };
  },
});

export const conversationQueries = [offerVersions] as const;
