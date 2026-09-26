import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BlogHeader, EmptyState, Pagination, PostGrid } from '@/components/blog';
import { JsonLd } from '@/components/json-ld';
import { Container } from '@/components/ui';
import { isBadCursor, opinly } from '@/lib/opinly/client';
import { loadTag } from '@/lib/opinly/load';
import { blogPaths, pagedPath, readCursor } from '@/lib/opinly/paths';
import {
  blogAlternates,
  blogCrumbs,
  blogTitle,
  breadcrumbJsonLd,
  collectionJsonLd,
  openGraph,
} from '@/lib/opinly/seo';

/**
 * A topic tag's archive. Opinly lists tag pages in `/v1/content/routes`, so they are in the sitemap and have to
 * exist; every tag on a post links here.
 */
type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
};

const describe = (name: string, description: string | null) =>
  description || `Articles about ${name.toLowerCase()} from the HandsFreeOS blog.`;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ slug }, { cursor: raw }] = await Promise.all([params, searchParams]);
  const tag = await loadTag(slug);
  const cursor = readCursor(raw);
  const title = cursor ? `${tag.name} — older posts` : tag.name;
  const description = describe(tag.name, tag.description);
  const path = pagedPath(blogPaths.tag(slug), cursor);
  return {
    title: blogTitle(title),
    description,
    alternates: blogAlternates(path),
    openGraph: openGraph({ type: 'website', url: path, title, description }),
  };
}

export default async function TagPage({ params, searchParams }: Props) {
  const [{ slug }, { cursor: raw }] = await Promise.all([params, searchParams]);
  const cursor = readCursor(raw);
  const [tag, page] = await Promise.all([
    loadTag(slug),
    opinly.posts({ tag: slug, cursor }).catch((error: unknown) => {
      if (isBadCursor(error)) notFound();
      throw error;
    }),
  ]);
  const path = blogPaths.tag(slug);
  const crumbs = blogCrumbs({ name: tag.name, path });
  const description = describe(tag.name, tag.description);

  return (
    <Container className="py-12 sm:py-16">
      <JsonLd data={collectionJsonLd({ name: tag.name, description, path, posts: page.data })} />
      <JsonLd data={breadcrumbJsonLd(crumbs)} />

      <BlogHeader crumbs={crumbs} eyebrow="Topic" title={tag.name} sub={tag.description} />

      {page.data.length === 0 ? (
        <EmptyState
          title={cursor ? 'That is every post here' : 'Nothing on this topic yet'}
          action={{ href: blogPaths.index(), label: 'See every post' }}
        >
          {cursor
            ? 'There is nothing older than this.'
            : 'New articles land here as they are published.'}
        </EmptyState>
      ) : (
        <PostGrid posts={page.data} />
      )}

      <Pagination
        basePath={path}
        nextCursor={page.has_more ? page.next_cursor : null}
        onFirstPage={!cursor}
      />
    </Container>
  );
}
