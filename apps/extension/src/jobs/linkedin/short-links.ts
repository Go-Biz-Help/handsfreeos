/**
 * LinkedIn's short links (https://lnkd.in/p/…), made the post's own address (docs/outreach.md, decision 138). Since
 * 31 Oct 2026 Copy link to post on LinkedIn's post search copies one (the owner's outline), and it names no post: it
 * answers with a redirect to the post's public page, /posts/<name>_<words>-share-<number>-…/, whose number is the
 * post's. The background worker follows it as a HEAD without the person's cookies, so no page is drawn and LinkedIn
 * sees no visit from their account; a sign-in wall in the way still names the post it would go on to.
 */
import { linkedinUrl, postUrlFrom } from '../../networks/linkedin/urls';

/** How long a short link has to answer. */
const FOLLOW_MS = 10_000;

/** The post an address names: its own, or the one LinkedIn's sign-in wall would go on to (`sessionRedirect`). */
export function postUrlIn(href: string): string | null {
  const url = linkedinUrl(href);
  if (!url) return null;
  const own = postUrlFrom(url);
  if (own) return own;
  for (const value of url.searchParams.values()) {
    const inner = linkedinUrl(value);
    const post = inner ? postUrlFrom(inner) : null;
    if (post) return post;
  }
  return null;
}

/** The post a short link leads to, as /feed/update/urn:li:…/, or null when it leads to none or doesn't answer. */
export async function postUrlOfShort(
  short: string,
  get: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const answer = await get(short, {
      method: 'HEAD',
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(FOLLOW_MS),
    });
    return postUrlIn(answer.url);
  } catch {
    return null;
  }
}
