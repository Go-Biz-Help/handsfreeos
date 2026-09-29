import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { HANDSFREEOS_DOMAIN } from '@hfos/core';
import {
  emailDomainRecord,
  emailReceive,
  emailSuppressionRecord,
  executeCommand,
  messageUpdateStatus,
  scheduleJob,
} from '@hfos/core/server';
import type { Tx } from '@hfos/db/client';
import {
  conversations,
  emailAddresses,
  emailDomains,
  emailInboundUnmatched,
  workspaces,
  type messages,
} from '@hfos/db/schema';
import { renderEmailHtml } from '../email/render';
import { oneClickUrl, unsubscribeToken } from '../email/unsubscribe';
import { emailDomainLapsedEmail, emailDomainVerifiedEmail } from '../emails/templates';
import { sendThroughMailbox } from '../mailbox/send';
import {
  isPermanentEmailError,
  mailbox,
  type DomainState,
  type EmailAttachment,
} from '../email/transport';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { managers } from './telephony';
import type { EventHandler, HandlerContext } from './types';

const metaOf = (ctx: HandlerContext) => workerMeta(ctx.event.correlationId, ctx.event.id);

type Message = typeof messages.$inferSelect;

/**
 * Sends a queued email from a workspace address. Replies come back through the shared subdomain, whatever address
 * sent it: the Reply-To's +token names the conversation. An address on a domain whose mail arrives here (M19) has
 * no Reply-To: the reply comes straight back to it, and its In-Reply-To finds the conversation.
 */
export async function sendQueuedEmail(ctx: HandlerContext, m: Message): Promise<void> {
  const scope = tenantOf(ctx.scope);
  const update = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      messageUpdateStatus,
      {
        workspaceId: scope.workspaceId,
        messageId: m.id,
        // A retry's send takes the place of the provider id the failed attempt left (message.retry).
        ...(input.providerMessageId && m.providerMessageId
          ? { replacesProviderMessageId: m.providerMessageId }
          : {}),
        ...input,
      },
      systemActor(scope),
      metaOf(ctx),
    );
  if (m.mailboxConnectionId) return sendThroughMailbox(ctx, m, update);
  const [conv] = await ctx.tx
    .select({ token: conversations.emailReplyToken })
    .from(conversations)
    .where(eq(conversations.id, m.conversationId));
  const [from] = m.emailAddressId
    ? await ctx.tx
        .select({
          address: emailAddresses.address,
          displayName: emailAddresses.displayName,
          receiving: emailDomains.receiving,
        })
        .from(emailAddresses)
        .leftJoin(emailDomains, eq(emailDomains.id, emailAddresses.emailDomainId))
        .where(eq(emailAddresses.id, m.emailAddressId))
    : [];
  const [shared] = await ctx.tx
    .select({ localPart: emailAddresses.localPart })
    .from(emailAddresses)
    .where(
      and(eq(emailAddresses.workspaceId, scope.workspaceId), isNull(emailAddresses.emailDomainId)),
    )
    .orderBy(desc(emailAddresses.isDefault), asc(emailAddresses.createdAt))
    .limit(1);
  if (!conv || !from) {
    await update({
      status: 'failed',
      errorCode: 'no_address',
      errorMessage: 'The address this email was going from no longer exists.',
    });
    return;
  }
  const replyTo =
    conv.token && shared && from.receiving !== 'on'
      ? mailbox(from.displayName, `${shared.localPart}+${conv.token}@${ctx.email.mailDomain}`)
      : null;
  const attachments: EmailAttachment[] = [];
  for (const media of m.media)
    attachments.push({
      name: media.name,
      contentType: media.contentType,
      content: await ctx.store.download(media.bucket, media.objectPath),
    });
  // A campaign email: the mail app's own unsubscribe button (RFC 8058), on the broadcast stream.
  const unsubscribe = m.campaignRecipientId
    ? oneClickUrl(
        ctx.unsubscribeLinks,
        unsubscribeToken(ctx.unsubscribeLinks, m.campaignRecipientId),
      )
    : null;
  try {
    const sent = await ctx.email.transport.send({
      from: { address: from.address, name: from.displayName },
      to: m.toAddresses,
      cc: m.ccAddresses,
      replyTo,
      subject: m.subject ?? '',
      text: m.bodyText ?? '',
      html: renderEmailHtml(m.bodyText ?? ''),
      messageIdHeader: m.messageIdHeader ?? `<${m.id}@${ctx.email.mailDomain}>`,
      inReplyTo: m.inReplyToHeader,
      references: m.referencesHeaders,
      attachments,
      metadata: {
        messageId: m.id,
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      },
      ...(unsubscribe
        ? {
            bulk: true,
            headers: [
              { name: 'List-Unsubscribe', value: `<${unsubscribe}>` },
              { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
            ],
          }
        : {}),
    });
    await update({
      providerMessageId: sent.providerMessageId,
      status: 'sent',
      ...(sent.messageIdHeader !== m.messageIdHeader
        ? { messageIdHeader: sent.messageIdHeader }
        : {}),
    });
  } catch (e) {
    if (!isPermanentEmailError(e)) throw e;
    const inactive = e.code === '406';
    // Postmark stopped this address before (a bounce or a complaint): stop it here too.
    if (inactive && m.toAddresses[0])
      await executeCommand(
        ctx.db,
        emailSuppressionRecord,
        {
          workspaceId: scope.workspaceId,
          address: m.toAddresses[0],
          reason: 'hard_bounce',
          messageId: m.id,
          origin: 'postmark-inactive',
        },
        systemActor(scope),
        metaOf(ctx),
      );
    await update({
      status: 'failed',
      errorCode: e.code,
      errorMessage: inactive
        ? 'This address bounced or reported spam before, so the mail service won’t send to it.'
        : e.message.slice(0, 500),
    });
  }
}

