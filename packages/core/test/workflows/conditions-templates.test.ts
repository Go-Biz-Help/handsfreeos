import { describe, expect, it } from 'vitest';
import {
  Condition,
  ConditionGroup,
  conditionFields,
  evaluate,
  FIELD_CATALOG,
  OPERATORS_BY_TYPE,
  removeTemplateVar,
  render,
  templateVars,
  type AnyConditionGroup,
} from '../../src/workflows/index';
import { STAGE_ESTIMATE, STAGE_NEW, VIP } from './fixtures';

const NOW = Date.parse('2026-09-16T15:00:00Z');
const c = (field: string, op: string, value: unknown = null) =>
  Condition.parse({ field, op, value });
const one = (field: string, op: string, value: unknown, facts: Record<string, unknown>) =>
  evaluate({ match: 'all', conditions: [c(field, op, value)] }, facts, {
    now: NOW,
    timeZone: 'America/Chicago',
  });

describe('conditions', () => {
  it.each([
    ['person.first_name', 'eq', 'maria', { 'person.first_name': ' Maria ' }, true],
    ['person.first_name', 'neq', 'maria', { 'person.first_name': 'Ana' }, true],
    ['person.first_name', 'neq', 'maria', {}, true],
    ['person.email', 'contains', 'EXAMPLE', { 'person.email': 'a@example.com' }, true],
    ['person.email', 'not_contains', 'example', { 'person.email': null }, true],
    ['person.phone', 'starts_with', '+1214', { 'person.phone': '+12145550100' }, true],
    ['person.city', 'is_empty', null, { 'person.city': '' }, true],
    ['person.city', 'is_not_empty', null, { 'person.city': 'Dallas' }, true],
    ['lead.value', 'gt', 5000, { 'lead.value': 6500 }, true],
    ['lead.value', 'gte', 6500, { 'lead.value': 6500 }, true],
    ['lead.value', 'lt', 5000, { 'lead.value': null }, false],
    ['lead.value', 'eq', 0, { 'lead.value': null }, false],
    ['lead.status', 'in', ['won', 'lost'], { 'lead.status': 'lost' }, true],
    ['lead.status', 'not_in', ['won', 'lost'], { 'lead.status': 'open' }, true],
    ['lead.stage_id', 'eq', STAGE_NEW, { 'lead.stage_id': STAGE_ESTIMATE }, false],
    ['lead.stage_id', 'eq', { $ph: 'estimate_stage' }, { 'lead.stage_id': STAGE_ESTIMATE }, false],
    ['person.tags', 'includes', VIP, { 'person.tags': [VIP] }, true],
    ['person.tags', 'excludes', VIP, { 'person.tags': [] }, true],
    ['conversation.awaiting_reply', 'is_true', null, { 'conversation.awaiting_reply': true }, true],
    ['conversation.awaiting_reply', 'is_false', null, {}, true],
    [
      'appointment.starts_at',
      'before',
      '2026-09-17',
      { 'appointment.starts_at': '2026-09-16T20:00:00Z' },
      true,
    ],
    [
      'appointment.starts_at',
      'after',
      '2026-09-17',
      { 'appointment.starts_at': '2026-09-17T04:00:00Z' },
      false,
    ],
    [
      'lead.created_at',
      'within_last',
      { amount: 2, unit: 'days' },
      { 'lead.created_at': '2026-09-15T15:00:00Z' },
      true,
    ],
    [
      'lead.created_at',
      'more_than_ago',
      { amount: 2, unit: 'days' },
      { 'lead.created_at': '2026-09-15T15:00:00Z' },
      false,
    ],
    [
      'appointment.starts_at',
      'within_next',
      { amount: 3, unit: 'hours' },
      { 'appointment.starts_at': NOW + 3_600_000 },
      true,
    ],
    ['ai.category', 'eq', 'book', { 'ai.category': 'Book' }, true],
    ['ai.mood', 'eq', 'happy', { 'ai.mood': 'happy' }, true],
  ])('%s %s %j', (field, op, value, facts, expected) => {
    expect(one(field, op, value, facts)).toBe(expected);
  });

  it('combines all and any, three deep, and passes an empty group', () => {
    const group: AnyConditionGroup = ConditionGroup.parse({
      match: 'all',
      conditions: [
        { field: 'lead.status', op: 'eq', value: 'open' },
        {
          match: 'any',
          conditions: [
            { field: 'lead.value', op: 'gt', value: 5000 },
            { match: 'all', conditions: [{ field: 'person.tags', op: 'includes', value: VIP }] },
          ],
        },
      ],
    });
    const truth = (status: string, value: number, tags: string[]) =>
      evaluate(group, { 'lead.status': status, 'lead.value': value, 'person.tags': tags });
    expect([
      truth('open', 6000, []),
      truth('open', 10, [VIP]),
      truth('open', 10, []),
      truth('won', 6000, [VIP]),
    ]).toEqual([true, true, false, false]);
    expect(evaluate(ConditionGroup.parse({}), {})).toBe(true);
    expect(conditionFields(group)).toEqual(['lead.status', 'lead.value', 'person.tags']);
  });

  it('reads facts lazily and once', () => {
    const asked: string[] = [];
    const group = ConditionGroup.parse({
      match: 'any',
      conditions: [
        { field: 'lead.status', op: 'eq', value: 'won' },
        { field: 'lead.status', op: 'eq', value: 'open' },
        { field: 'person.city', op: 'is_empty' },
      ],
    });
    expect(evaluate(group, (f) => (asked.push(f), f === 'lead.status' ? 'open' : null))).toBe(true);
    expect(asked).toEqual(['lead.status']);
  });

  it('refuses a fourth level, unknown fields and wrong values', () => {
    const deep = {
      match: 'all',
      conditions: [
        {
          match: 'all',
          conditions: [{ match: 'all', conditions: [{ match: 'all', conditions: [] }] }],
        },
      ],
    };
    expect(ConditionGroup.safeParse(deep).success).toBe(false);
    expect(Condition.safeParse({ field: 'person.shoe_size', op: 'eq', value: 9 }).success).toBe(
      false,
    );
    expect(Condition.safeParse({ field: 'lead.value', op: 'contains', value: 'x' }).success).toBe(
      false,
    );
    expect(Condition.safeParse({ field: 'lead.status', op: 'eq', value: 'maybe' }).success).toBe(
      false,
    );
    expect(Condition.safeParse({ field: 'person.city', op: 'is_empty', value: 'x' }).success).toBe(
      false,
    );
  });

  it('gives every field type at least one operator', () => {
    for (const f of FIELD_CATALOG) expect(OPERATORS_BY_TYPE[f.type].length).toBeGreaterThan(0);
  });
});

