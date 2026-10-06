/**
 * What Meta's webhooks say, in our own shapes (20261025000200). Pure: no database, no network.
 *
 * A webhook is a batch: entries for Pages and Instagram accounts, each with messaging events. `splitWebhook` cuts it
 * into one stored delivery per event, keyed so a retry from Meta is stored once; `readEvent` turns one event into
 * what the processor acts on. Messenger and Instagram send nearly the same shapes, and where they differ (an ad's
 * referral inside the message or beside it, a read receipt by moment or by message) both are read.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { SocialReferral } from '@hfos/core';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max: number): string | null => {
  if (typeof v === 'number') return String(v).slice(0, max);
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
};

/** The kind a stored Meta event has: one processor reads them all (receive.ts). */
export const META_DELIVERY_KIND = 'messaging';

const ACCOUNT_ID = /^[0-9]{1,40}$/;
const SCOPED_ID = /^[0-9A-Za-z_-]{1,64}$/;
const AD_ID = /^[0-9A-Za-z_-]{1,64}$/;

/** Meta signs the exact bytes with the app's secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function verifyMetaSignature(
  rawBody: string,
  signature: string | undefined,
  appSecret: string,
): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const given = Buffer.from(signature.slice(7).trim(), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Facebook's `signed_request`, as its deauthorize and data deletion callbacks send it: the payload, if Facebook
 * signed it with this app's secret.
 */
