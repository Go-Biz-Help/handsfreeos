/**
 * Tasks due (the owner, 25 Nov 2026, reminders first): a task with a time pings whoever has it at that time, with Done
 * and In 1 hour. "Remind me at 3 PM to call Bob" is such a task, which the Assistant makes (create_task).
 *
 * Armed whenever a task is made, changed or reopened with a time still ahead; the job reads the task again when it
 * runs, so one ticked off, moved, taken off its time or put in the Deleted bin since says nothing, and one moved later
 * waits for its new time. A task due on a day, with no time, never pings: the morning email and Home have those.
 */
import { scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { queuePush } from '../push/queue';
import { tenantOf } from '../services';

export const TASK_DUE_JOB = 'tasks.due';
export const taskDueKey = (taskId: string): string => `task-due:${taskId}`;
/** A task's ping this late (the worker was down for it) is left out: the task list has it, and it's old news. */
export const TASK_DUE_LATE_MS = 2 * 60 * 60_000;
/** Early by less than this, it goes now rather than waiting again. */
const EARLY_MS = 30_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

interface DueTask extends Record<string, unknown> {
  title: string;
  due_at: Date | null;
  all_day: boolean;
  done_at: Date | null;
  bin_item_id: string | null;
  assignee_user_id: string | null;
  created_by: string | null;
  person_id: string | null;
  lead_id: string | null;
  customer: string | null;
}

/** A task made, changed or reopened: its ping at its time, when it has one still ahead. */
export const onArmTaskDue: EventHandler = async (ctx) => {
  const taskId = ctx.event.entityId;
  if (!taskId) return;
  const scope = tenantOf(ctx.scope);
  const [t] = await rows<{ due_at: Date | null; all_day: boolean; done_at: Date | null }>(
    ctx.tx,
    sql`select due_at, all_day, done_at from app.tasks
        where id = ${taskId} and workspace_id = ${scope.workspaceId} and bin_item_id is null`,
  );
  if (!t?.due_at || t.all_day || t.done_at) return;
  const due = new Date(t.due_at);
  // Already past when it was set: nobody needs a ping for a time that's gone.
  if (due.getTime() < ctx.event.createdAt.getTime() - 60_000) return;
  await scheduleJob(
    ctx.tx,
    {
      kind: TASK_DUE_JOB,
      dedupeKey: taskDueKey(taskId),
      runAt: due,
      payload: { taskId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
};

export const taskDueJob: JobHandler = async (ctx) => {
  const taskId = str((ctx.job.payload ?? {})['taskId']);
  if (!taskId) return;
  const scope = tenantOf(ctx.scope);
  return asWorker(ctx.db, scope, async (tx) => {
    const [t] = await rows<DueTask>(
      tx,
      sql`select t.title, t.due_at, t.all_day, t.done_at, t.bin_item_id, t.assignee_user_id, t.created_by,
            t.person_id, t.lead_id,
            nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') as customer
          from app.tasks t left join app.people p on p.id = t.person_id
          where t.id = ${taskId} and t.workspace_id = ${scope.workspaceId}`,
    );
    if (!t?.due_at || t.all_day || t.done_at || t.bin_item_id) return;
    const due = new Date(t.due_at).getTime();
    // Moved later since it was armed: wait for the new time.
    if (ctx.now < due - EARLY_MS) return { rescheduleAt: new Date(due) };
    if (ctx.now - due > TASK_DUE_LATE_MS) return;
    // Whoever has it, else whoever made it; either only while they still work here.
    const [who] = await rows<{ id: string }>(
      tx,
      sql`select u.id from (values (${t.assignee_user_id ?? t.created_by}::uuid)) as u(id)
          where u.id is not null and (
            exists (select 1 from app.workspace_memberships wm
                    where wm.workspace_id = ${scope.workspaceId} and wm.user_id = u.id)
            or exists (select 1 from app.organization_memberships om
                       join app.workspaces w on w.organization_id = om.organization_id
                       where w.id = ${scope.workspaceId} and om.user_id = u.id))`,
    );
    if (!who) return;
    await queuePush(tx, scope, {
      // One ping for each time it's due: a task moved to a new time pings again then.
      key: `${taskDueKey(taskId)}:${due}`,
      category: 'task_due',
      userIds: [who.id],
      title: 'Reminder',
      about: 'Task',
      body: t.customer ? `${t.title} · ${t.customer}` : t.title,
      path: `/app/w/${scope.workspaceId}/tasks`,
      refs: {
        taskId,
        ...(t.person_id ? { personId: t.person_id } : {}),
        ...(t.lead_id ? { leadId: t.lead_id } : {}),
      },
      collapseId: `task-${taskId}`,
    });
  });
};
