import {
  executeCommand,
  isRcsAddress,
  messageAttachMedia,
  messageReceive,
  messageUpdateStatus,
  phoneOfAddress,
  RCS_SENDER_ID,
  rcsSenderIdOf,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { DeliveryContext, DeliveryProcessor } from '../deliveries';
import { chargeText } from '../money/usage-capture';
import { systemActor, workerMeta, type TenantScope } from '../services';
import { loadAccount } from '../telephony/accounts';

type Params = Readonly<Record<string, string | undefined>>;
type DeliveryStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'undelivered' | 'failed';

/** Provider statuses → ours. Anything else (receiving, received) says nothing about an outbound text. */
export const TEXT_STATUS: Readonly<Record<string, DeliveryStatus>> = {
  accepted: 'sending',
  scheduled: 'sending',
  queued: 'sending',
  sending: 'sending',
  sent: 'sent',
  delivered: 'delivered',
  // RCS says when the customer opened it (0103). It used to be folded into delivered.
  read: 'read',
  partially_delivered: 'delivered',
  undelivered: 'undelivered',
  failed: 'failed',
  canceled: 'failed',
};

const E164 = /^\+[1-9][0-9]{6,14}$/;
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/amr': 'amr',
  'audio/mpeg': 'mp3',
  'text/vcard': 'vcf',
  'text/x-vcard': 'vcf',
  'application/pdf': 'pdf',
};

/**
 * Whether a message or a callback came over RCS (0103): Twilio puts `rcs:` in front of the address — the
 * customer's `rcs:+15551234567` on the way in, the sender's `rcs:<id>` on the way out — and names the channel.
 */
const viaRcs = (p: Params): boolean =>
  isRcsAddress(p.From) || (p.ChannelPrefix ?? '').toLowerCase() === 'rcs';

/** The RCS sender a customer wrote to, as an address message.receive takes. */
function senderAddress(to: string | undefined): string {
  const id = rcsSenderIdOf(to ?? '');
  return `rcs:${RCS_SENDER_ID.test(id) ? id : 'sender'}`;
}

/** Where a delivery is done with: nothing more will come of it, so its content template can go. */
const FINISHED = new Set(['delivered', 'read', 'undelivered', 'failed']);

function tenant(ctx: DeliveryContext): TenantScope | null {
  const { workspaceId, organizationId } = ctx.delivery;
  return workspaceId && organizationId ? { workspaceId, organizationId } : null;
}

/**
 * A customer texted one of our numbers, or wrote to the business's RCS sender (0103): file it through
 * message.receive, then copy any photos off the provider. An RCS message is the same message on its way in —
 * the customer's number with `rcs:` in front of it — and lands in the same thread; a tapped button comes with
 * its id and its words, which the command matches to the message that offered it.
 */
export const onInboundText: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = ctx.delivery.params as Params;
  if (!scope || !p.MessageSid) return 'ignored';
  const rcs = viaRcs(p);
  const from = phoneOfAddress(p.From);
  const to = rcs ? senderAddress(p.To) : p.To;
  if (!from || !to || (!rcs && !E164.test(to))) {
    ctx.log.info({ from: p.From }, 'inbound text from a non-phone sender; ignored');
    return 'ignored';
  }
  const mediaCount = Math.min(Math.max(Number(p.NumMedia ?? 0) || 0, 0), 10);
  const tapped = !!(p.ButtonPayload || p.ButtonText);
  const { output } = await executeCommand(
    ctx.db,
    messageReceive,
    {
      workspaceId: scope.workspaceId,
      provider: ctx.telephony.name,
      providerMessageId: p.MessageSid,
      from,
      to,
      via: rcs ? 'rcs' : 'sms',
      ...(tapped
        ? {
            button: {
              payload: p.ButtonPayload?.slice(0, 300) || null,
              text: p.ButtonText?.slice(0, 300) || null,
              type: p.ButtonType?.slice(0, 40) || null,
            },
          }
        : {}),
      // A tap comes with the button's words as its body; a phone that leaves it out still says what it chose.
      body: p.Body || (tapped ? (p.ButtonText ?? '') : ''),
      mediaCount,
      // Advanced Opt-Out names the keyword it already answered; the default handling says nothing.
      keywordAnswered: !!p.OptOutType,
      ...(ctx.reminderOverrideMs ? { reminderAfterMs: ctx.reminderOverrideMs } : {}),
    },
    systemActor(scope),
    workerMeta(),
  );
  if (mediaCount > 0) await copyMedia(ctx, scope, output.messageId, p, mediaCount);
  // An inbound text is billed to us the moment it arrives, so it is billed on once, here. Segments are what
  // Twilio says they are on the way in; we do not re-count them from the body.
  await chargeText(ctx.wallet, scope, {
    messageSid: p.MessageSid,
    direction: 'inbound',
    segments: Math.max(1, Number(p.NumSegments ?? 1) || 1),
    mediaCount,
    counterpart: from,
    messageId: output.messageId,
  });
};

