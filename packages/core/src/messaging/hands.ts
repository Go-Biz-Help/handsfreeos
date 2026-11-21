/**
 * In your hands (20261027030900; the owner, 19 Nov 2026, "all your picks"): a customer someone on the team is
 * talking to themselves. A message a person sends them (in HandsFreeOS, from their own mailbox, or typed in Facebook's
 * or Instagram's own inbox), a call a person makes, or Take over puts them in that person's hands, and the AI holds
 * off them everywhere: each of their conversations is a person's, and the AI teammate, its follow-ups, funnels and
 * AI calls leave them alone. Social Outreach reads the same row. They stay until someone gives them back, which hands
 * their conversations back to the AI teammate where it answers that channel.
 *
 * An AI draft someone OK'd or edited is still the AI's (it goes out as the teammate's), and the business's own
 * automations count either way: neither comes here.
 */
import { and, eq, inArray, isNull, sql as dsql } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { conversations, peopleInHands } from '@hfos/db/schema';
import { loadTeammate, teammateConfigOf } from '../ai-team/load';
import type { CommandContext } from '../kernel/types';
import { cancelPendingReplyDraft } from './handling';

export const HANDS_HOW = ['wrote', 'called', 'took_over'] as const;
export type HandsHow = (typeof HANDS_HOW)[number];

type Conversation = typeof conversations.$inferSelect;

/** What the AI teammate may answer, of the channels a conversation can be on. */
const TEAMMATE_CHANNELS = new Set(['sms', 'email', 'chat']);

/** Whether a customer is in someone's hands now. */
export async function inHands(tx: Tx, personId: string | null): Promise<boolean> {
  if (!personId) return false;
  const [r] = await rows<{ yes: boolean }>(
    tx,
    sql`select exists (select 1 from app.people_in_hands h where h.person_id = ${personId}) as yes`,
  );
  return !!r?.yes;
}

/**
 * Gives one conversation to a person (`userId`, null for someone outside HandsFreeOS): handled by a person, the
 * epoch raised, no longer waiting for a person, and the teammate's waiting reply let go. Emits
 * conversation.taken_over, which pauses a funnel and settles what Home shows.
 */
export async function handConversationToPerson(
  ctx: CommandContext,
  conv: Conversation,
  userId: string | null,
  how: 'reply' | 'button' | 'elsewhere' | 'call',
): Promise<{ draftId: string | null }> {
  await ctx.tx
    .update(conversations)
    .set({
      handledBy: 'person',
      takenOverBy: userId,
      needsPersonSince: null,
      aiEpoch: dsql`${conversations.aiEpoch} + 1`,
    })
    .where(eq(conversations.id, conv.id));
  const draftId = await cancelPendingReplyDraft(
    ctx,
    conv.id,
    'A person took the conversation over.',
  );
  await ctx.emit({
    type: 'conversation.taken_over',
    entityType: 'conversation',
    entityId: conv.id,
    payload: {
      conversationId: conv.id,
      personId: conv.personId,
      teammateId: conv.aiTeammateId,
      how,
      draftId,
    },
    before: { handledBy: conv.handledBy, needsPerson: conv.needsPersonSince !== null },
    after: { handledBy: 'person', draftCancelled: draftId !== null },
  });
  return { draftId };
}

export interface TakeIntoHands {
  readonly personId: string;
  /** Whose hands: null for someone outside HandsFreeOS (a reply typed in Facebook's own inbox). */
  readonly userId: string | null;
  readonly how: HandsHow;
  /** Where: a channel, 'call', or a network an add-on names; null for Take over. */
  readonly place: string | null;
  /** When the message or call was, for one that arrives late (an email from a mailbox). */
  readonly at?: Date;
  /** The conversation it happened in, which the caller has already given to the person (or will). */
  readonly exceptConversationId?: string | null;
}

/**
 * Puts a customer in someone's hands, or notes the latest message by hand when they already are (whoever wrote last
 * has them). Every conversation of theirs the AI teammate has, or nobody has, becomes a person's. Returns whether
 * they've just come into someone's hands.
 */
