/**
 * AI Social Media Content Creator setting itself up (docs/socialcontent.md, "Setting up on its own"; the owner's
 * decisions 28 to 33, 12 Nov 2026): which creators it picks to study, which it swaps out each month, when it starts
 * writing, and the steps the Creators page shows. Browser-safe and pure: the server, the worker, the web and the
 * phone work it out the same way.
 */
import { z } from 'zod';
import { networkName, type ContentNetwork } from './networks';
import { doneWell } from './standouts';

export const PICKING = {
  /** The creators studied on each network (decision 30). */
  perNetwork: 10,
  /** How close a creator must be to what the business does, of 10, to be picked. */
  matchLeast: 6,
  /** The closest this many on a network are weighed for their likes and comments, their profiles read first. */
  shortlist: 20,
  /** A shortlisted profile read longer ago than this is read again before it's picked. */
  freshDays: 14,
  /** Creators the AI scores in one ask, and in one run. */
  matchBatch: 12,
  matchRunMost: 120,
  /** How much the best likes and comments for their followers adds to a match of 10. */
  engagementWeight: 3,
  /** Their latest posts as read from a profile, and the ones kept for the AI to read. */
  recentAtMost: 12,
  recentKept: 6,
  captionKept: 200,
  /** Posts with numbers it takes to say how a creator's posts do for their followers. */
  recentLeast: 3,
  /** Swapped out each month (decision 31): no post in this many days, */
  quietDays: 45,
  /** or, with this many posts read, fewer than 1 standout in this many. */
  readLeast: 30,
  standoutEvery: 30,
  /** It writes anyway this many days after setup started, Playbook or not (decision 32). */
  writeAfterDays: 3,
} as const;

const DAY_MS = 86_400_000;

/** One of a creator's latest posts as their profile shows it. */
export const RecentPost = z.object({
  likes: z.number().int().min(0).nullable().default(null),
  comments: z.number().int().min(0).nullable().default(null),
  views: z.number().int().min(0).nullable().default(null),
  caption: z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, PICKING.captionKept))
    .nullable()
    .default(null),
});
export type RecentPost = z.output<typeof RecentPost>;

/** The steps of setting up it has taken, each when (decision 28). */
export const SetupMarks = z
  .object({
    startedAt: z.string().optional(),
    nichesAt: z.string().optional(),
    findAt: z.string().optional(),
    writeAt: z.string().optional(),
  })
  .catch({});
export type SetupMarks = z.output<typeof SetupMarks>;

