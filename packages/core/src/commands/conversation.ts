import { and, eq } from 'drizzle-orm';
import { conversations, people } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { fullName, requirePerson, userRef } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { stampSql } from '../kernel/field-merge';
import { changedSince, logLaterChange, whoChangedIt } from '../kernel/later-change';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import {
  findOrCreateConversation,
  isWorkspaceUser,
  defaultNumber,
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

/** Who a conversation is with, for audit sentences: the customer's name once linked, else the number or address. */
async function withWhom(
  ctx: CommandContext,
  c: { channel: string; counterpart: string; personId: string | null },
): Promise<string> {
  return (await personLabel(ctx, c.personId)) ?? withWho(c);
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
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const person = await requirePerson(ctx.tx, workspaceId, input.personId);
    const counterpart =
      input.channel === 'sms' ? person.phoneE164 : (person.email?.toLowerCase() ?? null);
    if (!counterpart)
      throw input.channel === 'sms'
        ? HfosError.rule('no_phone', 400, 'Add a mobile number to text this customer.')
        : HfosError.rule('no_email', 400, 'Add an email address to email this customer.');
    const number = input.channel === 'sms' ? await defaultNumber(ctx.tx, workspaceId) : null;
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
  offline: 'anytime',
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
      after: { unreadCount: 0, with: await withWhom(ctx, c) },
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
  offline: 'anytime',
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
      after: { unreadCount: 1, with: await withWhom(ctx, c) },
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
  actors: ['human', 'workflow'],
  offline: 'anytime',
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
      after: { assignee: after?.fullName ?? null, with: await withWhom(ctx, c) },
    });
    return { conversationId: c.id };
  },
});

const DAY = 86_400_000;

type Conversation = Awaited<ReturnType<typeof loadConversation>>;

/** The conversation, locked, for a change that checks what happened in it since it was made. */
async function lockConversation(
  ctx: CommandContext,
  conversationId: string,
): Promise<Conversation> {
  const [c] = await ctx.tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.workspaceId, ctx.scope.workspaceId!),
      ),
    )
    .for('update');
  if (!c) throw HfosError.notFound('Conversation not found.');
  return c;
}

/**
 * A close or a snooze someone overtook: the customer wrote, or someone reopened, snoozed or closed the conversation, after
 * this change was made (on a phone, perhaps long before it had signal). What happened since stands, and the customer's
 * timeline says so. True when it was overtaken.
 */
