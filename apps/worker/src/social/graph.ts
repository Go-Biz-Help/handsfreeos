/**
 * Meta's Graph API behind one seam (20261025000200): signing a business in to Facebook, listing the Pages and
 * Instagram accounts it can answer, asking Meta to send their messages here, sending replies, looking up the ads
 * people came from, and reading the leads their lead ads collect (funnels). A stand-in (fake.ts) answers the same
 * way locally and in tests.
 *
 * **Every token is the business's, never ours.** A person's own token lists their Pages and reads their ads; each
 * Page's token answers its Messenger and its linked Instagram account. The worker seals both before anything else
 * sees them, and every call proves it is this app making it (`appsecret_proof`), so a token copied out of here is
 * no use anywhere else.
 */
import { createHmac } from 'node:crypto';
import type { SafeFetch } from '../http/safe-fetch';

/** The permissions the sign-in asks for, when there's no Facebook Login for Business configuration to name them. */
export const META_SCOPES = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_manage_messages',
  'business_management',
  'ads_read',
] as const;

/**
 * Lead ads (funnels) need these on top: reading a Page's lead forms and their leads. Asked for only once Meta's App
 * Review approves them (META_LEAD_ADS=on); until then the sign-in stays as it was.
 */
export const META_LEAD_SCOPES = ['leads_retrieval', 'pages_manage_ads'] as const;

/** Messenger needs these; without them nothing can be connected. */
export const META_MESSENGER_SCOPES = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging',
];
/** Instagram needs these on top: without them only the Facebook Pages connect. */
export const META_INSTAGRAM_SCOPES = ['instagram_basic', 'instagram_manage_messages'];

/** What Meta's refusal means for whoever made the call. */
export type MetaErrorKind =
  /** The token stopped working (expired, revoked, password changed): sign in again. */
  | 'auth'
  /** The token works but isn't allowed this (a permission left unticked, an app Meta hasn't approved yet). */
  | 'permission'
  /** Outside the day after the customer last wrote. */
  | 'window'
  /** The Human Agent tag isn't this app's to use. */
  | 'human_agent'
  /** The customer can't get messages from this Page (blocked it, closed their account). */
  | 'unavailable'
  | 'rate_limit'
  /** Meta couldn't take a file. */
  | 'attachment'
  | 'too_long'
  /** No such thing, or not one this token may see: Meta doesn't say which. */
  | 'not_found'
  | 'bad_request'
  /** Meta itself is in trouble, or couldn't be reached. */
  | 'server';

export class MetaError extends Error {
  constructor(
    message: string,
    readonly kind: MetaErrorKind,
    readonly code: number | null = null,
    readonly subcode: number | null = null,
    /** Worth trying again later: Meta was busy or broken rather than refusing. */
    readonly retryable = false,
    /** A send that went and got no answer: Meta may have delivered it, so it isn't sent again by itself. */
    readonly uncertain = false,
  ) {
    super(message);
    this.name = 'MetaError';
  }
}

