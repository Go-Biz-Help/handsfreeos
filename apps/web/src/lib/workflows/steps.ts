import {
  ACTION_LABELS,
  aiOutputKey,
  describeStep,
  findStep,
  newBranchId,
  newStepId,
  REJECTED_LANE,
  stepsBefore,
  type ActionKey,
  type InsertionPoint,
  type LaneRef,
  type Ref,
  type Step,
  type StepInput,
  type WorkflowCatalogs,
  type WorkflowDefinition,
  type WorkflowNames,
} from '@hfos/core';

/** What the "+" menu can add. */
export type NewStepKind =
  | { readonly kind: 'action'; readonly action: ActionKey }
  | { readonly kind: 'wait' }
  | { readonly kind: 'if_else' }
  | { readonly kind: 'multi' }
  | { readonly kind: 'ai_sort' }
  | { readonly kind: 'ai' }
  | { readonly kind: 'approval' }
  | { readonly kind: 'goto' }
  | { readonly kind: 'end' };

/** The colour family of a step's icon tile (the design's `k-*` tiles). */
export type StepTone = 'trig' | 'act' | 'wait' | 'ai' | 'appr' | 'br' | 'end';

export function stepTone(step: Step): StepTone {
  switch (step.type) {
    case 'action':
      return 'act';
    case 'wait':
      return 'wait';
    case 'ai':
      return 'ai';
    case 'approval':
      return 'appr';
    case 'branch':
    case 'goto':
      return 'br';
    case 'end':
      return 'end';
  }
}

/** A step's one plain-English line, split for a card: "Send a text" over "“Hi Maria…”". */
export function stepLines(
  step: Step,
  names: WorkflowNames,
  def: WorkflowDefinition,
): { title: string; detail: string | null } {
  const line = describeStep(step, names, def);
  const at = line.indexOf(': ');
  if (at > 0 && at < 60) return { title: line.slice(0, at), detail: line.slice(at + 2) };
  return { title: line, detail: null };
}

/** A short name for a step type, for panel headers and menus. */
export function stepTypeName(step: Step): string {
  switch (step.type) {
    case 'action':
      return ACTION_LABELS[step.action];
    case 'wait':
      return 'Wait';
    case 'branch':
      return step.mode === 'if_else'
        ? 'If / else'
        : step.mode === 'ai'
          ? 'AI picks a path'
          : 'Paths';
    case 'ai':
      return step.task === 'classify'
        ? 'AI sorts the reply'
        : step.task === 'summarize'
          ? 'AI summarizes'
          : 'AI writes a message';
    case 'approval':
      return 'Approval';
    case 'goto':
      return 'Go to another step';
    case 'end':
      return 'End';
  }
}

/** Where a step sits, for the panel's context line: "Step 2", "“Yes” path · step 1", "If rejected · step 1". */
export function stepPlace(def: WorkflowDefinition, stepId: string): string {
  const loc = findStep(def, stepId);
  if (!loc) return '';
  const n = loc.index + 1;
  if (loc.lane.parentId === null) return `Step ${n}`;
  if (loc.lane.branchId === REJECTED_LANE) return `If it’s rejected · step ${n}`;
  const parent = findStep(def, loc.lane.parentId)?.step;
  const branch =
    parent?.type === 'branch' ? parent.branches.find((b) => b.id === loc.lane.branchId) : null;
  return branch ? `${branch.name} path · step ${n}` : `Step ${n}`;
}

/** The name of a lane for sentences: "the main path", "the “Yes” path", "the rejected path". */
export function laneName(def: WorkflowDefinition, lane: LaneRef): string {
  if (lane.parentId === null) return 'the main path';
  if (lane.branchId === REJECTED_LANE) return 'the “If it’s rejected” path';
  const parent = findStep(def, lane.parentId)?.step;
  const branch =
    parent?.type === 'branch' ? parent.branches.find((b) => b.id === lane.branchId) : null;
  return branch ? `the “${branch.name}” path` : 'a path';
}

// ---- New steps ----

const ph = (key: string): Ref => ({ $ph: key });

function firstStage(c: WorkflowCatalogs): { pipelineId: Ref; stageId: Ref } {
  for (const p of c.pipelines) {
    if (p.archived) continue;
    const s = p.stages.find((x) => !x.archived);
    if (s) return { pipelineId: p.id, stageId: s.id };
  }
  return { pipelineId: ph('pipeline'), stageId: ph('stage') };
}

const firstTag = (c: WorkflowCatalogs): Ref => c.tags[0]?.id ?? ph('tag');
const firstUser = (c: WorkflowCatalogs): string | null =>
  c.team.find((p) => p.active)?.userId ?? null;

/** The steps that surely ran before a "+" slot. */
function stepsBeforePoint(def: WorkflowDefinition, at: InsertionPoint): Step[] {
  if (at.afterStepId) {
    const loc = findStep(def, at.afterStepId);
    return loc ? [...stepsBefore(def, at.afterStepId), loc.step] : [];
  }
  return at.parentId ? stepsBefore(def, at.parentId) : [];
}

