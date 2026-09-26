/**
 * The blog's building blocks: cards, bylines, breadcrumbs, the "older posts" link and the empty states.
 *
 * All server components. Posts arrive from Opinly already published, so nothing here needs the browser.
 */
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { blogPaths, imageUrl, pagedPath } from '@/lib/opinly/paths';
import type { Crumb } from '@/lib/opinly/seo';
import type { OpinlyPost, OpinlyPostAuthor } from '@/lib/opinly/types';

const dateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  // Opinly's dates are UTC; formatting them in the server's zone would move a midnight post a day.
  timeZone: 'UTC',
});

export function PostDate({ iso }: { iso: string }) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return <time dateTime={iso}>{dateFormat.format(date)}</time>;
}

/** Author, date and, on a full post, reading time — separated by dots, and read as one line. */
export function Byline({
  author,
  date,
  minutes,
  linkAuthor = true,
}: {
  author: OpinlyPostAuthor | null;
  date: string;
  minutes?: number;
  linkAuthor?: boolean;
}) {
  const parts: ReactNode[] = [];
  if (author) {
    parts.push(
      linkAuthor ? (
        <Link
          key="a"
          href={blogPaths.author(author.slug)}
          className="text-text hover:text-accent-text relative z-10 font-semibold"
        >
          {author.name}
        </Link>
      ) : (
        <span key="a" className="text-text font-semibold">
          {author.name}
        </span>
      ),
    );
  }
  parts.push(<PostDate key="d" iso={date} />);
  if (minutes) parts.push(<span key="m">{minutes} min read</span>);
  return (
    <p className="text-text-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </span>
      ))}
    </p>
  );
}

/**
 * One post in a list. The whole card is one link (the title's, stretched over the card) so a screen reader
 * hears each post once; the category and author sit above the stretch and stay separately clickable.
 */
export function PostCard({
  post,
  heading = 'h2',
  eager = false,
}: {
  post: OpinlyPost;
  heading?: 'h2' | 'h3';
  /** The first card on a page is usually the largest thing above the fold: load it straight away. */
  eager?: boolean;
}) {
  const Heading = heading;
  const src = imageUrl(post.image?.fileKey);
  return (
    <article className="group bg-card border-border hover:border-border-strong relative flex w-full flex-col overflow-hidden rounded-[var(--radius-card)] border transition-colors">
      {src ? (
        <div className="bg-card-2 relative aspect-[16/9] overflow-hidden">
          <Image
            src={src}
            // The title right below says what the picture is about; repeating it would be read twice.
            alt=""
            fill
            sizes="(min-width: 1024px) 368px, (min-width: 640px) 50vw, 100vw"
            className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            preload={eager}
          />
        </div>
      ) : null}
      <div className="flex flex-1 flex-col gap-3 p-6">
        {post.category ? (
          <Link
            href={blogPaths.category(post.category.slug)}
            className="text-accent-text relative z-10 self-start text-xs font-semibold tracking-[0.14em] uppercase hover:underline"
          >
            {post.category.name}
          </Link>
        ) : null}
        <Heading className="text-xl leading-snug font-bold">
          <Link
            href={blogPaths.post(post.slug)}
            className="after:absolute after:inset-0 after:content-[''] hover:underline"
          >
            {post.title}
          </Link>
        </Heading>
        {post.description ? <p className="text-text-2 line-clamp-3">{post.description}</p> : null}
        <div className="mt-auto pt-2">
          <Byline author={post.author} date={post.firstPublishedAt} />
        </div>
      </div>
    </article>
  );
}

export function PostGrid({
  posts,
  heading = 'h2',
}: {
  posts: readonly OpinlyPost[];
  heading?: 'h2' | 'h3';
}) {
  return (
    <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" role="list">
      {posts.map((post, i) => (
        <li key={post.slug} className="flex">
          <PostCard post={post} heading={heading} eager={i === 0} />
        </li>
      ))}
    </ul>
  );
}

