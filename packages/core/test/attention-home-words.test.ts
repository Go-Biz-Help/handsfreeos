/**
 * Home's words (M10: moved from the web's `attention-words.ts` and its cards, so the web and the phone say the same):
 * chips, snooze choices, groups, handled lines, the header, where an item opens, the main button, Assign, Dismiss and
 * the Let HandsFreeOS Handle sheet.
 */
import { describe, expect, it } from 'vitest';
import {
  assignedToast,
  assignHeadingOf,
  assignNoteOf,
  attentionGroupTitle,
  attentionHeaderWords,
  attentionSnoozeChoices,
  attentionTargetOf,
  cardChipsOf,
  dismissAboutOf,
  dismissNoteOf,
  dismissReasonsOf,
  dismissSaid,
  foldAttentionRows,
  goesStripWords,
  groupDaysSpan,
  groupValueCents,
  handleButtonOf,
  handledLineOf,
  handledSummary,
  joinAnd,
  letHandleOffReason,
  letHandleSubOf,
  letHandleTitleOf,
  snoozedUntilWords,
  snoozePickError,
  type AttentionKind,
} from '../src/attention/index';
import type { AttentionItemOut } from '../src/schemas/attention';
import { at, DALE, HOUR, MIN, NOW, TZ, uid } from './attention-fixtures';

const now = NOW.getTime();

function item(over: Partial<AttentionItemOut> = {}): AttentionItemOut {
  return {
    id: uid(1),
    kind: 'hot_lead',
    state: 'open',
    subject: { type: 'lead', id: uid(11) },
    personId: uid(21),
    leadId: uid(11),
    conversationId: null,
    appointmentId: null,
    startsAt: null,
    reach: null,
    callable: false,
    addonAlert: null,
    title: 'Maria Lopez · New AC install',
    detail: null,
    valueCents: 1_850_000,
    valueIsEstimate: false,
    reasons: [],
    urgent: false,
    score: 100,
    urgency: 1,
    since: null,
    urgentFrom: null,
    dueAt: null,
    openedAt: new Date(now - HOUR).toISOString(),
    assignee: null,
    snoozedUntil: null,
    dismissedAt: null,
    dismissReason: null,
    handled: null,
    auto: { action: null, state: null, scheduledFor: null, doneAt: null, skipReason: null },
    letHandleMode: 'ask',
    handleLabel: 'Call',
    actions: { handle: true, letHandle: true, assign: true, snooze: true, dismiss: true },
    ...over,
  };
}

describe('chips', () => {
  it('counts the wait up, adds a typical value, and says when HandsFreeOS acts', () => {
    const since = new Date(now - 11 * MIN).toISOString();
    const chips = cardChipsOf(
      item({
        valueIsEstimate: true,
        valueCents: 420_000,
        urgent: true,
        reasons: [{ code: 'waiting', label: 'waiting 1 min', text: 'waiting 1 min', since }],
      }),
      now,
      TZ,
    );
    expect(chips.map((c) => [c.text, c.tone])).toEqual([
      ['About $4,200', 'est'],
      ['Waiting 11 min', 'late'],
    ]);
    const auto = cardChipsOf(
      item({
        reasons: [
          { code: 'value', label: '$18,500', text: '$18,500' },
          { code: 'qualified', label: 'qualified', text: 'qualified' },
          { code: 'repeat_customer', label: 'repeat customer', text: 'repeat customer' },
        ],
        auto: {
          action: 'nudge',
          state: 'scheduled',
          scheduledFor: at('2026-09-15', '10:40').toISOString(),
          doneAt: null,
          skipReason: null,
        },
      }),
      now,
      TZ,
    );
    expect(auto.map((c) => c.text)).toEqual(['$18,500', 'Qualified', 'Follows up at 10:40 AM']);
  });
});

