import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { CompanyRef, ListInput, PersonRef, UserRef } from './crm';

const title = z.string().trim().min(1, 'Enter a task.').max(200);
const taskNotes = z.string().trim().max(5000).nullable().optional();

export const TaskCreateInput = z.object({
  workspaceId: uuid,
  title,
  notes: taskNotes,
  dueAt: isoDateTime.nullable().optional(),
  allDay: z.boolean().default(true),
  assigneeUserId: uuid.nullable().optional(),
  personId: uuid.nullable().optional(),
  companyId: uuid.nullable().optional(),
  leadId: uuid.nullable().optional(),
});
export const TaskCreateOutput = z.object({ taskId: uuid });
export const TaskUpdateInput = z.object({
  workspaceId: uuid,
  taskId: uuid,
  title: title.optional(),
  notes: taskNotes,
  dueAt: isoDateTime.nullable().optional(),
  allDay: z.boolean().optional(),
  assigneeUserId: uuid.nullable().optional(),
  personId: uuid.nullable().optional(),
  companyId: uuid.nullable().optional(),
  leadId: uuid.nullable().optional(),
});
export const TaskUpdateOutput = z.object({ taskId: uuid, updated: z.array(z.string()) });
export const TaskCompleteInput = z.object({ workspaceId: uuid, taskId: uuid });
export const TaskCompleteOutput = z.object({ taskId: uuid, doneAt: isoDateTime });
export const TaskReopenInput = z.object({ workspaceId: uuid, taskId: uuid });
export const TaskReopenOutput = z.object({ taskId: uuid });
export const TaskDeleteInput = z.object({ workspaceId: uuid, taskId: uuid });
export const TaskDeleteOutput = z.object({ taskId: uuid });

export const dueBucket = z.enum(['overdue', 'today', 'week', 'later', 'none']);
export const TaskOut = z.object({
  id: uuid,
  title: z.string(),
  notes: z.string().nullable(),
  dueAt: isoDateTime.nullable(),
  allDay: z.boolean(),
  dueBucket,
  assignee: UserRef,
  person: PersonRef.nullable(),
  company: CompanyRef.nullable(),
  lead: z.object({ id: uuid, title: z.string() }).nullable(),
  doneAt: isoDateTime.nullable(),
  doneBy: UserRef,
  createdBy: UserRef,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type TaskOut = z.infer<typeof TaskOut>;

export const TaskListInput = ListInput.extend({
  workspaceId: uuid,
  scope: z.enum(['mine', 'all']).default('mine'),
  status: z.enum(['open', 'done', 'all']).default('open'),
  personId: uuid.optional(),
  companyId: uuid.optional(),
  leadId: uuid.optional(),
});
export const TaskListOutput = z.object({
  items: z.array(TaskOut),
  nextCursor: z.string().nullable(),
  timezone: z.string(),
});
