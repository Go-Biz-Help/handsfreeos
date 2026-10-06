/**
 * Who answers a conversation (M7). The AI teammate hands one to a person (conversation.hand_off, which
 * workflows and the system may also do), picks up one nobody has (conversation.pick_up), a person takes one
 * from it (conversation.take_over), and a person or a workflow step hands one to it (conversation.hand_to_ai).
 * Each change of hands raises ai_epoch, so a teammate run that started before it is superseded, and drops the
 * teammate's pending reply.
 */
import { and, desc, eq, isNull, sql as dsql } from 'drizzle-orm';
import { conversations, leads, people } from '@hfos/db/schema';
import { loadTeammate, teammateConfigOf, type TeammateRow } from '../ai-team/load';
import { notHandledByAi, outsideItsConversation } from '../ai-team/reach';
import { HfosError } from '../errors';
import { FRESH_MINUTES } from '../mobile';
import { aiEmployeeOf, requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { cancelPendingReplyDraft, takeOver } from '../messaging/handling';
import { isWorkspaceUser, loadConversation } from '../messaging/store';
import {
  ConversationHandOffInput,
  ConversationHandOffOutput,
  ConversationHandToAiOutput,
  ConversationTakeOverOutput,
} from '../schemas/ai-team';
import { ConversationPickUpOutput, ConversationRefInput } from '../schemas/conversation';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type Conversation = Awaited<ReturnType<typeof loadConversation>>;

const CHANNEL_WORDS: Readonly<Record<string, string>> = {
  sms: 'texts',
  email: 'email',
  chat: 'website chat',
  portal: 'messages in a client’s portal',
  messenger: 'Messenger messages yet',
  instagram: 'Instagram messages yet',
};

/** Each channel's switch under Channels on the AI teammate page. */
const CHANNEL_SWITCHES: Readonly<Record<string, string>> = {
  sms: 'Texts',
  email: 'Email',
  chat: 'Website chat',
};

/** The teammate is on and answers the conversation's channel; otherwise the refusal says what to change. */
function assertAnswers(teammate: TeammateRow, conv: Conversation): void {
  if (teammate.status === 'off')
    throw HfosError.rule(
      'teammate_off',
      409,
      `${teammate.name} is off, so it can’t answer this conversation. Set it to Training wheels or Automatic under Status on the AI teammate page first.`,
    );
  const channels = teammateConfigOf(teammate).channels;
  if (
    !(conv.channel === 'sms' || conv.channel === 'email' || conv.channel === 'chat') ||
    !channels[conv.channel]
  )
    throw HfosError.rule(
      'channel_off',
      409,
      CHANNEL_SWITCHES[conv.channel]
        ? `${teammate.name} doesn’t answer ${CHANNEL_WORDS[conv.channel]}. Turn on ${CHANNEL_SWITCHES[conv.channel]} under Channels on the AI teammate page first.`
        : `${teammate.name} can’t answer ${CHANNEL_WORDS[conv.channel] ?? conv.channel}, so someone on the team has to.`,
    );
}

async function requireTeammate(ctx: CommandContext, teammateId?: string): Promise<TeammateRow> {
  const teammate = await loadTeammate(
    ctx.tx,
    ctx.scope.workspaceId!,
    teammateId ? { teammateId } : {},
  );
  if (!teammate)
    throw HfosError.rule(
      'no_teammate',
      409,
      teammateId
        ? 'That AI teammate isn’t in this business anymore. Set one up on the AI teammate page first.'
        : 'This business doesn’t have an AI teammate yet. Set one up on the AI teammate page first.',
    );
  return teammate;
}

/**
 * Who picks up a conversation handed to a person: whoever it's assigned to already, else the assignee of the
 * customer's open lead, else the customer's owner (each only while they're still in the workspace), else
 * nobody in particular.
 */
async function handOffAssignee(ctx: CommandContext, conv: Conversation): Promise<string | null> {
  if (conv.assigneeUserId) return conv.assigneeUserId;
  if (!conv.personId) return null;
  const ws = ctx.scope.workspaceId!;
  const [lead] = await ctx.tx
    .select({ assignee: leads.assigneeUserId })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, ws),
        eq(leads.personId, conv.personId),
        eq(leads.status, 'open'),
        isNull(leads.archivedAt),
      ),
    )
    .orderBy(desc(leads.updatedAt))
    .limit(1);
  const [person] = await ctx.tx
    .select({ owner: people.ownerUserId })
    .from(people)
    .where(eq(people.id, conv.personId));
  for (const candidate of [lead?.assignee, person?.owner])
    if (candidate && (await isWorkspaceUser(ctx.tx, ws, candidate))) return candidate;
  return null;
}

