import { describe, expect, it } from 'vitest';
import {
  describeTemplateMerge,
  effectiveMapping,
  extractPlaceholders,
  findStep,
  mergeTemplateUpdate,
  placeholdersIn,
  templateCatalogs,
  templateIssues,
  unmappedKeys,
  validateWorkflow,
  type StepInput,
  type WorkflowDefinition,
} from '../../src/workflows/index';
import { catalogs, def, sid, STAGE_ESTIMATE, text, VIP, waitDays } from './fixtures';

const email = (id: string, subject: string, body: string): StepInput => ({
  id,
  type: 'action',
  action: 'send_email',
  config: { subject, body },
});
const task = (
  id: string,
  title: string,
  assignTo: Record<string, unknown> = { kind: 'lead_assignee' },
) => ({
  id,
  type: 'action' as const,
  action: 'create_task' as const,
  config: { title, assignTo: assignTo as never },
});
const configOf = (d: WorkflowDefinition, id: string) =>
  (findStep(d, id)?.step as { config?: Record<string, unknown> } | undefined)?.config;
const untilOf = (d: WorkflowDefinition, id: string) =>
  (findStep(d, id)?.step as { until?: Record<string, unknown> } | undefined)?.until;

const W1 = sid('wait1');
const MAIL = sid('mail1');
const TASK = sid('task1');
const TASK2 = sid('task2');

/** What the business installed: a wait, an email, a task for whoever takes office calls. */
const base = def({
  trigger: {
    kind: 'event',
    event: 'lead.stage_changed',
    filters: {
      match: 'all',
      conditions: [{ field: 'trigger.to_stage_id', op: 'eq', value: { $ph: 'estimate_stage' } }],
    },
  },
  steps: [
    waitDays(W1, 2),
    email(MAIL, 'Your estimate', 'Hi {{person.first_name | default:"there"}}'),
    task(TASK, 'Call them', { kind: 'user', userId: { $ph: 'office_user' } }),
  ],
});

describe('templates are checked for their own structure', () => {
  it('leaves placeholders alone and assumes texting works', () => {
    const t = def({ ...base, steps: [...base.steps, text(sid('text1'))] });
    expect(validateWorkflow(t, templateCatalogs()).map((i) => i.code)).toContain(
      'placeholder_unmapped',
    );
    const codes = templateIssues(t).map((i) => i.code);
    expect(codes).not.toContain('placeholder_unmapped');
    expect(codes).not.toContain('texting_not_ready');
  });

  it('still flags what is wrong with the template itself', () => {
    const broken = def({ steps: [text(sid('text1'), 'Hi {{person.shoe_size}}')] });
    expect(templateIssues(broken).map((i) => i.code)).toContain('unknown_variable');
  });

  it('names a saved template’s placeholders by what they stand for, not their kind', () => {
    const saved = extractPlaceholders(
      def({
        trigger: {
          kind: 'event',
          event: 'lead.stage_changed',
          filters: {
            match: 'all',
            conditions: [{ field: 'trigger.to_stage_id', op: 'eq', value: STAGE_ESTIMATE }],
          },
        },
      }),
      catalogs,
    ).definition;
    expect(placeholdersIn(saved)).toEqual([
      { key: 'stage_estimate_sent', kind: 'stage', label: 'Estimate sent' },
    ]);
    // What a business reads in Checks until it picks one.
    const issue = validateWorkflow(saved, templateCatalogs()).find(
      (i) => i.code === 'placeholder_unmapped',
    );
    expect(issue?.message).toBe('Pick estimate sent for this business');
    // Recipe keys that don't lead with their kind read as before.
    expect(placeholdersIn(base).map((p) => p.label)).toEqual(['Estimate stage', 'Office user']);
  });
});