describe('snooze', () => {
  it('offers an hour, this evening, tomorrow morning and next week in the business’s zone', () => {
    expect(attentionSnoozeChoices(TZ, now).map((c) => [c.label, c.hint])).toEqual([
      ['1 hour', '11:00 AM'],
      ['This evening', '6:00 PM'],
      ['Tomorrow morning', 'Wed 8:00 AM'],
      ['Next week', 'Tue, Sep 22'],
    ]);
    expect(
      attentionSnoozeChoices(TZ, at('2026-09-15', '17:30').getTime()).map((c) => c.key),
    ).toEqual(['hour', 'tomorrow', 'next_week']);
  });
  it('says until when, and refuses a time that won’t do', () => {
    expect(snoozedUntilWords(now + HOUR, TZ, now)).toBe('11:00 AM');
    expect(snoozedUntilWords(at('2026-09-16', '08:00').getTime(), TZ, now)).toBe(
      'tomorrow at 8:00 AM',
    );
    expect(snoozePickError(null, now)).toBe('Pick a day and a time.');
    expect(snoozePickError(now - MIN, now)).toBe('Pick a time later than now.');
    expect(snoozePickError(now + 31 * 24 * HOUR, now)).toBe('Snooze for 30 days at most.');
    expect(snoozePickError(now + HOUR, now)).toBeNull();
  });
});

