/**
 * Instagram's own readers (the Instagram and Alignable plan's part 10, "Reading"), run on each page read beside the
 * links (`LookingRead.found`), as ../alignable/read.ts is Alignable's. What its steps, its asks and Check Instagram need:
 *
 * - **Someone's profile** (/<name>/): their name and username, whether the person follows them (Follow, Follow Back,
 *   Following, Requested), whether they follow the person (Follow Back, "Follows you"), their followers, and their
 *   latest posts' links. From the owner's Check (0.62.0): the header's username in an `h2`, the name in a line of its
 *   own under it, the counts as links, and Following with its words beside an arrow.
 * - **Your followers** (the box over /<you>/followers/, or over their account once its count is pressed): each
 *   person's username, name and link, and whether the person follows them back: in their own list Instagram shows
 *   Follow beside those they don't, and Remove beside everyone.
 * - **A post** (/p/<code>/): who posted it (its own link names them: /<name>/p/<code>/), its link, its caption, its
 *   likes ("1,234 likes", "Liked by … and 12 others", or from the owner's Check of 21 Oct 2026 the number after its
 *   Like in its bar), its comments (who and what: each has its own link, /p/<code>/c/<id>/, on its time, and a Reply)
 *   and its place (/explore/locations/<id>/<name>/). From the owner's Check (0.62.0).
 * - **A post's Likes box** (decision 92, from 0.95.0): who liked it, in the box headed Likes that its count of likes
 *   opens over the post (/p/<code>/liked_by/ in the address while it's open), each row as the followers' box's are,
 *   with whether the person follows them by its own button. Never the person. Drawn from Instagram's usual markup till
 *   the owner's next Check outlines it.
 * - **A hashtag's and a place's page:** their posts' links; a hashtag's on the search Instagram sends it to now
 *   (/explore/search/keyword/?q=#<tag>).
 * - **Notifications:** who followed the person, liked or commented on their posts (the kind and who; never what a
 *   comment says), and whether the person follows them, by the button beside it (part 15). The accounts Instagram
 *   suggests under them are never among them.
 * - **Messages** (/direct/inbox/, /direct/requests/): its chats, each with the other person's name (in a `title`),
 *   whether the last line is the person's ("You: …") and when, and which box shows (Primary, General or Requests).
 *   From the owner's Check (0.62.0): the rows are buttons, not links.
 * - **A chat** (/direct/t/<id>/): who it's with, its messages (theirs or the person's), and its box: a request asks
 *   them to Accept. From the owner's Check of 21 Oct 2026: each message an article, their picture (a link to them)
 *   beside the last of a run of theirs, a post one shares linking to whoever posted it, and its header a link to them
 *   with their name in a heading.
 *
 * And what Check Instagram follows from page to page (part 9): the places, hashtags and chats a page links to.
 *
 * It reads by Instagram's own words, labels, roles and link addresses, never class names. Its followers list,
 * notifications and a chat were read from Instagram's usual markup till the owner's Check of 21 Oct 2026 (0.83.0)
 * outlined them, and they're tuned from that; a place's page is still to be outlined, as that Check found none to open.
 * Each is plain data: it crosses from the tab as JSON. Check notes only how many of each it found, never what they say
 * (../../jobs/report.ts).
 */
import { measuredSide } from '../facebook/chat';
import { clean, isBefore, textLines } from '../facebook/dom';
import { nameOf } from '../looking/read';
import {
  accountOf,
  instagramUrl,
  isCommentLink,
  kindOf,
  partsOf,
  postAuthorOf,
  postOf,
  profileOf,
  threadOf,
} from './urls';

const HOST = 'https://www.instagram.com';
/** At most, of each. */
const MOST = 20;
/** Of a list's rows and a post's comments: enough to go on with, never a whole page's worth. */
const ROWS_MOST = 200;
/**
 * Of the box of followers, which keeps every row it has drawn: room past the newest 200 that Save my followers reads
 * (the owner, 21 and 22 Oct 2026), as its rows aren't all followers. At 200 a read never got past the first 200 drawn.
 */
const FOLLOWER_ROWS_MOST = 400;
const COMMENTS_MOST = 40;
/** A chat's latest messages. */
const MESSAGES_MOST = 20;
/** A post's caption, a comment, a message: as long as a reader keeps. */
const TEXT_MOST = 2_000;
/** A profile's latest posts. */
const POSTS_MOST = 12;
/** The lines under a profile's name: what they do, their bio. */
const BIO_LINES = 8;

const LOCATION = /^\/explore\/locations\/[^/]+(\/[^/]+)?\/?$/i;
const TAG = /^\/explore\/tags\/[^/]+\/?$/i;
const THREAD = /^\/direct\/t\/[^/]+\/?$/i;

const FOLLOW = /^follow$/i;
const FOLLOW_BACK = /^follow back$/i;
const FOLLOWING = /^following$/i;
const REQUESTED = /^requested$/i;
const FOLLOWS_YOU = /^follows you$/i;
/** "Followed by sam.lee and 2 others": who they share, never their bio. */
const FOLLOWED_BY = /^followed by\b/i;
const REMOVE = /^remove$/i;
const REPLY = /^reply$/i;
const ACCEPT = /^accept$/i;
/** The heading over the accounts Instagram suggests. */
const SUGGESTED = /^suggested for you$/i;
/** Instagram's own words around a profile's lines: never a name. */
export const OWN_WORDS =
  /^(posts?|followers?|following|follow|follow back|requested|message|edit profile|view archive|more|options|new|threads|meta verified|verified|follows you|remove|·|•|reply|see translation)$/i;
