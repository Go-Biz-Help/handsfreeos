import { describe, expect, it } from 'vitest';
import {
  ATTENTION_KINDS,
  attentionWakeAt,
  autoActionOf,
  defaultAttentionSettings,
  DETECTORS,
  detectAttention,
  fingerprintOf,
  isUrgent,
  parseAttentionSettings,
  type AiApprovalFacts,
  type AttentionSettings,
  type CustomerWaitingFacts,
  type Detection,
  type HotLeadFacts,
  type LeadFacts,
  type OverdueTaskFacts,
  type UnconfirmedAppointmentFacts,
} from '../src/attention/index';
import {
  ago,
  at,
  business,
  DALE,
  DAY,
  HOUR,
  iso,
  later,
  lead,
  MARIA,
  MIN,
  NO_REPEAT,
  NOW,
  shift,
  STAGE_QUOTED,
  uid,
} from './attention-fixtures';

const settings = defaultAttentionSettings();
const codes = (d: Detection | null) => d?.reasons.map((r) => r.code) ?? [];
const words = (d: Detection | null, code: string) => d?.reasons.find((r) => r.code === code)?.label;

// ---- hot_lead ----

describe('hot_lead', () => {
  const facts = (over: Partial<HotLeadFacts> = {}): HotLeadFacts => ({
    business,
    lead: lead(),
    awaitingReplySince: null,
    customerWords: [],
    repeat: NO_REPEAT,
    ...over,
  });
  const hot = (over: Partial<HotLeadFacts> = {}, now = NOW, s: AttentionSettings = settings) =>
    DETECTORS.hot_lead.detect(facts(over), s, now);

  it('opens on one strong signal: ready-to-book words', () => {
    const d = hot({ customerWords: ['Can you come out today? The AC is dead'] });
    expect(codes(d)).toEqual(['waiting', 'ready_to_book', 'came_in_today', 'not_contacted']);
    expect(words(d, 'waiting')).toBe('waiting 5 min');
    expect(d!.confidence).toBe(0.9);
    expect(d!.since).toBe(lead().createdAt);
    // Urgent 10 minutes after it came in, and the worker looks again then.
    expect(d!.urgentFrom).toBe(later(5 * MIN));
    expect(d!.recheckAt).toBe(d!.urgentFrom);
    expect(d!.assignee).toBe(DALE);
    // No value set: the typical job value, as an estimate.
    expect(d!).toMatchObject({ value: 50_000, valueIsEstimate: true, moneyKey: null });
  });

  it('opens on one strong signal: qualified', () => {
    const d = hot({
      lead: lead({
        qualification: 'qualified',
        createdAt: ago(2 * DAY),
        firstResponseAt: ago(2 * DAY),
        lastContactAt: ago(3 * MIN),
      }),
      awaitingReplySince: ago(3 * MIN),
    });
    expect(codes(d)).toEqual(['waiting', 'qualified']);
    expect(d!.since).toBe(ago(3 * MIN));
  });

  it('opens on two weak signals, never on one', () => {
    // $5,000 and came in today.
    const two = hot({ lead: lead({ valueCents: 500_000 }) });
    expect(codes(two)).toEqual(['value', 'waiting', 'came_in_today', 'not_contacted']);
    expect(words(two, 'value')).toBe('$5,000');
    expect(two!).toMatchObject({ confidence: 0.75, moneyKey: `lead:${uid(1)}` });
    expect(hot({ lead: lead({ valueCents: 499_999 }) })).toBeNull();

    const known = {
      lead: lead({ valueCents: 500_000, createdAt: ago(2 * DAY), firstResponseAt: ago(2 * DAY) }),
      awaitingReplySince: ago(MIN),
    };
    expect(hot(known)).toBeNull();
    expect(codes(hot({ ...known, repeat: { otherWonLeads: 1, pastVisits: 0 } }))).toContain(
      'repeat_customer',
    );
  });

  it('never counts an estimate as the value signal', () => {
    const rich = { ...business, medianWonCents: 900_000 };
    expect(hot({ business: rich })).toBeNull();
  });

  it('looks again at midnight when "came in today" is one of only two signals', () => {
    const late = at('2026-09-15', '23:55');
    const d = hot({ lead: lead({ valueCents: 500_000, createdAt: ago(20 * MIN, late) }) }, late);
    expect(d!.recheckAt).toBe(iso(at('2026-09-16', '00:00')));
  });

  it('never counts an import as new', () => {
    const imported = lead({ imported: true, valueCents: 600_000 });
    // Nobody is waiting: an imported lead hasn't asked for anything.
    expect(hot({ lead: imported })).toBeNull();
    // Their message waits, but "came in today" doesn't count, so $6,000 alone isn't enough.
    expect(hot({ lead: imported, awaitingReplySince: ago(2 * MIN) })).toBeNull();
    const d = hot({
      lead: imported,
      awaitingReplySince: ago(2 * MIN),
      customerWords: ['How soon can you get here?'],
    });
    expect(codes(d)).toEqual(['value', 'waiting', 'ready_to_book']);
  });

  it('skips a lead nobody is waiting on', () => {
    expect(
      hot({ lead: lead({ qualification: 'qualified', firstResponseAt: ago(MIN) }) }),
    ).toBeNull();
    expect(hot({ lead: lead({ createdByPerson: true, qualification: 'qualified' }) })).toBeNull();
  });

  it('skips won, lost, archived and not-a-fit leads', () => {
    const ready = { customerWords: ['Can I book for tomorrow?'] };
    expect(hot({ ...ready, lead: lead({ status: 'won' }) })).toBeNull();
    expect(hot({ ...ready, lead: lead({ status: 'lost' }) })).toBeNull();
    expect(hot({ ...ready, lead: lead({ archived: true }) })).toBeNull();
    expect(hot({ ...ready, lead: lead({ qualification: 'not_a_fit' }) })).toBeNull();
  });

  it('counts from the earlier of "not contacted yet" and a waiting message', () => {
    const d = hot({
      lead: lead({ createdAt: ago(40 * MIN), qualification: 'qualified' }),
      awaitingReplySince: ago(2 * MIN),
    });
    expect(d!.since).toBe(ago(40 * MIN));
  });

  it('turns urgent after 10 plain minutes, even after hours', () => {
    const night = at('2026-09-15', '21:00');
    const d = hot(
      { lead: lead({ createdAt: ago(3 * MIN, night) }), customerWords: ['Need someone ASAP'] },
      night,
    );
    expect(d!.urgentFrom).toBe(later(7 * MIN, night));
    expect(isUrgent(d!, night)).toBe(false);
    expect(isUrgent(d!, shift(night, 8 * MIN))).toBe(true);
  });

  it('is off when its switch is', () => {
    const off = parseAttentionSettings({ kinds: { hot_lead: false } });
    expect(hot({ customerWords: ['Can I book?'] }, NOW, off)).toBeNull();
  });
});

