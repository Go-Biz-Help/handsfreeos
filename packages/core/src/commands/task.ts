import { and, eq } from 'drizzle-orm';
import { leads, tasks } from '@hfos/db/schema';
import { assertAiReach } from '../ai-team/reach';
import { logSystemActivity } from '../crm/activities';
import { insertWithId, madeBefore } from '../crm/client-ids';
import { requireCompany, requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  logNotApplied,
  mergeColumns,
  mergeFields,
  type MergeField,
  type MergeKind,
} from '../kernel/field-merge';
import { changedSince, logLaterChange, whoChangedIt } from '../kernel/later-change';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import { requireCustomRecord } from '../relationships/store';
import {
  TaskCompleteInput,
  TaskCompleteOutput,
  TaskCreateInput,
  TaskCreateOutput,
  TaskDeleteInput,
  TaskDeleteOutput,
  TaskReopenInput,
  TaskReopenOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
} from '../schemas/task';

async function checkRelated(
  ctx: CommandContext,
  input: {
    personId?: string | null;
    companyId?: string | null;
    leadId?: string | null;
    customRecordId?: string | null;
  },
) {
  const workspaceId = ctx.scope.workspaceId!;
  if (input.personId) await requirePerson(ctx.tx, workspaceId, input.personId);
  if (input.companyId) await requireCompany(ctx.tx, workspaceId, input.companyId);
  if (input.leadId) {
    const [lead] = await ctx.tx
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, workspaceId)));
    if (!lead)
      throw HfosError.notFound(
        'That lead isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
  }
  if (input.customRecordId) await requireCustomRecord(ctx.tx, workspaceId, input.customRecordId);
}

/** A task in this workspace (locked, for a change that compares against it); a deleted one isn't there. */
async function loadTask(ctx: CommandContext, taskId: string, opts: { lock?: boolean } = {}) {
  const query = ctx.tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, ctx.scope.workspaceId!)));
  const [task] = opts.lock ? await query.for('update') : await query;
  if (!task)
    throw HfosError.notFound(
      'That task isn’t there anymore. Someone may have deleted it. Refresh and try again.',
    );
  return task;
}

type TaskRow = Awaited<ReturnType<typeof loadTask>>;

/**
 * When the task was last ticked or reopened: `field_times.done_at`, which both write. A task ticked before they wrote it
 * has only its `done_at` to say when.
 */
const doneChangedAt = (task: TaskRow): string | Date | null =>
  task.fieldTimes['done_at'] ?? task.doneAt;

/**
 * A tick or a reopen someone overtook: they reopened or ticked the task after this change was made (on a phone, perhaps
 * long before it had signal), and theirs stands. Written on the task's customer, company or lead.
 */
async function overtaken(
  ctx: CommandContext,
  task: TaskRow,
  tried: string,
  did: { readonly by: string; readonly was: string },
) {
  const at = doneChangedAt(task);
  const who = await whoChangedIt(
    ctx.tx,
    { type: 'task', id: task.id },
    ['task.completed', 'task.reopened'],
    at,
  );
  await logLaterChange(
    ctx,
    {
      key: 'done',
      tried,
      because: `${who ? `${who} ${did.by}` : `it was ${did.was}`} after that`,
      changedAt: at,
    },
    { type: 'task', id: task.id },
    {
      personId: task.personId,
      companyId: task.companyId,
      leadId: task.leadId,
      customRecordId: task.customRecordId,
    },
  );
}

