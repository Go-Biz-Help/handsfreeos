/**
 * When a duty is due (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Dates"), worked out from its rule, the deal's
 * key dates and the business's calendar, with a trace that replays exactly: which date it rests on and where that came
 * from, each day passed over and why, the time of day, and the holiday rules' version. Browser-safe and pure.
 *
 * - **A date with no time** is due at 11:59 pm where the business is (Chris, 2026-09-30).
 * - **Calendar days** land where they land: a deadline on a weekend or holiday keeps its date and says so
 *   (`not_a_business_day`); only a business-day rule skips days.
 * - **Unconfirmed dates** still give a due time, marked `unconfirmed`, so a draft duty can show when it would be due;
 *   a missing one gives none (`waiting`).
 */
import { addDays, localDateOf, localInstant, zonedParts } from '../../../calendar/engine/zoned';
import {
  addBusinessDays,
  dayOff,
  NO_CLOSED_DAYS,
  type BusinessCalendar,
  type DayOff,
  type SkippedDay,
} from './business-days';
import { HOLIDAY_RULES_VERSION } from './holidays';
import type { KeyDateKey, KeyDates, TermSource } from './key-dates';

/** 11:59 pm: when a date with no time is due. */
export const END_OF_DAY = '23:59';

export type DueRule =
  /** Nothing to be due by: done when it's done. */
  | { readonly kind: 'none' }
  /** Kept up while the deal is in its stages; no single deadline. */
  | { readonly kind: 'ongoing' }
  /** Some time after the duty began (its trigger's moment). */
  | {
      readonly kind: 'after_start';
      readonly hours?: number;
      readonly days?: number;
      readonly businessDays?: number;
    }
  /** Before (negative) or after a key date, or on it. */
  | {
      readonly kind: 'relative';
      readonly to: KeyDateKey;
      readonly days?: number;
      readonly businessDays?: number;
      readonly hours?: number;
      /** A time of day for the result ('17:00'); otherwise the key date's own time, else 11:59 pm. */
      readonly at?: string;
    }
  /** Again every so many days while it's open: the next one after it began. */
  | { readonly kind: 'every'; readonly days: number }
  /** The earliest or latest of several. */
  | { readonly kind: 'earliest' | 'latest'; readonly of: readonly DueRule[] };

export interface DueContext {
  readonly timeZone: string;
  readonly calendar?: BusinessCalendar;
  readonly keyDates: KeyDates;
  /** When the duty began: the moment its trigger happened. */
  readonly startedAt: number;
}

/** One step of the working out, in order. */
export type DueStep =
  | {
      readonly step: 'anchor';
      readonly key: KeyDateKey;
      readonly date: string;
      readonly time: string | null;
      readonly source: TermSource;
      readonly confirmed: boolean;
    }
  | { readonly step: 'start'; readonly at: string }
  | {
      readonly step: 'offset';
      readonly unit: 'hours' | 'days' | 'business_days';
      readonly by: number;
      readonly from: string;
      readonly to: string;
      readonly skipped: readonly SkippedDay[];
    }
  | {
      readonly step: 'time';
      readonly clock: string;
      readonly why: 'given' | 'from_date' | 'end_of_day';
    }
  | { readonly step: 'pick'; readonly rule: 'earliest' | 'latest'; readonly chose: number };

export type DueWarning = {
  readonly code: 'not_a_business_day';
  readonly date: string;
  readonly off: DayOff;
};

export interface DueResult {
  /** due: it has a due time; none: it has no deadline; waiting: a date it needs isn't entered yet. */
  readonly state: 'due' | 'none' | 'waiting';
  /** The instant (ISO). */
  readonly dueAt: string | null;
  /** The local date and time it's due. */
  readonly date: string | null;
  readonly time: string | null;
  /** Dates it rests on that nobody has confirmed yet. */
  readonly unconfirmed: readonly KeyDateKey[];
  /** Dates it needs that aren't entered. */
  readonly missing: readonly KeyDateKey[];
  readonly warnings: readonly DueWarning[];
  readonly trace: readonly DueStep[];
  readonly rulesVersion: string;
}

const NONE: Omit<DueResult, 'trace'> = {
  state: 'none',
  dueAt: null,
  date: null,
  time: null,
  unconfirmed: [],
  missing: [],
  warnings: [],
  rulesVersion: HOLIDAY_RULES_VERSION,
};

const iso = (ms: number) => new Date(ms).toISOString();

