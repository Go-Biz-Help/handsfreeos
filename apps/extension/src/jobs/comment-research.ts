/**
 * **Comment research** on any network (docs/outreach.md, decisions 166 and 172: `comment_research`), once a day in
 * batches while it works on its own: HandsFreeOS's own study of how real people comment, started by HandsFreeOS staff
 * from Social Outreach → Settings, one research a network. Only the browser of whoever started one reads for it; for
 * everyone else HandsFreeOS answers that there's none, and this does nothing.
 *
 * - **Each batch:** a couple of the searches HandsFreeOS names for the network (everyday hashtags on Instagram,
 *   everyday words on Facebook, Threads and X, work words on LinkedIn, the town's group and the person's groups on
 *   Alignable: none about the business), a few posts on each opened in turn, and the comments each shows read. A post
 *   read before for this research is passed over (`seenPosts`). Then the next batch later in the day (`again`), until
 *   the day's share is read.
 * - **What leaves the browser:** each comment's words alone, sorted here first (core's `sortComments`): never who
 *   wrote it, the post, its caption or its address; no @name, link, email or phone number; and nothing that reads
 *   like a bot's or an advert's. Never the post writer's own comments, nor the person's.
 * - **What each network reads** is its own (`ResearchReader`): ./instagram/comment-research.ts,
 *   ./facebook-research.ts, ./linkedin/comment-research.ts, ./alignable/comment-research.ts and
 *   ./follows/comment-research.ts (Threads and X).
 *
 * - **Its turn** (decision 194, `researchNext`): from 0.154.0 each runner asks before the day's other once-a-day
 *   jobs, so a research that runs goes first whenever its batch is due, and outside the working hours too, as it only
 *   reads (`lookForResearch` says when the runner wakes for it there).
 *
 * Nothing is written. It goes at a person's pace and stops for the day on any warning from the network.
 */
import {
  researchNetworkName,
  sortComments,
  type ResearchPlatform,
} from '@hfos/core/addons/outreach/comment-research';
import type { Hfos } from './job';
import { waitsAgain, type AutoState } from '../auto/plan';
import { AWAY_AGAIN_MS } from '../auto/on-screen';
import { counted } from '../words';
import { onScreen, paced, pause, valueOf, type Job, type JobEnd } from './job';

/** Between one search and the next: a person going on to another. */
const SEARCH_PACE_MS = [20_000, 40_000] as const;
/** Between one post and the next, unless the network says its own. */
export const POST_PACE_MS = [8_000, 15_000] as const;

/** One post's comments as they leave the browser: the words kept, and how many were left out. */
export interface PostComments {
  readonly comments: string[];
  readonly dropped: number;
}

/** What a network's research reads, and how. */
export interface ResearchReader {
  readonly platform: ResearchPlatform;
  /** One search as the person's lines say it: "#foodie posts", "posts about “my dog”", "your town’s posts". */
  readonly where: (search: string) => string;
  /** Whether a search is read with its window in front: Instagram draws a hashtag's grid only on screen. */
  readonly onScreen?: boolean;
  /** Between one post and the next: `POST_PACE_MS` unless the network says its own. */
  readonly postPace?: readonly [number, number];
  /**
   * A search's posts' own addresses, in the order shown: it reads on (a screen more) till `most` of them are `fresh`
   * (not read before for this research) or it has read as far as it goes; or the day's end on a warning or a sign-in.
   */
  readonly links: (
    job: Job,
    search: string,
    most: number,
    progress: string,
    fresh: (link: string) => boolean,
  ) => Promise<readonly string[] | JobEnd>;
  /**
   * One post's comments by other people (never its writer's, nor the person's), as they were typed; null for a post
   * it couldn't read; or the day's end on a warning or a sign-in.
   */
  readonly comments: (job: Job, link: string) => Promise<readonly string[] | null | JobEnd>;
}

export const ended = (got: object | null): got is JobEnd => got !== null && 'warned' in got;

// ------------------------------------------------------------------------------------------- posts read before

/** The most posts remembered as read for a research: a few batches' worth, the oldest let go first. */
const SEEN_MOST = 1_000;
const SEEN_KEY = 'hfos.researchSeen';

