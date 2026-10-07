/**
 * Facebook and Instagram without Meta, locally and in tests (20261025000200). Signing in is the worker's own page
 * (routes.ts), each person's Pages and their Instagram accounts live in memory, and every reply sent is kept for a
 * test to read. Tokens, refusals and ads behave the way Meta's do, so the routes and jobs are really exercised:
 * a revoked Page's token stops working, a sign-in that didn't allow ads can't read them, a reply can be refused.
 */
import { createHmac, randomBytes } from 'node:crypto';
import {
  MetaError,
  type MetaAdDetails,
  type MetaGraph,
  type MetaPage,
  type MetaProfile,
  type MetaSendInput,
} from './graph';

/** The stand-in app's secret: what signs its webhooks, so a test or a local demo can sign one too. */
export const FAKE_META_APP_SECRET = 'fake-meta-app-secret';
export const FAKE_META_APP_ID = '900000000000001';
/** The verify token Meta's webhook setup page would be given, locally. */
export const FAKE_META_VERIFY_TOKEN = 'hfos-local-meta';

export interface FakeMetaUser {
  readonly id: string;
  readonly name: string;
  readonly pageIds: readonly string[];
}

export interface FakeMetaPageInput {
  readonly id: string;
  readonly name: string;
  readonly instagram?: {
    readonly id: string;
    readonly username: string;
    readonly name?: string;
  } | null;
  /** Without MESSAGING the person can see the Page but not answer for it. */
  readonly tasks?: readonly string[];
}

export interface FakeSent extends Omit<MetaSendInput, 'pageToken'> {
  readonly messageId: string;
}

export interface FakeMeta {
  readonly graph: MetaGraph;
  readonly appSecret: string;
  readonly verifyToken: string;
  /** The people who can sign in, the first being who the sign-in page suggests. */
  users(): readonly FakeMetaUser[];
  /** Somebody with these Pages; replaces anybody with the same id. */
  addUser(user: { id: string; name: string; pages: readonly FakeMetaPageInput[] }): void;
  /** Every reply HandsFreeOS sent, in order. */
  sent(): readonly FakeSent[];
  /** The next send, or the next few, are refused like this. */
  failNextSend(...errors: MetaError[]): void;
  /** Where the app's own webhook was pointed, and with what verify token; null until somebody connects. */
  appWebhook(): { readonly callbackUrl: string; readonly verifyToken: string } | null;
  /** Pages Meta was asked to send messages for. */
  subscribed(): readonly string[];
  /** Asking Meta to send a Page's messages fails like this until it's cleared. */
  failSubscribe(pageId: string, error: MetaError | null): void;
  /** The Page's token stops working, as when somebody changes their password or removes the app. */
  revokePage(pageId: string): void;
  revokeUser(userId: string): void;
  setProfile(scopedId: string, profile: MetaProfile | null): void;
  /** What Meta says about an ad: its details, or that this sign-in can't see it, or that there's no such ad. */
  setAd(adId: string, ad: MetaAdDetails | 'no_access' | 'not_found' | 'rate_limit'): void;
  /** A file somebody sent, at the link Meta would give. */
  setFile(url: string, file: { data: Buffer; contentType: string } | null): void;
  /** The code the sign-in page hands back: who signed in and what they allowed. */
  code(input: { userId: string; scopes?: readonly string[] }): string;
  /** `sha256=…` over a webhook body, as Meta signs it. */
  sign(rawBody: string): string;
}

const ALL_SCOPES = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_manage_messages',
  'business_management',
  'ads_read',
];

/** What the stand-in says about an ad nobody set: a plausible spring campaign, so a local demo shows one. */
const sampleAd = (adId: string): MetaAdDetails => ({
  name: 'Spring tune-up · Messenger',
  adAccountId: '1234567890',
  adsetId: `${adId}1`,
  adsetName: 'Homeowners within 15 miles',
  campaignId: `${adId}2`,
  campaignName: 'Spring tune-ups',
  campaignObjective: 'OUTCOME_ENGAGEMENT',
  creativeId: `${adId}3`,
  creativeName: 'Spring tune-up creative',
  creativeTitle: 'Beat the summer heat',
  creativeBody: 'Book a spring AC tune-up this week and save $40. Message us to pick a time.',
  creativeThumbnailUrl: null,
  creativeLink: null,
  callToAction: 'MESSAGE_PAGE',
  effectiveStatus: 'ACTIVE',
  platforms: ['facebook', 'instagram'],
  raw: { id: adId, name: 'Spring tune-up · Messenger' },
});