/** A count with its word: "504 posts", "321K followers". */
const COUNTED = /^[\d,.]+\s*[km]?\s+(posts?|followers?|following)$/i;
/** What a notification says someone did: followed, commented, liked. Never what a comment says. */
const DID: readonly (readonly [Engaged['kind'], RegExp])[] = [
  ['follow', /\bstarted following you\b|\bfollowed you\b|\brequested to follow you\b/i],
  ['comment', /\b(commented|replied|mentioned you in a comment)\b/i],
  ['reaction', /\bliked your\b|\breacted to your\b/i],
];
/** What a chat's line of its own says it was: the person's ("You sent", "You replied"), or someone's ("Dana sent"). */
const MINE = /^you (sent|replied|reacted|forwarded)( to [^.]{1,60}| a message| an attachment)?$/i;
const THEIRS = /^(.{1,60}?) (sent|replied)( to you| a message| an attachment)?$/i;
/** Lines that are Instagram talking, not anyone in the chat. */
const NOTICE =
  /^(seen( by .+)?|sent|delivered|sending…?|active now|active \d+\w* ago|.+ is typing…?|today|yesterday|view profile|accept|delete|block|decline|you can now message.*|.+ wants to send you a message.*)$/i;

/** An account as a page links it. */
export interface Account {
  readonly username: string;
  readonly url: string;
}

/** Someone's profile, as its header shows them. */
export interface InstagramProfile extends Account {
  /** The name above their bio, when they've put one. */
  readonly name: string | null;
  /**
   * Whether the person follows them: `following`, `requested` (a private account they asked to follow), or `no`
   * (Follow, or Follow Back); null on a page without it (their own).
   */
  readonly following: 'following' | 'requested' | 'no' | null;
  /** Whether they follow the person: Follow Back, or "Follows you"; null when the page doesn't say. */
  readonly followsYou: boolean | null;
  /** How many follow them, as its link's own number says ("321,861"), else as shown ("321K"). */
  readonly followers: number | null;
  /** Their latest posts' links, as their grid shows them. */
  readonly posts: readonly string[];
  /**
   * The lines under their name, as shown (part 13, for the checks and the look-up): what they do, their bio and its
   * link's words; never a count, "Followed by …" or Instagram's own words.
   */
  readonly bio: readonly string[];
  /**
   * What Instagram says each of their latest posts shows, beside `posts`: its picture's own description, which often
   * carries its caption; null where it gave none.
   */
  readonly pictures: readonly (string | null)[];
}

/** Someone in the person's followers list. */
export interface Follower extends Account {
  readonly name: string | null;
  /** Whether the person follows them back: Follow beside them says not; null when the row doesn't say. */
  readonly followBack: boolean | null;
}

/** A comment under a post: who wrote it (their account and its own address, `url`), and what. */
export interface Comment extends Account {
  readonly text: string;
}

/**
 * Someone in a post's Likes box (decision 92): their account, the name under it, and whether the person follows them,
 * by the row's own button (Following or Requested, or Follow and Follow Back); null when the row has none.
 */
export interface Liker extends Account {
  readonly name: string | null;
  readonly following: InstagramProfile['following'];
}

/** A post's own page. */
export interface InstagramPost {
  readonly url: string;
  readonly author: Account | null;
  readonly caption: string | null;
  readonly likes: number | null;
  readonly comments: readonly Comment[];
  /** Its place's page, and its name. */
  readonly place: { readonly url: string; readonly name: string | null } | null;
}

/** A hashtag's or a place's page, and its posts' links. */
export interface PostsPage {
  readonly url: string;
  readonly name: string;
  readonly posts: readonly string[];
}

/** Someone their notifications say followed them, or liked or commented on one of their posts. */
export interface Engaged extends Account {
  readonly kind: 'follow' | 'reaction' | 'comment';
  /** The post it's about, when the notification links to it. */
  readonly post: string | null;
  /**
   * Whether the person follows them, by the notification's own button (part 15): Following or Requested, or Follow
   * and Follow Back; null when it has none.
   */
  readonly following: InstagramProfile['following'];
}

/** Which of Instagram's message boxes: Primary, General, or Requests (from people the person doesn't follow). */
export type Box = 'primary' | 'general' | 'requests';

/** A chat in the person's messages. */
export interface ChatRow {
  readonly name: string;
  /** Its last line, as the list shows it. */
  readonly preview: string | null;
  /** The last line is the person's ("You: …"). */
  readonly yours: boolean;
  readonly when: string | null;
  /** Its id, when the row links to it. */
  readonly thread: string | null;
}

/** A message in a chat: the person's or theirs. */
export interface ChatMessage {
  readonly from: 'me' | 'them';
  readonly text: string;
}

/** A chat open on its own page. */
export interface ChatOpen {
  readonly thread: string | null;
  /** Who it's with: one other account, or null for a group or when the page doesn't link them. */
  readonly with: Account | null;
  readonly name: string | null;
  readonly messages: readonly ChatMessage[];
  /**
   * Whose the last message is, written or not: a post or a reel one of them shares has no words of theirs to read, but
   * is still who wrote last (the owner's Check, 21 Oct 2026). Null with none read.
   */
  readonly last: ChatMessage['from'] | null;
  /** Its box to write in, in sight. */
  readonly box: boolean;
  /** A request they sent the person, waiting for Accept. */
  readonly request: boolean;
}

/** What Instagram's readers found on a page. Plain data: it crosses from the tab as JSON. */
export type InstagramFound = {
  readonly locations: readonly string[];
  readonly tags: readonly string[];
  readonly threads: readonly string[];
  readonly profile: InstagramProfile | null;
  readonly followers: readonly Follower[];
  readonly post: InstagramPost | null;
  /** Who liked the post, in its Likes box over it (decision 92): never the person. */
  readonly likers: readonly Liker[];
  readonly tag: PostsPage | null;
  readonly place: PostsPage | null;
  readonly engaged: readonly Engaged[];
  readonly chats: readonly ChatRow[];
  /** Which box the messages show: Primary, General or Requests. */
  readonly box: Box | null;
  readonly chat: ChatOpen | null;
  /**
   * The posts on the page whose own links name who posted them (/<name>/p/<code>/), as a search, a hashtag or a place
   * shows them (part 14, for Find partners): each post once, with its author.
   */
  readonly authors: readonly { readonly post: string; readonly author: Account }[];
};

export const NOTHING_FOUND: InstagramFound = {
  locations: [],
  tags: [],
  threads: [],
  profile: null,
  followers: [],
  post: null,
  likers: [],
  tag: null,
  place: null,
  engaged: [],
  chats: [],
  box: null,
  chat: null,
  authors: [],
};

