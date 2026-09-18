import {
  DALE,
  LONE_STAR,
  memoryStore,
  phone,
  refusal,
  type Phone,
} from '@/changes/__tests__/harness';

import { TAP } from '../buttons';
import { PressRunner, type FollowUp, type PressDeps } from '../press';

import { approval, COMMAND_IDS, CONVERSATION, customerMessage, ITEM, urgentLead } from './fixtures';

/**
 * A press on a notification runs its command through `change()` under the command id the notification carries, then
 * sends it straight away: pressed twice, replayed, or pressed on another of the person's phones, it's done once. On a
 * locked Android phone the buttons that reach a customer wait for the unlock; Snooze doesn't. What happened replaces
 * the notification.
 */

const MIN = 60_000;
const identifier = `conversation-${CONVERSATION}`;

function runner(
  p: Phone,
  options: Partial<PressDeps> & { locked?: boolean; inFront?: boolean } = {},
) {
  const followUps: FollowUp[] = [];
  const dismissed: string[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  const unlocks: number[] = [];
  const state = { locked: options.locked ?? false, inFront: options.inFront ?? false };
  const r = new PressRunner({
    platform: 'android',
    now: () => p.clock.now,
    ready: async () => ({ userId: DALE, businessIds: [LONE_STAR] }),
    phoneLocked: () => state.locked,
    change: (name, input, opts) => p.changes.change(name, input, opts),
    sendNow: (id) => p.changes.sendQueuedNow(id),
    openLink: (path) => void opened.push(path),
    appInFront: () => state.inFront,
    askAbout: (id) => void asked.push(id),
    unlockToRun: () => void unlocks.push(p.clock.now),
    followUp: async (f) => void followUps.push(f),
    dismiss: async (id) => void dismissed.push(id),
    store: memoryStore(),
    ...options,
  });
  return { r, followUps, dismissed, opened, asked, unlocks, state };
}

const reply = (typed = 'Marco can be there at 11. Does that work?') => ({
  data: customerMessage(),
  actionId: 'reply',
  typed,
  identifier,
});

describe('a button pressed on a notification', () => {
  it('replies once, under the notification’s command id, made when it was pressed, and says so in the notification', async () => {
    const p = phone();
    const { r, dismissed, followUps } = runner(p);
    const outcome = await r.handle(reply());
    expect(outcome).toEqual({ kind: 'sent', button: 'reply', changeId: expect.any(String) });
    expect(p.api.sent('message.send')).toEqual([
      expect.objectContaining({
        commandId: COMMAND_IDS.reply,
        madeAt: new Date(p.clock.now).toISOString(),
      }),
    ]);
    expect(JSON.parse(p.api.sent('message.send')[0]!.input)).toEqual({
      workspaceId: LONE_STAR,
      conversationId: CONVERSATION,
      channel: 'sms',
      body: 'Marco can be there at 11. Does that work?',
    });
    expect(p.row(outcome.kind === 'sent' ? outcome.changeId : '').state).toBe('sent');
    // Android keeps a notification replied to from the shade: it says the reply went, without buttons.
    expect(followUps).toEqual([
      { kind: 'done', data: customerMessage(), title: 'Kendra Lee', body: 'Your reply was sent.' },
    ]);
    expect(dismissed).toEqual([]);
  });

  it('takes the notification away after a reply on an iPhone, and after a button with nothing typed', async () => {
    const ios = runner(phone(), { platform: 'ios' });
    await expect(ios.r.handle(reply())).resolves.toMatchObject({ kind: 'sent' });
    expect(ios.dismissed).toEqual([identifier]);
    expect(ios.followUps).toEqual([]);
    const android = runner(phone());
    await expect(
      android.r.handle({
        data: customerMessage(),
        actionId: 'let_ai_handle',
        typed: null,
        identifier,
      }),
    ).resolves.toMatchObject({ kind: 'sent', button: 'let_ai_handle' });
    expect(android.dismissed).toEqual([identifier]);
    expect(android.followUps).toEqual([]);
  });

  it('does it once when pressed twice, replayed, or heard twice at the same moment', async () => {
    const p = phone();
    const { r } = runner(p);
    const [first, second] = await Promise.all([r.handle(reply()), r.handle(reply())]);
    expect(first).toEqual(second);
    await expect(r.handle(reply())).resolves.toEqual({ kind: 'already', button: 'reply' });
    // A second, different reply from the same notification is the same press: already done.
    await expect(r.handle(reply('Never mind'))).resolves.toEqual({
      kind: 'already',
      button: 'reply',
    });
    expect(p.api.sent('message.send')).toHaveLength(1);
    expect(p.db.rows('SELECT id FROM outbox')).toHaveLength(1);
  });

  it('gets the first answer back when the same button is pressed on another of the person’s phones', async () => {
    const p = phone();
    await runner(p).r.handle(reply());
    // Another phone: its own queue and its own memory of presses, the same API with its receipts.
    const otherPhone = phone({ send: p.api.send });
    const other = runner(otherPhone);
    await expect(other.r.handle(reply())).resolves.toMatchObject({ kind: 'sent' });
    expect(other.followUps).toEqual([expect.objectContaining({ kind: 'done' })]);
    expect(p.api.sent('message.send').map((s) => s.commandId)).toEqual([
      COMMAND_IDS.reply,
      COMMAND_IDS.reply,
    ]);
    expect(p.api.ran().filter((n) => n === 'message.send')).toHaveLength(1);
  });

  it('treats the API keeping a different reply under the same id as already done', async () => {
    const p = phone();
    p.api.script((request) =>
      request.name === 'message.send'
        ? refusal(409, 'final', 'The app already sent a different change with this id.', {
            rule: 'command_id_reused',
          })
        : undefined,
    );
    const { r, followUps } = runner(p);
    await expect(r.handle(reply())).resolves.toEqual({ kind: 'already', button: 'reply' });
    expect(followUps).toEqual([
      {
        kind: 'done',
        data: customerMessage(),
        title: 'Kendra Lee',
        body: 'That was already done.',
      },
    ]);
  });

  it.each([
    ['approval_decided', 'step' as const, 'workflow.decide_approval'],
    ['draft_decided', 'draft' as const, 'ai_teammate.decide_draft'],
  ])(
    'treats Approve after the same thing was decided on Home (%s) as already done',
    async (rule, kind, command) => {
      const p = phone();
      p.api.script((request) =>
        request.name === command
          ? refusal(409, 'final', 'This was already decided.', { rule })
          : undefined,
      );
      const { r, followUps, dismissed } = runner(p);
      await expect(
        r.handle({
          data: approval(kind),
          actionId: 'approve',
          typed: null,
          identifier: `approval-${kind}`,
        }),
      ).resolves.toEqual({ kind: 'already', button: 'approve' });
      // Nothing was refused and nothing ran twice, so the notification simply goes, as a done press does.
      expect(followUps).toEqual([]);
      expect(dismissed).toEqual([`approval-${kind}`]);
    },
  );

  it('snoozes an hour from the press, under Snooze’s own id', async () => {
    const p = phone();
    const { r } = runner(p);
    await expect(
      r.handle({
        data: urgentLead(),
        actionId: 'snooze',
        typed: null,
        identifier: urgentLead().notificationId,
      }),
    ).resolves.toMatchObject({ kind: 'sent', button: 'snooze' });
    const [sent] = p.api.sent('attention.snooze');
    expect(sent!.commandId).toBe(COMMAND_IDS.snooze);
    expect(JSON.parse(sent!.input)).toEqual({
      workspaceId: LONE_STAR,
      itemId: ITEM,
      until: new Date(p.clock.now + 60 * MIN).toISOString(),
    });
  });
});

describe('the unlock rule', () => {
  it('on a locked Android phone, keeps Reply until the phone is unlocked and asks for it; Snooze still runs', async () => {
    const p = phone();
    const { r, followUps, state, opened, unlocks } = runner(p, { locked: true });
    const pressedAt = p.clock.now;
    await expect(r.handle(reply())).resolves.toEqual({ kind: 'unlock-first', button: 'reply' });
    expect(p.api.sent()).toEqual([]);
    expect(followUps).toEqual([
      {
        kind: 'unlock',
        data: customerMessage(),
        title: 'Kendra Lee',
        body: 'Unlock your phone to send your reply.',
      },
    ]);
    expect(r.pending()).toMatchObject({ actionId: 'reply', pressedAt });

    await expect(
      r.handle({ data: urgentLead(), actionId: 'snooze', typed: null, identifier: 'lead' }),
    ).resolves.toMatchObject({ kind: 'sent', button: 'snooze' });
    expect(p.api.sent().map((s) => s.name)).toEqual(['attention.snooze']);

    // Tapping "Unlock your phone to send your reply." opens the conversation and asks to run the reply.
    p.clock.now += MIN;
    state.locked = false;
    await r.handle(
      { data: customerMessage(), actionId: TAP, typed: null, identifier },
      { followUp: { kind: 'unlock' } },
    );
    expect(opened).toEqual([customerMessage().path]);
    expect(unlocks).toHaveLength(1);
    // Once the app has let the person in: it runs, made when it was pressed.
    await expect(r.runPending()).resolves.toMatchObject({ kind: 'sent', button: 'reply' });
    expect(r.pending()).toBeNull();
    expect(p.api.sent('message.send')).toEqual([
      expect.objectContaining({
        commandId: COMMAND_IDS.reply,
        madeAt: new Date(pressedAt).toISOString(),
      }),
    ]);
  });

  it('leaves the unlock to an iPhone, which asks for Face ID or the passcode before the press reaches the app', async () => {
    const p = phone();
    const { r } = runner(p, { platform: 'ios', locked: true });
    await expect(r.handle(reply())).resolves.toMatchObject({ kind: 'sent' });
  });

  it('asks Still send? when a press kept for the unlock is run more than 30 minutes later', async () => {
    const p = phone();
    const { r, state, asked, opened } = runner(p, { locked: true, inFront: true });
    await r.handle(reply());
    p.clock.now += 45 * MIN;
    state.locked = false;
    const outcome = await r.runPending();
    expect(outcome).toMatchObject({ kind: 'asked', rule: 'stale_action' });
    expect(p.api.sent()).toEqual([]);
    expect(opened).toEqual([customerMessage().path]);
    expect(asked).toEqual([outcome?.kind === 'asked' ? outcome.changeId : '']);
  });
});

describe('what a press leaves behind', () => {
  it('asks about quiet hours: in a notification with the app closed, opening the conversation to ask', async () => {
    const p = phone();
    // 9:40 PM in Houston, inside Lone Star's quiet hours (8 PM to 8 AM).
    p.clock.now = Date.parse('2026-09-17T02:40:00.000Z');
    const { r, followUps, opened, asked } = runner(p);
    const outcome = await r.handle(reply());
    expect(outcome).toMatchObject({ kind: 'asked', button: 'reply', rule: 'quiet_hours' });
    expect(p.api.sent()).toEqual([]);
    const changeId = outcome.kind === 'asked' ? outcome.changeId : '';
    expect(followUps).toEqual([
      {
        kind: 'ask',
        data: customerMessage(),
        title: 'Kendra Lee',
        body: 'It’s quiet hours at Lone Star HVAC & Roofing. Open to send your reply now, or when quiet hours end.',
        changeId,
      },
    ]);
    await r.handle(
      { data: customerMessage(), actionId: TAP, typed: null, identifier },
      { followUp: { kind: 'ask', changeId } },
    );
    expect(opened).toEqual([customerMessage().path]);
    expect(asked).toEqual([changeId]);
  });

  it('heads what it says on an iPhone with the notification’s own title, which an iPhone push keeps beside its data', async () => {
    const p = phone();
    p.clock.now = Date.parse('2026-09-17T02:40:00.000Z');
    const { title: _title, subtitle: _subtitle, body: _body, ...data } = customerMessage();
    const { r, followUps } = runner(p, { platform: 'ios' });
    await r.handle({
      data,
      actionId: 'reply',
      typed: 'See you at 11.',
      identifier,
      title: 'Kendra Lee',
    });
    expect(followUps[0]).toMatchObject({ kind: 'ask', title: 'Kendra Lee' });
  });

  it('asks about quiet hours at once, over the conversation, when the app is in front', async () => {
    const p = phone();
    p.clock.now = Date.parse('2026-09-17T02:40:00.000Z');
    const { r, followUps, opened, asked, dismissed } = runner(p, { inFront: true });
    const outcome = await r.handle(reply());
    expect(followUps).toEqual([]);
    expect(dismissed).toEqual([identifier]);
    expect(opened).toEqual([customerMessage().path]);
    expect(asked).toEqual([outcome.kind === 'asked' ? outcome.changeId : '']);
  });

  it('says why it was refused, in the API’s words, and opens Changes on this phone', async () => {
    const p = phone();
    p.api.script((request) =>
      request.name === 'message.send'
        ? refusal(409, 'final', 'Kendra Lee texted STOP, so she can’t be texted.', {
            rule: 'opted_out',
          })
        : undefined,
    );
    const { r, followUps, opened } = runner(p);
    const outcome = await r.handle(reply());
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'Kendra Lee texted STOP, so she can’t be texted.',
    });
    expect(followUps[0]).toMatchObject({
      kind: 'refused',
      body: 'Your reply wasn’t sent. Kendra Lee texted STOP, so she can’t be texted.',
    });
    await r.handle(
      { data: customerMessage(), actionId: TAP, typed: null, identifier },
      { followUp: { kind: 'refused' } },
    );
    expect(opened).toEqual([`/app/w/${LONE_STAR}/changes`]);
  });

  it('waits on the phone with no signal, says so, and goes once when signal is back', async () => {
    const p = phone({ online: false });
    const { r, followUps } = runner(p);
    const outcome = await r.handle(reply());
    expect(outcome).toMatchObject({ kind: 'waiting', button: 'reply' });
    expect(followUps[0]).toMatchObject({
      kind: 'waiting',
      body: 'Your reply is on this phone and goes as soon as HandsFreeOS can be reached.',
    });
    p.setOnline(true);
    await p.sync();
    expect(p.api.sent('message.send')).toEqual([
      expect.objectContaining({ commandId: COMMAND_IDS.reply }),
    ]);
    await expect(r.handle(reply())).resolves.toEqual({ kind: 'already', button: 'reply' });
    expect(p.api.sent('message.send')).toHaveLength(1);
  });

  it('opens the push’s path for a tap, Call and Review, once when heard twice', async () => {
    const p = phone();
    const { r, opened } = runner(p);
    await r.handle({ data: customerMessage(), actionId: TAP, typed: null, identifier });
    await r.handle({ data: customerMessage(), actionId: TAP, typed: null, identifier });
    await r.handle({ data: customerMessage(), actionId: 'call', typed: null, identifier });
    expect(opened).toEqual([customerMessage().path, customerMessage().path]);
    expect(p.api.sent()).toEqual([]);
  });

  it('opens the conversation for Call and asks for the call there, which a tap never does', async () => {
    const p = phone();
    const calls: unknown[] = [];
    const { r, opened } = runner(p, {
      startCall: (target, workspaceId) => void calls.push({ target, workspaceId }),
    });
    await r.handle({ data: customerMessage(), actionId: TAP, typed: null, identifier });
    expect(calls).toEqual([]);
    await r.handle({ data: customerMessage(), actionId: 'call', typed: null, identifier });
    expect(opened).toEqual([customerMessage().path, customerMessage().path]);
    expect(calls).toEqual([{ target: { conversationId: CONVERSATION }, workspaceId: LONE_STAR }]);
    // An urgent lead's Call: the customer, when the push names them; with neither, nothing to call.
    const person = '30000000-0000-4000-8000-000000000001';
    const lead = urgentLead();
    await r.handle({
      data: {
        ...lead,
        notificationId: '20000000-0000-4000-8000-0000000000aa',
        refs: { ...lead.refs, personId: person },
      },
      actionId: 'call',
      typed: null,
      identifier: 'lead-with-person',
    });
    expect(calls[1]).toEqual({ target: { personId: person }, workspaceId: LONE_STAR });
    await r.handle({ data: lead, actionId: 'call', typed: null, identifier: 'lead' });
    expect(calls).toHaveLength(2);
    // The call itself isn't a change the press makes: the call sheet runs it, with signal.
    expect(p.api.sent()).toEqual([]);
  });

  it('does nothing for a business the person isn’t part of', async () => {
    const p = phone();
    const { r } = runner(p, { ready: async () => ({ userId: DALE, businessIds: [] }) });
    await expect(r.handle(reply())).resolves.toMatchObject({ kind: 'nothing' });
    expect(p.api.sent()).toEqual([]);
  });
});
