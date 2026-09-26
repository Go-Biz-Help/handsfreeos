import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { BlogHeader, EmptyState } from '@/components/blog';
import { JsonLd } from '@/components/json-ld';
import { Container } from '@/components/ui';
import { opinly } from '@/lib/opinly/client';
import { blogPaths } from '@/lib/opinly/paths';
import {
  blogAlternates,
  blogCrumbs,
  blogTitle,
  breadcrumbJsonLd,
  openGraph,
} from '@/lib/opinly/seo';

const TITLE = 'Blog categories';
const DESCRIPTION = 'Every topic on the HandsFreeOS blog, with the latest articles in each.';

export const metadata: Metadata = {
  title: blogTitle(TITLE),
  description: DESCRIPTION,
  alternates: blogAlternates(blogPaths.categories()),
  openGraph: openGraph({
    type: 'website',
    url: blogPaths.categories(),
    title: TITLE,
    description: DESCRIPTION,
  }),
};

export default async function CategoriesPage() {
  // Rendered per request from the cached API answer, so a deploy never has to reach Opinly to build it.
  await connection();
  const categories = await opinly.categories();
  const crumbs = blogCrumbs({ name: 'Categories', path: blogPaths.categories() });

  return (
    <Container className="py-12 sm:py-16">
      <JsonLd data={breadcrumbJsonLd(crumbs)} />
      <BlogHeader crumbs={crumbs} title="Categories" sub={DESCRIPTION} />

      {categories.length === 0 ? (
        <EmptyState
          title="No categories yet"
          action={{ href: blogPaths.index(), label: 'See every post' }}
        >
          Posts are grouped here once there are enough of them to group.
        </EmptyState>
      ) : (
        <ul className="grid gap-6 md:grid-cols-2" role="list">
          {categories.map((category) => (
            <li
              key={category.slug}
              className="bg-card border-border flex flex-col rounded-[var(--radius-card)] border p-6"
            >
              <h2 className="text-xl font-bold">
                <Link href={blogPaths.category(category.slug)} className="hover:underline">
                  {category.title}
                </Link>
              </h2>
              {category.description ? (
                <p className="text-text-2 mt-2">{category.description}</p>
              ) : null}
              {category.posts.length ? (
                <ul className="mt-4 space-y-2" role="list">
                  {category.posts.map((post) => (
                    <li key={post.slug}>
                      <Link
                        href={blogPaths.post(post.slug)}
                        className="text-text-2 hover:text-text hover:underline"
                      >
                        {post.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Link
                href={blogPaths.category(category.slug)}
                className="text-accent-text mt-5 self-start font-semibold hover:underline"
              >
                All {category.title.toLowerCase()} articles<span aria-hidden="true"> →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}
