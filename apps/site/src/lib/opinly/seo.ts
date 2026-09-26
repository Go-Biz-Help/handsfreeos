/**
 * Search metadata and structured data for the blog.
 *
 * Everything here describes what a reader can see on the same page — the house rule in json-ld.tsx. The
 * publisher is the same Organization the home page declares, referenced by its `@id` and named in full, so a
 * crawler that lands on a post first still knows who wrote it.
 */
import type { Metadata } from 'next';
import { company, urls } from '@/content/site';
import { absoluteUrl, blogPaths, imageUrl } from './paths';
import { wordCount } from './render';
import type { OpinlyFullPost, OpinlyPost } from './types';

/** The site's own suffix is ` · HandsFreeOS`, 15 characters. Past about 60 in all, a result cuts the title off. */
const TITLE_BUDGET = 60 - ' · HandsFreeOS'.length;

/**
 * A page title that keeps the suffix when it fits and drops it when it does not. Opinly writes its SEO titles
 * to length already; cutting one short to make room for our name would lose the words people searched for.
 */
export const blogTitle = (title: string): Metadata['title'] =>
  title.length > TITLE_BUDGET ? { absolute: title } : title;

/** The site's own share picture (app/opengraph-image.tsx), for a page with no picture of its own. */
const DEFAULT_SHARE_IMAGE = {
  url: '/opengraph-image',
  width: 1200,
  height: 630,
  alt: 'HandsFreeOS — the CRM that doesn’t want you to use it',
};

/**
 * Open Graph, carried whole: a page's `openGraph` replaces the root layout's rather than merging into it, and
 * that includes the share picture the root's `opengraph-image.tsx` would otherwise have given it.
 */
export function openGraph(extra: NonNullable<Metadata['openGraph']>): Metadata['openGraph'] {
  return { siteName: company.product, locale: 'en_US', images: [DEFAULT_SHARE_IMAGE], ...extra };
}

/**
 * A page's canonical address, plus the feed. Both go in together because a page's `alternates` replaces the
 * layout's whole: set the canonical alone and the feed link silently disappears from that page.
 */
export const blogAlternates = (canonical: string): Metadata['alternates'] => ({
  canonical,
  types: { 'application/rss+xml': [{ url: blogPaths.rss(), title: `${company.product} blog` }] },
});

const publisher = {
  '@type': 'Organization',
  '@id': `${urls.site}/#organization`,
  name: company.legalName,
  url: urls.site,
  logo: { '@type': 'ImageObject', url: `${urls.site}/handsfreeos-mark.png` },
} as const;

export interface Crumb {
  readonly name: string;
  readonly path: string;
}

/** Home › Blog, then whatever the page adds. The same list draws the visible breadcrumb. */
export const blogCrumbs = (...rest: Crumb[]): Crumb[] => [
  { name: 'Home', path: '/' },
  { name: 'Blog', path: blogPaths.index() },
  ...rest,
];

export function breadcrumbJsonLd(crumbs: readonly Crumb[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.name,
      item: crumb.path === '/' ? urls.site : absoluteUrl(crumb.path),
    })),
  };
}

export function blogPostingJsonLd(post: OpinlyFullPost) {
  const url = absoluteUrl(blogPaths.post(post.slug));
  const image = imageUrl(post.titleFile?.fileKey);
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    '@id': `${url}#article`,
    headline: post.metaTitle ?? post.title,
    name: post.title,
    description: post.metaDescription ?? post.description,
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    datePublished: post.firstPublishedAt,
    dateModified: post.modifiedAt || post.firstPublishedAt,
    inLanguage: 'en-US',
    wordCount: wordCount(post.content),
    ...(image ? { image: [image] } : {}),
    ...(post.author
      ? {
          author: {
            '@type': 'Person',
            name: post.author.name,
            url: absoluteUrl(blogPaths.author(post.author.slug)),
          },
        }
      : { author: publisher }),
    publisher,
    ...(post.category ? { articleSection: post.category.name } : {}),
    ...(post.tags.length ? { keywords: post.tags.map((t) => t.name).join(', ') } : {}),
    isPartOf: { '@type': 'Blog', '@id': `${absoluteUrl(blogPaths.index())}#blog` },
  };
}

/** A post's own questions, which the page also prints under the article. */
export function faqJsonLd(post: OpinlyFullPost) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${absoluteUrl(blogPaths.post(post.slug))}#faq`,
    mainEntity: (post.faqs ?? []).map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

const postSummary = (post: OpinlyPost) => ({
  '@type': 'BlogPosting',
  headline: post.title,
  url: absoluteUrl(blogPaths.post(post.slug)),
  datePublished: post.firstPublishedAt,
  ...(post.author ? { author: { '@type': 'Person', name: post.author.name } } : {}),
});

/** The blog's front page: the Blog itself, with the posts it is showing. */
export function blogJsonLd(posts: readonly OpinlyPost[], description: string) {
  const url = absoluteUrl(blogPaths.index());
  return {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    '@id': `${url}#blog`,
    name: `${company.product} blog`,
    description,
    url,
    inLanguage: 'en-US',
    publisher,
    blogPost: posts.map(postSummary),
  };
}

/** A category, tag or author archive. */
export function collectionJsonLd(args: {
  name: string;
  description?: string | null;
  path: string;
  posts: readonly OpinlyPost[];
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: args.name,
    ...(args.description ? { description: args.description } : {}),
    url: absoluteUrl(args.path),
    isPartOf: { '@type': 'Blog', '@id': `${absoluteUrl(blogPaths.index())}#blog` },
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: args.posts.map((post, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: absoluteUrl(blogPaths.post(post.slug)),
        name: post.title,
      })),
    },
  };
}

/** An author's page, the shape Google reads for a profile. */
export function profileJsonLd(author: {
  name: string;
  slug: string;
  bio: string | null;
  image: string | null;
}) {
  const url = absoluteUrl(blogPaths.author(author.slug));
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url,
    mainEntity: {
      '@type': 'Person',
      '@id': `${url}#person`,
      name: author.name,
      url,
      ...(author.bio ? { description: author.bio } : {}),
      ...(author.image ? { image: author.image } : {}),
    },
  };
}
