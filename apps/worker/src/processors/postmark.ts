import {
  emailReceive,
  emailSuppressionRecord,
  emailUnsubscribeRecord,
  executeCommand,
  messageUpdateStatus,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { DeliveryContext, DeliveryProcessor } from '../deliveries';
import { fileIndeedApplicant } from '../email/indeed';
import {
  headerOf,
  htmlToText,
  isAutomatic,
  messageIds,
  sanitizeInboundHtml,
  spamScoreOf,
  type MailHeader,
} from '../email/render';
import { systemActor, workerMeta, type TenantScope } from '../services';

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

interface StoredParty {
  Email?: string;
  Name?: string;
}
interface StoredMedia {
  bucket: string;
  objectPath: string;
  contentType: string;
  sizeBytes: number;
  name: string;
  contentId: string | null;
}
interface StoredInbound {
  MessageID: string;
  From?: string;
  FromName?: string;
  FromFull?: StoredParty;
  ToFull?: StoredParty[];
  CcFull?: StoredParty[];
  Subject?: string;
  Date?: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
  Headers?: MailHeader[];
  Attachments?: StoredMedia[];
  route?: { emailAddressId: string | null; replyToken: string | null };
}

function tenant(ctx: DeliveryContext): TenantScope | null {
  const { workspaceId, organizationId } = ctx.delivery;
  return workspaceId && organizationId ? { workspaceId, organizationId } : null;
}

const parties = (list: StoredParty[] | undefined) =>
  (list ?? [])
    .map((x) => ({ address: (x.Email ?? '').trim().toLowerCase(), name: x.Name?.trim() || null }))
    .filter((x) => EMAIL.test(x.address))
    .slice(0, 50);

/** The date the customer's mail program stamped, unless it is missing or in the future. */
function sentAt(value: string | undefined): string | undefined {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) && t <= Date.now() ? new Date(t).toISOString() : undefined;
}

/**
 * Someone wrote to a workspace address (or answered one of our emails). Automatic mail and what the spam filter
 * scored come along too: email.receive decides where they go (M19), and a customer's automatic mail is still never
 * filed.
 */
export const onInboundEmail: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = ctx.delivery.params as unknown as StoredInbound;
  if (!scope || !p.MessageID) return 'ignored';
  const headers = p.Headers ?? [];
  const from = (p.FromFull?.Email ?? p.From ?? '').trim().toLowerCase();
  if (!EMAIL.test(from)) return 'ignored';
  const media = p.Attachments ?? [];
  const cids = new Map<string, number>();
  media.forEach((m, i) => {
    if (m.contentId) cids.set(m.contentId.replace(/^<|>$/g, ''), i);
  });
  const text =
    p.StrippedTextReply?.trim() || p.TextBody?.trim() || (p.HtmlBody ? htmlToText(p.HtmlBody) : '');
  await executeCommand(
    ctx.db,
    emailReceive,
    {
      workspaceId: scope.workspaceId,
      provider: 'postmark',
      providerMessageId: p.MessageID,
      messageIdHeader: messageIds(headerOf(headers, 'Message-ID'))[0] ?? null,
      inReplyTo: messageIds(headerOf(headers, 'In-Reply-To'))[0] ?? null,
      references: messageIds(headerOf(headers, 'References')),
      from: { address: from, name: p.FromFull?.Name?.trim() || p.FromName?.trim() || null },
      to: parties(p.ToFull),
      cc: parties(p.CcFull),
      subject: p.Subject?.slice(0, 998) || null,
      bodyText: text.slice(0, 100_000) || null,
      bodyHtml: p.HtmlBody ? sanitizeInboundHtml(p.HtmlBody, cids).slice(0, 1_000_000) : null,
      media: media.slice(0, 20).map(({ bucket, objectPath, contentType, sizeBytes, name }) => ({
        bucket,
        objectPath,
        contentType,
        sizeBytes,
        name: name.slice(0, 200),
      })),
      replyToken: p.route?.replyToken ?? null,
      emailAddressId: p.route?.emailAddressId ?? null,
      occurredAt: sentAt(p.Date),
      automatic: isAutomatic(headers),
      spamScore: spamScoreOf(headers),
      ...(ctx.reminderOverrideMs ? { reminderAfterMs: ctx.reminderOverrideMs } : {}),
    },
    systemActor(scope),
    workerMeta(),
  );
  // Indeed telling the business somebody applied: the applicant is a lead of its own (email/indeed.ts).
  await fileIndeedApplicant(ctx, scope, {
    from: { address: from, name: p.FromFull?.Name?.trim() || p.FromName?.trim() || null },
    subject: p.Subject?.slice(0, 998) || null,
    text: p.TextBody?.trim() || (p.HtmlBody ? htmlToText(p.HtmlBody) : '') || null,
    key: messageIds(headerOf(headers, 'Message-ID'))[0] ?? `postmark:${p.MessageID}`,
    ...(sentAt(p.Date) ? { occurredAt: sentAt(p.Date)! } : {}),
    ours: [...parties(p.ToFull), ...parties(p.CcFull)].map((x) => x.address),
  });
};

