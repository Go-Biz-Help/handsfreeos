import { TOO_OLD_WORDS } from '../version-gate';

import { DALE, LONE_STAR, MARIA, noSignal, phone, refusal, type Phone } from './harness';

/**
 * The uploader's rules on the phone, exactly the Node phone's (`apps/sync/test/harness/phone.ts`), on real SQLite with
 * PowerSync's upload loop played in the test: applied, final, ask, tries in place then set aside, 401, 426, held
 * dependants three deep, the order changes go again in, and a lost answer on a replay.
 */

const note = (p: Phone, body: string, options: { dependsOn?: string[] } = {}) =>
  p.changes.change(
    'activity.log',
    { workspaceId: LONE_STAR, personId: MARIA, kind: 'note', body },
    options,
  );

describe('one change', () => {
  it('is sent with what was saved, and completed once applied', async () => {
    const p = phone();
    const { id } = await note(p, 'Replaced the capacitor');
    expect(p.db.queue()).toEqual([{ table: 'commands', id, op: 'PUT' }]);
    expect(p.row(id)).toMatchObject({ state: 'waiting', command_id: id, attempts: 0 });

    await p.sync();
    expect(p.api.sent()).toEqual([
      {
        name: 'activity.log',
        commandId: id,
        input: JSON.stringify({
          workspaceId: LONE_STAR,
          personId: MARIA,
          kind: 'note',
          body: 'Replaced the capacitor',
        }),
        madeAt: new Date(p.clock.now).toISOString(),
        confirmedAt: null,
      },
    ]);
    expect(p.row(id)).toMatchObject({ state: 'sent', attempts: 1 });
    expect(JSON.parse(p.row(id).answer as string)).toEqual({ ok: true, n: 1 });
    expect(p.db.queue()).toEqual([]);
  });

  it('keeps its optimistic rows in the same local transaction, and completes them with it', async () => {
    const p = phone();
    const { id } = await p.changes.change(
      'activity.log',
      {
        workspaceId: LONE_STAR,
        id: '99999999-9999-4999-8999-999999999999',
        personId: MARIA,
        kind: 'note',
        body: 'Hi',
      },
      {
        optimistic: (tx) =>
          tx.execute(
            `INSERT INTO activities (id, workspace_id, kind, person_id, body) VALUES (?, ?, 'note', ?, 'Hi')`,
            ['99999999-9999-4999-8999-999999999999', LONE_STAR, MARIA],
          ),
      },
    );
    // One transaction: the optimistic row, then the command.
    expect(p.db.queue()).toEqual([
      { table: 'activities', id: '99999999-9999-4999-8999-999999999999', op: 'PUT' },
      { table: 'commands', id, op: 'PUT' },
    ]);
    await p.sync();
    expect(p.db.queue()).toEqual([]);
    expect(p.api.ran()).toEqual(['activity.log']);
  });

  it('a refusal the API calls final is kept with its words, completed, and never tried again', async () => {
    const p = phone();
    p.api.script((r) =>
      r.name === 'activity.log'
        ? refusal(409, 'final', 'This lead is archived. Restore it, then move it.', {
            rule: 'lead_archived',
          })
        : undefined,
    );
    const { id } = await note(p, 'On an archived lead');
    await p.sync();
    expect(p.row(id)).toMatchObject({
      state: 'refused',
      reason: 'This lead is archived. Restore it, then move it.',
      disposition: 'final',
      rule: 'lead_archived',
    });
    expect(p.db.queue()).toEqual([]);
    await p.advance(60 * 60_000);
    p.returnToApp();
    await p.sync();
    expect(p.api.sent()).toHaveLength(1);
  });

  it('a question the API asks is kept for the person, completed, and nothing behind it waits', async () => {
    const p = phone();
    p.api.script((r) =>
      r.name === 'person.create'
        ? refusal(409, 'ask', 'Someone with this phone number is already here.', {
            rule: 'duplicate',
          })
        : undefined,
    );
    const dup = await p.changes.change('person.create', {
      workspaceId: LONE_STAR,
      firstName: 'Maria',
      lastName: 'Lopez',
      phone: '(713) 555-0174',
    });
    const after = await note(p, 'Behind it');
    await p.sync();
    expect(p.row(dup.id)).toMatchObject({ state: 'ask', disposition: 'ask', rule: 'duplicate' });
    expect(p.row(after.id).state).toBe('sent');
    // "Add them anyway": again under its own id, at the back, with the answer.
    await p.changes.doItAnyway(dup.id);
    expect(p.db.queue()).toEqual([{ table: 'commands', id: dup.id, op: 'PUT' }]);
    await p.sync();
    const last = p.api.sent('person.create').at(-1)!;
    expect(last.commandId).toBe(dup.id);
    expect(JSON.parse(last.input)).toMatchObject({ ignoreDuplicates: true });
    expect(last.confirmedAt).toBe(new Date(p.clock.now).toISOString());
    expect(p.row(dup.id).state).toBe('sent');
  });
});

