/**
 * Results by group, and the weekly report (docs/outreach.md, decision 34; the owner's answers 9a and 9g):
 *
 * - **By group.** Everyone reached is counted under the group they were found in, with whether they wrote back and
 *   booked a demo (`outreach.activity`, `outreach.groups`). The groups that brought demos, then replies, come first
 *   on the Groups tab, and the extension works them more: most of each run's groups are those, and the rest try
 *   others, so a new group still gets its chance. Today puts people from them ahead of others who fit as well.
 * - **The weekly report.** On Monday at the morning push's hour (8 when that's off), each person who used the
 *   extension in the week gets an email of it: friend requests, chats started, replies and demos, their best group
 *   and their best opener (apps/worker/src/addons/outreach/weekly.ts). An owner or admin can turn it off.
 *
 * Browser-safe: the web, the extension and the worker all use it.
 */
import { addDays, localDateOf, localInstant } from '../../calendar/engine/zoned';

/** What came of the people reached from a group: how many wrote back, and how many booked a demo. */
export interface GroupResults {
  readonly replies: number;
  readonly demos: number;
}

/** Whether a group brought anything: a reply or a demo. */
export const brought = (g: GroupResults) => g.replies + g.demos > 0;

/** The groups that brought demos first, then replies; others keep their order. */
export const byResults = (a: GroupResults, b: GroupResults) =>
  b.demos - a.demos || b.replies - a.replies;

/** "3 wrote back · 1 demo booked"; empty when nothing came of it yet. */
export function resultWords(g: GroupResults): string {
  return [
    g.replies ? `${g.replies.toLocaleString()} wrote back` : null,
    g.demos ? `${g.demos.toLocaleString()} ${g.demos === 1 ? 'demo' : 'demos'} booked` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Of the groups one run of the extension works, the share kept for the ones that brought results. */
export const PROVEN_SHARE = 0.6;

/**
 * The groups one run of the extension works, at most `most`, from the person's groups marked Work these and Maybe,
 * each in the order HandsFreeOS lists them (results first, then the best fit), and only those they're in: the ones
 * that brought replies or demos, from either list, the best first, in 3 of every 5 places; then others from Work
 * these, or from Maybe when they're in none of Work these. With too few of either, the other fills the rest.
 */
export function groupsToWork<T extends GroupResults & { readonly joined: boolean | null }>(
  work: readonly T[],
  maybe: readonly T[],
  most: number,
): T[] {
  const inWork = work.filter((g) => g.joined === true);
  const inMaybe = maybe.filter((g) => g.joined === true);
  const proven = [...inWork, ...inMaybe].filter(brought).sort(byResults);
  const fresh = (inWork.length ? inWork : inMaybe).filter((g) => !brought(g));
  const kept = Math.min(
    proven.length,
    Math.max(most - fresh.length, Math.ceil(most * PROVEN_SHARE)),
  );
  return [...proven.slice(0, kept), ...fresh.slice(0, most - kept)];
}

/** The group that did best: the most demos, then replies. Null when none brought any. */
export function bestGroup<T extends GroupResults>(groups: readonly T[]): T | null {
  return [...groups].filter(brought).sort(byResults)[0] ?? null;
}

/** How an opener did: first messages sent with it, who wrote back and who booked a demo. */
export interface OpenerScore {
  readonly sent: number;
  readonly replies: number;
  readonly demos: number;
}

/** The opener that did best: the most demos, then replies, then replies for each sent. Null when none brought any. */
export function bestOpener<T extends OpenerScore>(openers: readonly T[]): T | null {
  return (
    [...openers]
      .filter((o) => o.sent > 0 && o.replies + o.demos > 0)
      .sort(
        (a, b) =>
          b.demos - a.demos || b.replies - a.replies || b.replies / b.sent - a.replies / a.sent,
      )[0] ?? null
  );
}

/** The weekly report's day: Monday. */
export const WEEKLY_DAY = 1;
/** Its hour when the morning push is off. */
export const WEEKLY_HOUR = 8;

/** The next weekly report after `now`: the coming Monday at the hour, in the business's time zone. */
export function nextWeekly(now: number, timeZone: string, hour: number): Date {
  const clock = `${String(hour).padStart(2, '0')}:00`;
  const today = localDateOf(now, timeZone);
  for (let i = 0; ; i++) {
    const day = addDays(today, i);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() !== WEEKLY_DAY) continue;
    const at = localInstant(day, clock, timeZone);
    if (at > now) return new Date(at);
  }
}
