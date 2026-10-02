/**
 * A deal's health (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Health and alerts"): green, yellow or red, never a
 * score, with the exact reasons: the duty or date, who answers for it, when it's due, and the next step.
 * Browser-safe and pure: worked out at every change and every sweep, and shown the same everywhere.
 *
 * - **Red:** a critical duty overdue; a material duty overdue by a business day, or due within one and not
 *   started; two values of a date that counts that disagree; a reported wire change; closing within two business
 *   days with material work open; a problem across the deal's dates (a rate lock ending before closing, the
 *   Closing Disclosure too late, closing before acceptance…).
 * - **Yellow:** anything overdue; material work due within three business days and not started; anything blocked;
 *   duties waiting for their dates to be confirmed; a date that isn't entered; a duty nobody answers for; a warning
 *   across the dates (closing on a weekend or holiday…).
 */
import { fmtDateShort } from '../../calendar/when';
import type { Materiality } from './catalog/types';
import { contingencyClock, inSentence } from './contingencies';
import { businessDaysBetween, type BusinessCalendar } from './dates/business-days';
import type { DateProblem } from './dates/conflicts';
import { KEY_DATES, type KeyDateKey, type KeyDates } from './dates/key-dates';
import { WIRE_CHECK_KEY } from './own-duties';
import { isDoneDuty, isOpenDuty, type DutyStatus } from './states';
import { termLabel, type TermKey } from './terms';

export type HealthLevel = 'green' | 'yellow' | 'red';

export const HEALTH_CODES = [
  'critical_overdue',
  'material_late',
  'material_not_moving',
  'date_conflict',
  'wire_hold',
  'closing_with_open_work',
  'date_problem',
  'overdue',
  'material_soon',
  'blocked',
  'dates_unconfirmed',
  'date_missing',
  'nobody_accountable',
  'date_warning',
  // Round four.
  'contingency_passed',
  'linked_conflict',
  'contingency_ending',
  'prerequisite_open',
  'read_waiting',
  'waiting_long',
] as const;
export type HealthCode = (typeof HEALTH_CODES)[number];

export interface HealthReason {
  readonly code: HealthCode;
  readonly level: 'red' | 'yellow';
  /** What's wrong, in a sentence. */
  readonly words: string;
  /** What to do about it. */
  readonly next: string;
  readonly dutyId?: string;
  readonly keys?: readonly string[];
  readonly dueAt?: string | null;
  readonly accountableUserId?: string | null;
}

export interface HealthDuty {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly status: DutyStatus;
  readonly materiality: Materiality;
  readonly dueAt: string | null;
  readonly dueDate: string | null;
  readonly dueState: 'due' | 'none' | 'waiting';
  readonly needsDates: readonly string[];
  readonly accountableRole: 'agent' | 'coordinator' | 'broker';
  readonly accountableUserId: string | null;
  readonly blocker: string | null;
  /** Waiting on someone outside: who, and the day to chase them (round four). */
  readonly waitingOn?: string | null;
  readonly chaseAt?: string | null;
}

/** An open contingency and the day it ends (round four). */
export interface HealthContingency {
  readonly id: string;
  readonly label: string;
  readonly end: string | null;
}

/** A duty that can't be done before another on the deal (round four). */
export interface HealthWait {
  readonly dutyId: string;
  readonly dependsOnId: string;
}

/** Something the deal's linked sale or purchase breaks, in words (round four). */
export interface HealthLinked {
  readonly words: string;
  readonly next: string;
  readonly keys: readonly string[];
}

export interface HealthInput {
  readonly duties: readonly HealthDuty[];
  readonly keyDates: KeyDates;
  /** Terms whose live entries disagree. */
  readonly conflicts: readonly TermKey[];
  readonly dateProblems: readonly DateProblem[];
  readonly now: number;
  /** Today, where the business is. */
  readonly today: string;
  readonly calendar?: BusinessCalendar;
  // Round four.
  readonly contingencies?: readonly HealthContingency[];
  /** Values read from the deal's contracts, waiting for a person to confirm them. */
  readonly readsWaiting?: number;
  readonly waits?: readonly HealthWait[];
  readonly linked?: readonly HealthLinked[];
}

