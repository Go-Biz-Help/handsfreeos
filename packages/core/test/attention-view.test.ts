/**
 * The Action Center's list, the same on the server and the phone (M10): a set of stored rows sorted, ranked, counted
 * and shaped as `attention.list` answers; a phone's synced rows giving the same answer; who may decide an approval; and
 * the hints (the appointment, the channel, the call) from facts, as the server looks them up and the phone reads them.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAlertOfSynced,
  attentionListOut,
  attentionListView,
  attentionRowOfSynced,
  attentionToday,
  attentionViewerOfSynced,
  hintFactsOfSynced,
  inAttentionList,
  itemHintsOf,
  mayDecideApproval,
  namesOfSynced,
  reachBusinessOfSynced,
  type AttentionRow,
  type AttentionViewer,
  type HintFacts,
  type SyncedAttentionRow,
} from '../src/attention/index';
import { AttentionListOutput } from '../src/schemas/attention';
import { DALE, HOUR, MIN, NOW, TZ, uid } from './attention-fixtures';

const PRIYA = uid(901);
const at = NOW.getTime();

function row(over: Partial<AttentionRow> & { id: string }): AttentionRow {
  return {
    kind: 'unanswered_lead',
    subjectType: 'lead',
    subjectId: uid(500),
    personId: null,
    leadId: null,
    conversationId: null,
    state: 'open',
    openedAt: new Date(at - HOUR),
    sinceAt: new Date(at - 20 * MIN),
    urgentFrom: null,
    dueAt: null,
    valueCents: 0,
    valueIsEstimate: false,
    moneyKey: null,
    probability: 0.6,
    confidence: 0.8,
    reasons: [],
    title: 'Someone',
    detail: null,
    assigneeUserId: null,
    snoozedUntil: null,
    dismissedAt: null,
    dismissReason: null,
    handledAt: null,
    handledBy: null,
    handledVia: null,
    autoState: null,
    autoScheduledFor: null,
    autoDoneAt: null,
    autoSkipReason: null,
    ...over,
  };
}

const viewer = (
  decidable: string[] = [],
  role: AttentionViewer['role'] = 'owner',
): AttentionViewer => ({
  userId: DALE,
  role,
  decidable: new Set(decidable),
});

const ROWS: AttentionRow[] = [
  // A hot lead past its urgent moment, $18,500.
  row({
    id: uid(1),
    kind: 'hot_lead',
    leadId: uid(11),
    personId: uid(21),
    title: 'Maria Lopez · New AC install',
    valueCents: 1_850_000,
    moneyKey: `lead:${uid(11)}`,
    urgentFrom: new Date(at - 5 * MIN),
    sinceAt: new Date(at - 11 * MIN),
    probability: 0.8,
    confidence: 0.9,
    reasons: [
      { code: 'value', label: '$18,500' },
      { code: 'waiting', label: 'waiting 11 min', since: new Date(at - 11 * MIN).toISOString() },
      { code: 'qualified', label: 'qualified' },
    ],
    assigneeUserId: DALE,
  }),
  // Priya's unanswered lead with a typical value (left out of $ affected).
  row({
    id: uid(2),
    leadId: uid(12),
    title: 'Carlos Mendoza · Roof leak repair',
    valueCents: 420_000,
    valueIsEstimate: true,
    assigneeUserId: PRIYA,
  }),
  // An overdue invoice for Maria's job: the same money seen again, the larger counts once.
  row({
    id: uid(3),
    kind: 'invoice_overdue',
    subjectType: 'invoice',
    subjectId: uid(31),
    leadId: uid(11),
    title: 'Maria Lopez · INV-1036',
    valueCents: 255_188,
    moneyKey: `invoice:${uid(31)}`,
  }),
  // An approval Dale may not decide: nobody but its approvers sees it.
  row({ id: uid(4), kind: 'ai_approval', subjectType: 'approval', subjectId: uid(41) }),
  // Snoozed, handled today by HandsFreeOS, handled yesterday, and dismissed.
  row({ id: uid(5), state: 'snoozed', snoozedUntil: new Date(at + HOUR) }),
  row({
    id: uid(6),
    kind: 'unconfirmed_appointment',
    subjectType: 'attendee',
    state: 'handled',
    handledAt: new Date(at - 30 * MIN),
    handledVia: 'auto',
  }),
  row({ id: uid(7), state: 'handled', handledAt: new Date(at - 30 * HOUR), handledVia: 'person' }),
  row({ id: uid(8), state: 'dismissed', dismissedAt: new Date(at - MIN) }),
];

describe('attention list', () => {
  const today = attentionToday(at, TZ);
  const inList = ROWS.filter((r) => inAttentionList(r, today));
  const v = viewer();
  const visible = inList.filter((r) => r.kind !== 'ai_approval' || v.decidable.has(r.subjectId));

  it('keeps open and snoozed items and today’s handled ones', () => {
    expect(inList.map((r) => r.id)).toEqual([uid(1), uid(2), uid(3), uid(4), uid(5), uid(6)]);
  });

  it('ranks, counts and shapes the list as attention.list does', () => {
    const view = attentionListView(visible, { me: DALE, role: 'owner', now: at });
    expect(view.scope).toBe('everyone');
    const out = attentionListOut(view, {
      viewer: v,
      names: new Map([[DALE, 'Dale Carter']]),
      hints: new Map(),
      now: at,
      includeHandled: true,
    });
    expect(out.items.map((i) => i.id)).toEqual([uid(1), uid(2), uid(3)]);
    expect(out.items[0]).toMatchObject({
      urgent: true,
      assignee: { id: DALE, fullName: 'Dale Carter' },
      reasons: [
        { code: 'value', text: '$18,500' },
        { code: 'waiting', text: 'waiting 11 min' },
        { code: 'qualified', text: 'qualified' },
      ],
      actions: { handle: true, letHandle: true, assign: true, snooze: true, dismiss: true },
    });
    expect(out.affectedCents).toBe(1_850_000);
    expect(out.counts).toEqual({ total: 3, urgent: 1, snoozed: 1, mine: 2, everyone: 3 });
    expect(out.handled.map((i) => i.id)).toEqual([uid(6)]);
    expect(out.handledToday).toBe(1);
  });

  it('Mine is yours and unassigned ones; members start there', () => {
    const view = attentionListView(visible, { me: DALE, role: 'member', now: at });
    expect(view.scope).toBe('mine');
    expect(view.ranked.map((r) => r.id)).toEqual([uid(1), uid(3)]);
  });

  it('counts an item cleared today as handled when someone dealt with it', () => {
    const cleared = row({
      id: uid(9),
      state: 'resolved',
      resolvedAt: new Date(at - MIN),
      resolution: 'replied',
    });
    const view = attentionListView([...visible, cleared], { me: DALE, role: 'owner', now: at });
    const out = attentionListOut(view, {
      viewer: v,
      names: new Map(),
      hints: new Map(),
      now: at,
      includeHandled: false,
    });
    expect(out.handledToday).toBe(2);
    expect(out.handled).toEqual([]);
  });

  it('answers with a quiet channel, whose id is a hash and not a strict UUID', () => {
    // As `loadChannels` makes it: md5(workspace || ':channel:' || kind)::uuid, version and variant bits and all.
    const quiet = row({
      id: uid(10),
      kind: 'channel_quiet',
      subjectType: 'channel_call',
      subjectId: 'e4913ac6-0b0c-df1a-d68d-22301a238108',
      reasons: [{ code: 'quiet_channel', label: 'Calls usually every 34 h' }],
      title: 'Calls have gone quiet',
    });
    const view = attentionListView([...visible, quiet], { me: DALE, role: 'owner', now: at });
    const out = attentionListOut(view, {
      viewer: v,
      names: new Map(),
      hints: new Map(),
      now: at,
      includeHandled: true,
    });
    const parsed = AttentionListOutput.parse(out);
    expect(parsed.items.find((i) => i.id === uid(10))?.subject).toEqual({
      type: 'channel_call',
      id: 'e4913ac6-0b0c-df1a-d68d-22301a238108',
    });
  });
});

describe('who may decide an approval', () => {
  it('a workflow’s: its approvers, or whoever manages workflows', () => {
    const flow = { source: 'workflow' as const, approvers: [PRIYA], kind: null };
    expect(mayDecideApproval({ role: 'member' }, PRIYA, flow)).toBe(true);
    expect(mayDecideApproval({ role: 'member' }, DALE, flow)).toBe(false);
    expect(mayDecideApproval({ role: 'admin' }, DALE, flow)).toBe(true);
  });
  it('a teammate’s reply by anyone in the inbox, what it asks approval for by owners and admins', () => {
    expect(
      mayDecideApproval({ role: 'member' }, DALE, {
        source: 'teammate',
        approvers: [],
        kind: 'reply',
      }),
    ).toBe(true);
    expect(
      mayDecideApproval({ role: 'member' }, DALE, {
        source: 'teammate',
        approvers: [],
        kind: 'approval',
      }),
    ).toBe(false);
  });
});

/** A row as a phone's copy holds it: ISO text, 1 or 0, JSON text. */
function synced(r: AttentionRow): SyncedAttentionRow {
  const t = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: r.id,
    kind: r.kind,
    subject_type: r.subjectType,
    subject_id: r.subjectId,
    person_id: r.personId,
    lead_id: r.leadId,
    conversation_id: r.conversationId,
    state: r.state,
    opened_at: t(r.openedAt),
    since_at: t(r.sinceAt),
    urgent_from: t(r.urgentFrom),
    due_at: t(r.dueAt),
    value_cents: r.valueCents,
    value_is_estimate: r.valueIsEstimate ? 1 : 0,
    money_key: r.moneyKey,
    probability: r.probability,
    confidence: r.confidence,
    reasons: JSON.stringify(r.reasons),
    title: r.title,
    detail: r.detail,
    assignee_user_id: r.assigneeUserId,
    snoozed_until: t(r.snoozedUntil),
    dismissed_at: t(r.dismissedAt),
    dismiss_reason: r.dismissReason,
    handled_at: t(r.handledAt),
    handled_by: r.handledBy,
    handled_via: r.handledVia,
    auto_state: r.autoState,
    auto_scheduled_for: t(r.autoScheduledFor),
    auto_done_at: t(r.autoDoneAt),
    auto_skip_reason: r.autoSkipReason,
  };
}

