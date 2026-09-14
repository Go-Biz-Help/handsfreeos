/**
 * The workflow checks. Each issue explains a problem in a short sentence and offers fixes as patch ops, so
 * a fix is an ordinary edit (with Undo) in any of the three editors. Errors block publishing; warnings
 * never block. Shaped like the calendar's `CalendarIssue`, with the step the issue is about.
 */
import type { CatalogPipeline } from '../calendar/catalogs';
import { TRIGGER_EVENTS, triggerEventDef, type Step, type WorkflowDefinition } from './definition';
import { diffWorkflows, refName } from './describe';
import { isPlaceholder, type RefKind } from './ids';
import { mapStrings } from './json';
import { applyWorkflowOps, type WorkflowOp } from './ops';
import { placeholdersIn, resolvePlaceholders, suggestMapping } from './recipes';
import { listRefs, mapRefs, REMOVE_REF, sameSite, type RefMapper, type RefSite } from './refs';
import { removeTemplateVar, templateVars } from './templates';
import { allLanes, allSteps, countSteps, findStep, variablesAt } from './walk';

/** What a workflow refers to, and whether texting works. The loader builds it; the web from its queries. */
export interface WorkflowCatalogs {
  readonly timeZone: string;
  readonly team: readonly {
    readonly userId: string;
    readonly name: string;
    readonly active: boolean;
  }[];
  readonly pipelines: readonly CatalogPipeline[];
  readonly tags: readonly { readonly id: string; readonly name: string }[];
  readonly calendars: readonly {
    readonly id: string;
    readonly name: string;
    readonly archived: boolean;
  }[];
  readonly services?: readonly {
    readonly id: string;
    readonly name: string;
    readonly archived: boolean;
  }[];
  readonly workflows?: readonly { readonly id: string; readonly name: string }[];
  /** Texting is registered and has a number. */
  readonly textingReady: boolean;
}

export function emptyWorkflowCatalogs(timeZone = 'America/Chicago'): WorkflowCatalogs {
  return { timeZone, team: [], pipelines: [], tags: [], calendars: [], textingReady: false };
}

export const WORKFLOW_ISSUE_CODES = [
  'duplicate_step_id',
  'goto_not_last',
  'goto_target_missing',
  'unknown_variable',
  'stage_gone',
  'tag_gone',
  'calendar_gone',
  'user_gone',
  'placeholder_unmapped',
  'approval_no_approvers',
  'unreachable_after_end',
  'texting_not_ready',
  'broad_trigger',
  'step_limit',
  'depth_limit',
] as const;
export type WorkflowIssueCode = (typeof WORKFLOW_ISSUE_CODES)[number];

export interface WorkflowIssueFix {
  readonly id: string;
  readonly label: string;
  readonly ops: readonly WorkflowOp[];
}

export interface WorkflowIssue {
  readonly code: WorkflowIssueCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** Dotted paths the editor highlights, e.g. 'steps.s_ab12cd34.config.stageId', 'trigger.filters'. */
  readonly fields: readonly string[];
  /** The step it's about; null for the trigger, the settings or the whole workflow. */
  readonly stepId: string | null;
  readonly fixes: readonly WorkflowIssueFix[];
}

export const MAX_WORKFLOW_STEPS = 100;
export const MAX_WORKFLOW_DEPTH = 5;