// ------------------------------------------------------------------------------------------------ the page's parts

/** The page's main part: its main landmark, else the whole page. */
const mainOf = (doc: Document): Element => doc.querySelector('main, [role="main"]') ?? doc.body;

/** The links in a part of the page, made whole on Instagram. */
export const linksIn = (root: ParentNode, base: string) =>
  [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].flatMap((a) => {
    const url = instagramUrl(a.getAttribute('href') ?? '', base);
    return url ? [{ a, url }] : [];
  });

/** The account a link leads to, when it's one. */
export const accountLinked = (a: Element, base: string): Account | null => {
  const url = instagramUrl(a.getAttribute('href') ?? '', base);
  return url ? profileOf(url) : null;
};

/** A post's Likes box, in its address while it's open over the post. */
const LIKED_BY = /\/liked_by\/?$/i;

/** Text with its lines kept apart by a space, as a person reads it. */
function textOf(element: Element | null | undefined): string {
  if (!element) return '';
  const copy = element.cloneNode(true) as Element;
  for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
  return (copy.textContent ?? '')
    .split('\n')
    .map((line) => clean(line))
    .filter(Boolean)
    .join('\n')
    .slice(0, TEXT_MOST);
}

/** A count as Instagram prints it: "1,234", "12.5K", "3M". */
export function countOf(text: string | null | undefined): number | null {
  const t = clean(text).replace(/,/g, '');
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000) : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** The controls in a part of the page, each with what a person hears it called. */
const controlsIn = (root: ParentNode) =>
  [...root.querySelectorAll('button, [role="button"], a[href]')].map((c) => ({
    c,
    name: nameOf(c),
  }));

export const says = (root: ParentNode, words: RegExp): boolean =>
  controlsIn(root).some(({ name }) => words.test(name));

/** The lines of a part of the page with no element inside them: each piece of writing, as shown. */
export function leafLines(root: Element): { el: Element; text: string }[] {
  return [...root.querySelectorAll('span, div, h1, h2')]
    .filter((el) => !el.querySelector('span, div, h1, h2') && clean(el.textContent))
    .map((el) => ({ el, text: clean(el.textContent) }));
}

// ------------------------------------------------------------------------------------------------ a profile

/** Where the person stands with the account whose header this is, by its own buttons. */
function followingIn(header: Element): InstagramProfile['following'] {
  const names = controlsIn(header).map(({ name }) => name);
  if (names.some((n) => FOLLOWING.test(n))) return 'following';
  if (names.some((n) => REQUESTED.test(n))) return 'requested';
  if (names.some((n) => FOLLOW.test(n) || FOLLOW_BACK.test(n))) return 'no';
  return null;
}

/** Someone's profile, from its header: never the person's own (it has Edit profile, and no Follow). */
export function profileOn(doc: Document, base: string): InstagramProfile | null {
  const page = instagramUrl(base);
  if (!page || kindOf(page) !== 'profile') return null;
  const account = profileOf(page);
  const header = mainOf(doc).querySelector('header');
  if (!account || !header) return null;
  const username = clean(header.querySelector('h2, h1')?.textContent) || account.username;
  const following = followingIn(header);
  const names = controlsIn(header).map(({ name }) => name);
  const words = leafLines(header).map((l) => l.text);
  const followsYou =
    names.some((n) => FOLLOW_BACK.test(n)) || words.some((w) => FOLLOWS_YOU.test(w))
      ? true
      : names.some((n) => FOLLOW.test(n))
        ? false
        : null;
  // The name: the first line of its own that isn't a link, a button, a count or Instagram's words.
  const name =
    leafLines(header).find(
      ({ el, text }) =>
        !el.closest('a, button, [role="button"], h1, h2') &&
        text.toLowerCase() !== username.toLowerCase() &&
        !OWN_WORDS.test(text) &&
        !COUNTED.test(text) &&
        countOf(text) === null,
    )?.text ?? null;
  // Its count of followers: the link that says followers (it opens the list), never "Followed by …".
  const followersLink =
    linksIn(header, base).find(({ a }) => /\bfollowers?$/i.test(clean(a.textContent))) ??
    linksIn(header, base).find(({ url }) => /^\/[^/]+\/followers\/?$/i.test(url.pathname));
  const followers = followersLink
    ? (countOf(followersLink.a.querySelector('[title]')?.getAttribute('title')) ??
      countOf(clean(followersLink.a.textContent).replace(/\s*followers?$/i, '')))
    : null;
  // Their grid: each post once, by its link, with what Instagram says its picture shows.
  const grid = new Map<string, string | null>();
  for (const { a, url } of linksIn(mainOf(doc), base)) {
    if (header.contains(a)) continue;
    const post = postOf(url);
    if (!post || grid.has(post)) continue;
    if (grid.size >= POSTS_MOST) break;
    grid.set(post, clean(a.querySelector('img[alt]')?.getAttribute('alt')) || null);
  }
  const shownName = name && name.toLowerCase() !== account.username.toLowerCase() ? name : null;
  // The lines under their name: what they do and their bio. Instagram draws a long bio in a part to press for more,
  // so only links, buttons and headings are left out, with its own words, counts and who they share.
  const bio = [
    ...new Set(
      leafLines(header)
        .filter(
          ({ el, text }) =>
            !el.closest('a, button, h1, h2') &&
            text !== shownName &&
            text.toLowerCase() !== account.username.toLowerCase() &&
            !OWN_WORDS.test(text) &&
            !COUNTED.test(text) &&
            countOf(text) === null &&
            !FOLLOWS_YOU.test(text) &&
            !FOLLOWED_BY.test(text),
        )
        .map(({ text }) => text.slice(0, TEXT_MOST)),
    ),
  ].slice(0, BIO_LINES);
  return {
    username: account.username,
    url: account.url,
    name: shownName,
    following,
    followsYou,
    followers,
    posts: [...grid.keys()],
    bio,
    pictures: [...grid.values()],
  };
}

// ------------------------------------------------------------------------------------------------ a list of people

