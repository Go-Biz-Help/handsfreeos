import { ChangeError, NEEDS_SIGNAL } from '../controller';
import { onRefused, type Refused } from '../fixers';
import { editedOnly, tagChanges } from '../edits';

import { LONE_STAR, MARIA, noSignal, phone, refusal } from './harness';

/**
 * The one way screens make a change: queued changes are kept on the phone with their optimistic rows; online-only
 * commands never queue and need signal; new records carry the phone's own ids; edits send only what changed, with what
 * the person saw; tags go one at a time.
 */

describe('change()', () => {
  it('never queues an online-only command: with no signal the screen hears "This needs signal."', async () => {
    const p = phone({ online: false });
    await expect(
      p.changes.change('call.connect_me', { workspaceId: LONE_STAR, personId: MARIA }),
    ).rejects.toEqual(new ChangeError('needs-signal', NEEDS_SIGNAL));
    expect(p.db.queue()).toEqual([]);
    expect(p.db.rows('SELECT * FROM outbox')).toEqual([]);
    expect(p.api.sent()).toEqual([]);
  });

  it('sends an online-only command straight to the API, made now, and gives its answer', async () => {
    const p = phone();
    const result = await p.changes.change('call.connect_me', {
      workspaceId: LONE_STAR,
      personId: MARIA,
    });
    expect(result).toEqual({ id: expect.any(String), queued: false, output: { ok: true, n: 1 } });
    expect(p.api.sent()).toEqual([
      expect.objectContaining({
        name: 'call.connect_me',
        commandId: result.id,
        madeAt: new Date(p.clock.now).toISOString(),
        confirmedAt: null,
      }),
    ]);
    expect(p.db.queue()).toEqual([]);
    expect(p.db.rows('SELECT * FROM outbox')).toEqual([]);
  });

  it('gives an online-only command’s refusal to the screen, and "This needs signal." when there’s no answer', async () => {
    const p = phone();
    p.api.script(() =>
      refusal(409, 'final', 'Verify your cell phone first.', { rule: 'no_verified_cell' }),
    );
    await expect(
      p.changes.change('call.connect_me', { workspaceId: LONE_STAR, personId: MARIA }),
    ).rejects.toMatchObject({ kind: 'refused', message: 'Verify your cell phone first.' });
    p.api.script(() => noSignal);
    await expect(
      p.changes.change('call.connect_me', { workspaceId: LONE_STAR, personId: MARIA }),
    ).rejects.toMatchObject({ kind: 'needs-signal', message: NEEDS_SIGNAL });
  });

  it('keeps an online-only command from going before the changes it needs have', async () => {
    const p = phone({ online: false });
    const person = await p.changes.change('person.create', {
      workspaceId: LONE_STAR,
      firstName: 'Rosa',
    });
    p.setOnline(true);
    await expect(
      p.changes.change(
        'call.connect_me',
        { workspaceId: LONE_STAR, personId: MARIA },
        { dependsOn: [person.id] },
      ),
    ).rejects.toMatchObject({ kind: 'waiting' });
  });

  it('queues a new customer under the phone’s own id, and a lead for them that waits', async () => {
    const p = phone({ online: false });
    const personId = '12345678-1234-4234-8234-123456789012';
    const person = await p.changes.change(
      'person.create',
      { workspaceId: LONE_STAR, id: personId, firstName: 'Rosa', lastName: 'Delgado' },
      {
        optimistic: (tx) =>
          tx.execute(
            `INSERT INTO people (id, workspace_id, first_name, last_name) VALUES (?, ?, 'Rosa', 'Delgado')`,
            [personId, LONE_STAR],
          ),
      },
    );
    const lead = await p.changes.change(
      'lead.create',
      { workspaceId: LONE_STAR, personId, title: 'AC tune-up' },
      { dependsOn: [person.id] },
    );
    expect(person).toEqual({ id: expect.any(String), queued: true });
    expect(p.db.rows('SELECT first_name FROM people WHERE id = ?', [personId])).toEqual([
      { first_name: 'Rosa' },
    ]);
    expect(p.row(lead.id)).toMatchObject({
      depends_on: JSON.stringify([person.id]),
      workspace_id: LONE_STAR,
    });
    await p.settle();
    expect(p.changes.getSnapshot()).toMatchObject({ waiting: 2 });
    p.setOnline(true);
    await p.sync();
    expect(JSON.parse(p.api.sent('person.create')[0]!.input)).toMatchObject({ id: personId });
    expect(p.api.ran()).toEqual(['person.create', 'lead.create']);
  });

  it('rolls the whole change back when its optimistic rows fail', async () => {
    const p = phone();
    await expect(
      p.changes.change(
        'activity.log',
        { workspaceId: LONE_STAR, personId: MARIA, kind: 'note', body: 'x' },
        { optimistic: (tx) => tx.execute('INSERT INTO no_such_table (id) VALUES (1)') },
      ),
    ).rejects.toThrow();
    expect(p.db.rows('SELECT * FROM outbox')).toEqual([]);
    expect(p.db.queue()).toEqual([]);
  });

  it('refuses a change without its business, and a name the contract doesn’t have', async () => {
    const p = phone();
    await expect(
      p.changes.change('activity.log', { personId: MARIA, kind: 'note', body: 'x' } as never),
    ).rejects.toMatchObject({ kind: 'failed' });
    await expect(p.changes.change('payment.refund' as never, {} as never)).rejects.toMatchObject({
      kind: 'failed',
    });
  });
});

