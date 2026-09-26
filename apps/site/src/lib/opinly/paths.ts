/**
 * Where each piece of Opinly content lives on this site, in one place.
 *
 * The sitemap, the webhook and every link on the blog build their addresses here, so the three can never
 * disagree about where a post is. The folders under `src/app/blog` have to match: rename a prefix here and
 * rename its folder with it.
 *
 * Posts are flat — `/blog/<slug>`, whatever category they are in — and categories, authors and tags each sit
 * under their own prefix. That is Opinly's default layout, so the addresses it reports for rankings match.
 */
import { urls } from '@/content/site';
import type { OpinlyRoute } from './types';

export const BLOG_PATH = '/blog';
export const CATEGORY_PREFIX = 'category';
export const AUTHOR_PREFIX = 'authors';
export const TAG_PREFIX = 'tag';

/**
 * Opinly's CDN, with this account's namespace. The API gives each picture as a path (`fileKey`) under it; the
 * path is used exactly as it arrives.
 */
export const IMAGE_CDN = 'https://cdn.opinly.ai/MzKcn0zBiTOQe3-OH3lIx';

export const blogPaths = {
  index: () => BLOG_PATH,
  post: (slug: string) => `${BLOG_PATH}/${slug}`,
  categories: () => `${BLOG_PATH}/${CATEGORY_PREFIX}`,
  category: (slug: string) => `${BLOG_PATH}/${CATEGORY_PREFIX}/${slug}`,
  authors: () => `${BLOG_PATH}/${AUTHOR_PREFIX}`,
  author: (slug: string) => `${BLOG_PATH}/${AUTHOR_PREFIX}/${slug}`,
  tag: (slug: string) => `${BLOG_PATH}/${TAG_PREFIX}/${slug}`,
  rss: () => `${BLOG_PATH}/rss.xml`,
} as const;

/** The page an entry from `/v1/content/routes`, or from the webhook, is about. */
export function routePath(route: Pick<OpinlyRoute, 'type' | 'slug'>): string {
  switch (route.type) {
    case 'post':
      return blogPaths.post(route.slug);
    case 'category':
      return blogPaths.category(route.slug);
    case 'author':
      return blogPaths.author(route.slug);
    case 'tag':
      return blogPaths.tag(route.slug);
    case 'home':
      return blogPaths.index();
  }
}

/** The full address, for canonicals, the sitemap, the feed and structured data. */
export const absoluteUrl = (path: string): string => `${urls.site}${path}`;

/**
 * A picture's address on the CDN. A key that is already a full address (a category's `imageUrl` can be) is
 * left alone, and so is everything after the namespace: the key is Opinly's, not ours to reshape.
 */
export function imageUrl(fileKey: string | null | undefined): string | null {
  if (!fileKey) return null;
  if (/^https?:\/\//i.test(fileKey)) return fileKey;
  return `${IMAGE_CDN}/${fileKey.replace(/^\//, '')}`;
}

/**
 * The `?cursor=` of a paged list, if it looks like one of Opinly's. Cursors are opaque, so this only refuses
 * what could never be one — an array, or something long or odd enough to be a probe — and lets Opinly judge
 * the rest (a stale one comes back `INVALID_CURSOR`, which the pages turn into a 404).
 */
export function readCursor(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.length <= 512 && /^[A-Za-z0-9._~+/=:-]+$/.test(value) ? value : undefined;
}

/** The address of one page of a paged list. */
export const pagedPath = (basePath: string, cursor: string | undefined): string =>
  cursor ? `${basePath}?cursor=${encodeURIComponent(cursor)}` : basePath;