/**
 * The rows of a list of accounts: each the largest part of the page around one account's named link that links to no
 * other account. Its name is the first line in it that isn't the username or Instagram's own words.
 */
function rowsIn(
  root: Element,
  base: string,
  most = ROWS_MOST,
): { row: Element; account: Account; name: string | null }[] {
  const rows = new Map<string, { row: Element; account: Account; name: string | null }>();
  for (const { a, url } of linksIn(root, base)) {
    const account = profileOf(url);
    if (!account || !clean(a.textContent)) continue;
    const key = account.username.toLowerCase();
    if (rows.has(key)) continue;
    let row: Element = a;
    for (let up = a.parentElement; up && up !== root; up = up.parentElement) {
      const others = linksIn(up, base).some(({ url: u }) => {
        const other = profileOf(u);
        return other !== null && other.username.toLowerCase() !== key;
      });
      if (others) break;
      row = up;
    }
    const name =
      leafLines(row).find(
        ({ el, text }) =>
          !el.closest('button, [role="button"]') &&
          text.toLowerCase() !== key &&
          !OWN_WORDS.test(text),
      )?.text ?? null;
    rows.set(key, { row, account, name });
    if (rows.size >= most) break;
  }
  return [...rows.values()];
}

/**
 * The box of followers over an account's page: the one over /<you>/followers/, or over their own account once its
 * count of followers is pressed (the owner's Check, 21 Oct 2026: the counts aren't links to the list now, and the page
 * at /<you>/followers/ showed their account without it), by its heading's own word.
 */
export function followersBox(doc: Document, base: string): Element | null {
  const page = instagramUrl(base);
  const kind = page ? kindOf(page) : null;
  const boxes = [...doc.querySelectorAll('[role="dialog"]')];
  const headed = boxes.find((box) =>
    [...box.querySelectorAll('h1, h2, [role="heading"]')].some((h) =>
      /^followers$/i.test(clean(h.textContent)),
    ),
  );
  if (headed && (kind === 'followers' || kind === 'profile')) return headed;
  return kind === 'followers' ? (boxes[0] ?? null) : null;
}

/**
 * Their own account's count of followers, which opens the box of them over the page when pressed: the link in its
 * header whose words end with Instagram's own "followers". Never "Followed by …" on someone else's account.
 */
export function followersCount(doc: Document): HTMLElement | null {
  const header = mainOf(doc).querySelector('header');
  if (!header) return null;
  return (
    [...header.querySelectorAll<HTMLElement>('a, [role="link"], [role="button"]')].find((el) =>
      /^[\d,.]+\s*[km]?\s*followers$/i.test(clean(el.textContent)),
    ) ?? null
  );
}

/** The person's followers, in the box over their account: each, and whether they follow them back. */
function followersOn(doc: Document, base: string): Follower[] {
  const page = instagramUrl(base);
  if (!page) return [];
  const listOwner = accountOf(page)?.username.toLowerCase();
  const box = followersBox(doc, base);
  if (!box && kindOf(page) !== 'followers') return [];
  const root = box ?? mainOf(doc);
  return rowsIn(root, base, FOLLOWER_ROWS_MOST)
    .filter(({ account }) => account.username.toLowerCase() !== listOwner)
    .map(({ row, account, name }) => {
      const names = controlsIn(row).map((c) => c.name);
      const followBack = names.some((n) => FOLLOW.test(n) || FOLLOW_BACK.test(n))
        ? false
        : names.some((n) => FOLLOWING.test(n) || REQUESTED.test(n) || REMOVE.test(n))
          ? true
          : null;
      return { ...account, name, followBack };
    });
}

// ------------------------------------------------------------------------------------------------ a post's likes

/** The heading over a post's Likes box: Instagram's own word. */
const LIKES_HEADING = /^likes$/i;

/**
 * A post's Likes box over its page (decision 92): the box headed Likes, on the post's own page or at
 * /p/<code>/liked_by/, where Instagram puts it in the address while it's open; at that address, the box over the page
 * when no heading says so. Never a list on the page itself: the post's own writer and commenters are there.
 */
export function likersBox(doc: Document, base: string): Element | null {
  const page = instagramUrl(base);
  const kind = page ? kindOf(page) : null;
  if (kind !== 'post' && kind !== 'likers') return null;
  const boxes = [...doc.querySelectorAll('[role="dialog"]')];
  const headed = boxes.find((box) =>
    [...box.querySelectorAll('h1, h2, h3, [role="heading"]')].some((h) =>
      LIKES_HEADING.test(clean(h.textContent)),
    ),
  );
  return headed ?? (kind === 'likers' ? (boxes[0] ?? null) : null);
}

/**
 * Who liked a post, in its Likes box (decision 92): each account once, by its rows as the followers' box's are, with
 * whether the person follows them by the row's own button. Never the person (`own`).
 */
export function likersOn(doc: Document, base: string, own = ownOf(doc, base)): Liker[] {
  const box = likersBox(doc, base);
  if (!box) return [];
  return rowsIn(box, base)
    .filter(({ account }) => account.username.toLowerCase() !== own?.toLowerCase())
    .map(({ row, account, name }) => ({ ...account, name, following: followingIn(row) }));
}

// ------------------------------------------------------------------------------------------------ a post

/** The post's own part of the page: around its box to comment in, or its Like and Comment, else the main part. */
export function postRootOf(doc: Document): Element {
  const main = mainOf(doc);
  const article = main.querySelector('article');
  return article ?? main;
}

/** Who posted it: its own link names them (/<name>/p/<code>/); else the account beside its More options. */
export function authorOf(root: Element, base: string, code: string): Account | null {
  for (const { url } of linksIn(root, base)) {
    const name = postAuthorOf(url);
    if (name && partsOf(url)[2] === code) return profileOf(new URL(`${HOST}/${name}/`));
  }
  const more = controlsIn(root).find(({ name }) => /^more options$/i.test(name))?.c;
  for (let up = more?.parentElement, steps = 0; up && steps < 4; up = up.parentElement, steps++) {
    const named = linksIn(up, base).find(({ a, url }) => profileOf(url) && clean(a.textContent));
    if (named) return profileOf(named.url);
  }
  return null;
}

