/**
 * The Opinly content API, read from the server only.
 *
 * `OPINLY_API_KEY` is a secret key: besides reading posts it can record analytics events and purchases in our
 * name. So this file is `server-only` — importing it from a client component fails the build — and nothing it
 * returns carries the key. Pages, route handlers and the sitemap call it; the browser never talks to Opinly's
 * content API at all (the analytics pixel uses a separate, publishable key).
 *
 * **Caching.** Every response is kept in Next's data cache under one tag, `opinly`. The Svix webhook
 * (`app/api/opinly-webhook`) drops the tag the moment Opinly publishes, so a new post is live on the next
 * request; the hour here is only a backstop in case a webhook is ever lost.
 *
 * **Failures throw.** A page that cannot reach Opinly shows the blog's error boundary, and a page that was
 * already built keeps serving its last good copy — both better than rendering an empty blog that then sits
 * in the cache looking like the truth. The one place that must never throw, the sitemap, catches for itself.
 */
import 'server-only';
import { cache } from 'react';
import { urls } from '@/content/site';
import { BLOG_PATH } from './paths';
import type {
  OpinlyAuthorPage,
  OpinlyAuthors,
  OpinlyCategory,
  OpinlyFullPost,
  OpinlyPostList,
  OpinlyRoute,
  OpinlyRssItem,
  OpinlyTag,
} from './types';

/** The cache tag on every Opinly response. The webhook revalidates exactly this. */
export const OPINLY_CACHE_TAG = 'opinly';

/** Seconds a cached response is trusted if no webhook arrives. */
const BACKSTOP_SECONDS = 3600;

const TIMEOUT_MS = 8000;

/** Overridable so a local mock can stand in for Opinly; production never sets it. */
const apiBase = (): string =>
  (process.env.OPINLY_API_URL ?? 'https://sdk.opinly.ai').replace(/\/$/, '');

export class OpinlyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'OpinlyError';
  }
}

/**
 * One retry, a moment later, for the failures that are usually a blip: the connection dropping, or a 502–504 from
 * something in front of Opinly. Not for a timeout (the page has already waited long enough) or a 4xx (asking
 * again will get the same answer).
 */
async function fetchOnceMore(url: URL, init: RequestInit): Promise<Response> {
  try {
    const res = await fetch(url, init);
    if (res.status < 502 || res.status > 504) return res;
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** A cursor Opinly no longer recognises: the page it pointed at does not exist, so the answer is a 404. */
export const isBadCursor = (error: unknown): boolean =>
  error instanceof OpinlyError && error.status === 400 && error.code === 'INVALID_CURSOR';

type Query = Record<string, string | number | undefined>;

async function get<T>(path: string, query: Query, nullOn404: true): Promise<T | null>;
async function get<T>(path: string, query?: Query): Promise<T>;
async function get<T>(path: string, query: Query = {}, nullOn404 = false): Promise<T | null> {
  const key = process.env.OPINLY_API_KEY;
  if (!key) throw new OpinlyError('OPINLY_API_KEY is not set', 500, 'NOT_CONFIGURED');

  const url = new URL(`${apiBase()}${path}`);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }

  const res = await fetchOnceMore(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      // Where the blog lives, so Opinly can match each post to its live address for rankings and traffic.
      // The same two headers Opinly's own client sends; it only ever fills in an address it does not have.
      'x-opinly-site-url': urls.site,
      'x-opinly-blog-prefix': BLOG_PATH,
    },
    // Cached even on pages that render per request (they call `connection()` or read the query string).
    cache: 'force-cache',
    next: { revalidate: BACKSTOP_SECONDS, tags: [OPINLY_CACHE_TAG] },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 404 && nullOn404) return null;
  if (!res.ok) {
    // Errors are RFC 9457 problem documents; the code and request id are what Opinly support asks for.
    const problem = (await res.json().catch(() => null)) as {
      code?: string;
      detail?: string;
      title?: string;
      request_id?: string;
    } | null;
    throw new OpinlyError(
      `Opinly ${path} answered ${res.status}${problem?.code ? ` (${problem.code}: ${problem.detail ?? problem.title ?? ''})` : ''}`,
      res.status,
      problem?.code,
      problem?.request_id ?? res.headers.get('x-request-id') ?? undefined,
    );
  }
  return (await res.json()) as T;
}

/**
 * Each call is wrapped in React's `cache`, so `generateMetadata` and the page asking for the same post in one
 * render make one request. (Next's own fetch memoising steps aside when a fetch has a timeout signal.)
 */
export const opinly = {
  /** A page of published posts, newest first unless told otherwise. */
  posts: cache(
    (
      args: {
        limit?: number;
        cursor?: string;
        category?: string;
        author?: string;
        tag?: string;
        sort?: 'newest' | 'oldest';
      } = {},
    ) => get<OpinlyPostList>('/v1/content/posts', { limit: 12, ...args }),
  ),

  /** One post by its flat slug, or null when there is none. */
  post: cache((slug: string) => get<OpinlyFullPost>('/v1/content/post', { slug }, true)),

  /** Every category, each with up to five of its latest posts. */
  categories: cache(() => get<OpinlyCategory[]>('/v1/content/categories')),

  /** Every tag with how many published posts it has. */
  tags: cache(() => get<OpinlyTag[]>('/v1/content/tags')),

  authors: cache(() => get<OpinlyAuthors>('/v1/content/authors')),

  /** One author and their posts, or null. */
  author: cache(async (slug: string) => {
    const page = await get<OpinlyAuthorPage>(
      `/v1/content/authors/${encodeURIComponent(slug)}`,
      {},
      true,
    );
    return page?.type === 'author' ? page.data : null;
  }),

  /** Every addressable page with when it last changed: the sitemap's source. */
  routes: cache(() => get<OpinlyRoute[]>('/v1/content/routes')),

  rss: cache((limit: number = 20) => get<OpinlyRssItem[]>('/v1/content/rss', { limit })),
};
