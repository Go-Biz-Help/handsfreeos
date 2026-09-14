import { describe, expect, it } from 'vitest';
import {
  applyWorkflowOps,
  describeOps,
  describeStep,
  describeTrigger,
  diffWorkflows,
  recipeDefinition,
  Step,
  Trigger,
} from '../../src/workflows/index';
import { catalogs, def, goto, ifElse, sid, STAGE_ESTIMATE, text, waitDays } from './fixtures';

describe('describeTrigger and describeStep', () => {
  it('reads like plain English', () => {
    const t = (x: unknown) => describeTrigger(Trigger.parse(x), catalogs);
    expect(t({ kind: 'event', event: 'lead.created' })).toBe('When a new lead comes in');
    expect(
      t({
        kind: 'event',
        event: 'lead.stage_changed',
        filters: {
          match: 'all',
          conditions: [{ field: 'trigger.to_stage_id', op: 'eq', value: STAGE_ESTIMATE }],
        },
      }),
    ).toBe('When a lead moves stage, if moved to stage is Estimate sent');
    expect(
      t({ kind: 'schedule', cadence: { every: 'weekly', days: [5, 1, 2, 3, 4], at: '09:00' } }),
    ).toBe('Every weekday at 9:00 AM');
    expect(t({ kind: 'schedule', cadence: { every: 'monthly', day: 'last', at: '17:30' } })).toBe(
      'Monthly on the last day at 5:30 PM',
    );
    expect(
      t({ kind: 'date', anchor: 'appointment.ends_at', offset: { amount: 2, unit: 'hours' } }),
    ).toBe('2 hours after the appointment ends');
    expect(t({ kind: 'manual' })).toBe('When someone starts it');

    const s = (x: unknown) => describeStep(Step.parse(x), catalogs);
    expect(s(waitDays(sid('w')))).toBe('Wait 1 day');
    expect(s(text(sid('t'), 'Hi there, thanks for calling!'))).toBe(
      'Send a text: “Hi there, thanks for calling!”',
    );
    expect(
      s({
        id: sid('a'),
        type: 'ai',
        task: 'classify',
        prompt: 'x',
        categories: ['happy', 'unhappy'],
      }),
    ).toBe('AI sorts it into happy or unhappy');
    expect(s({ id: sid('p'), type: 'approval' })).toBe('Ask an owner or admin to approve');
    const d = def({
      steps: [waitDays(sid('w')), ifElse(sid('br'), [goto(sid('g'), sid('w'))], [])],
    });
    const g = d.steps[1]!.type === 'branch' ? d.steps[1]!.branches[0]!.steps[0]! : d.steps[0]!;
    expect(describeStep(g, catalogs, d)).toBe('Go back to “Wait 1 day” (up to 3 times)');
  });
});

describe('the AI teammate', () => {
  it('describes the hand-over step, its new triggers and waits', () => {
    const hand = (config: Record<string, unknown>) =>
      Step.parse({ id: sid('ai'), type: 'action', action: 'hand_to_ai_teammate', config });
    expect(describeStep(hand({ goal: 'qualify' }), catalogs)).toBe(
      'Hand to the AI teammate: ask the qualifying questions; it writes first',
    );
    expect(
      describeStep(hand({ goal: 'book', channel: 'sms' }), { ...catalogs, teammateName: 'Ava' }),
    ).toBe('Hand to Ava (AI): get them booked; it writes first by text');
    expect(describeStep(hand({ firstMessage: 'none' }), catalogs)).toBe(
      'Hand to the AI teammate: reply and help; it waits for them',
    );
    const t = (event: string) => describeTrigger(Trigger.parse({ kind: 'event', event }));
    expect(t('lead.qualified')).toBe('When a lead is qualified');
    expect(t('ai_teammate.handed_off')).toBe(
      'When the AI teammate hands a conversation to a person',
    );
    expect(
      describeStep(
        Step.parse({
          id: sid('w'),
          type: 'wait',
          until: {
            kind: 'event',
            events: ['lead.qualified', 'ai_teammate.handed_off'],
            timeout: { amount: 1, unit: 'days' },
          },
        }),
      ),
    ).toBe('Wait up to 1 day for the lead to qualify or the AI teammate to hand it to a person');
  });
});

describe('describeOps', () => {
  it('says what each op does', () => {
    const d = def({
      steps: [text(sid('t')), waitDays(sid('w')), ifElse(sid('br'), [text(sid('t2'), 'Yay')], [])],
    });
    const lines = describeOps(
      [
        { op: 'update_step', stepId: sid('w'), patch: { until: { duration: { amount: 2 } } } },
        {
          op: 'add_step',
          parentId: sid('br'),
          branchId: 'b_br00yes0',
          index: null,
          step: waitDays(sid('w2'), 3),
        },
        { op: 'move_step', stepId: sid('t'), parentId: null, branchId: null, index: 1 },
        { op: 'set_settings', patch: { quietHours: 'skip', stopOn: ['reply', 'booking'] } },
        { op: 'delete_step', stepId: sid('br') },
      ],
      d,
      catalogs,
    );
    expect(lines).toEqual([
      'Change the wait from 1 day to 2 days',
      'Add a step to the “Yes” path: Wait 3 days',
      'Move the text “Hi {{person.first_name}}” down',
      'In quiet hours, skip the text',
      'Stop when they reply or they book',
      'Remove the branch (“Yes” or “No”) and the 2 steps inside it',
    ]);
  });
});

describe('diffWorkflows', () => {
  it('turns one version into another by stable ids', () => {
    const a = recipeDefinition('appointment_follow_up_review');
    const b = applyWorkflowOps(a, [
      { op: 'update_step', stepId: 's_afrwait1', patch: { until: { duration: { amount: 3 } } } },
      { op: 'move_step', stepId: 's_afrtask1', parentId: null, branchId: null, index: 0 },
      { op: 'delete_step', stepId: 's_afrrevw1' },
      { op: 'set_settings', patch: { maxRunDays: 30 } },
    ]).definition;
    const ops = diffWorkflows(a, b);
    expect(applyWorkflowOps(a, ops).definition).toEqual(b);
    expect(ops.map((o) => o.op).sort()).toEqual([
      'delete_step',
      'move_step',
      'set_settings',
      'update_step',
    ]);
    expect(diffWorkflows(a, a)).toEqual([]);
  });
});
