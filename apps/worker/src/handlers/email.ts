import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import {
  emailDomainRecord,
  emailReceive,
  emailSuppressionRecord,
  executeCommand,
  messageUpdateStatus,
} from '@hfos/core/server';
import {
  conversations,
  emailAddresses,
  emailDomains,
  emailInboundUnmatched,
  type messages,
} from '@hfos/db/schema';
import { renderEmailHtml } from '../email/render';
import { sendThroughMailbox } from '../mailbox/send';
import {
  isPermanentEmailError,
  mailbox,
  type DomainState,
  type EmailAttachment,
} from '../email/transport';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import type { EventHandler, HandlerContext } from './types';

const metaOf = (ctx: HandlerContext) => workerMeta(ctx.event.correlationId, ctx.event.id);

type Message = typeof messages.$inferSelect;

/**
 * Sends a queued email from a workspace address. Replies always come back through the shared subdomain,
 * whatever address sent it: the Reply-To's +token names the conversation.
 */
export async function sendQueuedEmail(ctx: HandlerContext, m: Message): Promise<void> {
  const scope = tenantOf(ctx.scope);
  const update = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      messageUpdateStatus,
      { workspaceId: scope.workspaceId, messageId: m.id, ...input },
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
        .select({ address: emailAddresses.address, displayName: emailAddresses.displayName })
        .from(emailAddresses)
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
    conv.token && shared
      ? mailbox(from.displayName, `${shared.localPart}+${conv.token}@${ctx.email.mailDomain}`)
      : null;
  const attachments: EmailAttachment[] = [];
  for (const media of m.media)
    attachments.push({
      name: media.name,
      contentType: media.contentType,
      content: await ctx.store.download(media.bucket, media.objectPath),
    });
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

async function recordDomain(
  ctx: HandlerContext,
  scope: TenantScope,
  emailDomainId: string,
  state: DomainState | null,
  error?: string,
) {
  const found = state
    ? Object.fromEntries(Object.entries(state).filter(([, v]) => v !== null && v !== undefined))
    : {};
  await executeCommand(
    ctx.db,
    emailDomainRecord,
    { workspaceId: scope.workspaceId, emailDomainId, ...found, ...(error ? { error } : {}) },
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

/** The workspace removed its domain: remove it at the mail service too. */
export const onEmailDomainRemoved: EventHandler = async (ctx) => {
  const id = (ctx.event.payload as { providerDomainId?: string | null }).providerDomainId;
  if (id) await ctx.email.domains.remove(id);
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
