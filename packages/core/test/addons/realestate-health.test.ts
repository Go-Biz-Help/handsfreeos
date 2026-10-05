/**
 * Real Estate Agent's health and alert ladder (step 10), pure: each red and yellow rule with its reason, green when
 * nothing's wrong, and the rungs a duty climbs as its due time comes and goes.
 */
import { describe, expect, it } from 'vitest';
import { healthOf, type HealthDuty, type HealthInput } from '../../src/addons/realestate/health';
import { ladderAlert, rungOf, rungSince } from '../../src/addons/realestate/ladder';

// Wednesday, October 7, 2026, noon in Chicago.
const NOW = Date.parse('2026-10-07T17:00:00Z');
const TODAY = '2026-10-07';

const duty = (over: Partial<HealthDuty> = {}): HealthDuty => ({
  id: 'd1',
  key: 'B-20',
  title: 'Attend inspection',
  status: 'not_started',
  materiality: 'standard',
  dueAt: null,
  dueDate: null,
  dueState: 'none',
  needsDates: [],
  accountableRole: 'agent',
  accountableUserId: 'u1',
  blocker: null,
  ...over,
});
const input = (over: Partial<HealthInput> = {}): HealthInput => ({
  duties: [],
  keyDates: {},
  conflicts: [],
  dateProblems: [],
  now: NOW,
  today: TODAY,
  ...over,
});
const codes = (i: HealthInput) => healthOf(i).reasons.map((r) => `${r.level}:${r.code}`);

describe('Health', () => {
  it('is green with nothing wrong', () => {
    expect(healthOf(input({ duties: [duty()] }))).toEqual({ level: 'green', reasons: [] });
  });

  it('turns red for a critical duty overdue, and a material one a business day late', () => {
    const critical = duty({
      materiality: 'critical',
      dueAt: '2026-10-07T04:59:00Z',
      dueDate: '2026-10-06',
    });
    expect(codes(input({ duties: [critical] }))).toEqual(['red:critical_overdue']);
    const material = duty({
      materiality: 'material',
      dueAt: '2026-10-06T04:59:00Z',
      dueDate: '2026-10-05',
    });
    expect(codes(input({ duties: [material] }))).toEqual(['red:material_late']);
    // Due yesterday by the clock but not a full business day late: yellow.
    const sameDay = duty({
      materiality: 'material',
      dueAt: '2026-10-07T15:00:00Z',
      dueDate: '2026-10-07',
    });
    expect(codes(input({ duties: [sameDay] }))).toEqual(['yellow:overdue']);
  });

  it('turns red for material work due within a business day that hasn’t started, yellow within three', () => {
    const tomorrow = duty({
      materiality: 'material',
      dueAt: '2026-10-09T04:59:00Z',
      dueDate: '2026-10-08',
    });
    expect(codes(input({ duties: [tomorrow] }))).toEqual(['red:material_not_moving']);
    expect(codes(input({ duties: [{ ...tomorrow, status: 'in_progress' }] }))).toEqual([]);
    const friday = duty({
      materiality: 'material',
      dueAt: '2026-10-10T04:59:00Z',
      dueDate: '2026-10-09',
    });
    expect(codes(input({ duties: [friday] }))).toEqual(['yellow:material_soon']);
  });

  it('holds red for a changed wire, and closing near with material work open', () => {
    const wire = duty({
      key: 'W-00',
      materiality: 'critical',
      title: 'Verify changed wiring instructions by phone',
    });
    expect(codes(input({ duties: [wire] }))).toEqual(['red:wire_hold']);
    const open = duty({ materiality: 'material' });
    expect(
      codes(
        input({
          duties: [open],
          keyDates: { closing: { date: '2026-10-09', source: 'contract', confirmed: true } },
        }),
      ),
    ).toEqual(['red:closing_with_open_work']);
  });

  it('turns red for a disagreeing date that counts, and names the dates still to come', () => {
    const drafted = duty({ status: 'draft', needsDates: ['closing'], dueState: 'due' });
    expect(
      codes(
        input({
          duties: [drafted],
          keyDates: { closing: { date: '2026-11-20', source: 'contract', confirmed: false } },
          conflicts: ['closing'],
        }),
      ),
    ).toEqual(['red:date_conflict']);
    const h = healthOf(
      input({
        duties: [drafted, duty({ id: 'd2', dueState: 'waiting', needsDates: ['inspection_end'] })],
        keyDates: { closing: { date: '2026-11-20', source: 'contract', confirmed: false } },
      }),
    );
    expect(h.level).toBe('yellow');
    expect(h.reasons.map((r) => r.words)).toEqual([
      '1 duty is a draft until the closing is confirmed.',
      'The inspection period ends isn’t entered, so 1 duty has no due date.',
    ]);
  });

  it('turns yellow for anything blocked and anything nobody answers for', () => {
    expect(
      codes(
        input({
          duties: [
            duty({ status: 'blocked', blocker: 'Roofer hasn’t finished' }),
            duty({ id: 'd2', accountableUserId: null }),
            duty({ id: 'd3', accountableRole: 'broker', accountableUserId: null }),
          ],
        }),
      ),
    ).toEqual(['yellow:blocked', 'yellow:nobody_accountable']);
  });

  it('takes the checks across the dates as they come: problems red, warnings yellow', () => {
    expect(
      codes(
        input({
          dateProblems: [
            {
              check: 'rate_lock_before_closing',
              severity: 'problem',
              keys: ['rate_lock_expiry'],
              words: 'x',
            },
            {
              check: 'closing_not_business_day',
              severity: 'warning',
              keys: ['closing'],
              words: 'y',
            },
          ],
        }),
      ),
    ).toEqual(['red:date_problem', 'yellow:date_warning']);
  });
});