export const conversationHandOff = defineCommand({
  name: 'conversation.hand_off',
  description:
    'Hand a conversation to a person: it waits in “Needs a person” with a reason and a note, goes to the lead’s assignee or the customer’s owner, and the AI teammate stops answering it.',
  risk: 1,
  input: ConversationHandOffInput,
  output: ConversationHandOffOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.handed_off', 'ai_teammate.handed_off'],
  actors: ['ai_employee', 'workflow', 'system'],
  async handler(ctx, input) {
    const conv = await loadConversation(ctx, input.conversationId);
    const ai = aiEmployeeOf(ctx.actor);
    // The AI teammate hands off only the conversation it's answering, and only while it still has it.
    if (ai) {
      if (ai.conversationId !== conv.id) throw outsideItsConversation();
      if (conv.handledBy !== 'ai' || conv.aiTeammateId !== ai.teammateId) throw notHandledByAi();
    }
    const assignee = await handOffAssignee(ctx, conv);
    const teammateId = ai?.teammateId ?? conv.aiTeammateId;
    const note = input.note ?? null;
    const [row] = await ctx.tx
      .update(conversations)
      .set({
        handledBy: 'person',
        needsPersonSince: dsql`coalesce(${conversations.needsPersonSince}, now())`,
        handoffReason: input.reason,
        handoffNote: note,
        takenOverBy: null,
        aiEpoch: dsql`${conversations.aiEpoch} + 1`,
        assigneeUserId: assignee,
        // Someone has to look: it comes back into the open inbox.
        status: 'open',
        snoozedUntil: null,
        closedAt: null,
        closedBy: null,
      })
      .where(eq(conversations.id, conv.id))
      .returning({ needsPersonSince: conversations.needsPersonSince });
    const draftId = await cancelPendingReplyDraft(ctx, conv.id, 'Handed to a person.');
    const payload = { personId: conv.personId, conversationId: conv.id, reason: input.reason };
    await ctx.emit({
      type: 'conversation.handed_off',
      entityType: 'conversation',
      entityId: conv.id,
      payload: { ...payload, note, assigneeUserId: assignee, teammateId, draftId },
      before: { handledBy: conv.handledBy },
      after: { handledBy: 'person', reason: input.reason, note, assigneeUserId: assignee },
    });
    await ctx.emit({
      type: 'ai_teammate.handed_off',
      entityType: 'conversation',
      entityId: conv.id,
      payload: { ...payload, teammateId },
      broadcast: false,
    });
    return {
      conversationId: conv.id,
      assigneeUserId: assignee,
      needsPersonSince: row!.needsPersonSince!.toISOString(),
    };
  },
});