// ---- unanswered_lead ----

describe('unanswered_lead', () => {
  const run = (l: LeadFacts, now: Date, b = business) => ({
    d: DETECTORS.unanswered_lead.detect({ business: b, lead: l }, settings, now),
    wake: DETECTORS.unanswered_lead.wakeAt({ business: b, lead: l }, settings, now),
  });

  it('opens after 15 open-hours minutes: not at 14, at 16', () => {
    const l = lead({ createdAt: iso(at('2026-09-15', '09:45')) });
    const early = run(l, at('2026-09-15', '09:59'));
    expect(early.d).toBeNull();
    expect(early.wake).toBe(iso(at('2026-09-15', '10:00')));
    const { d } = run(l, at('2026-09-15', '10:01'));
    expect(codes(d)).toEqual(['waiting', 'not_contacted']);
    expect(words(d, 'waiting')).toBe('waiting 16 min');
    expect(d!.urgentFrom).toBe(iso(at('2026-09-15', '10:00')));
    expect(isUrgent(d!, at('2026-09-15', '10:01'))).toBe(true);
    expect(d!.confidence).toBe(0.9);
  });

  it('counts open hours, not the clock', () => {
    const l = lead({ createdAt: iso(at('2026-09-15', '16:55')) });
    const evening = run(l, at('2026-09-15', '17:20'));
    expect(evening.d).toBeNull();
    expect(evening.wake).toBe(iso(at('2026-09-16', '08:10')));
    expect(run(l, at('2026-09-16', '08:09')).d).toBeNull();
    const { d } = run(l, at('2026-09-16', '08:11'));
    expect(words(d, 'waiting')).toBe('waiting 15 h');
  });

  it('waits for Monday over a weekend', () => {
    const l = lead({ createdAt: iso(at('2026-09-19', '10:00')) });
    expect(run(l, at('2026-09-19', '12:00')).wake).toBe(iso(at('2026-09-21', '08:15')));
  });

  it('counts plain minutes for a business with no open hours', () => {
    const always = { ...business, openHours: [] };
    const l = lead({ createdAt: iso(at('2026-09-15', '21:00')) });
    expect(run(l, at('2026-09-15', '21:14'), always).d).toBeNull();
    expect(run(l, at('2026-09-15', '21:16'), always).d).not.toBeNull();
  });

  it('skips imports, leads a person entered, and leads someone has reached', () => {
    const now = shift(NOW, HOUR);
    expect(run(lead({ imported: true }), now)).toEqual({ d: null, wake: null });
    expect(run(lead({ createdByPerson: true }), now)).toEqual({ d: null, wake: null });
    expect(run(lead({ firstResponseAt: ago(MIN) }), now)).toEqual({ d: null, wake: null });
  });

  it('skips won and lost leads', () => {
    const now = shift(NOW, HOUR);
    expect(run(lead({ status: 'won' }), now).d).toBeNull();
    expect(run(lead({ status: 'lost' }), now).d).toBeNull();
  });
});