export const taskCreate = defineCommand({
  name: 'task.create',
  description:
    'Add a task, optionally tied to a person, company or lead, or to a record like a pet, vehicle or property, and assigned to someone.',
  risk: 1,
  input: TaskCreateInput,
  output: TaskCreateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['task.created'],
  // The system too, for an add-on acting for someone: Sales Coach turns what a rep promised on a call into tasks.
  actors: ['human', 'workflow', 'ai_employee', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    await assertAiReach(ctx, input);
    const earlier = await madeBefore(ctx.tx, 'tasks', input.id, ctx.scope.workspaceId!);
    if (earlier) return { taskId: earlier.id };
    await checkRelated(ctx, input);
    const [row] = await insertWithId('tasks', input.id, () =>
      ctx.tx
        .insert(tasks)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId: ctx.scope.workspaceId!,
          title: input.title,
          notes: input.notes ?? null,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          allDay: input.allDay,
          assigneeUserId: input.assigneeUserId ?? null,
          personId: input.personId ?? null,
          companyId: input.companyId ?? null,
          leadId: input.leadId ?? null,
          customRecordId: input.customRecordId ?? null,
          createdBy: userIdOf(ctx.actor),
        })
        .returning({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt }),
    );
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'task.created',
      entityType: 'task',
      entityId: row.id,
      payload: { title: row.title, assigneeUserId: input.assigneeUserId ?? null },
      after: {
        title: row.title,
        dueAt: row.dueAt?.toISOString() ?? null,
        assigneeUserId: input.assigneeUserId ?? null,
      },
    });
    return { taskId: row.id };
  },
});

export const taskUpdate = defineCommand({
  name: 'task.update',
  description:
    'Change a task’s title, notes, due date, assignee or related records: only what was edited, each with what the editor saw, and the newest change to each wins.',
  risk: 1,
  input: TaskUpdateInput,
  output: TaskUpdateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['task.updated'],
  offline: 'anytime',
  async handler(ctx, input) {
    const current = await loadTask(ctx, input.taskId, { lock: true });
    await checkRelated(ctx, input);
    const seen: NonNullable<typeof input.base> = input.base ?? {};
    const field = (
      key: keyof typeof seen,
      value: unknown,
      kind: MergeKind,
      label: string,
    ): MergeField => ({ key, column: key, value, base: seen[key], kind, label });
    const merged = mergeFields(
      current,
      [
        field('title', input.title, 'text', 'title'),
        field('notes', input.notes, 'text', 'notes'),
        field(
          'dueAt',
          input.dueAt === undefined ? undefined : input.dueAt ? new Date(input.dueAt) : null,
          'time',
          'due date',
        ),
        field('allDay', input.allDay, 'flag', 'all-day'),
        field('assigneeUserId', input.assigneeUserId, 'id', 'assignee'),
        field('personId', input.personId, 'id', 'person'),
        field('companyId', input.companyId, 'id', 'company'),
        field('leadId', input.leadId, 'id', 'lead'),
        field('customRecordId', input.customRecordId, 'id', 'record'),
      ],
      mergeColumns(tasks),
      ctx.meta,
    );
    const { patch } = merged;
    const notApplied = merged.notApplied.map((n) => n.key);
    await logNotApplied(
      ctx,
      merged.notApplied,
      { type: 'task', id: current.id },
      {
        personId: current.personId,
        companyId: current.companyId,
        leadId: current.leadId,
        customRecordId: current.customRecordId,
      },
    );
    const updated = [...merged.applied];
    if (updated.length === 0) return { taskId: current.id, updated: [], notApplied };
    await ctx.tx.update(tasks).set(patch).where(eq(tasks.id, current.id));
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of updated) {
      const b = (current as Record<string, unknown>)[k];
      const a = patch[k];
      before[k] = b instanceof Date ? b.toISOString() : b;
      after[k] = a instanceof Date ? a.toISOString() : a;
    }
    const title = (patch.title as string | undefined) ?? current.title;
    await ctx.emit({
      type: 'task.updated',
      entityType: 'task',
      entityId: current.id,
      payload: { title, fields: updated },
      before: { title: current.title, ...before },
      after: { title, ...after },
    });
    return { taskId: current.id, updated, notApplied };
  },
});

