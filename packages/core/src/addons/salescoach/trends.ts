/**
 * Trends (round four, docs/salescoach.md): how a rep's coached calls are going over time, and the owner's view of
 * every rep. Worked out from the write-ups already kept (`addon_salescoach.calls.result`), never stored: a period
 * of weeks (Monday to Sunday, in the business's time zone) against the same number of weeks before it.
 *
 * - **Score**: the average of the write-ups' scores (./coach.ts `scoreCall`).
 * - **Talk time**: the rep's average share of the words said, on calls and Zoom meetings only. A written
 *   conversation's share of the words says little about talking too much.
 * - **Objections answered** and **script steps done**: added up across the write-ups, so a call with five
 *   objections counts for more than one with none.
 * - **Wins**: coached records the customer went on to book, accept, pay or win (./learn.ts) within a week.
 * - **Steps skipped most**: counted against each playbook's steps as they are now, and only from calls whose
 *   playbook had the same number of steps then, since a step's id is its place in the script.
 *
 * Browser-safe and pure: the server query (./ops/trends.ts) reads the rows, the screens read the shapes.
 */
import { z } from 'zod';
import { addDays, localDateOf, startOfLocalDay, weekdayOf } from '../../calendar/engine/zoned';
import type { CallScore } from './coach';

export const TREND_WEEKS = { min: 4, max: 26, default: 12 } as const;
/** The periods the screens offer. */
export const TREND_PERIODS = [4, 12, 26] as const;
/** The most skipped steps shown for a rep, and for the team. */
export const SKIPPED_SHOWN = 3;
/** A step needs this many calls before its skips mean anything. */
export const SKIPPED_MIN_CALLS = 3;

/** One coached record, as trends read it. */
export interface TrendRecord {
  readonly userId: string | null;
  /** When it started, epoch ms. */
  readonly at: number;
  /** A call or a Zoom meeting: someone talked. */
  readonly spoken: boolean;
  readonly score: CallScore;
  readonly stepsCovered: readonly string[];
  readonly playbookId: string | null;
  readonly won: boolean;
}

export const TrendTotals = z.object({
  coached: z.number().int(),
  /** The average score, 0 to 100; null with nothing coached. */
  score: z.number().int().nullable(),
  /** The rep's average share of the talking on calls and meetings, 0 to 100; null without one. */
  talkShare: z.number().int().nullable(),
  objections: z.object({ answered: z.number().int(), of: z.number().int() }),
  steps: z.object({ covered: z.number().int(), of: z.number().int() }),
  wins: z.number().int(),
});
export type TrendTotals = z.infer<typeof TrendTotals>;

export const TrendWeek = TrendTotals.extend({
  /** The week's Monday, a local date. */
  week: z.string(),
});
export type TrendWeek = z.infer<typeof TrendWeek>;

export const SkippedStep = z.object({
  playbookId: z.string(),
  playbookName: z.string(),
  stepId: z.string(),
  title: z.string(),
  skipped: z.number().int(),
  of: z.number().int(),
});
export type SkippedStep = z.infer<typeof SkippedStep>;

export const Trend = z.object({
  totals: TrendTotals,
  /** The same number of weeks just before. */
  previous: TrendTotals,
  series: z.array(TrendWeek),
  skippedSteps: z.array(SkippedStep),
});
export type Trend = z.infer<typeof Trend>;

/** The Monday of the week a local date falls in. */
export function mondayOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** The weeks of a period, oldest first: the last is this week, so far. */
export function trendWeeks(now: number, weeks: number, timeZone: string): string[] {
  const thisWeek = mondayOf(localDateOf(now, timeZone));
  return Array.from({ length: weeks }, (_, i) => addDays(thisWeek, 7 * (i - weeks + 1)));
}

/** When the period starts, and when the one before it does, epoch ms. */
export function trendBounds(
  now: number,
  weeks: number,
  timeZone: string,
): { from: number; previousFrom: number } {
  const first = trendWeeks(now, weeks, timeZone)[0]!;
  return {
    from: startOfLocalDay(first, timeZone),
    previousFrom: startOfLocalDay(addDays(first, -7 * weeks), timeZone),
  };
}

const average = (values: readonly number[]) =>
  values.length === 0 ? null : Math.round(values.reduce((t, v) => t + v, 0) / values.length);

/** The totals of some coached records. */
export function tallyTrend(records: readonly TrendRecord[]): TrendTotals {
  let answered = 0;
  let raised = 0;
  let covered = 0;
  let steps = 0;
  for (const r of records) {
    answered += r.score.objections.answered;
    raised += r.score.objections.of;
    covered += r.score.steps?.covered ?? 0;
    steps += r.score.steps?.of ?? 0;
  }
  return {
    coached: records.length,
    score: average(records.map((r) => r.score.total)),
    talkShare: average(records.filter((r) => r.spoken).map((r) => r.score.talkShare)),
    objections: { answered, of: raised },
    steps: { covered, of: steps },
    wins: records.filter((r) => r.won).length,
  };
}

/** A playbook's steps as they are now. */
export interface TrendPlaybook {
  readonly name: string;
  readonly steps: readonly { readonly id: string; readonly title: string }[];
}

/** The script steps skipped most, by how often, of the calls that had them. */
export function skippedSteps(
  records: readonly TrendRecord[],
  playbooks: ReadonlyMap<string, TrendPlaybook>,
  shown = SKIPPED_SHOWN,
): SkippedStep[] {
  const counts = new Map<string, SkippedStep>();
  for (const r of records) {
    const pb = r.playbookId ? playbooks.get(r.playbookId) : undefined;
    // The playbook changed shape since: its step ids may name other steps now.
    if (!pb || !r.score.steps || r.score.steps.of !== pb.steps.length) continue;
    const done = new Set(r.stepsCovered);
    for (const s of pb.steps) {
      const key = `${r.playbookId}:${s.id}`;
      const c = counts.get(key) ?? {
        playbookId: r.playbookId!,
        playbookName: pb.name,
        stepId: s.id,
        title: s.title,
        skipped: 0,
        of: 0,
      };
      counts.set(key, { ...c, of: c.of + 1, skipped: c.skipped + (done.has(s.id) ? 0 : 1) });
    }
  }
  return [...counts.values()]
    .filter((c) => c.skipped > 0 && c.of >= SKIPPED_MIN_CALLS)
    .sort((a, b) => b.skipped / b.of - a.skipped / a.of || b.skipped - a.skipped)
    .slice(0, shown);
}

/** One rep's, or the team's, trend over the period's weeks. */
export function trendOf(
  records: readonly TrendRecord[],
  input: {
    readonly weeks: readonly string[];
    readonly from: number;
    readonly previousFrom: number;
    readonly timeZone: string;
    readonly playbooks: ReadonlyMap<string, TrendPlaybook>;
  },
): Trend {
  const current = records.filter((r) => r.at >= input.from);
  const byWeek = new Map<string, TrendRecord[]>();
  for (const r of current) {
    const week = mondayOf(localDateOf(r.at, input.timeZone));
    byWeek.set(week, [...(byWeek.get(week) ?? []), r]);
  }
  return {
    totals: tallyTrend(current),
    previous: tallyTrend(records.filter((r) => r.at >= input.previousFrom && r.at < input.from)),
    series: input.weeks.map((week) => ({ week, ...tallyTrend(byWeek.get(week) ?? []) })),
    skippedSteps: skippedSteps(current, input.playbooks),
  };
}

/** A share as a whole percent, or null of nothing. */
export const percentOf = (part: number, of: number): number | null =>
  of === 0 ? null : Math.round((part / of) * 100);
