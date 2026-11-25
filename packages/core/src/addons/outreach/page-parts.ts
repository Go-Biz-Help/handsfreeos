/**
 * Needs you's and Today's parts (docs/outreach.md, decision 193): each page was one long column, so each has a row of
 * parts at the top, the way People has its views (decision 128), on the web and the phone alike, in this order.
 *
 * - **Needs you** has a part for each kind of thing that waits, in decision 42's order: Autopilot's people to OK for
 *   today (decision 151, while anyone on it waits), what the computer needs the person for, the asks about people in
 *   their hands (decision 182), replies handed over, messages to OK, comments to OK (comments on posts and answers in
 *   groups, decision 196: they wait among the messages, and have a part of their own), steps it couldn't do, friend
 *   requests to decide, and Not sure where they live (decision 128). Only the parts with something in them are on the
 *   row, each with its count, and the one open; the page opens on the first with anything, so nothing waiting is ever
 *   out of sight for long. With nothing at all, there's no row.
 * - **Today** keeps every part on the row: **Overview** (what it did, Heads up, what needs the person and each network's
 *   card with Start my day), **Plan** (what their computer will do today and about when, decision 195), **Your list**
 *   (the day's list, partners and referrals), **Posts and events** (the helpful post and the events near them), **Done
 *   today** (every step today) and, for owners and admins, **Your team**.
 *
 * Browser-safe and pure.
 */
import { autopilotPlace, type AutopilotState } from './autopilot';
import type { WaitingKind } from './waiting-words';

/** Needs you's parts, in the row's order. */
export const NEEDS_PARTS = {
  autopilot: 'People to OK',
  ask: 'Your computer',
  hands: 'In your hands',
  reply: 'Replies',
  message: 'Messages',
  comment: 'Comments',
  need: 'Steps',
  request: 'Requests',
  unsure: 'Where they live',
} as const;
export type NeedsPart = keyof typeof NEEDS_PARTS;
export const NEEDS_PART_KEYS = Object.keys(NEEDS_PARTS) as [NeedsPart, ...NeedsPart[]];

/** How many wait in each part: a part whose count isn't known (no signal on the phone) is left out. */
export type NeedsCounts = Partial<Record<NeedsPart, number>>;

/** A part from an address (`/needs-you/<part>`, the phone's `&part=`): null for none, or one it doesn't know. */
export const readNeedsPart = (s: string | null | undefined): NeedsPart | null =>
  NEEDS_PART_KEYS.find((k) => k === s) ?? null;

/**
 * The part open: the one the address asks for, else the first with anything in it. Null when nothing waits and none
 * was asked for.
 */
export function needsPartOpen(asked: NeedsPart | null, counts: NeedsCounts): NeedsPart | null {
  return asked ?? NEEDS_PART_KEYS.find((k) => (counts[k] ?? 0) > 0) ?? null;
}

/** The parts on the row: each with something in it, and the one open even once it's empty. */
export function needsPartsShown(open: NeedsPart | null, counts: NeedsCounts): NeedsPart[] {
  return NEEDS_PART_KEYS.filter((k) => k === open || (counts[k] ?? 0) > 0);
}

/**
 * The parts that are a list of `outreach.waiting`'s items, in the row's order: each kind that waits, with the messages
 * to OK in two, the messages and the comments (decision 196).
 */
export const NEEDS_LIST_PARTS = [
  'ask',
  'reply',
  'message',
  'comment',
  'need',
  'request',
] as const satisfies readonly NeedsPart[];
export type NeedsListPart = (typeof NEEDS_LIST_PARTS)[number];

/**
 * Each part's count from what the page knows: each kind's count (`outreach.waiting`'s `kinds`), how many of the
 * messages are comments (its `comments`, decision 196), the asks about people in the person's hands, Autopilot's people
 * still waiting for the OK, and how many the country setting isn't sure of. Anything left out isn't known, so its part
 * shows only while it's open: without how many are comments, the messages' count is all of them.
 */