/** The wall clock where the business is, as 'HH:MM'. */
function clockAt(at: number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

interface Point {
  readonly at: number;
  readonly date: string;
  readonly time: string;
}

/** A local date and time as an instant, with the warning a calendar-day deadline on a day off gets. */
function point(
  date: string,
  clock: string,
  ctx: DueContext,
  warnOnDayOff: boolean,
): { point: Point; warnings: DueWarning[] } {
  const off = warnOnDayOff ? dayOff(date, ctx.calendar ?? NO_CLOSED_DAYS) : null;
  return {
    point: { at: localInstant(date, clock, ctx.timeZone), date, time: clock },
    warnings: off ? [{ code: 'not_a_business_day', date, off }] : [],
  };
}

function due(
  p: Point,
  trace: DueStep[],
  extra: Partial<Pick<DueResult, 'unconfirmed' | 'warnings'>> = {},
): DueResult {
  return {
    ...NONE,
    state: 'due',
    dueAt: iso(p.at),
    date: p.date,
    time: p.time,
    unconfirmed: extra.unconfirmed ?? [],
    warnings: extra.warnings ?? [],
    trace,
  };
}

/** Days after a local date, or business days, with the step that says so. */
function shift(
  date: string,
  rule: { readonly days?: number; readonly businessDays?: number },
  ctx: DueContext,
): { date: string; step: DueStep | null; businessDays: boolean } {
  if (rule.businessDays !== undefined && rule.businessDays !== 0) {
    const moved = addBusinessDays(date, rule.businessDays, ctx.calendar ?? NO_CLOSED_DAYS);
    return {
      date: moved.date,
      businessDays: true,
      step: {
        step: 'offset',
        unit: 'business_days',
        by: rule.businessDays,
        from: date,
        to: moved.date,
        skipped: moved.skipped,
      },
    };
  }
  if (rule.days !== undefined && rule.days !== 0) {
    const to = addDays(date, rule.days);
    return {
      date: to,
      businessDays: false,
      step: { step: 'offset', unit: 'days', by: rule.days, from: date, to, skipped: [] },
    };
  }
  return { date, step: null, businessDays: rule.businessDays !== undefined };
}

/** When a rule makes a duty due. */
export function resolveDue(rule: DueRule, ctx: DueContext): DueResult {
  switch (rule.kind) {
    case 'none':
    case 'ongoing':
      return { ...NONE, trace: [] };

    case 'after_start': {
      const trace: DueStep[] = [{ step: 'start', at: iso(ctx.startedAt) }];
      if (rule.hours !== undefined) {
        const at = ctx.startedAt + rule.hours * 3_600_000;
        const date = localDateOf(at, ctx.timeZone);
        trace.push({
          step: 'offset',
          unit: 'hours',
          by: rule.hours,
          from: iso(ctx.startedAt),
          to: iso(at),
          skipped: [],
        });
        return due({ at, date, time: clockAt(at, ctx.timeZone) }, trace);
      }
      const started = localDateOf(ctx.startedAt, ctx.timeZone);
      const moved = shift(started, rule, ctx);
      if (moved.step) trace.push(moved.step);
      trace.push({ step: 'time', clock: END_OF_DAY, why: 'end_of_day' });
      const made = point(moved.date, END_OF_DAY, ctx, false);
      return due(made.point, trace);
    }

    case 'relative': {
      const anchor = ctx.keyDates[rule.to];
      if (!anchor) return { ...NONE, state: 'waiting', missing: [rule.to], trace: [] };
      const trace: DueStep[] = [
        {
          step: 'anchor',
          key: rule.to,
          date: anchor.date,
          time: anchor.time ?? null,
          source: anchor.source,
          confirmed: anchor.confirmed,
        },
      ];
      const unconfirmed = anchor.confirmed ? [] : [rule.to];
      if (rule.hours !== undefined) {
        const clock = anchor.time ?? END_OF_DAY;
        const at = localInstant(anchor.date, clock, ctx.timeZone) + rule.hours * 3_600_000;
        trace.push({
          step: 'offset',
          unit: 'hours',
          by: rule.hours,
          from: iso(localInstant(anchor.date, clock, ctx.timeZone)),
          to: iso(at),
          skipped: [],
        });
        const date = localDateOf(at, ctx.timeZone);
        return due({ at, date, time: clockAt(at, ctx.timeZone) }, trace, { unconfirmed });
      }
      const moved = shift(anchor.date, rule, ctx);
      if (moved.step) trace.push(moved.step);
      const moving = moved.step !== null;
      const clock = rule.at ?? (!moving && anchor.time ? anchor.time : END_OF_DAY);
      trace.push({
        step: 'time',
        clock,
        why: rule.at ? 'given' : !moving && anchor.time ? 'from_date' : 'end_of_day',
      });
      // A calendar-day deadline keeps its date on a weekend or holiday, and says so.
      const made = point(moved.date, clock, ctx, !moved.businessDays);
      return due(made.point, trace, { unconfirmed, warnings: made.warnings });
    }

    case 'every': {
      const started = localDateOf(ctx.startedAt, ctx.timeZone);
      const to = addDays(started, rule.days);
      const trace: DueStep[] = [
        { step: 'start', at: iso(ctx.startedAt) },
        { step: 'offset', unit: 'days', by: rule.days, from: started, to, skipped: [] },
        { step: 'time', clock: END_OF_DAY, why: 'end_of_day' },
      ];
      return due(point(to, END_OF_DAY, ctx, false).point, trace);
    }

    case 'earliest':
    case 'latest': {
      const each = rule.of.map((r) => resolveDue(r, ctx));
      const missing = [...new Set(each.flatMap((r) => r.missing))];
      // One still waiting could turn out earliest (or latest): nothing is due until every date is in.
      if (missing.length)
        return {
          ...NONE,
          state: 'waiting',
          missing,
          unconfirmed: [...new Set(each.flatMap((r) => r.unconfirmed))],
          trace: [],
        };
      const dated = each
        .map((r, i) => ({ r, i }))
        .filter((x) => x.r.state === 'due' && x.r.dueAt !== null);
      if (!dated.length) return { ...NONE, trace: [] };
      const pick = dated.reduce((best, x) =>
        rule.kind === 'earliest'
          ? Date.parse(x.r.dueAt!) < Date.parse(best.r.dueAt!)
            ? x
            : best
          : Date.parse(x.r.dueAt!) > Date.parse(best.r.dueAt!)
            ? x
            : best,
      );
      return {
        ...pick.r,
        unconfirmed: [...new Set(dated.flatMap((x) => x.r.unconfirmed))],
        trace: [...pick.r.trace, { step: 'pick', rule: rule.kind, chose: pick.i }],
      };
    }
  }
}

/** The key dates a rule rests on. */
export function dueRuleDates(rule: DueRule): KeyDateKey[] {
  switch (rule.kind) {
    case 'relative':
      return [rule.to];
    case 'earliest':
    case 'latest':
      return [...new Set(rule.of.flatMap(dueRuleDates))];
    default:
      return [];
  }
}