export function readSignedRequest(
  signed: string | undefined,
  appSecret: string,
): { readonly userId: string } | null {
  if (!signed || signed.length > 4000) return null;
  const [sig, payload] = signed.split('.', 2);
  if (!sig || !payload) return null;
  const given = Buffer.from(sig, 'base64url');
  const expected = createHmac('sha256', appSecret).update(payload).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data: Json;
  try {
    data = obj(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
  if (String(data['algorithm'] ?? '').toUpperCase() !== 'HMAC-SHA256') return null;
  const userId = str(data['user_id'], 40);
  return userId && ACCOUNT_ID.test(userId) ? { userId } : null;
}

/** One messaging event out of a webhook, and the Page or Instagram account it came to. */
export interface SplitEvent {
  readonly platform: 'facebook' | 'instagram';
  /** The Page's or the Instagram account's own id: the entry's. */
  readonly accountExternalId: string;
  readonly event: Json;
  /** It came while another app held the conversation (Meta's handover): still a message to the business. */
  readonly standby: boolean;
  /** Stable across Meta's retries, so each is stored once. */
  readonly dedupeKey: string;
}

/**
 * A webhook's events, one each, for the Pages and accounts it names. Anything else in it (comments, feed) is left.
 * Nothing is cut short: Meta counts the whole post delivered once it hears back, so an event left out is lost.
 */
export function splitWebhook(body: unknown): SplitEvent[] {
  const o = obj(body);
  const platform =
    o['object'] === 'page' ? 'facebook' : o['object'] === 'instagram' ? 'instagram' : null;
  if (!platform) return [];
  const out: SplitEvent[] = [];
  for (const entry of arr(o['entry'])) {
    const e = obj(entry);
    const id = str(e['id'], 40);
    if (!id || !ACCOUNT_ID.test(id)) continue;
    for (const [list, standby] of [
      [e['messaging'], false],
      [e['standby'], true],
    ] as const)
      for (const raw of arr(list)) {
        const event = obj(raw);
        if (!Object.keys(event).length) continue;
        out.push({
          platform,
          accountExternalId: id,
          event,
          standby,
          dedupeKey: `${platform}:${id}:${eventKey(event)}`,
        });
      }
  }
  return out;
}

/** What makes an event itself: Meta's message id where there is one, else a hash of what it said. */
function eventKey(event: Json): string {
  const m = obj(event['message']);
  const mid = str(m['mid'], 300);
  if (mid) {
    if (m['is_deleted'] === true) return `unsent:${mid}`;
    return `${m['is_echo'] === true ? 'echo' : 'message'}:${mid}`;
  }
  const edit = obj(event['message_edit']);
  const edited = str(edit['mid'], 300);
  if (edited)
    return `edit:${edited}:${str(edit['num_edit'], 10) ?? str(event['timestamp'], 20) ?? ''}`;
  const pb = obj(event['postback']);
  const pbMid = str(pb['mid'], 300);
  if (pbMid) return `postback:${pbMid}`;
  return `hash:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`;
}

/** A file or a shared thing, as core's receive takes it. */
export interface EventAttachment {
  readonly type: string;
  readonly url: string | null;
  readonly title: string | null;
}

export type MetaEvent =
  | {
      readonly kind: 'message';
      readonly scopedId: string;
      readonly mid: string;
      readonly text: string | null;
      readonly attachments: readonly EventAttachment[];
      readonly replyToMid: string | null;
      readonly storyReply: boolean;
      readonly referral: SocialReferral | null;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'echo';
      readonly scopedId: string;
      readonly mid: string;
      readonly text: string | null;
      readonly attachments: readonly EventAttachment[];
      /** The app that sent it: ours means HandsFreeOS, already in the thread. Null when Meta doesn't say. */
      readonly appId: string | null;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'postback';
      readonly scopedId: string;
      readonly mid: string | null;
      readonly title: string | null;
      readonly referral: SocialReferral | null;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'referral';
      readonly scopedId: string;
      readonly referral: SocialReferral;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'delivered' | 'read';
      readonly scopedId: string;
      readonly watermark: string | null;
      readonly mids: readonly string[];
    }
  | {
      readonly kind: 'edit';
      readonly scopedId: string;
      readonly mid: string;
      readonly text: string | null;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'unsent';
      readonly scopedId: string;
      readonly mid: string;
      readonly occurredAt: string;
    }
  | { readonly kind: 'other'; readonly what: string };

const isoFrom = (ms: unknown): string | null => {
  const n = typeof ms === 'number' ? ms : typeof ms === 'string' ? Number(ms) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Seconds, now and then, rather than milliseconds.
  const at = new Date(n < 1e12 ? n * 1000 : n);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/** Where somebody came from, as Meta said it; null when it said nothing worth keeping. */
export function referralOf(raw: unknown): SocialReferral | null {
  const r = obj(raw);
  if (!Object.keys(r).length) return null;
  const ad = obj(r['ads_context_data']);
  const product = obj(r['product']);
  const adId = str(r['ad_id'], 64);
  const out: SocialReferral = {
    source: str(r['source'], 60),
    type: str(r['type'], 60),
    ref: str(r['ref'], 500),
    adId: adId && AD_ID.test(adId) ? adId : null,
    adTitle: str(ad['ad_title'], 1000),
    photoUrl: str(ad['photo_url'], 2000),
    videoUrl: str(ad['video_url'], 2000),
    postId: str(ad['post_id'], 200),
    productId: str(ad['product_id'], 200) ?? str(product['id'], 200),
    refererUri: str(r['referer_uri'], 2000),
    raw: trimmed(r),
  };
  return out.adId || out.ref || out.source || out.productId ? out : null;
}

function trimmed(v: Json): Record<string, unknown> {
  const cut = (x: unknown, depth: number): unknown => {
    if (typeof x === 'string') return x.slice(0, 2000);
    if (typeof x !== 'object' || x === null) return x;
    if (depth >= 4) return null;
    if (Array.isArray(x)) return x.slice(0, 20).map((y) => cut(y, depth + 1));
    return Object.fromEntries(
      Object.entries(x as Json)
        .slice(0, 40)
        .map(([k, y]) => [k, cut(y, depth + 1)]),
    );
  };
  return cut(v, 0) as Record<string, unknown>;
}

/** A message's files and shared things. A sticker is a picture with a sticker's id, and is said rather than kept. */
export function attachmentsOf(message: Json): EventAttachment[] {
  const out: EventAttachment[] = [];
  for (const raw of arr(message['attachments']).slice(0, 20)) {
    const a = obj(raw);
    const p = obj(a['payload']);
    let type = str(a['type'], 40) ?? 'fallback';
    if (type === 'image' && (p['sticker_id'] !== undefined || p['sticker'] !== undefined))
      type = 'sticker';
    let url = str(p['url'], 4000);
    // A shared location has no link: one to a map is what a person would send.
    const at = obj(p['coordinates']);
    if (
      type === 'location' &&
      !url &&
      typeof at['lat'] === 'number' &&
      typeof at['long'] === 'number'
    )
      url = `https://maps.google.com/?q=${at['lat']},${at['long']}`;
    out.push({ type, url, title: str(p['title'], 500) ?? str(a['title'], 500) });
  }
  // Instagram's way of saying there was something it won't share with apps.
  if (message['is_unsupported'] === true && out.length === 0)
    out.push({ type: 'unsupported', url: null, title: null });
  return out;
}

/** One event, read. `accountExternalId` is the entry's: the Page or account the event came to. */
export function readEvent(event: Json): MetaEvent {
  const sender = str(obj(event['sender'])['id'], 64);
  const recipient = str(obj(event['recipient'])['id'], 64);
  const at = isoFrom(event['timestamp']) ?? new Date().toISOString();
  const customer = (id: string | null) => (id && SCOPED_ID.test(id) ? id : null);

  const message = obj(event['message']);
  if (Object.keys(message).length) {
    const mid = str(message['mid'], 300);
    if (!mid) return { kind: 'other', what: 'message without an id' };
    const text = typeof message['text'] === 'string' ? message['text'].slice(0, 20000) : null;
    if (message['is_echo'] === true) {
      // The business wrote it: the customer is whom it went to.
      const to = customer(recipient);
      if (!to) return { kind: 'other', what: 'echo without a recipient' };
      return {
        kind: 'echo',
        scopedId: to,
        mid,
        text,
        attachments: attachmentsOf(message),
        appId: str(message['app_id'], 40),
        occurredAt: at,
      };
    }
    const from = customer(sender);
    if (!from) return { kind: 'other', what: 'message without a sender' };
    if (message['is_deleted'] === true)
      return { kind: 'unsent', scopedId: from, mid, occurredAt: at };
    const reply = obj(message['reply_to']);
    const story = obj(reply['story']);
    const storyUrl = str(story['url'], 4000);
    const attachments = attachmentsOf(message);
    return {
      kind: 'message',
      scopedId: from,
      mid,
      text,
      // A reply to their story keeps a link to it, while Meta's link works.
      attachments: storyUrl
        ? [...attachments, { type: 'story', url: storyUrl, title: null }]
        : attachments,
      replyToMid: str(reply['mid'], 300),
      storyReply: Object.keys(story).length > 0,
      referral: referralOf(message['referral']) ?? referralOf(event['referral']),
      occurredAt: at,
    };
  }

  const from = customer(sender);
  const postback = obj(event['postback']);
  if (Object.keys(postback).length) {
    if (!from) return { kind: 'other', what: 'postback without a sender' };
    return {
      kind: 'postback',
      scopedId: from,
      mid: str(postback['mid'], 300),
      title: str(postback['title'], 500),
      referral: referralOf(postback['referral']) ?? referralOf(event['referral']),
      occurredAt: at,
    };
  }
  if (event['referral'] !== undefined) {
    const referral = referralOf(event['referral']);
    if (!from || !referral) return { kind: 'other', what: 'referral without a sender or a source' };
    return { kind: 'referral', scopedId: from, referral, occurredAt: at };
  }
  const delivery = obj(event['delivery']);
  const read = obj(event['read']);
  for (const [kind, r] of [
    ['delivered', delivery],
    ['read', read],
  ] as const) {
    if (!Object.keys(r).length) continue;
    if (!from) return { kind: 'other', what: `${kind} without a sender` };
    const mids = [...arr(r['mids']), r['mid']]
      .map((m) => str(m, 300))
      .filter((m): m is string => !!m)
      .slice(0, 100);
    return { kind, scopedId: from, watermark: isoFrom(r['watermark']), mids };
  }
  const edit = obj(event['message_edit']);
  if (Object.keys(edit).length) {
    const mid = str(edit['mid'], 300);
    if (!from || !mid) return { kind: 'other', what: 'edit without a sender or a message' };
    const text = typeof edit['text'] === 'string' ? edit['text'].slice(0, 20000) : null;
    return { kind: 'edit', scopedId: from, mid, text, occurredAt: at };
  }
  if (event['reaction'] !== undefined) return { kind: 'other', what: 'reaction' };
  return {
    kind: 'other',
    what:
      Object.keys(event)
        .filter((k) => k !== 'sender' && k !== 'recipient' && k !== 'timestamp')
        .join(',') || 'empty',
  };
}