describe('from a phone’s copy', () => {
  it('gives the same list as the server’s rows', () => {
    const today = attentionToday(at, TZ);
    const build = (rows: readonly AttentionRow[]) => {
      const inList = rows.filter((r) => inAttentionList(r, today) && r.kind !== 'ai_approval');
      return attentionListOut(attentionListView(inList, { me: DALE, role: 'owner', now: at }), {
        viewer: viewer(),
        names: new Map([[DALE, 'Dale Carter']]),
        hints: new Map(),
        now: at,
        includeHandled: true,
      });
    };
    const fromCopy = ROWS.map(synced).map(attentionRowOfSynced);
    expect(build(fromCopy)).toEqual(build(ROWS));
  });

  it('reads the viewer from the waiting approvals it holds', () => {
    const v = attentionViewerOfSynced(DALE, { role: 'member' }, [
      {
        id: uid(41),
        source: 'workflow',
        approvers: JSON.stringify([DALE]),
        kind: null,
        status: 'pending',
      },
      { id: uid(42), source: 'workflow', approvers: '[]', kind: null, status: 'pending' },
      { id: uid(43), source: 'teammate', approvers: null, kind: 'reply', status: 'pending' },
      { id: uid(44), source: 'teammate', approvers: null, kind: 'reply', status: 'approved' },
    ]);
    expect([...v.decidable]).toEqual([uid(41), uid(43)]);
  });

  it('names people as the server does: the full name, else the email', () => {
    const names = namesOfSynced([
      { id: DALE, full_name: 'Dale Carter', email: 'dale@lonestarhvac.test' },
      { id: PRIYA, full_name: '', email: 'priya@lonestarhvac.test' },
    ]);
    expect(names.get(DALE)).toBe('Dale Carter');
    expect(names.get(PRIYA)).toBe('priya@lonestarhvac.test');
  });

  it('reads an add-on’s alert from its card: its add-on, its seriousness and whether it asks for a Got it', () => {
    const card = (asks: boolean) => ({
      kind: 'addon_alert',
      subjectId: uid(71),
      reasons: [
        { code: 'severity', label: 'At risk' },
        ...(asks ? [{ code: 'needs_ack', label: 'Not acknowledged yet' }] : []),
      ],
    });
    // The add-on whose phone permission the person holds: a card reaches a phone only under it.
    expect(addonAlertOfSynced(card(true), ['records.read', 'realestate.use'])).toEqual({
      alertId: uid(71),
      addonId: 'realestate',
      addonName: 'Real Estate Agent',
      severity: 'at_risk',
      href: '/a/realestate',
      needsAck: true,
      acknowledgedAt: null,
    });
    expect(addonAlertOfSynced(card(true), ['records.read'])).toBeNull();
    expect(addonAlertOfSynced(card(true), null)).toBeNull();
    expect(addonAlertOfSynced({ ...card(true), kind: 'hot_lead' }, ['realestate.use'])).toBeNull();
    // HandsFreeOS's own description wins where it says more: the alert's page.
    const server = {
      alertId: uid(71),
      addonId: 'realestate',
      addonName: 'Real Estate Agent',
      severity: 'at_risk' as const,
      href: '/a/realestate/deals/deal-1',
      needsAck: true,
      acknowledgedAt: null,
    };
    expect(addonAlertOfSynced(card(true), [], { server })).toEqual(server);
    // Acknowledged here, or elsewhere (the chip went): it stops asking.
    expect(
      addonAlertOfSynced(card(true), [], { server, acknowledgedHere: true, now: at })
        ?.acknowledgedAt,
    ).toBe(new Date(at).toISOString());
    expect(addonAlertOfSynced(card(false), [], { server, now: at })?.acknowledgedAt).toBe(
      new Date(at).toISOString(),
    );
    // One that never asked doesn't start to.
    expect(addonAlertOfSynced(card(false), ['realestate.use'])).toMatchObject({
      needsAck: false,
      acknowledgedAt: null,
    });
  });
});

