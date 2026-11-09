/**
 * AI Social Media Content Creator's work on Instagram (docs/socialcontent.md, part 2; ./run.ts), in its reading tab,
 * from the answers Instagram's own pages load (./instagram.ts):
 *
 * - **Find creators** for a niche: for each of its searches, Instagram's search page is opened as a person would, and
 *   the accounts behind the posts it shows (its own answer; a hashtag's page sends there now), behind the hashtag's
 *   top posts (#homeorganizing for "home organizing"), and whose names match the words are gathered, in that order, as
 *   the posts did well there. When none of those answers has anyone new, what the page holds itself is read: the
 *   accounts in the data it came with, then the search answers it loaded, asked for again; then who posted the posts
 *   it links, brought in front and scrolled for its grid to draw when it must, which only happens while the person is
 *   away (decision 120). Those already known and private accounts are passed over. Then up to `most` profiles are
 *   opened and read, and sent to HandsFreeOS ten at a time, which sorts who fits (5,000+ followers, a post in the last
 *   30 days). When not one search showed anyone, it's reported with what the page loaded, and the search says so
 *   rather than finishing with nobody.
 *
 * Each read says what it's doing as it goes (`Progress`): the words it's searching, the searches done, the accounts
 * the searches showed, and the profiles and posts it read, for the Creators page.
 * - **A profile:** their name, bio, followers and when they last posted.
 * - **Their posts,** back to `since` (12 months the first time; a week's re-read goes back 60 days past the last
 *   read, as numbers still grow): their profile is opened, and their posts asked for 12 at a time, newest first, saved
 *   as it goes. Where it got to is kept, so a read cut off (Chrome closed, the day's room used) goes on from there.
 *
 * - **Watch a standout video** (part 4, decision 9, only once an owner tries it or turns it on): its post is opened,
 *   its video asked for, and a few frames and its sound taken from it in the tab (./watch.ts), then sent to the worker,
 *   where the AI looks and listens.
 *
 * Every answer that doesn't come goes to the AI helper, then once more when it cleared the way, then the problem
 * report (./read.ts). Nothing is pressed but what the helper clears.
 */
import type { ReadKind } from '@hfos/core/addons/socialcontent/helper';
import type { FoundCreator, PostIn } from '@hfos/core/addons/socialcontent/shapes';
import { LIMITS } from '@hfos/core/addons/socialcontent/shapes';
import { NotAway } from '../away';
import { creatorRead, creatorsFound, postsSave, watchSend } from './hfos';
import {
  accountsFrom,
  INSTAGRAM_READS,
  loadedShown,
  creatorFrom,
  mediaIdOf,
  mediaInfoPath,
  postsFrom,
  postsPath,
  profilePage,
  profilePath,
  SEARCH_LOADED,
  searchPage,
  searchPath,
  serpPath,
  tagOf,
  tagPath,
  troubleOf,
  troubleWords,
  videoOf,
  type InstagramCreator,
  type InstagramFoundAccount,
} from './instagram';
import {
  answerStep,
  helpWith,
  openPage,
  paced,
  pause,
  Progress,
  report,
  RESEARCH_PACE,
  warned,
  type Got,
  type HelperRun,
  type ReadCtx,
  type ReadEnd,
} from './read';

/** Pages of someone's posts read in one go, at most: 12 each, so years of daily posts. */
export const POSTS_PAGES_MOST = 60;
/** How many of their posts wait before they're saved. */
const SAVE_EVERY = 48;
/** How many found creators wait before they're sent. */
const FOUND_EVERY = 10;
/** Where a read of someone's posts got to, so it goes on from there. */
const CURSOR_KEY = 'hfos-research-cursor';
const READ_BACK_MS = 365 * 86_400_000;

