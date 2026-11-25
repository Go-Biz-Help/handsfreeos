/**
 * The business's link as the first comment under its own post, once the post is up (docs/socialcontent.md, "Your
 * link"; the owner, 24 Nov 2026): on Facebook, Instagram and LinkedIn, from the person's own account (a Page's post
 * too: the owner's pick, 24 Nov). Threads and X need none of this: the link goes as a reply in the post's own chain.
 * It's written once and never again: a comment that may have gone is the person's to look at.
 *
 * - **On the post's own page** (its link opened): the post's own box to comment in, as Social Outreach's comments go
 *   (../networks/facebook/auto.ts, ../networks/linkedin/auto.ts, ../networks/instagram/auto.ts).
 * - **Facebook, without its link** (a new post's time link stays empty until it's pointed at): on the page that lists
 *   it (the profile or the Page), the post that starts with its words, its Comment pressed to open it over the page,
 *   then that box. Never another post's box: with no post opened over the page, nothing is written.
 */
import type { AutoResult } from '../networks/facebook/auto';
import { writeComment as facebookComment } from '../networks/facebook/auto';
import { labelOf, mainOf } from '../networks/facebook/dom';
import { shown } from '../networks/facebook/fetch';
import { postBoxes, postOver, readPost } from '../networks/facebook/posts';
import { facebookUrl, postUrlFrom } from '../networks/facebook/urls';
import { writeTheirComment } from '../networks/instagram/auto';
import { writeComment as linkedinComment } from '../networks/linkedin/auto';
import { waitFor } from '../steady';
import { instagramMe } from './post-here';

/** What the background asks for: the comment's words, and the post's own words to find it by. */
export interface CommentAsk {
  readonly where: 'facebook' | 'instagram' | 'linkedin';
  readonly text: string;
  readonly words: string;
}

/** How long a Facebook post opened by its Comment is waited on to show over the page. */
const OPENED_MS = 5_000;

/** Facebook's own mark on a post's Comment button, in the bar its Like and Share sit in. */
const COMMENT_HOOK = '[data-ad-rendering-role="comment_button"]';

/**
 * Words compared with no spaces or line breaks, in lower case, the first 60 characters, with a "…" Facebook cuts a
 * long post short with left off: as `startsLike` in ../jobs/helpful.ts, which finds the post's link the same way.
 */
const plain = (s: string) => s.replace(/\s+/g, '').toLowerCase();
export function startsLike(shownWords: string, text: string): boolean {
  const mine = plain(text).slice(0, 60);
  const theirs = plain(shownWords)
    .replace(/(?:…|\.{3})$/u, '')
    .slice(0, 60);
  return (
    mine.length > 0 &&
    theirs.length >= Math.min(20, mine.length) &&
    (theirs.startsWith(mine) || mine.startsWith(theirs))
  );
}

/** Whether the page is a Facebook post's own. */
function onFacebookPost(href: string): boolean {
  const url = facebookUrl(href);
  return url !== null && postUrlFrom(url) !== null;
}

/** On the page that lists it, the post that starts with these words, opened over the page by its own Comment. */
async function openFacebookPost(doc: Document, href: string, words: string): Promise<boolean> {
  const box = postBoxes(mainOf(doc)).find((b) => startsLike(readPost(b, href)?.text ?? '', words));
  if (!box) return false;
  const opener =
    [...box.querySelectorAll<HTMLElement>(`${COMMENT_HOOK}, [role="button"], button`)].find(
      (b) =>
        shown(b) &&
        (b.matches(COMMENT_HOOK) || /^(leave a comment|comment)$/i.test(labelOf(b))) &&
        !b.closest('[role="article"] [role="article"]'),
    ) ?? null;
  if (!opener) return false;
  opener.click();
  return (await waitFor(() => postOver(doc), OPENED_MS, 300)) !== null;
}

/** Writes the first comment under the business's own post: `done` once it went. */
export async function commentHere(
  doc: Document,
  href: string,
  ask: CommentAsk,
): Promise<AutoResult> {
  if (!ask.text.trim()) return 'none';
  if (ask.where === 'facebook') {
    if (!postOver(doc) && !onFacebookPost(href) && !(await openFacebookPost(doc, href, ask.words)))
      return 'none';
    return facebookComment(doc, ask.text);
  }
  if (ask.where === 'linkedin') return linkedinComment(doc, ask.text);
  const me = instagramMe(doc);
  if (!me) return 'none';
  return writeTheirComment(
    doc,
    href,
    {
      profile: { id: null, username: me, url: `https://www.instagram.com/${me}/` },
      postUrl: href,
    },
    ask.text,
  );
}
