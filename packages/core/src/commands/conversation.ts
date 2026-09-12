import { eq } from 'drizzle-orm';
import { conversations, people } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { fullName, requirePerson, userRef } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  findOrCreateConversation,
  isWorkspaceUser,
  liveNumber,
  loadConversation,
} from '../messaging/store';
import {
  ConversationAssignInput,
  ConversationLinkPersonInput,
  ConversationLinkPersonOutput,
  ConversationOpenInput,
  ConversationOpenOutput,
  ConversationRefInput,
  ConversationRefOutput,
  ConversationSnoozeInput,
} from '../schemas/conversation';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const withWho = (c: { channel: string; counterpart: string }) =>
  c.channel === 'sms' ? formatPhone(c.counterpart) : c.counterpart;

async function personLabel(ctx: CommandContext, personId: string | null): Promise<string | null> {
  if (!personId) return null;
  const [p] = await ctx.tx
    .select({ firstName: people.firstName, lastName: people.lastName })
    .from(people)
    .where(eq(people.id, personId));
  return p ? fullName(p.firstName, p.lastName) : null;
}

export const conversationOpen = defineCommand({
  name: 'conversation.open',
  description: 'Open the text or email conversation with a customer, starting it if needed.',
  risk: 1,
  input: ConversationOpenInput,
  output: ConversationOpenOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.created', 'conversation.linked'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const person = await requirePerson(ctx.tx, workspaceId, input.personId);
    const counterpart =
      input.channel === 'sms' ? person.phoneE164 : (person.email?.toLowerCase() ?? null);
    if (!counterpart)
      throw input.channel === 'sms'
        ? HfosError.rule('no_phone', 400, 'Add a mobile number to text this customer.')
        : HfosError.rule('no_email', 400, 'Add an email address to email this customer.');
    const number = input.channel === 'sms' ? await liveNumber(ctx.tx, workspaceId) : null;
    const { conversation, created } = await findOrCreateConversation(ctx, {
      channel: input.channel,
      counterpart,
      personId: person.id,
      phoneNumberId: number?.id ?? null,
    });
    const name = fullName(person.firstName, person.lastName);
    if (created)
      await ctx.emit({
        type: 'conversation.created',
        entityType: 'conversation',
        entityId: conversation.id,
        payload: { channel: input.channel, personId: person.id },
        after: { with: name, channel: input.channel },
      });
    else if (!conversation.personId) {
      // An earlier unknown number turned out to be this customer: link it (the worker backfills the timeline).
      await ctx.tx
        .update(conversations)
        .set({ personId: person.id })
        .where(eq(conversations.id, conversation.id));
      await ctx.emit({
        type: 'conversation.linked',
        entityType: 'conversation',
        entityId: conversation.id,
        payload: { personId: person.id, previousPersonId: null, phoneAdded: false },
        before: { person: null },
        after: { person: name, with: withWho(conversation) },
      });
    }
    return { conversationId: conversation.id, created };
  },
});

export const conversationMarkRead = defineCommand({
  name: 'conversation.mark_read',
  description: 'Mark a conversation read for the whole team.',
  risk: 0,
  input: ConversationRefInput,
  output: ConversationRefOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.read'],
  async handler(ctx, input) {
    const c = await loadConversation(ctx, input.conversationId);
    if (c.unreadCount === 0) return { conversationId: c.id };
    await ctx.tx.update(conversations).set({ unreadCount: 0 }).where(eq(conversations.id, c.id));
    await ctx.emit({
      type: 'conversation.read',
      entityType: 'conversation',
      entityId: c.id,
      payload: { unread: c.unreadCount },
      before: { unreadCount: c.unreadCount },
      after: { unreadCount: 0, with: withWho(c) },
    });
    return { conversationId: c.id };
  },
});

export const conversationMarkUnread = defineCommand({
  name: 'conversation.mark_unread',
  description: 'Mark a conversation unread so it stands out in the inbox again.',
  risk: 0,
  input: ConversationRefInput,
  output: ConversationRefOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.marked_unread'],
  async handler(ctx, input) {
    const c = await loadConversation(ctx, input.conversationId);
    if (c.unreadCount > 0) return { conversationId: c.id };
    await ctx.tx.update(conversations).set({ unreadCount: 1 }).where(eq(conversations.id, c.id));
    await ctx.emit({
      type: 'conversation.marked_unread',
      entityType: 'conversation',
      entityId: c.id,
      payload: {},
      before: { unreadCount: 0 },
      after: { unreadCount: 1, with: withWho(c) },
    });
    return { conversationId: c.id };
  },
});

export const conversationAssign = defineCommand({
  name: 'conversation.assign',
  description: 'Give a conversation to a teammate, or leave it for anyone.',
  risk: 1,
  input: ConversationAssignInput,
  output: ConversationRefOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.assigned'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const c = await loadConversation(ctx, input.conversationId);
    if (c.assigneeUserId === input.assigneeUserId) return { conversationId: c.id };
    if (input.assigneeUserId && !(await isWorkspaceUser(ctx.tx, workspaceId, input.assigneeUserId)))
      throw HfosError.validation([
        { path: 'assigneeUserId', message: 'Pick someone in this workspace.' },
      ]);
    await ctx.tx
      .update(conversations)
      .set({ assigneeUserId: input.assigneeUserId })
      .where(eq(conversations.id, c.id));
    const before = await userRef(ctx.tx, c.assigneeUserId);
    const after = await userRef(ctx.tx, input.assigneeUserId);
    await ctx.emit({
      type: 'conversation.assigned',
      entityType: 'conversation',
      entityId: c.id,
      payload: { assigneeUserId: input.assigneeUserId },
      before: { assignee: before?.fullName ?? null },
      after: { assignee: after?.fullName ?? null, with: withWho(c) },
    });
    return { conversationId: c.id };
  },
});

