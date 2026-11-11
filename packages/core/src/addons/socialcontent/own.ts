/**
 * Learning from the business's own posts (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, part 11; decision 19;
 * docs/socialcontent.md, "Its own posts' numbers"). Two and seven days after a post goes up, the reading computer reads
 * its numbers in each place it went up; at seven days it's weighed against the business's own other posts in the same
 * place, as a creator's posts are against theirs (./standouts.ts), and one that did well goes into the Playbook beside
 * the creators' standouts.
 *
 * The one copy: the server decides when a read is due and keeps what did well; the web and the phone show it.
 * Browser-safe and pure.
 */
import type { PostedTo, PostPlace } from './calendar';
import { STANDOUT, weighPosts, type StandoutOn } from './standouts';

export const OWN = {
  /** When its numbers are read: about 2 days after it went up, and about 7. */
  firstDays: 2,
  secondDays: 7,
  /** A read the computer took and never answered is due again after this. */
  takenMs: 30 * 60_000,
} as const;

const DAY_MS = 86_400_000;

/** Which read: at about 2 days, or at about 7. */
export const OWN_READS = ['d2', 'd7'] as const;
export type OwnRead = (typeof OWN_READS)[number];

/** One place's numbers at one read, as the network showed them; or why they couldn't be read. */
export type OwnNumbersRead =
  | {
      readonly at: string;
      /** Whole days after it went up there. */
      readonly days: number;
      readonly views: number | null;
      readonly likes: number | null;
      readonly comments: number | null;
      readonly shares: number | null;
    }
  | { readonly at: string; readonly days: number; readonly failure: string };

/** Its numbers so far, by place: the read at about 2 days and at about 7. */
export type OwnNumbers = Readonly<
  Partial<Record<PostPlace, Readonly<Partial<Record<OwnRead, OwnNumbersRead>>>>>
>;

/** A post that did well against the business's own others in the same place. */
export interface DoneWell {
  readonly place: PostPlace;
  readonly on: StandoutOn;
  /** How many times their middle number, on its better number. */
  readonly times: number;
  readonly at: string;
}

const time = (d: Date | string | number) =>
  d instanceof Date ? d.getTime() : typeof d === 'number' ? d : new Date(d).getTime();

/** Whether a read has numbers (not a failure). */
export const hasNumbers = (
  r: OwnNumbersRead | undefined,
): r is Extract<OwnNumbersRead, { views: number | null }> => !!r && !('failure' in r);

/** When it first went up anywhere, or null. */
export function firstUp(postedTo: readonly PostedTo[]): number | null {
  const ats = postedTo.map((p) => time(p.at)).filter((t) => Number.isFinite(t));
  return ats.length ? Math.min(...ats) : null;
}

/** The places that went up with a link: the only ones whose numbers can be read. */
export const linkedPlaces = (postedTo: readonly PostedTo[]): PostedTo[] =>
  postedTo.filter((p) => !!p.link);

/**
 * When its next read is due, from when it first went up and what's been read: the 2-day read, then the 7-day; null
 * once both are, or when it went up nowhere with a link. A 2-day read missed until the 7th day is left out: the 7-day
 * read takes its place.
 */
export function nextCheckAt(postedTo: readonly PostedTo[], numbers: OwnNumbers): Date | null {
  const linked = linkedPlaces(postedTo);
  const first = firstUp(linked);
  if (first === null) return null;
  const done = (read: OwnRead) => linked.every((p) => !!numbers[p.place]?.[read]);
  if (!done('d7') && !done('d2')) return new Date(first + OWN.firstDays * DAY_MS);
  if (!done('d7')) return new Date(first + OWN.secondDays * DAY_MS);
  return null;
}

/** The read due now, and the places it reads: the 7-day once it's 7 days on, else the 2-day. Null when none is. */
export function checkDue(
  postedTo: readonly PostedTo[],
  numbers: OwnNumbers,
  now: Date | number,
): { read: OwnRead; places: { place: PostPlace; link: string }[] } | null {
  const linked = linkedPlaces(postedTo);
  const first = firstUp(linked);
  if (first === null) return null;
  const days = (time(now) - first) / DAY_MS;
  if (days < OWN.firstDays) return null;
  const read: OwnRead = days >= OWN.secondDays ? 'd7' : 'd2';
  const places = linked
    .filter((p) => !numbers[p.place]?.[read])
    .map((p) => ({ place: p.place, link: p.link! }));
  return places.length ? { read, places } : null;
}

/** Whole days between when a place went up and a read. */
export function daysUp(at: string, readAt: Date | number): number {
  return Math.max(0, Math.round((time(readAt) - time(at)) / DAY_MS));
}

/** One of the business's own posts in one place, with its 7-day numbers, to be weighed against the others. */
export interface OwnPostNumbers {
  readonly id: string;
  readonly place: PostPlace;
  readonly at: string;
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
}

/**
 * Whether one post did well in a place against the business's own other posts there, with their 7-day numbers: the
 * same rule as a creator's standouts (2 times the middle of up to 10 on each side, from at least 4 that show the same
 * number, and the least numbers a standout needs). Null when it didn't, or there are too few to tell yet.
 */
export function ownDoneWell(
  post: OwnPostNumbers,
  others: readonly OwnPostNumbers[],
  now: Date | number,
): DoneWell | null {
  const same = [post, ...others.filter((o) => o.place === post.place && o.id !== post.id)];
  // Weighed as at their 7-day reads: every one of them is old enough to weigh and be weighed.
  const weighed = weighPosts(
    same.map((p) => ({
      id: p.id,
      postedAt: p.at,
      views: p.views,
      likes: p.likes,
      comments: p.comments,
    })),
    Math.max(time(now), ...same.map((p) => time(p.at) + STANDOUT.waitDays * DAY_MS)),
  ).find((w) => w.id === post.id);
  if (!weighed?.standout || !weighed.on) return null;
  return {
    place: post.place,
    on: weighed.on,
    times: Math.max(weighed.viewsTimes ?? 0, weighed.engagementTimes ?? 0),
    at: new Date(time(now)).toISOString(),
  };
}