describe('hints', () => {
  const SEAT = uid(61);
  const OLIVIA = uid(62);
  const KENDRA = uid(63);
  const TOM = uid(64);
  const items: AttentionRow[] = [
    row({
      id: uid(51),
      kind: 'unconfirmed_appointment',
      subjectType: 'attendee',
      subjectId: SEAT,
      personId: OLIVIA,
    }),
    row({
      id: uid(52),
      kind: 'customer_waiting',
      subjectType: 'conversation',
      personId: KENDRA,
      conversationId: uid(71),
    }),
    row({ id: uid(53), kind: 'invoice_overdue', subjectType: 'invoice', personId: TOM }),
    row({
      id: uid(54),
      kind: 'missing_next_action',
      personId: TOM,
      reasons: [{ code: 'follow_up_overdue', label: 'follow-up overdue' }],
    }),
  ];
  const facts: HintFacts = {
    seats: new Map([
      [
        SEAT,
        {
          id: SEAT,
          appointmentId: uid(81),
          startsAt: '2026-09-16T15:00:00.000Z',
          phone: '+15125550101',
          email: 'olivia@example.com',
          smsOk: true,
          consent: 'unknown',
        },
      ],
    ]),
    people: new Map([
      [KENDRA, { id: KENDRA, phone: '+15125550102', email: null, consent: 'unknown' }],
      [TOM, { id: TOM, phone: '+15125550103', email: 'tom@example.com', consent: 'unknown' }],
    ]),
    conversations: [
      {
        id: uid(71),
        personId: KENDRA,
        channel: 'sms',
        counterpart: '+15125550102',
        lastMessageAt: at,
      },
    ],
    stoppedNumbers: new Set(['+15125550101']),
    stoppedEmails: new Set(),
    business: { textingReady: true, canEmail: true },
    openNow: true,
  };

  it('works out the appointment, the channel and the call', () => {
    const hints = itemHintsOf(items, facts);
    // Olivia's number said STOP: the confirmation goes by email.
    expect(hints.get(uid(51))).toEqual({
      appointmentId: uid(81),
      startsAt: '2026-09-16T15:00:00.000Z',
      reach: 'email',
      callable: false,
      addonAlert: null,
    });
    expect(hints.get(uid(52))).toMatchObject({ reach: 'sms', callable: false });
    // Tom's invoice: a number and the business is open, so the call comes first.
    expect(hints.get(uid(53))).toMatchObject({ reach: 'sms', callable: true });
    // A nudge texts only someone who agreed to texts.
    expect(hints.get(uid(54))).toMatchObject({ reach: 'email' });
  });

  it('reads the same facts from a copy', () => {
    const f = hintFactsOfSynced(
      {
        seats: [
          {
            id: SEAT,
            appointment_id: uid(81),
            starts_at: '2026-09-16T15:00:00Z',
            contact_phone_e164: '+15125550101',
            contact_email: 'olivia@example.com',
            sms_ok: 1,
            sms_consent: null,
          },
        ],
        people: [
          { id: KENDRA, phone_e164: '+15125550102', email: null, sms_consent: 'unknown' },
          { id: TOM, phone_e164: '+15125550103', email: 'tom@example.com', sms_consent: null },
        ],
        conversations: [
          {
            id: uid(71),
            person_id: KENDRA,
            channel: 'sms',
            counterpart: '+15125550102',
            last_message_at: new Date(at).toISOString(),
          },
        ],
        optOuts: [
          { counterpart_e164: '+15125550101', opted_out: 1 },
          { counterpart_e164: '+15125550109', opted_out: 0 },
        ],
        suppressions: [{ address: 'Gone@Example.com' }],
        phoneNumbers: [{ status: 'active' }],
        emailAddresses: [{ email_domain_id: null, verified_at: null }],
        settings: null,
        // Tuesday 10 AM in Chicago, inside the default open hours.
        timezone: TZ,
      },
      at,
    );
    expect(f.stoppedNumbers).toEqual(new Set(['+15125550101']));
    expect(f.stoppedEmails).toEqual(new Set(['gone@example.com']));
    expect(f.business).toEqual({ textingReady: true, canEmail: true });
    expect(f.openNow).toBe(true);
    expect(itemHintsOf(items, f)).toEqual(itemHintsOf(items, facts));
  });

  it('can’t text before the business has an active number, or email without a verified address', () => {
    expect(
      reachBusinessOfSynced({
        phoneNumbers: [{ status: 'provisioning' }],
        emailAddresses: [{ email_domain_id: uid(90), verified_at: null }],
      }),
    ).toEqual({ textingReady: false, canEmail: false });
  });
});
