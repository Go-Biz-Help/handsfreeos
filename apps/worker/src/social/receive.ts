/**
 * What Meta sent about a Page's or an Instagram account's messages, acted on (20261025000200). Each event was
 * stored on its own by routes.ts, keyed so a retry from Meta is stored once; this is its processor, retried with
 * the deliveries' own backoff when Meta or storage doesn't answer.
 *
 * - A message, a tapped button or a visit from an ad goes to core's meta_message.receive, with the customer's name
 *   when Meta shares it (asked once a week, not every message). Photos, videos, voice messages and files are then
 *   copied onto our own storage: Meta's links to them stop working.
 * - A reply the business wrote on Facebook or Instagram itself (an echo) is kept in the thread as theirs. One
 *   HandsFreeOS sent comes back too, marked with our app's id, and is already there.
 * - Delivery and read receipts, edits and messages taken back change the messages they name.
 */
import {
  executeCommand,
  messageAttachMedia,
  metaMessageEdit,
  metaMessageReceipt,
  metaMessageReceive,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { messages, metaContacts } from '@hfos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { DeliveryContext, DeliveryProcessor } from '../deliveries';
import { errorMessage } from '../outbox';
import { systemActor, workerMeta, type TenantScope } from '../services';
import { needsConverting } from '../telephony/video';
import { loadMetaAccount, type MetaAccountRow } from './accounts';
import { readEvent, type EventAttachment, type MetaEvent } from './events';
import { MetaError, type MetaProfile } from './graph';

type Params = Readonly<Record<string, string | undefined>>;
type Received = Extract<MetaEvent, { kind: 'message' | 'echo' | 'postback' | 'referral' }>;

const DAY = 86_400_000;
/** A customer's name and @handle are asked again after a week: people change them, rarely. */
const PROFILE_FRESH_MS = 7 * DAY;
/** How long one message's videos may spend becoming MP4s, all together (the same as a text's). */
const CONVERTING_MS = 3 * 60_000;
/** Meta's attachment types that are files we keep. */
const FILE_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'file']);
/** What a file is called when Meta doesn't say what type it is. */
const FALLBACK_TYPE: Readonly<Record<string, string>> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/mp4',
  file: 'application/octet-stream',
};
const KIND_NAME: Readonly<Record<string, string>> = {
  image: 'photo',
  video: 'video',
  audio: 'voice-message',
  file: 'file',
};
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
};

function tenant(ctx: DeliveryContext): TenantScope | null {
  const { workspaceId, organizationId } = ctx.delivery;
  return workspaceId && organizationId ? { workspaceId, organizationId } : null;
}

/** `meta:messaging`: one event for one Page or Instagram account (routes.ts). */
export const onMetaMessaging: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = ctx.delivery.params as Params;
  if (!scope || !p.accountId || !p.event) return 'ignored';
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(p.event) as Record<string, unknown>;
  } catch {
    return 'ignored';
  }
  const e = readEvent(raw);
  const actor = systemActor(scope);
  switch (e.kind) {
    case 'other':
      ctx.log.debug({ what: e.what }, 'a Meta event with nothing to keep');
      return 'ignored';
    case 'delivered':
    case 'read': {
      const { output } = await executeCommand(
        ctx.db,
        metaMessageReceipt,
        {
          workspaceId: scope.workspaceId,
          accountId: p.accountId,
          scopedId: e.scopedId,
          kind: e.kind,
          watermark: e.watermark,
          mids: [...e.mids],
        },
        actor,
        workerMeta(),
      );
      return output.updated > 0 ? undefined : 'ignored';
    }
    case 'edit':
    case 'unsent': {
      const { output } = await executeCommand(
        ctx.db,
        metaMessageEdit,
        {
          workspaceId: scope.workspaceId,
          accountId: p.accountId,
          mid: e.mid,
          text: e.kind === 'edit' ? e.text : null,
          unsent: e.kind === 'unsent',
          occurredAt: e.occurredAt,
        },
        actor,
        workerMeta(),
      );
      return output.messageId ? undefined : 'ignored';
    }
    default:
      return receive(ctx, scope, p.accountId, e);
  }
};

async function receive(
  ctx: DeliveryContext,
  scope: TenantScope,
  accountId: string,
  e: Received,
): Promise<void | 'ignored'> {
  const loaded = await asWorker(ctx.db, scope, (tx) =>
    loadMetaAccount(tx, ctx.sealer, scope.workspaceId, accountId),
  );
  // Meta keeps sending for a while after a Page is let go.
  if (!loaded || loaded.account.status === 'disconnected') return 'ignored';
  const { account, pageToken } = loaded;
  if (e.kind === 'echo') {
    // A reply HandsFreeOS sent, said back: it's in the thread already.
    const ours = ctx.social.graph.appId;
    if (e.appId && ours && e.appId === ours) return 'ignored';
    /*
     * Instagram doesn't always say which app sent it. A reply of ours whose ids aren't kept yet would look like
     * one written on Instagram itself, so while one is on its way in this thread the echo waits its turn; the
     * delivery's retry finds the ids kept, and core sees it was ours.
     */
    if (!e.appId && ctx.attempt < 3 && (await replyOnItsWay(ctx, scope, account, e.scopedId)))
      throw new Error('a reply of ours is on its way in this thread; its echo waits for it');
  }
  const profile = await profileOf(ctx, scope, account, pageToken, e.scopedId);
  const files = e.kind === 'message' || e.kind === 'echo' ? e.attachments : [];
  const { output } = await executeCommand(
    ctx.db,
    metaMessageReceive,
    {
      workspaceId: scope.workspaceId,
      accountId: account.id,
      kind: e.kind,
      scopedId: e.scopedId,
      mid: e.kind === 'referral' ? null : e.mid,
      eventKey: ctx.delivery.dedupeKey.slice(0, 300),
      text: e.kind === 'message' || e.kind === 'echo' ? e.text : null,
      attachments: files.map((a) => ({ type: a.type, url: a.url, title: a.title })),
      replyToMid: e.kind === 'message' ? e.replyToMid : null,
      storyReply: e.kind === 'message' ? e.storyReply : false,
      postbackTitle: e.kind === 'postback' ? e.title : null,
      referral: e.kind === 'echo' ? null : e.referral,
      profile,
      occurredAt: e.occurredAt,
    },
    systemActor(scope),
    workerMeta(),
  );
  if (output.outcome === 'ignored') return 'ignored';
  // A message Meta sent again whose files didn't all copy the first time gets them now.
  if (output.messageId) await copyFiles(ctx, scope, output.messageId, files);
}