/** What the mail service said about a domain, as email_domain.record takes it (what it left out stays as is). */
export const domainRecordInput = (state: DomainState): Record<string, unknown> =>
  Object.fromEntries(Object.entries(state).filter(([, v]) => v !== null && v !== undefined));

/** The records that don't verify: "DKIM record", "Return-Path record", or both. */
export function missingRecords(state: {
  dkimVerified: boolean;
  returnPathVerified: boolean;
}): string {
  if (!state.dkimVerified && !state.returnPathVerified) return 'DKIM and Return-Path records';
  return state.dkimVerified ? 'Return-Path record' : 'DKIM record';
}

/** What Settings → Email says about a verified domain whose records stopped verifying. */
export function lapsedMessage(
  state: { dkimVerified: boolean; returnPathVerified: boolean },
  shared: string | null,
): string {
  const records = missingRecords(state);
  const plural = records.endsWith('records');
  return `The ${records} stopped verifying, so email goes out from ${shared ?? 'the shared address'} until ${plural ? 'they’re' : 'it’s'} fixed. Put the ${plural ? 'records' : 'record'} back at your DNS provider, then press Check now.`;
}

/** The workspace's address on the shared subdomain (the default one first): where its mail goes when its own domain can't. */
export async function sharedAddress(tx: Tx, workspaceId: string): Promise<string | null> {
  const [a] = await tx
    .select({ address: emailAddresses.address })
    .from(emailAddresses)
    .where(and(eq(emailAddresses.workspaceId, workspaceId), isNull(emailAddresses.emailDomainId)))
    .orderBy(desc(emailAddresses.isDefault), asc(emailAddresses.createdAt))
    .limit(1);
  return a?.address ?? null;
}

async function recordDomain(
  ctx: HandlerContext,
  scope: TenantScope,
  emailDomainId: string,
  state: DomainState | null,
  error?: string,
) {
  await executeCommand(
    ctx.db,
    emailDomainRecord,
    {
      workspaceId: scope.workspaceId,
      emailDomainId,
      ...(state ? domainRecordInput(state) : {}),
      ...(error ? { error } : {}),
    },
    systemActor(scope),
    metaOf(ctx),
  );
}

const loadDomain = async (ctx: HandlerContext) =>
  (await ctx.tx.select().from(emailDomains).where(eq(emailDomains.id, ctx.event.entityId!)))[0];

/** A workspace added its own domain: create it at the mail service and store the DNS records to show. */
export const onEmailDomainAdded: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const d = await loadDomain(ctx);
  if (!d || d.providerDomainId) return;
  try {
    await recordDomain(ctx, scope, d.id, await ctx.email.domains.create(d.domain));
  } catch (e) {
    if (!isPermanentEmailError(e)) throw e;
    await recordDomain(ctx, scope, d.id, null, e.message);
  }
};

/** Someone pressed Verify: ask the mail service to look for the records now. */
export const onEmailDomainVerifyRequested: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const d = await loadDomain(ctx);
  if (!d) return;
  try {
    const id = d.providerDomainId ?? (await ctx.email.domains.create(d.domain)).providerDomainId;
    await recordDomain(ctx, scope, d.id, await ctx.email.domains.verify(id));
  } catch (e) {
    if (!isPermanentEmailError(e)) throw e;
    await recordDomain(ctx, scope, d.id, null, e.message);
  }
};

