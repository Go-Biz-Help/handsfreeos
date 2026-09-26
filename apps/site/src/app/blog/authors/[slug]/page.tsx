import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AuthorAvatar, Breadcrumbs, EmptyState, Pagination, PostGrid } from '@/components/blog';
import { JsonLd } from '@/components/json-ld';
import { Container } from '@/components/ui';
import { isBadCursor, opinly } from '@/lib/opinly/client';
import { loadAuthor } from '@/lib/opinly/load';
import { blogPaths, imageUrl, pagedPath, readCursor } from '@/lib/opinly/paths';
import {
  blogAlternates,
  blogCrumbs,
  blogTitle,
  breadcrumbJsonLd,
  openGraph,
  profileJsonLd,
} from '@/lib/opinly/seo';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ slug }, { cursor: raw }] = await Promise.all([params, searchParams]);
  const author = await loadAuthor(slug);
  const cursor = readCursor(raw);
  const title = cursor ? `${author.name} — older posts` : `${author.name}, author`;
  const description = author.bio || `Articles by ${author.name} on the HandsFreeOS blog.`;
  const path = pagedPath(blogPaths.author(slug), cursor);
  const image = imageUrl(author.image?.fileKey);
  return {
    title: blogTitle(title),
    description,
    alternates: blogAlternates(path),
    openGraph: openGraph({
      type: 'profile',
      url: path,
      title: author.name,
      description,
      ...(image ? { images: [{ url: image, alt: author.name }] } : {}),
    }),
  };
}

/** One author: who they are, then everything they have written, paged the same way as the blog. */
export default async function AuthorPage({ params, searchParams }: Props) {
  const [{ slug }, { cursor: raw }] = await Promise.all([params, searchParams]);
  const cursor = readCursor(raw);
  const [author, page] = await Promise.all([
    loadAuthor(slug),
    opinly.posts({ author: slug, cursor }).catch((error: unknown) => {
      if (isBadCursor(error)) notFound();
      throw error;
    }),
  ]);
  const path = blogPaths.author(slug);
  const crumbs = blogCrumbs(
    { name: 'Authors', path: blogPaths.authors() },
    { name: author.name, path },
  );

  return (
    <Container className="py-12 sm:py-16">
      <JsonLd
        data={profileJsonLd({
          name: author.name,
          slug: author.slug,
          bio: author.bio,
          image: imageUrl(author.image?.fileKey),
        })}
      />
      <JsonLd data={breadcrumbJsonLd(crumbs)} />

      <header className="mb-12">
        <Breadcrumbs crumbs={crumbs} />
        <div className="mt-8 flex flex-col gap-6 sm:flex-row sm:items-center">
          <AuthorAvatar name={author.name} fileKey={author.image?.fileKey} size={96} />
          <div>
            <p className="text-accent-text text-xs font-semibold tracking-[0.14em] uppercase">
              Author
            </p>
            <h1 className="mt-2 text-3xl leading-[1.12] font-bold sm:text-4xl">{author.name}</h1>
            {author.bio ? <p className="text-text-2 mt-4 max-w-3xl text-lg">{author.bio}</p> : null}
          </div>
        </div>
      </header>

      <h2 className="mb-6 text-2xl font-bold">{cursor ? 'Older articles' : 'Articles'}</h2>
      {page.data.length === 0 ? (
        <EmptyState
          title={cursor ? 'That is every post' : 'Nothing published yet'}
          action={{ href: blogPaths.index(), label: 'See every post' }}
        />
      ) : (
        <PostGrid posts={page.data} heading="h3" />
      )}

      <Pagination
        basePath={path}
        nextCursor={page.has_more ? page.next_cursor : null}
        onFirstPage={!cursor}
      />
    </Container>
  );
}