describe('trouble reaching HandsFreeOS', () => {
  it.each([
    ['no signal', noSignal],
    [
      'a server error',
      { reached: true as const, status: 502, body: { error: { message: 'Bad gateway' } } },
    ],
    ['a retry answer', refusal(429, 'retry', 'Too many attempts. Try again in a minute.')],
    [
      'a refusal with no disposition',
      { reached: true as const, status: 409, body: { error: { message: 'Old API' } } },
    ],
  ])(
    'tries in place for a minute, a few seconds apart, then sets it aside so the queue empties (%s)',
    async (_, answer) => {
      const p = phone();
      const stop = p.api.always((r) => (r.name === 'activity.log' ? answer : undefined));
      const { id } = await note(p, 'Order the filter');
      const inPlace = await p.sync();
      // 3 seconds apart: tries at 0, 3, …, 57 s are in place; the one at 60 s sets it aside.
      expect(inPlace).toBe(20);
      expect(p.api.sent()).toHaveLength(21);
      expect(p.row(id)).toMatchObject({ state: 'retry' });
      expect(p.db.queue()).toEqual([]);
      // Everything else still goes meanwhile.
      stop();
      const other = await note(p, 'Unrelated');
      await p.sync();
      expect(p.row(other.id).state).toBe('sent');
      // A little later it goes again on its own, and runs.
      await p.advance(30_000);
      await p.sync();
      expect(p.row(id).state).toBe('sent');
      expect(p.api.ran()).toEqual(['activity.log', 'activity.log']);
    },
  );

  it('sends changes set aside again in the order they were made, behind anything made since', async () => {
    const p = phone();
    const stop = p.api.always(() => noSignal);
    const first = await note(p, 'First');
    const second = await note(p, 'Second');
    await p.sync();
    expect([p.row(first.id).state, p.row(second.id).state]).toEqual(['retry', 'retry']);
    stop();
    const third = await note(p, 'Third, made while they waited');
    await p.sync();
    expect(p.row(third.id).state).toBe('sent');
    p.setOnline(false);
    p.setOnline(true);
    await p.settle();
    await p.sync();
    // The order they ran in on the server.
    const order = [...p.api.receipts.values()].map((r) => JSON.parse(r.input).body as string);
    expect(order).toEqual(['Third, made while they waited', 'First', 'Second']);
  });

  it('runs once when its answer is lost and it goes again under the same id', async () => {
    const p = phone();
    // It reaches the API and runs; the answer never comes back.
    p.api.script((request, server) => {
      if (request.name !== 'activity.log') return undefined;
      server.apply(request);
      return noSignal;
    });
    const { id } = await note(p, 'Replaced the capacitor');
    const inPlace = await p.sync();
    expect(inPlace).toBe(1);
    expect(p.api.sent().map((r) => r.commandId)).toEqual([id, id]);
    expect(p.api.receipts.size).toBe(1);
    // Tried twice, ran once, and kept the one answer.
    expect(p.row(id)).toMatchObject({ state: 'sent', attempts: 2 });
    expect(JSON.parse(p.row(id).answer as string)).toEqual({ ok: true, n: 1 });
  });

  it('refreshes the sign-in on a 401 and sends it again', async () => {
    const p = phone();
    p.api.script((r) =>
      r.name === 'activity.log' ? { reached: true, status: 401, body: null } : undefined,
    );
    const { id } = await note(p, 'After an hour offline');
    const inPlace = await p.sync();
    expect(inPlace).toBe(0);
    expect(p.refreshes.count).toBe(1);
    expect(p.api.sent()).toHaveLength(2);
    expect(p.row(id).state).toBe('sent');
  });

  it('stops sending on a 426 and keeps everything, until the app is updated', async () => {
    const p = phone();
    p.api.script(() => ({
      reached: true,
      status: 426,
      body: {
        error: {
          code: 'upgrade_required',
          message: 'Update the HandsFreeOS app to keep going.',
          details: { minVersion: '1.1.0' },
          disposition: 'retry',
        },
      },
    }));
    const a = await note(p, 'A');
    const b = await note(p, 'B');
    const c = await note(p, 'C');
    await p.sync();
    // One request: the rest are set aside without being sent.
    expect(p.api.sent()).toHaveLength(1);
    for (const id of [a.id, b.id, c.id])
      expect(p.row(id)).toMatchObject({
        state: 'retry',
        reason: TOO_OLD_WORDS,
        rule: 'upgrade_required',
      });
    expect(p.changes.getSnapshot()).toMatchObject({ tooOld: true, waiting: 3 });
    expect(p.db.queue()).toEqual([]);
    // Waiting out the retry rounds sends nothing from this build.
    await p.advance(15 * 60_000);
    await p.sync();
    expect(p.api.sent()).toHaveLength(1);
    // Updated: everything goes, in order.
    p.setVersion('1.1.0');
    await p.changes.retryNow();
    await p.sync();
    expect(p.api.receipts.size).toBe(3);
    expect([...p.api.receipts.values()].map((r) => JSON.parse(r.input).body)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(p.changes.getSnapshot()).toMatchObject({ tooOld: false, waiting: 0 });
  });
});

describe('changes that depend on others', () => {
  it('holds a chain three deep behind a refusal while an unrelated note goes, and sends them in order once fixed', async () => {
    const p = phone();
    const personId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const leadId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const rosa = await p.changes.change('person.create', {
      workspaceId: LONE_STAR,
      id: personId,
      firstName: 'Rosa',
      lastName: 'Delgado',
      email: 'rosa.delgado@gmail',
    });
    const lead = await p.changes.change(
      'lead.create',
      { workspaceId: LONE_STAR, id: leadId, personId, title: 'AC tune-up' },
      { dependsOn: [rosa.id] },
    );
    const task = await p.changes.change(
      'task.create',
      { workspaceId: LONE_STAR, title: 'Call Rosa about the tune-up', leadId },
      { dependsOn: [lead.id] },
    );
    const unrelated = await note(p, 'Asked about a second unit');
    p.api.always((r) =>
      r.name === 'person.create' && JSON.parse(r.input).email === 'rosa.delgado@gmail'
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
    await p.sync();
    expect(p.row(rosa.id)).toMatchObject({
      state: 'refused',
      reason: 'Email: Enter a valid email address.',
      rule: 'validation',
    });
    expect(p.row(lead.id)).toMatchObject({
      state: 'held',
      reason: 'Held until Rosa Delgado is saved, then it goes.',
    });
    expect(p.row(task.id)).toMatchObject({
      state: 'held',
      reason: 'Held until the AC tune-up lead for Rosa is saved, then it goes.',
    });
    expect(p.row(unrelated.id).state).toBe('sent');
    // Neither dependant ever left the phone.
    expect(p.api.sent().map((r) => r.name)).toEqual(['person.create', 'activity.log']);
    expect(p.db.queue()).toEqual([]);
    expect(p.changes.getSnapshot()).toMatchObject({ waiting: 3, needsYou: 1 });

    // Fixed: Rosa goes again under her change's own id, at the back, then the lead, then the task.
    const fixed = {
      workspaceId: LONE_STAR,
      id: personId,
      firstName: 'Rosa',
      lastName: 'Delgado',
      email: 'rosa.delgado@gmail.com',
    };
    await p.changes.fix(rosa.id, fixed);
    expect(p.row(rosa.id)).toMatchObject({ state: 'waiting', revision: 1 });
    await p.sync();
    expect(p.api.ran()).toEqual(['activity.log', 'person.create', 'lead.create', 'task.create']);
    const again = p.api.sent('person.create').at(-1)!;
    expect(again.commandId).toBe(rosa.id);
    expect(again.confirmedAt).not.toBeNull();
    for (const id of [rosa.id, lead.id, task.id]) expect(p.row(id).state).toBe('sent');
    expect(p.changes.getSnapshot()).toMatchObject({ waiting: 0, needsYou: 0 });
  });

  it('holds a change behind one set aside, and releases it once that one goes', async () => {
    const p = phone();
    const stop = p.api.always((r) => (r.name === 'person.create' ? noSignal : undefined));
    const person = await p.changes.change('person.create', {
      workspaceId: LONE_STAR,
      firstName: 'Nadia',
    });
    const lead = await p.changes.change(
      'lead.create',
      { workspaceId: LONE_STAR, personId: MARIA, title: 'Second unit' },
      { dependsOn: [person.id] },
    );
    await p.sync();
    expect(p.row(person.id).state).toBe('retry');
    expect(p.row(lead.id).state).toBe('held');
    stop();
    await p.advance(30_000);
    await p.sync();
    expect(p.api.ran()).toEqual(['person.create', 'lead.create']);
  });

  it('a fixed change the API kept an earlier try of goes under a new id', async () => {
    const p = phone();
    p.api.script((r, server) => {
      if (r.name !== 'lead.move_stage') return undefined;
      // The API ran the first try and kept its refusal against the id.
      server.receipts.set(r.commandId, { name: r.name, input: r.input, output: null });
      return refusal(409, 'final', 'This lead is archived. Restore it, then move it.', {
        rule: 'lead_archived',
      });
    });
    const move = await p.changes.change('lead.move_stage', {
      workspaceId: LONE_STAR,
      leadId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      stageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    await p.sync();
    expect(p.row(move.id).state).toBe('refused');
    await p.changes.fix(move.id, {
      workspaceId: LONE_STAR,
      leadId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      stageId: '12121212-1212-4212-8212-121212121212',
    });
    await p.sync();
    const tries = p.api.sent('lead.move_stage');
    expect(tries.map((t) => t.commandId)).toEqual([
      move.id,
      move.id,
      expect.not.stringMatching(move.id),
    ]);
    expect(p.row(move.id)).toMatchObject({ state: 'sent', command_id: tries[2]!.commandId });
  });

  it('counts what hasn’t gone, and keeps the count for a copy that isn’t open', async () => {
    const p = phone({ online: false });
    await note(p, 'One');
    await note(p, 'Two');
    await p.settle();
    expect(p.changes.getSnapshot()).toMatchObject({ userId: DALE, waiting: 2 });
    // Signing out counts from the copy before it closes: 2 waiting keep the copy.
    expect(await p.changes.closing(p.db, DALE)).toBe(2);
    expect(p.changes.getSnapshot()).toMatchObject({ userId: null, waiting: 0 });
    expect(p.changes.lastKnown(DALE)).toBe(2);
    expect(await p.changes.closing(null, DALE)).toBe(2);
  });
});
