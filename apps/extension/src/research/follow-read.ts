/**
 * How AI Social Media Content Creator reads Threads and X (decision 41, part 17 in
 * HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md; ./run.ts): by their pages, as a person sees them, with the readers
 * Threads' and X's kits have (src/networks/follows, through the tab's `read` hand, its `found`), scrolling for more as
 * a person does. Like Facebook's and LinkedIn's (./page-read.ts), neither gives a page's answers the way Instagram
 * does, so this reads what's drawn.
 *
 * - **Find creators** for a niche: for each of its searches, the network's top posts for it (whose writers did well
 *   there, posting lately), then on X its people search, gathered in that order, passing over those known and the
 *   person's own account. Then up to `most` profiles are opened and read, and sent ten at a time.
 * - **A profile**: their name, what they say about themselves and their link, their followers, when they last posted,
 *   and their latest posts' likes and replies (how they do for their followers, as Instagram's say).
 * - **Their posts**, back to `since`: their profile, scrolled until the last of their posts on screen is older than
 *   `since`, or nothing new loads. Only their own posts: never one they reposted, nor a reply to someone else. A pinned
 *   post at the top (older than the one under it) is kept as pinned, and never stops it. Each post's likes and replies
 *   as the page shows them; neither page shows a post's views the readers take.
 *
 * When a page doesn't show what's read, the AI helper looks, then it's read once more when it cleared the way, else
 * reported (./read.ts), as the other networks' reads are. Each read says what it's doing as it goes (`Progress`).
 */
import type { ReadKind } from '@hfos/core/addons/socialcontent/helper';
import {
  creatorFromLink,
  creatorLink,
  handleShown,
  networkName,
} from '@hfos/core/addons/socialcontent/networks';
import { PICKING, type RecentPost } from '@hfos/core/addons/socialcontent/picking';
import { LIMITS, type FoundCreator, type PostIn } from '@hfos/core/addons/socialcontent/shapes';
import type { FollowFound, FollowPost, FollowProfile } from '../networks/follows/types';
import { creatorRead, creatorsFound, postsSave } from './hfos';
import {
  answerStep,
  helpWith,
  openPage,
  Progress,
  report,
  type Got,
  type HelperRun,
  type ReadCtx,
  type ReadEnd,
} from './read';

export type FollowNetwork = 'threads' | 'x';

/** Screens scrolled for someone's posts, at most, and how many that bring nothing new before it stops. */
export const FOLLOW_SCROLLS_MOST = 40;
const NOTHING_NEW_MOST = 3;
/** Screens scrolled on a post search for more of its posts. */
const SEARCH_SCROLLS = 2;
const FOUND_EVERY = 10;
const SAVE_EVERY = 48;
const READ_BACK_MS = 365 * 86_400_000;

// ------------------------------------------------------------------------------------------------ what a page shows