/** Why an email bounced, in words a person can act on. */
function bounceReason(type: string | undefined, description: string | undefined): string {
  switch (type) {
    case 'HardBounce':
    case 'BadEmailAddress':
      return 'that address doesn’t exist';
    case 'Blocked':
      return 'the customer’s mail server blocked it';
    case 'DMARCPolicy':
      return 'the sending domain’s DNS records need fixing';
    default:
      return description?.slice(0, 200) || 'it could not be delivered';
  }
}

/** The mail service reported on an email we sent: delivered, bounced for good, or marked as spam. */
export const onEmailEvent: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = ctx.delivery.params as {
    RecordType?: string;
    MessageID?: string;
    Type?: string;
    Description?: string;
    Email?: string;
    Inactive?: boolean;
    ID?: number;
    Recipient?: string;
    SuppressSending?: boolean;
    SuppressionReason?: string;
  };
  if (!scope || !p.MessageID) return 'ignored';
  const update = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      messageUpdateStatus,
      { workspaceId: scope.workspaceId, providerMessageId: p.MessageID, ...input },
      systemActor(scope),
      workerMeta(),
    );
  const suppress = (reason: 'hard_bounce' | 'spam_complaint', messageId: string) =>
    p.Email
      ? executeCommand(
          ctx.db,
          emailSuppressionRecord,
          {
            workspaceId: scope.workspaceId,
            address: p.Email.trim().toLowerCase(),
            reason,
            messageId,
            ...(p.ID ? { providerRef: String(p.ID) } : {}),
            origin: 'postmark',
          },
          systemActor(scope),
          workerMeta(),
        )
      : null;
  switch (p.RecordType) {
    case 'Delivery':
      await update({ status: 'delivered' });
      return;
    case 'Bounce': {
      // A soft bounce: the mail service keeps trying, and the address stays usable.
      if (!p.Inactive) return 'ignored';
      const { output } = await update({
        status: 'bounced',
        errorCode: p.Type ?? 'HardBounce',
        errorMessage: bounceReason(p.Type, p.Description),
      });
      await suppress('hard_bounce', output.messageId);
      return;
    }
    case 'SpamComplaint': {
      const { output } = await update({
        status: 'complained',
        errorCode: 'SpamComplaint',
        errorMessage: 'the customer marked it as spam',
      });
      await suppress('spam_complaint', output.messageId);
      return;
    }
    case 'SubscriptionChange': {
      // Someone unsubscribed through Postmark's own link on the broadcast stream: the same as ours. Bounces and
      // complaints come as their own events above.
      if (!p.SuppressSending || p.SuppressionReason !== 'ManualSuppression' || !p.Recipient)
        return 'ignored';
      const [sent] = await asWorker(ctx.db, scope, (tx) =>
        rows<{ campaign_id: string | null }>(
          tx,
          sql`select r.campaign_id from app.messages m
              join app.campaign_recipients r on r.id = m.campaign_recipient_id
              where m.workspace_id = ${scope.workspaceId} and m.provider_message_id = ${p.MessageID}`,
        ),
      );
      await executeCommand(
        ctx.db,
        emailUnsubscribeRecord,
        {
          workspaceId: scope.workspaceId,
          address: p.Recipient.trim().toLowerCase(),
          campaignId: sent?.campaign_id ?? null,
          source: 'postmark',
        },
        systemActor(scope),
        workerMeta(),
      );
      return;
    }
    default:
      return 'ignored';
  }
};
