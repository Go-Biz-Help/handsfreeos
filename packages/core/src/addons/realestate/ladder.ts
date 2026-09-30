/**
 * The alert ladder (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Health and alerts"): where a duty stands against
 * its due time, and the alert that says so. Browser-safe and pure; the worker's sweep raises what this says through
 * core's add-on alerts (step 5), one alert per duty that climbs as it goes.
 *
 * - **Seven days out:** a Home card. **Three days and one day out:** a push too, and an email for material work.
 * - **Overdue:** at risk, to the person answering for it. **A business day late:** at risk and asking to be
 *   acknowledged, to them, the main agent and the coordinator.
 * - **Critical:** a critical duty once it's overdue, or a material one two business days late: to everyone who sees
 *   the deal, at any hour. Everything else waits for the business's working hours.
 */
import { fmtDateShort } from '../../calendar/when';
import type { Materiality } from './catalog/types';
import { businessDaysBetween, type BusinessCalendar } from './dates/business-days';
import { WIRE_CHECK_KEY } from './own-duties';
import { isOpenDuty, type DutyStatus } from './states';

export const RUNGS = ['week', 'days', 'day', 'overdue', 'late', 'critical'] as const;
export type Rung = (typeof RUNGS)[number];

const DAY = 86_400_000;

export interface LadderDuty {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly status: DutyStatus;
  readonly materiality: Materiality;
  readonly dueAt: string | null;
  readonly dueDate: string | null;
}

/** Where a duty stands on the ladder now, or null when it has nothing to say (not due soon, or not open). */
export function rungOf(
  d: LadderDuty,
  now: number,
  today: string,
  calendar?: BusinessCalendar,
): Rung | null {
  if (!isOpenDuty(d.status) || !d.dueAt || d.key === WIRE_CHECK_KEY) return null;
  const due = Date.parse(d.dueAt);
  const ahead = due - now;
  if (ahead > 7 * DAY) return null;
  if (ahead > 3 * DAY) return 'week';
  if (ahead > DAY) return 'days';
  if (ahead > 0) return 'day';
  if (d.materiality === 'critical') return 'critical';
  const late = d.dueDate ? businessDaysBetween(d.dueDate, today, calendar) : 0;
  if (d.materiality === 'material' && late >= 2) return 'critical';
  if (late >= 1) return 'late';
  return 'overdue';
}

/**
 * The moment a duty reached its rung (as best the ladder can say): a rung reached before the add-on was last turned
 * on is caught up quietly, as a Home card, never sent late.
 */
export function rungSince(rung: Rung, d: LadderDuty): number {
  const due = Date.parse(d.dueAt!);
  switch (rung) {
    case 'week':
      return due - 7 * DAY;
    case 'days':
      return due - 3 * DAY;
    case 'day':
      return due - DAY;
    case 'overdue':
      return due;
    case 'late':
    case 'critical':
      // A business day or two after; the day after due is near enough to decide "was it while off?".
      return due + DAY;
  }
}

export interface LadderAlert {
  readonly severity: 'info' | 'attention' | 'at_risk' | 'critical';
  readonly title: string;
  readonly needsAck: boolean;
  /** Push (and email when `email`) as well as Home. */
  readonly notify: boolean;
  readonly email: boolean;
  /** Who it's for: the person answering for it, or them with the main agent and coordinator; empty is everyone
   *  who sees the deal. */
  readonly audience: 'accountable' | 'team' | 'everyone';
}

/** What a duty's alert says on its rung. */
export function ladderAlert(rung: Rung, d: LadderDuty): LadderAlert {
  const when = d.dueDate ? fmtDateShort(d.dueDate) : 'soon';
  const weighty = d.materiality !== 'standard';
  switch (rung) {
    case 'week':
      return {
        severity: 'info',
        title: `“${d.title}” is due ${when}`,
        needsAck: false,
        notify: false,
        email: false,
        audience: 'accountable',
      };
    case 'days':
    case 'day':
      return {
        severity: 'attention',
        title: `“${d.title}” is due ${rung === 'day' ? 'within a day' : when}`,
        needsAck: false,
        notify: true,
        email: weighty,
        audience: 'accountable',
      };
    case 'overdue':
      return {
        severity: 'at_risk',
        title: `“${d.title}” is overdue`,
        needsAck: false,
        notify: true,
        email: true,
        audience: 'accountable',
      };
    case 'late':
      return {
        severity: 'at_risk',
        title: `“${d.title}” is late: it was due ${when}`,
        needsAck: true,
        notify: true,
        email: true,
        audience: 'team',
      };
    case 'critical':
      return {
        severity: 'critical',
        title: `“${d.title}” is overdue and critical`,
        needsAck: true,
        notify: true,
        email: true,
        audience: 'everyone',
      };
  }
}

/** How high each severity sits, to keep an acknowledged alert from climbing. */
export const SEVERITY_RANK = { info: 0, attention: 1, at_risk: 2, critical: 3 } as const;