/** What a read of a page found that these reads use: its kind and address, and what the kit's readers found. */
export interface FollowShown {
  readonly kind: string;
  readonly url: string;
  readonly found: FollowFound;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null;
const listOf = <T>(v: unknown): T[] => (Array.isArray(v) ? (v.filter(isObject) as T[]) : []);

/** A page's read (Threads' or X's kit's `readPage`, with its `found`) as these reads use it; null when it isn't one. */
export function followShownOf(read: unknown): FollowShown | null {
  if (!isObject(read) || typeof read.kind !== 'string') return null;
  const found = isObject(read.found) ? read.found : {};
  return {
    kind: read.kind,
    url: typeof read.url === 'string' ? read.url : '',
    found: {
      profile: isObject(found.profile) ? (found.profile as unknown as FollowProfile) : null,
      posts: listOf<FollowPost>(found.posts).filter((p) => isObject(p.author)),
      post: null,
      replies: [],
      people: listOf(found.people),
      me: typeof found.me === 'string' ? found.me : null,
    },
  };
}

// ------------------------------------------------------------------------------------------------ each network's ways

interface FollowWays {
  /** The searches that find creators: top posts first, then people where it has a search of its own for them. */
  searchPages(words: string): readonly string[];
  /** A post's key, kept the one way: its number on X, its code on Threads. */
  postKey(url: string): string | null;
}

const words = (w: string) => encodeURIComponent(w);

export const FOLLOW_WAYS: Readonly<Record<FollowNetwork, FollowWays>> = {
  x: {
    // Top, not Latest: whose posts did well there.
    searchPages: (w) => [
      `https://x.com/search?q=${words(w)}&src=typed_query`,
      `https://x.com/search?q=${words(w)}&src=typed_query&f=user`,
    ],
    postKey: (url) => {
      const id = /\/status\/(\d{1,30})(?:[/?#]|$)/.exec(url)?.[1];
      return id ? `status/${id}` : null;
    },
  },
  threads: {
    searchPages: (w) => [`https://www.threads.com/search?q=${words(w)}&serp_type=default`],
    postKey: (url) => {
      const code = /\/post\/([A-Za-z0-9_-]{5,64})(?:[/?#]|$)/.exec(url)?.[1];
      return code ? `post/${code}` : null;
    },
  },
};

/** Whether two usernames are the same account, whatever their case. */
const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Someone's name on a network, from their page's link, the way HandsFreeOS keeps it. */
const handleOf = (network: FollowNetwork, url: string | null | undefined): string | null =>
  url ? (creatorFromLink(url, network)?.handle ?? null) : null;

/** When a post went up, from its time's own date; null when it has none, or it's in the future. */
export function followPostedAt(post: Pick<FollowPost, 'at'>, now: Date): string | null {
  const ms = post.at ? Date.parse(post.at) : NaN;
  return Number.isFinite(ms) && ms <= now.getTime() + 60_000 ? new Date(ms).toISOString() : null;
}

/** Whether a post on someone's profile is theirs: written by them, and not a reply to anyone else. */
export function theirs(post: FollowPost, handle: string): boolean {
  return (
    same(post.author?.username, handle) && (post.replyingTo ?? []).every((to) => same(to, handle))
  );
}

/** A post as one to save; null without a key or a time to weigh it by. */
export function followPostIn(
  network: FollowNetwork,
  post: FollowPost,
  now: Date,
  pinned = false,
): PostIn | null {
  const postKey = post.url ? FOLLOW_WAYS[network].postKey(post.url) : null;
  const postedAt = followPostedAt(post, now);
  if (!postKey || !postedAt) return null;
  return {
    postKey,
    link: post.url.slice(0, LIMITS.link),
    postedAt,
    kind: 'other',
    caption: post.text.replace(/\s+/g, ' ').trim().slice(0, LIMITS.caption) || null,
    views: null,
    likes: post.likes,
    comments: post.replies,
    shares: null,
    seconds: null,
    pinned,
  };
}

/**
 * Someone's own posts on their profile, in page order, as ones to save. The first is pinned when it went up before the
 * one under it: a profile lists the rest newest first.
 */
export function ownPostsOn(
  network: FollowNetwork,
  posts: readonly FollowPost[],
  handle: string,
  now: Date,
  top: boolean,
): PostIn[] {
  const kept = posts
    .filter((p) => theirs(p, handle))
    .map((p) => followPostIn(network, p, now))
    .filter((p): p is PostIn => p !== null);
  const [first, second] = kept;
  if (top && first && second && first.postedAt < second.postedAt)
    kept[0] = { ...first, pinned: true };
  return kept;
}

/** Their latest posts' numbers, as the creator's `recent`. */
const recentOf = (posts: readonly PostIn[]): RecentPost[] =>
  posts.slice(0, PICKING.recentAtMost).map((p) => ({
    likes: p.likes ?? null,
    comments: p.comments ?? null,
    views: null,
    caption: p.caption ?? null,
  }));

// ------------------------------------------------------------------------------------------------ reading a page

const couldntRead = (network: FollowNetwork): ReadEnd => ({
  failure: `${networkName(network)}’s page didn’t show what the extension reads. HandsFreeOS got a report so it can be fixed, and it tries again later.`,
  halt: 'while',
});
const signedOut = (network: FollowNetwork): ReadEnd => ({
  failure: `${networkName(network)} asked to sign in on the reading computer. Sign in there in Chrome, then press Read again now.`,
  halt: 'while',
});

/**
 * The page read, and `parse` of it. When it doesn't have what's read, the helper looks; when it cleared the way the
 * page is read once more, else it's reported.
 */
async function readFound<T>(
  ctx: ReadCtx,
  read: ReadKind,
  parse: (shown: FollowShown) => T | null,
  what: string,
  first = true,
): Promise<Got<T>> {
  const network = ctx.work.network as FollowNetwork;
  let before: HelperRun | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const step = await answerStep(ctx, first && attempt === 0);
    if (!step.ok) return step;
    const shown = followShownOf(await ctx.tab.hands('read'));
    // Sent to sign in: nothing to fix in the reader, and nothing more to read till they do.
    if (shown?.kind === 'login') return { ok: false, end: signedOut(network) };
    const value = shown && shown.kind !== 'other' ? parse(shown) : null;
    if (value !== null) return { ok: true, value };
    const note = shown
      ? `${what}: the page (${shown.kind}) didn’t show what it reads.`
      : `${what}: the reading tab didn’t answer.`;
    const run: HelperRun = before ?? (await helpWith(ctx, read, note));
    if (run.cleared && !before) {
      before = run;
      continue;
    }
    await report(ctx, read, note, run.helper, {
      kind: shown ? [shown.kind] : [],
      posts: shown?.found.posts.length ?? 0,
      people: shown?.found.people.length ?? 0,
      profile: !!shown?.found.profile,
    });
    return {
      ok: false,
      end:
        run.helper.verdict === 'refused' || shown?.kind === 'other'
          ? signedOut(network)
          : couldntRead(network),
    };
  }
  return { ok: false, end: couldntRead(network) };
}

/** One screen further down, at a person's pace. Whether it moved, so there's more to read. */
async function scrollOn(ctx: ReadCtx): Promise<Got<boolean>> {
  const step = await answerStep(ctx, false);
  if (!step.ok) return step;
  const went = await ctx.tab.hands('scroll');
  return { ok: true, value: Boolean(went?.moved) };
}

/** What a profile says, as kept: its name, what it says about them with its link, and its followers. */
type ProfileRead = Pick<FoundCreator, 'name' | 'bio' | 'followers' | 'lastPostAt'> & {
  readonly recent: RecentPost[];
};

/** Someone's profile, opened and read: what it says, and when they last posted from the posts it shows. */
async function readProfile(
  ctx: ReadCtx,
  handle: string,
  read: ReadKind,
): Promise<Got<ProfileRead>> {
  const network = ctx.work.network as FollowNetwork;
  const opened = await openPage(ctx, creatorLink(network, handle));
  if (!opened.ok) return opened;
  const now = new Date();
  return readFound(
    ctx,
    read,
    (shown) => {
      const p = shown.found.profile;
      if (!p) return null;
      const posts = ownPostsOn(network, shown.found.posts, handle, now, true);
      const bio =
        [p.bio, ...(p.links ?? [])]
          .filter((l): l is string => !!l?.trim())
          .join(' · ')
          .slice(0, LIMITS.bio) || null;
      return {
        name: p.name?.trim() ? p.name.trim().slice(0, LIMITS.name) : null,
        bio,
        followers: typeof p.followers === 'number' ? p.followers : null,
        lastPostAt:
          posts
            .map((x) => x.postedAt)
            .sort()
            .at(-1) ?? null,
        recent: recentOf(posts.filter((x) => !x.pinned)),
      };
    },
    'Profile',
  );
}

// ------------------------------------------------------------------------------------------------ the reads

async function find(ctx: ReadCtx): Promise<ReadEnd> {
  const network = ctx.work.network as FollowNetwork;
  const ways = FOLLOW_WAYS[network];
  const { work } = ctx;
  const known = new Set(work.known.map((h) => h.toLowerCase()));
  /** Who was gathered, with when a search showed them posting. */
  const gathered = new Map<string, { lastPostAt: string | null }>();
  /** Everyone the searches showed, known or not, for what it's doing. */
  const looked = new Set<string>();
  let me: string | null = null;
  const enough = work.most * 2;
  const now = new Date();
  const gather = (url: string | null | undefined, lastPostAt: string | null) => {
    const handle = handleOf(network, url);
    if (!handle || same(handle, me)) return;
    looked.add(handle);
    if (known.has(handle)) return;
    const had = gathered.get(handle);
    if (!had) gathered.set(handle, { lastPostAt });
    else if (lastPostAt && (!had.lastPostAt || lastPostAt > had.lastPostAt))
      gathered.set(handle, { lastPostAt });
  };
  const progress = new Progress(ctx);
  const searches = (work.niche?.searches ?? []).slice(0, LIMITS.searchesPerNetwork);
  const searched: string[] = [];
  const name = networkName(network);
  for (const said of searches) {
    if (gathered.size >= enough) break;
    await progress.say({
      now: `Searching ${name} for “${said}”`,
      searches: searches.length,
      searched,
      accounts: looked.size,
    });
    for (const [index, page] of ways.searchPages(said).entries()) {
      const opened = await openPage(ctx, page);
      if (!opened.ok) return opened.end;
      const posts = index === 0;
      for (let screen = 0; screen <= (posts ? SEARCH_SCROLLS : 0); screen++) {
        const got = await readFound(
          ctx,
          'find',
          (shown) => (shown.found.posts.length || shown.found.people.length ? shown : null),
          posts ? 'Post search' : 'People search',
          screen === 0,
        );
        if (!got.ok) return got.end;
        me ??= got.value.found.me;
        for (const p of got.value.found.posts) gather(p.author.url, followPostedAt(p, now));
        for (const person of got.value.found.people) gather(person.url, null);
        if (screen < SEARCH_SCROLLS && posts) {
          const more = await scrollOn(ctx);
          if (!more.ok) return more.end;
          if (!more.value) break;
        }
      }
    }
    searched.push(said.slice(0, LIMITS.search));
    await progress.say({ searched, accounts: looked.size });
  }

  let found: FoundCreator[] = [];
  const send = async () => {
    if (!found.length) return;
    await creatorsFound(ctx.businessId, work.id, found.slice(0, LIMITS.foundPerSave));
    found = [];
  };
  const toRead = Math.min(work.most, gathered.size);
  let read = 0;
  for (const [handle, seen] of gathered) {
    if (read >= work.most) break;
    await progress.say({ now: `Reading profiles: ${read + 1} of ${toRead}`, profiles: read });
    const got = await readProfile(ctx, handle, 'find');
    if (!got.ok) {
      await send();
      await progress.say({ profiles: read }, true);
      return got.end;
    }
    read++;
    found.push({
      handle,
      name: got.value.name,
      bio: got.value.bio,
      followers: got.value.followers,
      lastPostAt:
        [got.value.lastPostAt, seen.lastPostAt]
          .filter((t): t is string => !!t)
          .sort()
          .at(-1) ?? null,
      recent: got.value.recent.length ? got.value.recent : null,
    });
    if (found.length >= FOUND_EVERY) await send();
  }
  await send();
  await progress.say({ now: 'Done', searched, accounts: looked.size, profiles: read }, true);
  return { failure: null };
}

async function profile(ctx: ReadCtx): Promise<ReadEnd> {
  const creator = ctx.work.creator;
  if (!creator) return { failure: 'That creator isn’t there anymore.' };
  const network = ctx.work.network as FollowNetwork;
  const progress = new Progress(ctx);
  await progress.say({ now: `Reading ${handleShown(network, creator.handle)}’s profile` }, true);
  const got = await readProfile(ctx, creator.handle, 'profile');
  if (!got.ok) return got.end;
  await creatorRead(ctx.businessId, creator.id, {
    name: got.value.name,
    bio: got.value.bio,
    followers: got.value.followers,
    lastPostAt: got.value.lastPostAt,
    recent: got.value.recent.length ? got.value.recent : null,
  });
  await progress.say({ now: 'Done', profiles: 1 }, true);
  return { failure: null };
}

async function posts(ctx: ReadCtx): Promise<ReadEnd> {
  const network = ctx.work.network as FollowNetwork;
  const creator = ctx.work.creator;
  if (!creator) return { failure: 'That creator isn’t there anymore.' };
  const shownAs = handleShown(network, creator.handle);
  const progress = new Progress(ctx);
  await progress.say({ now: `Reading ${shownAs}’s profile` }, true);
  const profileGot = await readProfile(ctx, creator.handle, 'posts');
  if (!profileGot.ok) return profileGot.end;
  await creatorRead(ctx.businessId, creator.id, {
    name: profileGot.value.name,
    bio: profileGot.value.bio,
    followers: profileGot.value.followers,
    lastPostAt: profileGot.value.lastPostAt,
    recent: profileGot.value.recent.length ? profileGot.value.recent : null,
  });
  // Their posts are on the profile already open.
  const since = ctx.work.since ?? new Date(Date.now() - READ_BACK_MS).toISOString();
  const now = new Date();
  const seen = new Set<string>();
  let waiting: PostIn[] = [];
  const save = async () => {
    for (let i = 0; i < waiting.length; i += LIMITS.postsPerSave)
      await postsSave(ctx.businessId, creator.id, waiting.slice(i, i + LIMITS.postsPerSave));
    waiting = [];
  };
  let kept = 0;
  await progress.say({ now: `Reading ${shownAs}’s posts`, profiles: 1, posts: 0 });
  let nothingNew = 0;
  for (let screen = 0; screen < FOLLOW_SCROLLS_MOST; screen++) {
    const got = await readFound(ctx, 'posts', (shown) => shown, 'Posts', false);
    if (!got.ok) {
      await save();
      await progress.say({ posts: kept }, true);
      return got.end;
    }
    const own = ownPostsOn(network, got.value.found.posts, creator.handle, now, screen === 0);
    let fresh = 0;
    for (const post of own) {
      if (seen.has(post.postKey)) continue;
      seen.add(post.postKey);
      fresh++;
      if (post.postedAt >= since) {
        waiting.push(post);
        kept++;
      }
    }
    if (waiting.length >= SAVE_EVERY) await save();
    await progress.say({ posts: kept });
    // The last of theirs on screen is past `since`: everything under it is older still. A pinned one never stops it.
    const last = own.filter((p) => !p.pinned).at(-1);
    if (last && last.postedAt < since) break;
    nothingNew = fresh ? 0 : nothingNew + 1;
    if (nothingNew >= NOTHING_NEW_MOST) break;
    const more = await scrollOn(ctx);
    if (!more.ok) {
      await save();
      await progress.say({ posts: kept }, true);
      return more.end;
    }
    if (!more.value && !fresh) break;
  }
  await save();
  await progress.say({ now: 'Done', posts: kept }, true);
  // Nothing at all on a profile that should list posts: worth a report, but nothing's wrong to say.
  if (!seen.size)
    await report(ctx, 'posts', 'Posts: none of their posts could be read from the page.', null, {});
  return { failure: null };
}

export const FOLLOW_READS_BY_KIND = {
  find,
  profile,
  posts,
  watch: async (): Promise<ReadEnd> => ({
    failure: 'Watching videos works on Instagram for now.',
  }),
} as const;