const signedOut = (): ReadEnd => ({
  failure:
    'Instagram asked to sign in on the reading computer. Sign in to Instagram in Chrome there, then press Read again now.',
  halt: 'while',
});
const couldntRead = (): ReadEnd => ({
  failure:
    'Instagram’s page didn’t show what the extension reads. HandsFreeOS got a report so it can be fixed, and it tries again later.',
  halt: 'while',
});

/** The names an answer keeps its parts under (Instagram's own, never anyone's), for a report. */
const partsOf = (json: unknown): string[] =>
  typeof json === 'object' && json !== null
    ? Object.keys(json)
        .slice(0, 8)
        .map((k) => k.slice(0, 40))
    : [];

/**
 * One of Instagram's answers, read by `parse`. When it doesn't come: a warning stops Instagram for the day; "not
 * there" is said back; anything else has the helper look, and when it cleared the way it's asked once more, else
 * reported.
 */
async function answer<T>(
  ctx: ReadCtx,
  read: ReadKind,
  path: string,
  parse: (json: unknown) => T | null,
  what: string,
  first = true,
): Promise<Got<T>> {
  let before: HelperRun | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const step = await answerStep(ctx, first && attempt === 0);
    if (!step.ok) return step;
    const got = await ctx.tab.hands('get', path);
    let note: string;
    let found: Record<string, number | boolean | string[]> = {};
    let trouble: ReturnType<typeof troubleOf> = 'other';
    if (got?.ok) {
      const value = parse(got.json);
      if (value !== null) return { ok: true, value };
      note = `${what}: Instagram’s answer didn’t have what it reads.`;
      found = { status: got.status, answerParts: partsOf(got.json) };
    } else if (!got) {
      note = `${what}: the reading tab didn’t answer.`;
    } else {
      trouble = troubleOf(got.status, got.json);
      note = `${what}: Instagram answered ${got.status || 'nothing'}${got.error ? ` (${got.error.slice(0, 80)})` : ''}.`;
      found = { status: got.status, answerParts: partsOf(got.json) };
    }
    if (trouble === 'warning')
      return {
        ok: false,
        end: await warned(ctx, [
          troubleWords(got?.json) ?? 'Please wait a few minutes before you try again.',
        ]),
      };
    if (trouble === 'not_there')
      return {
        ok: false,
        end: { failure: null },
        gone: true,
        why: [
          String(got?.status ?? 0),
          troubleWords(got?.json)?.slice(0, 80),
          partsOf(got?.json).join(',') || null,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    // Once the helper cleared the way and it still didn't come, it's reported with what the helper did.
    const run: HelperRun = before ?? (await helpWith(ctx, read, note));
    if (run.cleared && !before) {
      before = run;
      continue;
    }
    await report(ctx, read, note, run.helper, found);
    return {
      ok: false,
      end:
        trouble === 'signed_out' || run.helper.verdict === 'refused' ? signedOut() : couldntRead(),
    };
  }
  return { ok: false, end: couldntRead() };
}

/** Someone's profile as read: from Instagram's answer, or from their page when the answer said "not there". */
interface ReadCreator {
  readonly creator: InstagramCreator;
  /** Read from their page: with the posts it holds. */
  readonly page: { readonly posts: readonly PostIn[] } | null;
}

/**
 * Someone's profile, opened and read: Instagram's answer, or, when it says they aren't there, what their page itself
 * holds (the data it came with, and its description). `gone` only when neither has them.
 */
async function readCreator(
  ctx: ReadCtx,
  username: string,
  read: ReadKind,
): Promise<Got<ReadCreator>> {
  const opened = await openPage(ctx, profilePage(username));
  if (!opened.ok) return opened;
  const got = await answer(ctx, read, profilePath(username), creatorFrom, 'Profile');
  if (got.ok) return { ok: true, value: { creator: got.value, page: null } };
  if (!got.gone) return got;
  const held = await ctx.tab.hands('profileHeld', username);
  if (!held?.creator) return got;
  return { ok: true, value: { creator: held.creator, page: { posts: held.posts } } };
}

const shown = (handle: string) => `@${handle.replace(/^@/, '')}`;

// ------------------------------------------------------------------------------------------------ find creators

async function find(ctx: ReadCtx): Promise<ReadEnd> {
  const { work } = ctx;
  const known = new Set(work.known.map((h) => h.toLowerCase()));
  const gathered = new Map<string, InstagramFoundAccount>();
  /** Every account the searches showed, known or not, for what it's doing. */
  const looked = new Set<string>();
  const enough = work.most * 2;
  const searches = (work.niche?.searches ?? []).slice(0, LIMITS.searchesPerNetwork);
  const progress = new Progress(ctx);
  const searched: string[] = [];
  // What each place gave, for the report when no search showed anyone.
  const seen = {
    searched: 0,
    posts: 0,
    hashtag: 0,
    accounts: 0,
    held: 0,
    loadedAsked: 0,
    loadedShowed: 0,
    grid: 0,
    notThere: 0,
  };
  const loadedSeen = new Set<string>();
  let notAway = false;
  const take = (accounts: readonly InstagramFoundAccount[]): number => {
    let added = 0;
    for (const account of accounts) {
      looked.add(account.username);
      if (
        !known.has(account.username) &&
        account.private !== true &&
        !gathered.has(account.username)
      ) {
        gathered.set(account.username, account);
        added++;
      }
    }
    return added;
  };
  for (const words of searches) {
    if (gathered.size >= enough) break;
    await progress.say({
      now: `Searching Instagram for “${words}”`,
      searches: searches.length,
      searched,
      accounts: looked.size,
    });
    const opened = await openPage(ctx, searchPage(words));
    if (!opened.ok) return opened.end;
    seen.searched++;
    // The posts the search page shows (a hashtag's too: its own page sends there now), the hashtag's answer as it
    // was, and the accounts whose names match the words (Instagram's account search finds none for "#…").
    const asks: [
      string,
      (json: unknown) => InstagramFoundAccount[] | null,
      string,
      keyof typeof seen,
    ][] = [[serpPath(words), objectAccounts, 'Search page’s posts', 'posts']];
    const tag = tagOf(words);
    if (tag)
      asks.push([
        tagPath(tag),
        (json) =>
          typeof json === 'object' && json !== null && 'data' in json ? accountsFrom(json) : null,
        'Hashtag',
        'hashtag',
      ]);
    const named = words.replace(/^#/, '').trim();
    if (named.length >= 2)
      asks.push([
        searchPath(named),
        (json) =>
          typeof json === 'object' &&
          json !== null &&
          Array.isArray((json as { users?: unknown }).users)
            ? accountsFrom(json)
            : null,
        'Search',
        'accounts',
      ]);
    let here = 0;
    for (const [index, [path, parse, what, place]] of asks.entries()) {
      const got = await answer(ctx, 'find', path, parse, what, index === 0);
      if (!got.ok) {
        if (got.gone) {
          seen.notThere++;
          continue;
        }
        return got.end;
      }
      seen[place] += got.value.length;
      here += take(got.value);
    }
    if (!here) {
      // None of the answers had anyone new: what the page itself holds and loaded, then who posted what it shows.
      const page = await pageAccounts(ctx, new Set(asks.map(([path]) => path)), seen, loadedSeen);
      if (!page.ok) return page.end;
      here += take(page.value.accounts);
      if (!here) {
        const grid = await gridAuthors(ctx, page.value.posts);
        if (!grid.ok) return grid.end;
        if (grid.value.notAway) notAway = true;
        seen.grid += grid.value.accounts.length;
        take(grid.value.accounts);
      }
    }
    searched.push(words.slice(0, LIMITS.search));
    await progress.say({ searched, accounts: looked.size });
  }

  // Not one search showed anyone: Instagram has changed what its search answers, so it's reported to be fixed.
  if (searches.length && !gathered.size && !looked.size) {
    await progress.say({ now: 'Instagram’s search showed nobody', searched, accounts: 0 }, true);
    await report(
      ctx,
      'find',
      `Find: none of the ${seen.searched} searches on Instagram showed anyone.`,
      null,
      {
        ...seen,
        notAway,
        loaded: [...loadedSeen].slice(0, 20),
      },
    );
    return {
      failure: notAway
        ? 'Instagram showed nobody for this niche’s searches. Its search page shows posts only on screen, which the extension uses only while you’re away from the computer, so press Find creators again before you step away. HandsFreeOS got a report too.'
        : 'Instagram’s search showed nobody for this niche’s searches. HandsFreeOS got a report so it can be fixed. Meanwhile, add creators you know with Add a creator.',
    };
  }

  let found: FoundCreator[] = [];
  const send = async () => {
    if (!found.length) return;
    await creatorsFound(ctx.businessId, work.id, found.slice(0, LIMITS.foundPerSave));
    found = [];
  };
  const toRead = Math.min(work.most, gathered.size);
  let read = 0;
  /** Profiles Instagram wouldn't open, what it answered for the first, and those read from their page. */
  let notOpened = 0;
  let notOpenedWhy = '';
  let fromPage = 0;
  for (const account of gathered.values()) {
    if (read >= work.most) break;
    await progress.say({
      now: `Reading profiles: ${read + notOpened + 1} of ${toRead}`,
      profiles: read,
      ...(notOpened ? { notOpened } : {}),
    });
    const got = await readCreator(ctx, account.username, 'find');
    if (!got.ok) {
      if (got.gone) {
        notOpened++;
        notOpenedWhy ||= got.why ?? '';
        continue;
      }
      await send();
      await progress.say({ profiles: read, ...(notOpened ? { notOpened } : {}) }, true);
      return got.end;
    }
    read++;
    if (got.value.page) fromPage++;
    const c = got.value.creator;
    if (c.private) continue;
    found.push({
      handle: c.username,
      name: c.name,
      bio: c.bio,
      followers: c.followers,
      lastPostAt: c.lastPostAt,
    });
    if (found.length >= FOUND_EVERY) await send();
  }
  await send();
  const tally = {
    searched,
    accounts: looked.size,
    profiles: read,
    ...(notOpened ? { notOpened } : {}),
  };
  // Profiles Instagram wouldn't open: reported, with what it answered and what the searches gave, so it can be fixed.
  if (notOpened && notOpened >= read)
    await report(
      ctx,
      'find',
      `Find: Instagram wouldn’t open ${notOpened} of the ${read + notOpened} profiles the searches showed (it answered ${notOpenedWhy || 'nothing'}).`,
      null,
      {
        ...seen,
        notAway,
        profilesRead: read,
        notOpened,
        fromPage,
        loaded: [...loadedSeen].slice(0, 20),
      },
    );
  if (!read && notOpened) {
    await progress.say({ now: 'Instagram wouldn’t open their profiles', ...tally }, true);
    return {
      failure: `Instagram wouldn’t open any of the ${notOpened} profiles its searches showed, so nobody could be suggested. HandsFreeOS got a report so it can be fixed. Meanwhile, add creators you know with Add a creator.`,
    };
  }
  await progress.say({ now: 'Done', ...tally }, true);
  return { failure: null };
}

/** The accounts in an answer that's an object at all. */
const objectAccounts = (json: unknown): InstagramFoundAccount[] | null =>
  typeof json === 'object' && json !== null ? accountsFrom(json) : null;

/** Loaded search answers asked for again on one search page, at most. */
export const LOADED_ASKS_MOST = 2;

/**
 * What the search page itself holds (the accounts in the data it came with), then the search answers it loaded that
 * weren't asked for already, asked for again as the page did. Its post links come back too, for `gridAuthors`.
 */
async function pageAccounts(
  ctx: ReadCtx,
  asked: ReadonlySet<string>,
  seen: { held: number; loadedAsked: number; loadedShowed: number; notThere: number },
  loadedSeen: Set<string>,
): Promise<Got<{ accounts: InstagramFoundAccount[]; posts: readonly string[] }>> {
  const held = await ctx.tab.hands('held');
  const accounts = [...(held?.accounts ?? [])];
  seen.held += accounts.length;
  for (const path of held?.loaded ?? []) loadedSeen.add(loadedShown(path));
  const again = (held?.loaded ?? [])
    .filter((path) => SEARCH_LOADED.test(path) && INSTAGRAM_READS.test(path) && !asked.has(path))
    .slice(0, LOADED_ASKS_MOST);
  for (const path of again) {
    seen.loadedAsked++;
    const got = await answer(ctx, 'find', path, objectAccounts, 'Search page’s own answer', false);
    if (!got.ok) {
      if (got.gone) {
        seen.notThere++;
        continue;
      }
      return got;
    }
    seen.loadedShowed += got.value.length;
    accounts.push(...got.value);
  }
  return { ok: true, value: { accounts, posts: held?.posts ?? [] } };
}

/** Posts of the search page's grid whose author is asked for. */
export const GRID_POSTS_MOST = 6;
/** Screens the search page is scrolled, in front, for its grid to draw. */
export const GRID_SCROLLS = 3;

/**
 * Who posted the posts the search page shows, for a few of them: the account each one's answer names. The page draws
 * its grid only on screen, so when its links aren't there yet it's brought in front and scrolled, which happens only
 * while the person is away (`notAway` when they weren't).
 */
async function gridAuthors(
  ctx: ReadCtx,
  linked: readonly string[],
): Promise<Got<{ accounts: InstagramFoundAccount[]; notAway: boolean }>> {
  let posts = [...linked];
  let notAway = false;
  if (!posts.length) {
    try {
      posts = await ctx.tab.inFront(async () => {
        const codes = new Set<string>();
        for (let screen = 0; screen <= GRID_SCROLLS && codes.size < GRID_POSTS_MOST; screen++) {
          if (screen) {
            await pause(paced(RESEARCH_PACE.answerMs));
            const moved = await ctx.tab.hands('scroll');
            if (!moved?.moved) break;
          } else await pause(RESEARCH_PACE.settleMs);
          for (const code of (await ctx.tab.hands('held'))?.posts ?? []) codes.add(code);
        }
        return [...codes];
      });
    } catch (error) {
      if (!(error instanceof NotAway)) throw error;
      notAway = true;
    }
  }
  const accounts: InstagramFoundAccount[] = [];
  for (const code of posts.slice(0, GRID_POSTS_MOST)) {
    const id = mediaIdOf(code);
    if (!id) continue;
    const got = await answer(
      ctx,
      'find',
      mediaInfoPath(id),
      (json) =>
        typeof json === 'object' && json !== null && 'items' in json ? accountsFrom(json) : null,
      'Post',
      false,
    );
    if (!got.ok) {
      if (got.gone) continue;
      return got;
    }
    accounts.push(...got.value);
  }
  return { ok: true, value: { accounts, notAway } };
}

// ------------------------------------------------------------------------------------------------ a profile

async function profile(ctx: ReadCtx): Promise<ReadEnd> {
  const creator = ctx.work.creator;
  if (!creator) return { failure: 'That creator isn’t there anymore.' };
  const progress = new Progress(ctx);
  await progress.say({ now: `Reading ${shown(creator.handle)}’s profile` }, true);
  const got = await readCreator(ctx, creator.handle, 'profile');
  if (!got.ok)
    return got.gone ? await notOpenedEnd(ctx, 'profile', creator.handle, got.why) : got.end;
  const c = got.value.creator;
  await creatorRead(ctx.businessId, creator.id, {
    name: c.name,
    bio: c.bio,
    followers: c.followers,
    lastPostAt: c.lastPostAt,
  });
  await progress.say({ now: 'Done', profiles: 1 }, true);
  return { failure: null };
}

// ------------------------------------------------------------------------------------------------ their posts

async function cursorFor(workId: string): Promise<string | null> {
  try {
    const kept = (await chrome.storage.local.get(CURSOR_KEY))[CURSOR_KEY] as
      { workId?: string; next?: string } | undefined;
    return kept?.workId === workId && typeof kept.next === 'string' ? kept.next : null;
  } catch {
    return null;
  }
}

const keepCursor = (workId: string, next: string | null) =>
  (next
    ? chrome.storage.local.set({ [CURSOR_KEY]: { workId, next } })
    : chrome.storage.local.remove(CURSOR_KEY)
  ).catch(() => undefined);

/** Which of a page's posts to keep: those since the read's start. Pinned ones count only when they're that new. */
export const postsSince = (posts: readonly PostIn[], since: string): PostIn[] =>
  posts.filter((p) => p.postedAt >= since);

async function posts(ctx: ReadCtx): Promise<ReadEnd> {
  const creator = ctx.work.creator;
  if (!creator) return { failure: 'That creator isn’t there anymore.' };
  const progress = new Progress(ctx);
  await progress.say({ now: `Reading ${shown(creator.handle)}’s profile` }, true);
  const got = await readCreator(ctx, creator.handle, 'posts');
  if (!got.ok)
    return got.gone ? await notOpenedEnd(ctx, 'posts', creator.handle, got.why) : got.end;
  const c = got.value.creator;
  const onPage = got.value.page;
  await creatorRead(ctx.businessId, creator.id, {
    name: c.name,
    bio: c.bio,
    followers: c.followers,
    lastPostAt: c.lastPostAt,
  });
  if (c.private)
    return {
      failure: `${shown(creator.handle)}’s account is private, so its posts can’t be read.`,
    };
  const since = ctx.work.since ?? new Date(Date.now() - READ_BACK_MS).toISOString();
  if (!c.id) {
    if (onPage?.posts.length)
      return pagePosts(ctx, creator, onPage.posts, since, progress, 'no account id');
    await report(
      ctx,
      'posts',
      'Profile: Instagram’s answer had no account id to ask for their posts by.',
      null,
    );
    return couldntRead();
  }
  let next = await cursorFor(ctx.work.id);
  let waiting: PostIn[] = [];
  let kept = 0;
  const save = async () => {
    for (let i = 0; i < waiting.length; i += LIMITS.postsPerSave)
      await postsSave(ctx.businessId, creator.id, waiting.slice(i, i + LIMITS.postsPerSave));
    waiting = [];
  };
  await progress.say({ now: `Reading ${shown(creator.handle)}’s posts`, profiles: 1, posts: 0 });
  for (let page = 0; page < POSTS_PAGES_MOST; page++) {
    const read = await answer(ctx, 'posts', postsPath(c.id, next), postsFrom, 'Posts', false);
    if (!read.ok) {
      await save();
      // Not one page of their posts came: what their profile page holds, when it holds any.
      if (read.gone && page === 0 && !kept) {
        const held = onPage ?? (await ctx.tab.hands('profileHeld', creator.handle));
        if (held?.posts.length)
          return pagePosts(ctx, creator, held.posts, since, progress, read.why ?? 'not there');
      }
      await progress.say({ posts: kept }, true);
      return read.gone ? { failure: null } : read.end;
    }
    const these = postsSince(read.value.posts, since);
    kept += these.length;
    waiting.push(...these);
    if (waiting.length >= SAVE_EVERY) await save();
    await progress.say({ posts: kept });
    next = read.value.next;
    if (!next || (read.value.oldest !== null && read.value.oldest < since)) break;
    await keepCursor(ctx.work.id, next);
  }
  await save();
  await keepCursor(ctx.work.id, null);
  await progress.say({ now: 'Done', posts: kept }, true);
  return { failure: null };
}

/**
 * Their posts as their profile page holds them (its first dozen or so), when Instagram's list of their posts didn't
 * come: saved, and reported, so the list can be fixed.
 */
async function pagePosts(
  ctx: ReadCtx,
  creator: { id: string; handle: string },
  posts: readonly PostIn[],
  since: string,
  progress: Progress,
  why: string,
): Promise<ReadEnd> {
  const these = postsSince(posts, since);
  for (let i = 0; i < these.length; i += LIMITS.postsPerSave)
    await postsSave(ctx.businessId, creator.id, these.slice(i, i + LIMITS.postsPerSave));
  await report(
    ctx,
    'posts',
    `Posts: Instagram’s list of their posts didn’t come (${why}), so ${these.length} were read from their page.`,
    null,
    { pagePosts: posts.length, kept: these.length },
  );
  await progress.say({ now: 'Done', profiles: 1, posts: these.length }, true);
  return { failure: null };
}

/** A profile Instagram wouldn't open, its page holding nothing either: reported, and said so. */
async function notOpenedEnd(
  ctx: ReadCtx,
  read: ReadKind,
  handle: string,
  why: string | undefined,
): Promise<ReadEnd> {
  await report(
    ctx,
    read,
    `Profile: Instagram wouldn’t open it (it answered ${why || 'nothing'}), and the page held nothing to read.`,
    null,
    {},
  );
  return {
    failure: `Instagram wouldn’t open ${shown(handle)}’s profile. It may be gone or renamed. HandsFreeOS got a report in case Instagram changed something.`,
  };
}

// ------------------------------------------------------------------------------------------------ watch a video

/** What watching sends: frames, each one's size as base64, and the sound. Core's limits (shapes.ts) hold it. */
export const WATCH_ASK = {
  most: LIMITS.framesMost,
  width: 512,
  frameBytes: LIMITS.frameBytes,
  soundSeconds: 120,
  /** A file bigger than this is passed over: some minutes of video. */
  fileBytes: 60 * 1024 * 1024,
} as const;

/** The file, fetched by the background when the tab couldn't, as base64; null when it couldn't either. */
async function fileOf(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > WATCH_ASK.fileBytes) return null;
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  } catch {
    return null;
  }
}

