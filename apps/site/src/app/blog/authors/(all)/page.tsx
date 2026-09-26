import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { AuthorAvatar, BlogHeader, EmptyState } from '@/components/blog';
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

const TITLE = 'Blog authors';
const DESCRIPTION = 'Who writes the HandsFreeOS blog, and what each of them has written.';

export const metadata: Metadata = {
  title: blogTitle(TITLE),
  description: DESCRIPTION,
  alternates: blogAlternates(blogPaths.authors()),
  openGraph: openGraph({
    type: 'website',
    url: blogPaths.authors(),
    title: TITLE,
    description: DESCRIPTION,
  }),
};

export default async function AuthorsPage() {
  // Rendered per request from the cached API answer, so a deploy never has to reach Opinly to build it.
  await connection();
  const { data: authors } = await opinly.authors();
  const crumbs = blogCrumbs({ name: 'Authors', path: blogPaths.authors() });

  return (
    <Container className="py-12 sm:py-16">
      <JsonLd data={breadcrumbJsonLd(crumbs)} />
      <BlogHeader crumbs={crumbs} title="Authors" sub={DESCRIPTION} />

      {authors.length === 0 ? (
        <EmptyState
          title="No authors yet"
          action={{ href: blogPaths.index(), label: 'See every post' }}
        />
      ) : (
        <ul className="grid gap-6 md:grid-cols-2" role="list">
          {authors.map((author) => (
            <li
              key={author.slug}
              className="bg-card border-border flex gap-5 rounded-[var(--radius-card)] border p-6"
            >
              <AuthorAvatar name={author.name} fileKey={author.image?.fileKey} />
              <div className="min-w-0">
                <h2 className="text-xl font-bold">
                  <Link href={blogPaths.author(author.slug)} className="hover:underline">
                    {author.name}
                  </Link>
                </h2>
                {author.bio ? <p className="text-text-2 mt-2 line-clamp-3">{author.bio}</p> : null}
                {author.posts[0] ? (
                  <p className="text-text-3 mt-3 text-sm">
                    Latest:{' '}
                    <Link
                      href={blogPaths.post(author.posts[0].slug)}
                      className="text-text-2 hover:text-text hover:underline"
                    >
                      {author.posts[0].title}
                    </Link>
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}