function actionConfig(
  action: ActionKey,
  c: WorkflowCatalogs,
  selfId: string | null,
): Record<string, unknown> {
  const first = '{{person.first_name | default:"there"}}';
  switch (action) {
    case 'send_text':
      return { body: `Hi ${first}, this is {{business.name}}.`, bookingCalendarId: null };
    case 'send_email':
      return {
        subject: 'A message from {{business.name}}',
        body: `Hi ${first},\n\nThanks,\n{{business.name}}`,
        bookingCalendarId: null,
      };
    case 'update_person':
      return { fields: [{ field: 'source', value: 'Workflow' }] };
    case 'add_tag':
    case 'remove_tag':
      return { tagId: firstTag(c), target: 'person' };
    case 'create_lead':
      return {
        title: 'New lead for {{person.name}}',
        ...firstStage(c),
        value: null,
        assignTo: { kind: 'nobody' },
      };
    case 'move_lead_stage':
      return { ...firstStage(c), lostReason: null };
    case 'assign_lead': {
      const user = firstUser(c);
      return { assignTo: user ? { kind: 'user', userId: user } : { kind: 'nobody' } };
    }
    case 'set_next_action':
      return { text: 'Call them back', due: { amount: 1, unit: 'days' } };
    case 'create_task':
      return {
        title: `Call ${'{{person.first_name | default:"the customer"}}'}`,
        notes: '',
        due: { amount: 1, unit: 'days' },
        assignTo: { kind: 'person_owner' },
      };
    case 'complete_task':
      return { taskStepId: null };
    case 'add_note':
      return { body: 'Note from {{workflow.name}}' };
    case 'assign_conversation':
      return { assignTo: { kind: 'person_owner' }, channel: 'latest' };
    case 'close_conversation':
      return { channel: 'latest' };
    case 'notify_team':
      return { who: { kind: 'admins' }, message: '{{person.name}} needs a follow-up', email: true };
    case 'webhook_out':
      return { url: 'https://example.com/webhook', include: ['person'] };
    case 'enrol_workflow':
    case 'remove_from_workflow':
      return {
        workflowId: (c.workflows ?? []).find((w) => w.id !== selfId)?.id ?? ph('workflow'),
      };
  }
}

/** A new step of this kind with working defaults, ready for an `add_step` op at `at`. */
export function newStep(
  kind: NewStepKind,
  ctx: {
    readonly def: WorkflowDefinition;
    readonly catalogs: WorkflowCatalogs;
    readonly at: InsertionPoint;
    /** This workflow, so "Start another workflow" doesn't pick itself. */
    readonly workflowId: string | null;
  },
): StepInput {
  const id = newStepId();
  switch (kind.kind) {
    case 'action':
      return {
        id,
        type: 'action',
        action: kind.action,
        config: actionConfig(kind.action, ctx.catalogs, ctx.workflowId),
      } as StepInput;
    case 'wait':
      return {
        id,
        type: 'wait',
        until: { kind: 'duration', duration: { amount: 1, unit: 'days' } },
      };
    case 'if_else':
      return {
        id,
        type: 'branch',
        mode: 'if_else',
        branches: [
          {
            id: newBranchId(),
            name: 'Yes',
            condition: {
              match: 'all',
              conditions: [{ field: 'person.email', op: 'is_not_empty', value: null }],
            },
            steps: [],
          },
          { id: newBranchId(), name: 'Otherwise', condition: null, steps: [] },
        ],
      };
    case 'multi':
      return {
        id,
        type: 'branch',
        mode: 'multi',
        branches: [
          {
            id: newBranchId(),
            name: 'Path 1',
            condition: {
              match: 'all',
              conditions: [{ field: 'person.sms_consent', op: 'eq', value: 'opted_in' }],
            },
            steps: [],
          },
          {
            id: newBranchId(),
            name: 'Path 2',
            condition: {
              match: 'all',
              conditions: [{ field: 'person.email', op: 'is_not_empty', value: null }],
            },
            steps: [],
          },
          { id: newBranchId(), name: 'Otherwise', condition: null, steps: [] },
        ],
      };
    case 'ai_sort':
      return {
        id,
        type: 'branch',
        mode: 'ai',
        branches: [
          {
            id: newBranchId(),
            name: 'Interested',
            description: 'They want to book, get a quote or learn more',
            steps: [],
          },
          {
            id: newBranchId(),
            name: 'Other',
            description: 'Anything else, or not sure',
            steps: [],
          },
        ],
      };
    case 'ai':
      return {
        id,
        type: 'ai',
        task: 'write',
        prompt:
          'Write a short, friendly text that answers their latest message. If you’re not sure, say someone will follow up today.',
        channel: 'sms',
      };
    case 'approval': {
      const writer = stepsBeforePoint(ctx.def, ctx.at)
        .filter((s) => s.type === 'ai' && s.task === 'write')
        .at(-1);
      return {
        id,
        type: 'approval',
        approvers: { kind: 'admins' },
        message: '',
        previewStepId: writer?.id ?? null,
        rejected: { steps: [] },
      };
    }
    case 'goto': {
      const target =
        ctx.at.parentId && findStep(ctx.def, ctx.at.parentId)
          ? (stepsBefore(ctx.def, ctx.at.parentId).at(-1)?.id ?? ctx.def.steps[0]?.id)
          : ctx.def.steps[0]?.id;
      return { id, type: 'goto', target: target ?? id, maxVisits: 2 };
    }
    case 'end':
      return { id, type: 'end' };
  }
}

/** The key an AI step's result is saved under, for `{{ai.<key>}}`. */
export const aiKeyOf = aiOutputKey;