async function watch(ctx: ReadCtx): Promise<ReadEnd> {
  const post = ctx.work.post;
  if (!post) return { failure: 'That post isn’t there anymore.' };
  const mediaId = mediaIdOf(post.postKey);
  if (!mediaId)
    return { failure: 'That post’s link can’t be read, so its video can’t be watched.' };
  await new Progress(ctx).say({ now: 'Watching the video: frames and sound' }, true);
  const opened = await openPage(ctx, post.link);
  if (!opened.ok) return opened.end;
  const got = await answer(ctx, 'watch', mediaInfoPath(mediaId), videoOf, 'Video');
  if (!got.ok)
    return got.gone ? { failure: 'Instagram says that post isn’t there anymore.' } : got.end;
  let seen = await ctx.tab.hands('watch', { ...WATCH_ASK, url: got.value.url });
  if (seen && !seen.ok && seen.blocked) {
    const file = await fileOf(got.value.url);
    if (file) seen = await ctx.tab.hands('watch', { ...WATCH_ASK, url: got.value.url, file });
  }
  if (!seen) return { failure: 'The reading tab didn’t answer. It tries again later.' };
  if (!seen.ok) return { failure: seen.failure };
  const sent = await watchSend(ctx.businessId, {
    workId: ctx.work.id,
    postId: post.id,
    seconds: seen.seconds ?? got.value.seconds,
    frames: seen.frames,
    sound: got.value.sound ? seen.sound : null,
  });
  return { failure: sent.watched ? null : (sent.failure ?? 'The AI couldn’t watch that video.') };
}

export const INSTAGRAM_READS_BY_KIND = { find, profile, posts, watch } as const;
