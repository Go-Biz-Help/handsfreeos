import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { rows, type Tx } from '@hfos/db/client';
import {
  conversations,
  emailAddresses,
  emailInboundUnmatched,
  emailSuppressions,
  mailboxConnections,
  messages,
  people,
} from '@hfos/db/schema';
import { workspaceZone } from '../calendar/load';
import { logChannelActivity } from '../crm/activities';
import { intakeFromChannel, looksAutomatedEmail, type IntakeResult } from '../crm/intake';
import { fullName } from '../crm/records';
import { defineCommand } from '../kernel/define';
import { emailDedupeKey, emailPreview, matchPersonByEmail } from '../messaging/email';
import { findOrCreateConversation, scheduleJob, workspaceMessaging } from '../messaging/store';
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

type Conversation = typeof conversations.$inferSelect;

export const emailReceive = defineCommand({
  name: 'email.receive',
  description:
    'Worker: an email reached a workspace address, or a connected mailbox synced one. Files it in the customer’s conversation (by reply token, thread headers or address), or sets mail from someone we don’t know aside.',
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
    'email.unmatched_received',
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
    }
    if (!conv)
      [conv = null] = await ctx.tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.channel, 'email'),
            eq(conversations.counterpart, counterpart),
          ),
        );
    let matched = personId ?? (await matchPersonByEmail(ctx.tx, workspaceId, counterpart));
    const at = input.occurredAt ? new Date(input.occurredAt) : new Date();

    // Nobody we know wrote in: lead intake (M14) makes the customer and their lead, so the mail lands in a
    // real conversation instead of the unmatched list. Machines don't become leads — a bounce, an
    // out-of-office, a newsletter, or an address that already bounced for good.
    let intake: IntakeResult | null = null;
    if (
      !conv &&
      !matched &&
      inbound &&
      !input.knownOnly &&
      !looksAutomatedEmail(input.from, input.subject) &&
      !(await suppressed(ctx.tx, workspaceId, counterpart))
    ) {
      intake = await intakeFromChannel(
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
    }

    if (!conv && !matched) {
      if (!inbound || input.knownOnly) return { outcome: 'skipped' as const, ...none };
      // Someone we don't know: kept whole until the team claims it for a customer or dismisses it.
      const snippet =
        (input.bodyText ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) ||
        input.subject?.slice(0, 300) ||
        null;
      const [set] = await ctx.tx
        .insert(emailInboundUnmatched)
        .values({
          workspaceId,
          emailAddressId: input.emailAddressId ?? null,
          fromAddress: counterpart,
          fromName: input.from.name ?? null,
          toAddresses: input.to.map((t) => t.address),
          ccAddresses: input.cc.map((c) => c.address),
          subject: input.subject ?? null,
          snippet,
          bodyText: input.bodyText ?? null,
          bodyHtml: input.bodyHtml ?? null,
          media: input.media,
          messageIdHeader: header,
          inReplyToHeader: input.inReplyTo ?? null,
          referencesHeaders: input.references,
          receivedAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: emailInboundUnmatched.id });
      if (!set) return { outcome: 'duplicate' as const, ...none };
      await ctx.emit({
        type: 'email.unmatched_received',
        entityType: 'email_unmatched',
        entityId: set.id,
        payload: { from: counterpart },
        after: { from: counterpart, subject: input.subject ?? null },
      });
      return {
        outcome: 'unmatched' as const,
        messageId: null,
        conversationId: null,
        unmatchedId: set.id,
      };
    }

    let created = false;
    if (!conv)
      ({ conversation: conv, created } = await findOrCreateConversation(ctx, {
        channel: 'email',
        counterpart,
        personId: matched,
        phoneNumberId: null,
      }));
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
        payload: { channel: 'email', personId: person },
        after: { with: counterpart, channel: 'email' },
      });
    const eventId = await ctx.emit({
      type: inbound ? 'message.received' : 'message.imported',
      entityType: 'message',
      entityId: messageId,
      payload: {
        conversationId: conv.id,
        personId: person,
        channel: 'email',
        mediaCount: input.media.length,
        ...(inbound
          ? { reopened: fresh && conv.status !== 'open' }
          : { mailboxConnectionId: input.mailboxConnectionId ?? null }),
      },
      after: inbound
        ? { from: counterpart, subject: input.subject ?? null }
        : { to: counterpart, subject: input.subject ?? null },
      // Old mail from a mailbox's first sync should not light up everyone's inbox.
      broadcast: fresh,
    });
    const activityId = await logChannelActivity(ctx, {
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
      emailAddressId: input.emailAddressId ?? null,
      mailboxConnectionId: input.mailboxConnectionId ?? null,
      sentBy: author,
      occurredAt: at,
      sentAt: inbound ? null : at,
      activityId,
    });
    const nudge = inbound && fresh;
    await ctx.tx
      .update(conversations)
      .set({
        ...(newest
          ? { lastMessageAt: at, lastPreview: preview, lastDirection: input.direction }
          : {}),
        ...(inbound ? { lastInboundAt: at } : { lastOutboundAt: at }),
        ...(nudge
          ? {
              unreadCount: sql`${conversations.unreadCount} + 1`,
              status: 'open' as const,
              snoozedUntil: null,
              closedAt: null,
              closedBy: null,
              awaitingReplySince: sql`coalesce(${conversations.awaitingReplySince}, ${at.toISOString()}::timestamptz)`,
            }
          : {}),
        ...(!inbound && newest ? { awaitingReplySince: null } : {}),
        ...(autoLink ? { personId: person } : {}),
        ...(!conv.emailAddressId && input.emailAddressId
          ? { emailAddressId: input.emailAddressId }
          : {}),
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
    return { outcome: 'filed' as const, messageId, conversationId: conv.id, unmatchedId: null };
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