/** Its comments: each found by its own link on its time (/p/<code>/c/<id>/), with a Reply beside it. */
function commentsIn(root: Element, base: string): { comments: Comment[]; parts: Element[] } {
  const comments: Comment[] = [];
  const seen = new Set<Element>();
  for (const { a, url } of linksIn(root, base)) {
    if (!isCommentLink(url)) continue;
    // The comment: the nearest part around its time that has its Reply and names who wrote it.
    let at: Element | null = a.parentElement;
    for (let steps = 0; at && steps < 8 && !says(at, REPLY); steps++) at = at.parentElement;
    if (!at || seen.has(at)) continue;
    seen.add(at);
    const by = linksIn(at, base)
      .map(({ a: link, url: u }) => ({ link, account: profileOf(u) }))
      .find(({ link, account }) => account && clean(link.textContent));
    if (!by?.account) continue;
    const said = [...at.querySelectorAll('span[dir="auto"], span')]
      .filter(
        (el) =>
          !el.closest('a, button, [role="button"], time') &&
          !el.querySelector('a, time, span') &&
          clean(el.textContent) &&
          clean(el.textContent).toLowerCase() !== by.account!.username.toLowerCase() &&
          !OWN_WORDS.test(clean(el.textContent)),
      )
      .map((el) => textOf(el))[0];
    comments.push({ ...by.account, text: said ?? '' });
    if (comments.length >= COMMENTS_MOST) break;
  }
  return { comments, parts: [...seen] };
}

/**
 * Its caption: the words beside the time that isn't a link (a comment's is), by who posted it; else the post's own
 * heading, where Instagram has put it.
 */
function captionIn(root: Element, author: Account | null): string | null {
  for (const time of root.querySelectorAll('time')) {
    if (time.closest('a')) continue;
    const line = time.parentElement;
    const next = line?.nextElementSibling ?? line?.parentElement?.nextElementSibling;
    if (!next) continue;
    const by = line?.querySelector('a[href]');
    if (
      author &&
      by &&
      !clean(by.getAttribute('href')).toLowerCase().includes(author.username.toLowerCase())
    )
      continue;
    const text = textOf(next);
    if (text) return text;
  }
  const heading = root.querySelector('h1[dir="auto"], h1');
  return heading ? textOf(heading) || null : null;
}

/** "1,234 likes": a post's count of likes in words, or a comment's by its Reply. */
const LIKES_SAID = /^([\d,.]+\s*[km]?)\s+likes?$/i;

/** Whether a part of a post is in one of its comments: a comment's own likes ("3 likes") sit there, by its Reply. */
function inACommentOf(root: Element, comments: readonly Element[]): (el: Element) => boolean {
  return (el) => {
    if (comments.some((comment) => comment.contains(el))) return true;
    for (let up = el.parentElement, n = 0; up && up !== root && n < 4; up = up.parentElement, n++)
      if (says(up, REPLY)) return true;
    return false;
  };
}

/**
 * The control in a post's bar after its own Like that's its count of likes ("36.5K"), when its likes show: the bar's
 * Comment comes after the count (the owner's Check, 21 Oct 2026: Like, "36.5K", Comment, "1.1K", Share), and straight
 * after the Like when its likes are hidden.
 */
function barCountOf(root: Element): Element | null {
  const controls = controlsIn(root);
  for (const [i, { name }] of controls.entries()) {
    if (!/^like$/i.test(name)) continue;
    const after = controls.slice(i + 1);
    const count = after.findIndex(({ name: n }) => countOf(n) === null);
    if (count < 0 || !/^comment$/i.test(after[count]!.name)) continue;
    return count > 0 ? after[0]!.c : null;
  }
  return null;
}

/** Its likes: "1,234 likes", the number on its Liked by link, "Liked by … and 12 others", or the number beside Like. */
function likesIn(root: Element, base: string, comments: readonly Element[]): number | null {
  // A comment's own likes ("3 likes") sit in the comment, by its Reply: never the post's.
  const inComment = inACommentOf(root, comments);
  for (const { el, text } of leafLines(root)) {
    if (inComment(el)) continue;
    const m = LIKES_SAID.exec(text);
    if (m) return countOf(m[1]);
  }
  for (const { a, url } of linksIn(root, base)) {
    if (!LIKED_BY.test(url.pathname)) continue;
    const words = clean(a.textContent);
    const n = countOf(words.replace(/\s*(likes?|others?)$/i, ''));
    if (n !== null) {
      // "Liked by dana and 12 others": the others, and the one named.
      const named =
        /\bothers?$/i.test(words) && /liked by/i.test(clean(a.parentElement?.textContent));
      return named ? n + 1 : n;
    }
  }
  // The number beside the post's own Like, in its bar: the control after the Like is its count, and the one after that
  // the bar's Comment, where a comment's Like has its Reply or the next comment after it. In page order, however many
  // boxes Instagram wraps around each. With the likes hidden, the Comment comes straight after the Like.
  const count = barCountOf(root);
  return count ? countOf(nameOf(count)) : null;
}

/** The nearest part a person presses around a piece of a post: a control, else the piece itself. */
const pressed = (el: Element): HTMLElement | null => {
  const at = el.closest('a[href], button, [role="button"], [role="link"]') ?? el;
  return at instanceof at.ownerDocument.defaultView!.HTMLElement ? at : null;
};

/**
 * What opens a post's Likes box when pressed, as a person opens it (decision 92): its "12 others" or "1,234 likes"
 * link, which Instagram points at the post's own /p/<code>/liked_by/ (a comment's would be under its own link,
 * /p/<code>/c/<id>/); else its "1,234 likes" in words; else the number beside its own Like in its bar. Never a
 * comment's own likes, by its Reply. Null when its likes show none of these.
 */
export function likesOpenerIn(root: Element, base: string): HTMLElement | null {
  const inComment = inACommentOf(root, commentsIn(root, base).parts);
  const link = linksIn(root, base).find(
    ({ a, url }) => kindOf(url) === 'likers' && clean(a.textContent),
  );
  if (link) return pressed(link.a);
  const said = leafLines(root).find(({ el, text }) => LIKES_SAID.test(text) && !inComment(el));
  if (said) return pressed(said.el);
  const count = barCountOf(root);
  return count ? pressed(count) : null;
}

