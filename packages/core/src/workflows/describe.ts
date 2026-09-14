/**
 * Plain English for workflows: one line per trigger and step ("Wait 1 day"), sentences for ops ("Change
 * the wait from 1 day to 2 days"), and `diffWorkflows(a, b)`, the ops that turn one definition into the
 * other by stable ids (template updates, history restore, the Describe preview). Browser-safe.
 */
import { formatClock } from '../messaging/quiet-hours';
import { ACTION_LABELS, type AssignTo, type NotifyWho } from './actions';
import {
  durationText,
  emptyGroup,
  fieldDef,
  isConditionGroup,
  OPERATOR_LABELS,
  type AnyConditionGroup,
  type Condition,
  type Duration,
} from './conditions';
import {
  DATE_ANCHORS,
  Step as StepSchema,
  Trigger as TriggerSchema,
  TRIGGER_EVENTS,
  type Cadence,
  type DateOffset,
  type Step,
  type Trigger,
  type TriggerEventKey,
  type WaitUntil,
  type WorkflowDefinition,
  type WorkflowSettings,
} from './definition';
import { isPlaceholder, type RefKind } from './ids';
import { cloneJson, jsonEqual } from './json';
import { applyOpsUnchecked, type WorkflowOp } from './ops';
import { allLanes, allSteps, countSteps, findStep, REJECTED_LANE, type LaneRef } from './walk';

/** Names for ids; any of the workflow catalogs will do. */
export interface WorkflowNames {
  readonly team?: readonly { readonly userId: string; readonly name: string }[];
  readonly pipelines?: readonly {
    readonly id: string;
    readonly name: string;
    readonly stages: readonly { readonly id: string; readonly name: string }[];
  }[];
  readonly tags?: readonly { readonly id: string; readonly name: string }[];
  readonly calendars?: readonly { readonly id: string; readonly name: string }[];
  readonly services?: readonly { readonly id: string; readonly name: string }[];
  readonly workflows?: readonly { readonly id: string; readonly name: string }[];
}

const GENERIC: Readonly<Record<RefKind, string>> = {
  pipeline: 'a pipeline',
  stage: 'a stage',
  tag: 'a tag',
  calendar: 'a calendar',
  service: 'a service',
  user: 'someone',
  workflow: 'another workflow',
};