describe('a business’s mapping', () => {
  const placeholders = [
    { key: 'estimate_stage', kind: 'stage' as const, label: 'Estimate sent' },
    { key: 'office_user', kind: 'user' as const, label: 'Who answers questions' },
    { key: 'vip', kind: 'tag' as const, label: 'VIP' },
  ];

  it('keeps what was stored, suggests keys never mapped, and leaves an explicit null for the business', () => {
    const m = effectiveMapping(
      placeholders,
      { estimate_stage: STAGE_ESTIMATE, office_user: null, old_key: 'x' },
      catalogs,
    );
    expect(m).toEqual({ estimate_stage: STAGE_ESTIMATE, office_user: null, vip: VIP });
    expect(unmappedKeys(m)).toEqual(['office_user']);
  });

  it('suggests every key when nothing was stored', () => {
    const m = effectiveMapping(placeholders, {}, catalogs);
    expect(m.estimate_stage).toBe(STAGE_ESTIMATE);
    expect(m.vip).toBe(VIP);
    // People rarely have telling names: the first active one is proposed.
    expect(m.office_user).toEqual(expect.any(String));
  });
});

describe('merging a template update into a business’s copy', () => {
  /** The template's v2: a longer wait, a new email subject, one more task. */
  const theirs = def({
    ...base,
    steps: [
      waitDays(W1, 3),
      email(MAIL, 'Your estimate is ready', 'Hi {{person.first_name | default:"there"}}'),
      task(TASK, 'Call them', { kind: 'user', userId: { $ph: 'office_user' } }),
      task(TASK2, 'Check in a week later'),
    ],
  });

  it('with no changes of the business’s own, is the new version exactly', () => {
    const m = mergeTemplateUpdate(base, theirs, base);
    expect(m.definition).toEqual(theirs);
    expect(m.yourOps).toEqual([]);
    expect(m.kept).toEqual([]);
    expect(m.templateOps.length).toBeGreaterThan(0);
  });

  it('keeps the business’s own changes on top, down to the field they changed', () => {
    const mine = def({
      ...base,
      steps: [
        waitDays(W1, 2),
        email(MAIL, 'Your estimate', 'Howdy {{person.first_name | default:"there"}}!'),
        task(TASK, 'Call them today', { kind: 'user', userId: { $ph: 'office_user' } }),
      ],
    });
    const m = mergeTemplateUpdate(base, theirs, mine);
    // The template's changes arrive…
    expect(untilOf(m.definition, W1)).toMatchObject({ duration: { amount: 3, unit: 'days' } });
    expect(findStep(m.definition, TASK2)).not.toBeNull();
    // …and theirs stay: the email keeps its new body and takes the template's new subject.
    expect(configOf(m.definition, MAIL)).toMatchObject({
      subject: 'Your estimate is ready',
      body: 'Howdy {{person.first_name | default:"there"}}!',
    });
    expect(configOf(m.definition, TASK)).toMatchObject({ title: 'Call them today' });
    expect(m.kept).toHaveLength(2);
    expect(m.dropped).toEqual([]);
    const lines = describeTemplateMerge(m, base, catalogs);
    expect(lines.kept.join(' ')).toMatch(/Call them today/);
    expect(lines.templateChanges.join(' ')).toMatch(/3 days/);
  });

  it('lets the business’s change win where both changed the same thing', () => {
    const mine = def({ ...base, steps: [waitDays(W1, 5), ...base.steps.slice(1)] });
    const m = mergeTemplateUpdate(base, theirs, mine);
    expect(untilOf(m.definition, W1)).toMatchObject({ duration: { amount: 5, unit: 'days' } });
  });

  it('drops a change to a step the new version no longer has, and says so', () => {
    const without = def({ ...theirs, steps: theirs.steps.filter((s) => s.id !== TASK) });
    const mine = def({
      ...base,
      steps: [
        ...base.steps.slice(0, 2),
        task(TASK, 'Call them today', { kind: 'user', userId: { $ph: 'office_user' } }),
      ],
    });
    const m = mergeTemplateUpdate(base, without, mine);
    expect(findStep(m.definition, TASK)).toBeNull();
    expect(m.dropped).toHaveLength(1);
    expect(describeTemplateMerge(m, base, catalogs).dropped).toHaveLength(1);
  });
});
