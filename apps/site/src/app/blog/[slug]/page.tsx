import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { AuthorAvatar, Breadcrumbs, Byline, PostCard, PostDate } from '@/components/blog';
import { JsonLd } from '@/components/json-ld';
import { Button, Container } from '@/components/ui';
import { urls } from '@/content/site';
import { opinly } from '@/lib/opinly/client';
import { loadPost } from '@/lib/opinly/load';
import { absoluteUrl, blogPaths, imageUrl } from '@/lib/opinly/paths';
import { extractHeadings, PostBody, readingMinutes } from '@/lib/opinly/render';
import {
  blogAlternates,
  blogCrumbs,
  blogPostingJsonLd,
  blogTitle,
  breadcrumbJsonLd,
  faqJsonLd,
  openGraph,
} from '@/lib/opinly/seo';
import type { OpinlyFullPost, OpinlyPost } from '@/lib/opinly/types';

/**
 * Posts are built ahead of time from `/v1/content/routes` and kept until Opinly's webhook says one changed
 * (the hour is only a backstop). A post published after the last deploy is built on its first visit.
 */
export const revalidate = 3600;

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  try {
    const routes = await opinly.routes();
    return routes.filter((r) => r.type === 'post' && r.slug).map((r) => ({ slug: r.slug }));
  } catch (error) {
    // No key (CI, a preview) or Opinly unreachable: the build still ships, and each post is built when first
    // asked for instead. A marketing deploy must never fail because the blog's API had a bad minute.
    console.warn(`[blog] building posts on demand: ${(error as Error).message}`);
    return [];
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = await loadPost((await params).slug);

  const title = post.metaTitle ?? post.title;
  const description = post.metaDescription ?? post.description;
  const path = blogPaths.post(post.slug);
  const image = imageUrl(post.titleFile?.fileKey);
  const images = image ? [{ url: image, alt: post.titleFile?.altText ?? post.title }] : undefined;

  return {
    title: blogTitle(title),
    description,
    alternates: blogAlternates(path),
    authors: post.author
      ? [{ name: post.author.name, url: blogPaths.author(post.author.slug) }]
      : undefined,
    keywords: post.tags.length ? post.tags.map((t) => t.name) : undefined,
    openGraph: openGraph({
      type: 'article',
      url: path,
      title,
      description,
      publishedTime: post.firstPublishedAt,
      modifiedTime: post.modifiedAt || post.firstPublishedAt,
      authors: post.author ? [absoluteUrl(blogPaths.author(post.author.slug))] : undefined,
      section: post.category?.name,
      tags: post.tags.map((t) => t.name),
      ...(images ? { images } : {}),
    }),
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: images ?? ['/twitter-image'],
    },
  };
}

/** Up to three more from the same category, or the newest others when it has none. Never the post itself. */
async function related(post: OpinlyFullPost): Promise<OpinlyPost[]> {
  try {
    const list = await opinly.posts({ category: post.category?.slug, limit: 4 });
    return list.data.filter((p) => p.slug !== post.slug).slice(0, 3);
  } catch {
    return [];
  }
}

