/**
 * Automations' service, hand-offs and revenue (stage 4a), without a database: the promise word check, and when a
 * regular gone quiet, a promise not kept, an approval about to expire and a week of money open their cards.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultAttentionSettings,
  DETECTORS,
  type AiApprovalFacts,
  type ClientQuietFacts,
  type PromiseDueFacts,
  type RevenueMovedFacts,
} from '../src/attention/index';
import { mondayOf } from '../src/attention/load-service';
import { mayPromise } from '../src/automations/promise-words';
import { ago, business, DALE, DAY, HOUR, later, NOW, TZ, uid } from './attention-fixtures';

const settings = defaultAttentionSettings();

describe('the promise word check', () => {
  it('needs a promise and a time', () => {
    for (const yes of [
      "I'll send the quote tomorrow",
      'We will swing by Friday afternoon',
      'Let me check with the supplier and get back to you by 3pm',
      'I’ll call you back this afternoon',
      "I'm going to email it over tonight",
    ])
      expect(mayPromise(yes), yes).toBe(true);
    for (const no of [
      'Let me know if you need anything',
      'Thanks for choosing us!',
      "I'll look into it",
      'See you tomorrow',
      '',
      null,
    ])
      expect(mayPromise(no), String(no)).toBe(false);
  });
});

describe('client_quiet', () => {
  const facts = (over: Partial<ClientQuietFacts['regular']> = {}): ClientQuietFacts => ({
    business,
    regular: {
      personId: uid(1),
      visits: 3,
      lastVisitAt: ago(200 * DAY),
      usualGapDays: 90,
      bookedAhead: false,
      covered: false,
      lastContactAt: ago(200 * DAY),
      ...over,
    },
    lead: null,
    assigneeUserId: DALE,
  });
  const detect = (f: ClientQuietFacts) => DETECTORS.client_quiet.detect(f, settings, NOW);

  it('opens at twice their usual gap, and says how long it has been', () => {
    const d = detect(facts());
    expect(d?.reasons[0]).toMatchObject({
      code: 'quiet',
      label: 'Usually every 3 months · 7 months since',
    });
    // 170 days in, 180 due: not yet.
    expect(detect(facts({ lastVisitAt: ago(170 * DAY) }))).toBeNull();
    // A short gap still waits at least 60 days.
    expect(detect(facts({ usualGapDays: 14, lastVisitAt: ago(40 * DAY) }))).toBeNull();
    expect(detect(facts({ usualGapDays: 14, lastVisitAt: ago(61 * DAY) }))).not.toBeNull();
  });

  it('leaves alone the few-timers, the booked, the covered and the ones already contacted', () => {
    expect(detect(facts({ visits: 2 }))).toBeNull();
    expect(detect(facts({ bookedAhead: true }))).toBeNull();
    expect(detect(facts({ covered: true }))).toBeNull();
    expect(detect(facts({ lastContactAt: ago(5 * DAY) }))).toBeNull();
    // And lets go 90 days after it opened.
    expect(detect(facts({ lastVisitAt: ago(280 * DAY) }))).toBeNull();
  });
});

describe('promise_due', () => {
  const facts = (over: Partial<PromiseDueFacts> = {}): PromiseDueFacts => ({
    business,
    promise: {
      id: uid(2),
      what: 'send the quote',
      kind: 'send',
      dueAt: ago(2 * HOUR),
      dueLabel: 'Tue, Sep 15 at 5:00 PM',
      status: 'open',
    },
    keptAt: null,
    lead: null,
    assigneeUserId: DALE,
    ...over,
  });
  const d = DETECTORS.promise_due;

  it('opens an hour after its time when nothing of the kind reached them', () => {
    expect(d.detect(facts(), settings, NOW)?.reasons[0]).toMatchObject({
      code: 'promise',
      label: 'You said: send the quote · Tue, Sep 15 at 5:00 PM',
    });
    const soon = facts({ promise: { ...facts().promise, dueAt: ago(30 * 60_000) } });
    expect(d.detect(soon, settings, NOW)).toBeNull();
    expect(d.wakeAt(soon, settings, NOW)).not.toBeNull();
  });

  it('stands down once kept or dismissed, and lets go after two weeks', () => {
    expect(d.detect(facts({ keptAt: ago(HOUR) }), settings, NOW)).toBeNull();
    expect(
      d.detect(facts({ promise: { ...facts().promise, status: 'dismissed' } }), settings, NOW),
    ).toBeNull();
    expect(
      d.detect(facts({ promise: { ...facts().promise, dueAt: ago(15 * DAY) } }), settings, NOW),
    ).toBeNull();
  });
});

describe('approvals about to expire', () => {
  const facts = (expiresIn: number, expiryWarn = true): AiApprovalFacts => ({
    business,
    approval: {
      id: uid(3),
      source: 'workflow',
      draftKind: null,
      status: 'pending',
      createdAt: ago(DAY),
      expiresAt: later(expiresIn),
      approvers: [],
    },
    lead: null,
    conversationAssigneeUserId: null,
    expiryWarn,
  });
  it('turns urgent two hours before it expires, while the switch is on', () => {
    const d = DETECTORS.ai_approval.detect(facts(5 * HOUR), settings, NOW)!;
    expect(Date.parse(d.urgentFrom!)).toBe(Date.parse(later(3 * HOUR)));
    expect(
      DETECTORS.ai_approval.detect(facts(5 * HOUR, false), settings, NOW)!.urgentFrom,
    ).toBeNull();
  });
});

describe('revenue_moved', () => {
  const monday = mondayOf(NOW.getTime(), TZ);
  const facts = (over: Partial<RevenueMovedFacts> = {}): RevenueMovedFacts => ({
    business,
    week: { start: monday, opensAt: ago(HOUR), endsAt: later(6 * DAY) },
    lastCents: 620_000,
    usualCents: 900_000,
    weeksCounted: 8,
    reason: '6 jobs done, usually 10',
    ...over,
  });
  const detect = (f: RevenueMovedFacts) => DETECTORS.revenue_moved.detect(f, settings, NOW);

  it('opens on Monday when the week was 30% or more off the usual one', () => {
    expect(detect(facts())?.reasons[0]).toMatchObject({
      code: 'revenue',
      label: '$6,200 last week · usually $9,000 (−31%)',
    });
    expect(detect(facts({ lastCents: 1_200_000 }))?.reasons[0]?.label).toContain('(+33%)');
  });

  it('says nothing for a small change, a small business, or too little history', () => {
    expect(detect(facts({ lastCents: 700_000 }))).toBeNull();
    expect(detect(facts({ usualCents: 40_000, lastCents: 10_000 }))).toBeNull();
    expect(detect(facts({ weeksCounted: 3 }))).toBeNull();
    expect(detect(facts({ usualCents: null }))).toBeNull();
    // Before Monday 6 AM it waits; after next Monday it's gone.
    expect(detect(facts({ week: { ...facts().week, opensAt: later(HOUR) } }))).toBeNull();
    expect(detect(facts({ week: { ...facts().week, endsAt: ago(HOUR) } }))).toBeNull();
  });
});
