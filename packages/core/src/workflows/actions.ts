/**
 * What an action step does, with a zod config per action. Text fields are templates (see templates.ts);
 * workspace ids are `Ref`s so recipes and agency templates can carry placeholders. Browser-safe.
 */
import { z } from 'zod';
import { Duration } from './conditions';
import { Ref, StepId } from './ids';

const template = (max: number, error = 'Write something.') =>
  z.string().trim().min(1, error).max(max, `Keep it under ${max} characters.`);

/** Who gets the work: a named person, the lead's assignee, the customer's owner, or nobody. */
export const AssignTo = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: Ref }),
  z.object({ kind: z.literal('lead_assignee') }),
  z.object({ kind: z.literal('person_owner') }),
  z.object({ kind: z.literal('nobody') }),
]);
export type AssignTo = z.infer<typeof AssignTo>;

/** Which of the customer's conversations: texts, email, or whichever they used last. */
const Channel = z.enum(['sms', 'email', 'latest']).default('latest');

const bookingCalendarId = Ref.nullable()
  .default(null)
  .describe('The calendar whose booking page {{links.booking}} opens; null uses the main one');

export const SendTextConfig = z.object({
  body: template(1600, 'Write the text.'),
  bookingCalendarId,
});
export const SendEmailConfig = z.object({
  subject: template(200, 'Write a subject.'),
  body: template(10000, 'Write the email.'),
  bookingCalendarId,
});

export const UPDATABLE_PERSON_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'city',
  'source',
  'notes',
] as const;
export const UpdatePersonConfig = z.object({
  fields: z
    .array(z.object({ field: z.enum(UPDATABLE_PERSON_FIELDS), value: z.string().trim().max(500) }))
    .min(1, 'Pick a field.')
    .max(UPDATABLE_PERSON_FIELDS.length)
    .refine((list) => new Set(list.map((x) => x.field)).size === list.length, {
      error: 'Each field once.',
    }),
});

const TagConfig = z.object({ tagId: Ref, target: z.enum(['person', 'lead']).default('person') });
export const AddTagConfig = TagConfig;
export const RemoveTagConfig = TagConfig;

export const CreateLeadConfig = z.object({
  title: template(160, 'Name the lead.'),
  pipelineId: Ref,
  stageId: Ref,
  value: z.number().min(0).max(1_000_000_000).nullable().default(null),
  assignTo: AssignTo.default({ kind: 'nobody' }),
});
export const MoveLeadStageConfig = z.object({
  pipelineId: Ref,
  stageId: Ref,
  lostReason: z.string().trim().max(300).nullable().default(null),
});
export const AssignLeadConfig = z.object({ assignTo: AssignTo });
export const SetNextActionConfig = z.object({
  text: template(200, 'Write the next action.'),
  /** Due this long after the step runs; null means no due time. */
  due: Duration.nullable().default(null),
});
export const CreateTaskConfig = z.object({
  title: template(200, 'Name the task.'),
  notes: z.string().trim().max(2000).default(''),
  due: Duration.nullable().default(null),
  assignTo: AssignTo.default({ kind: 'nobody' }),
});
export const CompleteTaskConfig = z.object({
  /** The create_task step whose task to complete; null completes every open task this run created. */
  taskStepId: StepId.nullable().default(null),
});
export const AddNoteConfig = z.object({ body: template(5000, 'Write the note.') });
export const AssignConversationConfig = z.object({ assignTo: AssignTo, channel: Channel });
export const CloseConversationConfig = z.object({ channel: Channel });

export const NotifyWho = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('admins') }),
  z.object({ kind: z.literal('users'), userIds: z.array(Ref).min(1, 'Pick someone.').max(20) }),
  z.object({ kind: z.literal('lead_assignee') }),
  z.object({ kind: z.literal('person_owner') }),
]);
export type NotifyWho = z.infer<typeof NotifyWho>;
export const NotifyTeamConfig = z.object({
  who: NotifyWho.default({ kind: 'admins' }),
  message: template(500, 'Write the message.'),
  email: z.boolean().default(true),
});

export const WEBHOOK_PARTS = ['person', 'lead', 'appointment', 'conversation', 'trigger'] as const;
export const WebhookOutConfig = z.object({
  url: z
    .url()
    .max(500)
    .refine((u) => u.startsWith('https://'), { error: 'Use an https:// address.' }),
  include: z
    .array(z.enum(WEBHOOK_PARTS))
    .max(WEBHOOK_PARTS.length)
    .default((): (typeof WEBHOOK_PARTS)[number][] => ['person']),
});
export const WorkflowRefConfig = z.object({ workflowId: Ref });

export const ACTION_CONFIGS = {
  send_text: SendTextConfig,
  send_email: SendEmailConfig,
  update_person: UpdatePersonConfig,
  add_tag: AddTagConfig,
  remove_tag: RemoveTagConfig,
  create_lead: CreateLeadConfig,
  move_lead_stage: MoveLeadStageConfig,
  assign_lead: AssignLeadConfig,
  set_next_action: SetNextActionConfig,
  create_task: CreateTaskConfig,
  complete_task: CompleteTaskConfig,
  add_note: AddNoteConfig,
  assign_conversation: AssignConversationConfig,
  close_conversation: CloseConversationConfig,
  notify_team: NotifyTeamConfig,
  webhook_out: WebhookOutConfig,
  enrol_workflow: WorkflowRefConfig,
  remove_from_workflow: WorkflowRefConfig,
} as const;
export type ActionKey = keyof typeof ACTION_CONFIGS;
export const ACTION_KEYS = Object.keys(ACTION_CONFIGS) as [ActionKey, ...ActionKey[]];
export type ActionConfig<K extends ActionKey = ActionKey> = z.infer<(typeof ACTION_CONFIGS)[K]>;

export const ACTION_LABELS: Readonly<Record<ActionKey, string>> = {
  send_text: 'Send a text',
  send_email: 'Send an email',
  update_person: 'Update the customer',
  add_tag: 'Add a tag',
  remove_tag: 'Remove a tag',
  create_lead: 'Create a lead',
  move_lead_stage: 'Move the lead',
  assign_lead: 'Assign the lead',
  set_next_action: 'Set the next action',
  create_task: 'Create a task',
  complete_task: 'Complete a task',
  add_note: 'Add a note',
  assign_conversation: 'Assign the conversation',
  close_conversation: 'Close the conversation',
  notify_team: 'Notify the team',
  webhook_out: 'Send a webhook',
  enrol_workflow: 'Start another workflow',
  remove_from_workflow: 'Remove from a workflow',
};

/** Actions that reach the customer (consent and quiet hours apply to texts). */
export const CUSTOMER_ACTIONS: ReadonlySet<ActionKey> = new Set(['send_text', 'send_email']);