// ---- stale_opportunity ----

describe('stale_opportunity', () => {
  const quoted = (lastContact: number | null, over: Partial<LeadFacts> = {}) =>
    lead({
      createdAt: ago(30 * DAY),
      firstResponseAt: ago(30 * DAY),
      lastContactAt: lastContact === null ? null : ago(lastContact),
      stage: STAGE_QUOTED,
      valueCents: 1_850_000,
      nextAction: 'Follow up on the quote',
      ...over,
    });
  const run = (l: LeadFacts, s = settings, now = NOW) => ({
    d: DETECTORS.stale_opportunity.detect({ business, lead: l }, s, now),
    wake: DETECTORS.stale_opportunity.wakeAt({ business, lead: l }, s, now),
  });

  it('goes stale after 7 days without contact', () => {
    const almost = run(quoted(7 * DAY - HOUR));
    expect(almost.d).toBeNull();
    expect(almost.wake).toBe(later(HOUR));
    const { d } = run(quoted(7 * DAY + MIN));
    expect(codes(d)).toEqual(['value', 'last_contact', 'stage']);
    expect(d!.reasons.map((r) => r.label)).toEqual([
      '$18,500',
      'Last contact 7 days ago',
      'Quote sent',
    ]);
    expect(d!).toMatchObject({ moneyKey: `lead:${uid(1)}`, urgentFrom: null, confidence: 0.7 });
    expect(autoActionOf('stale_opportunity', d!.reasons)).toBe('nudge');
  });

  it('uses a stage’s own stale days', () => {
    const fast = parseAttentionSettings({ stale: { stageDays: { [STAGE_QUOTED.id]: 3 } } });
    expect(run(quoted(4 * DAY), fast).d).not.toBeNull();
    expect(run(quoted(4 * DAY)).d).toBeNull();
  });

  it('counts from when it came in when there has been no contact', () => {
    const { d } = run(quoted(null, { createdAt: ago(8 * DAY), firstResponseAt: null }));
    expect(words(d, 'no_contact')).toBe('No contact yet');
  });

  it('includes imported leads (the list folds them into a group)', () => {
    expect(run(quoted(null, { imported: true, createdAt: ago(8 * DAY) })).d).not.toBeNull();
  });

  it('skips won and lost leads', () => {
    expect(run(quoted(9 * DAY, { status: 'won' })).d).toBeNull();
    expect(run(quoted(9 * DAY, { status: 'lost' })).d).toBeNull();
  });

  it('comes back with new facts after a new contact goes stale again', () => {
    const first = run(quoted(8 * DAY)).d!;
    // A new contact yesterday clears it.
    const contacted = quoted(DAY);
    expect(run(contacted).d).toBeNull();
    // A week on, that contact has gone stale too: a new fingerprint, so a dismissed item comes back.
    const second = run(contacted, settings, shift(NOW, 7 * DAY)).d!;
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });
});

