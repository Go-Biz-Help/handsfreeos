/**
 * Moving email threads between the Inbox, Other mail and Spam (M19). A thread keeps its folder until a person moves
 * it; new mail in it doesn't. Moving one into the Inbox starts the AI teammate, workflows, push and the timeline
 * from its next message, and moving one out stops them. Remembering the move saves a sender rule, so the sender's
 * next new thread goes to the same place.
 */
import { and, eq } from 'drizzle-orm';
import { conversations, emailSenderRules } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { loadConversation } from '../messaging/store';
import {
  ConversationMoveInput,
  ConversationMoveOutput,
  EmailSenderRuleRemoveInput,
  EmailSenderRuleRemoveOutput,
} from '../schemas/conversation';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const FOLDER_NAMES = { inbox: 'the Inbox', other: 'Other mail', spam: 'Spam' } as const;

export const conversationMove = defineCommand({
  name: 'conversation.move',
  description:
    'Move an email thread to the Inbox, Other mail or Spam. With remember, the sender’s next new thread goes there too.',
  risk: 1,
  input: ConversationMoveInput,
  output: ConversationMoveOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.moved'],
  async handler(ctx, input) {
    const c = await loadConversation(ctx, input.conversationId);
    if (c.channel !== 'email')
      throw HfosError.rule(
        'conversation_not_email',
        400,
        'Only email moves between the Inbox, Other mail and Spam. Texts and chats always stay in the Inbox.',
      );
    const changed = c.folder !== input.folder;
    if (changed)
      await ctx.tx
        .update(conversations)
        .set({ folder: input.folder })
        .where(eq(conversations.id, c.id));
    if (input.remember)
      await ctx.tx
        .insert(emailSenderRules)
        .values({
          workspaceId: c.workspaceId,
          address: c.counterpart,
          folder: input.folder,
          createdBy: userIdOf(ctx.actor),
        })
        .onConflictDoUpdate({
          target: [emailSenderRules.workspaceId, emailSenderRules.address],
          set: { folder: input.folder },
        });
    if (changed || input.remember)
      await ctx.emit({
        type: 'conversation.moved',
        entityType: 'conversation',
        entityId: c.id,
        payload: { from: c.folder, to: input.folder, remember: input.remember },
        before: { folder: FOLDER_NAMES[c.folder] },
        after: {
          folder: FOLDER_NAMES[input.folder],
          with: c.counterpart,
          ...(input.remember ? { rule: `New mail from ${c.counterpart} goes here too` } : {}),
        },
      });
    return { conversationId: c.id, folder: input.folder, changed };
  },
});

export const emailSenderRuleRemove = defineCommand({
  name: 'email_sender_rule.remove',
  description:
    'Forget where new mail from a sender goes. Their next new thread is sorted like anyone else’s.',
  risk: 1,
  input: EmailSenderRuleRemoveInput,
  output: EmailSenderRuleRemoveOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['email_sender_rule.removed'],
  async handler(ctx, input) {
    const [gone] = await ctx.tx
      .delete(emailSenderRules)
      .where(
        and(
          eq(emailSenderRules.workspaceId, ctx.scope.workspaceId!),
          eq(emailSenderRules.address, input.address),
        ),
      )
      .returning({ id: emailSenderRules.id, folder: emailSenderRules.folder });
    if (gone)
      await ctx.emit({
        type: 'email_sender_rule.removed',
        entityType: 'email_sender_rule',
        entityId: gone.id,
        payload: { address: input.address },
        before: { address: input.address, folder: FOLDER_NAMES[gone.folder] },
      });
    return { address: input.address, removed: !!gone };
  },
});

export const mailFolderCommands = [conversationMove, emailSenderRuleRemove];
