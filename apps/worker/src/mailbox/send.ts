import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import { mailboxConnections, messages } from '@hfos/db/schema';
import { renderEmailHtml } from '../email/render';
import { emailBrandFor } from '../look/public';
import type { EmailAttachment } from '../email/transport';
import type { HandlerContext } from '../handlers/types';
import { errorMessage } from '../outbox';
import { tenantOf } from '../services';
import { MailboxAuthError, MailboxError } from './provider';
import { failMailbox, freshTokens, PROVIDER_NAME } from './sync';

type Message = typeof messages.$inferSelect;
type Update = (input: Record<string, unknown>) => Promise<unknown>;

/**
 * Sends a queued email through the connected Outlook or Gmail mailbox it was written from. It lands in that
 * mailbox's Sent folder, so the next sync sees it and lands on this row (same Message-ID). Outlook answers
 * the customer's latest message in its thread; Gmail sends in the thread.
 */
export async function sendThroughMailbox(
  ctx: HandlerContext,
  m: Message,
  update: Update,
): Promise<void> {
  const scope = tenantOf(ctx.scope);
  const [box] = await ctx.tx
    .select()
    .from(mailboxConnections)
    .where(eq(mailboxConnections.id, m.mailboxConnectionId!));
  const label = box ? PROVIDER_NAME[box.provider] : 'The mailbox';
  if (!box || box.status !== 'active' || !box.tokenEnc || !box.accountEmail) {
    await update({
      status: 'failed',
      errorCode: 'mailbox_not_connected',
      errorMessage: `${label} isn’t connected anymore. Reconnect it in Settings → Email, or send from the workspace address.`,
    });
    return;
  }
  const provider = ctx.mailboxes.providers[box.provider];
  const [last] = await ctx.tx
    .select({ providerMessageId: messages.providerMessageId, threadId: messages.providerThreadId })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, m.conversationId),
        eq(messages.mailboxConnectionId, box.id),
        eq(messages.direction, 'inbound'),
        ne(messages.id, m.id),
        isNotNull(messages.providerMessageId),
      ),
    )
    .orderBy(desc(messages.occurredAt))
    .limit(1);
  const attachments: EmailAttachment[] = [];
  for (const media of m.media)
    attachments.push({
      name: media.name,
      contentType: media.contentType,
      content: await ctx.store.download(media.bucket, media.objectPath),
    });
  try {
    const tokens = await freshTokens(ctx, scope, box, provider);
    const sent = await provider.send(tokens.accessToken, {
      from: { address: box.accountEmail, name: box.displayName },
      to: m.toAddresses,
      cc: m.ccAddresses,
      subject: m.subject ?? '',
      text: m.bodyText ?? '',
      html: renderEmailHtml(m.bodyText ?? '', await emailBrandFor(ctx.tx, ctx.storageUrl, m)),
      messageIdHeader: m.messageIdHeader ?? `<${m.id}@${ctx.email.mailDomain}>`,
      inReplyTo: m.inReplyToHeader,
      references: m.referencesHeaders,
      attachments,
      replyToProviderMessageId:
        box.provider === 'microsoft' ? (last?.providerMessageId ?? null) : null,
      threadId: box.provider === 'google' ? (last?.threadId ?? null) : null,
    });
    await update({
      providerMessageId: sent.providerMessageId,
      status: 'sent',
      ...(sent.messageIdHeader !== m.messageIdHeader
        ? { messageIdHeader: sent.messageIdHeader }
        : {}),
    });
  } catch (e) {
    if (e instanceof MailboxAuthError) {
      await failMailbox(
        ctx.db,
        scope,
        box,
        'reauth_required',
        `${label} stopped accepting HandsFreeOS’s sign-in for ${box.accountEmail}.`,
      );
      await update({
        status: 'failed',
        errorCode: 'mailbox_reauth',
        errorMessage: `${label} needs ${box.accountEmail} to sign in again. Reconnect it in Settings → Email, then try again.`,
      });
      return;
    }
    if (e instanceof MailboxError && e.permanent) {
      await update({
        status: 'failed',
        errorCode: 'mailbox_refused',
        errorMessage: `${label} didn’t send it: ${e.message}`.slice(0, 500),
      });
      return;
    }
    // Worth another try, until the outbox's last: then it's "Not delivered", not "Sending…" for good.
    if (ctx.attempt < ctx.maxAttempts) throw e;
    ctx.log.warn({ err: errorMessage(e) }, 'email gave up after the last try');
    await update({
      status: 'failed',
      errorCode: 'mailbox_unreachable',
      errorMessage: `${label} didn’t answer, so this email didn’t go out. Try again in a minute.`,
    });
  }
}