// ---- missing_next_action ----

describe('missing_next_action', () => {
  const known = (over: Partial<LeadFacts> = {}) =>
    lead({
      createdAt: ago(3 * DAY),
      stageEnteredAt: ago(2 * DAY),
      firstResponseAt: ago(3 * DAY),
      lastContactAt: ago(HOUR),
      stage: STAGE_QUOTED,
      ...over,
    });
  const run = (l: LeadFacts, now = NOW) => ({
    d: DETECTORS.missing_next_action.detect({ business, lead: l }, settings, now),
    wake: DETECTORS.missing_next_action.wakeAt({ business, lead: l }, settings, now),
  });

  it('opens for an open lead with no next action, and asks first', () => {
    const { d } = run(known());
    expect(codes(d)).toEqual(['no_next_action', 'stage']);
    expect(d!.since).toBe(ago(2 * DAY));
    expect(autoActionOf('missing_next_action', d!.reasons)).toBeNull();
  });

  it('waits for a next action in the future', () => {
    const r = run(
      known({ nextAction: 'Call back about the quote', nextActionAt: later(2 * HOUR) }),
    );
    expect(r.d).toBeNull();
    expect(r.wake).toBe(later(2 * HOUR));
  });

  it('opens for an overdue follow-up, which may go out on its own as a nudge', () => {
    const { d } = run(
      known({ nextAction: 'Call back about the quote', nextActionAt: ago(2 * DAY) }),
    );
    expect(codes(d)).toEqual(['follow_up_overdue', 'next_action']);
    expect(words(d, 'follow_up_overdue')).toBe('follow-up 2 days overdue');
    expect(words(d, 'next_action')).toBe('Call back about the quote');
    expect(d!).toMatchObject({ dueAt: ago(2 * DAY), confidence: 0.8 });
    expect(autoActionOf('missing_next_action', d!.reasons)).toBe('nudge');
  });

  it('leaves a next action with no time alone', () => {
    expect(run(known({ nextAction: 'Send photos of the unit' }))).toEqual({ d: null, wake: null });
  });

  it('skips won and lost leads', () => {
    expect(run(known({ status: 'won' })).d).toBeNull();
    expect(run(known({ status: 'lost', nextActionAt: ago(DAY) })).d).toBeNull();
  });

  it('gets new facts when the follow-up moves', () => {
    const a = run(known({ nextActionAt: ago(2 * DAY) })).d!;
    const b = run(known({ nextActionAt: ago(DAY) })).d!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

// ---- unconfirmed_appointment ----

describe('unconfirmed_appointment', () => {
  const facts = (
    startsIn: number,
    over: {
      appointment?: Partial<UnconfirmedAppointmentFacts['appointment']>;
      attendee?: Partial<UnconfirmedAppointmentFacts['attendee']>;
      lead?: UnconfirmedAppointmentFacts['lead'];
    } = {},
  ): UnconfirmedAppointmentFacts => ({
    business,
    appointment: {
      id: uid(300),
      kind: 'booking',
      status: 'scheduled',
      startsAt: later(startsIn),
      ownerUserId: DALE,
      ...over.appointment,
    },
    attendee: {
      id: uid(301),
      personId: MARIA,
      status: 'booked',
      confirmedAt: null,
      confirmAskedAt: null,
      ...over.attendee,
    },
    lead: over.lead ?? null,
  });
  const run = (f: UnconfirmedAppointmentFacts, s = settings) => ({
    d: DETECTORS.unconfirmed_appointment.detect(f, s, NOW),
    wake: DETECTORS.unconfirmed_appointment.wakeAt(f, s, NOW),
  });

  it('opens 48 hours before the start: not at 49, at 47', () => {
    const early = run(facts(49 * HOUR));
    expect(early.d).toBeNull();
    expect(early.wake).toBe(later(HOUR));
    const { d } = run(facts(47 * HOUR));
    expect(codes(d)).toEqual(['starts_in']);
    expect(words(d, 'starts_in')).toBe('starts in 1 day');
    expect(d!).toMatchObject({
      dueAt: later(47 * HOUR),
      recheckAt: later(47 * HOUR),
      urgentFrom: null,
      assignee: DALE,
    });
    expect(autoActionOf('unconfirmed_appointment', d!.reasons)).toBe('confirm_request');
  });

  it('follows the window setting', () => {
    const day = parseAttentionSettings({ appointments: { windowHours: 24 } });
    expect(run(facts(30 * HOUR), day).d).toBeNull();
    expect(run(facts(20 * HOUR), day).d).not.toBeNull();
  });

  it('says when the customer has been asked', () => {
    const { d } = run(facts(20 * HOUR, { attendee: { confirmAskedAt: ago(HOUR) } }));
    expect(codes(d)).toEqual(['starts_in', 'asked_to_confirm']);
  });

  it('skips confirmed, started, cancelled and group appointments', () => {
    expect(run(facts(20 * HOUR, { attendee: { confirmedAt: ago(MIN) } })).d).toBeNull();
    expect(run(facts(-MIN)).d).toBeNull();
    expect(run(facts(20 * HOUR, { appointment: { status: 'cancelled' } })).d).toBeNull();
    expect(run(facts(20 * HOUR, { appointment: { kind: 'session' } })).d).toBeNull();
    expect(run(facts(20 * HOUR, { attendee: { status: 'cancelled' } })).d).toBeNull();
  });

  it('takes its value from the appointment’s lead, unless it was lost', () => {
    const won = run(
      facts(20 * HOUR, { lead: { id: uid(1), valueCents: 1_200_000, status: 'won' } }),
    );
    expect(won.d!).toMatchObject({
      value: 1_200_000,
      valueIsEstimate: false,
      moneyKey: `lead:${uid(1)}`,
    });
    const lost = run(
      facts(20 * HOUR, { lead: { id: uid(1), valueCents: 1_200_000, status: 'lost' } }),
    );
    expect(lost.d!).toMatchObject({ value: 50_000, valueIsEstimate: true, moneyKey: null });
  });
});

// ---- ai_approval ----

describe('ai_approval', () => {
  const facts = (over: Partial<AiApprovalFacts['approval']> = {}): AiApprovalFacts => ({
    business,
    approval: {
      id: uid(500),
      source: 'teammate',
      draftKind: 'reply',
      status: 'pending',
      createdAt: ago(12 * MIN),
      expiresAt: later(108 * MIN),
      approvers: [],
      ...over,
    },
    lead: null,
    conversationAssigneeUserId: DALE,
  });
  const run = (f: AiApprovalFacts) => DETECTORS.ai_approval.detect(f, settings, NOW);

  it('opens for a pending draft until it expires, and never runs on its own', () => {
    const d = run(facts());
    expect(codes(d)).toEqual(['waiting', 'draft', 'expires_in']);
    expect(d!.reasons.map((r) => r.label)).toEqual([
      'waiting 12 min',
      'AI reply draft',
      'expires in 1 h',
    ]);
    expect(d!).toMatchObject({ assignee: DALE, recheckAt: later(108 * MIN), urgentFrom: null });
    expect(autoActionOf('ai_approval', d!.reasons)).toBeNull();
  });

  it('names a workflow step’s only approver', () => {
    const one = run(facts({ source: 'workflow', draftKind: null, approvers: [uid(901)] }));
    expect(words(one, 'approval')).toBe('workflow approval');
    expect(one!.assignee).toBe(uid(901));
    expect(
      run(facts({ source: 'workflow', draftKind: null, approvers: [uid(901), uid(902)] }))!
        .assignee,
    ).toBeNull();
  });

  it('clears once decided or expired', () => {
    expect(run(facts({ status: 'approved' }))).toBeNull();
    expect(run(facts({ expiresAt: ago(MIN) }))).toBeNull();
  });
});

// ---- customer_waiting ----

describe('customer_waiting', () => {
  const facts = (
    over: Partial<CustomerWaitingFacts['conversation']> = {},
    threshold = 10,
  ): CustomerWaitingFacts => ({
    business,
    conversation: {
      id: uid(400),
      personId: MARIA,
      status: 'open',
      assigneeUserId: null,
      awaitingReplySince: ago(9 * MIN),
      handledBy: 'none',
      needsPersonSince: null,
      takenOverBy: null,
      ...over,
    },
    replyThresholdMinutes: threshold,
    lead: null,
  });
  const run = (f: CustomerWaitingFacts, now = NOW) => ({
    d: DETECTORS.customer_waiting.detect(f, settings, now),
    wake: DETECTORS.customer_waiting.wakeAt(f, settings, now),
  });

  it('opens past the reply threshold: not at 9 minutes, at 11', () => {
    const early = run(facts());
    expect(early.d).toBeNull();
    expect(early.wake).toBe(later(MIN));
    const { d } = run(facts({ awaitingReplySince: ago(11 * MIN) }));
    expect(codes(d)).toEqual(['waiting']);
    expect(d!.urgentFrom).toBe(ago(MIN));
    expect(isUrgent(d!, NOW)).toBe(true);
  });

  it('waits 15 open-hours minutes after a hand-off', () => {
    const handedOff = facts({
      handledBy: 'person',
      awaitingReplySince: iso(at('2026-09-15', '16:48')),
      needsPersonSince: iso(at('2026-09-15', '16:50')),
    });
    expect(run(handedOff, at('2026-09-15', '17:30')).wake).toBe(iso(at('2026-09-16', '08:05')));
    const { d } = run(handedOff, at('2026-09-16', '08:06'));
    expect(codes(d)).toEqual(['waiting', 'handed_off']);
    expect(d!.since).toBe(iso(at('2026-09-15', '16:48')));
  });

  it('opens at once, never urgent, with the reply alert off', () => {
    const { d } = run(facts({ awaitingReplySince: ago(MIN) }, 0));
    expect(d).not.toBeNull();
    expect(d!.urgentFrom).toBeNull();
  });

  it('skips snoozed and closed conversations, and one a person took over', () => {
    expect(run(facts({ status: 'snoozed', awaitingReplySince: ago(HOUR) })).d).toBeNull();
    expect(run(facts({ status: 'closed', awaitingReplySince: ago(HOUR) })).d).toBeNull();
    const takenOver = facts({
      handledBy: 'person',
      awaitingReplySince: null,
      needsPersonSince: ago(HOUR),
      takenOverBy: DALE,
    });
    expect(run(takenOver).d).toBeNull();
  });
});

// ---- overdue_task ----

describe('overdue_task', () => {
  const facts = (over: Partial<OverdueTaskFacts['task']> = {}): OverdueTaskFacts => ({
    business,
    task: {
      id: uid(600),
      title: 'Call Maria back',
      dueAt: ago(HOUR),
      allDay: false,
      doneAt: null,
      assigneeUserId: DALE,
      ...over,
    },
    lead: null,
  });
  const run = (f: OverdueTaskFacts, now = NOW) => ({
    d: DETECTORS.overdue_task.detect(f, settings, now),
    wake: DETECTORS.overdue_task.wakeAt(f, settings, now),
  });

  it('opens once a timed task is past due', () => {
    const soon = run(facts({ dueAt: later(HOUR) }));
    expect(soon).toEqual({ d: null, wake: later(HOUR) });
    const { d } = run(facts());
    expect(codes(d)).toEqual(['overdue']);
    expect(words(d, 'overdue')).toBe('1 h overdue');
    expect(d!.assignee).toBe(DALE);
    expect(autoActionOf('overdue_task', d!.reasons)).toBeNull();
  });

  it('lets an all-day task run to the end of its day', () => {
    const today = facts({ dueAt: iso(at('2026-09-15', '00:00')), allDay: true });
    expect(run(today)).toEqual({ d: null, wake: iso(at('2026-09-16', '00:00')) });
    const { d } = run(today, at('2026-09-16', '00:01'));
    expect(words(d, 'overdue')).toBe('1 min overdue');
  });

  it('skips done tasks and tasks with no due time', () => {
    expect(run(facts({ doneAt: ago(MIN) })).d).toBeNull();
    expect(run(facts({ dueAt: null }))).toEqual({ d: null, wake: null });
  });

  it('takes its value from the task’s lead', () => {
    const d = DETECTORS.overdue_task.detect(
      { ...facts(), lead: { id: uid(1), valueCents: 250_000, status: 'open' } },
      settings,
      NOW,
    );
    expect(codes(d)).toEqual(['value', 'overdue']);
  });
});

// ---- fingerprints and the registry ----

describe('fingerprints', () => {
  const hotFacts = (createdAt: string): HotLeadFacts => ({
    business,
    lead: lead({ createdAt, qualification: 'qualified' }),
    awaitingReplySince: null,
    customerWords: [],
    repeat: NO_REPEAT,
  });

  it('are the same for the same facts, however a time is written', () => {
    const a = DETECTORS.hot_lead.detect(hotFacts('2026-09-15T14:55:00Z'), settings, NOW)!;
    const b = DETECTORS.hot_lead.detect(hotFacts('2026-09-15T14:55:00.000Z'), settings, NOW)!;
    const c = DETECTORS.hot_lead.detect(
      hotFacts('2026-09-15T14:55:00.000Z'),
      settings,
      shift(NOW, 3 * MIN),
    )!;
    expect(a.fingerprint).toBe(b.fingerprint);
    // Time passing isn't a new fact.
    expect(c.fingerprint).toBe(a.fingerprint);
    expect(a.fingerprint).toBe(`hot_lead|v1|lead=${uid(1)}|since=2026-09-15T14:55:00.000Z`);
  });

  it('ignore key order, and hash what doesn’t fit the column', () => {
    expect(fingerprintOf('overdue_task', { a: 1, b: 'x' })).toBe(
      fingerprintOf('overdue_task', { b: 'x', a: 1 }),
    );
    const long = { note: 'x'.repeat(300) };
    const hashed = fingerprintOf('overdue_task', long);
    expect(hashed).toMatch(/^overdue_task\|v1\|#[0-9a-f]{14}$/);
    expect(fingerprintOf('overdue_task', long)).toBe(hashed);
    expect(fingerprintOf('overdue_task', { note: `${'x'.repeat(299)}y` })).not.toBe(hashed);
  });

  it('fit in 200 characters for every kind', () => {
    const found = [
      DETECTORS.hot_lead.detect(hotFacts(ago(MIN)), settings, NOW),
      DETECTORS.customer_waiting.detect(
        {
          business,
          conversation: {
            id: uid(400),
            personId: MARIA,
            status: 'open',
            assigneeUserId: null,
            awaitingReplySince: ago(HOUR),
            handledBy: 'person',
            needsPersonSince: ago(2 * HOUR),
            takenOverBy: null,
          },
          replyThresholdMinutes: 10,
          lead: null,
        },
        settings,
        NOW,
      ),
      DETECTORS.missing_next_action.detect({ business, lead: lead() }, settings, NOW),
    ];
    for (const d of found) expect(d!.fingerprint.length).toBeLessThanOrEqual(200);
  });
});

describe('registry', () => {
  it('has a detector for every kind', () => {
    expect(Object.keys(DETECTORS).sort()).toEqual([...ATTENTION_KINDS].sort());
  });

  it('runs a kind by name', () => {
    const f = { business, lead: lead({ createdAt: iso(at('2026-09-15', '09:45')) }) };
    expect(detectAttention('unanswered_lead', f, settings, at('2026-09-15', '10:01'))).toEqual(
      DETECTORS.unanswered_lead.detect(f, settings, at('2026-09-15', '10:01')),
    );
    expect(attentionWakeAt('unanswered_lead', f, settings, at('2026-09-15', '09:50'))).toBe(
      iso(at('2026-09-15', '10:00')),
    );
  });
});