export async function takeIntoHands(
  ctx: CommandContext,
  input: TakeIntoHands,
): Promise<{ fresh: boolean; draftsCancelled: number }> {
  const workspaceId = ctx.scope.workspaceId!;
  const at = input.at ?? new Date();
  const place = input.place && /^[a-z_]{1,40}$/.test(input.place) ? input.place : null;
  const [before] = await ctx.tx
    .select({ userId: peopleInHands.userId })
    .from(peopleInHands)
    .where(eq(peopleInHands.personId, input.personId))
    .for('update');
  if (before) {
    // Take over never moves someone from one person's hands to another's: only a message or a call does.
    if (input.how !== 'took_over')
      await ctx.tx
        .update(peopleInHands)
        .set({
          userId: input.userId,
          how: input.how,
          place,
          lastAt: dsql`greatest(${peopleInHands.lastAt}, ${at.toISOString()}::timestamptz)`,
        })
        .where(eq(peopleInHands.personId, input.personId));
  } else
    await ctx.tx.insert(peopleInHands).values({
      personId: input.personId,
      workspaceId,
      userId: input.userId,
      how: input.how,
      place,
      since: at,
      lastAt: at,
    });
  // Each conversation of theirs that isn't a person's yet (those this person may see; the database makes any new one
  // a person's from the start).
  const theirs = await ctx.tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.personId, input.personId),
        inArray(conversations.handledBy, ['ai', 'none']),
        isNull(conversations.privateTo),
      ),
    );
  let draftsCancelled = 0;
  for (const conv of theirs) {
    if (conv.id === input.exceptConversationId) continue;
    const { draftId } = await handConversationToPerson(
      ctx,
      conv,
      input.userId,
      input.how === 'took_over' ? 'button' : input.how === 'called' ? 'call' : 'elsewhere',
    );
    if (draftId) draftsCancelled++;
  }
  if (!before)
    await ctx.emit({
      type: 'person.taken_over',
      entityType: 'person',
      entityId: input.personId,
      payload: { personId: input.personId, userId: input.userId, how: input.how, place },
      after: { how: input.how, place, conversations: theirs.length },
    });
  return { fresh: !before, draftsCancelled };
}

/**
 * Gives a customer back to the AI: out of anyone's hands, and each conversation of theirs a person took (not one the
 * AI teammate handed to a person, which waits for them still) goes back to the teammate where it answers that channel,
 * or to nobody where it doesn't. A conversation handed to the teammate emits conversation.handed_to_ai, so it answers
 * what's waiting and a paused funnel picks up. Returns whether they were in someone's hands.
 */
export async function giveBackToAi(
  ctx: CommandContext,
  personId: string,
  opts: { readonly exceptConversationId?: string | null } = {},
): Promise<{ wasInHands: boolean; toAi: number }> {
  const workspaceId = ctx.scope.workspaceId!;
  const [gone] = await ctx.tx
    .delete(peopleInHands)
    .where(and(eq(peopleInHands.personId, personId), eq(peopleInHands.workspaceId, workspaceId)))
    .returning({ userId: peopleInHands.userId });
  const theirs = await ctx.tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.personId, personId),
        eq(conversations.handledBy, 'person'),
        isNull(conversations.needsPersonSince),
      ),
    );
  const teammate = theirs.length ? await loadTeammate(ctx.tx, workspaceId) : null;
  const channels =
    teammate && teammate.status !== 'off' ? teammateConfigOf(teammate).channels : null;
  let toAi = 0;
  for (const conv of theirs) {
    if (conv.id === opts.exceptConversationId) continue;
    const answers =
      !!teammate &&
      !!channels &&
      TEAMMATE_CHANNELS.has(conv.channel) &&
      channels[conv.channel as 'sms' | 'email' | 'chat'] === true &&
      conv.privateTo === null;
    await ctx.tx
      .update(conversations)
      .set({
        handledBy: answers ? 'ai' : 'none',
        aiTeammateId: answers ? teammate!.id : conv.aiTeammateId,
        aiEpoch: dsql`${conversations.aiEpoch} + 1`,
        takenOverBy: null,
        handoffReason: null,
        handoffNote: null,
      })
      .where(eq(conversations.id, conv.id));
    if (!answers) continue;
    toAi++;
    await ctx.emit({
      type: 'conversation.handed_to_ai',
      entityType: 'conversation',
      entityId: conv.id,
      payload: { conversationId: conv.id, personId, teammateId: teammate!.id },
      before: { handledBy: 'person' },
      after: { handledBy: 'ai', teammate: teammate!.name },
    });
  }
  if (gone)
    await ctx.emit({
      type: 'person.handed_back',
      entityType: 'person',
      entityId: personId,
      payload: { personId, userId: gone.userId },
      before: { inHands: true },
      after: { inHands: false, conversations: toAi },
    });
  return { wasInHands: !!gone, toAi };
}

/**
 * A person wrote in a conversation (a text, an email, a chat or portal reply, Messenger or Instagram): they take it
 * from the AI teammate or from "Needs a person", and the customer is in their hands everywhere. A conversation with
 * nobody tied to it is taken on its own, as before.
 */
export async function personWroteIn(ctx: CommandContext, conv: Conversation): Promise<void> {
  if (ctx.actor.type !== 'human') return;
  const me = ctx.actor.userId;
  // Theirs now, whoever had it: the AI teammate, nobody (so the teammate can't pick it up on their next message), or
  // "Needs a person". A sealed thread of their own mail is theirs already, and the teammate never answers it.
  const takes =
    conv.handledBy === 'ai' || conv.handledBy === 'none' || conv.needsPersonSince !== null;
  if (takes && conv.privateTo === null) await handConversationToPerson(ctx, conv, me, 'reply');
  if (conv.personId)
    await takeIntoHands(ctx, {
      personId: conv.personId,
      userId: me,
      how: 'wrote',
      place: conv.channel,
      exceptConversationId: conv.id,
    });
}
