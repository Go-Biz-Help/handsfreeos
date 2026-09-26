import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BlogHeader, CategoryChips, EmptyState, Pagination, PostGrid } from '@/components/blog';
import { JsonLd } from '@/components/json-ld';
import { Container } from '@/components/ui';
import { isBadCursor, opinly } from '@/lib/opinly/client';
import { blogPaths, pagedPath, readCursor } from '@/lib/opinly/paths';
import {
  blogAlternates,
  blogCrumbs,
  blogJsonLd,
  blogTitle,
  breadcrumbJsonLd,
  openGraph,
} from '@/lib/opinly/seo';

const DESCRIPTION =
  'Articles from HandsFreeOS for people who run a small service business: answering every lead, booking the work, quoting and getting paid.';

type Props = { searchParams: Promise<{ cursor?: string | string[] }> };

/**
 * The first page is `/blog`; later ones are `/blog?cursor=…`, each its own canonical. Opinly's cursors only go
 * forward, so later pages link on to the next and back to the newest.
 */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const cursor = readCursor((await searchParams).cursor);
  const title = cursor ? 'Blog — older posts' : 'Blog — running a small service business';
  const path = pagedPath(blogPaths.index(), cursor);
  return {
    title: blogTitle(title),
    description: DESCRIPTION,
    alternates: blogAlternates(path),
    openGraph: openGraph({ type: 'website', url: path, title, description: DESCRIPTION }),
  };
}

export default async function BlogIndex({ searchParams }: Props) {
  const cursor = readCursor((await searchParams).cursor);
  const [page, categories] = await Promise.all([
    opinly.posts({ cursor }).catch((error: unknown) => {
      if (isBadCursor(error)) notFound();
      throw error;
    }),
    // The chips are a convenience; a blog with no chips is still a blog.
    opinly.categories().catch(() => []),
  ]);
  const crumbs = blogCrumbs();

  return (
    <Container className="py-12 sm:py-16">
      <JsonLd data={blogJsonLd(page.data, DESCRIPTION)} />
      <JsonLd data={breadcrumbJsonLd(crumbs)} />

      <BlogHeader
        crumbs={crumbs}
        title={cursor ? 'Older posts' : 'The HandsFreeOS blog'}
        sub={
          cursor
            ? undefined
            : 'Plain-spoken articles for the people who run a service business from the job, not from a desk.'
        }
      />

      <CategoryChips categories={categories} />

      {page.data.length === 0 ? (
        cursor ? (
          <EmptyState
            title="That is every post"
            action={{ href: blogPaths.index(), label: 'Back to the newest posts' }}
          >
            There is nothing older than this.
          </EmptyState>
        ) : (
          <EmptyState
            title="No posts yet"
            action={{ href: '/features', label: 'See what HandsFreeOS does' }}
          >
            The first articles are on their way. In the meantime, the features page shows what
            HandsFreeOS does for a service business.
          </EmptyState>
        )
      ) : (
        <PostGrid posts={page.data} />
      )}

      <Pagination
        basePath={blogPaths.index()}
        nextCursor={page.has_more ? page.next_cursor : null}
        onFirstPage={!cursor}
      />
    </Container>
  );
}