/**
 * Owners and admins hear when their domain verifies (after Check now or the daily check), and when a verified one
 * stops verifying: its mail then goes out from the shared address until the records are back.
 */
export const onEmailDomainChecked: EventHandler = async (ctx) => {
  const p = ctx.event.payload as { status?: string; changed?: boolean; from?: string };
  if (!p.changed) return;
  const lapsed = p.status === 'failed' && p.from === 'verified';
  if (p.status !== 'verified' && !lapsed) return;
  const scope = tenantOf(ctx.scope);
  const d = await loadDomain(ctx);
  // Removed since, or changed again by a later check: the email would no longer be true.
  if (!d || d.status !== p.status) return;
  const recipients = await managers(ctx.tx, scope.workspaceId);
  if (recipients.length === 0) return;
  const [ws] = await ctx.tx
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId));
  const business = ws?.name ?? 'your business';
  const link = `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/email`;
  const mail = lapsed
    ? emailDomainLapsedEmail({
        business,
        domain: d.domain,
        records: missingRecords({
          dkimVerified: !!d.dkimVerifiedAt,
          returnPathVerified: !!d.returnPathVerifiedAt,
        }),
        sharedAddress:
          (await sharedAddress(ctx.tx, scope.workspaceId)) ??
          `your ${ctx.email.mailDomain} address`,
        link,
      })
    : emailDomainVerifiedEmail({ business, domain: d.domain, link });
  for (const r of recipients) await ctx.mailer.send({ to: r.email, ...mail });
};

/** A receiving domain's MX check (scheduled.ts): now, every 15 minutes while it waits, and daily after. */
export const EMAIL_RECEIVING_CHECK_JOB = 'email_domain.receiving_check';
export const receivingCheckKey = (emailDomainId: string) =>
  `email-receiving-check:${emailDomainId}`;

/** A business asked to receive its mail at one of its domains (M19): look for its MX now. */
export const onEmailDomainReceivingRequested: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const emailDomainId = ctx.event.entityId;
  if (!emailDomainId) return;
  await scheduleJob(
    ctx.tx,
    {
      kind: EMAIL_RECEIVING_CHECK_JOB,
      dedupeKey: receivingCheckKey(emailDomainId),
      runAt: new Date(),
      payload: { emailDomainId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    // A daily check already waiting for this domain comes forward instead.
    { pullEarlier: true },
  );
};

/**
 * The workspace removed its domain: remove it at the mail service too. Never handsfreeos.com (M19): HandsFreeOS's
 * own mail (no-reply@, alerts@, the support desk) sends as it, whichever business had it in its settings.
 */
export const onEmailDomainRemoved: EventHandler = async (ctx) => {
  const p = ctx.event.payload as { domain?: string; providerDomainId?: string | null };
  if (p.domain === HANDSFREEOS_DOMAIN) return;
  if (p.providerDomainId) await ctx.email.domains.remove(p.providerDomainId);
};

/** Mail from someone we didn't know was claimed for a customer: file it in their conversation. */
export const onUnmatchedClaimed: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const id =
    (ctx.event.payload as { unmatchedId?: string }).unmatchedId ?? ctx.event.entityId ?? '';
  const [u] = await ctx.tx
    .select()
    .from(emailInboundUnmatched)
    .where(eq(emailInboundUnmatched.id, id));
  if (!u?.resolvedPersonId || u.resolvedMessageId) return;
  const { output } = await executeCommand(
    ctx.db,
    emailReceive,
    {
      workspaceId: scope.workspaceId,
      provider: 'postmark',
      providerMessageId: `unmatched:${u.id}`,
      messageIdHeader: u.messageIdHeader,
      inReplyTo: u.inReplyToHeader,
      references: u.referencesHeaders,
      from: { address: u.fromAddress, name: u.fromName },
      to: u.toAddresses.map((address) => ({ address })),
      cc: u.ccAddresses.map((address) => ({ address })),
      subject: u.subject,
      bodyText: u.bodyText,
      bodyHtml: u.bodyHtml,
      media: u.media,
      emailAddressId: u.emailAddressId,
      occurredAt: u.receivedAt.toISOString(),
      personId: u.resolvedPersonId,
    },
    systemActor(scope),
    metaOf(ctx),
  );
  if (output.messageId)
    await ctx.tx
      .update(emailInboundUnmatched)
      .set({ resolvedMessageId: output.messageId })
      .where(eq(emailInboundUnmatched.id, u.id));
};
