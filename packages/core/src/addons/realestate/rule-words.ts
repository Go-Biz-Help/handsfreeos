/**
 * How a duty's rules read on a screen (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Screens"): when it's due,
 * what finishes it, what brings it, its reminders and who answers for it, in the words the duty editor, the duty
 * drawer and the Assistant all use. Browser-safe and pure.
 */
import { clockOfMinutes, fmtMonthDay, weekdayShort } from '../../calendar/when';
import { daysBetween, localDateOf, parseClock, parseLocalDate } from '../../calendar/engine/zoned';
import {
  DEAL_FACTS,
  type AccountableRole,
  type DealEvent,
  type DealFact,
  type Materiality,
  type Performer,
  type ProofRule,
  type TrackerCode,
} from './catalog/types';
import { TRACKERS } from './catalog/trackers';
import type { SkippedDay } from './dates/business-days';
import type { DueRule, DueStep, DueWarning } from './dates/due';
import { KEY_DATES, type KeyDateKey, type TermSource } from './dates/key-dates';
import { proofItemWords } from './proof';
import { STAGE_LABELS, type DealStage } from './states';

export const ACCOUNTABLE_LABELS: Readonly<Record<AccountableRole, string>> = {
  agent: 'Main agent',
  coordinator: 'Coordinator, else the main agent',
  broker: 'Owners and admins',
};

export const MATERIALITY_LABELS: Readonly<Record<Materiality, string>> = {
  standard: 'Everyday',
  material: 'Matters to the deal',
  critical: 'Could stop the closing',
};

export const PERFORMER_LABELS: Readonly<Record<Performer, string>> = {
  client: 'the client',
  lender: 'the lender',
  title: 'title or escrow',
  inspector: 'the inspector',
  appraiser: 'the appraiser',
  vendor: 'a vendor',
  other_agent: 'the other side’s agent',
  attorney: 'an attorney',
  hoa: 'the HOA',
  insurer: 'the insurer',
};

/** The moments that bring a duty, as "when …" finishes them. */
export const TRIGGER_EVENT_WORDS: Readonly<Record<DealEvent, string>> = {
  offer_received: 'an offer comes in',
  offer_lost: 'an offer is lost',
  inspection_report: 'the inspection report is in',
  repair_request: 'a repair request is made',
  repairs_agreed: 'repairs are agreed',
  low_appraisal: 'the appraisal comes in low',
  amendment: 'the contract is amended',
  terminated: 'the contract is terminated',
  closed: 'the deal closes',
  deal_ended: 'the deal closes or ends',
  deal_failed: 'an offer is lost or the contract is terminated',
  listing_ended: 'the listing is withdrawn, expires or is cancelled',
  search_changed: 'the search changes',
};

/** A tracker's name, as the list shows it ("Financing"). */
export const trackerName = (code: TrackerCode | string): string =>
  (TRACKERS as Readonly<Record<string, { name: string }>>)[code]?.name ?? code;

const dateWords = (key: KeyDateKey | string) =>
  (KEY_DATES as Readonly<Record<string, { label: string }>>)[key]?.label.toLowerCase() ?? key;

