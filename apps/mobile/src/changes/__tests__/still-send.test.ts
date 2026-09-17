import { isStale, quietHoursQuestion, quietHoursWindow } from '../rules';
import { askOf } from '../list';

import { LONE_STAR, MARIA, phone, refusal, type Phone } from './harness';

/**
 * "Still send?" and the quiet-hours question: a customer-facing change more than 30 minutes old asks first, and so does
 * the API's stale_action; a text that would go inside the business's quiet hours (its own settings, in its own time
 * zone) asks "Send now, or at 8:00 AM when quiet hours end?", and so does the API's quiet_hours.
 */

const MIN = 60_000;

describe('how old a change may be', () => {
  const now = Date.parse('2026-09-16T20:00:00.000Z');
  it('goes on its own for 30 minutes, then asks', () => {
    expect(isStale({ name: 'message.send', madeAt: now - 30 * MIN, confirmedAt: null, now })).toBe(
      false,
    );
    expect(
      isStale({ name: 'message.send', madeAt: now - 30 * MIN - 1, confirmedAt: null, now }),
    ).toBe(true);
    expect(isStale({ name: 'estimate.send', madeAt: now - 45 * MIN, confirmedAt: null, now })).toBe(
      true,
    );
  });

  it('goes after a yes within the last 5 minutes, and asks again after that', () => {
    const madeAt = now - 45 * MIN;
    expect(isStale({ name: 'message.send', madeAt, confirmedAt: now - 4 * MIN, now })).toBe(false);
    expect(isStale({ name: 'message.send', madeAt, confirmedAt: now - 6 * MIN, now })).toBe(true);
  });

  it('never asks for a change that can wait any time', () => {
    expect(
      isStale({ name: 'activity.log', madeAt: now - 3 * 24 * 60 * MIN, confirmedAt: null, now }),
    ).toBe(false);
    expect(isStale({ name: 'lead.move_stage', madeAt: 0, confirmedAt: null, now })).toBe(false);
  });
});

describe('quiet hours', () => {
  const at = (iso: string) => new Date(iso);
  const text = { workspaceId: LONE_STAR, personId: MARIA, body: 'See you Monday at 8.' };
  const settings = (quietHours: unknown) => JSON.stringify({ telephony: { quietHours } });
  const ask = (
    input: unknown,
    when: Date,
    timeZone = 'America/Chicago',
    s: unknown = settings({ enabled: true, start: '20:00', end: '08:00' }),
  ) => quietHoursQuestion({ name: 'message.send', input, settings: s, timeZone, now: when });

  it('asks at 9:40 PM where the business is, in a window past midnight', () => {
    // 9:40 PM in Houston (CDT) is 02:40 UTC the next day.
    expect(ask(text, at('2026-09-17T02:40:00Z'))).toEqual({
      localTime: '21:40',
      endsAt: '08:00',
      startsAt: '20:00',
    });
    // 7:59 AM is still quiet; 8:00 AM isn't; 7:59 PM isn't yet.
    expect(ask(text, at('2026-09-16T12:59:00Z'))?.localTime).toBe('07:59');
    expect(ask(text, at('2026-09-16T13:00:00Z'))).toBeNull();
    expect(ask(text, at('2026-09-17T00:59:00Z'))).toBeNull();
  });

  it('judges the time in the business’s own zone, not the phone’s', () => {
    const when = at('2026-09-17T02:40:00Z');
    expect(ask(text, when, 'America/Chicago')?.localTime).toBe('21:40');
    // The same moment is 7:40 PM in Los Angeles: not quiet yet.
    expect(ask(text, when, 'America/Los_Angeles')).toBeNull();
    // And 2:40 PM the next afternoon in Auckland.
    expect(ask(text, when, 'Pacific/Auckland')).toBeNull();
  });

  it('never asks when quiet hours are off, or start and end at the same time', () => {
    const when = at('2026-09-17T02:40:00Z');
    expect(
      ask(
        text,
        when,
        'America/Chicago',
        settings({ enabled: false, start: '20:00', end: '08:00' }),
      ),
    ).toBeNull();
    expect(
      ask(text, when, 'America/Chicago', settings({ enabled: true, start: '08:00', end: '08:00' })),
    ).toBeNull();
  });

  it('takes the default 8 PM to 8 AM when the business never set any', () => {
    expect(quietHoursWindow(JSON.stringify({}))).toEqual({
      enabled: true,
      start: '20:00',
      end: '08:00',
    });
    expect(quietHoursWindow('not json')).toEqual({ enabled: true, start: '20:00', end: '08:00' });
    expect(ask(text, at('2026-09-17T02:40:00Z'), 'America/Chicago', null)?.endsAt).toBe('08:00');
  });

  it('asks only about texts that haven’t been answered', () => {
    const when = at('2026-09-17T02:40:00Z');
    expect(ask({ ...text, channel: 'email', subject: 'Monday' }, when)).toBeNull();
    expect(ask({ ...text, acknowledgeQuietHours: true }, when)).toBeNull();
    expect(ask({ ...text, sendAfterQuietHours: true }, when)).toBeNull();
    expect(
      quietHoursQuestion({
        name: 'activity.log',
        input: text,
        settings: null,
        timeZone: 'America/Chicago',
        now: when,
      }),
    ).toBeNull();
  });
});

