import { LONE_STAR, MARIA, noSignal, phone } from './harness';

/**
 * A change sent straight away (a notification's button, pressed while the app is locked or closed and so not connected
 * to the sync service) follows the queue's rules, and is never sent twice: not by the upload queue afterwards, not by
 * the queue at the same moment, and not when made again under the same command id.
 */

const COMMAND_ID = '10000000-0000-4000-8000-000000000001';
const text = { workspaceId: LONE_STAR, personId: MARIA, body: 'Marco can be there at 11.' };

describe('sending a queued change straight away', () => {
  it('sends it once, and the upload queue then has nothing more to send', async () => {
    const p = phone();
    const made = await p.changes.change('message.send', text, { commandId: COMMAND_ID });
    await expect(p.changes.sendQueuedNow(made.id)).resolves.toMatchObject({ state: 'sent' });
    await p.sync();
    expect(p.api.sent('message.send')).toEqual([
      expect.objectContaining({ commandId: COMMAND_ID }),
    ]);
  });

  it('sends it once when the upload queue gets to it at the same moment', async () => {
    const p = phone();
    const made = await p.changes.change('message.send', text, { commandId: COMMAND_ID });
    await Promise.all([p.changes.sendQueuedNow(made.id), p.sync()]);
    expect(p.api.sent('message.send')).toHaveLength(1);
    expect(p.row(made.id).state).toBe('sent');
  });

  it('keeps the same change for the same command id instead of making another', async () => {
    const p = phone();
    const first = await p.changes.change('message.send', text, { commandId: COMMAND_ID });
    const second = await p.changes.change('message.send', text, { commandId: COMMAND_ID });
    expect(second.id).toBe(first.id);
    expect(p.db.rows('SELECT id, command_id FROM outbox')).toEqual([
      { id: first.id, command_id: COMMAND_ID },
    ]);
  });

  it('leaves one that can’t get through in the queue, which sends it later', async () => {
    const p = phone();
    const made = await p.changes.change('message.send', text, { commandId: COMMAND_ID });
    p.api.script(() => noSignal);
    await expect(p.changes.sendQueuedNow(made.id)).resolves.toMatchObject({ state: 'sending' });
    await p.sync();
    expect(p.api.sent('message.send').map((r) => r.commandId)).toEqual([COMMAND_ID, COMMAND_ID]);
    expect(p.api.ran()).toEqual(['message.send']);
    expect(p.row(made.id).state).toBe('sent');
  });

  it('carries the moment the button was pressed, never later than now', async () => {
    const p = phone();
    const pressed = p.clock.now - 5 * 60_000;
    const made = await p.changes.change('message.send', text, {
      commandId: COMMAND_ID,
      madeAt: pressed,
    });
    await p.changes.sendQueuedNow(made.id);
    expect(p.api.sent('message.send')[0]!.madeAt).toBe(new Date(pressed).toISOString());
    const future = await p.changes.change(
      'activity.log',
      { workspaceId: LONE_STAR, personId: MARIA, kind: 'note', body: 'x' },
      { madeAt: p.clock.now + 60_000 },
    );
    expect(p.row(future.id)['made_at']).toBe(new Date(p.clock.now).toISOString());
  });
});