describe('a command’s own refusal hook', () => {
  it('hears a queued change refused, with its row, and an online-only one, with the API’s answer', async () => {
    const heard: Refused[] = [];
    const off = [
      onRefused('estimate.update', (r) => void heard.push(r)),
      onRefused('activity.log', (r) => void heard.push(r)),
    ];
    try {
      const p = phone();
      // A stale draft save (online-only): the API refuses it and hands back a ready new draft.
      p.api.script(() =>
        refusal(409, 'final', 'Someone changed this estimate since you opened it.', {
          rule: 'document_conflict',
          details: {
            keepAsNewDraft: { command: 'estimate.create', input: { workspaceId: LONE_STAR } },
          },
        }),
      );
      await expect(
        p.changes.change('estimate.update', {
          workspaceId: LONE_STAR,
          estimateId: MARIA,
          baseRevision: 1,
        } as never),
      ).rejects.toMatchObject({ kind: 'refused' });
      expect(heard[0]).toMatchObject({
        name: 'estimate.update',
        workspaceId: LONE_STAR,
        row: null,
        answer: { error: { details: { keepAsNewDraft: { command: 'estimate.create' } } } },
      });

      p.api.script((r) =>
        r.name === 'activity.log' ? refusal(404, 'final', 'Customer not found.') : undefined,
      );
      const note = await p.changes.change('activity.log', {
        workspaceId: LONE_STAR,
        personId: MARIA,
        kind: 'note',
        body: 'x',
      });
      await p.sync();
      expect(heard[1]).toMatchObject({
        id: note.id,
        name: 'activity.log',
        row: { state: 'refused' },
      });
    } finally {
      off.forEach((remove) => remove());
    }
  });
});

describe('edits and tags', () => {
  it('send only the details that changed, with what the person saw', async () => {
    const opened = { phone: '(713) 555-0174', email: null as string | null, city: 'Houston' };
    const saved = { phone: '(713) 555-0199', email: 'maria.lopez@example.com', city: 'Houston' };
    const edit = editedOnly(opened, saved, { phone: '+17135550174', email: null });
    expect(edit).toEqual({
      changes: { phone: '(713) 555-0199', email: 'maria.lopez@example.com' },
      base: { phone: '+17135550174', email: null },
      any: true,
    });
    expect(editedOnly(opened, opened).any).toBe(false);

    const p = phone();
    const { id } = await p.changes.change('person.update', {
      workspaceId: LONE_STAR,
      personId: MARIA,
      ...edit.changes,
      base: edit.base,
    });
    await p.sync();
    expect(JSON.parse(p.api.sent()[0]!.input)).toEqual({
      workspaceId: LONE_STAR,
      personId: MARIA,
      phone: '(713) 555-0199',
      email: 'maria.lopez@example.com',
      base: { phone: '+17135550174', email: null },
    });
    expect(p.row(id).state).toBe('sent');
  });

  it('put tags on and take them off one at a time', () => {
    const ref = { workspaceId: LONE_STAR, recordType: 'person' as const, recordId: MARIA };
    expect(tagChanges(ref, ['vip', 'old'], ['vip', 'new'])).toEqual([
      { name: 'record.add_tag', input: { ...ref, tagId: 'new' } },
      { name: 'record.remove_tag', input: { ...ref, tagId: 'old' } },
    ]);
  });
});
