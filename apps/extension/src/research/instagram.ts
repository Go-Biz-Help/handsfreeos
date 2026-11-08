/**
 * How AI Social Media Content Creator reads Instagram (docs/socialcontent.md, part 2; ./run.ts): from the answers
 * Instagram's own pages load as they draw, asked for from inside the reading tab on the person's own signed-in
 * account, so it reads what the page reads, at a person's pace, and never from a server (decision 3). Each part here
 * turns one such answer into plain data, and is pure, so the tests hold it to hand-written answers:
 *
 * - **A profile** (/api/v1/users/web_profile_info/): their name, bio, followers, whether the account is private, its
 *   id (for their posts), and when they last posted, from the newest posts its grid starts with (a pinned post can be
 *   old, so it counts only when nothing else is there).
 * - **Their posts** (/api/v1/feed/user/<id>/), 12 at a time, newest first: each one's code, link, when it was posted,
 *   its kind, caption, views (a video's plays), likes, comments and length, and whether it's pinned; and where the next
 *   page starts. A post that hides its likes reads as none, never as 0.
 * - **A search** (/api/v1/web/search/topsearch/) and **a hashtag's top posts** (/api/v1/tags/web_info/): the accounts
 *   they show, by name, in the order shown: a hashtag's top posts' authors first, as they did well in the niche.
 *
 * It looks for what it needs wherever the answer keeps it, so a field Instagram moves within an answer is still found.
 * When it can't be, the read goes to the AI helper and a problem report (./run.ts), as Social Outreach's steps do.
 */
import type { PostIn, PostKind } from '@hfos/core/addons/socialcontent/shapes';

export const INSTAGRAM_HOME = 'https://www.instagram.com';
/** The id Instagram's own web pages send with what they ask for. */
export const INSTAGRAM_APP_ID = '936619743392459';

/** The only answers the reading tab asks Instagram for. */
export const INSTAGRAM_READS =
  /^\/api\/v1\/(users\/web_profile_info\/|feed\/user\/[\w.]+\/|web\/search\/topsearch\/|tags\/web_info\/)\?/;