/**
 * What shows more of a post's comments: "View all 12 comments", "Load more comments", or "4 more comments" under the
 * newer layout's comments (the owner's Check of 21 Oct 2026, its number in a part of its own). Never "View replies".
 */
const MORE_COMMENTS =
  /^(view all( [\d,.]+\s*[km]?)? comments|load more comments|view more comments|[\d,.]+\s*[km]? more comments)$/i;

/**
 * A post's own View all comments (or Load more comments), pressed once to read more of who commented (decision 92):
 * a control saying so, else the smallest part whose words say so, where Instagram draws them as a line to press. Null
 * with none.
 */
export function moreCommentsIn(root: Element): HTMLElement | null {
  const control = controlsIn(root).find(({ name }) => MORE_COMMENTS.test(name));
  if (control) return pressed(control.c);
  const saying = (el: Element) => MORE_COMMENTS.test(clean(el.textContent));
  const said = [...root.querySelectorAll('span, div')].find(
    (el) => saying(el) && ![...el.querySelectorAll('span, div')].some(saying),
  );
  return said ? pressed(said) : null;
}

function postOn(doc: Document, base: string): InstagramPost | null {
  const page = instagramUrl(base);
  if (!page || kindOf(page) !== 'post') return null;
  const url = postOf(page);
  if (!url) return null;
  const code = partsOf(new URL(url))[1]!;
  const root = postRootOf(doc);
  const author = authorOf(root, base, code);
  const { comments, parts } = commentsIn(root, base);
  const placeLink = linksIn(root, base).find(({ url: u }) => LOCATION.test(u.pathname));
  return {
    url,
    author,
    caption: captionIn(root, author),
    likes: likesIn(root, base, parts),
    comments,
    place: placeLink
      ? {
          url: whole(placeLink.url.pathname),
          name: clean(placeLink.a.textContent) || null,
        }
      : null,
  };
}

// ------------------------------------------------------------------------------------------------ hashtags and places

const whole = (path: string) => `${HOST}${path.endsWith('/') ? path : `${path}/`}`;

const postsIn = (doc: Document, base: string): string[] =>
  [
    ...new Set(
      linksIn(mainOf(doc), base)
        .map(({ url }) => postOf(url))
        .filter((p): p is string => p !== null),
    ),
  ].slice(0, ROWS_MOST);

/** A hashtag searched for: Instagram sends a hashtag's page to its search for it (?q=#smallbusiness). */
const TAG_SEARCHED = /^#([^\s#/]{1,100})$/;

/**
 * A hashtag's page, and the search Instagram sends it to now (the owner's Check, 21 Oct 2026: #smallbusiness landed on
 * /explore/search/keyword/?q=, with its posts' grid), read the same: its posts' links. Never a search for words.
 */
function tagOn(doc: Document, base: string): PostsPage | null {
  const page = instagramUrl(base);
  if (!page) return null;
  const kind = kindOf(page);
  const searched =
    kind === 'search' ? TAG_SEARCHED.exec(clean(page.searchParams.get('q')))?.[1] : undefined;
  const name = searched ?? (kind === 'tag' ? decodeURIComponent(partsOf(page)[2] ?? '') : '');
  if (!name) return null;
  return {
    url: whole(`/explore/tags/${encodeURIComponent(name)}/`),
    name,
    posts: postsIn(doc, base),
  };
}

function placeOn(doc: Document, base: string): PostsPage | null {
  const page = instagramUrl(base);
  if (!page || kindOf(page) !== 'place') return null;
  const [, , id, slug] = partsOf(page);
  if (!id || !/^\d+$/.test(id)) return null;
  const heading = clean(mainOf(doc).querySelector('h1')?.textContent);
  return {
    url: whole(`/explore/locations/${id}/${slug ? `${slug}/` : ''}`),
    name: heading || decodeURIComponent(slug ?? '').replace(/-/g, ' ') || id,
    posts: postsIn(doc, base),
  };
}

// ------------------------------------------------------------------------------------------------ notifications

/**
 * Who their notifications say followed them, or liked or commented on their posts: each notification is the part of
 * the page around an account's named link that says what they did; a post it's about links to it. One row a person
 * and kind, newest first.
 */
function engagedOn(doc: Document, base: string): Engaged[] {
  const page = instagramUrl(base);
  if (!page || kindOf(page) !== 'notifications') return [];
  const root = doc.querySelector('[role="dialog"]') ?? mainOf(doc);
  const found = new Map<string, Engaged>();
  // The accounts Instagram suggests under its own heading, each with Follow, are nobody who engaged (the owner's
  // Check, 21 Oct 2026: 30 of them under "Suggested for you", below a month of Meta's own notifications).
  const headings = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')];
  const suggested = (a: Element) =>
    SUGGESTED.test(clean(headings.filter((h) => isBefore(h, a)).at(-1)?.textContent));
  for (const { a, url } of linksIn(root, base)) {
    const account = profileOf(url);
    if (!account || !clean(a.textContent) || suggested(a)) continue;
    for (
      let up = a.parentElement, steps = 0;
      up && up !== root && steps < 6;
      up = up.parentElement, steps++
    ) {
      // Never past the notification: a part that links to someone else holds others' too.
      const others = linksIn(up, base).some(({ url: u }) => {
        const other = profileOf(u);
        return other !== null && other.username.toLowerCase() !== account.username.toLowerCase();
      });
      if (others) break;
      const words = clean(up.textContent);
      const kind = DID.find(([, did]) => did.test(words))?.[0];
      if (!kind) continue;
      // The notification's whole row, its post's picture beside the words: as far up as it's about them alone.
      let row: Element = up;
      for (let n = 0; n < 4 && row.parentElement && row.parentElement !== root; n++) {
        const others = linksIn(row.parentElement, base).some(({ url: u }) => {
          const other = profileOf(u);
          return other !== null && other.username.toLowerCase() !== account.username.toLowerCase();
        });
        if (others) break;
        row = row.parentElement;
      }
      const post =
        linksIn(row, base)
          .map(({ url: u }) => postOf(u))
          .find((p): p is string => p !== null) ?? null;
      const key = `${account.username.toLowerCase()}:${kind}`;
      if (!found.has(key)) found.set(key, { ...account, kind, post, following: followingIn(row) });
      break;
    }
    if (found.size >= ROWS_MOST) break;
  }
  return [...found.values()];
}