/** One of ours to this customer, queued or going out in the last few minutes. */
async function replyOnItsWay(
  ctx: DeliveryContext,
  scope: TenantScope,
  account: MetaAccountRow,
  scopedId: string,
): Promise<boolean> {
  const found = await asWorker(ctx.db, scope, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`select m.id from app.messages m
          join app.meta_contacts mc on mc.conversation_id = m.conversation_id
          where mc.account_id = ${account.id} and mc.scoped_id = ${scopedId}
            and m.direction = 'outbound' and m.status in ('queued', 'sending')
            and m.occurred_at > now() - interval '10 minutes'
          limit 1`,
    ),
  );
  return found.length > 0;
}

/**
 * Their name and @handle, asked of Meta when we don't have them or haven't asked in a week. Null when not asked:
 * the thread keeps what it had. Meta not answering never holds a message up.
 */
async function profileOf(
  ctx: DeliveryContext,
  scope: TenantScope,
  account: MetaAccountRow,
  pageToken: string | null,
  scopedId: string,
): Promise<MetaProfile | null> {
  if (!pageToken) return null;
  const [known] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select({ checkedAt: metaContacts.profileCheckedAt })
      .from(metaContacts)
      .where(and(eq(metaContacts.accountId, account.id), eq(metaContacts.scopedId, scopedId))),
  );
  if (known?.checkedAt && Date.now() - known.checkedAt.getTime() < PROFILE_FRESH_MS) return null;
  try {
    // Asked, even when Meta won't say: it isn't asked again for a week.
    return (
      (await ctx.social.graph.profile({ platform: account.platform, scopedId, pageToken })) ?? {
        name: null,
        username: null,
      }
    );
  } catch (err) {
    ctx.log.info({ err: errorMessage(err) }, 'could not read a Messenger or Instagram profile');
    return null;
  }
}

/**
 * Photos, videos, voice messages and files stay on our storage, not Meta's: each is copied, then attached. A video
 * that isn't an MP4 is made into one so it plays in the inbox (telephony/video.ts). A file Meta no longer has, or
 * one too big to keep, is left out and the message still says what it was; Meta or storage not answering is
 * tried again with the delivery.
 */
async function copyFiles(
  ctx: DeliveryContext,
  scope: TenantScope,
  messageId: string,
  attachments: readonly EventAttachment[],
): Promise<void> {
  const wanted = attachments.filter((a) => FILE_TYPES.has(a.type) && a.url);
  if (wanted.length === 0) return;
  const [m] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select({ media: messages.media, unsentAt: messages.unsentAt })
      .from(messages)
      .where(eq(messages.id, messageId)),
  );
  // Copied already (Meta said it twice), or taken back: Meta asks that what was taken back isn't kept.
  if (!m || m.unsentAt || m.media.length > 0) return;
  const media: {
    bucket: string;
    objectPath: string;
    contentType: string;
    sizeBytes: number;
    name: string;
  }[] = [];
  const convertUntil = Date.now() + CONVERTING_MS;
  for (const [i, a] of wanted.entries()) {
    let got: { data: Buffer; contentType: string | null };
    try {
      got = await ctx.social.graph.download(a.url!);
    } catch (err) {
      if (err instanceof MetaError && !err.retryable) {
        ctx.log.warn(
          { err: err.message, type: a.type },
          'a file sent on Messenger or Instagram could not be kept',
        );
        continue;
      }
      throw err;
    }
    let contentType = got.contentType ?? FALLBACK_TYPE[a.type] ?? 'application/octet-stream';
    let data = got.data;
    if (needsConverting(contentType) && Date.now() < convertUntil) {
      const mp4 = await ctx.video.toMp4(data);
      if (mp4) {
        data = mp4;
        contentType = 'video/mp4';
      }
    }
    const ext = EXTENSIONS[contentType] ?? 'bin';
    const objectPath = `${scope.workspaceId}/messages/${messageId}/${i}.${ext}`;
    await ctx.store.upload('telephony', objectPath, data, contentType, { upsert: true });
    media.push({
      bucket: 'telephony',
      objectPath,
      contentType,
      sizeBytes: data.length,
      name: `${KIND_NAME[a.type] ?? 'file'}-${i + 1}.${ext}`,
    });
  }
  if (media.length === 0) return;
  await executeCommand(
    ctx.db,
    messageAttachMedia,
    { workspaceId: scope.workspaceId, messageId, media },
    systemActor(scope),
    workerMeta(),
  );
  // Taken back while it was being copied: the copies go too.
  const [after] = await asWorker(ctx.db, scope, (tx) =>
    tx.select({ unsentAt: messages.unsentAt }).from(messages).where(eq(messages.id, messageId)),
  );
  if (after?.unsentAt) for (const f of media) await ctx.store.remove(f.bucket, f.objectPath);
}