const DAY = 86_400_000;

export const conversationSnooze = defineCommand({
  name: 'conversation.snooze',
  description:
    'Hide a conversation until a set time. It comes back then, or sooner if the customer writes again.',
  risk: 0,
  input: ConversationSnoozeInput,
  output: ConversationRefOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.snoozed'],
  async handler(ctx, input) {
    const c = await loadConversation(ctx, input.conversationId);
    const until = new Date(input.until);
    const now = Date.now();
    if (until.getTime() < now + 60_000)
      throw HfosError.validation([{ path: 'until', message: 'Pick a time in the future.' }]);
    if (until.getTime() > now + 90 * DAY)
      throw HfosError.validation([{ path: 'until', message: 'Snooze for 90 days at most.' }]);
    await ctx.tx
      .update(conversations)
      .set({ status: 'snoozed', snoozedUntil: until })
      .where(eq(conversations.id, c.id));
    await ctx.emit({
      type: 'conversation.snoozed',
      entityType: 'conversation',
      entityId: c.id,
      payload: { until: until.toISOString() },
      before: { status: c.status },
      after: { status: 'snoozed', until: until.toISOString(), with: withWho(c) },
    });
    return { conversationId: c.id };
  },
});

export const conversationClose = defineCommand({
  name: 'conversation.close',
  description: 'Close a conversation that needs nothing more. A new message opens it again.',
  risk: 0,
  input: ConversationRefInput,
  output: ConversationRefOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.closed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const c = await loadConversation(ctx, input.conversationId);
    if (c.status === 'closed') return { conversationId: c.id };
    await ctx.tx
      .update(conversations)
      .set({
        status: 'closed',
        closedAt: new Date(),
        closedBy: me.userId,
        snoozedUntil: null,
        awaitingReplySince: null,
      })
      .where(eq(conversations.id, c.id));
    await ctx.emit({
      type: 'conversation.closed',
      entityType: 'conversation',
      entityId: c.id,
      payload: {},
      before: { status: c.status },
      after: { status: 'closed', with: withWho(c) },
    });
    return { conversationId: c.id };
  },
});

export const conversationReopen = defineCommand({
  name: 'conversation.reopen',
  description: 'Bring a closed or snoozed conversation back into the inbox.',
  risk: 0,
  input: ConversationRefInput,
  output: ConversationRefOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.reopened'],
  // The worker brings snoozed conversations back when their time comes.
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const c = await loadConversation(ctx, input.conversationId);
    if (c.status === 'open') return { conversationId: c.id };
    await ctx.tx
      .update(conversations)
      .set({ status: 'open', closedAt: null, closedBy: null, snoozedUntil: null })
      .where(eq(conversations.id, c.id));
    await ctx.emit({
      type: 'conversation.reopened',
      entityType: 'conversation',
      entityId: c.id,
      payload: {},
      before: { status: c.status },
      after: { status: 'open', with: withWho(c) },
    });
    return { conversationId: c.id };
  },
});

export const conversationLinkPerson = defineCommand({
  name: 'conversation.link_person',
  description:
    'Tie a conversation from an unknown number or address to a customer. Earlier messages and calls join their timeline.',
  risk: 1,
  input: ConversationLinkPersonInput,
  output: ConversationLinkPersonOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.linked'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const c = await loadConversation(ctx, input.conversationId);
    const person = await requirePerson(ctx.tx, workspaceId, input.personId);
    if (person.archivedAt)
      throw HfosError.rule('person_archived', 409, 'Restore this customer before linking.');
    if (c.personId === person.id)
      return { conversationId: c.id, personId: person.id, phoneAdded: false };
    let phoneAdded = false;
    if (c.channel === 'sms' && !person.phoneE164) {
      await ctx.tx
        .update(people)
        .set({ phoneE164: c.counterpart, phone: formatPhone(c.counterpart) })
        .where(eq(people.id, person.id));
      phoneAdded = true;
    } else if (c.channel === 'email' && !person.email) {
      await ctx.tx.update(people).set({ email: c.counterpart }).where(eq(people.id, person.id));
      phoneAdded = true;
    }
    await ctx.tx
      .update(conversations)
      .set({ personId: person.id })
      .where(eq(conversations.id, c.id));
    const previous = await personLabel(ctx, c.personId);
    const name = fullName(person.firstName, person.lastName);
    await ctx.emit({
      type: 'conversation.linked',
      entityType: 'conversation',
      entityId: c.id,
      payload: { personId: person.id, previousPersonId: c.personId, phoneAdded },
      before: { person: previous },
      after: { person: name, with: withWho(c), contactAdded: phoneAdded },
    });
    return { conversationId: c.id, personId: person.id, phoneAdded };
  },
});