export function needsCountsOf(known: {
  readonly kinds?: Partial<Record<WaitingKind, { readonly count: number }>>;
  readonly comments?: number;
  readonly hands?: number;
  readonly autopilot?: number;
  readonly unsure?: number;
}): NeedsCounts {
  const counts: Record<string, number> = {};
  for (const [kind, of] of Object.entries(known.kinds ?? {})) if (of) counts[kind] = of.count;
  if (known.comments !== undefined && counts.message !== undefined) {
    counts.comment = Math.min(known.comments, counts.message);
    counts.message -= counts.comment;
  }
  if (known.hands !== undefined) counts.hands = known.hands;
  if (known.autopilot !== undefined) counts.autopilot = known.autopilot;
  if (known.unsure !== undefined) counts.unsure = known.unsure;
  return counts as NeedsCounts;
}

/**
 * Autopilot's people still waiting for the OK (decision 151), its part's count: none once its list is a line at the
 * bottom (decision 160), or while it's off.
 */
export function autopilotWaitingOf(
  list: {
    readonly on: boolean;
    readonly made: boolean;
    readonly people: readonly { readonly state: AutopilotState }[];
  } | null,
): number {
  return list && autopilotPlace(list) === 'top'
    ? list.people.filter((p) => p.state === 'waiting').length
    : 0;
}

/** Today's parts, in the row's order. Your team is owners' and admins' only. */
export const TODAY_PARTS = {
  overview: 'Overview',
  plan: 'Plan',
  list: 'Your list',
  posts: 'Posts and events',
  done: 'Done today',
  team: 'Your team',
} as const;
export type TodayPart = keyof typeof TODAY_PARTS;
export const TODAY_PART_KEYS = Object.keys(TODAY_PARTS) as [TodayPart, ...TodayPart[]];

/** The parts someone sees: Your team only for owners and admins (`outreach.manage`). */
export const todayPartsFor = (manages: boolean): TodayPart[] =>
  TODAY_PART_KEYS.filter((k) => k !== 'team' || manages);

/**
 * A part from an address (`/today/<part>`, the phone's `&part=`): Overview for none, one it doesn't know, or Your team
 * for someone who doesn't manage.
 */
export const readTodayPart = (s: string | null | undefined, manages: boolean): TodayPart =>
  todayPartsFor(manages).find((k) => k === s) ?? 'overview';

/**
 * What Today's list keeps of a list (its people, or its partners): everyone but a message waiting for an OK that Needs
 * you shows already, so nobody shows twice. `underNeeds` is those messages' ids.
 */
export function leftForToday<
  T extends { readonly send: { readonly sendId: string; readonly state: string } | null },
>(items: readonly T[], underNeeds: ReadonlySet<string>): T[] {
  return items.filter((i) => !(i.send?.state === 'waiting' && underNeeds.has(i.send.sendId)));
}

/** Your list's count on Today's row: the people and partners on it, less those Needs you shows already. */
export const todayListCount = (
  today: {
    readonly items: readonly {
      readonly send: { readonly sendId: string; readonly state: string } | null;
    }[];
    readonly partners: readonly {
      readonly send: { readonly sendId: string; readonly state: string } | null;
    }[];
  },
  underNeeds: ReadonlySet<string>,
): number =>
  leftForToday(today.items, underNeeds).length + leftForToday(today.partners, underNeeds).length;

/** The words around the two rows. */
export const PAGE_PART_WORDS = {
  needsLabel: 'What needs you',
  todayLabel: 'Which part of today',
  /** A part of Needs you that's empty now, with others still waiting. */
  needsPartEmpty: 'Nothing waits here now. Pick another part above.',
  /** Your team, when how each person's extension is doing couldn't be had. */
  teamNotLoaded: 'Your team’s day couldn’t be loaded just now. Try again in a minute.',
  /** Posts and events, with neither on the network shown. */
  postsNone: (network: string) =>
    `Nothing to post on ${network} today, and no events near you coming up.`,
} as const;