/** A call that failed before it reached Meta: nothing happened there, so it may simply go again. */
function neverArrived(e: unknown): boolean {
  const cause = e instanceof Error ? (e.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === 'string' ? cause.code : null;
  return (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

/** How long a call may take. A photo or file is fetched from us by Meta while the send waits. */
const CALL_MS = 30_000;
const FILE_SEND_MS = 120_000;

const RATE_LIMITS = new Set([
  4, 17, 32, 613, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014,
]);
const OUTSIDE_WINDOW = new Set([2018278, 2534022]);
const UNAVAILABLE = new Set([1545041, 2018001, 2018109, 2534014]);
const FILE_TROUBLE = new Set([2018008, 2018047, 2018051, 2018074, 2018294, 2534068]);
const TOKEN_TROUBLE = new Set([102, 190, 463, 467]);

/** Meta's error body, as a kind the callers act on. Keyed on Meta's codes; the words only break ties. */
export function metaErrorOf(status: number, body: unknown): MetaError {
  const e =
    (
      body as {
        error?: {
          message?: unknown;
          code?: unknown;
          error_subcode?: unknown;
          is_transient?: unknown;
        };
      } | null
    )?.error ?? {};
  const code = typeof e.code === 'number' ? e.code : null;
  const sub = typeof e.error_subcode === 'number' ? e.error_subcode : null;
  const message = (typeof e.message === 'string' ? e.message : `Meta answered ${status}`).slice(
    0,
    500,
  );
  const kind = classify(status, code, sub, message);
  const retryable =
    kind === 'rate_limit' || kind === 'server' || (e.is_transient === true && kind !== 'auth');
  return new MetaError(message, kind, code, sub, retryable);
}

function classify(
  status: number,
  code: number | null,
  sub: number | null,
  message: string,
): MetaErrorKind {
  if ((code !== null && TOKEN_TROUBLE.has(code)) || status === 401) return 'auth';
  if (sub !== null && OUTSIDE_WINDOW.has(sub)) return 'window';
  if (code === 10 && /window/i.test(message)) return 'window';
  if (code === 551 || (sub !== null && UNAVAILABLE.has(sub))) return 'unavailable';
  if (/HUMAN_AGENT|human agent/i.test(message) || (code === 100 && /\btag\b/i.test(message)))
    return 'human_agent';
  if ((code !== null && RATE_LIMITS.has(code)) || status === 429) return 'rate_limit';
  if (sub !== null && FILE_TROUBLE.has(sub)) return 'attachment';
  if (code === 100 && /length of param|too long|characters/i.test(message)) return 'too_long';
  if (code === 100 && /attachment|upload|fetch the (file|url)/i.test(message)) return 'attachment';
  if (code === 100 && sub === 33) return 'not_found';
  if (code === 803) return 'not_found';
  if (code === 3 || code === 10 || (code !== null && code >= 200 && code < 300))
    return 'permission';
  if (status >= 500 || code === 1 || code === 2) return 'server';
  return 'bad_request';
}

export interface MetaToken {
  readonly accessToken: string;
  /** Null: Meta says it never expires (a business's system user). */
  readonly expiresAt: string | null;
}

/** Who a token belongs to and what it may do, as Meta's own check of it says. */
export interface MetaTokenCheck {
  readonly valid: boolean;
  readonly userId: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
}

export interface MetaInstagramAccount {
  readonly id: string;
  readonly username: string | null;
  readonly name: string | null;
}

/** A Facebook Page the person can answer for, and the Instagram professional account linked to it. */
export interface MetaPage {
  readonly id: string;
  readonly name: string;
  /** Null when the person may not message for it (no MESSAGING task on the Page). */
  readonly accessToken: string | null;
  readonly tasks: readonly string[];
  readonly instagram: MetaInstagramAccount | null;
}

export type MetaOutbound =
  | { readonly text: string }
  | {
      readonly attachment: {
        readonly type: 'image' | 'video' | 'audio' | 'file';
        /** Where Meta fetches it from: a signed link to our own copy, good for an hour. */
        readonly url: string;
      };
    };

export interface MetaSendInput {
  readonly pageId: string;
  readonly pageToken: string;
  readonly platform: 'facebook' | 'instagram';
  /** The customer, as this Page or account knows them. */
  readonly recipientId: string;
  /** HUMAN_AGENT: a person answering more than a day after the customer last wrote (Meta approves it per app). */
  readonly tag: 'HUMAN_AGENT' | null;
  readonly message: MetaOutbound;
}

export interface MetaProfile {
  readonly name: string | null;
  readonly username: string | null;
}

/** What Meta's Marketing API says an ad is. */
export interface MetaAdDetails {
  readonly name: string | null;
  readonly adAccountId: string | null;
  readonly adsetId: string | null;
  readonly adsetName: string | null;
  readonly campaignId: string | null;
  readonly campaignName: string | null;
  readonly campaignObjective: string | null;
  readonly creativeId: string | null;
  readonly creativeName: string | null;
  readonly creativeTitle: string | null;
  readonly creativeBody: string | null;
  readonly creativeThumbnailUrl: string | null;
  readonly creativeLink: string | null;
  readonly callToAction: string | null;
  readonly effectiveStatus: string | null;
  readonly platforms: readonly string[];
  readonly raw: Readonly<Record<string, unknown>>;
}

/** One answer on a lead, and a tick box's answer, as Meta keeps them. */
export interface MetaLead {
  readonly id: string;
  readonly createdAt: string;
  readonly formId: string;
  readonly adId: string | null;
  /** Where they saw it. Meta says `fb` or `ig`; Facebook when it doesn't. */
  readonly platform: 'facebook' | 'instagram';
  readonly organic: boolean;
  readonly answers: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly consents: readonly { readonly key: string; readonly checked: boolean }[];
}

/** A Page's lead form: its name, its questions' words and its own tick boxes. */
export interface MetaLeadForm {
  readonly id: string;
  readonly name: string | null;
  /** ACTIVE, ARCHIVED … */
  readonly status: string | null;
  readonly questions: readonly { readonly key: string; readonly label: string }[];
  readonly consentBoxes: readonly { readonly key: string; readonly text: string }[];
}

export interface MetaGraph {
  readonly name: 'meta' | 'fake';
  /** This server has a Meta app: its id and secret. Without them nothing connects. */
  readonly configured: boolean;
  /** Our own app's id, which marks the replies HandsFreeOS sent when Meta echoes them back. */
  readonly appId: string | null;
  authorizeUrl(input: { readonly state: string; readonly redirectUri: string }): string;
  /** The code a sign-in came back with, as the person's long-lived token. */
  exchangeCode(input: { readonly code: string; readonly redirectUri: string }): Promise<MetaToken>;
  /** Who signed in. */
  me(userToken: string): Promise<{ readonly id: string; readonly name: string | null }>;
  /** Meta's own check of a token: whether it still works, whose it is, what it may do. */
  checkToken(token: string): Promise<MetaTokenCheck>;
  /** Every Page the person can answer for, with its token and its Instagram account. */
  pages(userToken: string): Promise<readonly MetaPage[]>;
  /**
   * Point the app's own webhook here, for Pages and Instagram, with every field read here: Meta sends a Page's events
   * only for the fields both the app and the Page ask for. Says which fields Meta wouldn't take.
   */
  subscribeApp(input: {
    readonly callbackUrl: string;
    readonly verifyToken: string;
  }): Promise<{ readonly refused: readonly string[] }>;
  /** Ask Meta to send this Page's messages, and its Instagram account's, here. */
  subscribe(pageId: string, pageToken: string): Promise<void>;
  unsubscribe(pageId: string, pageToken: string): Promise<void>;
  send(input: MetaSendInput): Promise<{ readonly messageId: string }>;
  /** Their name and @handle, when Meta shares them. Null when it won't. */
  profile(input: {
    readonly platform: 'facebook' | 'instagram';
    readonly scopedId: string;
    readonly pageToken: string;
  }): Promise<MetaProfile | null>;
  /** The ad's campaign, ad set and creative, read with the person's token (it needs ads_read). */
  ad(input: { readonly adId: string; readonly userToken: string }): Promise<MetaAdDetails>;
  /** A photo or file somebody sent: Meta's link to it works for a while, so it's copied while it does. */
  download(url: string): Promise<{ readonly data: Buffer; readonly contentType: string | null }>;
  /** Whether lead ads are asked for: their permissions at sign-in and their webhook field (META_LEAD_ADS). */
  readonly leadAds: boolean;
  /** One lead somebody sent, read with the Page's token. */
  lead(input: { readonly leadId: string; readonly pageToken: string }): Promise<MetaLead>;
  /** What a lead form is: its name, questions and tick boxes. */
  leadForm(input: { readonly formId: string; readonly pageToken: string }): Promise<MetaLeadForm>;
  /** The Page's lead forms, newest first: what the hourly catch-up reads. */
  leadForms(input: {
    readonly pageId: string;
    readonly pageToken: string;
  }): Promise<readonly MetaLeadForm[]>;
  /** A form's leads sent after a moment, oldest first, at most `limit`. */
  formLeads(input: {
    readonly formId: string;
    readonly pageToken: string;
    readonly since: Date;
    readonly limit: number;
  }): Promise<readonly MetaLead[]>;
}

/** The most a file someone sends may weigh before it's left with Meta: Messenger's own limit. */
export const META_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

const GRAPH = 'https://graph.facebook.com';
const DIALOG = 'https://www.facebook.com';

/**
 * What the Page is subscribed to: messages, buttons, ads and links, receipts, and replies sent elsewhere. `standby`
 * brings the chats another app holds, such as HighLevel when it's the Page's main app for messages: Meta sends those
 * only to apps that ask for them.
 */
const PAGE_FIELDS = [
  'messages',
  'messaging_postbacks',
  'messaging_referrals',
  'message_deliveries',
  'message_reads',
  'message_echoes',
  'standby',
];
/** Newer fields some Pages refuse: asked for, and dropped when Meta says no. */
const PAGE_FIELDS_EXTRA = ['message_edits', 'message_reactions'];
/** A lead somebody sent on the Page's lead ad (funnels): asked for with META_LEAD_ADS, and dropped when refused. */
const PAGE_FIELDS_LEADS = ['leadgen'];

/**
 * What the app's own webhook asks for, by object. Meta's dashboard doesn't offer every app `standby` for Pages, so
 * it's asked for here; it and the newer fields are asked for one at a time when Meta refuses the lot.
 */
const appFields = (leadAds: boolean) => ({
  page: {
    fields: [
      'messages',
      'messaging_postbacks',
      'messaging_referrals',
      'message_deliveries',
      'message_reads',
      'message_echoes',
    ],
    extra: ['standby', ...PAGE_FIELDS_EXTRA, ...(leadAds ? PAGE_FIELDS_LEADS : [])],
  },
  instagram: {
    fields: ['messages', 'messaging_postbacks', 'messaging_seen', 'messaging_referral'],
    extra: ['standby', 'message_edit', 'message_reactions'],
  },
});

/** What a lead is read with. Tick boxes come back only when asked for by name. */
const LEAD_FIELDS =
  'id,created_time,ad_id,form_id,platform,is_organic,field_data,custom_disclaimer_responses';
const LEAD_FORM_FIELDS = 'id,name,status,questions,legal_content';

const AD_FIELDS =
  'id,name,effective_status,account_id,adset{id,name,targeting},campaign{id,name,objective},' +
  'creative{id,name,title,body,thumbnail_url,image_url,call_to_action_type,object_story_spec,instagram_permalink_url}';

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const idText = (v: unknown): string | null =>
  typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 64) : null;

/** Meta's answer, kept small: long strings cut, long lists shortened, deep objects left out. */
export function trimRaw(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.slice(0, 1000);
  if (typeof v !== 'object' || v === null) return v;
  if (depth >= 5) return null;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => trimRaw(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .slice(0, 40)
      .map(([k, x]) => [k, trimRaw(x, depth + 1)]),
  );
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

const truthy = (v: unknown): boolean =>
  v === true || v === 1 || (typeof v === 'string' && /^(1|true|yes)$/i.test(v.trim()));

/** A lead, from Meta's answer. Answers and tick boxes Meta sends oddly are left out rather than guessed at. */
export function leadOf(body: unknown): MetaLead {
  const b = obj(body);
  const id = idText(b['id']);
  const formId = idText(b['form_id']);
  if (!id || !/^[0-9]{1,40}$/.test(id) || !formId || !/^[0-9]{1,40}$/.test(formId))
    throw new MetaError('Meta sent a lead without its id or form.', 'bad_request');
  const created = typeof b['created_time'] === 'string' ? Date.parse(b['created_time']) : NaN;
  const adId = idText(b['ad_id']);
  const answers = (Array.isArray(b['field_data']) ? b['field_data'] : [])
    .slice(0, 100)
    .map((f) => obj(f))
    .filter((f) => typeof f['name'] === 'string' && f['name'])
    .map((f) => ({
      name: String(f['name']).slice(0, 200),
      values: (Array.isArray(f['values']) ? f['values'] : [])
        .slice(0, 20)
        .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
        .map((v) => String(v).slice(0, 2000)),
    }));
  const consents = (
    Array.isArray(b['custom_disclaimer_responses']) ? b['custom_disclaimer_responses'] : []
  )
    .slice(0, 20)
    .map((c) => obj(c))
    .filter((c) => typeof c['checkbox_key'] === 'string' && c['checkbox_key'])
    .map((c) => ({
      key: String(c['checkbox_key']).slice(0, 200),
      checked: truthy(c['is_checked']),
    }));
  return {
    id,
    createdAt: new Date(Number.isFinite(created) ? created : Date.now()).toISOString(),
    formId,
    adId: adId && /^[0-9A-Za-z_-]{1,64}$/.test(adId) ? adId : null,
    platform: String(b['platform'] ?? '').toLowerCase() === 'ig' ? 'instagram' : 'facebook',
    organic: truthy(b['is_organic']),
    answers,
    consents,
  };
}

/** A lead form, from Meta's answer: its own tick boxes are in its legal content's custom disclaimer. */
export function leadFormOf(body: unknown): MetaLeadForm {
  const b = obj(body);
  const id = idText(b['id']);
  if (!id || !/^[0-9]{1,40}$/.test(id))
    throw new MetaError('Meta sent a lead form without its id.', 'bad_request');
  const legal = obj(b['legal_content']);
  const disclaimer = obj(legal['custom_disclaimer']);
  const boxes = obj(disclaimer['checkboxes'])['data'] ?? disclaimer['checkboxes'];
  const questions = obj(b['questions'])['data'] ?? b['questions'];
  return {
    id,
    name: text(b['name'], 300),
    status: text(b['status'], 40),
    questions: (Array.isArray(questions) ? questions : [])
      .slice(0, 100)
      .map((q) => obj(q))
      .filter((q) => typeof q['key'] === 'string' && q['key'])
      .map((q) => ({
        key: String(q['key']).slice(0, 200),
        label: text(q['label'], 500) ?? String(q['key']).slice(0, 200),
      })),
    consentBoxes: (Array.isArray(boxes) ? boxes : [])
      .slice(0, 20)
      .map((c) => obj(c))
      .filter((c) => typeof c['key'] === 'string' && c['key'])
      .map((c) => ({ key: String(c['key']).slice(0, 200), text: text(c['text'], 2000) ?? '' })),
  };
}

/** The ad, from Meta's answer: its headline and words live on the creative or, more often, in its story's spec. */
export function adDetailsOf(body: unknown): MetaAdDetails {
  const b = obj(body);
  const adset = obj(b['adset']);
  const campaign = obj(b['campaign']);
  const creative = obj(b['creative']);
  const spec = obj(creative['object_story_spec']);
  const link = obj(spec['link_data']);
  const video = obj(spec['video_data']);
  const cta = obj(link['call_to_action'] ?? video['call_to_action']);
  const targeting = obj(adset['targeting']);
  const platforms = Array.isArray(targeting['publisher_platforms'])
    ? (targeting['publisher_platforms'] as unknown[])
        .filter((p): p is string => typeof p === 'string')
        .slice(0, 10)
    : [];
  // Targeting says who saw it; only where it ran is kept.
  const raw = trimRaw({
    ...b,
    adset: { id: adset['id'], name: adset['name'], publisher_platforms: platforms },
  }) as Json;
  return {
    name: text(b['name'], 400),
    adAccountId: idText(b['account_id']),
    adsetId: idText(adset['id']),
    adsetName: text(adset['name'], 400),
    campaignId: idText(campaign['id']),
    campaignName: text(campaign['name'], 400),
    campaignObjective: text(campaign['objective'], 100),
    creativeId: idText(creative['id']),
    creativeName: text(creative['name'], 400),
    creativeTitle:
      text(creative['title'], 1000) ?? text(link['name'], 1000) ?? text(video['title'], 1000),
    creativeBody:
      text(creative['body'], 4000) ?? text(link['message'], 4000) ?? text(video['message'], 4000),
    creativeThumbnailUrl:
      text(creative['thumbnail_url'], 2000) ??
      text(creative['image_url'], 2000) ??
      text(video['image_url'], 2000),
    creativeLink: text(link['link'], 2000) ?? text(creative['instagram_permalink_url'], 2000),
    callToAction: text(creative['call_to_action_type'], 100) ?? text(cta['type'], 100),
    effectiveStatus: text(b['effective_status'], 60),
    platforms,
    raw,
  };
}

export function createMetaGraph(opts: {
  readonly appId: string | null;
  readonly appSecret: string | null;
  /** Graph's version, `v26.0`. */
  readonly version: string;
  /** Ask for lead ads' permissions and webhook field: once Meta approves them (META_LEAD_ADS). */
  readonly leadAds?: boolean;
  /** A Facebook Login for Business configuration: what the sign-in asks for, set in Meta's dashboard. */
  readonly loginConfigId: string | null;
  /** How files people send are fetched: https only, never a private address. */
  readonly fetchUrl: SafeFetch;
  readonly fetch?: typeof fetch;
}): MetaGraph {
  const f = opts.fetch ?? fetch;
  const base = `${GRAPH}/${opts.version}`;
  const configured = !!opts.appId && !!opts.appSecret;
  const proof = (token: string) =>
    createHmac('sha256', opts.appSecret ?? '')
      .update(token)
      .digest('hex');

  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string | null,
    params: Record<string, string> = {},
    body?: unknown,
    /** `once`: going twice would do it twice (a message sent), so an unanswered call is never retried as if it failed. */
    how: { readonly timeoutMs?: number; readonly once?: boolean } = {},
  ): Promise<T> {
    if (!configured) throw new MetaError('Facebook isn’t set up on this server yet.', 'permission');
    const q = new URLSearchParams(params);
    if (token) {
      q.set('access_token', token);
      q.set('appsecret_proof', proof(token));
    }
    const url = `${base}${path}?${q}`;
    let res: Response;
    try {
      res = await f(url, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(how.timeoutMs ?? CALL_MS),
      });
    } catch (e) {
      const unsure = !!how.once && !neverArrived(e);
      throw new MetaError(
        `Couldn’t reach Meta (${e instanceof Error ? e.message : String(e)}).`,
        'server',
        null,
        null,
        !unsure,
        unsure,
      );
    }
    const answer = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok || (answer && typeof answer === 'object' && 'error' in answer))
      throw metaErrorOf(res.status, answer);
    return answer as T;
  }

  const appToken = () => `${opts.appId ?? ''}|${opts.appSecret ?? ''}`;
  const leadAds = !!opts.leadAds;
  const scopes = leadAds ? [...META_SCOPES, ...META_LEAD_SCOPES] : META_SCOPES;

  return {
    name: 'meta',
    configured,
    appId: opts.appId,
    leadAds,
    authorizeUrl({ state, redirectUri }) {
      const q = new URLSearchParams({
        client_id: opts.appId ?? '',
        redirect_uri: redirectUri,
        state,
        response_type: 'code',
      });
      if (opts.loginConfigId) {
        // Facebook Login for Business: the configuration names the permissions and the Pages' tasks.
        q.set('config_id', opts.loginConfigId);
        q.set('override_default_response_type', 'true');
      } else {
        q.set('scope', scopes.join(','));
        // Ask again for anything left unticked last time, instead of Facebook quietly skipping it.
        q.set('auth_type', 'rerequest');
      }
      return `${DIALOG}/${opts.version}/dialog/oauth?${q}`;
    },
    async exchangeCode({ code, redirectUri }) {
      const short = await call<{ access_token?: string; expires_in?: number }>(
        'GET',
        '/oauth/access_token',
        null,
        {
          client_id: opts.appId ?? '',
          client_secret: opts.appSecret ?? '',
          redirect_uri: redirectUri,
          code,
        },
      );
      if (!short.access_token) throw new MetaError('Facebook sent no token back.', 'auth');
      /*
       * Swapped for the sixty-day token straight away: the Page tokens read with it then never expire. A business's
       * system user's token already lasts, and can't be swapped; it's kept as it came. Meta busy or out of reach is
       * another matter: the sign-in fails and is tried again, rather than connecting Pages that stop in an hour.
       */
      const long = await call<{ access_token?: string; expires_in?: number }>(
        'GET',
        '/oauth/access_token',
        null,
        {
          grant_type: 'fb_exchange_token',
          client_id: opts.appId ?? '',
          client_secret: opts.appSecret ?? '',
          fb_exchange_token: short.access_token,
        },
      ).catch((e: unknown) => {
        if (e instanceof MetaError && e.retryable) throw e;
        return short;
      });
      const token = long.access_token ?? short.access_token;
      const expiresIn = Number(long.expires_in ?? 0);
      return {
        accessToken: token,
        expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      };
    },
    async me(userToken) {
      const me = await call<{ id?: string; name?: string }>('GET', '/me', userToken, {
        fields: 'id,name',
      });
      if (!me.id) throw new MetaError('Facebook didn’t say who signed in.', 'auth');
      return { id: String(me.id), name: text(me.name, 200) };
    },
    async checkToken(token) {
      const out = await call<{
        data?: {
          is_valid?: boolean;
          user_id?: string;
          scopes?: string[];
          expires_at?: number;
        };
      }>('GET', '/debug_token', appToken(), { input_token: token });
      const d = out.data ?? {};
      return {
        valid: d.is_valid === true,
        userId: d.user_id ? String(d.user_id) : null,
        scopes: Array.isArray(d.scopes) ? d.scopes.filter((s) => typeof s === 'string') : [],
        // Zero means never.
        expiresAt: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null,
      };
    },
    async pages(userToken) {
      const out: MetaPage[] = [];
      type PageRow = {
        id?: string;
        name?: string;
        access_token?: string;
        tasks?: string[];
        instagram_business_account?: { id?: string; username?: string; name?: string };
      };
      let after: string | null = null;
      // An agency can manage hundreds; ten pages of a hundred is past anybody connecting them one by one.
      for (let i = 0; i < 10; i++) {
        const body: {
          data?: PageRow[];
          paging?: { next?: string; cursors?: { after?: string } };
        } = await call('GET', '/me/accounts', userToken, {
          fields: 'id,name,access_token,tasks,instagram_business_account{id,username,name}',
          limit: '100',
          ...(after ? { after } : {}),
        });
        for (const p of body.data ?? []) {
          if (!p.id || !/^[0-9]{1,40}$/.test(String(p.id))) continue;
          const tasks = Array.isArray(p.tasks) ? p.tasks.map(String) : [];
          const ig = p.instagram_business_account;
          out.push({
            id: String(p.id),
            name: text(p.name, 200) ?? `Page ${p.id}`,
            // Without the MESSAGING task the Page's token can't answer its messages.
            accessToken:
              p.access_token && (tasks.length === 0 || tasks.includes('MESSAGING'))
                ? p.access_token
                : null,
            tasks,
            instagram:
              ig?.id && /^[0-9]{1,40}$/.test(String(ig.id))
                ? {
                    id: String(ig.id),
                    username: text(ig.username, 100),
                    name: text(ig.name, 200),
                  }
                : null,
          });
        }
        // Graph says there's more only with a next link; its cursor is what asks for it.
        after = body.paging?.next ? (body.paging.cursors?.after ?? null) : null;
        if (!after) break;
      }
      return out;
    },
    async subscribeApp({ callbackUrl, verifyToken }) {
      const refused: string[] = [];
      for (const [object, { fields, extra }] of Object.entries(appFields(leadAds))) {
        // Each ask adds to the fields the app already has, and Meta checks the address with the verify token first.
        const ask = (list: readonly string[]) =>
          call('POST', `/${opts.appId}/subscriptions`, appToken(), {
            object,
            callback_url: callbackUrl,
            verify_token: verifyToken,
            fields: list.join(','),
          });
        const refusal = (e: unknown) => e instanceof MetaError && e.code === 100;
        try {
          await ask([...fields, ...extra]);
          continue;
        } catch (e) {
          if (!refusal(e)) throw e;
        }
        await ask(fields);
        for (const field of extra)
          await ask([field]).catch((e: unknown) => {
            if (!refusal(e)) throw e;
            refused.push(`${object}.${field}`);
          });
      }
      return { refused };
    },
    async subscribe(pageId, pageToken) {
      const ask = (fields: readonly string[]) =>
        call('POST', `/${pageId}/subscribed_apps`, pageToken, {
          subscribed_fields: fields.join(','),
        });
      /*
       * Most first, then less: a field this Page doesn't offer yet, or leads its sign-in may not read, never keeps
       * its messages from coming.
       */
      const tiers = [
        ...(leadAds ? [[...PAGE_FIELDS, ...PAGE_FIELDS_EXTRA, ...PAGE_FIELDS_LEADS]] : []),
        [...PAGE_FIELDS, ...PAGE_FIELDS_EXTRA],
        PAGE_FIELDS,
      ];
      for (const [i, fields] of tiers.entries()) {
        try {
          await ask(fields);
          return;
        } catch (e) {
          const last = i === tiers.length - 1;
          const refused =
            e instanceof MetaError &&
            (e.code === 100 || (fields.includes('leadgen') && e.kind === 'permission'));
          if (last || !refused) throw e;
        }
      }
    },
    async unsubscribe(pageId, pageToken) {
      await call('DELETE', `/${pageId}/subscribed_apps`, pageToken);
    },
    async send(input) {
      const message =
        'text' in input.message
          ? { text: input.message.text }
          : {
              attachment: {
                type: input.message.attachment.type,
                payload: { url: input.message.attachment.url, is_reusable: false },
              },
            };
      const out = await call<{ message_id?: string }>(
        'POST',
        `/${input.pageId}/messages`,
        input.pageToken,
        {},
        {
          recipient: { id: input.recipientId },
          messaging_type: input.tag ? 'MESSAGE_TAG' : 'RESPONSE',
          ...(input.tag ? { tag: input.tag } : {}),
          message,
        },
        { once: true, timeoutMs: 'text' in input.message ? CALL_MS : FILE_SEND_MS },
      );
      if (!out.message_id) throw new MetaError('Meta took the reply but gave no id.', 'server');
      return { messageId: String(out.message_id) };
    },
    async profile({ platform, scopedId, pageToken }) {
      try {
        const p = await call<{
          name?: string;
          first_name?: string;
          last_name?: string;
          username?: string;
        }>('GET', `/${scopedId}`, pageToken, {
          fields: platform === 'instagram' ? 'name,username' : 'name,first_name,last_name',
        });
        const name =
          text(p.name, 200) ?? text([p.first_name, p.last_name].filter(Boolean).join(' '), 200);
        return { name, username: text(p.username, 100) };
      } catch (e) {
        // Their privacy settings, or a Page not yet allowed to ask: the thread still works without a name.
        if (e instanceof MetaError && !e.retryable && e.kind !== 'auth') return null;
        throw e;
      }
    },
    async ad({ adId, userToken }) {
      return adDetailsOf(await call('GET', `/${adId}`, userToken, { fields: AD_FIELDS }));
    },
    async lead({ leadId, pageToken }) {
      return leadOf(await call('GET', `/${leadId}`, pageToken, { fields: LEAD_FIELDS }));
    },
    async leadForm({ formId, pageToken }) {
      return leadFormOf(await call('GET', `/${formId}`, pageToken, { fields: LEAD_FORM_FIELDS }));
    },
    async leadForms({ pageId, pageToken }) {
      const out: MetaLeadForm[] = [];
      let after: string | null = null;
      // Fifty forms is a business with a great many; the newest come first.
      for (let i = 0; i < 2 && out.length < 50; i++) {
        const body: { data?: unknown[]; paging?: { next?: string; cursors?: { after?: string } } } =
          await call('GET', `/${pageId}/leadgen_forms`, pageToken, {
            fields: LEAD_FORM_FIELDS,
            limit: '25',
            ...(after ? { after } : {}),
          });
        for (const f of body.data ?? []) {
          try {
            out.push(leadFormOf(f));
          } catch {
            /* A form Meta describes oddly is skipped; its leads still come by webhook. */
          }
        }
        after = body.paging?.next ? (body.paging.cursors?.after ?? null) : null;
        if (!after) break;
      }
      return out;
    },
    async formLeads({ formId, pageToken, since, limit }) {
      const out: MetaLead[] = [];
      let after: string | null = null;
      const filtering = JSON.stringify([
        {
          field: 'time_created',
          operator: 'GREATER_THAN',
          value: Math.floor(since.getTime() / 1000),
        },
      ]);
      while (out.length < limit) {
        const body: { data?: unknown[]; paging?: { next?: string; cursors?: { after?: string } } } =
          await call('GET', `/${formId}/leads`, pageToken, {
            fields: LEAD_FIELDS,
            filtering,
            limit: String(Math.min(100, limit - out.length)),
            ...(after ? { after } : {}),
          });
        for (const l of body.data ?? []) {
          try {
            out.push(leadOf(l));
          } catch {
            /* Skipped: a lead without its id can't be told apart from the next. */
          }
        }
        after = body.paging?.next ? (body.paging.cursors?.after ?? null) : null;
        if (!after) break;
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
    },
    async download(url) {
      let res;
      try {
        res = await opts.fetchUrl(url, {
          binary: true,
          maxBytes: META_DOWNLOAD_MAX_BYTES + 1,
          timeoutMs: 60_000,
        });
      } catch (e) {
        throw new MetaError(
          `Couldn’t fetch the file (${e instanceof Error ? e.message : String(e)}).`,
          'server',
          null,
          null,
          true,
        );
      }
      if (res.status >= 400)
        throw new MetaError(
          `Meta answered ${res.status} for the file.`,
          res.status === 404 || res.status === 403 ? 'not_found' : 'server',
          null,
          null,
          res.status >= 500,
        );
      if (res.truncated || res.bytes.length > META_DOWNLOAD_MAX_BYTES)
        throw new MetaError('The file is too big to keep.', 'attachment');
      const type = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      return { data: res.bytes, contentType: type || null };
    },
  };
}