export interface Health {
  readonly level: HealthLevel;
  readonly reasons: readonly HealthReason[];
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const listOf = (words: readonly string[]) =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
const dateLabel = (k: string) =>
  (KEY_DATES as Record<string, { label: string }>)[k]?.label.toLowerCase() ?? k;

/** The deal's health, with every reason, reds first. */
export function healthOf(input: HealthInput): Health {
  const { duties, now, today } = input;
  const cal = input.calendar;
  const red: HealthReason[] = [];
  const yellow: HealthReason[] = [];
  const bdFromToday = (date: string) => businessDaysBetween(today, date, cal);
  const at = (d: HealthDuty) => ({
    dutyId: d.id,
    dueAt: d.dueAt,
    accountableUserId: d.accountableUserId,
  });

  for (const d of duties) {
    if (!isOpenDuty(d.status)) continue;
    const due = d.dueAt ? Date.parse(d.dueAt) : null;
    const overdue = due !== null && due <= now;
    // Business days past its due date (0 on the day), or until it (0 today).
    const late = overdue && d.dueDate ? -bdFromToday(d.dueDate) : 0;
    const ahead = !overdue && d.dueDate ? bdFromToday(d.dueDate) : null;
    const weighty = d.materiality !== 'standard';
    if (d.key === WIRE_CHECK_KEY) {
      red.push({
        code: 'wire_hold',
        level: 'red',
        words: 'Someone said the wiring instructions changed. Every payment is on hold.',
        next: 'Call the title or escrow company at a number you found yourself, then finish the check.',
        ...at(d),
      });
      continue;
    }
    if (overdue && d.materiality === 'critical')
      red.push({
        code: 'critical_overdue',
        level: 'red',
        words: `“${d.title}” is overdue, and it’s critical.`,
        next: 'Do it now, or say what’s in the way.',
        ...at(d),
      });
    else if (overdue && d.materiality === 'material' && late >= 1)
      red.push({
        code: 'material_late',
        level: 'red',
        words: `“${d.title}” is ${late} business ${plural(late, 'day', 'days')} overdue.`,
        next: 'Finish it, or mark it blocked with what’s in the way.',
        ...at(d),
      });
    else if (overdue)
      yellow.push({
        code: 'overdue',
        level: 'yellow',
        words: `“${d.title}” is overdue.`,
        next: 'Finish it, or say where it stands.',
        ...at(d),
      });
    else if (weighty && d.status === 'not_started' && ahead !== null && ahead <= 1)
      red.push({
        code: 'material_not_moving',
        level: 'red',
        words: `“${d.title}” is due ${ahead === 0 ? 'today' : 'within a business day'} and hasn’t been started.`,
        next: 'Start it now.',
        ...at(d),
      });
    else if (weighty && d.status === 'not_started' && ahead !== null && ahead <= 3)
      yellow.push({
        code: 'material_soon',
        level: 'yellow',
        words: `“${d.title}” is due ${d.dueDate ? fmtDateShort(d.dueDate) : 'soon'} and hasn’t been started.`,
        next: 'Start it.',
        ...at(d),
      });
    if (d.status === 'blocked')
      yellow.push({
        code: 'blocked',
        level: 'yellow',
        words: `“${d.title}” is blocked${d.blocker ? `: ${d.blocker}` : ''}.`,
        next: 'Clear what’s in the way, or ask whose it is. Its due date hasn’t moved.',
        ...at(d),
      });
    if (d.accountableRole !== 'broker' && !d.accountableUserId)
      yellow.push({
        code: 'nobody_accountable',
        level: 'yellow',
        words: `Nobody answers for “${d.title}”.`,
        next: 'Give it to someone on the deal.',
        ...at(d),
      });
  }

  // Dates: disagreeing values of one that counts, drafts waiting on confirmation, and dates not entered.
  const openDuties = duties.filter((d) => !isDoneDuty(d.status));
  const needed = new Set(openDuties.flatMap((d) => d.needsDates));
  for (const k of input.conflicts) {
    const counts =
      needed.has(k) || !!(KEY_DATES as Record<string, { contract?: boolean }>)[k]?.contract;
    if (!counts) continue;
    red.push({
      code: 'date_conflict',
      level: 'red',
      words: `The ${termLabel(k).toLowerCase()} has two values that disagree.`,
      next: 'Choose the one that counts on the deal’s key dates.',
      keys: [k],
    });
  }
  const drafts = openDuties.filter((d) => d.status === 'draft' && d.needsDates.length > 0);
  const waitingOn = [...new Set(drafts.flatMap((d) => d.needsDates))].filter(
    (k) => input.keyDates[k as KeyDateKey] && !input.conflicts.includes(k as TermKey),
  );
  if (waitingOn.length)
    yellow.push({
      code: 'dates_unconfirmed',
      level: 'yellow',
      words: `${drafts.length} ${plural(drafts.length, 'duty is a draft', 'duties are drafts')} until the ${listOf(waitingOn.map(dateLabel))} ${plural(waitingOn.length, 'is', 'are')} confirmed.`,
      next: 'Confirm the dates on the deal’s key dates.',
      keys: waitingOn,
    });
  const missing = [
    ...new Set(
      openDuties
        .filter((d) => d.dueState === 'waiting')
        .flatMap((d) => d.needsDates)
        .filter((k) => !input.keyDates[k as KeyDateKey]),
    ),
  ];
  if (missing.length) {
    const n = openDuties.filter(
      (d) => d.dueState === 'waiting' && d.needsDates.some((k) => missing.includes(k)),
    ).length;
    yellow.push({
      code: 'date_missing',
      level: 'yellow',
      words: `The ${listOf(missing.map(dateLabel))} ${plural(missing.length, 'isn’t', 'aren’t')} entered, so ${n} ${plural(n, 'duty has', 'duties have')} no due date.`,
      next: 'Enter the dates from the contract.',
      keys: missing,
    });
  }

  // Closing close with material work still open.
  const closing = input.keyDates.closing?.date;
  if (closing) {
    const days = bdFromToday(closing);
    const open = openDuties.filter(
      (d) => d.materiality !== 'standard' && d.key !== WIRE_CHECK_KEY && isOpenDuty(d.status),
    );
    if (days >= 0 && days <= 2 && open.length)
      red.push({
        code: 'closing_with_open_work',
        level: 'red',
        words: `Closing is ${days === 0 ? 'today' : fmtDateShort(closing)} and ${open.length} material ${plural(open.length, 'duty is', 'duties are')} still open.`,
        next: 'Finish them, or get an owner to decide on each.',
        keys: ['closing'],
      });
  }

  for (const p of input.dateProblems)
    (p.severity === 'problem' ? red : yellow).push({
      code: p.severity === 'problem' ? 'date_problem' : 'date_warning',
      level: p.severity === 'problem' ? 'red' : 'yellow',
      words: p.words,
      next: 'Check the dates with the other side, and correct whichever is wrong.',
      keys: [...p.keys],
    });

  // Round four: contingencies, what duties wait on, the linked deal, what was read, and waits past their chase.
  for (const c of input.contingencies ?? []) {
    const clock = contingencyClock(c.end, today, cal);
    const what = `The ${inSentence(c.label)} contingency`;
    if (clock === 'passed')
      red.push({
        code: 'contingency_passed',
        level: 'red',
        words: `${what} ended ${fmtDateShort(c.end!)}, and how it ended isn’t recorded.`,
        next: 'Record whether it was satisfied, waived or expired, with the signed form.',
        keys: [`contingency:${c.id}`],
      });
    else if (clock === 'ending')
      yellow.push({
        code: 'contingency_ending',
        level: 'yellow',
        words: `${what} ends ${c.end === today ? 'today' : fmtDateShort(c.end!)}.`,
        next: 'Get the signed form, then record how it ended.',
        keys: [`contingency:${c.id}`],
      });
  }
  const byId = new Map(duties.map((d) => [d.id, d]));
  for (const w of input.waits ?? []) {
    const d = byId.get(w.dutyId);
    const first = byId.get(w.dependsOnId);
    if (!d || !first || !isOpenDuty(d.status) || isDoneDuty(first.status) || !d.dueDate) continue;
    if (bdFromToday(d.dueDate) > 3) continue;
    const late = !!first.dueAt && Date.parse(first.dueAt) <= now;
    (late ? red : yellow).push({
      code: 'prerequisite_open',
      level: late ? 'red' : 'yellow',
      words: `“${d.title}” is due ${d.dueDate === today ? 'today' : fmtDateShort(d.dueDate)} and waits on “${first.title}”, which is ${late ? 'overdue' : 'still open'}.`,
      next: late
        ? `Get “${first.title}” done first, or move what waits on it.`
        : `Make sure “${first.title}” is done first.`,
      ...at(d),
    });
  }
  for (const l of input.linked ?? [])
    red.push({
      code: 'linked_conflict',
      level: 'red',
      words: l.words,
      next: l.next,
      keys: [...l.keys],
    });
  const read = input.readsWaiting ?? 0;
  if (read > 0)
    yellow.push({
      code: 'read_waiting',
      level: 'yellow',
      words: `${read} ${plural(read, 'value', 'values')} read from the deal’s contracts ${plural(read, 'waits', 'wait')} to be confirmed.`,
      next: 'Check each one beside its clause, then confirm it.',
    });
  for (const d of duties) {
    if (d.status !== 'waiting_external' || !d.chaseAt || Date.parse(d.chaseAt) > now) continue;
    yellow.push({
      code: 'waiting_long',
      level: 'yellow',
      words: `“${d.title}” is waiting on ${d.waitingOn ?? 'someone outside'}, past the day to chase them.`,
      next: 'Chase them, then say when you did.',
      ...at(d),
    });
  }

  return {
    level: red.length ? 'red' : yellow.length ? 'yellow' : 'green',
    reasons: [...red, ...yellow],
  };
}