export const taskComplete = defineCommand({
  name: 'task.complete',
  description: 'Mark a task done. Already done, nothing changes.',
  risk: 1,
  input: TaskCompleteInput,
  output: TaskCompleteOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['task.completed'],
  actors: ['human', 'workflow'],
  offline: 'anytime',
  async handler(ctx, input) {
    const current = await loadTask(ctx, input.taskId, { lock: true });
    if (current.doneAt) return { taskId: current.id, doneAt: current.doneAt.toISOString() };
    if (changedSince(ctx.meta, doneChangedAt(current))) {
      await overtaken(ctx, current, `mark the task “${current.title}” done`, {
        by: 'reopened it',
        was: 'reopened',
      });
      return { taskId: current.id, doneAt: null, notApplied: ['done'] };
    }
    // Done when the person ticked it, even if the phone only now had signal.
    const doneAt = changeMoment(ctx.meta);
    await ctx.tx
      .update(tasks)
      .set({
        doneAt,
        doneBy: userIdOf(ctx.actor),
        fieldTimes: { ...current.fieldTimes, done_at: doneAt.toISOString() },
      })
      .where(eq(tasks.id, current.id));
    const eventId = await ctx.emit({
      type: 'task.completed',
      entityType: 'task',
      entityId: current.id,
      payload: { title: current.title },
      before: { title: current.title, done: false },
      after: { title: current.title, done: true },
    });
    if (current.personId || current.companyId || current.leadId || current.customRecordId) {
      await logSystemActivity(ctx, {
        subtype: 'task_done',
        personId: current.personId,
        companyId: current.companyId,
        leadId: current.leadId,
        customRecordId: current.customRecordId,
        body: current.title,
        meta: { taskId: current.id },
        eventId,
        occurredAt: doneAt,
      });
    }
    return { taskId: current.id, doneAt: doneAt.toISOString() };
  },
});

export const taskReopen = defineCommand({
  name: 'task.reopen',
  description: 'Reopen a completed task. Already open, nothing changes.',
  risk: 1,
  input: TaskReopenInput,
  output: TaskReopenOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['task.reopened'],
  offline: 'anytime',
  async handler(ctx, input) {
    const current = await loadTask(ctx, input.taskId, { lock: true });
    if (!current.doneAt) return { taskId: current.id };
    if (changedSince(ctx.meta, doneChangedAt(current))) {
      await overtaken(ctx, current, `reopen the task “${current.title}”`, {
        by: 'marked it done',
        was: 'marked done',
      });
      return { taskId: current.id, notApplied: ['done'] };
    }
    await ctx.tx
      .update(tasks)
      .set({
        doneAt: null,
        doneBy: null,
        fieldTimes: { ...current.fieldTimes, done_at: changeMoment(ctx.meta).toISOString() },
      })
      .where(eq(tasks.id, current.id));
    await ctx.emit({
      type: 'task.reopened',
      entityType: 'task',
      entityId: current.id,
      payload: { title: current.title },
      before: { title: current.title, done: true },
      after: { title: current.title, done: false },
    });
    return { taskId: current.id };
  },
});

export const taskDelete = defineCommand({
  name: 'task.delete',
  description:
    'Delete a task you created (anyone the business lets archive records can delete any).',
  risk: 2,
  input: TaskDeleteInput,
  output: TaskDeleteOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['task.deleted'],
  offline: 'anytime',
  async handler(ctx, input) {
    const current = await loadTask(ctx, input.taskId);
    const deleted = await ctx.tx
      .delete(tasks)
      .where(eq(tasks.id, current.id))
      .returning({ id: tasks.id });
    if (deleted.length === 0)
      throw HfosError.forbidden(
        'Only whoever made this task, or someone allowed to archive customers, can delete it. Ask one of them, or mark it done instead.',
      );
    await ctx.emit({
      type: 'task.deleted',
      entityType: 'task',
      entityId: current.id,
      payload: { title: current.title },
      before: { title: current.title },
      after: null,
    });
    return { taskId: current.id };
  },
});
