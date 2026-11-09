/**
 * How AI Social Media Content Creator reads Facebook and LinkedIn (docs/socialcontent.md, part 6; ./run.ts): by the
 * pages themselves, as a person sees them, with the extension's own readers for each network (src/networks/facebook
 * and src/networks/linkedin, through the tab's `read` hand), scrolling for more as a person does. Neither network
 * gives a page's answers the way Instagram does, so this reads what's drawn.
 *
 * - **Find creators** for a niche: for each of its searches, the network's post search (whose authors did well
 *   there, posting lately), then its people search, gathered in that order, passing over those known. Then up to
 *   `most` profiles are opened and read (name, what they say about themselves, followers) and sent ten at a time;
 *   when a profile doesn't say when they last posted and they have the followers to fit, their latest posts are
 *   looked at too.
 * - **A profile**: their name, what they say about themselves, followers and when they last posted.
 * - **Their posts**, back to `since`: their posts' page (a Facebook profile itself, a LinkedIn member's recent
 *   activity) is read and scrolled until it's past `since`, or nothing new loads. Each post's reactions count as its
 *   likes; neither network shows a post's views to others. A LinkedIn post's time comes from its own number; a
 *   Facebook one's from what it printed ("3h", "March 3 at 2:15 PM").
 *
 * When a page doesn't show what's read, the AI helper looks, then it's read once more when it cleared the way, else
 * reported (./read.ts), as Instagram's reads and Social Outreach's steps are. Watching videos is Instagram's alone.
 * Each read says what it's doing as it goes (`Progress`), as Instagram's do.
 */
import type { ReadKind } from '@hfos/core/addons/socialcontent/helper';
import {
  creatorFromLink,
  creatorLink,
  handleShown,
  networkName,
  type ContentNetwork,
} from '@hfos/core/addons/socialcontent/networks';
import { LIMITS, type FoundCreator, type PostIn } from '@hfos/core/addons/socialcontent/shapes';
import { DONE_WELL } from '@hfos/core/addons/socialcontent/standouts';
import { instantOf } from '../hfos/when';
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

export type PageNetwork = 'facebook' | 'linkedin';

/** Screens scrolled for someone's posts, at most, and how many that bring nothing new before it stops. */
export const POSTS_SCROLLS_MOST = 40;
const NOTHING_NEW_MOST = 3;
/** Screens scrolled on a search for more of its posts. */
const SEARCH_SCROLLS = 2;
const FOUND_EVERY = 10;
const SAVE_EVERY = 48;
const READ_BACK_MS = 365 * 86_400_000;

// ------------------------------------------------------------------------------------------------ what a page shows

/** Someone a page links: their name, and their page's link. */
interface Linked {
  readonly name: string;
  readonly url: string | null;
}

/** A post as a page shows it, by the network's own reader. */
export interface PagePost {
  readonly author: Linked | null;
  readonly url: string | null;
  readonly when: string | null;
  readonly text: string;
  readonly comments: number | null;
  readonly reactions: number | null;
}

/** A profile as its page shows it. */
export interface PageProfile {
  readonly name: string | null;
  readonly bio: string | null;
  readonly followers: number | null;
}