/** A one-pixel PNG: what a photo somebody sent is, to the stand-in. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export function createFakeMeta(opts: { publicUrl: string }): FakeMeta {
  const pages = new Map<
    string,
    { input: FakeMetaPageInput; token: string; tasks: readonly string[] }
  >();
  const users = new Map<string, FakeMetaUser>();
  const tokens = new Map<string, { userId: string; scopes: readonly string[] }>();
  const revokedUsers = new Set<string>();
  const sent: FakeSent[] = [];
  const failures: MetaError[] = [];
  let appWebhook: { callbackUrl: string; verifyToken: string } | null = null;
  const subscribed = new Set<string>();
  const subscribeFailures = new Map<string, MetaError>();
  const profiles = new Map<string, MetaProfile | null>();
  const adAnswers = new Map<string, MetaAdDetails | 'no_access' | 'not_found' | 'rate_limit'>();
  const files = new Map<string, { data: Buffer; contentType: string } | null>();

  const pageToken = (pageId: string) =>
    `fake-meta-page.${pageId}.${randomBytes(6).toString('hex')}`;
  const addUser = (u: { id: string; name: string; pages: readonly FakeMetaPageInput[] }) => {
    for (const p of u.pages)
      pages.set(p.id, {
        input: p,
        token: pages.get(p.id)?.token ?? pageToken(p.id),
        tasks: p.tasks ?? [
          'ADVERTISE',
          'ANALYZE',
          'CREATE_CONTENT',
          'MESSAGING',
          'MODERATE',
          'MANAGE',
        ],
      });
    users.set(u.id, { id: u.id, name: u.name, pageIds: u.pages.map((p) => p.id) });
    revokedUsers.delete(u.id);
  };
  addUser({
    id: '10000000000001',
    name: 'Pat Owner',
    pages: [
      {
        id: '20000000000001',
        name: 'Lone Star HVAC',
        instagram: { id: '17840000000000001', username: 'lonestarhvac', name: 'Lone Star HVAC' },
      },
    ],
  });

  const userOf = (token: string) => {
    const t = tokens.get(token);
    if (!t || revokedUsers.has(t.userId))
      throw new MetaError(
        'Error validating access token: the session has been invalidated.',
        'auth',
        190,
        460,
      );
    return t;
  };
  const pageOf = (pageId: string, token: string) => {
    const p = pages.get(pageId);
    if (!p || p.token !== token)
      throw new MetaError(
        'Error validating access token: the Page’s token was changed.',
        'auth',
        190,
        460,
      );
    return p;
  };
  const pageOfToken = (token: string) => [...pages.entries()].find(([, p]) => p.token === token);

  const graph: MetaGraph = {
    name: 'fake',
    configured: true,
    appId: FAKE_META_APP_ID,
    authorizeUrl: ({ state, redirectUri }) =>
      `${opts.publicUrl}/oauth/fake/meta/authorize?${new URLSearchParams({
        state,
        redirect_uri: redirectUri,
      })}`,
    async exchangeCode({ code }) {
      const [prefix, payload] = code.split('.');
      if (prefix !== 'fakemeta' || !payload)
        throw new MetaError('Not a stand-in sign-in.', 'bad_request', 100);
      const said = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        userId?: string;
        scopes?: string[];
      };
      if (!said.userId || !users.has(said.userId))
        throw new MetaError('Nobody by that id.', 'bad_request', 100);
      const accessToken = `fake-meta-user.${said.userId}.${randomBytes(6).toString('hex')}`;
      tokens.set(accessToken, { userId: said.userId, scopes: said.scopes ?? ALL_SCOPES });
      return { accessToken, expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString() };
    },
    async me(userToken) {
      const t = userOf(userToken);
      return { id: t.userId, name: users.get(t.userId)?.name ?? null };
    },
    async checkToken(token) {
      const t = tokens.get(token);
      if (t)
        return {
          valid: !revokedUsers.has(t.userId),
          userId: t.userId,
          scopes: t.scopes,
          expiresAt: null,
        };
      const page = pageOfToken(token);
      return { valid: !!page, userId: null, scopes: page ? ALL_SCOPES : [], expiresAt: null };
    },
    async pages(userToken): Promise<MetaPage[]> {
      const t = userOf(userToken);
      const ig = t.scopes.includes('instagram_basic');
      return (users.get(t.userId)?.pageIds ?? []).flatMap((id) => {
        const p = pages.get(id);
        if (!p) return [];
        return [
          {
            id,
            name: p.input.name,
            accessToken: p.tasks.includes('MESSAGING') ? p.token : null,
            tasks: p.tasks,
            instagram:
              ig && p.input.instagram
                ? {
                    id: p.input.instagram.id,
                    username: p.input.instagram.username,
                    name: p.input.instagram.name ?? null,
                  }
                : null,
          },
        ];
      });
    },
    async subscribeApp({ callbackUrl, verifyToken }) {
      appWebhook = { callbackUrl, verifyToken };
      return { refused: [] };
    },
    async subscribe(pageId, token) {
      pageOf(pageId, token);
      const failure = subscribeFailures.get(pageId);
      if (failure) throw failure;
      subscribed.add(pageId);
    },
    async unsubscribe(pageId, token) {
      pageOf(pageId, token);
      subscribed.delete(pageId);
    },
    async send(input) {
      pageOf(input.pageId, input.pageToken);
      const failure = failures.shift();
      if (failure) throw failure;
      const messageId = `m_fake_${randomBytes(8).toString('hex')}`;
      const { pageToken: _token, ...rest } = input;
      sent.push({ ...rest, messageId });
      return { messageId };
    },
    async profile({ scopedId, pageToken: token }) {
      if (!pageOfToken(token)) throw new MetaError('Error validating access token.', 'auth', 190);
      return profiles.has(scopedId) ? profiles.get(scopedId)! : null;
    },
    async ad({ adId, userToken }) {
      const t = userOf(userToken);
      const answer = adAnswers.get(adId);
      if (answer === 'rate_limit')
        throw new MetaError('User request limit reached', 'rate_limit', 17, null, true);
      if (!t.scopes.includes('ads_read') || answer === 'no_access')
        throw new MetaError('(#200) Requires ads_read permission', 'permission', 200);
      if (answer === 'not_found')
        throw new MetaError(
          `Unsupported get request. Object with ID '${adId}' does not exist`,
          'not_found',
          100,
          33,
        );
      return answer ?? sampleAd(adId);
    },
    async download(url) {
      if (files.has(url)) {
        const f = files.get(url);
        if (!f) throw new MetaError('Meta answered 404 for the file.', 'not_found');
        return f;
      }
      return { data: PIXEL, contentType: 'image/png' };
    },
  };

  return {
    graph,
    appSecret: FAKE_META_APP_SECRET,
    verifyToken: FAKE_META_VERIFY_TOKEN,
    users: () => [...users.values()],
    addUser,
    sent: () => sent,
    failNextSend: (...errors) => {
      failures.push(...errors);
    },
    appWebhook: () => appWebhook,
    subscribed: () => [...subscribed],
    failSubscribe: (pageId, error) => {
      if (error) subscribeFailures.set(pageId, error);
      else subscribeFailures.delete(pageId);
    },
    revokePage: (pageId) => {
      const p = pages.get(pageId);
      if (p) pages.set(pageId, { ...p, token: pageToken(pageId) });
    },
    revokeUser: (userId) => {
      revokedUsers.add(userId);
    },
    setProfile: (scopedId, profile) => {
      profiles.set(scopedId, profile);
    },
    setAd: (adId, ad) => {
      adAnswers.set(adId, ad);
    },
    setFile: (url, file) => {
      files.set(url, file);
    },
    code: ({ userId, scopes }) =>
      `fakemeta.${Buffer.from(JSON.stringify({ userId, scopes: scopes ?? ALL_SCOPES })).toString('base64url')}`,
    sign: (rawBody) =>
      `sha256=${createHmac('sha256', FAKE_META_APP_SECRET).update(rawBody).digest('hex')}`,
  };
}