export default async function PostPage({ params }: Props) {
  const post = await loadPost((await params).slug);

  const crumbs = blogCrumbs(
    ...(post.category
      ? [{ name: post.category.name, path: blogPaths.category(post.category.slug) }]
      : []),
    { name: post.title, path: blogPaths.post(post.slug) },
  );
  const hero = imageUrl(post.titleFile?.fileKey);
  const contents = extractHeadings(post.content).filter((h) => h.level === 2);
  const faqs = post.faqs ?? [];
  const more = await related(post);
  const updated =
    post.modifiedAt && post.modifiedAt.slice(0, 10) !== post.firstPublishedAt.slice(0, 10)
      ? post.modifiedAt
      : null;

  return (
    <>
      <JsonLd data={blogPostingJsonLd(post)} />
      <JsonLd data={breadcrumbJsonLd(crumbs)} />
      {faqs.length ? <JsonLd data={faqJsonLd(post)} /> : null}

      <article className="py-12 sm:py-16">
        <Container>
          <header className="mx-auto max-w-3xl">
            <Breadcrumbs crumbs={crumbs} />
            {post.category ? (
              <Link
                href={blogPaths.category(post.category.slug)}
                className="text-accent-text mt-8 inline-block text-xs font-semibold tracking-[0.14em] uppercase hover:underline"
              >
                {post.category.name}
              </Link>
            ) : null}
            <h1
              className={`${post.category ? 'mt-3' : 'mt-8'} text-3xl leading-[1.12] font-bold sm:text-4xl md:text-[2.75rem]`}
            >
              {post.title}
            </h1>
            {post.description ? (
              <p className="text-text-2 mt-5 text-lg sm:text-xl">{post.description}</p>
            ) : null}
            <div className="mt-6">
              <Byline
                author={post.author}
                date={post.firstPublishedAt}
                minutes={readingMinutes(post.content)}
              />
              {updated ? (
                <p className="text-text-3 mt-1 text-sm">
                  Updated <PostDate iso={updated} />
                </p>
              ) : null}
            </div>
          </header>

          {hero ? (
            <figure className="mx-auto mt-10 max-w-4xl">
              <div className="bg-card-2 relative aspect-[16/9] overflow-hidden rounded-[var(--radius-card)]">
                <Image
                  src={hero}
                  alt={post.titleFile?.altText ?? ''}
                  fill
                  preload
                  sizes="(min-width: 1024px) 896px, 100vw"
                  className="object-cover"
                />
              </div>
              {post.titleFile?.caption ? (
                <figcaption className="text-text-3 mt-3 text-center text-sm">
                  {post.titleFile.caption}
                </figcaption>
              ) : null}
            </figure>
          ) : null}

          <div className="mx-auto mt-10 max-w-3xl">
            {contents.length >= 3 ? (
              <nav
                aria-labelledby="contents-heading"
                className="border-border bg-card-2 mb-10 rounded-[var(--radius-card)] border p-5"
              >
                <h2
                  id="contents-heading"
                  className="text-text text-sm font-semibold tracking-[0.12em] uppercase"
                >
                  On this page
                </h2>
                <ol className="mt-3 space-y-2">
                  {contents.map((h) => (
                    <li key={h.id}>
                      <a href={`#${h.id}`} className="text-text-2 hover:text-text hover:underline">
                        {h.text}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
            ) : null}

            <PostBody content={post.content} />

            {faqs.length ? (
              <section aria-labelledby="faq-heading" className="mt-14">
                <h2 id="faq-heading" className="text-2xl font-bold">
                  Questions people ask
                </h2>
                <dl className="border-border mt-6 divide-y divide-[var(--border)] border-y">
                  {faqs.map((faq) => (
                    <div key={faq.question} className="py-5">
                      <dt className="text-text font-semibold">{faq.question}</dt>
                      <dd className="text-text-2 mt-2">{faq.answer}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}

            {post.tags.length ? (
              <div className="mt-12">
                <h2 className="sr-only">Topics</h2>
                <ul className="flex flex-wrap gap-2" role="list">
                  {post.tags.map((tag) => (
                    <li key={tag.slug}>
                      <Link
                        href={blogPaths.tag(tag.slug)}
                        className="border-border text-text-2 hover:border-border-strong hover:text-text inline-flex rounded-full border px-3 py-1 text-sm transition-colors"
                      >
                        {tag.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {post.author ? (
              <aside
                aria-label="About the author"
                className="border-border bg-card mt-12 flex gap-4 rounded-[var(--radius-card)] border p-5"
              >
                <AuthorAvatar name={post.author.name} fileKey={post.author.fileKey} />
                <div>
                  <p className="text-text-3 text-sm">Written by</p>
                  <p className="font-semibold">
                    <Link href={blogPaths.author(post.author.slug)} className="hover:underline">
                      {post.author.name}
                    </Link>
                  </p>
                  {post.author.bio ? (
                    <p className="text-text-2 mt-2 text-base">{post.author.bio}</p>
                  ) : null}
                </div>
              </aside>
            ) : null}

            <section
              aria-labelledby="cta-heading"
              className="border-border bg-accent-soft mt-12 rounded-[var(--radius-card)] border p-6 sm:p-8"
            >
              <h2 id="cta-heading" className="text-2xl font-bold">
                Your business keeps answering while you’re on the job.
              </h2>
              <p className="text-text-2 mt-3">
                HandsFreeOS answers your calls and texts, books the job, sends the quote and chases
                the invoice — one system for small service businesses.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Button href={urls.signUp}>Sign up</Button>
                <Button href="/features" variant="secondary">
                  See what it does
                </Button>
              </div>
            </section>
          </div>
        </Container>
      </article>

      {more.length ? (
        <section aria-labelledby="more-heading" className="border-border bg-card-2 border-t py-16">
          <Container>
            <h2 id="more-heading" className="text-2xl font-bold">
              Keep reading
            </h2>
            <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3" role="list">
              {more.map((p) => (
                <li key={p.slug} className="flex">
                  <PostCard post={p} heading="h3" />
                </li>
              ))}
            </ul>
          </Container>
        </section>
      ) : null}
    </>
  );
}