const textMaria = (p: Phone, body = 'Thanks again, Maria. We’ll be back Monday at 8:00 AM.') =>
  p.changes.change('message.send', {
    workspaceId: LONE_STAR,
    personId: MARIA,
    body,
    clientId: 'bubble-1',
  });

describe('Still send?', () => {
  it('asks about a text written 45 minutes ago, sends nothing, and lets the queue move on', async () => {
    const p = phone({ online: false });
    const text = await textMaria(p);
    const note = await p.changes.change('activity.log', {
      workspaceId: LONE_STAR,
      personId: MARIA,
      kind: 'note',
      body: 'After the text',
    });
    p.clock.now += 45 * MIN;
    // Still waiting for signal, but too old to go on its own: it needs the person already.
    expect(askOf(p.row(text.id) as never, p.clock.now)).toBe('still-send');
    await p.sync();
    expect(p.row(text.id)).toMatchObject({
      state: 'ask',
      rule: 'stale_action',
      reason: 'This was done 45 minutes ago, so it waits for your OK before it goes.',
    });
    expect(p.api.sent('message.send')).toEqual([]);
    expect(p.row(note.id).state).toBe('sent');
    expect(p.changes.getSnapshot()).toMatchObject({ waiting: 1, needsYou: 1 });

    // Send now: exactly one message, under the change's own id, with when the person said yes.
    await p.changes.stillSend(text.id);
    await p.sync();
    const sent = p.api.sent('message.send');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      commandId: text.id,
      confirmedAt: new Date(p.clock.now).toISOString(),
    });
    expect(p.api.ran().filter((n) => n === 'message.send')).toHaveLength(1);
    expect(p.row(text.id).state).toBe('sent');
  });

  it('takes the API’s own stale_action the same way', async () => {
    const p = phone();
    p.api.script((r) =>
      r.name === 'message.send' && !r.confirmedAt
        ? refusal(
            409,
            'ask',
            'This was done 31 minutes ago, so it waits for your OK before it goes.',
            {
              rule: 'stale_action',
              details: { freshMinutes: 30 },
            },
          )
        : undefined,
    );
    const text = await textMaria(p);
    await p.sync();
    expect(p.row(text.id)).toMatchObject({
      state: 'ask',
      rule: 'stale_action',
      disposition: 'ask',
    });
    await p.changes.stillSend(text.id);
    await p.sync();
    expect(p.api.ran()).toEqual(['message.send']);
  });

  it('asks again when the yes is more than 5 minutes old by the time there’s signal', async () => {
    const p = phone({ online: false });
    const text = await textMaria(p);
    p.clock.now += 45 * MIN;
    await p.changes.stillSend(text.id);
    p.clock.now += 6 * MIN;
    await p.sync();
    expect(p.row(text.id)).toMatchObject({ state: 'ask', rule: 'stale_action' });
    expect(p.api.sent()).toEqual([]);
  });

  it('discards only that change, after saying what depends on it', async () => {
    const p = phone();
    const text = await textMaria(p);
    const unrelated = await p.changes.change('activity.log', {
      workspaceId: LONE_STAR,
      personId: MARIA,
      kind: 'note',
      body: 'Unrelated',
    });
    p.clock.now += 45 * MIN;
    await p.sync();
    expect(await p.changes.dependantsOf(text.id)).toEqual([]);
    await p.changes.discard([text.id]);
    expect(p.db.rows('SELECT id FROM outbox WHERE id = ?', [text.id])).toEqual([]);
    expect(p.row(unrelated.id).state).toBe('sent');
    expect(p.api.sent('message.send')).toEqual([]);
  });
});

