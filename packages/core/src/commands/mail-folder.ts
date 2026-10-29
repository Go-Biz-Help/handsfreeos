/**
 * Moving email threads between the Inbox, Other mail and Spam (M19). A thread keeps its folder until a person moves
 * it; new mail in it doesn't. Moving one into the Inbox starts the AI teammate, workflows, push and the timeline
 * from its next message, and moving one out stops them. Remembering the move saves a sender rule, so the sender's
 * next new thread goes to the same place.
 */
import { and, eq } from 'drizzle-orm';
import { conversations, emailSenderRules, people } from '@hfos/db/schema';
import { fullName } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman, userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import { matchPersonByEmail } from '../messaging/email';
import { loadConversation } from '../messaging/store';
import {
  ConversationMoveInput,
  ConversationMoveOutput,
  ConversationShareInput,
  ConversationShareOutput,
  EmailSenderRuleRemoveInput,
  EmailSenderRuleRemoveOutput,
} from '../schemas/conversation';
import { linkConversation } from './conversation';
import { personCreate } from './person.create';

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
    // Sender rules are the team's: saved from someone's own mailbox, they would tell the team who writes to them.
    if (input.remember && c.privateTo)
      throw HfosError.rule(
        'sender_rule_private',
        409,
        'Where a sender’s mail goes is the team’s to remember, so it can’t be saved from your own mailbox. Move this thread without remembering.',
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

/**
 * Sharing a thread from someone's own mailbox with the team (M19): only its person does it, and from then on it is a
 * team thread, linked to the customer when their address is on one (their timeline then gets its mail), and mail
 * from them to that address comes to the team too.
 *
 * With a personId it is shared straight onto that customer, the one somebody picked to link it to or just added from
 * the thread, and they gain the address as `conversation.link_person` gives it; with newPerson the sender is added
 * as a customer first, with this address, through `person.create` (the phone's way, which can't wait for its own
 * queue to send them first). Own mail is never on a customer while it is private, so adding the sender from it is
 * one step that does both, and says so on its button.
 */
export const conversationShare = defineCommand({
  name: 'conversation.share',
  description:
    'Share a thread from your own mailbox with the team. It becomes a team thread, linked to the customer whose address it is, or to the customer you name.',
  risk: 2,
  input: ConversationShareInput,
  output: ConversationShareOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.shared', 'conversation.linked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const c = await loadConversation(ctx, input.conversationId);
    if (!c.privateTo)
      throw HfosError.rule(
        'conversation_not_private',
        409,
        'This thread is the team’s already, so there’s nothing to share.',
      );
    if (c.privateTo !== me) throw HfosError.forbidden();
    const chosen = input.newPerson
      ? (
          await executeCommandWithin(ctx, personCreate, {
            workspaceId: c.workspaceId,
            ...input.newPerson,
            email: c.counterpart,
          })
        ).output.personId
      : (input.personId ?? null);
    const personId = chosen ?? (await matchPersonByEmail(ctx.tx, c.workspaceId, c.counterpart));
    await ctx.tx
      .update(conversations)
      .set({ privateTo: null, ...(personId && !chosen ? { personId } : {}) })
      .where(eq(conversations.id, c.id));
    await ctx.emit({
      type: 'conversation.shared',
      entityType: 'conversation',
      entityId: c.id,
      payload: { personId },
      before: { mailbox: 'their own' },
      after: { mailbox: 'the team’s', with: c.counterpart },
    });
    if (chosen) await linkConversation(ctx, { ...c, privateTo: null }, chosen);
    else if (personId) {
      const [p] = await ctx.tx
        .select({ firstName: people.firstName, lastName: people.lastName })
        .from(people)
        .where(eq(people.id, personId));
      await ctx.emit({
        type: 'conversation.linked',
        entityType: 'conversation',
        entityId: c.id,
        payload: { personId, previousPersonId: null, phoneAdded: false, auto: true },
        before: { person: null },
        after: { person: p ? fullName(p.firstName, p.lastName) : null, with: c.counterpart },
      });
    }
    return { conversationId: c.id, personId };
  },
});

export const mailFolderCommands = [conversationMove, emailSenderRuleRemove, conversationShare];
