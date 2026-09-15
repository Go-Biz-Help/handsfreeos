import { describe, expect, it } from 'vitest';
import {
  affectedCents,
  defaultAttentionSettings,
  DETECTORS,
  isUrgent,
  rankItems,
  scoreOf,
  urgencyOf,
  type AttentionKind,
  type Detection,
  type Scorable,
} from '../src/attention/index';
import {
  ago,
  business,
  DALE,
  DAY,
  HOUR,
  later,
  lead,
  MIN,
  NO_REPEAT,
  NOW,
  shift,
  STAGE_DECIDING,
  uid,
} from './attention-fixtures';

const settings = defaultAttentionSettings();

const item = (over: Partial<Scorable> = {}): Scorable => ({
  kind: 'stale_opportunity',
  value: 100_000,
  probability: 0.5,
  confidence: 0.7,
  since: ago(10 * DAY),
  dueAt: null,
  urgentFrom: null,
  ...over,
});

const scorable = (kind: AttentionKind, d: Detection | null) => {
  if (!d) throw new Error(`${kind} didn’t detect`);
  return { kind, ...d };
};

describe('score', () => {
  it('follows 100 × log10(10 + V) × U × P × C', () => {
    const i = item({ value: 4_000_000, since: NOW.toISOString() });
    const u = urgencyOf(i, NOW);
    expect(u).toBe(1);
    expect(scoreOf(i, NOW)).toBeCloseTo(100 * Math.log10(10 + 40_000) * 1 * 0.5 * 0.7, 6);
  });

  it('grows with value, urgency, probability and confidence', () => {
    const base = scoreOf(item(), NOW);
    expect(scoreOf(item({ value: 1_000_000 }), NOW)).toBeGreaterThan(base);
    expect(scoreOf(item(), shift(NOW, 10 * DAY))).toBeGreaterThan(base);
    expect(scoreOf(item({ probability: 0.9 }), NOW)).toBeGreaterThan(base);
    expect(scoreOf(item({ confidence: 0.95 }), NOW)).toBeGreaterThan(base);
  });

  it('caps urgency at 3; a hot lead starts at 2', () => {
    const hot = { kind: 'hot_lead' as const, since: NOW.toISOString(), dueAt: null };
    expect(urgencyOf(hot, NOW)).toBe(2);
    expect(urgencyOf(hot, shift(NOW, 5 * MIN))).toBeCloseTo(2.5);
    expect(urgencyOf(hot, shift(NOW, HOUR))).toBe(3);
    const waiting = { kind: 'customer_waiting' as const, since: NOW.toISOString(), dueAt: null };
    expect(urgencyOf(waiting, shift(NOW, 15 * MIN))).toBeCloseTo(1.5);
    expect(urgencyOf(waiting, shift(NOW, 5 * HOUR))).toBe(3);
    expect(urgencyOf({ kind: 'overdue_task', since: null, dueAt: null }, NOW)).toBe(1);
  });

  it('grows an appointment’s urgency from 1 to 3 over the two days before it starts', () => {
    const appt = (inMs: number) => ({
      kind: 'unconfirmed_appointment' as const,
      since: null,
      dueAt: later(inMs),
    });
    expect(urgencyOf(appt(72 * HOUR), NOW)).toBe(1);
    expect(urgencyOf(appt(48 * HOUR), NOW)).toBe(1);
    expect(urgencyOf(appt(24 * HOUR), NOW)).toBeCloseTo(2);
    expect(urgencyOf(appt(0), NOW)).toBe(3);
  });

  it('ranks a $40,000 lead showing buying intent above a $50 reminder, however late the reminder', () => {
    const fifty = (id: number) => ({ id: uid(id), valueCents: 5_000, status: 'open' as const });
    const hot = scorable(
      'hot_lead',
      DETECTORS.hot_lead.detect(
        {
          business,
          lead: lead({ valueCents: 4_000_000, createdAt: NOW.toISOString() }),
          awaitingReplySince: null,
          customerWords: ['Can you come out today to look at the AC?'],
          repeat: NO_REPEAT,
        },
        settings,
        NOW,
      ),
    );
    const reminders = [
      scorable(
        'overdue_task',
        DETECTORS.overdue_task.detect(
          {
            business,
            task: {
              id: uid(600),
              title: 'Call back',
              dueAt: ago(30 * DAY),
              allDay: false,
              doneAt: null,
              assigneeUserId: DALE,
            },
            lead: fifty(50),
          },
          settings,
          NOW,
        ),
      ),
      scorable(
        'unconfirmed_appointment',
        DETECTORS.unconfirmed_appointment.detect(
          {
            business,
            appointment: {
              id: uid(300),
              kind: 'booking',
              status: 'scheduled',
              startsAt: later(MIN),
              ownerUserId: DALE,
            },
            attendee: {
              id: uid(301),
              personId: uid(2),
              status: 'booked',
              confirmedAt: null,
              confirmAskedAt: null,
            },
            lead: fifty(51),
          },
          settings,
          NOW,
        ),
      ),
      scorable(
        'missing_next_action',
        DETECTORS.missing_next_action.detect(
          {
            business,
            lead: lead({
              id: uid(52),
              valueCents: 5_000,
              stage: STAGE_DECIDING,
              qualification: 'qualified',
              createdAt: ago(40 * DAY),
              firstResponseAt: ago(40 * DAY),
              nextAction: 'Call back',
              nextActionAt: ago(30 * DAY),
            }),
          },
          settings,
          NOW,
        ),
      ),
      scorable(
        'stale_opportunity',
        DETECTORS.stale_opportunity.detect(
          {
            business,
            lead: lead({
              id: uid(53),
              valueCents: 5_000,
              stage: STAGE_DECIDING,
              qualification: 'qualified',
              createdAt: ago(100 * DAY),
              firstResponseAt: ago(100 * DAY),
              lastContactAt: ago(90 * DAY),
            }),
          },
          settings,
          NOW,
        ),
      ),
      scorable(
        'ai_approval',
        DETECTORS.ai_approval.detect(
          {
            business,
            approval: {
              id: uid(500),
              source: 'workflow',
              draftKind: null,
              status: 'pending',
              createdAt: ago(DAY),
              expiresAt: null,
              approvers: [],
            },
            lead: fifty(54),
            conversationAssigneeUserId: null,
          },
          settings,
          NOW,
        ),
      ),
    ];
    for (const r of reminders) {
      expect(urgencyOf(r, NOW), r.kind).toBeGreaterThan(2.99);
      expect(scoreOf(hot, NOW), r.kind).toBeGreaterThan(scoreOf(r, NOW));
    }
    expect(rankItems([...reminders, hot], NOW)[0]).toBe(hot);
  });

  it('knows when an item is urgent', () => {
    expect(isUrgent({ urgentFrom: null }, NOW)).toBe(false);
    expect(isUrgent({ urgentFrom: later(MIN) }, NOW)).toBe(false);
    expect(isUrgent({ urgentFrom: NOW.toISOString() }, NOW)).toBe(true);
    expect(isUrgent({ urgentFrom: ago(MIN) }, NOW)).toBe(true);
  });

  it('ranks urgent items first, then by score, with steady ties', () => {
    const big = { ...item({ value: 5_000_000 }), id: 'b' };
    const urgent = { ...item({ value: 1_000, urgentFrom: ago(MIN) }), id: 'u' };
    const twinA = { ...item(), id: 'a' };
    const twinC = { ...item(), id: 'c' };
    expect(rankItems([twinC, big, twinA, urgent], NOW).map((i) => i.id)).toEqual([
      'u',
      'b',
      'a',
      'c',
    ]);
    expect(rankItems([twinA, twinC], NOW)).toEqual(rankItems([twinC, twinA], NOW));
  });
});

describe('affectedCents', () => {
  it('counts each lead once and leaves out estimates', () => {
    expect(
      affectedCents([
        { value: 1_850_000, valueIsEstimate: false, moneyKey: `lead:${uid(1)}` },
        { value: 1_850_000, valueIsEstimate: false, moneyKey: `lead:${uid(1)}` },
        { value: 400_000, valueIsEstimate: false, moneyKey: `lead:${uid(2)}` },
        { value: 50_000, valueIsEstimate: true, moneyKey: null },
        { value: 90_000, valueIsEstimate: true, moneyKey: `lead:${uid(3)}` },
        { value: 70_000, valueIsEstimate: false, moneyKey: null },
      ]),
    ).toBe(2_250_000);
    expect(affectedCents([])).toBe(0);
  });
});
