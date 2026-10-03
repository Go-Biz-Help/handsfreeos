import { PHONE_COMMANDS } from '../commands';
import { bookOf, describe as describeChange, loadNames } from '../describe';
import { describeRealestate, NO_REALESTATE_NAMES } from '../describe-realestate';
import { listChanges } from '../list';
import type { OutboxRow } from '../outbox';
import { outcomeOf } from '../rules';

import { LONE_STAR, MARIA, phone } from './harness';

/**
 * Real Estate's changes on Changes on this phone (round six, board 79's last panel): "Marked done: insurance binder ·
 * Smith purchase", "Note on “Attend inspection”", each named from the phone's copy and grouped under its deal; replies
 * in a client's portal or the website chat said as replies (board 92); and a client update sent right behind its edit
 * waiting for its fair-housing check instead of failing (board 81).
 */

const SMITH = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const NGUYEN = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Real Estate’s changes', () => {
  it('each say what they did: none of the phone’s Real Estate commands is just “a change”', () => {
    const names = Object.keys(PHONE_COMMANDS).filter((n) => n.startsWith('realestate.'));
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) {
      const words = describeRealestate(name, { workspaceId: LONE_STAR }, NO_REALESTATE_NAMES)!;
      expect({ name, title: words.title }).not.toEqual({
        name,
        title: expect.stringMatching(/^A change/),
      });
      expect(words.part).not.toBe('a change');
    }
  });

  it('name what they point at from the phone’s copy, and group under the deal (board 79)', async () => {
    const p = phone();
    const db = p.db.sqlite;
    db.exec(`INSERT INTO custom_records (id, workspace_id, name) VALUES
      ('${SMITH}', '${LONE_STAR}', 'Smith purchase'), ('${NGUYEN}', '${LONE_STAR}', 'Nguyen purchase')`);
    const row = (source: string, key: string, dealId: string, data: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO addon_phone_rows (id, workspace_id, addon_id, source, record_id, data)
           VALUES (?, ?, 'realestate', ?, ?, ?)`,
        )
        .run(`${source}:${key}`, LONE_STAR, source, dealId, JSON.stringify(data));
    row('duties', id(1), SMITH, { title: 'Get the insurance binder to the lender' });
    row('duties', id(2), NGUYEN, { title: 'Attend inspection' });
    row('homes', id(3), NGUYEN, { address: '418 Maple Ave' });
    row('tour_stops', id(4), NGUYEN, { home_id: id(3), position: 1 });
    row('inspection_findings', id(5), NGUYEN, { title: 'Water heater past its life' });
    await p.changes.change('realestate.duty.complete', { workspaceId: LONE_STAR, dutyId: id(1) });
    await p.changes.change('realestate.duty.add_evidence', {
      workspaceId: LONE_STAR,
      dutyId: id(2),
      id: id(10),
      kind: 'note',
      body: 'Inspector there at 9.',
    });
    await p.changes.change('realestate.tour.record_visit', {
      workspaceId: LONE_STAR,
      stopId: id(4),
      status: 'visited',
    });
    await p.changes.change('realestate.finding.update', {
      workspaceId: LONE_STAR,
      findingId: id(5),
      photoFileIds: [id(11)],
    });
    await p.changes.change('realestate.open_house.sign_in', {
      workspaceId: LONE_STAR,
      openHouseId: id(6),
      id: id(12),
      firstName: 'Sam',
      lastName: 'Cole',
      phone: '+15125550163',
    });

    const rows = p.db.rows<OutboxRow>('SELECT * FROM outbox ORDER BY seq');
    const names = await loadNames(p.db, rows);
    expect(
      rows.map((r) => {
        const w = describeChange(r, names);
        return [w.title, w.about?.name ?? null];
      }),
    ).toEqual([
      ['Marked done: get the insurance binder to the lender', 'Smith purchase'],
      ['Note on “Attend inspection”', 'Nguyen purchase'],
      ['Seen: 418 Maple Ave', 'Nguyen purchase'],
      ['Finding changed: Water heater past its life', 'Nguyen purchase'],
      // An open house this phone doesn't keep: the visitor still has a name.
      ['Sam Cole signed in', null],
    ]);
    expect(describeChange(rows[1]!, names).quote).toBe('Inspector there at 9.');

    // Sent: Nguyen purchase's three changes are one line under the deal.
    for (const r of rows)
      db.prepare(`UPDATE outbox SET state = 'sent', sent_at = ? WHERE id = ?`).run(
        new Date(p.clock.now).toISOString(),
        r.id,
      );
    const sent = listChanges({
      rows: p.db.rows<OutboxRow>('SELECT * FROM outbox'),
      photos: [],
      names,
      now: p.clock.now,
    }).sent;
    expect(sent.map((g) => [g.title, g.line])).toEqual(
      expect.arrayContaining([
        ['Marked done: get the insurance binder to the lender', 'Marked done'],
        ['3 changes for Nguyen purchase', 'A note · seen · a finding changed'],
      ]),
    );
  });

  it('say what a finding, a walkthrough item or a showing was', () => {
    const names = {
      deal: (dealId: string | null) => (dealId === SMITH ? 'Smith purchase' : null),
      row: (source: string, rowId: string | null) =>
        source === 'walkthrough_items' && rowId === id(7)
          ? { dealId: SMITH, data: { title: 'Dishwasher stays' } }
          : source === 'showings' && rowId === id(8)
            ? { dealId: SMITH, data: { agent_name: 'Lee Wong' } }
            : source === 'contingencies' && rowId === id(9)
              ? { dealId: SMITH, data: { kind: 'other', label: 'Sale of the condo' } }
              : null,
    };
    const say = (name: string, input: Record<string, unknown>) =>
      describeRealestate(name, input, names)!.title;
    expect(say('realestate.finding.add', { title: 'Roof flashing loose' })).toBe(
      'Finding: Roof flashing loose',
    );
    expect(say('realestate.walkthrough.check_item', { itemId: id(7), state: 'not_ok' })).toBe(
      'Not OK: Dishwasher stays',
    );
    expect(say('realestate.showing.decide', { showingId: id(8), decision: 'confirm' })).toBe(
      'Showing confirmed: Lee Wong',
    );
    expect(say('realestate.contingency.resolve', { contingencyId: id(9), how: 'waived' })).toBe(
      'Sale of the condo contingency waived',
    );
    expect(say('realestate.financing.mark_done', { dealId: SMITH, step: 'appraisal' })).toBe(
      'Appraisal done',
    );
    expect(say('realestate.listing.price.propose', { dealId: SMITH, priceCents: 47_900_000 })).toBe(
      'New price for the seller: $479,000',
    );
    // A client update reaches the client, so it isn't said as an email "to" its deal.
    expect(
      describeRealestate('realestate.status_email.send', { dealId: SMITH }, names),
    ).toMatchObject({
      title: 'Client update for Smith purchase',
      icon: 'inbox',
      deal: { id: SMITH, name: 'Smith purchase' },
    });
  });

  it('waits for a client update’s fair-housing check instead of failing (board 81)', () => {
    const answer = outcomeOf({
      reached: true,
      status: 503,
      body: {
        error: {
          code: 'rule_violation',
          rule: 'realestate_check_running',
          message:
            'The fair-housing check on this update is still running. It goes once the check is done.',
          disposition: 'retry',
        },
      },
    });
    expect(answer.kind).toBe('retry');
  });
});

describe('a reply in a portal or the website chat', () => {
  const names = bookOf({
    people: new Map([[MARIA, { name: 'Ann Webb', first: 'Ann' }]]),
    conversations: [{ id: id(20), person_id: MARIA }],
  });
  const reply = (channel: string) =>
    describeChange(
      {
        name: 'message.send',
        track: 'queue',
        input: JSON.stringify({
          workspaceId: LONE_STAR,
          conversationId: id(20),
          channel,
          body: 'See you Saturday.',
        }),
      },
      names,
    );

  it('is said as a reply where they wrote, not a text (board 92)', () => {
    expect(reply('portal')).toMatchObject({
      title: 'Reply in Ann Webb’s portal',
      part: 'a portal reply',
      quote: 'See you Saturday.',
      icon: 'inbox',
      about: { name: 'Ann Webb' },
    });
    expect(reply('chat')).toMatchObject({
      title: 'Reply to Ann Webb in the chat',
      part: 'a chat reply',
      icon: 'inbox',
    });
    expect(reply('sms').title).toBe('Text to Ann Webb');
  });
});
