import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BlogHeader, CategoryChips, EmptyState, Pagination, PostGrid } from '@/components/blog';
import { JsonLd } from '@/components/json-ld';
import { Container } from '@/components/ui';
import { isBadCursor, opinly } from '@/lib/opinly/client';
import { loadCategory } from '@/lib/opinly/load';
import { blogPaths, pagedPath, readCursor } from '@/lib/opinly/paths';
import {
  blogAlternates,
  blogCrumbs,
  blogTitle,
  breadcrumbJsonLd,
  collectionJsonLd,
  openGraph,
} from '@/lib/opinly/seo';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
};

const describe = (title: string, description: string | null) =>
  description || `Articles about ${title.toLowerCase()} from the HandsFreeOS blog.`;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ slug }, { cursor: raw }] = await Promise.all([params, searchParams]);
  const { category } = await loadCategory(slug);
  const cursor = readCursor(raw);
  const title = cursor ? `${category.title} articles — older posts` : `${category.title} articles`;
  const description = describe(category.title, category.description);
  const path = pagedPath(blogPaths.category(slug), cursor);
  return {
    title: blogTitle(title),
    description,
    alternates: blogAlternates(path),
    openGraph: openGraph({ type: 'website', url: path, title, description }),
  };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const [{ slug }, { cursor: raw }] = await Promise.all([params, searchParams]);
  const cursor = readCursor(raw);
  const [{ category, categories }, page] = await Promise.all([
    loadCategory(slug),
    opinly.posts({ category: slug, cursor }).catch((error: unknown) => {
      if (isBadCursor(error)) notFound();
      throw error;
    }),
  ]);
  const path = blogPaths.category(slug);
  const crumbs = blogCrumbs(
    { name: 'Categories', path: blogPaths.categories() },
    { name: category.title, path },
  );
  const description = describe(category.title, category.description);

  return (
    <Container className="py-12 sm:py-16">
      <JsonLd
        data={collectionJsonLd({ name: category.title, description, path, posts: page.data })}
      />
      <JsonLd data={breadcrumbJsonLd(crumbs)} />

      <BlogHeader
        crumbs={crumbs}
        eyebrow="Category"
        title={category.title}
        sub={category.description}
      />
      <CategoryChips categories={categories} current={slug} />

      {page.data.length === 0 ? (
        <EmptyState
          title={cursor ? 'That is every post here' : 'Nothing in this category yet'}
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