/** A post's address as a short number: which posts were read is remembered, never their addresses. */
export function postKey(link: string): string {
  let hash = 0x811c9dc5;
  const text = link
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

type Seen = Readonly<Record<string, readonly string[]>>;
const kept = new Map<string, string[]>();
const storage = (): chrome.storage.StorageArea | null =>
  (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local ?? null;

/**
 * The posts read before for a research, as keys (`postKey`): kept in the extension's storage across the background's
 * restarts, one research a network, and here when there's no storage.
 */
export async function seenPosts(researchId: string): Promise<Set<string>> {
  const area = storage();
  if (!area) return new Set(kept.get(researchId) ?? []);
  try {
    const got = (await area.get(SEEN_KEY))[SEEN_KEY] as Seen | undefined;
    return new Set(got?.[researchId] ?? []);
  } catch {
    return new Set();
  }
}

/** Remembers the posts read for a research, the newest last, dropping any research of the network but this one. */
async function keepSeen(
  researchId: string,
  others: readonly string[],
  keys: Set<string>,
): Promise<void> {
  const list = [...keys].slice(-SEEN_MOST);
  const area = storage();
  if (!area) {
    for (const id of others) kept.delete(id);
    kept.set(researchId, list);
    return;
  }
  try {
    const got = ((await area.get(SEEN_KEY))[SEEN_KEY] as Seen | undefined) ?? {};
    const next: Record<string, readonly string[]> = {};
    for (const [id, seen] of Object.entries(got)) if (!others.includes(id)) next[id] = seen;
    next[researchId] = list;
    await area.set({ [SEEN_KEY]: next });
  } catch {
    // Not remembered: a post may be read again, and its comments count once more.
  }
}

/** The research ids this computer read for on a network, so a new one's start lets the old one's go. */
const lastResearch = new Map<ResearchPlatform, string>();

/** Forgets every post read, where there's no storage: each test starts afresh. */
export function forgetSeenPosts(): void {
  kept.clear();
  lastResearch.clear();
}

// ------------------------------------------------------------------------------------------- the day's reading

/** What the day keeps for the comment research when none is this person's to read for: never shown. */
export const NO_RESEARCH = 'No comment research is running.';

/**
 * Whether a comment research this person started is reading on the network (decisions 166 and 172). Anything else, a
 * HandsFreeOS that doesn't answer included, is no.
 */
export async function researchRuns(
  hfos: Hfos,
  businessId: string,
  platform: ResearchPlatform,
): Promise<boolean> {
  try {
    const next = await hfos({
      type: 'hfos-comment-research-next',
      input: { workspaceId: businessId, platform },
    });
    return next.ok && Boolean(next.value?.research);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------- its turn (decision 194)

/**
 * Outside the working hours, once today's share of a research it read is done, how often a runner looks again: the
 * next day's share starts soon after the day turns.
 */
export const RESEARCH_LOOK_MS = 60 * 60_000;

/**
 * Whether the comment research reads next on a network (decision 194): its batch is due (not done today, not waiting
 * for its next batch, not put off till the person's away) and a research this person started reads there. While one
 * does, it goes before the day's other once-a-day jobs, then takes turns with them as its batches wait, and outside the
 * working hours too, as it only reads. For anyone else the day keeps that none runs, asked once a day. `state` comes
 * back as it now is.
 */
export async function researchNext(input: {
  readonly hfos: Hfos;
  readonly businessId: string;
  readonly platform: ResearchPlatform;
  readonly state: AutoState;
  readonly now: number;
  readonly passOver?: readonly string[];
  readonly setState: (change: Partial<AutoState>) => Promise<AutoState>;
}): Promise<{ readonly reads: boolean; readonly state: AutoState }> {
  const { state } = input;
  if (
    state.daily?.comment_research !== undefined ||
    waitsAgain(state, 'comment_research', input.now) ||
    input.passOver?.includes('comment_research')
  )
    return { reads: false, state };
  if (await researchRuns(input.hfos, input.businessId, input.platform))
    return { reads: true, state };
  const now = await input.setState({ daily: { ...state.daily, comment_research: NO_RESEARCH } });
  return { reads: false, state: now };
}

/**
 * When a runner outside its working hours looks next (decision 194): at `look` (null for no time), or sooner for a
 * comment research it reads: its next batch today; in a few minutes while a batch waits for the person to be away
 * (`passOver`); or, once today's share is done, in an hour (`RESEARCH_LOOK_MS`).
 */
export function lookForResearch(
  look: number | null,
  state: Pick<AutoState, 'daily' | 'againAt'>,
  now: number,
  passOver: readonly string[] = [],
): number | null {
  const done = state.daily?.comment_research;
  const again = state.againAt?.comment_research;
  const next =
    done === undefined
      ? again !== undefined && again > now
        ? again
        : passOver.includes('comment_research')
          ? now + AWAY_AGAIN_MS
          : null
      : done === NO_RESEARCH
        ? null
        : now + RESEARCH_LOOK_MS;
  return next === null ? look : Math.min(look ?? Infinity, next);
}

/** One search's posts read: each one's comments sorted, or the day's end. */
async function readSearch(
  job: Job,
  reader: ResearchReader,
  search: string,
  most: number,
  seen: Set<string>,
  progress: string,
): Promise<{ readonly posts: PostComments[] } | JobEnd> {
  const unseen = (link: string) => !seen.has(postKey(link));
  const links = await reader.links(job, search, most, progress, unseen);
  if (ended(links)) return links;
  const fresh = [...new Set(links)].filter(unseen).slice(0, most);
  const posts: PostComments[] = [];
  for (const link of fresh) {
    if (job.stopped()) break;
    await pause(paced(reader.postPace ?? POST_PACE_MS));
    const said = await reader.comments(job, link);
    if (ended(said)) return said;
    seen.add(postKey(link));
    if (!said) continue;
    const sorted = sortComments(said);
    posts.push({ comments: sorted.kept, dropped: sorted.dropped });
  }
  return { posts };
}

/**
 * Reads the next batch of comments for the research this person started on the reader's network, if they started
 * one, and sends the words.
 */
export async function readCommentsFor(job: Job, reader: ResearchReader): Promise<JobEnd> {
  const network = researchNetworkName(reader.platform);
  const { research } = valueOf(
    await job.hfos({
      type: 'hfos-comment-research-next',
      input: { workspaceId: job.businessId, platform: reader.platform },
    }),
  );
  if (!research) return { line: NO_RESEARCH, warned: false };
  const so = (total: number) =>
    `${total.toLocaleString()} of about ${research.target.toLocaleString()} comments kept so far`;
  if (!research.tags.length)
    return {
      line: `Today’s share of the comment research is read: ${so(research.kept)}. It carries on tomorrow.`,
      warned: false,
    };
  const before = lastResearch.get(reader.platform);
  const others = before && before !== research.id ? [before] : [];
  lastResearch.set(reader.platform, research.id);
  const seen = await seenPosts(research.id);
  let kept = 0;
  let posts = 0;
  let total = research.kept;
  let reading = true;
  const summary = () =>
    `Read the comments under ${counted(posts, 'post')} for the comment research and kept ${counted(kept, 'comment')}’ words: ${so(total)}.`;
  try {
    for (const [i, tag] of research.tags.entries()) {
      if (job.stopped()) return { line: `Stopped. ${summary()}`, warned: false };
      if (i > 0) await pause(paced(SEARCH_PACE_MS));
      const progress = `Comment research: reading the comments under ${reader.where(tag)} on ${network}… ${so(total)}.`;
      job.progress(progress);
      const work = () => readSearch(job, reader, tag, research.postsEach, seen, progress);
      const read = reader.onScreen ? await onScreen(job, work) : await work();
      if (ended(read)) return { ...read, line: `${read.line} ${summary()}` };
      const saved = valueOf(
        await job.hfos({
          type: 'hfos-comment-research-save',
          input: { workspaceId: job.businessId, id: research.id, tag, posts: read.posts },
        }),
      );
      posts += read.posts.length;
      kept += saved.kept;
      total = saved.total;
      reading = saved.reading;
      if (!reading) break;
    }
  } finally {
    await keepSeen(research.id, others, seen);
  }
  if (!reading)
    return {
      line: `${summary()} That’s all it set out to read, so the AI sums it up now: see it in Social Outreach → Settings.`,
      warned: false,
    };
  // More of today's share may be left: the next batch goes later today, and HandsFreeOS says when the day's is read.
  return { line: `${summary()} The next batch goes later today.`, warned: false, again: true };
}
