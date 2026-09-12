import {
  executeCommand,
  messageAttachMedia,
  messageReceive,
  messageUpdateStatus,
} from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import type { DeliveryContext, DeliveryProcessor } from '../deliveries';
import { systemActor, workerMeta, type TenantScope } from '../services';
import { loadAccount } from '../telephony/accounts';

type Params = Readonly<Record<string, string | undefined>>;
type DeliveryStatus = 'sending' | 'sent' | 'delivered' | 'undelivered' | 'failed';

/** Provider statuses → ours. Anything else (receiving, received) says nothing about an outbound text. */
export const TEXT_STATUS: Readonly<Record<string, DeliveryStatus>> = {
  accepted: 'sending',
  scheduled: 'sending',
  queued: 'sending',
  sending: 'sending',
  sent: 'sent',
  delivered: 'delivered',
  read: 'delivered',
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

function tenant(ctx: DeliveryContext): TenantScope | null {
  const { workspaceId, organizationId } = ctx.delivery;
  return workspaceId && organizationId ? { workspaceId, organizationId } : null;
}

/** A customer texted one of our numbers: file it through message.receive, then copy any photos off the provider. */
export const onInboundText: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = ctx.delivery.params as Params;
  if (!scope || !p.MessageSid) return 'ignored';
  if (!p.From || !E164.test(p.From) || !p.To || !E164.test(p.To)) {
    ctx.log.info({ from: p.From }, 'inbound text from a non-phone sender; ignored');
    return 'ignored';
  }
  const mediaCount = Math.min(Math.max(Number(p.NumMedia ?? 0) || 0, 0), 10);
  const { output } = await executeCommand(
    ctx.db,
    messageReceive,
    {
      workspaceId: scope.workspaceId,
      provider: ctx.telephony.name,
      providerMessageId: p.MessageSid,
      from: p.From,
      to: p.To,
      body: p.Body ?? '',
      mediaCount,
      ...(ctx.reminderOverrideMs ? { reminderAfterMs: ctx.reminderOverrideMs } : {}),
    },
    systemActor(scope),
    workerMeta(),
  );
  if (mediaCount > 0) await copyMedia(ctx, scope, output.messageId, p, mediaCount);
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

/** The carrier moved a text along: sent, delivered, failed. Callbacks can arrive out of order or twice. */
export const onTextStatus: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = ctx.delivery.params as Params;
  const status = TEXT_STATUS[(p.MessageStatus ?? '').toLowerCase()];
  if (!scope || !p.MessageSid || !status) return 'ignored';
  // A callback can beat our own record of the provider id; not-found retries with the outbox backoff.
  await executeCommand(
    ctx.db,
    messageUpdateStatus,
    {
      workspaceId: scope.workspaceId,
      providerMessageId: p.MessageSid,
      status,
      errorCode: p.ErrorCode || null,
      errorMessage: p.ErrorMessage || null,
    },
    systemActor(scope),
    workerMeta(),
  );
};
