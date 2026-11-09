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
 * - **A video** (/api/v1/media/<number>/info/), for watching a standout (part 4): its file on Instagram's own video
 *   servers, its length and whether it has sound; and when to take frames from it.
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
  /^\/api\/v1\/(users\/web_profile_info\/\?|feed\/user\/[\w.]+\/\?|web\/search\/[\w/]+\/\?|fbsearch\/[\w/]+\/\?|tags\/web_info\/\?|media\/\d{1,25}\/info\/$)/;
/** Search answers the search page loaded itself, asked for again when Instagram's own ones show nobody. */
export const SEARCH_LOADED = /^\/api\/v1\/(fbsearch|web\/search|tags)\/[\w/]+\/\?/;
/** A loaded answer's path with only the names of what it asked ("…/top_serp/?query&count"), for a report. */
export const loadedShown = (path: string): string => {
  const [where, asked = ''] = path.split('?');
  const names = asked
    .split('&')
    .map((part) => part.split('=')[0])
    .filter(Boolean);
  return `${where}${names.length ? `?${names.join('&')}` : ''}`.slice(0, 60);
};
/** Where Instagram keeps its videos: the only other place the reading tab fetches from, to watch a standout. */
export const INSTAGRAM_VIDEO_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/;

export const profilePath = (username: string) =>
  `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
export const postsPath = (userId: string, next: string | null = null) =>
  `/api/v1/feed/user/${encodeURIComponent(userId)}/?count=12${next ? `&max_id=${encodeURIComponent(next)}` : ''}`;
export const searchPath = (words: string) =>
  `/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(words)}&include_reel=true`;
/**
 * The posts Instagram's search page shows for some words or a hashtag (/explore/search/keyword/?q=), as that page asks
 * for them: hashtags' own pages send there now (the owner's Check of 21 Oct 2026), so it's where a hashtag's posts are.
 */
export const serpPath = (words: string) =>
  `/api/v1/fbsearch/web/top_serp/?enable_metadata=true&query=${encodeURIComponent(words)}`;
export const tagPath = (tag: string) =>
  `/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`;
export const mediaInfoPath = (mediaId: string) => `/api/v1/media/${mediaId}/info/`;

const SHORTCODE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/**
 * A post's number, from the code in its link (instagram.com/p/<code>/): the code is the number written in 64 letters.
 * A longer code (a private account's) starts with it. Null when it isn't a code.
 */
export function mediaIdOf(code: string): string | null {
  const head = code.slice(0, 11);
  if (!/^[\w-]{1,11}$/.test(head)) return null;
  let n = 0n;
  for (const ch of head) n = n * 64n + BigInt(SHORTCODE_LETTERS.indexOf(ch));
  return n > 0n ? n.toString() : null;
}

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

// ------------------------------------------------------------------------------------------------ a video

/** A standout video to watch: where its file is, how long it is, and whether it has sound. */
export interface InstagramVideo {
  readonly url: string;
  readonly seconds: number | null;
  readonly sound: boolean;
}

/** The narrowest file this wide or more is enough to see what's on screen, and quick to fetch. */
const VIDEO_WIDTH_AT_LEAST = 480;

/** A post's video, from its media answer (/api/v1/media/<number>/info/); null when the answer has none. */
export function videoOf(json: unknown): InstagramVideo | null {
  const items = at(json, 'items');
  const item = Array.isArray(items) ? items[0] : null;
  if (!isObject(item)) return null;
  const versions = (Array.isArray(item.video_versions) ? item.video_versions : [])
    .filter(isObject)
    .filter((v) => typeof v.url === 'string' && /^https:\/\//.test(v.url))
    .map((v) => ({ url: v.url as string, width: count(v.width) ?? 0 }))
    .filter((v) => {
      try {
        return INSTAGRAM_VIDEO_HOSTS.test(new URL(v.url).hostname);
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.width - b.width);
  const pick = versions.find((v) => v.width >= VIDEO_WIDTH_AT_LEAST) ?? versions.at(-1);
  if (!pick) return null;
  return {
    url: pick.url,
    seconds: typeof item.video_duration === 'number' ? item.video_duration : null,
    sound: item.has_audio !== false,
  };
}

/**
 * When to take frames from a video this long: three in its first seconds (the hook), the rest spread to the end. At
 * most `most`, each before its end.
 */
export function frameTimes(seconds: number, most: number): number[] {
  if (!Number.isFinite(seconds) || seconds <= 0.5) return [0];
  const end = seconds - 0.25;
  const hook = [0.3, 1.2, 2.5].filter((t) => t < end);
  const rest = Math.max(0, most - hook.length);
  const from = Math.min(3.5, end);
  const spread = Array.from({ length: rest }, (_, i) =>
    rest === 1 ? end : from + ((end - from) * i) / (rest - 1),
  );
  return [...new Set([...hook, ...spread].map((t) => Math.round(t * 10) / 10))]
    .filter((t) => t >= 0 && t < seconds)
    .sort((a, b) => a - b)
    .slice(0, most);
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