const list = (words: readonly string[], join: 'and' | 'or') =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} ${join} ${words[words.length - 1]}`;

const count = (n: number, one: string, many: string) =>
  `${Math.abs(n)} ${Math.abs(n) === 1 ? one : many}`;

/** "10 business days before closing", "Within 24 hours", "Every 7 days", "The earlier of … or …". */
export function dueRuleWords(rule: DueRule): string {
  switch (rule.kind) {
    case 'none':
      return 'No deadline';
    case 'ongoing':
      return 'Kept up while the deal is open';
    case 'every':
      return rule.days === 1 ? 'Every day' : `Every ${rule.days} days`;
    case 'after_start': {
      const parts = [
        rule.hours ? count(rule.hours, 'hour', 'hours') : null,
        rule.days ? count(rule.days, 'day', 'days') : null,
        rule.businessDays ? count(rule.businessDays, 'business day', 'business days') : null,
      ].filter((p): p is string => !!p);
      return parts.length ? `Within ${list(parts, 'and')} of it starting` : 'When it starts';
    }
    case 'relative': {
      const to = dateWords(rule.to);
      const by = rule.businessDays ?? rule.days ?? 0;
      const unit = rule.businessDays ? ['business day', 'business days'] : ['day', 'days'];
      const at = rule.at ? ` at ${clockOfMinutes(parseClock(rule.at))}` : '';
      const hours = rule.hours
        ? `${count(rule.hours, 'hour', 'hours')} ${rule.hours < 0 ? 'before' : 'after'} `
        : '';
      if (!by) return hours ? `${hours}${to}${at}` : `On ${to}${at}`;
      return `${hours}${count(by, unit[0]!, unit[1]!)} ${by < 0 ? 'before' : 'after'} ${to}${at}`;
    }
    case 'earliest':
    case 'latest': {
      const parts = rule.of.map((r) => lowerFirst(dueRuleWords(r)));
      return `The ${rule.kind === 'earliest' ? 'earlier' : 'later'} of ${list(parts, 'or')}`;
    }
  }
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** "A signed Purchase contract and a note of what was done"; no rule: "Saying it’s done". */
export function proofRuleWords(rule: ProofRule | null | undefined): string {
  if (!rule || rule.items.length === 0) return 'Saying it’s done';
  const words = list(rule.items.map(proofItemWords), rule.mode === 'any' ? 'or' : 'and');
  return words[0]!.toUpperCase() + words.slice(1);
}

/** "When the deal reaches Signed", "When closing is confirmed", "When an offer comes in". */
export function triggerWords(
  trigger:
    | { readonly on: 'stage'; readonly stage: DealStage | string }
    | { readonly on: 'dates'; readonly key: KeyDateKey | string }
    | { readonly on: 'event'; readonly event: DealEvent | string },
): string {
  switch (trigger.on) {
    case 'stage':
      return `When the deal reaches ${STAGE_LABELS[trigger.stage as DealStage] ?? trigger.stage}`;
    case 'dates':
      return `When ${dateWords(trigger.key)} is confirmed`;
    case 'event':
      return `When ${TRIGGER_EVENT_WORDS[trigger.event as DealEvent] ?? trigger.event}`;
  }
}

/** "7, 3 and 1 days before"; none: "No reminders". */
export function remindersWords(days: readonly number[]): string {
  if (!days.length) return 'No reminders';
  const sorted = [...days].sort((a, b) => b - a);
  return `${list(sorted.map(String), 'and')} ${sorted.length === 1 && sorted[0] === 1 ? 'day' : 'days'} before`;
}

/** "Only with an HOA" for a duty that needs some of the deal's facts. */
export function factsWords(facts: readonly (DealFact | string)[]): string {
  if (!facts.length) return '';
  return `Only when: ${list(
    facts.map((f) => lowerFirst((DEAL_FACTS as Readonly<Record<string, string>>)[f] ?? f)),
    'and',
  )}`;
}

/**
 * When something is due, from where the business is: "due today", "due tomorrow", "due Fri", "due Oct 3", "2 days
 * overdue" (an open one past its time), or "No deadline".
 */
export function dueWords(
  dueAt: string | null,
  timeZone: string,
  opts: { readonly now?: number; readonly open?: boolean } = {},
): string {
  if (!dueAt) return 'No deadline';
  const now = opts.now ?? Date.now();
  const at = Date.parse(dueAt);
  const today = localDateOf(now, timeZone);
  const day = localDateOf(at, timeZone);
  const d = daysBetween(today, day);
  if (opts.open !== false && at <= now)
    return d >= 0 ? 'overdue today' : `${-d} ${d === -1 ? 'day' : 'days'} overdue`;
  if (d === 0) return 'due today';
  if (d === 1) return 'due tomorrow';
  if (d > 1 && d < 7) return `due ${weekdayShort(day)}`;
  return `due ${fmtMonthDay(day, parseLocalDate(today).year)}`;
}

/** A local date as a list shows it: "Oct 14", with the year when it isn't this one. */
export function dayWords(date: string | null, timeZone: string, now = Date.now()): string {
  if (!date) return '—';
  return fmtMonthDay(date, parseLocalDate(localDateOf(now, timeZone)).year);
}

/**
 * What brought a duty, as the deal page groups them: the stage ("Under contract"), the date confirmed ("Closing"), the
 * moment ("The inspection report is in"), or "Added on this deal".
 */
export function startedByWords(startedBy: string): string {
  const [on, what = ''] = startedBy.split(':', 2) as [string, string?];
  if (on === 'stage') return STAGE_LABELS[what as DealStage] ?? what;
  if (on === 'dates')
    return (KEY_DATES as Readonly<Record<string, { label: string }>>)[what]?.label ?? what;
  if (on === 'event') {
    const w = TRIGGER_EVENT_WORDS[what as DealEvent] ?? what;
    return w[0]!.toUpperCase() + w.slice(1);
  }
  return 'Added on this deal';
}

/** Where a value came from, as a sentence says it. */
export const SOURCE_WORDS: Readonly<Record<TermSource, string>> = {
  contract: 'the contract',
  amendment: 'an amendment',
  counter: 'the counteroffer',
  addendum: 'an addendum',
  correction: 'a correction',
  lender: 'the lender',
  title: 'title or escrow',
  agreement: 'the agreement',
  typed: 'typed in',
};

/** A local date and time: "Oct 1, 11:59 PM"; the year only when it isn't this one. */
export function whenWords(date: string, time: string | null, thisYear?: number): string {
  const day = fmtMonthDay(date, thisYear);
  return time ? `${day}, ${clockOfMinutes(parseClock(time))}` : day;
}

const offWords = (d: SkippedDay) =>
  d.off.reason === 'weekend'
    ? `${fmtMonthDay(d.date)} (weekend)`
    : `${fmtMonthDay(d.date)} (${d.off.name})`;

/**
 * How a due time was worked out, a line a step: "Closing is Oct 8, from the contract", "Skipped Oct 12 (Columbus
 * Day)", "Not confirmed yet". Weekends skipped are left out unless they're all there is.
 */
export function traceWords(trace: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of trace as readonly DueStep[]) {
    if (raw.step === 'anchor') {
      const label =
        (KEY_DATES as Readonly<Record<string, { label: string }>>)[raw.key]?.label ?? raw.key;
      const from = SOURCE_WORDS[raw.source] ?? raw.source;
      out.push(
        `${label}: ${whenWords(raw.date, raw.time)}, ${raw.source === 'typed' ? from : `from ${from}`}${raw.confirmed ? '' : ', not confirmed yet'}`,
      );
    } else if (raw.step === 'offset' && raw.skipped.length) {
      const named = raw.skipped.filter((d) => d.off.reason !== 'weekend');
      if (named.length) out.push(`Skipped ${list(named.map(offWords), 'and')}`);
    }
  }
  return out;
}

/** A due date's warnings: "Oct 12 isn’t a business day (Columbus Day); the date stands". */
export function dueWarningWords(warnings: readonly unknown[]): string[] {
  return (warnings as readonly DueWarning[])
    .filter((w) => w.code === 'not_a_business_day')
    .map(
      (w) =>
        `${fmtMonthDay(w.date)} isn’t a business day (${w.off.reason === 'weekend' ? 'a weekend' : w.off.name}); the date stands`,
    );
}
