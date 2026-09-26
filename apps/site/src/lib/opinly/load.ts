/**
 * The "does this page exist?" half of each blog page, shared by the page and the layout above it.
 *
 * The layout calls these first, *outside* the page's loading skeleton, so a missing post, category, tag or author
 * answers with a real 404 rather than a streamed 200 marked `noindex`. The page calls them again for the data;
 * `opinly`'s calls are request-memoised, so the second call costs nothing.
 */
import 'server-only';
import { notFound } from 'next/navigation';
import { opinly } from './client';

export async function loadPost(slug: string) {
  const post = await opinly.post(slug);
  if (!post) notFound();
  return post;
}

/** A category's name and blurb come from the category list; its posts are paged separately. */
export async function loadCategory(slug: string) {
  const categories = await opinly.categories();
  const category = categories.find((c) => c.slug === slug);
  if (!category) notFound();
  return { category, categories };
}

export async function loadTag(slug: string) {
  const tag = (await opinly.tags()).find((t) => t.slug === slug);
  if (!tag) notFound();
  return tag;
}

export async function loadAuthor(slug: string) {
  const author = await opinly.author(slug);
  if (!author) notFound();
  return author;
}