/** What a read of a page found that these reads use. */
export interface PageShown {
  readonly kind: string;
  /** Where the page is, as read. */
  readonly url: string;
  readonly profile: PageProfile | null;
  readonly posts: readonly PagePost[];
  readonly people: readonly Linked[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
const linkedOf = (v: unknown): Linked | null => {
  if (!isObject(v)) return null;
  const name = str(v.name);
  if (!name) return null;
  return { name, url: isObject(v.profile) ? str(v.profile.url) : null };
};

/** A page's read (a Facebook or LinkedIn kit's `readPage`) as these reads use it; null when it isn't one. */
export function shownOf(read: unknown): PageShown | null {
  if (!isObject(read) || typeof read.kind !== 'string') return null;
  const p = isObject(read.profile) ? read.profile : null;
  const bio = p
    ? [str(p.headline), ...(Array.isArray(p.intro) ? p.intro.map(str) : []), str(p.about)]
        .filter((l): l is string => !!l)
        .join(' · ')
        .slice(0, LIMITS.bio) || null
    : null;
  return {
    kind: read.kind,
    url: typeof read.url === 'string' ? read.url : '',
    profile: p ? { name: str(p.name), bio, followers: num(p.followers) } : null,
    posts: (Array.isArray(read.posts) ? read.posts : []).filter(isObject).map((post) => ({
      author: linkedOf(post.author),
      url: str(post.url),
      when: str(post.when),
      text: typeof post.text === 'string' ? post.text : '',
      comments: num(post.comments),
      reactions: num(post.reactions),
    })),
    people: (Array.isArray(read.people) ? read.people : [])
      .map(linkedOf)
      .filter((l): l is Linked => l !== null),
  };
}

// ------------------------------------------------------------------------------------------------ each network's ways

/** A LinkedIn post's number holds when it was posted: its first 41 bits are milliseconds since 1970. */
export function linkedInPostedAt(url: string): string | null {
  const id = /urn:li:(?:activity|share|ugcPost):(\d{15,25})/.exec(decodeURIComponent(url))?.[1];
  if (!id) return null;
  const ms = Number(BigInt(id) >> 22n);
  return ms > Date.UTC(2005, 0, 1) && ms < Date.now() + 86_400_000
    ? new Date(ms).toISOString()
    : null;
}

/** "3h", "2d", "1w", "3mo", "1yr", as LinkedIn says how long ago. */
const LINKEDIN_AGO = /^(\d{1,3})\s?(m|h|d|w|mo|yr|y)\b/i;
const LINKEDIN_AGO_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000,
  yr: 31_536_000_000,
  y: 31_536_000_000,
};

interface PageWays {
  readonly network: PageNetwork;
  /** Where someone's posts are listed, from their page's link; null when it can't read them yet. */
  postsPage(handle: string): string | null;
  /** The searches that find creators: posts first, then people. */
  searchPages(words: string): readonly string[];
  /** A post's key, kept the one way. */
  postKey(url: string): string | null;
  postedAt(post: PagePost, now: Date): string | null;
}

const FACEBOOK: PageWays = {
  network: 'facebook',
  postsPage: (handle) => creatorLink('facebook', handle),
  searchPages: (words) => [
    `https://www.facebook.com/search/posts/?q=${encodeURIComponent(words)}`,
    `https://www.facebook.com/search/pages/?q=${encodeURIComponent(words)}`,
  ],
  postKey(url) {
    try {
      const u = new URL(url);
      const story = u.searchParams.get('story_fbid') ?? u.searchParams.get('fbid');
      const key = `${u.pathname.replace(/\/+$/, '')}${story ? `?${story}` : ''}`;
      return key.length > 1 ? key.slice(0, LIMITS.postKey) : null;
    } catch {
      return null;
    }
  },
  postedAt(post, now) {
    const at = post.when ? instantOf(post.when, now) : null;
    return at && at.getTime() <= now.getTime() + 60_000 ? at.toISOString() : null;
  },
};

const LINKEDIN: PageWays = {
  network: 'linkedin',
  // A member's recent activity; a company page's posts come later.
  postsPage: (handle) =>
    handle.startsWith('in/') ? `${creatorLink('linkedin', handle)}recent-activity/all/` : null,
  searchPages: (words) => [
    `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(words)}`,
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(words)}`,
  ],
  postKey: (url) =>
    /urn:li:((?:activity|share|ugcPost):\d{6,25})/.exec(decodeURIComponent(url))?.[1] ?? null,
  postedAt(post, now) {
    const fromId = post.url ? linkedInPostedAt(post.url) : null;
    if (fromId) return fromId;
    const ago = post.when ? LINKEDIN_AGO.exec(post.when.trim()) : null;
    const unit = ago?.[2]?.toLowerCase();
    return ago && unit
      ? new Date(now.getTime() - Number(ago[1]) * (LINKEDIN_AGO_MS[unit] ?? 0)).toISOString()
      : null;
  },
};

export const PAGE_WAYS: Readonly<Record<PageNetwork, PageWays>> = {
  facebook: FACEBOOK,
  linkedin: LINKEDIN,
};

/** A page's post as one to save; null without a link or a time to weigh it by. */
export function postInOf(ways: PageWays, post: PagePost, now: Date): PostIn | null {
  if (!post.url) return null;
  const postKey = ways.postKey(post.url);
  const postedAt = ways.postedAt(post, now);
  if (!postKey || !postedAt) return null;
  const caption = post.text.replace(/\s+/g, ' ').trim().slice(0, LIMITS.caption) || null;
  return {
    postKey,
    link: post.url.slice(0, LIMITS.link),
    postedAt,
    kind: 'other',
    caption,
    views: null,
    likes: post.reactions,
    comments: post.comments,
    shares: null,
    seconds: null,
    pinned: false,
  };
}

/** Someone's name on a network, from their page's link, the way HandsFreeOS keeps it. */
const handleOf = (network: PageNetwork, url: string | null): string | null =>
  url ? (creatorFromLink(url, network as ContentNetwork)?.handle ?? null) : null;

/** Whether a post on someone's posts page is theirs: by their link, or their name when the post links no one. */
function theirs(
  network: PageNetwork,
  post: PagePost,
  handle: string,
  name: string | null,
): boolean {
  if (!post.author) return true;
  const by = handleOf(network, post.author.url);
  if (by) return by === handle;
  return !name || post.author.name.toLowerCase() === name.toLowerCase();
}

// ------------------------------------------------------------------------------------------------ reading a page

const couldntRead = (network: PageNetwork): ReadEnd => ({
  failure: `${network === 'facebook' ? 'Facebook' : 'LinkedIn'}’s page didn’t show what the extension reads. HandsFreeOS got a report so it can be fixed, and it tries again later.`,
  halt: 'while',
});
const signedOut = (network: PageNetwork): ReadEnd => ({
  failure: `${network === 'facebook' ? 'Facebook' : 'LinkedIn'} asked to sign in on the reading computer. Sign in there in Chrome, then press Read again now.`,
  halt: 'while',
});

/** Whether the page is the network's sign-in (or its check before it). */
const SIGN_IN = /^https:\/\/[^/]+\/(login|checkpoint|uas\/login|authwall|signup)\b/i;

/**
 * The page read, and `parse` of it. When it doesn't have what's read, the helper looks; when it cleared the way the
 * page is read once more, else it's reported.
 */
async function readShown<T>(
  ctx: ReadCtx,
  read: ReadKind,
  parse: (shown: PageShown) => T | null,
  what: string,
  first = true,
): Promise<Got<T>> {
  const network = ctx.work.network as PageNetwork;
  let before: HelperRun | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const step = await answerStep(ctx, first && attempt === 0);
    if (!step.ok) return step;
    const shown = shownOf(await ctx.tab.hands('read'));
    // Sent to sign in: nothing to fix in the reader, and nothing more to read till they do.
    if (shown && SIGN_IN.test(shown.url)) return { ok: false, end: signedOut(network) };
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
      posts: shown?.posts.length ?? 0,
      people: shown?.people.length ?? 0,
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

/** Someone's profile, opened and read: what it says, and when they last posted when its posts show it. */
async function readProfile(
  ctx: ReadCtx,
  handle: string,
  read: ReadKind,
): Promise<Got<PageProfile & { lastPostAt: string | null; posts: readonly PagePost[] }>> {
  const network = ctx.work.network as PageNetwork;
  const opened = await openPage(ctx, creatorLink(network, handle));
  if (!opened.ok) return opened;
  const now = new Date();
  return readShown(
    ctx,
    read,
    (shown) => {
      if (!shown.profile?.name) return null;
      const ways = PAGE_WAYS[network];
      const times = shown.posts
        .filter((p) => theirs(network, p, handle, shown.profile?.name ?? null))
        .map((p) => ways.postedAt(p, now))
        .filter((t): t is string => !!t)
        .sort();
      return { ...shown.profile, lastPostAt: times.at(-1) ?? null, posts: shown.posts };
    },
    'Profile',
  );
}

// ------------------------------------------------------------------------------------------------ the reads

async function find(ctx: ReadCtx): Promise<ReadEnd> {
  const network = ctx.work.network as PageNetwork;
  const ways = PAGE_WAYS[network];
  const { work } = ctx;
  const known = new Set(work.known.map((h) => h.toLowerCase()));
  /** Who was gathered, with when a search showed them posting. */
  const gathered = new Map<string, { lastPostAt: string | null }>();
  /** Everyone the searches showed, known or not, for what it's doing. */
  const looked = new Set<string>();
  const enough = work.most * 2;
  const now = new Date();
  const gather = (url: string | null, lastPostAt: string | null) => {
    const handle = handleOf(network, url);
    if (handle) looked.add(handle);
    if (!handle || known.has(handle)) return;
    const had = gathered.get(handle);
    if (!had) gathered.set(handle, { lastPostAt });
    else if (lastPostAt && (!had.lastPostAt || lastPostAt > had.lastPostAt))
      gathered.set(handle, { lastPostAt });
  };
  const progress = new Progress(ctx);
  const searches = (work.niche?.searches ?? []).slice(0, LIMITS.searchesPerNetwork);
  const searched: string[] = [];
  const name = networkName(network);
  for (const words of searches) {
    if (gathered.size >= enough) break;
    await progress.say({
      now: `Searching ${name} for “${words}”`,
      searches: searches.length,
      searched,
      accounts: looked.size,
    });
    for (const [index, page] of ways.searchPages(words).entries()) {
      const opened = await openPage(ctx, page);
      if (!opened.ok) return opened.end;
      const posts = index === 0;
      for (let screen = 0; screen <= (posts ? SEARCH_SCROLLS : 0); screen++) {
        const got = await readShown(
          ctx,
          'find',
          (shown) => (shown.posts.length || shown.people.length ? shown : null),
          posts ? 'Post search' : 'People search',
          screen === 0,
        );
        if (!got.ok) return got.end;
        for (const p of got.value.posts) gather(p.author?.url ?? null, ways.postedAt(p, now));
        for (const person of got.value.people) gather(person.url, null);
        if (screen < SEARCH_SCROLLS && posts) {
          const more = await scrollOn(ctx);
          if (!more.ok) return more.end;
          if (!more.value) break;
        }
      }
    }
    searched.push(words.slice(0, LIMITS.search));
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
    let lastPostAt = [got.value.lastPostAt, seen.lastPostAt].filter(Boolean).sort().at(-1) ?? null;
    // Big enough to fit, and the profile didn't say when they last posted: a look at their latest posts.
    const postsPage = ways.postsPage(handle);
    if (
      !lastPostAt &&
      postsPage &&
      postsPage !== creatorLink(network, handle) &&
      (got.value.followers ?? 0) >= DONE_WELL.followersAtLeast
    ) {
      const opened = await openPage(ctx, postsPage);
      if (!opened.ok) {
        await send();
        return opened.end;
      }
      const latest = await readShown(ctx, 'find', (shown) => shown, 'Latest posts');
      if (latest.ok)
        lastPostAt =
          latest.value.posts
            .map((p) => ways.postedAt(p, now))
            .filter((t): t is string => !!t)
            .sort()
            .at(-1) ?? null;
    }
    found.push({
      handle,
      name: got.value.name,
      bio: got.value.bio,
      followers: got.value.followers,
      lastPostAt,
    });
    if (found.length >= FOUND_EVERY) await send();
  }
  await send();
  await progress.say({ now: 'Done', searched, accounts: looked.size, profiles: read }, true);
  return { failure: null };
}

/** "@name" or the page's name, as the Creators page shows them. */
const shownAs = (network: PageNetwork, handle: string) =>
  handleShown(network as ContentNetwork, handle);

async function profile(ctx: ReadCtx): Promise<ReadEnd> {
  const creator = ctx.work.creator;
  if (!creator) return { failure: 'That creator isn’t there anymore.' };
  const progress = new Progress(ctx);
  const network = ctx.work.network as PageNetwork;
  await progress.say({ now: `Reading ${shownAs(network, creator.handle)}’s profile` }, true);
  const got = await readProfile(ctx, creator.handle, 'profile');
  if (!got.ok) return got.end;
  await creatorRead(ctx.businessId, creator.id, {
    name: got.value.name,
    bio: got.value.bio,
    followers: got.value.followers,
    lastPostAt: got.value.lastPostAt,
  });
  await progress.say({ now: 'Done', profiles: 1 }, true);
  return { failure: null };
}

async function posts(ctx: ReadCtx): Promise<ReadEnd> {
  const network = ctx.work.network as PageNetwork;
  const ways = PAGE_WAYS[network];
  const creator = ctx.work.creator;
  if (!creator) return { failure: 'That creator isn’t there anymore.' };
  const postsPage = ways.postsPage(creator.handle);
  if (!postsPage)
    return {
      failure: `Reading ${handleShown(network as ContentNetwork, creator.handle)}’s posts comes later: for now it reads LinkedIn members’ posts, not company pages’.`,
    };
  const progress = new Progress(ctx);
  await progress.say({ now: `Reading ${shownAs(network, creator.handle)}’s profile` }, true);
  const profileGot = await readProfile(ctx, creator.handle, 'posts');
  if (!profileGot.ok) return profileGot.end;
  const name = profileGot.value.name;
  await creatorRead(ctx.businessId, creator.id, {
    name,
    bio: profileGot.value.bio,
    followers: profileGot.value.followers,
    lastPostAt: profileGot.value.lastPostAt,
  });
  // On Facebook their posts are on the profile already open; LinkedIn lists them on another page.
  if (postsPage !== creatorLink(network, creator.handle)) {
    const opened = await openPage(ctx, postsPage);
    if (!opened.ok) return opened.end;
  }
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
  await progress.say({
    now: `Reading ${shownAs(network, creator.handle)}’s posts`,
    profiles: 1,
    posts: 0,
  });
  let nothingNew = 0;
  for (let screen = 0; screen < POSTS_SCROLLS_MOST; screen++) {
    const got = await readShown(
      ctx,
      'posts',
      (shown) => shown,
      'Posts',
      screen === 0 && postsPage !== creatorLink(network, creator.handle),
    );
    if (!got.ok) {
      await save();
      await progress.say({ posts: kept }, true);
      return got.end;
    }
    let fresh = 0;
    let oldest: string | null = null;
    for (const p of got.value.posts) {
      if (!theirs(network, p, creator.handle, name)) continue;
      const post = postInOf(ways, p, now);
      if (!post) continue;
      if (!oldest || post.postedAt < oldest) oldest = post.postedAt;
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
    if (oldest && oldest < since) break;
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
  // Nothing at all on a page that should list posts: worth a report, but nothing's wrong to say.
  if (!seen.size)
    await report(ctx, 'posts', 'Posts: none of their posts could be read from the page.', null, {});
  return { failure: null };
}

export const PAGE_READS_BY_KIND = {
  find,
  profile,
  posts,
  watch: async (): Promise<ReadEnd> => ({
    failure: 'Watching videos works on Instagram for now.',
  }),
} as const;
