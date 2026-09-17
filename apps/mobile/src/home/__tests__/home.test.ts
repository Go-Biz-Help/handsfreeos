import type { SyncedAttentionRow, SyncedHintRows } from '@hfos/core';

import type { OutboxRow } from '@/changes/outbox';

import {
  buildHome,
  changeStands,
  homeChangesOf,
  overlay,
  SENT_KEEP_MS,
  type HomeInput,
} from '../build';
import { refusedLine, waitingLine } from '../words';

/**
 * Home from the phone's copy: the synced items ranked and counted by core, with this phone's own changes over them (a
 * snooze or a dismissal takes a card off at once and keeps it off while it waits, a refused one brings it back with
 * the API's words, Let HandsFreeOS Handle on its own keeps the card), drafts decided here gone, and approvals only for
 * the people who may decide them.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DALE = '11111111-1111-4111-8111-111111111111';
const PRIYA = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-09-15T15:00:00.000Z'); // 10 AM in Chicago
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function item(n: number, over: Partial<SyncedAttentionRow> = {}): SyncedAttentionRow {
  return {
    id: id(n),
    kind: 'unanswered_lead',
    subject_type: 'lead',
    subject_id: id(100 + n),
    person_id: null,
    lead_id: id(100 + n),
    conversation_id: null,
    state: 'open',
    opened_at: iso(NOW - 60 * MIN),
    since_at: iso(NOW - 20 * MIN),
    urgent_from: null,
    due_at: null,
    value_cents: 0,
    value_is_estimate: 0,
    money_key: null,
    probability: 0.6,
    confidence: 0.8,
    reasons: '[]',
    title: `Customer ${n} · Job`,
    detail: null,
    assignee_user_id: null,
    snoozed_until: null,
    dismissed_at: null,
    dismiss_reason: null,
    handled_at: null,
    handled_by: null,
    handled_via: null,
    auto_state: null,
    auto_scheduled_for: null,
    auto_done_at: null,
    auto_skip_reason: null,
    ...over,
  };
}

let seq = 0;
function outbox(
  name: string,
  input: Record<string, unknown>,
  over: Partial<OutboxRow> = {},
): OutboxRow {
  seq += 1;
  return {
    id: `change-${seq}`,
    command_id: `command-${seq}`,
    name,
    workspace_id: WS,
    input: JSON.stringify({ workspaceId: WS, ...input }),
    made_at: iso(NOW - MIN),
    depends_on: '[]',
    track: 'queue',
    state: 'waiting',
    reason: null,
    disposition: null,
    rule: null,
    answer: null,
    attempts: 0,
    revision: 0,
    confirmed_at: null,
    seq,
    queued_at: iso(NOW - MIN),
    settled_at: iso(NOW - MIN),
    sent_at: null,
    ...over,
  };
}

const NO_HINTS: SyncedHintRows = {
  seats: [],
  people: [],
  conversations: [],
  optOuts: [],
  suppressions: [],
  phoneNumbers: [],
  emailAddresses: [],
  settings: null,
  timezone: 'America/Chicago',
};

function input(over: Partial<HomeInput> = {}): HomeInput {
  return {
    userId: DALE,
    role: 'owner',
    timeZone: 'America/Chicago',
    now: NOW,
    scope: null,
    items: [item(1), item(2), item(3)],
    approvals: [],
    users: [{ id: DALE, full_name: 'Dale Porter', email: 'dale@lonestarhvac.test' }],
    hintRows: NO_HINTS,
    outbox: [],
    decided: new Set(),
    ...over,
  };
}

const ids = (h: ReturnType<typeof buildHome>) => h.list.items.map((i) => i.id);

describe('Home from the copy', () => {
  it('ranks the open items and counts them, as attention.list does', () => {
    const home = buildHome(
      input({
        items: [
          item(1, { value_cents: 50_000 }),
          item(2, {
            kind: 'hot_lead',
            urgent_from: iso(NOW - MIN),
            value_cents: 1_850_000,
            money_key: 'lead:2',
          }),
          item(3, { state: 'snoozed', snoozed_until: iso(NOW + 60 * MIN) }),
          item(4, { state: 'handled', handled_at: iso(NOW - 5 * MIN), handled_via: 'auto' }),
          // Handled yesterday: not today's.
          item(5, { state: 'handled', handled_at: iso(NOW - 26 * 60 * MIN), handled_via: 'auto' }),
        ],
      }),
    );
    expect(ids(home)).toEqual([id(2), id(1)]);
    expect(home.list.items[0]).toMatchObject({ urgent: true });
    expect(home.list.counts).toMatchObject({ total: 2, urgent: 1, snoozed: 1 });
    expect(home.list.handled.map((i) => i.id)).toEqual([id(4)]);
    expect(home.list.handledToday).toBe(1);
    expect(home.list.affectedCents).toBe(1_900_000);
  });

  it('shows Mine to members: theirs and unassigned', () => {
    const home = buildHome(
      input({
        role: 'member',
        items: [item(1, { assignee_user_id: PRIYA }), item(2, { assignee_user_id: DALE }), item(3)],
      }),
    );
    expect(home.list.scope).toBe('mine');
    expect(ids(home).sort()).toEqual([id(2), id(3)]);
    expect(home.list.counts).toMatchObject({ mine: 2, everyone: 3 });
  });

  it('shows an approval only to the people who may decide it, and not once it was decided here', () => {
    const approval = item(9, { kind: 'ai_approval', subject_type: 'approval', subject_id: id(90) });
    const approvals = [
      {
        id: id(90),
        source: 'workflow' as const,
        approvers: JSON.stringify([PRIYA]),
        kind: null,
        status: 'pending',
      },
    ];
    expect(ids(buildHome(input({ role: 'member', items: [approval], approvals })))).toEqual([]);
    expect(ids(buildHome(input({ role: 'owner', items: [approval], approvals })))).toEqual([id(9)]);
    expect(
      ids(
        buildHome(
          input({ role: 'owner', items: [approval], approvals, decided: new Set([id(90)]) }),
        ),
      ),
    ).toEqual([]);
  });
});

describe('this phone’s changes over the copy', () => {
  it('a snooze and a dismissal made here take their cards off at once, and list what waits', () => {
    const home = buildHome(
      input({
        outbox: [
          outbox('attention.snooze', { itemId: id(1), until: iso(NOW + 60 * MIN) }),
          outbox('attention.dismiss', { itemId: id(2), reason: null }, { state: 'retry' }),
        ],
      }),
    );
    expect(ids(home)).toEqual([id(3)]);
    expect(home.list.counts.snoozed).toBe(1);
    expect(home.waiting.map((c) => [c.name, c.itemId])).toEqual([
      ['attention.snooze', id(1)],
      ['attention.dismiss', id(2)],
    ]);
    expect(waitingLine(home.waiting[0]!, home.titles.get(id(1)) ?? null)).toBe(
      'Snooze · Customer 1 · Job',
    );
  });

  it('a refused change brings its card back with the API’s words', () => {
    const home = buildHome(
      input({
        outbox: [
          outbox(
            'attention.snooze',
            { itemId: id(1), until: iso(NOW + 60 * MIN) },
            { state: 'refused', reason: 'That item isn’t there anymore.' },
          ),
        ],
      }),
    );
    expect(ids(home)).toContain(id(1));
    expect(home.waiting).toEqual([]);
    expect(refusedLine(home.refused.get(id(1))!)).toBe(
      'Snooze didn’t go through: That item isn’t there anymore.',
    );
  });

  it('a sent change keeps the card as it made it for a moment, then the server’s row stands', () => {
    const sent = outbox(
      'attention.dismiss',
      { itemId: id(1) },
      { state: 'sent', sent_at: iso(NOW - 5_000) },
    );
    expect(changeStands(sent, NOW)).toBe(true);
    expect(changeStands(sent, NOW + SENT_KEEP_MS)).toBe(false);
    expect(ids(buildHome(input({ outbox: [sent] })))).not.toContain(id(1));
    expect(ids(buildHome(input({ outbox: [sent], now: NOW + SENT_KEEP_MS })))).toContain(id(1));
  });

  it('Undo on HandsFreeOS brings a card back; assigning shows the new owner', () => {
    const home = buildHome(
      input({
        items: [item(1, { state: 'snoozed', snoozed_until: iso(NOW + 60 * MIN) }), item(2)],
        users: [
          { id: DALE, full_name: 'Dale Porter', email: null },
          { id: PRIYA, full_name: 'Priya Shah', email: null },
        ],
        outbox: [
          outbox('attention.restore', { itemId: id(1) }),
          outbox('attention.assign', { itemId: id(2), assigneeUserId: PRIYA }),
        ],
      }),
    );
    expect(ids(home).sort()).toEqual([id(1), id(2)]);
    expect(home.list.items.find((i) => i.id === id(2))?.assignee).toEqual({
      id: PRIYA,
      fullName: 'Priya Shah',
    });
  });

  it('Let HandsFreeOS Handle: a choice takes the card off; on its own, the card stays and says it goes', () => {
    const rows = [item(1), item(2)].map((r) => ({ ...r }));
    const changes = homeChangesOf([
      outbox('attention.let_handle', { itemId: id(1), action: 'hand_to_ai' }),
      outbox('attention.let_handle', { itemId: id(2) }),
    ]);
    const home = buildHome(input({ items: rows, outbox: changes.map((c) => c.row) }));
    expect(ids(home)).toEqual([id(2)]);
    expect([...home.handing]).toEqual([id(2)]);
  });

  it('a change for an item the copy no longer has is kept in the list of what waits', () => {
    const over = overlay(
      [],
      homeChangesOf([outbox('attention.snooze', { itemId: id(7), until: iso(NOW) })]),
      NOW,
    );
    expect(over.rows).toEqual([]);
    expect(over.waiting).toHaveLength(1);
  });
});