// ------------------------------------------------------------------------------------------------ messages

/** Which box the messages show: the tab that's picked, or Requests by its address. */
function boxOn(doc: Document, base: string): Box | null {
  const page = instagramUrl(base);
  if (!page) return null;
  const [first, second] = partsOf(page);
  if (first !== 'direct') return null;
  if (second === 'requests') return 'requests';
  const tab = [...doc.querySelectorAll('[role="tab"]')].find(
    (t) => t.getAttribute('aria-selected') === 'true',
  );
  const words = clean(tab?.textContent).toLowerCase();
  return words === 'primary' || words === 'general' || words === 'requests' ? words : null;
}

/** The chats in the list beside their messages: rows with the other person's name in a `title` and a time. */
export function chatRows(doc: Document, base: string): ChatRow[] {
  const page = instagramUrl(base);
  if (!page || partsOf(page)[0] !== 'direct') return [];
  const rows: ChatRow[] = [];
  for (const row of doc.querySelectorAll('[role="button"], a[href]')) {
    const named = row.querySelector('span[title]');
    // A row is a button, or a link to its chat: never a link to someone's profile (a chat's own header).
    if (
      row.tagName === 'A' &&
      !threadOf(instagramUrl(row.getAttribute('href') ?? '', base) ?? page)
    )
      continue;
    if (
      !named ||
      row.querySelector('[role="button"]') ||
      row.parentElement?.closest('[role="button"]')
    )
      continue;
    const name = clean(named.getAttribute('title')) || clean(named.textContent);
    if (!name) continue;
    const when = clean(row.querySelector('abbr')?.textContent) || null;
    const preview =
      leafLines(row)
        .map((l) => l.text)
        .find((t) => t !== name && t !== when && !/^[·•]$/.test(t) && !OWN_WORDS.test(t)) ?? null;
    const link =
      row.tagName === 'A' ? row : (row.querySelector('a[href]') ?? row.closest('a[href]'));
    const url = link ? instagramUrl(link.getAttribute('href') ?? '', base) : null;
    rows.push({
      name,
      preview,
      yours: preview !== null && /^you(\s*:| sent\b| replied\b| reacted\b)/i.test(preview),
      when,
      thread: url ? threadOf(url) : null,
    });
    if (rows.length >= ROWS_MOST) break;
  }
  return rows;
}

/** Headings, where Instagram says for screen readers whose a message is. */
const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

/** What's never a message's own words: its buttons (a shared post among them), its times, its headings. */
const NOT_WRITTEN = `button, [role="button"], abbr, time, ${HEADINGS}`;

/**
 * A message's own words: what's written in its row, without Instagram's lines around it. An article of the newer
 * layout holds the message alone, so all it says is theirs to say, a line a block (a hashtag's link in a line is part
 * of it), but for a shared post's button.
 */
function messageText(row: Element): string {
  if (row.getAttribute('role') === 'article')
    return textLines(row, 60, NOT_WRITTEN).join('\n').slice(0, TEXT_MOST);
  return leafLines(row)
    .filter(({ el }) => !el.closest(NOT_WRITTEN))
    .map(({ text }) => text)
    .filter((text) => !MINE.test(text) && !THEIRS.test(text) && !NOTICE.test(text))
    .join('\n')
    .slice(0, TEXT_MOST);
}

/** Whether a link leads to their account: /<name>/, or /<name> as a message's picture links it. */
const toThem = (a: Element, them: Account, base: string): boolean =>
  accountLinked(a, base)?.username.toLowerCase() === them.username.toLowerCase();

/**
 * The part of the page around one message that's about it alone: its row, or in Instagram's newer layout the part
 * around its article as far up as it holds no other message, where their picture sits beside the last of theirs.
 */
function aroundMessage(message: Element, messages: readonly Element[]): Element {
  if (message.getAttribute('role') === 'row') return message;
  let part = message;
  for (
    let up = message.parentElement, steps = 0;
    up && steps < 10;
    up = up.parentElement, steps++
  ) {
    if (messages.some((other) => other !== message && up!.contains(other))) break;
    // Never as far as the chat's own header, or its top with View profile, or its box: each links to them too.
    if (up.querySelector('h1, h2, [role="textbox"], [contenteditable="true"]')) break;
    part = up;
  }
  return part;
}

/**
 * The person's and theirs: by what the message says for screen readers ("You sent"), by their picture beside it (a
 * link to them, never beside the person's), else by the side of the conversation it sits on. In Instagram's newer
 * layout (the owner's Check, 21 Oct 2026: each message an article, their picture beside the last of a run of theirs
 * and none beside the person's), a message with none of these is the person's.
 */
function whoseRow(
  row: Element,
  part: Element,
  conversation: Element,
  them: Account | null,
  base: string,
): 'me' | 'them' | null {
  const article = row.getAttribute('role') === 'article';
  for (const { el, text } of leafLines(row)) {
    // An article holds the message itself: only a heading in it is Instagram saying whose it is.
    if (article && !el.closest(HEADINGS)) continue;
    if (MINE.test(text)) return 'me';
    if (THEIRS.test(text)) return 'them';
  }
  for (const el of row.querySelectorAll('[aria-label]')) {
    const label = clean(el.getAttribute('aria-label'));
    if (MINE.test(label)) return 'me';
    if (THEIRS.test(label)) return 'them';
  }
  // Their picture, a link to them, beside the message: never one a post it shares links to inside it.
  if (
    them &&
    linksIn(part, base).some(({ a }) => toThem(a, them, base) && (part === row || !row.contains(a)))
  )
    return 'them';
  try {
    const side = measuredSide(row, conversation);
    if (side) return side === 'right' ? 'me' : 'them';
  } catch {
    // Not drawn: what the page says is all there is.
  }
  return article ? 'me' : null;
}