describe('The ladder', () => {
  const d = (
    dueAt: string,
    dueDate: string,
    materiality: 'standard' | 'material' | 'critical' = 'standard',
  ) => ({
    id: 'd1',
    key: 'B-20',
    title: 'Attend inspection',
    status: 'not_started' as const,
    materiality,
    dueAt,
    dueDate,
  });

  it('climbs from a week out to critical', () => {
    expect(rungOf(d('2026-10-20T04:59:00Z', '2026-10-19'), NOW, TODAY)).toBeNull();
    expect(rungOf(d('2026-10-13T04:59:00Z', '2026-10-12'), NOW, TODAY)).toBe('week');
    expect(rungOf(d('2026-10-10T04:59:00Z', '2026-10-09'), NOW, TODAY)).toBe('days');
    expect(rungOf(d('2026-10-08T04:59:00Z', '2026-10-07'), NOW, TODAY)).toBe('day');
    expect(rungOf(d('2026-10-07T15:00:00Z', '2026-10-07'), NOW, TODAY)).toBe('overdue');
    expect(rungOf(d('2026-10-06T04:59:00Z', '2026-10-05'), NOW, TODAY)).toBe('late');
    expect(rungOf(d('2026-10-06T04:59:00Z', '2026-10-05', 'material'), NOW, TODAY)).toBe(
      'critical',
    );
    expect(rungOf(d('2026-10-07T15:00:00Z', '2026-10-07', 'critical'), NOW, TODAY)).toBe(
      'critical',
    );
    // Weekends and holidays don't count toward late: due Friday the 16th, it's Monday: one business day.
    expect(
      rungOf(
        d('2026-10-17T04:59:00Z', '2026-10-16', 'material'),
        Date.parse('2026-10-19T17:00:00Z'),
        '2026-10-19',
      ),
    ).toBe('late');
    // Due Friday the 9th, and Monday the 12th is Columbus Day: not yet a business day late.
    expect(
      rungOf(
        d('2026-10-10T04:59:00Z', '2026-10-09', 'material'),
        Date.parse('2026-10-12T17:00:00Z'),
        '2026-10-12',
      ),
    ).toBe('overdue');
  });

  it('says nothing for drafts, finished duties and the wire check', () => {
    const x = d('2026-10-08T04:59:00Z', '2026-10-07');
    expect(rungOf({ ...x, status: 'draft' }, NOW, TODAY)).toBeNull();
    expect(rungOf({ ...x, status: 'completed' }, NOW, TODAY)).toBeNull();
    expect(rungOf({ ...x, key: 'W-00' }, NOW, TODAY)).toBeNull();
  });

  it('pushes from three days out, emails material work, and asks for acknowledgement once late', () => {
    const x = d('2026-10-10T04:59:00Z', '2026-10-09');
    expect(ladderAlert('week', x)).toMatchObject({ severity: 'info', notify: false });
    expect(ladderAlert('days', x)).toMatchObject({
      severity: 'attention',
      notify: true,
      email: false,
    });
    expect(ladderAlert('days', { ...x, materiality: 'material' })).toMatchObject({ email: true });
    expect(ladderAlert('late', x)).toMatchObject({
      severity: 'at_risk',
      needsAck: true,
      audience: 'team',
    });
    expect(ladderAlert('critical', x)).toMatchObject({
      severity: 'critical',
      audience: 'escalated',
    });
    expect(ladderAlert('days', x).title).toBe('“Attend inspection” is due Fri, Oct 9');
  });

  it('knows when a rung was reached, to catch up quietly', () => {
    const x = d('2026-10-10T04:59:00Z', '2026-10-09');
    expect(rungSince('days', x)).toBe(Date.parse('2026-10-07T04:59:00Z'));
    expect(rungSince('overdue', x)).toBe(Date.parse('2026-10-10T04:59:00Z'));
  });
});

describe('Reminder days', () => {
  const d = (dueAt: string, dueDate: string) => ({
    id: 'd1',
    key: 'B-20',
    title: 'Attend inspection',
    status: 'not_started' as const,
    materiality: 'standard' as const,
    dueAt,
    dueDate,
  });
  it('decide the early cards, and every duty climbs the same once due', () => {
    const fiveOut = d('2026-10-13T04:59:00Z', '2026-10-12');
    const twoOut = d('2026-10-10T04:59:00Z', '2026-10-09');
    expect(rungOf(fiveOut, NOW, TODAY, undefined, [3, 1])).toBeNull();
    expect(rungOf(twoOut, NOW, TODAY, undefined, [3, 1])).toBe('days');
    // Only a week's reminder: its card stays up as the day comes.
    expect(rungOf(twoOut, NOW, TODAY, undefined, [7])).toBe('week');
    expect(rungOf(twoOut, NOW, TODAY, undefined, [])).toBeNull();
    expect(rungOf(d('2026-10-06T04:59:00Z', '2026-10-05'), NOW, TODAY, undefined, [])).toBe('late');
  });
});