/** A name for an id or placeholder ("Estimate sent", "‹estimate stage›", or "a stage"). */
export function refName(kind: RefKind, ref: unknown, names: WorkflowNames = {}): string {
  if (isPlaceholder(ref)) return `‹${ref.$ph.replace(/_/g, ' ')}›`;
  if (typeof ref !== 'string') return GENERIC[kind];
  const byId = (list?: readonly { id: string; name: string }[]) =>
    list?.find((x) => x.id === ref)?.name;
  switch (kind) {
    case 'user':
      return names.team?.find((p) => p.userId === ref)?.name ?? GENERIC.user;
    case 'stage':
      for (const p of names.pipelines ?? []) {
        const s = p.stages.find((x) => x.id === ref);
        if (s) return s.name;
      }
      return GENERIC.stage;
    case 'pipeline':
      return byId(names.pipelines) ?? GENERIC.pipeline;
    case 'tag':
      return byId(names.tags) ?? GENERIC.tag;
    case 'calendar':
      return byId(names.calendars) ?? GENERIC.calendar;
    case 'service':
      return byId(names.services) ?? GENERIC.service;
    case 'workflow':
      return byId(names.workflows) ?? GENERIC.workflow;
  }
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Template tags without their filters: {{person.first_name | default:"there"}} reads {{person.first_name}}. */
const plainTags = (s: string) =>
  s.replace(/\{\{\s*([^{}|]*?)\s*(\|[^{}]*)?\}\}/g, (_m, path: string) => `{{${path}}}`);
const quote = (s: string, max = 60) => {
  const t = squash(plainTags(s));
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
};
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const join = (items: readonly string[], word: 'and' | 'or') =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function daysText(days: readonly number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return 'every day';
  if (jsonEqual(sorted, [1, 2, 3, 4, 5])) return 'every weekday';
  return `every ${join(
    sorted.map((d) => DAY_NAMES[d]!),
    'and',
  )}`;
}

const ordinal = (n: number) => {
  const tail =
    n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${tail}`;
};

export function cadenceText(c: Cadence): string {
  if (c.every === 'weekly') return `${daysText(c.days)} at ${formatClock(c.at)}`;
  const day = c.day === 'last' ? 'the last day' : `the ${ordinal(c.day)}`;
  return `monthly on ${day} at ${formatClock(c.at)}`;
}

function offsetText(
  offset: DateOffset,
  anchor: keyof typeof DATE_ANCHORS,
  at: string | null,
): string {
  const what = DATE_ANCHORS[anchor].label;
  const base =
    offset.amount === 0
      ? `when ${what}`
      : `${durationText({ amount: offset.amount, unit: offset.unit })} ${offset.direction} ${what}`;
  return at ? `${base}, at ${formatClock(at)}` : base;
}

// ---- Conditions ----

export function describeCondition(c: Condition, names: WorkflowNames = {}): string {
  const def = fieldDef(c.field);
  const label = def?.label ?? c.field;
  const value = (v: unknown): string => {
    if (def?.type === 'enum') return def.options?.find((o) => o.value === v)?.label ?? String(v);
    if ((def?.type === 'ref' || def?.type === 'tags') && def.refKind)
      return refName(def.refKind, v, names);
    if (typeof v === 'object' && v !== null && 'amount' in v) return durationText(v as Duration);
    if (typeof v === 'string') return quote(v, 40);
    return String(v);
  };
  if (c.value === null || c.value === undefined) return `${label} ${OPERATOR_LABELS[c.op]}`;
  if (c.op === 'more_than_ago') return `${label} is more than ${value(c.value)} ago`;
  if (Array.isArray(c.value))
    return `${label} ${OPERATOR_LABELS[c.op]} ${join(c.value.map(value), 'or')}`;
  return `${label} ${OPERATOR_LABELS[c.op]} ${value(c.value)}`;
}

/** "Lead status is Won and (Stage is Estimate sent or Lead value is more than 5000)"; "always" when empty. */
export function describeConditions(group: AnyConditionGroup, names: WorkflowNames = {}): string {
  if (!group.conditions.length) return 'always';
  return group.conditions
    .map((c) =>
      isConditionGroup(c) ? `(${describeConditions(c, names)})` : describeCondition(c, names),
    )
    .join(group.match === 'all' ? ' and ' : ' or ');
}

// ---- Triggers and steps ----

export function describeTrigger(t: Trigger, names: WorkflowNames = {}): string {
  const where = (g: AnyConditionGroup, lead: string) =>
    g.conditions.length ? `, ${lead} ${lowerFirst(describeConditions(g, names))}` : '';
  switch (t.kind) {
    case 'event':
      return `When ${lowerFirst(TRIGGER_EVENTS[t.event].label)}${where(t.filters, 'if')}`;
    case 'schedule':
      return `${upperFirst(cadenceText(t.cadence))}${where(t.audience, 'for customers where')}`;
    case 'date':
      return `${upperFirst(offsetText(t.offset, t.anchor, t.at))}${where(t.filters, 'if')}`;
    case 'webhook': {
      const by = { phone: 'phone', email: 'email', phone_or_email: 'phone or email' }[t.personBy];
      return `When a webhook arrives (matched by ${by}${t.createPerson ? ', adding new customers' : ''})`;
    }
    case 'manual':
      return 'When someone starts it';
  }
}

const WAIT_WORDS: Partial<Record<TriggerEventKey, string>> = {
  'message.received': 'a reply',
  'appointment.booked': 'a booking',
  'appointment.cancelled': 'a cancellation',
  'appointment.completed': 'a completed appointment',
  'call.missed': 'a missed call',
  'lead.stage_changed': 'the lead to move',
  'task.completed': 'a task to be done',
};

export function describeWait(until: WaitUntil): string {
  switch (until.kind) {
    case 'duration':
      return `Wait ${durationText(until.duration)}`;
    case 'time_of_day':
      return `Wait until ${formatClock(until.at)}${until.days.length < 7 ? `, ${daysText(until.days)}` : ''}`;
    case 'date_field':
      return `Wait until ${offsetText(until.offset, until.anchor, until.at)}`;
    case 'event':
      return `Wait up to ${durationText(until.timeout)} for ${join(
        until.events.map((e) => WAIT_WORDS[e] ?? lowerFirst(TRIGGER_EVENTS[e].label)),
        'or',
      )}`;
  }
}

function who(a: AssignTo, names: WorkflowNames): string {
  switch (a.kind) {
    case 'user':
      return refName('user', a.userId, names);
    case 'lead_assignee':
      return 'the lead’s assignee';
    case 'person_owner':
      return 'the customer’s owner';
    case 'nobody':
      return 'no one';
  }
}

function notifyWho(w: NotifyWho, names: WorkflowNames): string {
  switch (w.kind) {
    case 'admins':
      return 'owners and admins';
    case 'users':
      return join(
        w.userIds.map((u) => refName('user', u, names)),
        'and',
      );
    case 'lead_assignee':
      return 'the lead’s assignee';
    case 'person_owner':
      return 'the customer’s owner';
  }
}

function describeAction(step: Extract<Step, { type: 'action' }>, names: WorkflowNames): string {
  switch (step.action) {
    case 'send_text':
      return `Send a text: ${quote(step.config.body)}`;
    case 'send_email':
      return `Send an email: ${quote(step.config.subject)}`;
    case 'update_person':
      return `Update the customer’s ${join(
        step.config.fields.map((f) => f.field.replace('_', ' ')),
        'and',
      )}`;
    case 'add_tag':
      return `Tag the ${step.config.target === 'lead' ? 'lead' : 'customer'} ${refName('tag', step.config.tagId, names)}`;
    case 'remove_tag':
      return `Remove the tag ${refName('tag', step.config.tagId, names)} from the ${step.config.target === 'lead' ? 'lead' : 'customer'}`;
    case 'create_lead':
      return `Create a lead ${quote(step.config.title, 40)} in ${refName('pipeline', step.config.pipelineId, names)} · ${refName('stage', step.config.stageId, names)}`;
    case 'move_lead_stage':
      return `Move the lead to ${refName('stage', step.config.stageId, names)}`;
    case 'assign_lead':
      return `Assign the lead to ${who(step.config.assignTo, names)}`;
    case 'set_next_action':
      return `Set the next action: ${quote(step.config.text, 40)}`;
    case 'create_task': {
      const due = step.config.due ? `, due in ${durationText(step.config.due)}` : '';
      return `Create a task ${quote(step.config.title, 40)} for ${who(step.config.assignTo, names)}${due}`;
    }
    case 'complete_task':
      return step.config.taskStepId
        ? 'Complete the task this workflow made'
        : 'Complete this run’s open tasks';
    case 'add_note':
      return `Add a note: ${quote(step.config.body)}`;
    case 'assign_conversation':
      return `Assign the conversation to ${who(step.config.assignTo, names)}`;
    case 'close_conversation':
      return 'Close the conversation';
    case 'notify_team':
      return `Notify ${notifyWho(step.config.who, names)}: ${quote(step.config.message, 50)}`;
    case 'webhook_out': {
      let host = step.config.url;
      try {
        host = new URL(step.config.url).host;
      } catch {
        /* keep the text as it is */
      }
      return `Send a webhook to ${host}`;
    }
    case 'enrol_workflow':
      return `Start ${refName('workflow', step.config.workflowId, names)}`;
    case 'remove_from_workflow':
      return `Remove them from ${refName('workflow', step.config.workflowId, names)}`;
  }
}

/** One plain-English line for a step. Pass the definition to name a go-to's target. */
export function describeStep(
  step: Step,
  names: WorkflowNames = {},
  def?: WorkflowDefinition,
): string {
  switch (step.type) {
    case 'action':
      return describeAction(step, names);
    case 'wait':
      return describeWait(step.until);
    case 'branch': {
      const paths = step.branches.map((b) => `“${b.name}”`);
      if (step.mode === 'if_else')
        return `If ${lowerFirst(describeConditions(step.branches[0]?.condition ?? emptyGroup(), names))}: ${join(paths, 'or')}`;
      if (step.mode === 'ai') return `AI picks a path: ${join(paths, 'or')}`;
      return `Split into ${plural(step.branches.length, 'path')}: ${join(paths, 'or')}`;
    }
    case 'ai':
      if (step.task === 'classify') return `AI sorts it into ${join(step.categories, 'or')}`;
      if (step.task === 'summarize') return `AI summarizes: ${quote(step.prompt, 50)}`;
      return `AI writes ${step.channel === 'sms' ? 'a text' : 'an email'}: ${quote(step.prompt, 50)}`;
    case 'approval':
      if (step.approvers.kind === 'admins') return 'Ask an owner or admin to approve';
      if (!step.approvers.userIds.length) return 'Ask for approval (no one picked)';
      return `Ask ${join(
        step.approvers.userIds.map((u) => refName('user', u, names)),
        'or',
      )} to approve`;
    case 'goto': {
      const target = def ? findStep(def, step.target) : null;
      const name = target ? quote(describeStep(target.step, names), 40) : 'an earlier step';
      return `Go back to ${name} (up to ${plural(step.maxVisits, 'time')})`;
    }
    case 'end':
      return 'End the workflow';
  }
}

// ---- Settings ----

const STOP_WORDS = {
  reply: 'they reply',
  booking: 'they book',
  lead_won: 'the lead is won',
  lead_lost: 'the lead is lost',
} as const;

export function describeSetting<K extends keyof WorkflowSettings>(
  key: K,
  value: WorkflowSettings[K],
): string {
  const s = { [key]: value } as Partial<WorkflowSettings>;
  if (s.reentry) {
    const r = s.reentry;
    if (r.mode === 'once') return 'Customers go through it once';
    if (r.mode === 'after_exit') return 'Customers can start again after they finish';
    return `Customers can start again any time, at most every ${durationText(r.cooldown)}`;
  }
  if (s.stopOn)
    return s.stopOn.length
      ? `Stop when ${join(
          s.stopOn.map((x) => STOP_WORDS[x]),
          'or',
        )}`
      : 'Never stop early';
  if (s.quietHours)
    return {
      wait: 'In quiet hours, texts wait for the morning',
      email_instead: 'In quiet hours, send an email instead',
      skip: 'In quiet hours, skip the text',
    }[s.quietHours];
  if (s.noConsent)
    return s.noConsent === 'skip'
      ? 'Skip texts to customers who haven’t agreed to texts'
      : 'Email customers who haven’t agreed to texts';
  if (s.maxRunDays !== undefined) return `Runs end after ${plural(s.maxRunDays, 'day')}`;
  return 'Settings changed';
}

export function describeSettings(settings: WorkflowSettings): string[] {
  return (Object.keys(settings) as (keyof WorkflowSettings)[]).map((k) =>
    describeSetting(k, settings[k]),
  );
}

// ---- Ops ----

function laneName(def: WorkflowDefinition, lane: LaneRef): string {
  if (lane.parentId === null) return 'the main path';
  if (lane.branchId === REJECTED_LANE) return 'the rejected path';
  const parent = findStep(def, lane.parentId)?.step;
  const branch =
    parent?.type === 'branch' ? parent.branches.find((b) => b.id === lane.branchId) : undefined;
  return branch ? `the “${branch.name}” path` : 'a path';
}

/** A step as a noun phrase for sentences about it: the text “Hi {{person.first_name}}”, the wait (1 day). */
export function stepNoun(step: Step | undefined): string {
  if (!step) return 'a step';
  switch (step.type) {
    case 'action':
      if (step.action === 'send_text') return `the text ${quote(step.config.body, 30)}`;
      if (step.action === 'send_email') return `the email ${quote(step.config.subject, 30)}`;
      if (step.action === 'create_task') return `the task ${quote(step.config.title, 30)}`;
      return `the step “${ACTION_LABELS[step.action]}”`;
    case 'wait':
      return `the wait (${describeWait(step.until).replace(/^Wait /, '')})`;
    case 'branch':
      return `the branch (${join(
        step.branches.map((b) => `“${b.name}”`),
        'or',
      )})`;
    case 'ai':
      return 'the AI step';
    case 'approval':
      return 'the approval';
    case 'goto':
      return 'the go-to';
    case 'end':
      return 'the end step';
  }
}

const short = (step: Step | undefined, _names?: WorkflowNames) => stepNoun(step);

function describeUpdate(before: Step, after: Step | undefined, names: WorkflowNames): string[] {
  if (!after) return [`Change ${short(before, names)}`];
  if (before.type === 'wait' && after.type === 'wait') {
    if (before.until.kind === 'duration' && after.until.kind === 'duration')
      return [
        `Change the wait from ${durationText(before.until.duration)} to ${durationText(after.until.duration)}`,
      ];
    return [`Change the wait to: ${lowerFirst(describeWait(after.until))}`];
  }
  if (before.type === 'branch' && after.type === 'branch') {
    const lines: string[] = [];
    if (before.mode !== after.mode)
      lines.push(`Change ${short(before, names)} to ${lowerFirst(describeStep(after, names))}`);
    for (const b of after.branches) {
      const old = before.branches.find((x) => x.id === b.id);
      if (!old) continue;
      if (old.name !== b.name) lines.push(`Rename the path “${old.name}” to “${b.name}”`);
      if (!jsonEqual(old.condition, b.condition))
        lines.push(
          `Take “${b.name}” when ${b.condition ? lowerFirst(describeConditions(b.condition, names)) : 'nothing else matches'}`,
        );
      if (old.description !== b.description) lines.push(`Change how the AI picks “${b.name}”`);
    }
    if (
      !jsonEqual(
        before.branches.map((b) => b.id),
        after.branches.map((b) => b.id),
      )
    )
      lines.push('Reorder the paths');
    return lines.length ? lines : [`Change ${short(before, names)}`];
  }
  if (before.type === 'action' && after.type === 'action' && before.action === after.action) {
    if (
      before.action === 'send_text' &&
      after.action === 'send_text' &&
      before.config.body !== after.config.body
    )
      return [`Change the text to ${quote(after.config.body)}`];
    if (before.onError !== after.onError)
      return [
        `If ${short(after, names)} fails, ${after.onError === 'stop' ? 'stop the run' : 'carry on'}`,
      ];
  }
  const b = describeStep(after, names);
  return [
    describeStep(before, names) === b
      ? `Change the details of ${stepNoun(before)}`
      : `Change ${stepNoun(before)} to: ${lowerFirst(b)}`,
  ];
}

function describeOp(
  op: WorkflowOp,
  before: WorkflowDefinition,
  after: WorkflowDefinition,
  names: WorkflowNames,
): string[] {
  switch (op.op) {
    case 'add_step': {
      const parsed = StepSchema.safeParse(op.step);
      const what = parsed.success ? describeStep(parsed.data, names, after) : 'a step';
      return [`Add a step to ${laneName(before, op)}: ${what}`];
    }
    case 'delete_step': {
      const step = findStep(before, op.stepId)?.step;
      const inside = step ? countSteps([step]) - 1 : 0;
      return [
        `Remove ${short(step, names)}${inside ? ` and the ${plural(inside, 'step')} inside it` : ''}`,
      ];
    }
    case 'move_step': {
      const loc = findStep(before, op.stepId);
      if (!loc) return ['Move a step'];
      const same = loc.lane.parentId === op.parentId && loc.lane.branchId === op.branchId;
      if (same) return [`Move ${short(loc.step, names)} ${op.index < loc.index ? 'up' : 'down'}`];
      return [`Move ${short(loc.step, names)} to ${laneName(before, op)}`];
    }
    case 'update_step': {
      const old = findStep(before, op.stepId)?.step;
      if (!old) return ['Change a step'];
      return describeUpdate(old, findStep(after, op.stepId)?.step, names);
    }
    case 'add_branch': {
      const step = findStep(before, op.stepId)?.step;
      return [`Add the path “${op.branch.name}” to ${short(step, names)}`];
    }
    case 'delete_branch': {
      const step = findStep(before, op.stepId)?.step;
      const branch =
        step?.type === 'branch' ? step.branches.find((b) => b.id === op.branchId) : undefined;
      const inside = branch ? countSteps(branch.steps) : 0;
      return [
        `Remove the path “${branch?.name ?? 'a path'}”${inside ? ` and its ${plural(inside, 'step')}` : ''}`,
      ];
    }
    case 'set_goto': {
      const target = findStep(before, op.target)?.step;
      const cap = op.maxVisits === null ? '' : `, up to ${plural(op.maxVisits, 'time')}`;
      return [`Point the go-to at ${short(target, names)}${cap}`];
    }
    case 'set_trigger': {
      const parsed = TriggerSchema.safeParse(op.trigger);
      return [
        parsed.success
          ? `Change the trigger: ${lowerFirst(describeTrigger(parsed.data, names))}`
          : 'Change the trigger',
      ];
    }
    case 'set_settings':
      return (Object.keys(op.patch) as (keyof WorkflowSettings)[])
        .filter((k) => op.patch[k] !== undefined && k in after.settings)
        .map((k) => describeSetting(k, after.settings[k]));
  }
}

/** One or more sentences per op, in order ("Change the wait from 1 day to 2 days"). */
export function describeOps(
  ops: readonly WorkflowOp[],
  before: WorkflowDefinition,
  names: WorkflowNames = {},
): string[] {
  const lines: string[] = [];
  let state = before;
  for (const op of ops) {
    let next = state;
    try {
      next = applyOpsUnchecked(state, [op]);
    } catch {
      /* describe it against the unchanged tree */
    }
    lines.push(...describeOp(op, state, next, names));
    state = next;
  }
  return lines;
}

// ---- Diff ----

/** A step with its own paths emptied; the diff fills them lane by lane. */
function shell(step: Step): Step {
  const copy = cloneJson(step);
  if (copy.type === 'branch') copy.branches = copy.branches.map((b) => ({ ...b, steps: [] }));
  if (copy.type === 'approval') copy.rejected = { steps: [] };
  return copy;
}

const branchMeta = (s: Step) =>
  s.type === 'branch'
    ? s.branches.map((b) => ({
        id: b.id,
        name: b.name,
        condition: b.condition,
        description: b.description,
      }))
    : [];

/** The fields of `next` that differ from `cur` (ids, types and child steps aside), as an update_step patch. */
function contentPatch(cur: Step, next: Step): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const c = cur as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(next)) {
    if (k === 'id' || k === 'type' || k === 'rejected') continue;
    if (k === 'branches') {
      if (!jsonEqual(branchMeta(cur), branchMeta(next))) patch.branches = branchMeta(next);
      continue;
    }
    if (!jsonEqual(c[k], v)) patch[k] = cloneJson(v);
  }
  if ('action' in patch && next.type === 'action') patch.config = cloneJson(next.config);
  return Object.keys(patch).length ? patch : null;
}

/**
 * The ops that turn `a` into `b`, matching steps and paths by their stable ids. Applying them to `a` with
 * `applyWorkflowOps` gives `b`.
 */
export function diffWorkflows(a: WorkflowDefinition, b: WorkflowDefinition): WorkflowOp[] {
  const ops: WorkflowOp[] = [];
  let work = a;
  const emit = (op: WorkflowOp) => {
    ops.push(op);
    work = applyOpsUnchecked(work, [op]);
  };

  if (!jsonEqual(a.trigger, b.trigger)) emit({ op: 'set_trigger', trigger: cloneJson(b.trigger) });
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b.settings))
    if (!jsonEqual((a.settings as Record<string, unknown>)[k], v)) settings[k] = cloneJson(v);
  if (Object.keys(settings).length) emit({ op: 'set_settings', patch: settings });

  const target = new Map(allSteps(b).map((l) => [l.step.id, l.step]));
  // A step that changed type is a different step: take it out first.
  for (const loc of allSteps(work)) {
    const next = target.get(loc.step.id);
    if (next && next.type !== loc.step.type && findStep(work, loc.step.id))
      emit({ op: 'delete_step', stepId: loc.step.id });
  }
  // New paths on branch steps that stay.
  for (const loc of allSteps(work)) {
    const next = target.get(loc.step.id);
    if (loc.step.type !== 'branch' || next?.type !== 'branch') continue;
    for (const branch of next.branches)
      if (!loc.step.branches.some((x) => x.id === branch.id))
        emit({
          op: 'add_branch',
          stepId: loc.step.id,
          index: null,
          branch: { ...cloneJson(branch), steps: [] },
        });
  }
  // Lane by lane, parents first: put each step of `b` in its place.
  for (const lane of allLanes(b))
    lane.steps.forEach((step, index) => {
      const loc = findStep(work, step.id);
      if (!loc) {
        emit({ op: 'add_step', ...lane.ref, index, step: shell(step) });
        return;
      }
      if (
        loc.lane.parentId !== lane.ref.parentId ||
        loc.lane.branchId !== lane.ref.branchId ||
        loc.index !== index
      )
        emit({ op: 'move_step', stepId: step.id, ...lane.ref, index });
    });
  // What's left over in lanes that stay, then paths that go.
  const bLanes = new Set(allLanes(b).map((l) => `${l.ref.parentId}|${l.ref.branchId}`));
  for (const lane of allLanes(work)) {
    if (!bLanes.has(`${lane.ref.parentId}|${lane.ref.branchId}`)) continue;
    for (const step of [...lane.steps])
      if (!target.has(step.id)) emit({ op: 'delete_step', stepId: step.id });
  }
  for (const loc of allSteps(work)) {
    const next = target.get(loc.step.id);
    if (loc.step.type !== 'branch' || next?.type !== 'branch') continue;
    for (const branch of loc.step.branches)
      if (!next.branches.some((x) => x.id === branch.id))
        emit({ op: 'delete_branch', stepId: loc.step.id, branchId: branch.id });
  }
  // Finally the contents of steps that stay.
  for (const [id, next] of target) {
    const cur = findStep(work, id)?.step;
    const patch = cur ? contentPatch(cur, next) : null;
    if (patch) emit({ op: 'update_step', stepId: id, patch });
  }
  return ops;
}
