/**
 * Who answers a conversation (M7): nobody in particular, the AI teammate, or a person. Every change of hands
 * raises ai_epoch (a teammate run that started under an older one is superseded) and drops the teammate's
 * pending reply draft, so two voices never answer one customer.
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { aiTeammateDrafts, conversations } from '@hfos/db/schema';
import { requireHuman } from '../kernel/actor';
import type { CommandContext } from '../kernel/types';

type Conversation = typeof conversations.$inferSelect;

/** Cancels the conversation's pending reply draft, if it has one, in the actor's name. Returns its id. */
export async function cancelPendingReplyDraft(
  ctx: CommandContext,
  conversationId: string,
  reason: string,
): Promise<string | null> {
  const person = ctx.actor.type === 'human' ? ctx.actor.userId : null;
  const [row] = await ctx.tx
    .update(aiTeammateDrafts)
    .set({
      status: 'cancelled',
      decidedBy: person,
      decidedAt: dsql`now()`,
      via: person ? (ctx.meta.channel === 'assistant' ? 'assistant' : 'web') : 'system',
      reason,
    })
    .where(
      and(
        eq(aiTeammateDrafts.conversationId, conversationId),
        eq(aiTeammateDrafts.status, 'pending'),
        eq(aiTeammateDrafts.kind, 'reply'),
      ),
    )
    .returning({ id: aiTeammateDrafts.id });
  return row?.id ?? null;
}

/** Whether a person acting here takes the conversation: the AI teammate answers it, or it waits for a person. */
export function personTakesOver(ctx: CommandContext, conv: Conversation): boolean {
  return ctx.actor.type === 'human' && (conv.handledBy === 'ai' || conv.needsPersonSince !== null);
}

/**
 * Gives the conversation to the person acting, in the same transaction as what prompted it (their message,
 * or Take over): handled by a person, taken over by them, no longer waiting for a person, the epoch raised,
 * and the teammate's pending reply cancelled.
 */
export async function takeOver(
  ctx: CommandContext,
  conv: Conversation,
  how: 'reply' | 'button',
): Promise<{ draftId: string | null }> {
  const me = requireHuman(ctx).userId;
  await ctx.tx
    .update(conversations)
    .set({
      handledBy: 'person',
      takenOverBy: me,
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
