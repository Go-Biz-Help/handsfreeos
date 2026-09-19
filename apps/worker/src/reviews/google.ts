/**
 * Google reviews, through the Business Profile API.
 *
 * Two APIs, as Google has it: the account-management one says which places this sign-in can speak for, and
 * the older v4 one is still the only place reviews and replies live. A star is a word over there ("FIVE"),
 * so it is turned into a number here and nowhere else.
 *
 * `updateReply` is an upsert: answering a review that already has an answer replaces it, which is what a
 * person means when they edit a reply.
 */
import { oauthFailure, providerJson } from '../mailbox/provider';
import {
  ReviewAuthError,
  ReviewError,
  type ReviewPage,
  type ReviewPlace,
  type ReviewProvider,
  type SourceReview,
  type TokenSet,
} from './provider';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const ACCOUNTS = 'https://mybusinessaccountmanagement.googleapis.com/v1';
/** Reviews never moved to the new API surface; v4 is still where they are. */
const V4 = 'https://mybusiness.googleapis.com/v4';

export const GOOGLE_REVIEW_SCOPES = ['https://www.googleapis.com/auth/business.manage'];

const STARS: Record<string, 1 | 2 | 3 | 4 | 5> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

interface GoogleReview {
  name?: string;
  reviewId?: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string };
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}

const when = (v: string | undefined): Date | null => {
  if (!v) return null;
  const at = new Date(v);
  return Number.isNaN(at.getTime()) ? null : at;
};

export function createGoogleReviews(opts: {
  clientId: string | null;
  clientSecret: string | null;
  fetch?: typeof fetch;
}): ReviewProvider {
  const f = opts.fetch ?? fetch;

  async function token(params: Record<string, string>): Promise<TokenSet> {
    if (!opts.clientId || !opts.clientSecret)
      throw new ReviewError('Google reviews aren’t set up on this server yet.', null, true);
    const res = await f(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        ...params,
      }),
    });
    if (!res.ok) await oauthFailure('Google', res);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      accessToken: String(body['access_token'] ?? ''),
      refreshToken: body['refresh_token'] ? String(body['refresh_token']) : null,
      expiresAt: new Date(Date.now() + Number(body['expires_in'] ?? 3600) * 1000).toISOString(),
      scopes: String(body['scope'] ?? '')
        .split(' ')
        .filter(Boolean),
    };
  }

  const call = async <T>(accessToken: string, url: string, init?: RequestInit): Promise<T> =>
    providerJson<T>(
      'Google',
      await f(url, {
        ...init,
        headers: { ...(init?.headers ?? {}), authorization: `Bearer ${accessToken}` },
      }),
    );

  return {
    name: 'google',
    configured: !!opts.clientId && !!opts.clientSecret,
    scopes: GOOGLE_REVIEW_SCOPES,
    authorizeUrl: ({ state, codeChallenge, redirectUri }) =>
      `${AUTH}?${new URLSearchParams({
        client_id: opts.clientId ?? '',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_REVIEW_SCOPES.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        // Reviews are read on a timer long after somebody closed the tab, so a refresh token is the point.
        access_type: 'offline',
        prompt: 'consent',
      })}`,
    exchangeCode: ({ code, codeVerifier, redirectUri }) =>
      token({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    async refresh(tokens) {
      if (!tokens.refreshToken)
        throw new ReviewAuthError('This connection has no refresh token.', 'invalid_grant');
      const next = await token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
      // Google only returns a refresh token the first time; the one we hold stays good.
      return { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
    },
    async places(accessToken) {
      const accounts = await call<{ accounts?: { name?: string }[] }>(
        accessToken,
        `${ACCOUNTS}/accounts`,
      );
      const out: ReviewPlace[] = [];
      for (const account of accounts.accounts ?? []) {
        if (!account.name) continue;
        const locations = await call<{
          locations?: { name?: string; title?: string; metadata?: { mapsUri?: string } }[];
        }>(
          accessToken,
          `${ACCOUNTS}/${account.name}/locations?readMask=name,title,metadata&pageSize=100`,
        );
        for (const location of locations.locations ?? [])
          if (location.name)
            out.push({
              // v4 wants the account in the path, so the account is kept with the location.
              externalId: `${account.name}/${location.name}`,
              displayName: location.title ?? location.name,
              publicUrl: location.metadata?.mapsUri ?? null,
            });
      }
      return out;
    },
    async list({ accessToken, place, cursor }): Promise<ReviewPage> {
      const url = `${V4}/${place}/reviews?pageSize=50&orderBy=updateTime desc${
        cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''
      }`;
      const body = await call<{ reviews?: GoogleReview[]; nextPageToken?: string }>(
        accessToken,
        url,
      );
      const reviews: SourceReview[] = [];
      for (const r of body.reviews ?? []) {
        const id = r.reviewId ?? r.name?.split('/').pop();
        const postedAt = when(r.createTime);
        if (!id || !postedAt) continue;
        reviews.push({
          externalId: id,
          authorName: r.reviewer?.displayName ?? null,
          authorPhotoUrl: r.reviewer?.profilePhotoUrl ?? null,
          rating: STARS[r.starRating ?? ''] ?? null,
          // A star that is not one of the five is not a thumb either; it is recorded as three, which is
          // what "STAR_RATING_UNSPECIFIED" means to everybody who reads it.
          sentiment: STARS[r.starRating ?? ''] ? null : 'positive',
          body: r.comment ?? null,
          postedAt,
          updatedAt: when(r.updateTime),
          url: null,
          reply: r.reviewReply?.comment
            ? { body: r.reviewReply.comment, postedAt: when(r.reviewReply.updateTime) }
            : null,
        });
      }
      return { reviews, cursor: body.nextPageToken ?? null };
    },
    canReply: true,
    async reply({ accessToken, place, reviewId, body }) {
      await call(accessToken, `${V4}/${place}/reviews/${encodeURIComponent(reviewId)}/reply`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment: body }),
      });
    },
  };
}