export const profilePath = (username: string) =>
  `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
export const postsPath = (userId: string, next: string | null = null) =>
  `/api/v1/feed/user/${encodeURIComponent(userId)}/?count=12${next ? `&max_id=${encodeURIComponent(next)}` : ''}`;
export const searchPath = (words: string) =>
  `/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(words)}&include_reel=true`;
export const tagPath = (tag: string) =>
  `/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`;

/** The pages the tab opens, as a person would: someone's profile, and Instagram's search for some words. */
export const profilePage = (username: string) =>
  `${INSTAGRAM_HOME}/${encodeURIComponent(username)}/`;
export const searchPage = (words: string) =>
  `${INSTAGRAM_HOME}/explore/search/keyword/?q=${encodeURIComponent(words)}`;

/** Some search words as a hashtag: "home organizing" is #homeorganizing. Null when nothing's left. */
export function tagOf(words: string): string | null {
  const tag = words
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^\p{L}\p{N}_]/gu, '');
  return tag.length >= 2 && tag.length <= 100 ? tag : null;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null;
const at = (v: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), v);
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null;
/** A moment in seconds since 1970, as Instagram gives it, as ISO; null when it isn't one. */
const moment = (v: unknown): string | null => {
  const s = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof s === 'number' && s > 1_000_000_000 && s < 10_000_000_000
    ? new Date(s * 1000).toISOString()
    : null;
};

/** Everything in an answer, depth first, at most so deep: where a field is kept within it can change. */
function* everyObject(v: unknown, depth = 0): Generator<Json> {
  if (depth > 14) return;
  if (Array.isArray(v)) for (const x of v) yield* everyObject(x, depth + 1);
  else if (isObject(v)) {
    yield v;
    for (const x of Object.values(v)) yield* everyObject(x, depth + 1);
  }
}

// ------------------------------------------------------------------------------------------------ a profile

export interface InstagramCreator {
  readonly id: string | null;
  readonly username: string;
  readonly name: string | null;
  readonly bio: string | null;
  readonly followers: number | null;
  readonly private: boolean;
  /** When they last posted, as far as their grid's first posts say. */
  readonly lastPostAt: string | null;
  /** How many posts they have, as the profile says. */
  readonly posts: number | null;
}

/** The person a profile's answer is about, or null when it doesn't hold one. */
export function creatorFrom(json: unknown): InstagramCreator | null {
  const user =
    at(json, 'data', 'user') ??
    [...everyObject(json)].find((o) => typeof o.username === 'string' && 'biography' in o);
  if (!isObject(user) || typeof user.username !== 'string') return null;
  const media = at(user, 'edge_owner_to_timeline_media');
  const nodes = (Array.isArray(at(media, 'edges')) ? (at(media, 'edges') as unknown[]) : [])
    .map((e) => at(e, 'node'))
    .filter(isObject);
  const pinned = (n: Json) => Array.isArray(n.pinned_for_users) && n.pinned_for_users.length > 0;
  const times = (list: Json[]) =>
    list.map((n) => moment(n.taken_at_timestamp ?? n.taken_at)).filter((t): t is string => !!t);
  const unpinned = times(nodes.filter((n) => !pinned(n)));
  const newest = (unpinned.length ? unpinned : times(nodes)).sort().at(-1) ?? null;
  const id = user.id ?? user.pk;
  return {
    id: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
    username: user.username.toLowerCase(),
    name: text(user.full_name),
    bio: text(user.biography),
    followers: count(at(user, 'edge_followed_by', 'count') ?? user.follower_count),
    private: user.is_private === true,
    lastPostAt: newest,
    posts: count(at(media, 'count') ?? user.media_count),
  };
}

// ------------------------------------------------------------------------------------------------ their posts

/** One page of someone's posts, and where the next starts (null at the end). */
export interface InstagramPostsPage {
  readonly posts: readonly PostIn[];
  readonly next: string | null;
  /** The oldest post's moment on the page, pinned ones aside: how far back it has read. */
  readonly oldest: string | null;
}

const KINDS: Readonly<Record<number, PostKind>> = { 1: 'photo', 2: 'video', 8: 'carousel' };

/** One post as Instagram's list of someone's posts gives it; null when it isn't one. */
export function postFrom(item: unknown): PostIn | null {
  if (!isObject(item)) return null;
  const code = typeof item.code === 'string' ? item.code : null;
  const postedAt = moment(item.taken_at);
  if (!code || !/^[\w-]{5,80}$/.test(code) || !postedAt) return null;
  const kind = KINDS[Number(item.media_type)] ?? 'other';
  const reel = item.product_type === 'clips';
  const hidden = item.like_and_view_counts_disabled === true;
  const video = kind === 'video';
  return {
    postKey: code,
    link: `${INSTAGRAM_HOME}/${reel ? 'reel' : 'p'}/${code}/`,
    postedAt,
    kind,
    caption: text(at(item, 'caption', 'text')),
    views:
      video && !hidden ? count(item.play_count ?? item.ig_play_count ?? item.view_count) : null,
    likes: hidden ? null : count(item.like_count),
    comments: item.comments_disabled === true ? null : count(item.comment_count),
    shares: count(item.reshare_count ?? item.share_count),
    seconds:
      video && typeof item.video_duration === 'number' ? Math.round(item.video_duration) : null,
    pinned:
      (Array.isArray(item.timeline_pinned_user_ids) && item.timeline_pinned_user_ids.length > 0) ||
      item.is_pinned === true,
  };
}

/** A page of someone's posts, or null when the answer isn't one. */
export function postsFrom(json: unknown): InstagramPostsPage | null {
  const items = at(json, 'items');
  if (!Array.isArray(items)) return null;
  const posts = items.map(postFrom).filter((p): p is PostIn => p !== null);
  const next =
    at(json, 'more_available') === true && typeof at(json, 'next_max_id') === 'string'
      ? (at(json, 'next_max_id') as string)
      : null;
  const oldest =
    posts
      .filter((p) => !p.pinned)
      .map((p) => p.postedAt)
      .sort()[0] ?? null;
  return { posts, next, oldest };
}

// ------------------------------------------------------------------------------------------------ a search

/** Someone a search or a hashtag showed. */
export interface InstagramFoundAccount {
  readonly username: string;
  /** Null when the answer doesn't say. */
  readonly private: boolean | null;
}

const USERNAME = /^[a-z0-9._]{1,30}$/;

/**
 * The accounts an answer shows, each once, in the order shown: whoever a post in it is by (`user` or `owner`), and
 * each account a search lists.
 */
export function accountsFrom(json: unknown): InstagramFoundAccount[] {
  const found = new Map<string, InstagramFoundAccount>();
  for (const o of everyObject(json)) {
    for (const who of [o.user, o.owner]) {
      if (!isObject(who) || typeof who.username !== 'string') continue;
      const username = who.username.toLowerCase();
      if (!USERNAME.test(username) || found.has(username)) continue;
      found.set(username, {
        username,
        private: typeof who.is_private === 'boolean' ? who.is_private : null,
      });
    }
  }
  return [...found.values()];
}

// ------------------------------------------------------------------------------------------------ what went wrong

/** What an answer from Instagram says went wrong, sorted for the read. */
export type InstagramTrouble = 'signed_out' | 'warning' | 'not_there' | 'other';

/** Instagram's words when it asks the account to slow down or checks it. */
const SLOW_DOWN =
  /please wait a few minutes|try again later|feedback_required|checkpoint_required|spam|rate limit|challenge_required/i;

/** Sorts a refused answer: its status, and what its body says. */
export function troubleOf(status: number, json: unknown): InstagramTrouble {
  const said = [at(json, 'message'), at(json, 'error_type'), at(json, 'status')]
    .filter((s) => typeof s === 'string')
    .join(' ');
  if (status === 429 || SLOW_DOWN.test(said)) return 'warning';
  if (status === 401 || /login_required|not.?logged.?in|require_login/i.test(said))
    return 'signed_out';
  if (status === 404 || /user not found|not found/i.test(said)) return 'not_there';
  return 'other';
}

/** Instagram's own words in a refused answer, for the network's warning: a short line, never a person's. */
export function troubleWords(json: unknown): string | null {
  const said = text(at(json, 'message'));
  return said && said.length <= 120 ? said : null;
}
