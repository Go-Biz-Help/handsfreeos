import { describe, expect, it } from 'vitest';
import {
  allSteps,
  applyWorkflowOps,
  extractPlaceholders,
  isPlaceholder,
  listRefs,
  placeholdersIn,
  recipeByKey,
  recipeDefinition,
  resolvePlaceholders,
  structureProblems,
  suggestMapping,
  WORKFLOW_RECIPES,
  type WorkflowDefinition,
} from '../../src/workflows/index';
import { catalogs, DALE, PRIYA, SERVICE_CAL, sid, STAGE_ESTIMATE, VIP } from './fixtures';

describe('recipes', () => {
  it.each(WORKFLOW_RECIPES.map((r) => [r.key, r] as const))(
    '%s parses and lists its placeholders',
    (_key, recipe) => {
      const d = recipeDefinition(recipe.key);
      expect(structureProblems(d)).toEqual([]);
      expect(
        placeholdersIn(d)
          .map((p) => [p.key, p.kind])
          .sort(),
      ).toEqual(recipe.placeholders.map((p) => [p.key, p.kind]).sort());
    },
  );

  it('suggests ids by name, and leaves a stage without a match unmapped', () => {
    expect(
      suggestMapping(
        [
          { key: 'estimate_stage', kind: 'stage', label: 'Estimate sent' },
          { key: 'vip', kind: 'tag', label: 'Vip' },
          { key: 'won_stage', kind: 'stage', label: 'Signed contract' },
          { key: 'calendar', kind: 'calendar', label: 'Calendar' },
          { key: 'priya', kind: 'user', label: 'Priya' },
        ],
        catalogs,
      ),
    ).toEqual({
      estimate_stage: STAGE_ESTIMATE,
      vip: VIP,
      won_stage: null,
      calendar: SERVICE_CAL,
      priya: PRIYA,
    });
  });

  it('has AI teammate variants of speed to lead and missed-call text back', () => {
    const actions = (key: 'speed_to_lead_ai' | 'missed_call_text_back_ai') =>
      allSteps(recipeDefinition(key)).flatMap(({ step }) =>
        step.type === 'action' ? [step.action] : [],
      );
    expect(recipeByKey('speed_to_lead_ai')?.name).toBe('Speed to lead with your AI teammate');
    expect(recipeByKey('missed_call_text_back_ai')?.name).toBe(
      'Missed-call text back with your AI teammate',
    );
    expect(actions('speed_to_lead_ai')).toEqual(['hand_to_ai_teammate', 'create_task']);
    expect(actions('missed_call_text_back_ai')).toEqual(['hand_to_ai_teammate', 'create_task']);
    expect(recipeDefinition('speed_to_lead_ai').trigger).toMatchObject({ event: 'lead.created' });
    expect(recipeDefinition('speed_to_lead_ai').steps[0]).toMatchObject({
      config: { goal: 'qualify', firstMessage: 'ai_writes' },
    });
    expect(recipeDefinition('missed_call_text_back_ai').trigger).toMatchObject({
      event: 'call.missed',
    });
    expect(recipeDefinition('missed_call_text_back_ai').steps[0]).toMatchObject({
      config: { goal: 'book', channel: 'sms' },
    });
  });

  it('keeps unmapped placeholders when resolving', () => {
    const d = recipeDefinition('missed_call_text_back');
    const partly = resolvePlaceholders(d, { on_call_user: DALE });
    expect(placeholdersIn(partly).map((p) => p.key)).toEqual(['booking_calendar', 'office_user']);
  });
});

describe('placeholders round trip', () => {
  function workspaceWorkflow(): WorkflowDefinition {
    const base = resolvePlaceholders(recipeDefinition('missed_call_text_back'), {
      on_call_user: DALE,
      booking_calendar: SERVICE_CAL,
      office_user: PRIYA,
    });
    return applyWorkflowOps(base, [
      {
        op: 'set_trigger',
        trigger: {
          kind: 'event',
          event: 'call.missed',
          filters: {
            match: 'any',
            conditions: [
              { field: 'person.tags', op: 'includes', value: VIP },
              { field: 'lead.stage_id', op: 'in', value: [STAGE_ESTIMATE] },
            ],
          },
        },
      },
      {
        op: 'add_step',
        parentId: null,
        branchId: null,
        index: 0,
        step: { id: sid('tag1'), type: 'action', action: 'add_tag', config: { tagId: VIP } },
      },
    ]).definition;
  }

  it('extract then resolve gives the same definition', () => {
    const original = workspaceWorkflow();
    const { definition, placeholders } = extractPlaceholders(original, catalogs);
    expect(listRefs(definition).every((s) => isPlaceholder(s.value))).toBe(true);
    expect(placeholders.map((p) => p.key).sort()).toEqual([
      'calendar_service_calls',
      'stage_estimate_sent',
      'tag_vip',
      'user_dale',
      'user_priya',
    ]);
    const mapping = Object.fromEntries(placeholders.map((p) => [p.key, p.id]));
    expect(resolvePlaceholders(definition, mapping)).toEqual(original);
  });

  it('maps to another business with suggestions', () => {
    const { definition, placeholders } = extractPlaceholders(workspaceWorkflow(), catalogs);
    const mapping = suggestMapping(placeholders, catalogs);
    expect(mapping).toMatchObject({
      tag_vip: VIP,
      stage_estimate_sent: STAGE_ESTIMATE,
      user_priya: PRIYA,
    });
    expect(placeholdersIn(resolvePlaceholders(definition, mapping))).toEqual([]);
  });
});