/** A chat open on its own page: who it's with, its messages, its box, and whether it's a request to Accept. */
export function chatOn(doc: Document, base: string, own: string | null): ChatOpen | null {
  const page = instagramUrl(base);
  if (!page || kindOf(page) !== 'chat') return null;
  const main = mainOf(doc);
  // The list of chats beside it is its own: never the chat's.
  const inList = (el: Element) => el.closest('[role="navigation"]') !== null;
  // Its messages: the conversation's rows, else in Instagram's newer layout its articles (the owner's Check, 0.83.0).
  const labelled = [...main.querySelectorAll('[aria-label]')].find((el) =>
    /^(messages in )?conversation (with|titled)\b/i.test(clean(el.getAttribute('aria-label'))),
  );
  const grid = labelled ?? main.querySelector('[role="grid"]');
  const outer = (selector: string) =>
    [...(grid ?? main).querySelectorAll(selector)].filter(
      (el) => !inList(el) && !el.parentElement?.closest(selector),
    );
  const rows = outer('[role="row"]');
  const messages = rows.length ? rows : outer('[role="article"]');
  // Who it's with: the one account other than the person's own its page links to (its header, View profile, their
  // picture beside their messages), never one a message shares a post of.
  const accounts = new Map<string, Account>();
  for (const { a, url } of linksIn(main, base)) {
    const account = profileOf(url);
    if (!account || inList(a) || a.closest('[role="article"]')) continue;
    if (account.username.toLowerCase() !== own?.toLowerCase())
      accounts.set(account.username.toLowerCase(), account);
  }
  const them = accounts.size === 1 ? [...accounts.values()][0]! : null;
  const toThemNamed = them
    ? linksIn(main, base).filter(({ a }) => !inList(a) && toThem(a, them, base))
    : [];
  const header =
    main.querySelector('header, [role="banner"]') ??
    (toThemNamed.find(({ a }) => a.querySelector('h1, h2')) ?? toThemNamed[0])?.a ??
    null;
  const name =
    clean(header?.querySelector('h1, h2, span[title]')?.textContent) ||
    clean(header?.textContent) ||
    them?.username ||
    null;
  const box = main.querySelector(
    '[role="textbox"], [contenteditable="true"], textarea[placeholder], textarea[aria-label]',
  );
  // Which side a message sits on is against the conversation itself: the part around its messages and its box, never
  // the list of chats beside it.
  const conversation =
    grid ?? closestAround([...messages, ...(box && !inList(box) ? [box] : [])]) ?? main;
  const read: ChatMessage[] = [];
  let last: ChatOpen['last'] = null;
  for (const message of messages) {
    const part = aroundMessage(message, messages);
    const from = whoseRow(message, part, conversation, them, base);
    if (!from) continue;
    last = from;
    const text = messageText(message);
    if (text) read.push({ from, text });
  }
  return {
    thread: threadOf(page),
    with: them,
    name: name && name.length <= 100 ? name : (them?.username ?? null),
    messages: read.slice(-MESSAGES_MOST),
    last,
    box: box !== null,
    request: says(main, ACCEPT),
  };
}

/** The nearest part of the page holding all of these, when there are any. */
function closestAround(elements: readonly Element[]): Element | null {
  const [first, ...rest] = elements;
  for (let up: Element | null = first?.parentElement ?? null; up; up = up.parentElement)
    if (rest.every((el) => up!.contains(el))) return up;
  return null;
}

// ------------------------------------------------------------------------------------------------ who posted

/** The posts on the page whose own links name who posted them: each once, never the person's own. */
function authorsOn(doc: Document, base: string, own: string | null): InstagramFound['authors'] {
  const found = new Map<string, Account>();
  for (const { url } of linksIn(mainOf(doc), base)) {
    const name = postAuthorOf(url);
    const post = name ? postOf(url) : null;
    if (!name || !post || found.has(post) || name.toLowerCase() === own?.toLowerCase()) continue;
    const author = profileOf(new URL(`${HOST}/${name}/`));
    if (author) found.set(post, author);
    if (found.size >= ROWS_MOST) break;
  }
  return [...found].map(([post, author]) => ({ post, author }));
}

// ------------------------------------------------------------------------------------------------ everything

/** The person's own account, by the menu's Profile: never among those a page is about. */
export function ownOf(doc: Document, base: string): string | null {
  for (const { a, url } of linksIn(doc, base)) {
    const words = clean(a.textContent) || clean(a.getAttribute('aria-label'));
    if (!/^profile$/i.test(words)) continue;
    const own = profileOf(url);
    if (own) return own.username;
  }
  return null;
}

export function readInstagram(doc: Document, href: string): InstagramFound {
  const found = {
    locations: new Set<string>(),
    tags: new Set<string>(),
    threads: new Set<string>(),
  };
  for (const { url } of linksIn(doc, href)) {
    const path = url.pathname;
    if (LOCATION.test(path)) found.locations.add(whole(path));
    else if (TAG.test(path)) found.tags.add(whole(path));
    else if (THREAD.test(path)) found.threads.add(whole(path));
  }
  const own = ownOf(doc, href);
  const profile = profileOn(doc, href);
  const post = postOn(doc, href);
  return {
    locations: [...found.locations].slice(0, MOST),
    tags: [...found.tags].slice(0, MOST),
    threads: [...found.threads].slice(0, MOST),
    profile: profile && profile.username.toLowerCase() !== own?.toLowerCase() ? profile : null,
    followers: followersOn(doc, href),
    post,
    likers: likersOn(doc, href, own),
    tag: tagOn(doc, href),
    place: placeOn(doc, href),
    engaged: engagedOn(doc, href).filter((e) => e.username.toLowerCase() !== own?.toLowerCase()),
    chats: chatRows(doc, href),
    box: boxOn(doc, href),
    chat: chatOn(doc, href, own),
    authors: authorsOn(doc, href, own),
  };
}
