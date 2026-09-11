import { and, eq } from 'drizzle-orm';
import { leads, tasks } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { requireCompany, requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman, userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
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
  input: { personId?: string | null; companyId?: string | null; leadId?: string | null },
) {
  const workspaceId = ctx.scope.workspaceId!;
  if (input.personId) await requirePerson(ctx.tx, workspaceId, input.personId);
  if (input.companyId) await requireCompany(ctx.tx, workspaceId, input.companyId);
  if (input.leadId) {
    const [lead] = await ctx.tx
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, workspaceId)));
    if (!lead) throw HfosError.notFound('Lead not found.');
  }
}

async function loadTask(ctx: CommandContext, taskId: string) {
  const [task] = await ctx.tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, ctx.scope.workspaceId!)));
  if (!task) throw HfosError.notFound('Task not found.');
  return task;
}

export const taskCreate = defineCommand({
  name: 'task.create',
  description: 'Add a task, optionally tied to a person, company or lead and assigned to someone.',
  risk: 1,
  input: TaskCreateInput,
  output: TaskCreateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['task.created'],
  async handler(ctx, input) {
    await checkRelated(ctx, input);
    const [row] = await ctx.tx
      .insert(tasks)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        title: input.title,
        notes: input.notes ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        allDay: input.allDay,
        assigneeUserId: input.assigneeUserId ?? null,
        personId: input.personId ?? null,
        companyId: input.companyId ?? null,
        leadId: input.leadId ?? null,
        createdBy: userIdOf(ctx.actor),
      })
      .returning({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt });
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
  description: 'Change a task’s title, notes, due date, assignee or related records.',
  risk: 1,
  input: TaskUpdateInput,
  output: TaskUpdateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['task.updated'],
  async handler(ctx, input) {
    const current = await loadTask(ctx, input.taskId);
    await checkRelated(ctx, input);
    const patch: Record<string, unknown> = {};
    const set = (key: keyof typeof current, value: unknown) => {
      if (value !== undefined && value !== current[key]) patch[key] = value;
    };
    set('title', input.title);
    set('notes', input.notes);
    if (input.dueAt !== undefined) {
      const next = input.dueAt ? new Date(input.dueAt) : null;
      if ((next?.getTime() ?? null) !== (current.dueAt?.getTime() ?? null)) patch.dueAt = next;
    }
    set('allDay', input.allDay);
    set('assigneeUserId', input.assigneeUserId);
    set('personId', input.personId);
    set('companyId', input.companyId);
    set('leadId', input.leadId);
    const updated = Object.keys(patch);
    if (updated.length === 0) return { taskId: current.id, updated: [] };
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
    return { taskId: current.id, updated };
  },
});

export const taskComplete = defineCommand({
  name: 'task.complete',
  description: 'Mark a task done.',
  risk: 1,
  input: TaskCompleteInput,
  output: TaskCompleteOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['task.completed'],
  async handler(ctx, input) {
    const current = await loadTask(ctx, input.taskId);
    if (current.doneAt) return { taskId: current.id, doneAt: current.doneAt.toISOString() };
    const doneAt = new Date();
    await ctx.tx
      .update(tasks)
      .set({ doneAt, doneBy: requireHuman(ctx).userId })
      .where(eq(tasks.id, current.id));
    const eventId = await ctx.emit({
      type: 'task.completed',
      entityType: 'task',
      entityId: current.id,
      payload: { title: current.title },
      before: { title: current.title, done: false },
      after: { title: current.title, done: true },
    });
    if (current.personId || current.companyId || current.leadId) {
      await logSystemActivity(ctx, {
        subtype: 'task_done',
        personId: current.personId,
        companyId: current.companyId,
        leadId: current.leadId,
        body: current.title,
        meta: { taskId: current.id },
        eventId,
      });
    }
    return { taskId: current.id, doneAt: doneAt.toISOString() };
  },
});

export const taskReopen = defineCommand({
  name: 'task.reopen',
  description: 'Reopen a completed task.',
  risk: 1,
  input: TaskReopenInput,
  output: TaskReopenOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['task.reopened'],
  async handler(ctx, input) {
    const current = await loadTask(ctx, input.taskId);
    if (!current.doneAt) return { taskId: current.id };
    await ctx.tx.update(tasks).set({ doneAt: null, doneBy: null }).where(eq(tasks.id, current.id));
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
  description: 'Delete a task you created (owners and admins can delete any).',
  risk: 2,
  input: TaskDeleteInput,
  output: TaskDeleteOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['task.deleted'],
  async handler(ctx, input) {
    const current = await loadTask(ctx, input.taskId);
    const deleted = await ctx.tx
      .delete(tasks)
      .where(eq(tasks.id, current.id))
      .returning({ id: tasks.id });
    if (deleted.length === 0)
      throw HfosError.forbidden(
        'Only the person who created this task, or an owner or admin, can delete it.',
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
