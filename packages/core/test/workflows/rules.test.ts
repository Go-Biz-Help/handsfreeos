import { describe, expect, it } from 'vitest';
import {
  applyWorkflowOps,
  hasBlockingWorkflowIssues,
  recipeDefinition,
  resolvePlaceholders,
  suggestMapping,
  validateWorkflow,
  WORKFLOW_ISSUE_CODES,
  WORKFLOW_RECIPES,
  type StepInput,
  type WorkflowCatalogs,
  type WorkflowDefinition,
  type WorkflowIssueCode,
} from '../../src/workflows/index';
import {
  catalogs,
  def,
  end,
  GONE_TAG,
  goto,
  ifElse,
  JESS,
  OLD_CAL,
  SALES,
  sid,
  STAGE_OLD,
  text,
  waitDays,
} from './fixtures';

const NOW = Date.parse('2026-09-16T15:00:00Z');

interface Case {
  readonly code: WorkflowIssueCode;
  readonly severity: 'error' | 'warning';
  readonly build: () => WorkflowDefinition;
  readonly catalogs?: Partial<WorkflowCatalogs>;
}

const action = (id: string, name: string, config: Record<string, unknown>): StepInput =>
  ({ id, type: 'action', action: name, config }) as StepInput;

function nested(level: number): StepInput {
  return ifElse(sid(`br${level}`), level < 6 ? [nested(level + 1)] : [text(sid('deep'))], []);
}

/** The smallest workflow that trips each rule. */
const CASES: Case[] = [
  {
    code: 'duplicate_step_id',
    severity: 'error',
    build: () => def({ steps: [text(sid('a')), text(sid('a'))] }),
  },
  {
    code: 'goto_not_last',
    severity: 'error',
    build: () =>
      def({ steps: [ifElse(sid('br'), [goto(sid('g'), sid('t')), text(sid('t'))], [])] }),
  },
  {
    code: 'goto_target_missing',
    severity: 'error',
    build: () => def({ steps: [ifElse(sid('br'), [goto(sid('g'), sid('zzz'))], [])] }),
  },
  {
    code: 'unknown_variable',
    severity: 'error',
    build: () => def({ steps: [text(sid('t'), 'Hi {{foo.bar}} there')] }),
  },
  {
    code: 'stage_gone',
    severity: 'error',
    build: () =>
      def({
        steps: [action(sid('m'), 'move_lead_stage', { pipelineId: SALES, stageId: STAGE_OLD })],
      }),
  },
  {
    code: 'tag_gone',
    severity: 'error',
    build: () => def({ steps: [action(sid('t'), 'add_tag', { tagId: GONE_TAG })] }),
  },
  {
    code: 'calendar_gone',
    severity: 'error',
    build: () =>
      def({
        steps: [
          action(sid('t'), 'send_text', {
            body: 'Book: {{links.booking}}',
            bookingCalendarId: OLD_CAL,
          }),
        ],
      }),
  },
  {
    code: 'user_gone',
    severity: 'error',
    build: () =>
      def({
        steps: [
          action(sid('t'), 'create_task', {
            title: 'Call',
            assignTo: { kind: 'user', userId: JESS },
          }),
        ],
      }),
  },
  {
    code: 'placeholder_unmapped',
    severity: 'error',
    build: () => def({ steps: [action(sid('t'), 'add_tag', { tagId: { $ph: 'vip' } })] }),
  },
  {
    code: 'approval_no_approvers',
    severity: 'error',
    build: () =>
      def({
        steps: [{ id: sid('ap'), type: 'approval', approvers: { kind: 'users', userIds: [] } }],
      }),
  },
  {
    code: 'unreachable_after_end',
    severity: 'warning',
    build: () => def({ steps: [end(sid('e')), text(sid('t'))] }),
  },
  {
    code: 'texting_not_ready',
    severity: 'warning',
    build: () => def({ steps: [text(sid('t'))] }),
    catalogs: { textingReady: false },
  },
  {
    code: 'broad_trigger',
    severity: 'warning',
    build: () =>
      def({ trigger: { kind: 'event', event: 'message.received' }, steps: [text(sid('t'))] }),
  },
  {
    code: 'step_limit',
    severity: 'error',
    build: () =>
      def({
        steps: Array.from({ length: 101 }, (_, i) =>
          waitDays(sid(`w${String(i).padStart(3, '0')}`)),
        ),
      }),
  },
  { code: 'depth_limit', severity: 'error', build: () => def({ steps: [nested(1)] }) },
];

