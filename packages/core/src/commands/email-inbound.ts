import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { rows, type Tx } from '@hfos/db/client';
import {
  conversations,
  emailAddresses,
  emailSenderRules,
  emailSuppressions,
  mailboxConnections,
  messages,
  people,
} from '@hfos/db/schema';
import { workspaceZone } from '../calendar/load';
import { logChannelActivity } from '../crm/activities';
import { isIndeedApplicantEmail, isIndeedMachine } from '../crm/indeed';
import { intakeFromChannel, looksAutomatedEmail, type IntakeResult } from '../crm/intake';
import { fullName } from '../crm/records';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { emailDedupeKey, emailPreview, matchPersonByEmail, SPAM_SCORE } from '../messaging/email';
import {
  findConversation,
  findOrCreateConversation,
  scheduleJob,
  workspaceMessaging,
} from '../messaging/store';
import type { ConversationFolderValue } from '../schemas/conversation';
import {
  EmailReceiveInput,
  EmailReceiveOutput,
  EmailSuppressionRecordInput,
  EmailSuppressionRecordOutput,
} from '../schemas/message';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Mail older than this (a mailbox's first sync) is filed quietly: no unread count, no reminder. */
const FRESH_MS = 24 * 60 * 60 * 1000;

/** An address that bounced for good or marked us as spam: mail from it opens nothing. */
async function suppressed(tx: Tx, workspaceId: string, address: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.workspaceId, workspaceId),
        eq(emailSuppressions.address, address.toLowerCase()),
        isNull(emailSuppressions.releasedAt),
      ),
    )
    .limit(1);
  return !!row;
}

/** Where someone said new mail from this sender goes (M19), if they did. */
async function senderRule(
  tx: Tx,
  workspaceId: string,
  address: string,
): Promise<ConversationFolderValue | null> {
  const [r] = await tx
    .select({ folder: emailSenderRules.folder })
    .from(emailSenderRules)
    .where(
      and(
        eq(emailSenderRules.workspaceId, workspaceId),
        eq(emailSenderRules.address, address.toLowerCase()),
      ),
    )
    .limit(1);
  return r?.folder ?? null;
}

/** Whether this address already has an Inbox email thread here: someone the business talks to (M19). */
async function hasInboxThread(tx: Tx, workspaceId: string, counterpart: string): Promise<boolean> {
  const [c] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.channel, 'email'),
        eq(conversations.counterpart, counterpart),
        eq(conversations.folder, 'inbox'),
        isNull(conversations.privateTo),
      ),
    )
    .limit(1);
  return !!c;
}

/**
 * Whose mail this is (M19): the thread already on the lane it came in on decides, and a new one is its address's
 * person's. A person who no longer works here has their mail go to the business's default address instead, so the
 * team sees it while an owner decides what becomes of their address, and nobody reads what was theirs.
 */
