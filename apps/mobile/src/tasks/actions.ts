import { change, newId } from '@/changes';

/**
 * Completing, reopening, creating and assigning a task. All of them are "any time" commands, so they work with no
 * signal: the circle fills in at once and the change waits in the queue.
 */

const nowIso = () => new Date().toISOString();

export function completeTask(workspaceId: string, taskId: string, userId: string) {
  const at = nowIso();
  return change(
    'task.complete',
    { workspaceId, taskId },
    {
      optimistic: (tx) =>
        tx.execute('UPDATE tasks SET done_at = ?, done_by = ?, updated_at = ? WHERE id = ?', [
          at,
          userId,
          at,
          taskId,
        ]),
    },
  );
}

export function reopenTask(workspaceId: string, taskId: string) {
  return change(
    'task.reopen',
    { workspaceId, taskId },
    {
      optimistic: (tx) =>
        tx.execute('UPDATE tasks SET done_at = NULL, done_by = NULL, updated_at = ? WHERE id = ?', [
          nowIso(),
          taskId,
        ]),
    },
  );
}

export interface NewTask {
  readonly title: string;
  readonly dueAt: string | null;
  readonly allDay: boolean;
  readonly assigneeUserId: string | null;
  readonly personId?: string | null;
  readonly companyId?: string | null;
  readonly leadId?: string | null;
}

/**
 * Add a task, with an id this phone made so anything about it can point at it before it has been sent. The row
 * written here carries who made it, because Mine counts a task nobody is assigned as its author's.
 */
export async function addTask(
  workspaceId: string,
  task: NewTask,
  createdBy: string | null = null,
): Promise<string> {
  const id = newId();
  const at = nowIso();
  await change(
    'task.create',
    {
      workspaceId,
      id,
      title: task.title.trim(),
      dueAt: task.dueAt,
      allDay: task.allDay,
      assigneeUserId: task.assigneeUserId,
      personId: task.personId ?? null,
      companyId: task.companyId ?? null,
      leadId: task.leadId ?? null,
    } as never,
    {
      optimistic: (tx) =>
        tx.execute(
          `INSERT INTO tasks (id, workspace_id, title, due_at, all_day, assignee_user_id,
             person_id, company_id, lead_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            workspaceId,
            task.title.trim(),
            task.dueAt,
            task.allDay ? 1 : 0,
            task.assigneeUserId,
            task.personId ?? null,
            task.companyId ?? null,
            task.leadId ?? null,
            createdBy,
            at,
            at,
          ],
        ),
    },
  );
  return id;
}

/** Hand a task to a teammate: only the assignee changes, with the one the screen showed. */
export function assignTask(
  workspaceId: string,
  taskId: string,
  assigneeUserId: string | null,
  seen: string | null,
) {
  return change(
    'task.update',
    { workspaceId, taskId, assigneeUserId, base: { assigneeUserId: seen } } as never,
    {
      optimistic: (tx) =>
        tx.execute('UPDATE tasks SET assignee_user_id = ?, updated_at = ? WHERE id = ?', [
          assigneeUserId,
          nowIso(),
          taskId,
        ]),
    },
  );
}

/** Change when a task is due: only the date, with what the screen showed. */
export function setTaskDue(
  workspaceId: string,
  taskId: string,
  dueAt: string | null,
  allDay: boolean,
  seen: string | null,
) {
  return change(
    'task.update',
    { workspaceId, taskId, dueAt, allDay, base: { dueAt: seen } } as never,
    {
      optimistic: (tx) =>
        tx.execute('UPDATE tasks SET due_at = ?, all_day = ?, updated_at = ? WHERE id = ?', [
          dueAt,
          allDay ? 1 : 0,
          nowIso(),
          taskId,
        ]),
    },
  );
}
