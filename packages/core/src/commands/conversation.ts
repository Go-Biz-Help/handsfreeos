import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { conversations, people } from '@hfos/db/schema';
import {
  MAX_OTHER_CONTACTS,
  otherEmailsOf,
  otherPhonesOf,
  tidyOtherEmails,
  tidyOtherPhones,
} from '../crm/contact-points';
import { formatPhone, normalizePhone } from '../crm/phone';
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
  preferredLane,
} from '../messaging/store';
import {
  ConversationAssignInput,
  ConversationLinkPersonInput,
  ConversationLinkPersonOutput,
  ConversationOpenInput,
  ConversationOpenOutput,
  ConversationCloseAllOutput,
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

/**
 * The number or email `to` names, when the customer has it on file — main or other (0103) — as a thread's
 * counterpart; anything else is refused rather than texted.
 */
function onFile(
  person: {
    phoneE164: string | null;
    email: string | null;
    otherPhones: readonly object[];
    otherEmails: readonly object[];
  },
  channel: 'sms' | 'email',
  to: string,
): string {
  if (channel === 'sms') {
    const e164 = normalizePhone(to);
    const theirs = [person.phoneE164, ...otherPhonesOf(person.otherPhones).map((p) => p.phone)];
    if (e164 && theirs.includes(e164)) return e164;
    throw HfosError.rule('not_their_number', 400, 'That number isn’t on this customer’s record.');
  }
  const email = to.trim().toLowerCase();
  const theirs = [
    person.email?.toLowerCase() ?? null,
    ...otherEmailsOf(person.otherEmails).map((e) => e.email),
  ];
  if (theirs.includes(email)) return email;
  throw HfosError.rule('not_their_email', 400, 'That email isn’t on this customer’s record.');
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
    const counterpart = input.to
      ? onFile(person, input.channel, input.to)
      : input.channel === 'sms'
        ? person.phoneE164
        : (person.email?.toLowerCase() ?? null);
    if (!counterpart)
      throw input.channel === 'sms'
        ? HfosError.rule('no_phone', 400, 'Add a mobile number to text this customer.')
        : HfosError.rule('no_email', 400, 'Add an email address to email this customer.');
    // Opening a customer's thread means the one they are actually on (0089), not a fresh one on the
    // business's default line. Only a customer with no thread at all starts one, and a text starts on the
    // default number exactly as it did before lines existed.
    const lane = await preferredLane(ctx.tx, workspaceId, input.channel, counterpart);
    const number =
      input.channel === 'sms' && !lane?.phoneNumberId
        ? await defaultNumber(ctx.tx, workspaceId)
        : null;
    const { conversation, created } = await findOrCreateConversation(ctx, {
      channel: input.channel,
      counterpart,
      personId: person.id,
      phoneNumberId: lane?.phoneNumberId ?? number?.id ?? null,
      emailAddressId: lane?.emailAddressId ?? null,
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

/**
 * Close every lane this customer has, in one go (0089).
 *
 * Closing is per lane, because finishing a text conversation says nothing about a mail thread that is still
 * waiting on an answer — but "I am done with this customer" is a real thing to want, and doing it lane by
 * lane is four clicks and a chance to miss one. So both, and this is the second one, deliberately a separate
 * command rather than a flag on `conversation.close`: it is a different-sized decision, it wants its own line
 * in the audit, and a phone replaying a queued close must never find it has grown into a close-everything.
 *
 * Each lane goes through the same checks one at a time, `overtaken` included, so a customer who wrote in
 * while somebody was reading keeps their lane open and the rest still close. The count that comes back is
 * how many actually did.
 */
export const conversationCloseAll = defineCommand({
  name: 'conversation.close_all',
  description: 'Close every one of this customer’s conversations, on every line.',
  risk: 1,
  input: ConversationRefInput,
  output: ConversationCloseAllOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['conversation.closed'],
  actors: ['human'],
  offline: 'anytime',
  async handler(ctx, input) {
    const c = await loadConversation(ctx, input.conversationId);
    const workspaceId = ctx.scope.workspaceId!;
    // The customer's lanes, by the same rule the inbox groups them under: their record when they have one,
    // their address when nobody has linked them. RLS keeps a narrowed member to the lanes they may see, so
    // "close all" closes all of what they were shown and never a thread they cannot open.
    const lanes = await ctx.tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          ne(conversations.status, 'closed'),
          c.personId
            ? eq(conversations.personId, c.personId)
            : and(
                isNull(conversations.personId),
                eq(conversations.channel, c.channel),
                eq(conversations.counterpart, c.counterpart),
              ),
        ),
      );
    let closed = 0;
    for (const { id } of lanes) {
      const lane = await lockConversation(ctx, id);
      if (lane.status === 'closed') continue;
      if (await overtaken(ctx, lane, 'close the conversation')) continue;
      await ctx.tx
        .update(conversations)
        .set({
          status: 'closed',
          closedAt: changeMoment(ctx.meta),
          closedBy: userIdOf(ctx.actor),
          snoozedUntil: null,
          awaitingReplySince: null,
        })
        .where(eq(conversations.id, lane.id));
      await ctx.emit({
        type: 'conversation.closed',
        entityType: 'conversation',
        entityId: lane.id,
        payload: { closedWithCustomer: true },
        before: { status: lane.status },
        after: { status: 'closed', with: await withWhom(ctx, lane) },
      });
      closed += 1;
    }
    return { conversationId: c.id, closed };
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
    } else if (c.channel === 'sms' || c.channel === 'email') {
      // They already have a main one: this number or address joins their others (0103), so the next text from
      // it finds them on its own.
      const column = c.channel === 'sms' ? 'other_phones' : 'other_emails';
      const theirs =
        c.channel === 'sms'
          ? [person.phoneE164, ...otherPhonesOf(person.otherPhones).map((p) => p.phone)]
          : [person.email?.toLowerCase(), ...otherEmailsOf(person.otherEmails).map((e) => e.email)];
      // A customer with a full list keeps it as it is: the link still stands, the number just isn't added.
      const full =
        (c.channel === 'sms'
          ? otherPhonesOf(person.otherPhones).length
          : otherEmailsOf(person.otherEmails).length) >= MAX_OTHER_CONTACTS;
      if (!theirs.includes(c.counterpart) && !full) {
        await ctx.tx
          .update(people)
          .set(
            c.channel === 'sms'
              ? {
                  otherPhones: tidyOtherPhones(
                    [...otherPhonesOf(person.otherPhones), { phone: c.counterpart }],
                    person.phoneE164,
                  ),
                  fieldTimes: stampSql([column], changeMoment(ctx.meta)),
                }
              : {
                  otherEmails: tidyOtherEmails(
                    [...otherEmailsOf(person.otherEmails), { email: c.counterpart }],
                    person.email,
                  ),
                  fieldTimes: stampSql([column], changeMoment(ctx.meta)),
                },
          )
          .where(eq(people.id, person.id));
        phoneAdded = true;
      }
    }
    /**
     * Every unlinked lane on this address, not only the one somebody clicked (0089).
     *
     * The inbox groups an unlinked thread under its address and a linked one under its customer, so linking
     * one of two text lanes would split the customer in two: one row under their name, one still under their
     * number, and both of them the same person. The lanes share a counterpart, so this is the identification
     * the click already made, applied to all of it.
     *
     * The lane that was clicked moves whoever it was linked to before, because re-linking a thread put on the
     * wrong customer is exactly what this command is for. A *sibling* already linked to somebody else is left
     * alone: that was a separate decision and this click did not overrule it.
     */
    await ctx.tx
      .update(conversations)
      .set({ personId: person.id })
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.channel, c.channel),
          eq(conversations.counterpart, c.counterpart),
          or(eq(conversations.id, c.id), isNull(conversations.personId)),
        ),
      );
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