async function whoseMail(
  ctx: CommandContext,
  counterpart: string,
  emailAddressId: string | null,
): Promise<{ emailAddressId: string | null; privateTo: string | null }> {
  if (!emailAddressId) return { emailAddressId, privateTo: null };
  const workspaceId = ctx.scope.workspaceId!;
  const [address] = await ctx.tx
    .select({ ownerUserId: emailAddresses.ownerUserId })
    .from(emailAddresses)
    .where(and(eq(emailAddresses.id, emailAddressId), eq(emailAddresses.workspaceId, workspaceId)));
  const owner = address?.ownerUserId ?? null;
  const lane = await findConversation(ctx, {
    channel: 'email',
    counterpart,
    phoneNumberId: null,
    emailAddressId,
    privateTo: owner,
  });
  const who = lane ? lane.privateTo : owner;
  if (!who) return { emailAddressId, privateTo: null };
  const [here] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select private.works_in(${who}::uuid, ${workspaceId}::uuid) as ok`,
  );
  if (here?.ok) return { emailAddressId, privateTo: who };
  const [fallback] = await ctx.tx
    .select({ id: emailAddresses.id })
    .from(emailAddresses)
    .where(and(eq(emailAddresses.workspaceId, workspaceId), eq(emailAddresses.isDefault, true)));
  return { emailAddressId: fallback?.id ?? null, privateTo: null };
}

type Conversation = typeof conversations.$inferSelect;

export const emailReceive = defineCommand({
  name: 'email.receive',
  description:
    'Worker: an email reached a workspace address, or a connected mailbox synced one. Files it in its thread (by reply token, thread headers or address): a customer’s in the Inbox, a stranger’s or a machine’s in Other mail, and spam in Spam.',
  risk: 1,
  input: EmailReceiveInput,
  output: EmailReceiveOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: [
    'message.received',
    'message.imported',
    'conversation.created',
    'conversation.linked',
    // A sender nobody knows becomes a customer and a lead here (M14), unless the business turned that off.
    'person.created',
    'lead.created',
    // Mail in Other mail or Spam (M19): filed, and nothing wakes up.
    'email.filed',
  ],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const none = { messageId: null, conversationId: null, unmatchedId: null };
    const header = input.messageIdHeader?.trim() || null;
    const dedupeKey = header
      ? emailDedupeKey(header)
      : `email:${input.provider}:${input.providerMessageId}`;
    // Replays, and the mailbox copy of an email sent from HandsFreeOS, land on the row that exists.
    const [dup] = await ctx.tx
      .select({ id: messages.id, conversationId: messages.conversationId })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          header
            ? or(eq(messages.dedupeKey, dedupeKey), eq(messages.messageIdHeader, header))
            : eq(messages.dedupeKey, dedupeKey),
        ),
      )
      .limit(1);
    if (dup)
      return {
        outcome: 'duplicate' as const,
        messageId: dup.id,
        conversationId: dup.conversationId,
        unmatchedId: null,
      };

    const ours = new Set(
      (
        await ctx.tx
          .select({ address: emailAddresses.address })
          .from(emailAddresses)
          .where(eq(emailAddresses.workspaceId, workspaceId))
      ).map((a) => a.address),
    );
    const [mailbox] = input.mailboxConnectionId
      ? await ctx.tx
          .select({
            userId: mailboxConnections.userId,
            accountEmail: mailboxConnections.accountEmail,
          })
          .from(mailboxConnections)
          .where(
            and(
              eq(mailboxConnections.id, input.mailboxConnectionId),
              eq(mailboxConnections.workspaceId, workspaceId),
            ),
          )
      : [];
    if (mailbox?.accountEmail) ours.add(mailbox.accountEmail);
    const inbound = input.direction === 'inbound';
    // Our own mail coming back around is not a customer writing.
    if (inbound && ours.has(input.from.address)) return { outcome: 'skipped' as const, ...none };

    // Who the conversation is with: the sender, or, for mail the mailbox sent, the first customer on it.
    let counterpart: string | null = inbound ? input.from.address : null;
    let personId: string | null = input.personId ?? null;
    if (!inbound) {
      for (const r of [...input.to, ...input.cc].slice(0, 20)) {
        if (ours.has(r.address)) continue;
        const match = await matchPersonByEmail(ctx.tx, workspaceId, r.address);
        if (match) {
          counterpart = r.address;
          personId ??= match;
          break;
        }
      }
    }
    if (!counterpart) return { outcome: 'skipped' as const, ...none };

    // Whose mail this is (M19): a person's own, or the team's. Mailbox imports are always the team's.
    const screened = inbound && !input.knownOnly;
    const { emailAddressId, privateTo } = screened
      ? await whoseMail(ctx, counterpart, input.emailAddressId ?? null)
      : { emailAddressId: input.emailAddressId ?? null, privateTo: null };
    // A thread the token or the headers name counts only if it is as private as this mail: a person's own mail
    // never lands in a team thread, nor the team's in theirs, whatever the headers say.
    const samePrivacy = (c: Conversation | null) => (c && c.privateTo === privateTo ? c : null);

    // The conversation: the Reply-To token, then the thread's headers, then this address's email thread.
    let conv: Conversation | null = null;
    if (input.replyToken)
      [conv = null] = await ctx.tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.channel, 'email'),
            eq(conversations.emailReplyToken, input.replyToken.toLowerCase()),
          ),
        );
    conv = samePrivacy(conv);
    const threadIds = [input.inReplyTo, ...input.references]
      .filter((h): h is string => !!h)
      .slice(-20);
    if (!conv && threadIds.length > 0) {
      const [earlier] = await ctx.tx
        .select({ conversationId: messages.conversationId })
        .from(messages)
        .where(
          and(
            eq(messages.workspaceId, workspaceId),
            eq(messages.channel, 'email'),
            inArray(messages.messageIdHeader, threadIds),
          ),
        )
        .orderBy(desc(messages.occurredAt))
        .limit(1);
      if (earlier)
        [conv = null] = await ctx.tx
          .select()
          .from(conversations)
          .where(eq(conversations.id, earlier.conversationId));
      conv = samePrivacy(conv);
    }
    // A thread keeps its folder (M19), so before anything else: the thread this address already has on the lane
    // it wrote to, when neither the token nor the headers named one. Mailbox imports keep their own rules.
    if (!conv && screened)
      conv = await findConversation(ctx, {
        channel: 'email',
        counterpart,
        phoneNumberId: null,
        emailAddressId,
        privateTo,
      });
    // An out-of-office or a list mail in an Inbox thread wakes nobody, as it never has: it isn't filed.
    if (conv && input.automatic && conv.folder === 'inbox')
      return { outcome: 'skipped' as const, ...none };

    /**
     * Whether this address has ever written here, on any of the business's addresses.
     *
     * This used to be `conv`, found by counterpart alone, and it was answering two questions at once. Only
     * one of them is about *which* thread, and since 0089 that one has an address in it:
     * `findOrCreateConversation` keys on the address they wrote to, so mail to support@ no longer lands in
     * the thread they started with sales@. The other two — which folder a stranger's new thread goes to, and
     * whether lead intake should make them a customer — are about the person, and a customer who wrote to
     * sales@ last week is neither a stranger nor a new lead because today they wrote to support@.
     */
    const known =
      conv !== null ||
      (
        await ctx.tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.workspaceId, workspaceId),
              eq(conversations.channel, 'email'),
              eq(conversations.counterpart, counterpart),
              isNull(conversations.privateTo),
            ),
          )
          .limit(1)
      ).length > 0;
    // A person's own mail is never linked to a customer (M19): that is what keeps it off their record.
    let matched = privateTo
      ? null
      : (personId ?? (await matchPersonByEmail(ctx.tx, workspaceId, counterpart)));
    const at = input.occurredAt ? new Date(input.occurredAt) : new Date();

    let folder: ConversationFolderValue = conv?.folder ?? 'inbox';
    if (!conv && privateTo) {
      // A new thread in a person's own mailbox: sorted like anyone's mail, but never a customer, never a lead,
      // and never by a rule the team saved.
      folder =
        (input.spamScore ?? 0) >= SPAM_SCORE
          ? 'spam'
          : input.automatic || looksAutomatedEmail(input.from, input.subject)
            ? 'other'
            : 'inbox';
    } else if (!conv && screened) {
      // A new thread, and where it lives (M19). The sender rule someone saved; then a customer's mail, in the
      // Inbox; then Spam, by the mail service's score; then Other mail for machines, for addresses that bounced
      // or complained, and for strangers already set aside elsewhere. Last, lead intake (M14): a stranger it
      // makes a customer of is in the Inbox, and one it doesn't take is in Other mail. Nothing is dropped.
      // Mail a person claimed for a customer is theirs, whatever a rule says.
      const rule = input.personId ? null : await senderRule(ctx.tx, workspaceId, counterpart);
      if (rule) folder = rule;
      else if (matched || (await hasInboxThread(ctx.tx, workspaceId, counterpart))) {
        if (input.automatic) return { outcome: 'skipped' as const, ...none };
        folder = 'inbox';
      } else if ((input.spamScore ?? 0) >= SPAM_SCORE) folder = 'spam';
      else if (
        known ||
        input.automatic ||
        looksAutomatedEmail(input.from, input.subject) ||
        // Indeed's own mail, and its word that somebody applied: the applicant is filed under Lead intake's
        // "Indeed" row (indeed_applicant.receive), never as somebody who emailed in.
        isIndeedMachine(counterpart) ||
        isIndeedApplicantEmail(input) ||
        (await suppressed(ctx.tx, workspaceId, counterpart))
      )
        folder = 'other';
      else {
        const intake: IntakeResult | null = await intakeFromChannel(
          ctx,
          {
            kind: 'email',
            email: counterpart,
            name: input.from.name ?? null,
            how: 'emailed in',
            at,
          },
          await workspaceZone(ctx.tx, workspaceId),
        );
        matched = intake?.personId ?? matched;
        folder = matched ? 'inbox' : 'other';
      }
    } else if (!known && !matched) return { outcome: 'skipped' as const, ...none };

    let created = false;
    if (!conv)
      ({ conversation: conv, created } = await findOrCreateConversation(ctx, {
        channel: 'email',
        counterpart,
        personId: matched,
        phoneNumberId: null,
        emailAddressId,
        folder,
        privateTo,
      }));
    // A thread someone else started a moment ago keeps its own folder.
    folder = conv.folder;
    // Other mail and Spam wake nobody: no AI teammate, workflow, push, timeline or reminder hears of it. Nor does
    // a person's own mail, and the history owners read says only that it came (M19).
    const sealed = conv.privateTo !== null;
    const quiet = folder !== 'inbox' || sealed;
    const autoLink = !conv.personId && !!matched;
    const person = conv.personId ?? matched;
    const fresh = Date.now() - at.getTime() < FRESH_MS;
    const newest = !conv.lastMessageAt || at.getTime() >= conv.lastMessageAt.getTime();
    const preview = emailPreview(input.subject, input.bodyText, input.media.length);
    const messageId = randomUUID();
    const author = !inbound ? (mailbox?.userId ?? null) : null;

    if (created)
      await ctx.emit({
        type: 'conversation.created',
        entityType: 'conversation',
        entityId: conv.id,
        payload: {
          channel: 'email',
          personId: person,
          folder,
          ...(sealed ? { private: true } : {}),
        },
        after: sealed
          ? { channel: 'email' }
          : { with: counterpart, channel: 'email', ...(quiet ? { folder } : {}) },
      });
    const eventId = await ctx.emit({
      type: quiet ? 'email.filed' : inbound ? 'message.received' : 'message.imported',
      entityType: 'message',
      entityId: messageId,
      payload: {
        conversationId: conv.id,
        personId: person,
        channel: 'email',
        mediaCount: input.media.length,
        ...(quiet
          ? { folder, direction: input.direction, ...(sealed ? { private: true } : {}) }
          : inbound
            ? { reopened: fresh && conv.status !== 'open' }
            : { mailboxConnectionId: input.mailboxConnectionId ?? null }),
      },
      after: sealed
        ? { mediaCount: input.media.length }
        : inbound
          ? { from: counterpart, subject: input.subject ?? null }
          : { to: counterpart, subject: input.subject ?? null },
      // Old mail from a mailbox's first sync should not light up everyone's inbox.
      broadcast: fresh,
    });
    const activityId = quiet
      ? null
      : await logChannelActivity(ctx, {
          kind: 'email',
          subtype: inbound ? 'inbound' : 'outbound',
          personId: person,
          body: (input.bodyText ?? '').slice(0, 10_000) || preview,
          occurredAt: at,
          eventId,
          ...(author ? { authorUserId: author } : {}),
          meta: {
            direction: input.direction,
            messageId,
            conversationId: conv.id,
            subject: input.subject ?? null,
            mediaCount: input.media.length,
            attachments: input.media.map(({ name, bucket, objectPath }) => ({
              name,
              bucket,
              objectPath,
            })),
            ...(inbound ? {} : { status: 'sent', via: 'mailbox' }),
          },
        });
    await ctx.tx.insert(messages).values({
      id: messageId,
      workspaceId,
      conversationId: conv.id,
      channel: 'email',
      direction: input.direction,
      status: inbound ? 'received' : 'sent',
      fromAddress: input.from.address,
      toAddresses: input.to.map((t) => t.address),
      ccAddresses: input.cc.map((c) => c.address),
      subject: input.subject ?? null,
      bodyText: input.bodyText ?? null,
      bodyHtml: input.bodyHtml ?? null,
      media: input.media,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      dedupeKey,
      messageIdHeader: header,
      inReplyToHeader: input.inReplyTo ?? null,
      referencesHeaders: input.references,
      providerThreadId: input.providerThreadId ?? null,
      emailAddressId,
      mailboxConnectionId: input.mailboxConnectionId ?? null,
      sentBy: author,
      occurredAt: at,
      sentAt: inbound ? null : at,
      activityId,
    });
    // New mail counts as unread and brings a closed thread back, in any folder; only the Inbox waits on a reply.
    const wake = inbound && fresh;
    const nudge = wake && !quiet;
    await ctx.tx
      .update(conversations)
      .set({
        ...(newest
          ? { lastMessageAt: at, lastPreview: preview, lastDirection: input.direction }
          : {}),
        ...(inbound ? { lastInboundAt: at } : { lastOutboundAt: at }),
        ...(wake
          ? {
              unreadCount: sql`${conversations.unreadCount} + 1`,
              status: 'open' as const,
              snoozedUntil: null,
              closedAt: null,
              closedBy: null,
            }
          : {}),
        ...(nudge
          ? {
              awaitingReplySince: sql`coalesce(${conversations.awaitingReplySince}, ${at.toISOString()}::timestamptz)`,
            }
          : {}),
        ...(!inbound && newest ? { awaitingReplySince: null } : {}),
        ...(autoLink ? { personId: person } : {}),
        ...(!conv.emailAddressId && emailAddressId ? { emailAddressId } : {}),
      })
      .where(eq(conversations.id, conv.id));

    if (autoLink && person) {
      const [p] = await ctx.tx
        .select({ firstName: people.firstName, lastName: people.lastName })
        .from(people)
        .where(eq(people.id, person));
      await ctx.emit({
        type: 'conversation.linked',
        entityType: 'conversation',
        entityId: conv.id,
        payload: { personId: person, previousPersonId: null, phoneAdded: false, auto: true },
        before: { person: null },
        after: { person: p ? fullName(p.firstName, p.lastName) : null, with: counterpart },
      });
    }
    if (nudge) {
      const m = await workspaceMessaging(ctx.tx, workspaceId);
      const reminderMs = input.reminderAfterMs ?? m.settings.unansweredReminderMinutes * 60_000;
      if (reminderMs > 0)
        await scheduleJob(ctx.tx, {
          kind: 'conversation.unanswered_check',
          dedupeKey: `unanswered:${conv.id}`,
          runAt: new Date(at.getTime() + reminderMs),
          payload: { conversationId: conv.id },
          workspaceId,
          organizationId: m.organizationId,
        });
    }
    return {
      outcome: 'filed' as const,
      messageId,
      conversationId: conv.id,
      unmatchedId: null,
      folder,
    };
  },
});

export const emailSuppressionRecord = defineCommand({
  name: 'email_suppression.record',
  description:
    'Worker: an address bounced for good, or its owner marked an email as spam. Email to it stops until someone releases it.',
  risk: 1,
  input: EmailSuppressionRecordInput,
  output: EmailSuppressionRecordOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['email_suppression.recorded'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [made] = await rows<{ id: string }>(
      ctx.tx,
      sql`insert into app.email_suppressions (workspace_id, address, reason, origin, message_id, provider_ref)
          values (${workspaceId}, ${input.address}, ${input.reason}::app.suppression_reason, ${input.origin ?? null},
            ${input.messageId ?? null}, ${input.providerRef ?? null})
          on conflict (workspace_id, address) where released_at is null do nothing
          returning id`,
    );
    if (made) {
      await ctx.emit({
        type: 'email_suppression.recorded',
        entityType: 'email_suppression',
        entityId: made.id,
        payload: { reason: input.reason, messageId: input.messageId ?? null },
        after: { address: input.address, reason: input.reason },
      });
      return { suppressionId: made.id, created: true };
    }
    const [existing] = await ctx.tx
      .select({ id: emailSuppressions.id })
      .from(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.workspaceId, workspaceId),
          eq(emailSuppressions.address, input.address),
          isNull(emailSuppressions.releasedAt),
        ),
      );
    return { suppressionId: existing!.id, created: false };
  },
});
