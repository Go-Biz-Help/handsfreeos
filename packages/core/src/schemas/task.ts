import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { CompanyRef, ListInput, notApplied, PersonRef, seenId, seenText, UserRef } from './crm';

const title = z.string().trim().min(1, 'Enter a task.').max(200);
const taskNotes = z.string().trim().max(5000).nullable().optional();

export const TaskCreateInput = z.object({
  workspaceId: uuid,
  /** The id the phone made for it (M10). */
  id: uuid.optional(),
  title,
  notes: taskNotes,
  dueAt: isoDateTime.nullable().optional(),
  allDay: z.boolean().default(true),
  assigneeUserId: uuid.nullable().optional(),
  personId: uuid.nullable().optional(),
  companyId: uuid.nullable().optional(),
  leadId: uuid.nullable().optional(),
  /** A record of a kind the business made up: a pet, a vehicle, a property (0101). */
  customRecordId: uuid.nullable().optional(),
});
export const TaskCreateOutput = z.object({ taskId: uuid });
/** What the person saw of each detail they edited (see kernel/field-merge). */
export const TaskSeen = z.object({
  title: seenText,
  notes: seenText,
  dueAt: seenText,
  allDay: z.boolean().optional(),
  assigneeUserId: seenId,
  personId: seenId,
  companyId: seenId,
  leadId: seenId,
  customRecordId: seenId,
});
/** Only the details that were edited, each merged on its own: newest wins. */
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
  customRecordId: uuid.nullable().optional(),
  base: TaskSeen.optional(),
});
export const TaskUpdateOutput = z.object({
  taskId: uuid,
  updated: z.array(z.string()),
  notApplied,
});
export const TaskCompleteInput = z.object({ workspaceId: uuid, taskId: uuid });
export const TaskCompleteOutput = z.object({
  taskId: uuid,
  /** Null when it stays open: someone reopened it later than it was ticked. */
  doneAt: isoDateTime.nullable(),
  /** ['done'] when someone reopened it later than it was ticked (M10). */
  notApplied,
});
export const TaskReopenInput = z.object({ workspaceId: uuid, taskId: uuid });
export const TaskReopenOutput = z.object({
  taskId: uuid,
  /** ['done'] when someone marked it done later than it was reopened (M10). */
  notApplied,
});
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
  /** The pet, vehicle or property it's about, with its kind's name and picture. */
  customRecord: z
    .object({
      id: uuid,
      name: z.string(),
      archived: z.boolean(),
      typeId: uuid,
      kind: z.string(),
      icon: z.string(),
    })
    .nullable(),
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
  /** Only this teammate's tasks (with scope "all" for anyone but yourself). */
  assigneeUserId: uuid.optional(),
  personId: uuid.optional(),
  companyId: uuid.optional(),
  leadId: uuid.optional(),
  customRecordId: uuid.optional(),
  /** Only this task: a search result's `/tasks?task=<id>`, asked for with scope and status "all". */
  taskId: uuid.optional(),
});
export const TaskListOutput = z.object({
  items: z.array(TaskOut),
  nextCursor: z.string().nullable(),
  timezone: z.string(),
});