export const conversationPickUp = defineCommand({
  name: 'conversation.pick_up',
  description:
    'Worker: the AI teammate takes on a conversation nobody is handling or assigned to, so it answers it. A person writing in it takes it back.',
  risk: 1,
  input: ConversationRefInput,
  output: ConversationPickUpOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['ai_teammate.picked_up'],
  actors: ['system', 'ai_employee'],
  async handler(ctx, input) {
    const conv = await loadConversation(ctx, input.conversationId);
    const ai = aiEmployeeOf(ctx.actor);
    // The teammate picks up only the conversation its run is answering.
    if (ai && ai.conversationId !== conv.id) throw outsideItsConversation();
    const teammate = await requireTeammate(ctx, ai?.teammateId);
    assertAnswers(teammate, conv);
    if (conv.handledBy === 'ai' && conv.aiTeammateId === teammate.id)
      return { conversationId: conv.id, teammateId: teammate.id, aiEpoch: conv.aiEpoch };
    const taken = () =>
      HfosError.rule(
        'conversation_taken',
        409,
        'Someone is handling this conversation, or it’s assigned to someone, so the AI teammate leaves it to them.',
      );
    if (conv.handledBy !== 'none' || conv.assigneeUserId) throw taken();
    const [row] = await ctx.tx
      .update(conversations)
      .set({
        handledBy: 'ai',
        aiTeammateId: teammate.id,
        aiEpoch: dsql`${conversations.aiEpoch} + 1`,
      })
      .where(
        and(
          eq(conversations.id, conv.id),
          eq(conversations.handledBy, 'none'),
          isNull(conversations.assigneeUserId),
        ),
      )
      .returning({ aiEpoch: conversations.aiEpoch });
    if (!row) throw taken();
    await ctx.emit({
      type: 'ai_teammate.picked_up',
      entityType: 'conversation',
      entityId: conv.id,
      payload: {
        conversationId: conv.id,
        personId: conv.personId,
        teammateId: teammate.id,
        runId: ai?.runId ?? null,
      },
      before: { handledBy: 'none' },
      after: { handledBy: 'ai', teammate: teammate.name },
    });
    return { conversationId: conv.id, teammateId: teammate.id, aiEpoch: row.aiEpoch };
  },
});

export const conversationTakeOver = defineCommand({
  name: 'conversation.take_over',
  description:
    'Take a conversation from the AI teammate (or from “Needs a person”): the teammate stays quiet until someone hands it back, and its pending reply is dropped.',
  risk: 1,
  input: ConversationRefInput,
  output: ConversationTakeOverOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.taken_over'],
  offline: 'anytime',
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const conv = await loadConversation(ctx, input.conversationId);
    if (conv.handledBy === 'person' && conv.takenOverBy === me && !conv.needsPersonSince)
      return { conversationId: conv.id, draftCancelled: false };
    const { draftId } = await takeOver(ctx, conv, 'button');
    return { conversationId: conv.id, draftCancelled: draftId !== null };
  },
});

export const conversationHandToAi = defineCommand({
  name: 'conversation.hand_to_ai',
  description:
    'Hand a conversation back to the AI teammate. It answers what’s waiting and whatever the customer writes next.',
  risk: 1,
  input: ConversationRefInput,
  output: ConversationHandToAiOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.handed_to_ai'],
  // A person hands a conversation back; a workflow step ("Hand to the AI teammate") hands one over, and the
  // kernel puts its run's loop guard (_workflow) on the event, which the worker passes on to the teammate.
  actors: ['human', 'workflow'],
  offline: { freshMinutes: FRESH_MINUTES },
  async handler(ctx, input) {
    const conv = await loadConversation(ctx, input.conversationId);
    const teammate = await requireTeammate(ctx);
    assertAnswers(teammate, conv);
    if (conv.handledBy === 'ai' && conv.aiTeammateId === teammate.id)
      return { conversationId: conv.id, teammateId: teammate.id };
    // Only someone on the team takes a conversation back from a person; a workflow leaves it with them.
    if (ctx.actor.type !== 'human' && conv.handledBy === 'person')
      throw HfosError.rule(
        'person_handling',
        409,
        'A person is handling this conversation. Someone on the team can hand it back.',
      );
    await ctx.tx
      .update(conversations)
      .set({
        handledBy: 'ai',
        aiTeammateId: teammate.id,
        aiEpoch: dsql`${conversations.aiEpoch} + 1`,
        needsPersonSince: null,
        takenOverBy: null,
        handoffReason: null,
        handoffNote: null,
      })
      .where(eq(conversations.id, conv.id));
    await ctx.emit({
      type: 'conversation.handed_to_ai',
      entityType: 'conversation',
      entityId: conv.id,
      payload: { conversationId: conv.id, personId: conv.personId, teammateId: teammate.id },
      before: { handledBy: conv.handledBy },
      after: { handledBy: 'ai', teammate: teammate.name },
    });
    return { conversationId: conv.id, teammateId: teammate.id };
  },
});
