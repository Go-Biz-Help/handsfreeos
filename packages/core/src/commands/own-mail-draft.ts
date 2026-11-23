/**
 * The AI teammate's draft answer on a person's own mail ("Let Ava read this mail", owner 2026-11-22).
 *
 * A person's own address can let the AI teammate read the mail that comes in to it (`email_address.set_ai_reads`).
 * The worker then drafts an answer to the newest mail and keeps it here, on the thread (`conversations.ai_draft`).
 * The thread is private, so the draft is: the policies that hide the thread from everyone else hide it. Nothing is
 * sent. The person reads it above their message box, puts it in the box and sends it as their own, or puts it away.
 *
 * The history owners read says only that a draft was made or put away on a private thread, never what it said.
 */
import { and, desc, eq } from 'drizzle-orm';
import { conversations, emailAddresses, messages } from '@hfos/db/schema';
import { defineCommand } from '../kernel/define';
import { loadConversation } from '../messaging/store';
import {
  ConversationAiDraftDismissOutput,
  ConversationAiDraftSaveInput,
  ConversationAiDraftSaveOutput,
  ConversationRefInput,
} from '../schemas/conversation';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const conversationAiDraftSave = defineCommand({
  name: 'conversation.ai_draft_save',
  description:
    'Worker: the AI teammate drafted an answer to the newest mail in a person’s own thread, because their address lets it read. Kept on the thread, where only that person sees it. Nothing is sent.',
  risk: 1,
  input: ConversationAiDraftSaveInput,
  output: ConversationAiDraftSaveOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.ai_drafted'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadConversation(ctx, input.conversationId);
    const no = (skipped: 'not_own_mail' | 'switched_off' | 'not_newest') => ({
      conversationId: c.id,
      saved: false,
      skipped,
    });
    // A thread shared with the team since, or moved out of the Inbox, is no longer this draft's to answer.
    if (!c.privateTo || c.channel !== 'email' || c.folder !== 'inbox' || !c.emailAddressId)
      return no('not_own_mail');
    // The switch is asked again here, at the moment of writing: off, or the address changed hands, means no draft.
    const [address] = await ctx.tx
      .select({ aiReads: emailAddresses.aiReads, ownerUserId: emailAddresses.ownerUserId })
      .from(emailAddresses)
      .where(
        and(
          eq(emailAddresses.id, c.emailAddressId),
          eq(emailAddresses.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!address?.aiReads || address.ownerUserId !== c.privateTo) return no('switched_off');
    // Still the newest thing in the thread: they haven't answered, and nothing else has come.
    const [newest] = await ctx.tx
      .select({ id: messages.id, direction: messages.direction })
      .from(messages)
      .where(eq(messages.conversationId, c.id))
      .orderBy(desc(messages.occurredAt), desc(messages.createdAt))
      .limit(1);
    if (!newest || newest.id !== input.forMessageId || newest.direction !== 'inbound')
      return no('not_newest');
    await ctx.tx
      .update(conversations)
      .set({
        aiDraft: {
          body: input.body,
          forMessageId: input.forMessageId,
          at: new Date().toISOString(),
        },
      })
      .where(eq(conversations.id, c.id));
    await ctx.emit({
      type: 'conversation.ai_drafted',
      entityType: 'conversation',
      entityId: c.id,
      payload: { private: true },
      after: { drafted: true },
    });
    return { conversationId: c.id, saved: true, skipped: null };
  },
});

export const conversationAiDraftDismiss = defineCommand({
  name: 'conversation.ai_draft_dismiss',
  description:
    'Put away the answer the AI teammate drafted on your own mail. Nothing was sent, and it drafts again when new mail comes.',
  risk: 1,
  input: ConversationRefInput,
  output: ConversationAiDraftDismissOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.ai_draft_dismissed'],
  async handler(ctx, input) {
    // Only its person can open a private thread, so only they get this far.
    const c = await loadConversation(ctx, input.conversationId);
    if (!c.aiDraft) return { conversationId: c.id, dismissed: false };
    await ctx.tx.update(conversations).set({ aiDraft: null }).where(eq(conversations.id, c.id));
    await ctx.emit({
      type: 'conversation.ai_draft_dismissed',
      entityType: 'conversation',
      entityId: c.id,
      payload: { private: true },
      after: { drafted: false },
    });
    return { conversationId: c.id, dismissed: true };
  },
});

export const ownMailDraftCommands = [conversationAiDraftSave, conversationAiDraftDismiss];
