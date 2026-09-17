import { fieldProblems, loadNames } from '../describe';
import { listChanges, megabytes } from '../list';
import type { OutboxRow } from '../outbox';

import { LONE_STAR, MARIA, phone } from './harness';

/**
 * Changes on this phone as the canvas lists them: Needs you (Still send?, a refusal to fix), Waiting (held behind
 * Rosa, a photo uploading on its own), and Sent just now, grouped by customer.
 */

describe('Changes on this phone', () => {
  it('lists what needs the person, what waits, and what went, in the canvas’s words', async () => {
    const p = phone();
    const rosaId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    // Sent: Maria's number and email, a note, and her lead moved to Won.
    p.db.sqlite.exec(
      `INSERT INTO pipeline_stages (id, workspace_id, name) VALUES ('won', '${LONE_STAR}', 'Won')`,
    );
    p.db.sqlite.exec(
      `INSERT INTO leads (id, workspace_id, person_id, title) VALUES ('lead-1', '${LONE_STAR}', '${MARIA}', 'New AC install')`,
    );
    await p.changes.change('person.update', {
      workspaceId: LONE_STAR,
      personId: MARIA,
      phone: '(713) 555-0147',
      email: 'maria.lopez@example.com',
      base: { phone: '+17135550190', email: null },
    });
    await p.changes.change('activity.log', {
      workspaceId: LONE_STAR,
      personId: MARIA,
      kind: 'note',
      body: 'Old unit is a 2009 Trane.',
    });
    await p.changes.change('lead.move_stage', {
      workspaceId: LONE_STAR,
      leadId: 'lead-1',
      stageId: 'won',
    });
    await p.sync();
    // Needs you: a text written 45 minutes ago, and Rosa refused.
    const text = await p.changes.change('message.send', {
      workspaceId: LONE_STAR,
      personId: MARIA,
      body: 'Thanks again, Maria. We’ll be back Monday at 8:00 AM to put in the new system.',
    });
    p.api.script((r) =>
      r.name === 'person.create'
        ? {
            reached: true,
            status: 400,
            body: {
              error: {
                code: 'validation',
                message: 'Some fields need attention.',
                details: [{ path: 'email', message: 'Enter a valid email address.' }],
                disposition: 'final',
              },
            },
          }
        : undefined,
    );
    p.clock.now += 45 * 60_000;
    const rosa = await p.changes.change('person.create', {
      workspaceId: LONE_STAR,
      id: rosaId,
      firstName: 'Rosa',
      lastName: 'Delgado',
      email: 'rosa.delgado@gmail',
    });
    const lead = await p.changes.change(
      'lead.create',
      { workspaceId: LONE_STAR, personId: rosaId, title: 'AC tune-up' },
      { dependsOn: [rosa.id] },
    );
    await p.sync();

    const rows = p.db.rows<OutboxRow>('SELECT * FROM outbox');
    const list = listChanges({
      rows,
      photos: [],
      names: await loadNames(p.db, rows),
      now: p.clock.now,
    });
    expect(list.needsYou.map((i) => [i.words.title, i.row.state, i.ask, i.row.reason])).toEqual([
      [
        'Text to Maria Lopez',
        'ask',
        'still-send',
        'This was done 45 minutes ago, so it waits for your OK before it goes.',
      ],
      ['New customer · Rosa Delgado', 'refused', null, 'Email: Enter a valid email address.'],
    ]);
    expect(list.needsYou[0]!.words.quote).toBe(
      'Thanks again, Maria. We’ll be back Monday at 8:00 AM to put in the new system.',
    );
    expect(list.waiting.map((i) => [i.words.title, i.row.state, i.held])).toEqual([
      ['AC tune-up lead for Rosa', 'held', 'Held until Rosa Delgado is saved, then it goes.'],
    ]);
    expect(list.sent).toEqual([
      {
        key: `person:${MARIA}`,
        title: '3 changes for Maria Lopez',
        line: 'Number and email · a note · moved to Won',
        count: 3,
        lastSentAt: expect.any(Number),
      },
    ]);
    expect(list.unsent).toBe(3);
    expect(lead.id).toBeTruthy();
    expect(text.id).toBeTruthy();
  });

  it('reads the fields a refusal names, from the body the outbox keeps', () => {
    const kept = JSON.stringify({
      error: {
        code: 'validation',
        message: 'Some fields need attention.',
        details: [{ path: 'email', message: 'Enter a valid email address.' }],
      },
    });
    expect(fieldProblems(kept)).toEqual([
      { path: 'email', label: 'Email', message: 'Enter a valid email address.' },
    ]);
    expect(fieldProblems('not json')).toEqual([]);
  });

  it('says how much of a photo has gone', () => {
    expect(megabytes(1_600_000, 2_400_000)).toBe('1.6 of 2.4 MB');
    expect(megabytes(0, 850_000)).toBe('0.0 of 0.9 MB');
  });
});
