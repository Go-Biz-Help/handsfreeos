/**
 * Tasks: when one is due, which group it falls in, and every word the list says (M10 step 15). Browser-safe, so the
 * web's Tasks page and the phone's read the same.
 *
 * The due bucket used to be worked out in `task.list`'s SQL, which a phone can't run. It's here now, and the query
 * calls it, so there is one rule rather than two that could drift. It needs the **workspace's** zone, because "today"
 * for a business in Houston is not today for a phone in Denver: an all-day task is compared by the day it falls on
 * there, and a task with a time by the moment itself.
 */
import { zonedParts } from '../calendar/engine/zoned';
import { formatDate, timeOfDay } from './format';

export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';

export interface TaskDue {
  readonly dueAt: string | Date | null;
  readonly allDay: boolean;
  readonly doneAt: string | Date | null;
}

const at = (v: string | Date | null): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The day a moment falls on where the business is, as a number that sorts: 20260921. */
const dayNumber = (d: Date, timeZone: string): number => {
  const p = zonedParts(d, timeZone);
  return p.year * 10_000 + p.month * 100 + p.day;
};

/** That same day number, `days` days on, counted on the calendar rather than in milliseconds (so DST can't shift it). */
const dayNumberPlus = (d: Date, timeZone: string, days: number): number => {
  const p = zonedParts(d, timeZone);
  const rolled = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return rolled.getUTCFullYear() * 10_000 + (rolled.getUTCMonth() + 1) * 100 + rolled.getUTCDate();
};

/**
 * Which group a task belongs to: nothing due and anything done are `none`; an all-day task is overdue once the day it
 * falls on is behind the business's today, and one with a time once that moment has passed; `today` is the same day
 * there; `week` is inside the next seven days; everything else is `later`.
 */
export function taskDueBucket(task: TaskDue, timeZone: string, now: Date = new Date()): DueBucket {
  const due = at(task.dueAt);
  if (!due || at(task.doneAt)) return 'none';
  const dueDay = dayNumber(due, timeZone);
  const today = dayNumber(now, timeZone);
  if (task.allDay ? dueDay < today : due.getTime() < now.getTime()) return 'overdue';
  if (dueDay === today) return 'today';
  return dueDay < dayNumberPlus(now, timeZone, 7) ? 'week' : 'later';
}

export type DueTone = 'danger' | 'accent' | 'muted';

/**
 * The end of a task's row: "Overdue · Sep 21, 10:00 AM" in red, "Today 2:00 PM" in the accent, "Sep 25" and
 * "Done Sep 13" quiet.
 */
export function dueLabel(
  task: TaskDue & { readonly dueBucket: DueBucket },
  now: Date = new Date(),
): { readonly text: string; readonly tone: DueTone } {
  const done = at(task.doneAt);
  if (done) return { text: `Done ${formatDate(done.toISOString(), {}, now)}`, tone: 'muted' };
  const due = at(task.dueAt);
  if (!due) return { text: 'No due date', tone: 'muted' };
  const when = formatDate(due.toISOString(), { time: !task.allDay }, now);
  if (task.dueBucket === 'overdue') return { text: `Overdue · ${when}`, tone: 'danger' };
  if (task.dueBucket === 'today')
    return { text: task.allDay ? 'Today' : `Today ${timeOfDay(due)}`, tone: 'accent' };
  return { text: when, tone: 'muted' };
}

export interface TaskGroup {
  readonly key: DueBucket;
  readonly label: string;
  readonly tone: DueTone;
}

/** The groups the Tasks page shows, in order. */
export const TASK_GROUPS: readonly TaskGroup[] = [
  { key: 'overdue', label: 'Overdue', tone: 'danger' },
  { key: 'today', label: 'Today', tone: 'accent' },
  { key: 'week', label: 'This week', tone: 'muted' },
  { key: 'later', label: 'Later', tone: 'muted' },
  { key: 'none', label: 'No due date', tone: 'muted' },
];

/** "Dale · Roof replacement · Mike Johnson" under a task's title. */
export function taskRelatedLine(task: {
  readonly lead?: { readonly title: string } | null;
  readonly person?: { readonly fullName: string } | null;
  readonly company?: { readonly name: string } | null;
}): string {
  return [task.lead?.title, task.person?.fullName, task.company?.name].filter(Boolean).join(' · ');
}

export const TASK_WORDS = {
  title: 'Tasks',
  newTask: 'New task',
  unassigned: 'Unassigned',
  completed: 'Task completed.',
  deleted: 'Task deleted.',
  emptyTitle: 'No tasks',
  emptyBody: 'Nothing to do here yet.',
  nothingOnYourList: 'Nothing on your list',
  noOpenTasks: 'No open tasks',
  emptyPageBody:
    'Tasks you create from a customer or lead show up here, sorted by when they are due.',
  /** The web's heading over what was finished lately; the canvas calls the same section "Done lately". */
  recentlyDone: 'Recently done',
  doneLately: 'Done lately',
  mine: 'Mine',
  everyone: 'Everyone',
  complete: 'Complete task',
  reopen: 'Reopen task',
  openLead: 'Open lead',
  edit: 'Edit',
  delete: 'Delete',
} as const;

/** "6 open · due dates in America/Chicago", the line under the Tasks heading. */
export function tasksSummary(openCount: number, timeZone: string): string {
  return `${openCount} open · due dates in ${timeZone.replace(/_/g, ' ')}`;
}
