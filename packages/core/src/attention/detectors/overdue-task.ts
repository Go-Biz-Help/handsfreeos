/**
 * An overdue task: a to-do past its due time. An all-day task is overdue once its day is over in the business's
 * time zone, as the task list says. HandsFreeOS doesn't handle it: it's a person's own to-do.
 */
import { addDays, localDateOf, startOfLocalDay } from '../../calendar/engine/zoned';
import { sinceChip } from '../chips';
import { leadValue, type BusinessFacts, type LinkedLeadFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { defineDetector, detection, ms, stamp, valueChips, type Assessment } from './define';

export interface OverdueTaskFacts {
  readonly business: BusinessFacts;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly dueAt: string | null;
    readonly allDay: boolean;
    readonly doneAt: string | null;
    readonly assigneeUserId: string | null;
  };
  /** The task's lead, for the value. */
  readonly lead: LinkedLeadFacts | null;
}

function assess(f: OverdueTaskFacts, settings: AttentionSettings, now: number): Assessment {
  const t = f.task;
  if (t.doneAt || !t.dueAt) return null;
  const due = ms(t.dueAt);
  const tz = f.business.timeZone;
  const overdueFrom = t.allDay ? startOfLocalDay(addDays(localDateOf(due, tz), 1), tz) : due;
  if (now < overdueFrom) return { wakeAt: overdueFrom };
  const value = leadValue(f.lead, f.business, settings);
  return detection({
    fingerprint: fingerprintOf('overdue_task', { task: t.id, due: stamp(due) }),
    since: overdueFrom,
    urgentFrom: null,
    dueAt: due,
    value,
    probability: 0.4,
    confidence: 0.6,
    reasons: [...valueChips(value), sinceChip('overdue', overdueFrom, now)],
    assignee: t.assigneeUserId,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<OverdueTaskFacts>('overdue_task', assess);