describe('groups', () => {
  it('folds three or more of a kind from rank 5 down, where the first of them stood', () => {
    const kinds: AttentionKind[] = [
      'hot_lead',
      'customer_waiting',
      'unconfirmed_appointment',
      'unconfirmed_appointment',
      'unanswered_lead',
      'unconfirmed_appointment',
      'unconfirmed_appointment',
      'unconfirmed_appointment',
    ];
    const rows = foldAttentionRows(
      kinds.map((kind, i) => item({ id: uid(i + 1), kind })),
      1,
    );
    expect(rows.map((r) => (r.type === 'item' ? r.item.kind : `group:${r.items.length}`))).toEqual([
      'hot_lead',
      'customer_waiting',
      'unconfirmed_appointment',
      'unconfirmed_appointment',
      'unanswered_lead',
      'group:3',
    ]);
  });
  it('titles, values and days', () => {
    expect(attentionGroupTitle('unconfirmed_appointment', 4)).toEqual({
      title: 'Unconfirmed appointments',
      count: '4 customers',
    });
    expect(
      groupValueCents([
        item({ id: uid(1), leadId: uid(9), valueCents: 500_000 }),
        item({ id: uid(2), leadId: uid(9), valueCents: 900_000 }),
        item({ id: uid(3), leadId: null, valueCents: 100_000, valueIsEstimate: true }),
      ]),
    ).toBe(900_000);
    expect(
      groupDaysSpan(
        [
          { dueAt: at('2026-09-15', '14:00').toISOString() },
          { dueAt: at('2026-09-16', '09:00').toISOString() },
        ],
        TZ,
        now,
      ),
    ).toBe('Today and tomorrow');
    expect(joinAnd(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('A, B, C, D and 2 more');
  });
});

describe('handled', () => {
  it('says what HandsFreeOS did, and who asked', () => {
    const confirmed = item({
      kind: 'unconfirmed_appointment',
      title: 'Olivia Grant · AC tune-up',
      detail: 'Thu 9:00 AM',
      handled: {
        at: new Date(now).toISOString(),
        via: 'let_handle',
        by: { id: DALE, fullName: 'Dale Carter' },
      },
      auto: {
        action: 'confirm_request',
        state: 'sent',
        scheduledFor: null,
        doneAt: null,
        skipReason: null,
      },
    });
    expect(handledLineOf(confirmed, DALE)).toEqual({
      text: ['Asked ', { strong: 'Olivia Grant' }, ' to confirm the AC tune-up'],
      sub: 'Thu 9:00 AM · You asked HandsFreeOS',
    });
    expect(
      handledLineOf(
        item({ handled: { at: '', via: 'person', by: { id: uid(5), fullName: 'Priya Shah' } } }),
        DALE,
      ),
    ).toEqual({ text: ['Priya took care of ', { strong: 'Maria Lopez' }], sub: 'New AC install' });
    expect(handledSummary([confirmed, confirmed, item()])).toBe(
      'Asked 2 customers to confirm and handled 1 more',
    );
  });
});

describe('the header', () => {
  it('leads with dollars, or the count, or nothing', () => {
    expect(
      attentionHeaderWords({ total: 10, urgent: 2, handledToday: 3, affectedCents: 4_985_200 }),
    ).toMatchObject({
      headline: { figure: '$49,852', words: 'affected' },
      need: { count: '10', words: 'need attention' },
      urgent: '2 urgent',
      handled: '3 handled today',
    });
    expect(
      attentionHeaderWords({ total: 1, urgent: 0, handledToday: 0, affectedCents: 0 }),
    ).toMatchObject({
      headline: { figure: '1', words: 'needs attention' },
      need: null,
      urgent: null,
      title: null,
    });
    expect(
      attentionHeaderWords({ total: 0, urgent: 0, handledToday: 5, affectedCents: 0 }).headline,
    ).toEqual({ figure: 'Nothing needs you right now', words: null });
  });
});

describe('where it opens, and its main button', () => {
  const ws = uid(1000);
  it('opens the record behind it', () => {
    expect(attentionTargetOf(item(), ws)).toEqual({
      href: `/app/w/${ws}/leads/${uid(11)}`,
      label: 'Open the lead',
    });
    expect(
      attentionTargetOf(
        item({
          kind: 'ai_approval',
          reasons: [{ code: 'draft', label: 'AI reply draft', text: '' }],
        }),
        ws,
      ).href,
    ).toBe(`/app/w/${ws}/workflows/approvals?filter=ai`);
    expect(
      attentionTargetOf(item({ kind: 'unconfirmed_appointment', appointmentId: uid(7) }), ws).href,
    ).toBe(`/app/w/${ws}/calendar?appt=${uid(7)}`);
  });
  it('fits the item and the channel', () => {
    expect(handleButtonOf(item(), true)).toEqual({ label: 'Call Maria', icon: 'phone' });
    expect(handleButtonOf(item(), false)).toEqual({ label: 'Reply', icon: 'send' });
    expect(
      handleButtonOf(item({ kind: 'unconfirmed_appointment', reach: 'sms' }), true).label,
    ).toBe('Confirm by text');
    expect(
      handleButtonOf(
        item({ kind: 'invoice_overdue', title: 'Tom Reyes · INV-1036', reach: 'sms' }),
        true,
      ),
    ).toEqual({ label: 'Text Tom', icon: 'message' });
    expect(letHandleOffReason(item({ kind: 'ai_approval' }))).toBe(
      'Approvals always need a person',
    );
    expect(letHandleOffReason(item())).toBeNull();
  });
  it('says when HandsFreeOS goes', () => {
    const scheduled = item({
      kind: 'unconfirmed_appointment',
      title: 'Olivia Grant · AC tune-up',
      auto: {
        action: 'confirm_request',
        state: 'scheduled',
        scheduledFor: null,
        doneAt: null,
        skipReason: null,
      },
    });
    expect(goesStripWords(scheduled, at('2026-09-15', '10:40').getTime(), TZ)).toEqual({
      strong: 'HandsFreeOS will ask Olivia to confirm at 10:40 AM.',
      rest: null,
    });
  });
});

describe('Assign and Dismiss', () => {
  it('says what assigning changes', () => {
    expect(assignNoteOf(item())).toBe('This makes them the lead’s owner too.');
    expect(assignHeadingOf(item())).toBe('Assign Maria Lopez to');
    expect(assignHeadingOf(item({ kind: 'ai_approval' }))).toBe('Assign this item to');
    expect(assignedToast('lead', false, 'Priya')).toBe(
      'Assigned to Priya. Priya is now the lead’s owner.',
    );
    expect(assignedToast(null, false, null)).toBe('Unassigned.');
  });
  it('asks why, optionally', () => {
    expect(dismissReasonsOf(item())).toContain('Not a real lead');
    expect(dismissAboutOf(item())).toBe('Maria Lopez · New AC install · $18,500');
    expect(dismissNoteOf(item())).toBe(
      'It stays off the list until something changes, like a new message from Maria. The lead itself doesn’t change.',
    );
    expect(dismissSaid('Not needed', ' they called ')).toBe('Not needed: they called');
    expect(dismissSaid(null, '  ')).toBeNull();
  });
});

describe('Let HandsFreeOS Handle', () => {
  it('titles the sheet by what it will do', () => {
    const base = { item: item(), confirm: false, teammateName: 'Ava' };
    expect(letHandleTitleOf({ ...base, mode: 'ask', choice: 'hand_to_ai' })).toBe(
      'Hand Maria Lopez to Ava?',
    );
    expect(letHandleTitleOf({ ...base, mode: 'ask', choice: 'reply' })).toBe(
      'Reply to Maria Lopez',
    );
    expect(letHandleTitleOf({ ...base, mode: 'none', choice: null })).toBe('Hot lead: Maria Lopez');
    expect(
      letHandleSubOf(
        item({
          reasons: [
            { code: 'value', label: '$18,500', text: '$18,500' },
            { code: 'qualified', label: 'qualified', text: 'qualified' },
          ],
        }),
        now,
        TZ,
      ),
    ).toBe('New AC install · $18,500 · qualified');
  });
});