async function overtaken(ctx: CommandContext, c: Conversation, tried: string): Promise<boolean> {
  const wrote = changedSince(ctx.meta, c.lastInboundAt);
  if (!wrote && !changedSince(ctx.meta, c.statusChangedAt)) return false;
  let because: string;
  if (wrote) {
    const [p] = c.personId
      ? await ctx.tx
          .select({ firstName: people.firstName, lastName: people.lastName })
          .from(people)
          .where(eq(people.id, c.personId))
      : [];
    const name = p ? p.firstName.trim() || fullName(p.firstName, p.lastName) : '';
    because = `${name || 'the customer'} wrote again after that`;
  } else {
    const did = c.status === 'open' ? 'reopened' : c.status === 'snoozed' ? 'snoozed' : 'closed';
    const who = await whoChangedIt(
      ctx.tx,
      { type: 'conversation', id: c.id },
      [`conversation.${did}`],
      c.statusChangedAt,
    );
    because = `${who ? `${who} ${did} it` : `it was ${did}`} after that`;
  }
  await logLaterChange(
    ctx,
    { key: 'status', tried, because, changedAt: wrote ? c.lastInboundAt : c.statusChangedAt },
    { type: 'conversation', id: c.id },
    { personId: c.personId },
  );
  return true;
}

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
  offline: 'anytime',
  async handler(ctx, input) {
    const c = await lockConversation(ctx, input.conversationId);
    const until = new Date(input.until);
    // Measured from when the person snoozed it (on the phone, perhaps a while before it had signal).
    const madeAt = changeMoment(ctx.meta).getTime();
    if (until.getTime() < madeAt + 60_000)
      throw HfosError.validation([{ path: 'until', message: 'Pick a time in the future.' }]);
    if (until.getTime() > madeAt + 90 * DAY)
      throw HfosError.validation([{ path: 'until', message: 'Snooze for 90 days at most.' }]);
    // A snooze that ran out before it arrived has nothing left to do.
    if (until.getTime() <= Date.now()) return { conversationId: c.id };
    if (await overtaken(ctx, c, 'snooze the conversation'))
      return { conversationId: c.id, notApplied: ['status'] };
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
      after: { status: 'snoozed', until: until.toISOString(), with: await withWhom(ctx, c) },
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
  actors: ['human', 'workflow'],
  offline: 'anytime',
  async handler(ctx, input) {
    const c = await lockConversation(ctx, input.conversationId);
    if (c.status === 'closed') return { conversationId: c.id };
    if (await overtaken(ctx, c, 'close the conversation'))
      return { conversationId: c.id, notApplied: ['status'] };
    await ctx.tx
      .update(conversations)
      .set({
        status: 'closed',
        // Closed when the person closed it, even if the phone only now had signal.
        closedAt: changeMoment(ctx.meta),
        closedBy: userIdOf(ctx.actor),
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
      after: { status: 'closed', with: await withWhom(ctx, c) },
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
  offline: 'anytime',
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
      after: { status: 'open', with: await withWhom(ctx, c) },
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
  offline: 'anytime',
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
        .set({
          phoneE164: c.counterpart,
          phone: formatPhone(c.counterpart),
          fieldTimes: stampSql(['phone_e164'], changeMoment(ctx.meta)),
        })
        .where(eq(people.id, person.id));
      phoneAdded = true;
    } else if (c.channel === 'email' && !person.email) {
      await ctx.tx
        .update(people)
        .set({ email: c.counterpart, fieldTimes: stampSql(['email'], changeMoment(ctx.meta)) })
        .where(eq(people.id, person.id));
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

export const conversationArchive = defineCommand({
  name: 'conversation.archive',
  description:
    'Put a conversation away so it leaves the inbox. Its messages, calls and timeline stay; bring it back any time.',
  risk: 2,
  input: ConversationRefInput,
  output: ConversationRefOutput,
  // Archiving anywhere else in HandsFreeOS is an owner's or admin's, not anyone with the inbox.
  permission: 'records.archive',
  scope: inWorkspace,
  emits: ['conversation.archived'],
  offline: 'anytime',
  async handler(ctx, input) {
    const c = await loadConversation(ctx, input.conversationId);
    if (c.archivedAt) return { conversationId: c.id };
    await ctx.tx
      .update(conversations)
      // The status is untouched on purpose: restoring brings back the thread it was, not an open one.
      .set({ archivedAt: changeMoment(ctx.meta) })
      .where(eq(conversations.id, c.id));
    await ctx.emit({
      type: 'conversation.archived',
      entityType: 'conversation',
      entityId: c.id,
      payload: {},
      before: { archived: false, with: await withWhom(ctx, c) },
      after: { archived: true, with: await withWhom(ctx, c) },
    });
    return { conversationId: c.id };
  },
});

export const conversationRestore = defineCommand({
  name: 'conversation.restore',
  description: 'Bring an archived conversation back, in the state it was in when it was put away.',
  risk: 2,
  input: ConversationRefInput,
  output: ConversationRefOutput,
  permission: 'records.archive',
  scope: inWorkspace,
  emits: ['conversation.restored'],
  offline: 'anytime',
  async handler(ctx, input) {
    const c = await loadConversation(ctx, input.conversationId);
    if (!c.archivedAt) return { conversationId: c.id };
    await ctx.tx.update(conversations).set({ archivedAt: null }).where(eq(conversations.id, c.id));
    await ctx.emit({
      type: 'conversation.restored',
      entityType: 'conversation',
      entityId: c.id,
      payload: {},
      before: { archived: true, with: await withWhom(ctx, c) },
      after: { archived: false, with: await withWhom(ctx, c) },
    });
    return { conversationId: c.id };
  },
});