export function hasBlockingWorkflowIssues(issues: readonly WorkflowIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

interface Ctx {
  readonly def: WorkflowDefinition;
  readonly catalogs: WorkflowCatalogs;
  readonly now: number;
  readonly push: (issue: Omit<WorkflowIssue, 'fixes'> & { fixes: WorkflowIssueFix[] }) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fieldOf = (site: Pick<RefSite, 'stepId' | 'where'>) =>
  site.stepId ? `steps.${site.stepId}.${site.where}` : site.where;
const byMap = (ctx: Ctx, id: string, label: string, fn: RefMapper): WorkflowIssueFix => ({
  id,
  label,
  ops: diffWorkflows(ctx.def, mapRefs(ctx.def, fn)),
});

function structureRules({ def, push }: Ctx): void {
  const seen = new Map<string, number>();
  for (const { step } of allSteps(def)) seen.set(step.id, (seen.get(step.id) ?? 0) + 1);
  for (const [id, count] of seen)
    if (count > 1)
      push({
        code: 'duplicate_step_id',
        severity: 'error',
        message: `${plural(count, 'step')} share the id ${id}`,
        fields: [`steps.${id}`],
        stepId: id,
        fixes: [
          { id: 'remove_copy', label: 'Remove one copy', ops: [{ op: 'delete_step', stepId: id }] },
        ],
      });

  for (const lane of allLanes(def)) {
    const endAt = lane.steps.findIndex((s) => s.type === 'end');
    lane.steps.forEach((s, index) => {
      if (s.type !== 'goto') return;
      const remove: WorkflowIssueFix = {
        id: 'remove_goto',
        label: 'Remove the go-to',
        ops: [{ op: 'delete_step', stepId: s.id }],
      };
      if (lane.kind === 'root' || index !== lane.steps.length - 1)
        push({
          code: 'goto_not_last',
          severity: 'error',
          message:
            lane.kind === 'root'
              ? 'A go-to only works at the end of a path'
              : 'A go-to must be the last step of its path',
          fields: [`steps.${s.id}`],
          stepId: s.id,
          fixes:
            lane.kind === 'root'
              ? [remove]
              : [
                  {
                    id: 'move_to_end',
                    label: 'Move it to the end of the path',
                    ops: [
                      { op: 'move_step', stepId: s.id, ...lane.ref, index: lane.steps.length - 1 },
                    ],
                  },
                  remove,
                ],
        });
      if (s.target === s.id || !findStep(def, s.target))
        push({
          code: 'goto_target_missing',
          severity: 'error',
          message:
            s.target === s.id
              ? 'A go-to can’t go to itself'
              : 'The step this go-to goes back to was removed',
          fields: [`steps.${s.id}.target`],
          stepId: s.id,
          fixes: [remove],
        });
    });
    if (endAt >= 0 && endAt < lane.steps.length - 1) {
      const after = lane.steps.slice(endAt + 1);
      push({
        code: 'unreachable_after_end',
        severity: 'warning',
        message: `${plural(after.length, 'step')} after End never ${after.length === 1 ? 'runs' : 'run'}`,
        fields: after.map((s) => `steps.${s.id}`),
        stepId: after[0]!.id,
        fixes: [
          {
            id: 'remove_unreachable',
            label: `Remove the ${plural(after.length, 'step')} after End`,
            ops: after.map((s) => ({ op: 'delete_step' as const, stepId: s.id })),
          },
        ],
      });
    }
  }
}

/** The texts a step fills in, with the patch that replaces them. */
function templated(step: Step): {
  texts: string[];
  patch: (fix: (s: string) => string) => Record<string, unknown>;
} {
  if (step.type === 'action') {
    const texts: string[] = [];
    mapStrings(step.config, (s) => (s.includes('{{') && texts.push(s), s));
    return {
      texts,
      patch: (fix) => ({ config: mapStrings(step.config, (s) => (s.includes('{{') ? fix(s) : s)) }),
    };
  }
  if (step.type === 'ai')
    return { texts: [step.prompt], patch: (fix) => ({ prompt: fix(step.prompt) }) };
  if (step.type === 'approval')
    return { texts: [step.message], patch: (fix) => ({ message: fix(step.message) }) };
  return { texts: [], patch: () => ({}) };
}

function variableRules({ def, push }: Ctx): void {
  for (const { step } of allSteps(def)) {
    const { texts, patch } = templated(step);
    if (!texts.length) continue;
    const known = new Set(variablesAt(def, step.id).map((v) => v.path));
    const flagged = new Set<string>();
    for (const t of texts)
      for (const v of templateVars(t)) {
        if ((v.valid && known.has(v.path)) || flagged.has(v.path)) continue;
        flagged.add(v.path);
        push({
          code: 'unknown_variable',
          severity: 'error',
          message: v.valid
            ? `{{${v.path}}} isn’t available in this step`
            : `{{${v.raw}}} isn’t a variable`,
          fields: [`steps.${step.id}`],
          stepId: step.id,
          fixes: [
            {
              id: 'remove_variable',
              label: `Remove {{${v.path}}}`,
              ops: [
                {
                  op: 'update_step',
                  stepId: step.id,
                  patch: patch((s) => removeTemplateVar(s, v.path)),
                },
              ],
            },
          ],
        });
      }
  }
}

const GONE_CODE: Partial<Record<RefKind, WorkflowIssueCode>> = {
  stage: 'stage_gone',
  pipeline: 'stage_gone',
  tag: 'tag_gone',
  calendar: 'calendar_gone',
  user: 'user_gone',
};

function isGone(kind: RefKind, id: string, c: WorkflowCatalogs): boolean {
  switch (kind) {
    case 'stage':
      return !c.pipelines.some(
        (p) => !p.archived && p.stages.some((s) => s.id === id && !s.archived),
      );
    case 'pipeline':
      return !c.pipelines.some((p) => p.id === id && !p.archived);
    case 'tag':
      return !c.tags.some((t) => t.id === id);
    case 'calendar':
      return !c.calendars.some((x) => x.id === id && !x.archived);
    case 'user':
      return !c.team.some((p) => p.userId === id && p.active);
    default:
      return false;
  }
}

function goneMessage(kind: RefKind, id: string, c: WorkflowCatalogs): string {
  const name = refName(kind, id, c);
  const known = name !== refName(kind, '', {});
  if (kind === 'user')
    return known ? `${name} is no longer on the team` : 'Someone this workflow names left the team';
  if (kind === 'tag') return 'A tag this workflow uses was deleted';
  return known ? `${name} was archived` : `A ${kind} this workflow uses was deleted`;
}

function refRules(ctx: Ctx): void {
  const { def, catalogs, push } = ctx;
  const sites = listRefs(def);
  for (const site of sites) {
    const code = GONE_CODE[site.kind];
    if (!code || typeof site.value !== 'string' || !isGone(site.kind, site.value, catalogs))
      continue;
    // A lead step's pipeline and stage are one choice: report it once, on the stage.
    if (
      site.kind === 'pipeline' &&
      sites.some((s) => s.stepId === site.stepId && s.where === 'config.stageId')
    )
      continue;
    const fixes: WorkflowIssueFix[] = [];
    const remove: RefMapper = (s) => (sameSite(s, site) ? REMOVE_REF : undefined);
    const inConfig = site.where.startsWith('config.') && site.stepId !== null;
    if ((site.kind === 'stage' || site.kind === 'pipeline') && inConfig) {
      const step = findStep(def, site.stepId!)?.step;
      const current =
        step?.type === 'action' && 'pipelineId' in step.config ? step.config.pipelineId : null;
      const pick = [...catalogs.pipelines]
        .filter((p) => !p.archived)
        .sort((a, b) => Number(b.id === current) - Number(a.id === current))
        .map((p) => ({ p, s: p.stages.find((s) => !s.archived) }))
        .find((x) => x.s);
      if (pick?.s)
        fixes.push(
          byMap(ctx, 'pick_stage', `Use ${pick.p.name} · ${pick.s.name}`, (s) =>
            s.stepId !== site.stepId
              ? undefined
              : s.where === 'config.pipelineId'
                ? pick.p.id
                : s.where === 'config.stageId'
                  ? pick.s!.id
                  : undefined,
          ),
        );
    }
    if (site.where.startsWith('config.') && (site.kind === 'user' || site.kind === 'calendar'))
      fixes.push(
        byMap(
          ctx,
          site.kind === 'user' ? 'remove_person' : 'main_booking_page',
          site.kind === 'calendar'
            ? 'Use the main booking page'
            : site.where === 'config.assignTo'
              ? 'Assign to no one'
              : `Remove ${refName('user', site.value, catalogs)}`,
          remove,
        ),
      );
    else if (site.where === 'approvers')
      fixes.push(
        byMap(ctx, 'remove_person', `Remove ${refName('user', site.value, catalogs)}`, remove),
      );
    else if (inConfig)
      fixes.push({
        id: 'remove_step',
        label: 'Remove this step',
        ops: [{ op: 'delete_step', stepId: site.stepId! }],
      });
    else fixes.push(byMap(ctx, 'remove_condition', 'Remove this check', remove));
    push({
      code,
      severity: 'error',
      message: goneMessage(site.kind, site.value, catalogs),
      fields: [fieldOf(site)],
      stepId: site.stepId,
      fixes,
    });
  }

  for (const ph of placeholdersIn(def)) {
    const first = sites.find((s) => isPlaceholder(s.value) && s.value.$ph === ph.key);
    const suggestion = suggestMapping([ph], catalogs)[ph.key];
    const fixes: WorkflowIssueFix[] = [];
    if (suggestion)
      fixes.push({
        id: 'use_suggestion',
        label: `Use ${refName(ph.kind, suggestion, catalogs)}`,
        ops: diffWorkflows(def, resolvePlaceholders(def, { [ph.key]: suggestion })),
      });
    fixes.push(
      byMap(ctx, 'remove_placeholder', 'Remove it', (s) =>
        isPlaceholder(s.value) && s.value.$ph === ph.key ? REMOVE_REF : undefined,
      ),
    );
    push({
      code: 'placeholder_unmapped',
      severity: 'error',
      message: `Pick ${ph.label.toLowerCase()} for this business`,
      fields: first ? [fieldOf(first)] : [],
      stepId: first?.stepId ?? null,
      fixes,
    });
  }
}

function stepRules({ def, catalogs, push }: Ctx): void {
  for (const { step } of allSteps(def)) {
    if (
      step.type === 'approval' &&
      step.approvers.kind === 'users' &&
      step.approvers.userIds.length === 0
    )
      push({
        code: 'approval_no_approvers',
        severity: 'error',
        message: 'No one is picked to approve',
        fields: [`steps.${step.id}.approvers`],
        stepId: step.id,
        fixes: [
          {
            id: 'admins_approve',
            label: 'Owners and admins approve',
            ops: [{ op: 'update_step', stepId: step.id, patch: { approvers: { kind: 'admins' } } }],
          },
        ],
      });
    if (step.type === 'action' && step.action === 'send_text' && !catalogs.textingReady)
      push({
        code: 'texting_not_ready',
        severity: 'warning',
        message: 'Texting isn’t set up yet, so this text can’t go out',
        fields: [`steps.${step.id}`],
        stepId: step.id,
        fixes: [
          {
            id: 'send_email',
            label: 'Send an email instead',
            ops: [
              {
                op: 'update_step',
                stepId: step.id,
                patch: {
                  action: 'send_email',
                  config: {
                    subject: 'A message from {{business.name}}',
                    body: step.config.body,
                    bookingCalendarId: step.config.bookingCalendarId,
                  },
                },
              },
            ],
          },
        ],
      });
  }
}

function limitRules({ def, push }: Ctx): void {
  const t = def.trigger;
  if (
    t.kind === 'event' &&
    triggerEventDef(t.event).broad === true &&
    !t.filters.conditions.length &&
    def.settings.reentry.mode !== 'once'
  )
    push({
      code: 'broad_trigger',
      severity: 'warning',
      message: `This starts every time ${TRIGGER_EVENTS[t.event].label.toLowerCase()}`,
      fields: ['trigger.filters', 'settings.reentry'],
      stepId: null,
      fixes: [
        {
          id: 'once_per_customer',
          label: 'Start once per customer',
          ops: [{ op: 'set_settings', patch: { reentry: { mode: 'once' } } }],
        },
      ],
    });
  if (t.kind === 'schedule' && !t.audience.conditions.length)
    push({
      code: 'broad_trigger',
      severity: 'warning',
      message: 'Every customer is enrolled each time it runs',
      fields: ['trigger.audience'],
      stepId: null,
      fixes: [
        {
          id: 'opted_in_only',
          label: 'Only customers who agreed to texts',
          ops: [
            {
              op: 'set_trigger',
              trigger: {
                ...t,
                audience: {
                  match: 'all',
                  conditions: [{ field: 'person.sms_consent', op: 'eq', value: 'opted_in' }],
                },
              },
            },
          ],
        },
      ],
    });

  const total = countSteps(def.steps);
  if (total > MAX_WORKFLOW_STEPS) {
    const ops: WorkflowOp[] = [];
    let left = total;
    for (let i = def.steps.length - 1; i >= 0 && left > MAX_WORKFLOW_STEPS; i--) {
      left -= countSteps([def.steps[i]!]);
      ops.push({ op: 'delete_step', stepId: def.steps[i]!.id });
    }
    push({
      code: 'step_limit',
      severity: 'error',
      message: `${plural(total, 'step')}; a workflow can have ${MAX_WORKFLOW_STEPS}`,
      fields: ['steps'],
      stepId: null,
      fixes: [{ id: 'trim_steps', label: `Remove the last ${plural(ops.length, 'step')}`, ops }],
    });
  }

  for (const lane of allLanes(def)) {
    if (lane.depth !== MAX_WORKFLOW_DEPTH + 1 || !lane.steps.length) continue;
    const container = findStep(def, lane.ref.parentId!)!;
    push({
      code: 'depth_limit',
      severity: 'error',
      message: `Paths can nest ${MAX_WORKFLOW_DEPTH} deep`,
      fields: lane.steps.map((s) => `steps.${s.id}`),
      stepId: lane.steps[0]!.id,
      fixes: [
        {
          id: 'move_up',
          label: 'Move these steps up a level',
          ops: lane.steps.map((s, j) => ({
            op: 'move_step' as const,
            stepId: s.id,
            ...container.lane,
            index: container.index + 1 + j,
          })),
        },
      ],
    });
  }
}

/** Keeps the fixes whose ops apply cleanly. */
function workingFixes(def: WorkflowDefinition, fixes: WorkflowIssueFix[]): WorkflowIssueFix[] {
  return fixes.filter((f) => {
    if (!f.ops.length) return false;
    try {
      applyWorkflowOps(def, f.ops);
      return true;
    } catch {
      return false;
    }
  });
}

/** Every problem in a workflow, errors and warnings, in a stable order. */
export function validateWorkflow(
  def: WorkflowDefinition,
  catalogs: WorkflowCatalogs,
  now: Date | number = Date.now(),
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const hasDuplicates = new Set(allSteps(def).map((l) => l.step.id)).size !== allSteps(def).length;
  const ctx: Ctx = {
    def,
    catalogs,
    now: typeof now === 'number' ? now : now.getTime(),
    push: (issue) =>
      issues.push({
        ...issue,
        // With duplicate ids, ops can't tell the copies apart; only the duplicate fix is offered.
        fixes:
          hasDuplicates && issue.code !== 'duplicate_step_id' ? [] : workingFixes(def, issue.fixes),
      }),
  };
  structureRules(ctx);
  variableRules(ctx);
  refRules(ctx);
  stepRules(ctx);
  limitRules(ctx);
  const order = new Map(WORKFLOW_ISSUE_CODES.map((c, i) => [c, i]));
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => order.get(a.issue.code)! - order.get(b.issue.code)! || a.i - b.i)
    .map((x) => x.issue);
}