describe('templates', () => {
  const vars = {
    person: { first_name: 'maria lopez', name: 'Maria Lopez', tags: ['vip', 'new'] },
    business: { name: 'Lone Star HVAC' },
    appointment: { starts_at: '2026-09-16T19:30:00Z' },
    ai: { message: '' },
  };

  it('fills variables and filters, and reports missing ones', () => {
    const out = render(
      'Hi {{person.first_name | first | upper}}! {{ business.name }} at {{appointment.starts_at | time}} on {{appointment.starts_at|date}}. {{person.tags | first}} {{lead.title}} {{ai.message}}',
      vars,
      { timeZone: 'America/Chicago' },
    );
    expect(out.text).toBe('Hi MARIA! Lone Star HVAC at 2:30 PM on Wed, Sep 16. vip  ');
    expect(out.missing).toEqual(['lead.title', 'ai.message']);
  });

  it('uses a default for a blank value, and never reports it missing', () => {
    expect(
      render(
        'Hi {{person.nickname | default:"there"}}, {{x.y | lower | default:\'friend\'}}',
        vars,
      ),
    ).toEqual({
      text: 'Hi there, friend',
      missing: [],
    });
  });

  it('lists variables, flags bad filters and removes a variable', () => {
    const vs = templateVars('{{a.b}} {{ c | shout }} {{a.b}} {{d | default:"x|y"}}');
    expect(vs.map((v) => [v.path, v.valid, v.hasDefault])).toEqual([
      ['a.b', true, false],
      ['c', false, false],
      ['d', true, true],
    ]);
    expect(removeTemplateVar('Hi {{foo.bar}}, see {{links.booking}}', 'foo.bar')).toBe(
      'Hi, see {{links.booking}}',
    );
  });

  it('takes values from a lookup function', () => {
    expect(
      render('{{person.first_name}}', (p) => (p === 'person.first_name' ? 'Ana' : undefined)),
    ).toEqual({ text: 'Ana', missing: [] });
  });
});
