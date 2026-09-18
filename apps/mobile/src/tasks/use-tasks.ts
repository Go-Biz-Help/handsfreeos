import { taskOfSynced, TASK_GROUPS, type DueBucket, type TaskOut } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import { useNames } from '@/customers/names';
import { useRecordChanges, stateOf, type RecordChange } from '@/customers/outbox';
import { useTimeZone } from '@/customers/use-record';
import { TASKS_SQL } from '@/customers/queries';

/**
 * The business's tasks from the phone's copy, grouped and ordered as the web's Tasks page groups them: overdue, today,
 * this week, later, no due date, then what was finished lately. The groups and the due words are core's, and the
 * buckets are worked out **where the business is**, not where the phone is — "today" in Houston is what a task means.
 */

export type TaskScope = 'mine' | 'all';

export interface TaskGroupItems {
  readonly key: DueBucket;
  readonly label: string;
  readonly tone: 'danger' | 'accent' | 'muted';
  readonly items: readonly TaskOut[];
}

export interface TaskList {
  readonly loading: boolean;
  readonly open: readonly TaskOut[];
  readonly groups: readonly TaskGroupItems[];
  readonly done: readonly TaskOut[];
  readonly counts: { readonly mine: number; readonly all: number };
  readonly timeZone: string;
  readonly changes: readonly RecordChange[];
}

/** Done lately: what was finished in the last week, newest first, as the web's "Recently done" list shows. */
const DONE_WINDOW_MS = 7 * 86_400_000;

export function useTasks(scope: TaskScope): TaskList {
  const { business, me } = useBusiness();
  const names = useNames();
  const timeZone = useTimeZone();
  const changes = useRecordChanges();
  const { data: rows, isLoading } = useQuery<Record<string, string | null>>(TASKS_SQL, [
    business.id,
  ]);

  return React.useMemo(() => {
    const now = new Date();
    const all = rows.map((row) => taskOfSynced(row as never, names, timeZone, now));
    const mineOf = (t: TaskOut, row: Record<string, string | null>) =>
      t.assignee?.id === me.user.id || (!t.assignee && row.created_by === me.user.id);
    const mine = all.filter((t, i) => mineOf(t, rows[i]!));
    const chosen = scope === 'mine' ? mine : all;
    const open = chosen
      .filter((t) => !t.doneAt)
      .sort((a, b) =>
        a.dueAt === b.dueAt
          ? a.id.localeCompare(b.id)
          : (a.dueAt ?? '9999') < (b.dueAt ?? '9999')
            ? -1
            : 1,
      );
    const done = chosen
      .filter((t) => t.doneAt && now.getTime() - Date.parse(t.doneAt) < DONE_WINDOW_MS)
      .sort((a, b) => (a.doneAt! < b.doneAt! ? 1 : -1));
    const groups = TASK_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      tone: g.tone,
      items: open.filter((t) => t.dueBucket === g.key),
    })).filter((g) => g.items.length > 0);
    return {
      loading: isLoading,
      open,
      groups,
      done,
      counts: {
        mine: mine.filter((t) => !t.doneAt).length,
        all: all.filter((t) => !t.doneAt).length,
      },
      timeZone,
      changes,
    };
  }, [rows, names, timeZone, scope, me.user.id, changes, isLoading]);
}

/** Whether a task has a change of its own still waiting on this phone. */
export function taskState(changes: readonly RecordChange[], taskId: string) {
  return stateOf(changes, taskId);
}