describe('the quiet-hours question', () => {
  // 9:25 PM in Houston: written inside quiet hours, still fresh.
  const evening = Date.parse('2026-09-17T02:25:00.000Z');

  it('asks instead of sending, with the business’s time and when quiet hours end', async () => {
    const p = phone();
    p.clock.now = evening;
    const text = await textMaria(p, 'Hi Maria, the new unit is ordered and gets here Friday.');
    p.clock.now = evening + 15 * MIN;
    await p.sync();
    const row = p.row(text.id);
    expect(row).toMatchObject({
      state: 'ask',
      rule: 'quiet_hours',
      reason: 'It’s 9:40 PM where the business is. Quiet hours end at 8:00 AM.',
    });
    expect(JSON.parse(row.answer as string)).toEqual({
      phone: { localTime: '21:40', endsAt: '08:00', startsAt: '20:00', stale: false },
    });
    expect(p.api.sent()).toEqual([]);
  });

  it('"Send at 8:00 AM" sends sendAfterQuietHours; "Send now" sends it as it is, acknowledged', async () => {
    const p = phone();
    p.clock.now = evening;
    const later = await textMaria(p, 'Tomorrow is fine.');
    const now = await textMaria(p, 'Running late, sorry!');
    await p.sync();
    await p.changes.answerQuietHours(later.id, 'when-quiet-hours-end');
    await p.changes.answerQuietHours(now.id, 'now');
    await p.sync();
    const [first, second] = p.api.sent('message.send');
    expect(JSON.parse(first!.input)).toMatchObject({
      body: 'Tomorrow is fine.',
      sendAfterQuietHours: true,
    });
    expect(JSON.parse(first!.input)).not.toHaveProperty('acknowledgeQuietHours');
    expect(JSON.parse(second!.input)).toMatchObject({
      body: 'Running late, sorry!',
      acknowledgeQuietHours: true,
    });
    expect(first!.commandId).toBe(later.id);
    expect(p.api.ran()).toEqual(['message.send', 'message.send']);
  });

  it('asks once, not twice, for a text that is old as well as inside quiet hours', async () => {
    const p = phone({ online: false });
    p.clock.now = evening - 60 * MIN;
    const text = await textMaria(p);
    p.clock.now = evening;
    await p.sync();
    expect(p.row(text.id)).toMatchObject({ state: 'ask', rule: 'quiet_hours' });
    // Either answer says "send it": no "Still send?" after it.
    await p.changes.answerQuietHours(text.id, 'when-quiet-hours-end');
    await p.sync();
    expect(p.api.ran()).toEqual(['message.send']);
  });

  it('takes the API’s own quiet_hours the same way, when the phone didn’t know', async () => {
    const p = phone();
    p.db.sqlite.exec('DELETE FROM workspaces');
    p.api.script((r) =>
      r.name === 'message.send'
        ? refusal(409, 'ask', 'It’s 9:40 PM where the business is. Quiet hours end at 8:00 AM.', {
            rule: 'quiet_hours',
            details: { localTime: '21:40', endsAt: '08:00' },
          })
        : undefined,
    );
    const text = await textMaria(p);
    await p.sync();
    expect(p.row(text.id)).toMatchObject({ state: 'ask', rule: 'quiet_hours', disposition: 'ask' });
    expect(askOf(p.row(text.id) as never, p.clock.now)).toBe('quiet-hours');
    await p.changes.answerQuietHours(text.id, 'when-quiet-hours-end');
    await p.sync();
    expect(JSON.parse(p.api.sent('message.send').at(-1)!.input)).toMatchObject({
      sendAfterQuietHours: true,
    });
    expect(p.api.ran()).toEqual(['message.send']);
  });

  it('never asks with quiet hours off', async () => {
    const p = phone();
    p.db.sqlite.exec(
      `UPDATE workspaces SET settings = '{"telephony":{"quietHours":{"enabled":false,"start":"20:00","end":"08:00"}}}'`,
    );
    p.clock.now = evening;
    await textMaria(p);
    await p.sync();
    expect(p.api.ran()).toEqual(['message.send']);
  });
});