describe('validateWorkflow', () => {
  it('has a case for every code', () => {
    expect(new Set(CASES.map((c) => c.code))).toEqual(new Set(WORKFLOW_ISSUE_CODES));
  });

  it.each(CASES)(
    '$code fires, and its first fix clears it',
    ({ code, severity, build, catalogs: extra }) => {
      const cats = { ...catalogs, ...extra };
      const d = build();
      const issue = validateWorkflow(d, cats, NOW).find((i) => i.code === code);
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe(severity);
      expect(issue!.message).toMatch(/\S/);
      expect(issue!.fixes.length).toBeGreaterThan(0);
      const fixed = applyWorkflowOps(d, issue!.fixes[0]!.ops).definition;
      expect(validateWorkflow(fixed, cats, NOW).filter((i) => i.code === code)).toEqual([]);
    },
  );

  it('flags a broad schedule, fixed by picking an audience', () => {
    const d = def({
      trigger: { kind: 'schedule', cadence: { every: 'weekly', days: [1], at: '09:00' } },
      steps: [text(sid('t'))],
    });
    const issue = validateWorkflow(d, catalogs, NOW).find((i) => i.code === 'broad_trigger')!;
    const fixed = applyWorkflowOps(d, issue.fixes[0]!.ops).definition;
    expect(validateWorkflow(fixed, catalogs, NOW)).toEqual([]);
  });

  it('removes a check on a deleted tag from the trigger filters', () => {
    const d = def({
      trigger: {
        kind: 'event',
        event: 'lead.created',
        filters: {
          match: 'all',
          conditions: [{ field: 'person.tags', op: 'includes', value: GONE_TAG }],
        },
      },
    });
    const issue = validateWorkflow(d, catalogs, NOW).find((i) => i.code === 'tag_gone')!;
    expect(issue.fields).toEqual(['trigger.filters']);
    expect(issue.fixes[0]!.ops).toEqual([
      {
        op: 'set_trigger',
        trigger: {
          kind: 'event',
          event: 'lead.created',
          filters: { match: 'all', conditions: [] },
        },
      },
    ]);
  });

  it('passes a clean workflow, and only errors block', () => {
    const d = def({
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [text(sid('t')), waitDays(sid('w'))],
    });
    expect(validateWorkflow(d, catalogs, NOW)).toEqual([]);
    expect(hasBlockingWorkflowIssues(validateWorkflow(CASES[10]!.build(), catalogs, NOW))).toBe(
      false,
    );
    expect(hasBlockingWorkflowIssues(validateWorkflow(CASES[0]!.build(), catalogs, NOW))).toBe(
      true,
    );
  });
});

describe('recipes against the validator', () => {
  it.each(WORKFLOW_RECIPES.map((r) => [r.key, r] as const))(
    '%s has no errors once mapped',
    (_key, recipe) => {
      const raw = recipeDefinition(recipe.key);
      const unmapped = validateWorkflow(raw, catalogs, NOW).filter(
        (i) => i.code === 'placeholder_unmapped',
      );
      expect(unmapped).toHaveLength(recipe.placeholders.length);
      const mapping = suggestMapping(recipe.placeholders, catalogs);
      expect(Object.values(mapping).every((id) => typeof id === 'string')).toBe(true);
      const issues = validateWorkflow(resolvePlaceholders(raw, mapping), catalogs, NOW);
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    },
  );
});
