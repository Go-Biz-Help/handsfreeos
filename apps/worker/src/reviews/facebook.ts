/**
 * Facebook recommendations, through the Pages API.
 *
 * Facebook stopped having stars in 2018. What a page has now is recommendations — a yes or a no with some
 * words — and `recommendation_type` is how it says which. That is kept as what it is rather than being
 * turned into a number, because a made-up four stars beside a real four stars is worse than an honest thumb.
 *
 * Replying is not offered. A recommendation is answered as a comment on the story behind it, and the Pages
 * API will not reliably let an app post that. The screen sends people to Facebook instead of showing a box
 * that quietly fails.
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

const AUTH = 'https://www.facebook.com/v21.0/dialog/oauth';
const GRAPH = 'https://graph.facebook.com/v21.0';

export const FACEBOOK_REVIEW_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
];

interface Rating {
  open_graph_story?: { id?: string };
  reviewer?: { name?: string; id?: string };
  recommendation_type?: string;
  review_text?: string;
  created_time?: string;
}

const when = (v: string | undefined): Date | null => {
  if (!v) return null;
  const at = new Date(v);
  return Number.isNaN(at.getTime()) ? null : at;
};

export function createFacebookReviews(opts: {
  appId: string | null;
  appSecret: string | null;
  fetch?: typeof fetch;
}): ReviewProvider {
  const f = opts.fetch ?? fetch;
  const call = async <T>(url: string): Promise<T> => providerJson<T>('Facebook', await f(url));

  async function token(params: Record<string, string>): Promise<TokenSet> {
    if (!opts.appId || !opts.appSecret)
      throw new ReviewError('Facebook reviews aren’t set up on this server yet.', null, true);
    const res = await f(
      `${GRAPH}/oauth/access_token?${new URLSearchParams({
        client_id: opts.appId,
        client_secret: opts.appSecret,
        ...params,
      })}`,
    );
    if (!res.ok) await oauthFailure('Facebook', res);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      accessToken: String(body['access_token'] ?? ''),
      // Facebook has no refresh token: a long-lived page token is the whole of it, and when it stops
      // working the only answer is to connect the page again.
      refreshToken: null,
      // No expiry from Facebook means the long-lived page token, which lasts until somebody revokes it.
      // Sixty days is what its documentation promises, and is a better thing to hold than "forever".
      expiresAt: new Date(
        Date.now() + Number(body['expires_in'] ?? 60 * 86_400) * 1000,
      ).toISOString(),
      scopes: [...FACEBOOK_REVIEW_SCOPES],
    };
  }

  return {
    name: 'facebook',
    configured: !!opts.appId && !!opts.appSecret,
    scopes: FACEBOOK_REVIEW_SCOPES,
    authorizeUrl: ({ state, redirectUri }) =>
      `${AUTH}?${new URLSearchParams({
        client_id: opts.appId ?? '',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: FACEBOOK_REVIEW_SCOPES.join(','),
        state,
      })}`,
    exchangeCode: ({ code, redirectUri }) =>
      token({ code, redirect_uri: redirectUri }).then(async (short) => {
        // Swap the hour-long token for the long-lived one straight away; nothing else is worth keeping.
        const long = await token({
          grant_type: 'fb_exchange_token',
          fb_exchange_token: short.accessToken,
        });
        return long;
      }),
    async refresh(tokens) {
      // Nothing to refresh with. Asking Facebook to extend an expired token fails the same way, so this
      // says the honest thing: the page has to be connected again.
      if (!tokens.accessToken)
        throw new ReviewAuthError('This page needs connecting again.', 'invalid_grant');
      return token({ grant_type: 'fb_exchange_token', fb_exchange_token: tokens.accessToken });
    },
    async places(accessToken) {
      const body = await call<{
        data?: { id?: string; name?: string; link?: string; access_token?: string }[];
      }>(`${GRAPH}/me/accounts?fields=id,name,link,access_token&access_token=${accessToken}`);
      const out: ReviewPlace[] = [];
      for (const page of body.data ?? [])
        if (page.id)
          out.push({
            // The page's own token comes back with the list and is what every later read uses, so it
            // travels with the id. Sealed like any other token the moment it is stored.
            externalId: page.access_token ? `${page.id}|${page.access_token}` : (page.id ?? ''),
            displayName: page.name ?? page.id,
            publicUrl: page.link ?? `https://facebook.com/${page.id}`,
          });
      return out;
    },
    async list({ place, cursor }): Promise<ReviewPage> {
      const [pageId, pageToken] = place.split('|');
      if (!pageId || !pageToken)
        throw new ReviewAuthError('This page needs connecting again.', 'invalid_grant');
      const url =
        cursor ??
        `${GRAPH}/${pageId}/ratings?fields=reviewer,recommendation_type,review_text,created_time,open_graph_story&limit=50&access_token=${pageToken}`;
      const body = await call<{ data?: Rating[]; paging?: { next?: string } }>(url);
      const reviews: SourceReview[] = [];
      for (const r of body.data ?? []) {
        const id = r.open_graph_story?.id ?? `${r.reviewer?.id ?? ''}-${r.created_time ?? ''}`;
        const postedAt = when(r.created_time);
        if (!id || !postedAt) continue;
        reviews.push({
          externalId: id,
          authorName: r.reviewer?.name ?? null,
          authorPhotoUrl: null,
          rating: null,
          sentiment: r.recommendation_type === 'negative' ? 'negative' : 'positive',
          body: r.review_text ?? null,
          postedAt,
          updatedAt: null,
          url: r.open_graph_story?.id ? `https://facebook.com/${r.open_graph_story.id}` : null,
          reply: null,
        });
      }
      return { reviews, cursor: body.paging?.next ?? null };
    },
    canReply: false,
  };
}