/** The trail at the top of every blog page. The same list is the page's BreadcrumbList. */
export function Breadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-text-3 text-sm">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={crumb.path} className="flex items-center gap-2">
              {i > 0 ? <span aria-hidden="true">/</span> : null}
              {last ? (
                <span aria-current="page" className="text-text-2 line-clamp-1">
                  {crumb.name}
                </span>
              ) : (
                <Link href={crumb.path} className="hover:text-text">
                  {crumb.name}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Opinly pages with an opaque cursor, which only goes forward. So there is "older posts" and "back to the
 * newest" rather than numbered pages — both plain links, so crawlers follow them and they work without script.
 */
export function Pagination({
  basePath,
  nextCursor,
  onFirstPage,
}: {
  basePath: string;
  nextCursor: string | null;
  onFirstPage: boolean;
}) {
  if (!nextCursor && onFirstPage) return null;
  return (
    <nav
      aria-label="More posts"
      className="mt-12 flex flex-wrap items-center justify-between gap-4"
    >
      {onFirstPage ? (
        <span />
      ) : (
        <Link href={basePath} className="text-accent-text font-semibold hover:underline">
          <span aria-hidden="true">← </span>Back to the newest posts
        </Link>
      )}
      {nextCursor ? (
        <Link
          href={pagedPath(basePath, nextCursor)}
          rel="next"
          className="bg-card text-text border-border-strong hover:bg-card-2 inline-flex items-center gap-2 rounded-[10px] border px-5 py-2.5 font-semibold transition-colors"
        >
          Older posts<span aria-hidden="true"> →</span>
        </Link>
      ) : null}
    </nav>
  );
}

/** When a list has nothing in it. Says so plainly, and offers somewhere to go. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="border-border bg-card-2 rounded-[var(--radius-card)] border border-dashed px-6 py-14 text-center">
      <h2 className="text-xl font-bold">{title}</h2>
      {children ? <p className="text-text-2 mx-auto mt-3 max-w-md">{children}</p> : null}
      {action ? (
        <Link
          href={action.href}
          className="text-accent-text mt-5 inline-block font-semibold hover:underline"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

/** The page heading block every blog listing opens with. */
export function BlogHeader({
  crumbs,
  eyebrow,
  title,
  sub,
}: {
  crumbs: readonly Crumb[];
  eyebrow?: string;
  title: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <header className="mb-12">
      <Breadcrumbs crumbs={crumbs} />
      {eyebrow ? (
        <p className="text-accent-text mt-8 text-xs font-semibold tracking-[0.14em] uppercase">
          {eyebrow}
        </p>
      ) : null}
      <h1
        className={`${eyebrow ? 'mt-3' : 'mt-8'} max-w-3xl text-3xl leading-[1.12] font-bold sm:text-4xl md:text-[2.75rem]`}
      >
        {title}
      </h1>
      {sub ? <p className="text-text-2 mt-5 max-w-3xl text-lg sm:text-xl">{sub}</p> : null}
    </header>
  );
}

/** Links to every category, as a row of chips. The current one is marked, not linked. */
export function CategoryChips({
  categories,
  current,
}: {
  categories: readonly { slug: string; title: string }[];
  current?: string;
}) {
  if (categories.length === 0) return null;
  const chip =
    'inline-flex items-center rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors';
  return (
    <nav aria-label="Categories" className="mb-10">
      <ul className="flex flex-wrap gap-2" role="list">
        <li>
          {current ? (
            <Link
              href={blogPaths.index()}
              className={`${chip} border-border text-text-2 hover:border-border-strong hover:text-text`}
            >
              All posts
            </Link>
          ) : (
            <span
              aria-current="page"
              className={`${chip} border-accent bg-accent-soft text-accent-text`}
            >
              All posts
            </span>
          )}
        </li>
        {categories.map((category) => (
          <li key={category.slug}>
            {category.slug === current ? (
              <span
                aria-current="page"
                className={`${chip} border-accent bg-accent-soft text-accent-text`}
              >
                {category.title}
              </span>
            ) : (
              <Link
                href={blogPaths.category(category.slug)}
                className={`${chip} border-border text-text-2 hover:border-border-strong hover:text-text`}
              >
                {category.title}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** An author's picture, or their initial on the accent tint when Opinly has none. Decorative: the name is beside it. */
export function AuthorAvatar({
  name,
  fileKey,
  size = 56,
}: {
  name: string;
  fileKey: string | null | undefined;
  size?: 56 | 96;
}) {
  const src = imageUrl(fileKey);
  const box = size === 96 ? 'h-24 w-24 text-3xl' : 'h-14 w-14 text-lg';
  if (!src) {
    return (
      <span
        aria-hidden="true"
        className={`bg-accent-soft-2 text-accent-text flex shrink-0 items-center justify-center rounded-full font-bold ${box}`}
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <Image
      src={src}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 rounded-full object-cover ${box}`}
    />
  );
}
