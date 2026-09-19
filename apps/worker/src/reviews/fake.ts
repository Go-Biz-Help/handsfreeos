/**
 * Local and test reviews. Signing in is the worker's own stand-in page — the one connected mailboxes use,
 * with PKCE checked like the real thing — and each place's reviews live in memory: tests and the browser
 * specs put a review there, and a reply written here lands on it the way it would over there.
 *
 * The Google stand-in has stars and answers back; the Facebook one has a thumb up or down and cannot be
 * replied to, which is the real difference between them and the one the screens have to cope with.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { pkceChallenge } from '../mailbox/provider';
import {
  ReviewAuthError,
  ReviewError,
  type ReviewPage,
  type ReviewPlace,
  type ReviewProvider,
  type ReviewProviderName,
  type SourceReview,
  type TokenSet,
} from './provider';

export interface FakeReviewInput {
  readonly place?: string;
  readonly author?: string;
  readonly rating?: 1 | 2 | 3 | 4 | 5;
  readonly sentiment?: 'positive' | 'negative';
  readonly body?: string;
  readonly postedAt?: Date;
}

export interface FakeReviews {
  readonly providers: Record<ReviewProviderName, ReviewProvider>;
  /** Somebody writes one. Returns its id over there. */
  add(provider: ReviewProviderName, review: FakeReviewInput): string;
  /** What a place looks like to whoever signs in; the default is one place per provider. */
  setPlaces(provider: ReviewProviderName, places: readonly ReviewPlace[]): void;
  /** The replies that have been posted back, in order. */
  replies(): readonly { provider: ReviewProviderName; reviewId: string; body: string }[];
  /** The sign-in stops working, the way a revoked one does. */
  revoke(provider: ReviewProviderName): void;
}

const enc = (s: string) => Buffer.from(s).toString('base64url');
const HOUR = 3_600_000;

const DEFAULT_PLACE: Record<ReviewProviderName, ReviewPlace> = {
  google: {
    externalId: 'locations/fake-google',
    displayName: 'Lone Star HVAC',
    publicUrl: 'https://maps.example/lone-star-hvac',
  },
  facebook: {
    externalId: 'fake-facebook-page',
    displayName: 'Lone Star HVAC',
    publicUrl: 'https://facebook.example/lonestarhvac',
  },
};

export function createFakeReviews(opts: { publicUrl: string }): FakeReviews {
  const held = new Map<ReviewProviderName, SourceReview[]>([
    ['google', []],
    ['facebook', []],
  ]);
  const places = new Map<ReviewProviderName, ReviewPlace[]>([
    ['google', [DEFAULT_PLACE.google]],
    ['facebook', [DEFAULT_PLACE.facebook]],
  ]);
  const posted: { provider: ReviewProviderName; reviewId: string; body: string }[] = [];
  const revoked = new Set<ReviewProviderName>();

  const tokenFor = (name: ReviewProviderName): TokenSet => ({
    accessToken: `fake-review-access.${enc(name)}.${randomBytes(6).toString('hex')}`,
    refreshToken: `fake-review-refresh.${enc(name)}`,
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
    scopes: ['fake.reviews.read', 'fake.reviews.reply'],
  });
  const check = (name: ReviewProviderName, token: string) => {
    if (!token.startsWith('fake-review-access.'))
      throw new ReviewError('not a stand-in token', 400, true);
    if (revoked.has(name)) throw new ReviewAuthError('This sign-in was revoked.', 'invalid_grant');
  };

  const provider = (name: ReviewProviderName, canReply: boolean): ReviewProvider => ({
    name,
    configured: true,
    scopes: ['fake.reviews.read', ...(canReply ? ['fake.reviews.reply'] : [])],
    authorizeUrl: ({ state, codeChallenge, redirectUri }) =>
      `${opts.publicUrl}/oauth/fake/${name}/authorize?${new URLSearchParams({
        state,
        code_challenge: codeChallenge,
        redirect_uri: redirectUri,
      })}`,
    async exchangeCode({ code, codeVerifier }) {
      // The same code the stand-in sign-in page hands out (mailbox/fake.ts fakeCode), and PKCE checked
      // like the real thing, so the route's half of the dance is really exercised.
      const [prefix, payload] = code.split('.');
      if (prefix !== 'fakecode' || !payload)
        throw new ReviewError('not a stand-in sign-in', 400, true);
      const { challenge } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        challenge?: string;
      };
      if (!challenge || pkceChallenge(codeVerifier) !== challenge)
        throw new ReviewError('the sign-in did not match', 400, true);
      return tokenFor(name);
    },
    async refresh(tokens) {
      if (revoked.has(name))
        throw new ReviewAuthError('This sign-in was revoked.', 'invalid_grant');
      return { ...tokenFor(name), refreshToken: tokens.refreshToken };
    },
    async places(accessToken) {
      check(name, accessToken);
      return places.get(name) ?? [];
    },
    async list({ accessToken, cursor }): Promise<ReviewPage> {
      check(name, accessToken);
      // Newest first, which is the order both providers answer in and the order the list is read in.
      const all = [...(held.get(name) ?? [])].sort(
        (a, b) => b.postedAt.getTime() - a.postedAt.getTime(),
      );
      const from = cursor ? Number(cursor) : 0;
      const page = all.slice(from, from + 50);
      return { reviews: page, cursor: from + page.length < all.length ? String(from + 50) : null };
    },
    canReply,
    ...(canReply
      ? {
          async reply({ accessToken, reviewId, body }) {
            check(name, accessToken);
            const list = held.get(name) ?? [];
            const index = list.findIndex((r) => r.externalId === reviewId);
            if (index < 0) throw new ReviewError('no such review', 404, true);
            list[index] = { ...list[index]!, reply: { body, postedAt: new Date() } };
            posted.push({ provider: name, reviewId, body });
          },
        }
      : {}),
  });

  return {
    providers: {
      google: provider('google', true),
      // Facebook answers a recommendation as a comment on a story, which its API will not let an app post.
      facebook: provider('facebook', false),
    },
    add(name, input) {
      const externalId = `fake-review-${randomUUID().slice(0, 8)}`;
      const google = name === 'google';
      held.get(name)!.push({
        externalId,
        authorName: input.author ?? 'A customer',
        authorPhotoUrl: null,
        rating: google ? (input.rating ?? 5) : null,
        sentiment: google ? null : (input.sentiment ?? 'positive'),
        body: input.body ?? null,
        postedAt: input.postedAt ?? new Date(),
        updatedAt: null,
        url: `${DEFAULT_PLACE[name].publicUrl}#${externalId}`,
        reply: null,
      });
      return externalId;
    },
    setPlaces(name, list) {
      places.set(name, [...list]);
    },
    replies: () => posted,
    revoke(name) {
      revoked.add(name);
    },
  };
}