/** The middle of a list of numbers. */
function middle(list: readonly number[]): number {
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Likes and comments for their followers (decision 30): the middle of their latest posts', so one big hit doesn't
 * make a creator look better than they are. Null with no followers known or under 3 posts with numbers.
 */
export function engagementOf(
  recent: readonly RecentPost[] | null,
  followers: number | null,
): number | null {
  if (!recent || !followers) return null;
  const rates = recent
    .filter((p) => p.likes !== null || p.comments !== null)
    .map((p) => ((p.likes ?? 0) + (p.comments ?? 0)) / followers);
  if (rates.length < PICKING.recentLeast) return null;
  return Math.round(middle(rates) * 1e6) / 1e6;
}

/** The latest posts kept: those with words or numbers, up to the most. */
export const recentKept = (recent: readonly RecentPost[]): RecentPost[] =>
  recent
    .filter((p) => p.caption || p.likes !== null || p.comments !== null)
    .slice(0, PICKING.recentKept);

/** A creator as picking weighs them. */
export interface PickCandidate {
  readonly id: string;
  readonly network: ContentNetwork;
  readonly state: 'suggested' | 'studying' | 'skipped' | 'didnt_fit';
  readonly followers: number | null;
  readonly lastPostAt: Date | string | null;
  readonly profileReadAt: Date | string | null;
  readonly match: number | null;
  readonly engagement: number | null;
  /** Whether their latest posts were ever read from their profile. */
  readonly recentRead: boolean;
}

const time = (d: Date | string) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/**
 * Who to study on each network (decision 30): up to 10 on each, counting those already studied. Of the suggested
 * creators the AI found close enough (6 of 10), the closest 20 are weighed: how close, plus up to 3 for the best likes
 * and comments for their followers among them. Their profiles are read first when not lately, or never with their
 * latest posts while the extension reads them (`readFirst`), so their followers, last post and numbers are now's;
 * then those still with 5,000 followers and a post in the last 30 days are picked.
 */
export function pickCreators(input: {
  readonly candidates: readonly PickCandidate[];
  readonly studying: Readonly<Partial<Record<ContentNetwork, number>>>;
  readonly networks: readonly ContentNetwork[];
  /** Whether a reading computer can read profiles first, and whether its extension reads their latest posts too. */
  readonly canRead: boolean;
  readonly readsRecent: boolean;
  readonly now: number;
}): {
  pick: { id: string; network: ContentNetwork }[];
  readFirst: { id: string; network: ContentNetwork }[];
} {
  const pick: { id: string; network: ContentNetwork }[] = [];
  const readFirst: { id: string; network: ContentNetwork }[] = [];
  for (const network of input.networks) {
    const room = PICKING.perNetwork - (input.studying[network] ?? 0);
    if (room <= 0) continue;
    const close = input.candidates
      .filter(
        (c) =>
          c.network === network &&
          c.state === 'suggested' &&
          c.match !== null &&
          c.match >= PICKING.matchLeast,
      )
      .sort((a, b) => b.match! - a.match! || (b.followers ?? 0) - (a.followers ?? 0))
      .slice(0, PICKING.shortlist);
    const stale = close.filter(
      (c) =>
        !c.profileReadAt ||
        input.now - time(c.profileReadAt) > PICKING.freshDays * DAY_MS ||
        (!c.recentRead && input.readsRecent),
    );
    if (input.canRead && stale.length) {
      readFirst.push(...stale.map((c) => ({ id: c.id, network })));
      continue;
    }
    const fit = close.filter((c) => doneWell(c, input.now));
    const rates = fit
      .map((c) => c.engagement)
      .filter((e): e is number => e !== null)
      .sort((a, b) => a - b);
    // Where a creator's likes and comments for their followers stand among the others', 0 to 1; unknown counts as 0.
    const standing = (e: number | null) =>
      e === null || rates.length < 2 ? 0 : rates.filter((r) => r < e).length / (rates.length - 1);
    const score = (c: PickCandidate) =>
      c.match! + PICKING.engagementWeight * standing(c.engagement);
    pick.push(
      ...fit
        .sort((a, b) => score(b) - score(a) || (b.followers ?? 0) - (a.followers ?? 0))
        .slice(0, room)
        .map((c) => ({ id: c.id, network })),
    );
  }
  return { pick, readFirst };
}

/** A creator the AI picked, as the monthly swap weighs them. */
export interface SwapCandidate {
  readonly id: string;
  readonly lastPostAt: Date | string | null;
  readonly postsReadAt: Date | string | null;
  readonly postsCount: number;
  readonly standoutsCount: number;
}

/**
 * The creators the AI picked that it swaps out this month (decision 31), each with why: no post in 45 days, or fewer
 * than 1 standout in 30 posts once 30 are read. Only ones whose posts were read; never one a person ticked or added
 * (the caller passes only the AI's).
 */
export function swapsFor(
  picked: readonly SwapCandidate[],
  now: number,
): { id: string; why: string }[] {
  const out: { id: string; why: string }[] = [];
  for (const c of picked) {
    if (!c.postsReadAt) continue;
    if (c.lastPostAt && now - time(c.lastPostAt) > PICKING.quietDays * DAY_MS) {
      const days = Math.floor((now - time(c.lastPostAt)) / DAY_MS);
      out.push({ id: c.id, why: `Swapped out by the AI: no posts in ${days} days.` });
    } else if (
      c.postsCount >= PICKING.readLeast &&
      c.standoutsCount * PICKING.standoutEvery < c.postsCount
    )
      out.push({
        id: c.id,
        why: `Swapped out by the AI: ${c.standoutsCount === 1 ? '1 standout' : `${c.standoutsCount} standouts`} in ${c.postsCount} posts.`,
      });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the steps

/** What the steps of setting up are worked out from, as the server reads them. */
export const SetupFacts = z.object({
  autoPick: z.boolean(),
  autoFill: z.boolean(),
  marks: SetupMarks,
  readerSet: z.boolean(),
  nichesPicked: z.number().int(),
  findsLeft: z.number().int(),
  /** Profiles read before picking, still waiting. */
  readsLeft: z.number().int(),
  /** On each network studied: how many are studied, how many the AI picked, and how many it could still pick. */
  networks: z.array(
    z.object({
      network: z.string(),
      studying: z.number().int(),
      byAi: z.number().int(),
      pickable: z.number().int(),
    }),
  ),
  noted: z.number().int(),
  playbookAt: z.string().nullable(),
  filledAt: z.string().nullable(),
  offerLive: z.boolean(),
  listsFilled: z.number().int(),
  listsAll: z.number().int(),
});
export type SetupFacts = z.infer<typeof SetupFacts>;

export const SETUP_STEPS = ['reader', 'niches', 'find', 'pick', 'study', 'write'] as const;
export type SetupStepKey = (typeof SETUP_STEPS)[number];
export type SetupStepState = 'done' | 'doing' | 'waiting' | 'off';

export interface SetupStep {
  readonly key: SetupStepKey;
  readonly state: SetupStepState;
  readonly title: string;
  readonly line: string;
  /** Where to fix what it waits on: a page of the add-on's, or core's main offer. */
  readonly fix?: 'settings' | 'niches' | 'main-offer' | 'main-offer-lists';
}

/** When it writes anyway, Playbook or not (decision 32): 3 days after setup started. */
export function writeFrom(marks: SetupMarks): number | null {
  return marks.startedAt ? time(marks.startedAt) + PICKING.writeAfterDays * DAY_MS : null;
}

/**
 * What writing still waits on (decision 32), or null when it may start: the main offer live, its lists for content
 * all filled, and the Playbook written or 3 days passed since setup started.
 */
export function writeWaitsOn(f: SetupFacts, now: number): 'offer' | 'lists' | 'playbook' | null {
  if (!f.offerLive) return 'offer';
  if (f.listsFilled < f.listsAll) return 'lists';
  const from = writeFrom(f.marks);
  if (!f.playbookAt && (from === null || now < from)) return 'playbook';
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "today", "yesterday", "3 days ago". */
function agoShown(ms: number, now: number): string {
  const days = Math.floor((now - ms) / DAY_MS);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}
/** "today", "tomorrow", "in 3 days". */
function inShown(ms: number, now: number): string {
  const days = Math.ceil((ms - now) / DAY_MS);
  return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
}

/** The steps of setting up, as the Creators page shows them on the web and the phone. */
export function setupSteps(f: SetupFacts, now: number): SetupStep[] {
  const steps: SetupStep[] = [];
  steps.push(
    f.readerSet
      ? { key: 'reader', state: 'done', title: 'Reading computer', line: 'Picked.' }
      : {
          key: 'reader',
          state: 'waiting',
          title: 'Reading computer',
          line: 'Setup starts once an owner or admin picks whose computer reads, in Settings.',
          fix: 'settings',
        },
  );
  steps.push(
    f.nichesPicked
      ? {
          key: 'niches',
          state: 'done',
          title: 'Niches',
          line: `${plural(f.nichesPicked, 'niche')} ticked to search.`,
        }
      : !f.autoPick
        ? {
            key: 'niches',
            state: 'off',
            title: 'Niches',
            line: 'Tick the niches to search under Niches.',
            fix: 'niches',
          }
        : {
            key: 'niches',
            state: f.readerSet ? 'doing' : 'waiting',
            title: 'Niches',
            line: 'It ticks your own niche and the 2 closest.',
          },
  );
  steps.push(
    f.findsLeft
      ? {
          key: 'find',
          state: 'doing',
          title: 'Finding creators',
          line: `${plural(f.findsLeft, 'search', 'searches')} left on the reading computer.`,
        }
      : f.marks.findAt || f.networks.some((n) => n.studying || n.pickable)
        ? {
            key: 'find',
            state: 'done',
            title: 'Finding creators',
            line: 'Searched. It searches again once a month.',
          }
        : {
            key: 'find',
            state: 'waiting',
            title: 'Finding creators',
            line: 'Searches each ticked niche once niches are ticked.',
          },
  );
  const counts = f.networks.map(
    (n) => `${networkName(n.network as ContentNetwork)} ${n.studying} of ${PICKING.perNetwork}`,
  );
  const full = f.networks.every((n) => n.studying >= PICKING.perNetwork || !n.pickable);
  steps.push(
    !f.autoPick
      ? {
          key: 'pick',
          state: 'off',
          title: 'Picking creators',
          line: `You tick who to study. ${counts.join(', ')}.`,
          fix: 'settings',
        }
      : f.readsLeft
        ? {
            key: 'pick',
            state: 'doing',
            title: 'Picking the best 10',
            line: `Reading ${plural(f.readsLeft, 'profile')} first, for their latest likes and comments. ${counts.join(', ')}.`,
          }
        : f.networks.some((n) => n.studying)
          ? {
              key: 'pick',
              state: full ? 'done' : 'doing',
              title: 'Picking the best 10',
              line: full
                ? `${counts.join(', ')}. It swaps out quiet ones once a month.`
                : `${counts.join(', ')}. More after the next search.`,
            }
          : {
              key: 'pick',
              state: 'waiting',
              title: 'Picking the best 10',
              line: 'The closest match, 5,000+ followers, a post in the last 30 days, and the best likes and comments for their followers.',
            },
  );
  steps.push(
    f.playbookAt
      ? {
          key: 'study',
          state: 'done',
          title: 'Notes and Playbook',
          line: `${plural(f.noted, 'standout')} noted, and the Playbook written.`,
        }
      : f.noted
        ? {
            key: 'study',
            state: 'doing',
            title: 'Notes and Playbook',
            line: `${plural(f.noted, 'standout')} noted. The Playbook is written at 3.`,
          }
        : {
            key: 'study',
            state: f.networks.some((n) => n.studying) ? 'doing' : 'waiting',
            title: 'Notes and Playbook',
            line: 'Reads their posts back 12 months, notes the standouts, then writes the Playbook.',
          },
  );
  const waits = writeWaitsOn(f, now);
  const from = writeFrom(f.marks);
  steps.push(
    f.filledAt
      ? {
          key: 'write',
          state: 'done',
          title: 'Writing your posts',
          line: `Filled the calendar ${agoShown(time(f.filledAt), now)}. Each post waits for your OK.`,
        }
      : !f.autoFill
        ? {
            key: 'write',
            state: 'off',
            title: 'Writing your posts',
            line: 'Fill on its own is off. Turn it on in Settings, or press Fill the calendar.',
            fix: 'settings',
          }
        : waits === 'offer'
          ? {
              key: 'write',
              state: 'waiting',
              title: 'Writing your posts',
              line: 'Waits for your main offer to go live, in Settings → Main offer.',
              fix: 'main-offer',
            }
          : waits === 'lists'
            ? {
                key: 'write',
                state: 'waiting',
                title: 'Writing your posts',
                line: `Waits for For your content in Settings → Main offer: ${f.listsFilled} of ${f.listsAll} lists filled.`,
                fix: 'main-offer-lists',
              }
            : waits === 'playbook'
              ? {
                  key: 'write',
                  state: 'waiting',
                  title: 'Writing your posts',
                  line: from
                    ? `Starts once the Playbook is written, or ${inShown(from, now)} anyway.`
                    : 'Starts once the Playbook is written, or 3 days after setup starts.',
                }
              : {
                  key: 'write',
                  state: 'doing',
                  title: 'Writing your posts',
                  line: 'Filling the calendar now. Each post waits for your OK.',
                },
  );
  return steps;
}

/** Whether setting up is done: every step done or turned off, so the page needn't show it. */
export const setupDone = (steps: readonly SetupStep[]): boolean =>
  steps.every((s) => s.state === 'done' || s.state === 'off');

/** The extension that reads a creator's latest posts with their profile (`recent`): profiles are read first from it. */
export const RECENT_FROM_VERSION = '0.136.0';

/** Whether an extension's version is at least another, as 1.2.3 numbers; false for none. */
export function versionAtLeast(version: string | null, least: string): boolean {
  if (!version) return false;
  const a = version.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const b = least.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}
