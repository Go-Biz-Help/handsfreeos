/**
 * The business's link in its own posts (docs/socialcontent.md, "Your link"; the owner, 24 Nov 2026: "the content
 * creator posts are mentioning a link but there is not link in the post. i want the option to put a link in the
 * playbook and choose to put the link in the post, say it is in the bio, or put in the first comment after the post is
 * public").
 *
 * - **The link** is kept once for the business, on the Playbook page (`settings.link`), with **where it goes** on each
 *   network (`settings.link_places`): **In the post** (added after the post's words as it goes up), **Link in bio**
 *   (the words say it's in the bio, where the person keeps it themselves) or **First comment** (the extension writes it
 *   as the first comment once the post is up; on Threads and X, a reply under it).
 * - **A post carries it** only when its words point people to it (`content.link_place`, where it went when it was
 *   written). The AI is told whether the post may carry one, and where it goes, and never to mention one otherwise;
 *   what it writes is checked here (`mentionsLink`, `withoutLinkTalk`), so a post never promises a link it won't have.
 *
 * Browser-safe and pure: the web, the phone, the worker and the extension agree.
 */
import { quoteData } from '../../knowledge/prompt';
import { isPostingNetwork, POSTING_NETWORKS, type PostingNetwork } from './calendar';

/** Where a post's link goes (the owner's three, 24 Nov). */
export const LINK_PLACES = ['post', 'bio', 'comment'] as const;
export type LinkPlace = (typeof LINK_PLACES)[number];
export const isLinkPlace = (v: unknown): v is LinkPlace =>
  typeof v === 'string' && (LINK_PLACES as readonly string[]).includes(v);

/** Where the link goes on each network. */
export type LinkPlaces = Readonly<Record<PostingNetwork, LinkPlace>>;

export const LINK = {
  /** The longest link kept. */
  most: 500,
} as const;

/**
 * Where it goes on a network the person hasn't picked for: Instagram says it's in the bio, since a link in an Instagram
 * post can't be tapped; everywhere else it's in the post.
 */
export const DEFAULT_LINK_PLACES: LinkPlaces = {
  instagram: 'bio',
  facebook: 'post',
  linkedin: 'post',
  threads: 'post',
  x: 'post',
};

/** Each network's place, from what's kept (anything else is the network's default). */
export function linkPlacesOf(raw: unknown): Record<PostingNetwork, LinkPlace> {
  const kept = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_LINK_PLACES };
  for (const n of POSTING_NETWORKS) {
    const p = kept[n];
    if (isLinkPlace(p)) out[n] = p;
  }
  return out;
}

/** The places given, kept only for the networks posts are written for. */
export function linkPlacesChanged(
  was: LinkPlaces,
  changes: Readonly<Partial<Record<string, unknown>>>,
): Record<PostingNetwork, LinkPlace> {
  const out = { ...was };
  for (const [n, p] of Object.entries(changes))
    if (isPostingNetwork(n) && isLinkPlace(p)) out[n] = p;
  return out;
}

/**
 * The link as kept: trimmed, with `https://` in front when it has no `http(s)://` of its own, and a real web address
 * (a name with a dot in it). Null when there's none, or it isn't one.
 */
export function cleanLink(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t || /\s/.test(t) || t.length > LINK.most) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!/^[^.]+\.[^.]+/.test(url.hostname) || url.hostname.endsWith('.')) return null;
  return withScheme.length > LINK.most ? null : withScheme;
}

/**
 * Words that point people to a link: "link in bio", "the link in the first comment", "link below", "click the link",
 * "tap here", a web address. Not a link a post talks about ("send them a booking link", "internal links"), which is
 * what the business does, not somewhere to go.
 */
const LINK_TALK: readonly RegExp[] = [
  // "link in bio", "link’s in our bio", "the link is in the first comment", "links in the caption"
  /\blinks?(?:['’]s| is| are)? (?:in|on) (?:my |our |the )?(?:bio|profile|first comment|comments?|caption|description|repl(?:y|ies))\b/i,
  // "link below", "the link above", "link here", "link 👇"
  /\blinks? (?:below|above|here|down below)\b/i,
  /\blinks?\s*(?:👇|⬇️|⬇|👆)/u,
  // "click the link", "tap our link", "use this link", "at the link", "via the link"
  /\b(?:click|tap|hit|press|use|follow|visit|open|check out|grab|see|at|via|through) (?:the|this|our|my) links?\b/i,
  // "in our bio", "from the bio"
  /\b(?:in|on|from) (?:my|our|the) bio\b/i,
  /\b(?:click|tap) (?:here|below|above)\b/i,
  /\bswipe up\b/i,
  // "details in the first comment"
  /\b(?:details|info|more|everything)(?: is| are)? in the (?:first )?comments?\b/i,
  // A web address typed out.
  /\bhttps?:\/\/\S+/i,
  /\bwww\.[a-z0-9-]+\.[a-z]/i,
];

/** Whether these words point people to a link. */
export const mentionsLink = (text: string | null | undefined): boolean =>
  !!text && LINK_TALK.some((p) => p.test(text));

/**
 * The words without what points people to a link: each sentence that does is left out, and a line left empty goes
 * (the blank lines between paragraphs stay). For a post that carries no link.
 */
export function withoutLinkTalk(words: string): string {
  if (!mentionsLink(words)) return words;
  const lines = words.split('\n').map((line) => {
    if (!mentionsLink(line)) return line;
    const kept = line
      .split(/(?<=[.!?…])\s+/)
      .filter((sentence) => !mentionsLink(sentence))
      .join(' ')
      .trim();
    return kept ? kept : null;
  });
  return lines
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** What a post's link adds to its words as they go up: the room it takes, when it's in the post. */
export const linkRoom = (place: LinkPlace | null, link: string | null): number =>
  place === 'post' && link ? link.length + 2 : 0;

/** The networks where the first comment is a reply under the post, in its chain: Threads and X. */
export const repliesWithLink = (network: string): boolean =>
  network === 'threads' || network === 'x';

/** The link a post carries as it goes up, and where; null when it carries none, or the business has no link. */
export function postLinkOf(
  place: string | null | undefined,
  link: string | null | undefined,
): { readonly place: LinkPlace; readonly link: string } | null {
  return isLinkPlace(place) && link ? { place, link } : null;
}

/**
 * What the writer is told about the link for one post: where it goes and what to say, or that the post carries none,
 * so it never mentions one.
 */
export function linkForAi(
  network: PostingNetwork,
  link: { readonly url: string; readonly place: LinkPlace } | null,
): string {
  if (!link)
    return 'This post carries no link: never mention a link, a bio, a website to visit, the comments for a link, or anything to click or tap. Point people to something they can do here instead (comment, send a message, save or share it).';
  const where =
    link.place === 'post'
      ? 'goes at the end of the post’s words, added for you as it goes up. To point to it, say so plainly (“Book at the link below.”).'
      : link.place === 'bio'
        ? 'is in the business’s profile bio. To point to it, say it’s in the bio (“Link in bio.”).'
        : repliesWithLink(network)
          ? 'goes in a reply under the post once it’s up. To point to it, say it’s in the reply below (“Link in the reply below.”).'
          : 'goes in the first comment under the post once it’s up. To point to it, say it’s in the first comment (“Link in the first comment.”).';
  return `<link>\n${quoteData(link.url)}\n</link>\nThe business’s link above ${where} Point to it only when it fits, such as the offer or a clear ask to book, buy or learn more, and then set link to true; a tip or a story can end with a question instead. Never type the address yourself, and never say the link is anywhere else. With link false, never mention a link at all.`;
}