/** Photos and files stay on our storage, not the provider's: copy each, attach it, then delete the original. */
async function copyMedia(
  ctx: DeliveryContext,
  scope: TenantScope,
  messageId: string,
  p: Params,
  count: number,
): Promise<void> {
  const account = await asWorker(ctx.db, scope, (tx) =>
    loadAccount(tx, scope.workspaceId, ctx.sealer),
  );
  if (!account) throw new Error('no telephony account for this workspace');
  const media: {
    bucket: string;
    objectPath: string;
    contentType: string;
    sizeBytes: number;
    name: string;
  }[] = [];
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const url = p[`MediaUrl${i}`];
    if (!url) continue;
    const got = await ctx.telephony.fetchMedia(account, url);
    const contentType = p[`MediaContentType${i}`] || got.contentType;
    const ext = EXTENSIONS[contentType] ?? 'bin';
    const objectPath = `${scope.workspaceId}/messages/${messageId}/${i}.${ext}`;
    await ctx.store.upload('telephony', objectPath, got.data, contentType, { upsert: true });
    media.push({
      bucket: 'telephony',
      objectPath,
      contentType,
      sizeBytes: got.data.length,
      name: `${contentType.startsWith('image/') ? 'photo' : 'attachment'}-${i + 1}.${ext}`,
    });
    urls.push(url);
  }
  if (media.length > 0)
    await executeCommand(
      ctx.db,
      messageAttachMedia,
      { workspaceId: scope.workspaceId, messageId, media },
      systemActor(scope),
      workerMeta(),
    );
  for (const url of urls)
    await ctx.telephony
      .deleteMedia(account, url)
      .catch((e: unknown) => ctx.log.warn({ err: e }, 'could not delete provider media copy'));
}

/**
 * The carrier moved a text along: sent, delivered, read, failed. Callbacks can arrive out of order or twice.
 *
 * A text sent RCS first (0103) also learns here which way it went: `rcs:` in the callback's `From` when it went
 * over RCS, the thread's own number when Twilio fell back to SMS or MMS. And once it is done with — delivered,
 * read or failed — its content template is deleted at Twilio, where it would otherwise sit for good.
 */
export const onTextStatus: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = ctx.delivery.params as Params;
  const status =
    TEXT_STATUS[(p.MessageStatus ?? '').toLowerCase()] ??
    ((p.EventType ?? '').toUpperCase() === 'READ' ? 'read' : undefined);
  if (!scope || !p.MessageSid || !status) return 'ignored';
  const sent = await sentMessage(ctx, scope, p.MessageSid);
  const transport = viaRcs(p)
    ? ('rcs' as const)
    : E164.test(p.From ?? '')
      ? sent && sent.pictures > 0
        ? ('mms' as const)
        : ('sms' as const)
      : undefined;
  // A callback can beat our own record of the provider id; not-found retries with the outbox backoff.
  const { output } = await executeCommand(
    ctx.db,
    messageUpdateStatus,
    {
      workspaceId: scope.workspaceId,
      providerMessageId: p.MessageSid,
      status,
      errorCode: p.ErrorCode || null,
      errorMessage: p.ErrorMessage || null,
      ...(transport ? { transport } : {}),
    },
    systemActor(scope),
    workerMeta(),
  );
  if (sent?.content_sid && output.changed && FINISHED.has(output.status))
    await deleteTemplate(ctx, scope, sent.content_sid);
  // `sent`, `delivered` and `undelivered` all arrive for one message and Twilio bills us once, so all three
  // land on the row the first of them made. An undelivered text is still billed to us, so it is billed on.
  if (sent)
    await chargeText(ctx.wallet, scope, {
      messageSid: p.MessageSid,
      direction: 'outbound',
      status: p.MessageStatus ?? null,
      segments: sent.segments ?? 1,
      // A carousel is a picture message's worth over RCS, which is how Twilio prices rich media (0103).
      mediaCount:
        sent.pictures > 0 || sent.rich_kind === 'carousel' ? Math.max(1, sent.pictures) : 0,
      counterpart: sent.counterpart,
      messageId: sent.id,
    });
};

/** A delivered or failed rich text's template, gone from Twilio. Best effort: a leftover costs nothing. */
async function deleteTemplate(ctx: DeliveryContext, scope: TenantScope, contentSid: string) {
  try {
    const account = await asWorker(ctx.db, scope, (tx) =>
      loadAccount(tx, scope.workspaceId, ctx.sealer),
    );
    if (account) await ctx.telephony.deleteContent(account, contentSid);
  } catch (e) {
    ctx.log.warn({ err: e, contentSid }, 'could not delete a finished rcs template');
  }
}

/**
 * What our own row says the text was: its segments, its pictures (a carousel's ride on its cards, not here),
 * what it carried, its content template and who it went to.
 */
async function sentMessage(
  ctx: DeliveryContext,
  scope: TenantScope,
  providerMessageId: string,
): Promise<{
  id: string;
  segments: number | null;
  pictures: number;
  rich_kind: string | null;
  content_sid: string | null;
  counterpart: string;
} | null> {
  const [m] = await asWorker(ctx.db, scope, (tx) =>
    rows<{
      id: string;
      segments: number | null;
      pictures: number;
      rich_kind: string | null;
      content_sid: string | null;
      counterpart: string;
    }>(
      tx,
      sql`select m.id, m.segments, coalesce(jsonb_array_length(m.media), 0)::int as pictures,
            m.rich ->> 'kind' as rich_kind, m.content_sid, coalesce(c.counterpart, '') as counterpart
          from app.messages m left join app.conversations c on c.id = m.conversation_id
          where m.workspace_id = ${scope.workspaceId} and m.provider_message_id = ${providerMessageId}`,
    ),
  );
  return m ?? null;
}
