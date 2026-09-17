import { conversationOf, type ConversationListRow, type ThreadItemShape } from '@hfos/core';

import type { OutboxRow } from '@/changes/outbox';
import { pendingLine, quietFactsOf } from '@/components/inbox/pending-reply';

import { CALL_REQUEST_KEPT_MS, callRequests, startCall } from '../calls';
import { cancelledHere, pendingReplies, replyStage, withOwnChanges } from '../outbox';
import { noteOf, threadEntries } from '../thread-entries';

/**
 * The inbox on the phone: a conversation as this phone's own changes leave it, the replies written here that the thread
 * shows until HandsFreeOS sends them back, the thread's order with its day dividers, and Call asked for from anywhere.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DALE = { id: '11111111-1111-4111-8111-111111111111', fullName: 'Dale Porter' };
const MARCO = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-09-17T15:12:00.000Z');

let seq = 0;
function row(
  name: string,
  input: Record<string, unknown>,
  extra: Partial<OutboxRow> = {},
): OutboxRow {
  seq += 1;
  return {
    id: `change-${seq}`,
    command_id: `cmd-${seq}`,
    name,
    workspace_id: WS,
    input: JSON.stringify({ workspaceId: WS, ...input }),
    made_at: new Date(T0 + seq * 1000).toISOString(),
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
    queued_at: new Date(T0).toISOString(),
    settled_at: new Date(T0).toISOString(),
    sent_at: null,
    ...extra,
  };
}

const base: ConversationListRow = {
  id: CONV,
  channel: 'sms',
  counterpart: '+17135550142',
  status: 'open',
  person_id: 'p1',
  first_name: 'Mike',
  last_name: 'Johnson',
  assignee_user_id: null,
  unread_count: 2,
  last_message_at: '2026-09-17T12:30:00.000Z',
  last_preview: 'Is Marco still coming?',
  last_direction: 'inbound',
  awaiting_reply_since: '2026-09-17T12:30:00.000Z',
  snoozed_until: null,
  created_at: '2026-09-01T12:00:00.000Z',
  handled_by: 'ai',
  ai_teammate_id: 't1',
  teammate_name: 'Ava',
  needs_person_since: null,
  handoff_reason: null,
  handoff_note: null,
  taken_over_by: null,
};

describe('a conversation with this phone’s own changes over it', () => {
  it('closes, snoozes, reopens, assigns and reads it in the order they were made', () => {
    const c = conversationOf(base);
    const rows = [
      row('conversation.close', { conversationId: CONV }),
      row('conversation.reopen', { conversationId: CONV }),
      row('conversation.snooze', { conversationId: CONV, until: '2026-09-18T13:00:00.000Z' }),
      row('conversation.assign', { conversationId: CONV, assigneeUserId: MARCO }),
      row('conversation.mark_read', { conversationId: CONV }),
      row('conversation.close', { conversationId: OTHER }),
    ];
    const out = withOwnChanges(c, rows, DALE, new Map([[MARCO, 'Marco Diaz']]));
    expect(out).toMatchObject({
      status: 'snoozed',
      snoozedUntil: '2026-09-18T13:00:00.000Z',
      assignee: { id: MARCO, fullName: 'Marco Diaz' },
      unreadCount: 0,
    });
  });

  it('leaves out a change that was refused or has gone through', () => {
    const c = conversationOf(base);
    const out = withOwnChanges(
      c,
      [
        row('conversation.close', { conversationId: CONV }, { state: 'refused' }),
        row('conversation.snooze', { conversationId: CONV, until: 'x' }, { state: 'sent' }),
      ],
      DALE,
    );
    expect(out.status).toBe('open');
  });

  it('a reply opens it, answers the customer and takes it from the AI teammate', () => {
    const closed = conversationOf({ ...base, status: 'closed' });
    const reply = row('message.send', { conversationId: CONV, channel: 'sms', body: 'On my way' });
    const out = withOwnChanges(closed, [reply], DALE);
    expect(out).toMatchObject({
      status: 'open',
      lastPreview: 'On my way',
      lastDirection: 'outbound',
      lastSentBy: DALE,
      awaitingReplySince: null,
      handledBy: 'person',
      takenOverBy: DALE,
    });
    // A text sent to wait for quiet hours changes nothing until HandsFreeOS holds it.
    const later = row('message.send', {
      conversationId: CONV,
      body: 'Hi',
      sendAfterQuietHours: true,
    });
    expect(withOwnChanges(closed, [later], DALE).status).toBe('closed');
  });

  it('takes over and hands back', () => {
    const c = conversationOf(base);
    const took = withOwnChanges(c, [row('conversation.take_over', { conversationId: CONV })], DALE);
    expect(took).toMatchObject({ handledBy: 'person', takenOverBy: DALE });
    const back = withOwnChanges(
      conversationOf({ ...base, handled_by: 'person', taken_over_by: DALE.id }),
      [row('conversation.hand_to_ai', { conversationId: CONV })],
      DALE,
    );
    expect(back).toMatchObject({ handledBy: 'ai', takenOverBy: null });
  });
});

describe('replies written on this phone', () => {
  const reply = (extra: Partial<OutboxRow> = {}, input: Record<string, unknown> = {}) =>
    row(
      'message.send',
      {
        conversationId: CONV,
        channel: 'sms',
        body: 'Marco is on his way',
        clientId: 'client-1',
        ...input,
      },
      extra,
    );

  it('says where each stands', () => {
    const now = T0 + 5 * 60_000;
    expect(replyStage(reply(), false, now)).toBe('waiting');
    expect(replyStage(reply(), true, now)).toBe('sending');
    // Older than 30 minutes with no signal: it asks first.
    expect(replyStage(reply(), false, T0 + 45 * 60_000)).toBe('still-send');
    expect(replyStage(reply({ state: 'held' }), true, now)).toBe('photo');
    expect(replyStage(reply({ state: 'held' }), false, now)).toBe('waiting');
    expect(replyStage(reply({ state: 'ask', rule: 'quiet_hours' }), true, now)).toBe('quiet-hours');
    expect(replyStage(reply({ state: 'ask', rule: 'stale_action' }), true, now)).toBe('still-send');
    expect(replyStage(reply({ state: 'ask', rule: 'duplicate' }), true, now)).toBe('ask');
    expect(replyStage(reply({ state: 'refused' }), true, now)).toBe('refused');
    expect(replyStage(reply({ state: 'retry' }), true, now)).toBe('retry');
  });

  it('shows each until HandsFreeOS’s copy of it arrives, matched by its client id', () => {
    const waiting = reply();
    const through = reply(
      { state: 'sent', sent_at: new Date(T0).toISOString() },
      { clientId: 'client-2' },
    );
    const held = reply({ state: 'sent' }, { clientId: 'client-3', sendAfterQuietHours: true });
    const elsewhere = row('message.send', { conversationId: OTHER, body: 'Hi' });
    const photos = reply(
      { state: 'held' },
      { clientId: 'client-4', attachmentFileIds: ['f1', 'f2'] },
    );
    const shown = pendingReplies(
      [waiting, through, held, elsewhere, photos],
      CONV,
      new Set(['client-2']),
      false,
      T0,
    );
    // A reply sent from a notification's Reply carries no client id: once it's through, the thread has HandsFreeOS's own.
    const fromPush = reply(
      { state: 'sent', sent_at: new Date(T0).toISOString() },
      { clientId: null },
    );
    const shownWithPush = pendingReplies([waiting, fromPush], CONV, new Set(), false, T0);
    expect(shownWithPush.map((p) => p.row.id)).toEqual([waiting.id]);
    expect(shown.map((p) => p.row.id)).toEqual([waiting.id, photos.id]);
    expect(shown[0]).toMatchObject({
      stage: 'waiting',
      body: 'Marco is on his way',
      channel: 'sms',
    });
    expect(shown[0]!.goesBy).toBe(Date.parse(waiting.made_at) + 30 * 60_000);
    expect(shown[1]!.fileIds).toEqual(['f1', 'f2']);
  });

  it('words the line under each as the canvas does', () => {
    const [waiting] = pendingReplies([reply()], CONV, new Set(), false, T0);
    expect(pendingLine(waiting!, 'Mike').text).toMatch(
      /^Waiting for signal — sends by \d{1,2}:\d{2} [AP]M$/,
    );
    const [photo] = pendingReplies(
      [reply({ state: 'held' }, { attachmentFileIds: ['f1'] })],
      CONV,
      new Set(),
      true,
      T0,
    );
    expect(pendingLine(photo!, 'Mike')).toMatchObject({
      text: 'Sends once its photo is uploaded',
      action: null,
    });
    const answer = JSON.stringify({ phone: { localTime: '21:40', endsAt: '08:00', stale: false } });
    const [quiet] = pendingReplies(
      [reply({ state: 'ask', rule: 'quiet_hours', answer })],
      CONV,
      new Set(),
      true,
      T0,
    );
    expect(quietFactsOf(answer)).toEqual({ localTime: '21:40', endsAt: '08:00' });
    expect(pendingLine(quiet!, 'Mike')).toEqual({
      text: 'It’s 9:40 PM, inside quiet hours. Send now, or at 8:00 AM when quiet hours end?',
      tone: 'warning',
      action: 'Decide',
    });
    const [refused] = pendingReplies(
      [reply({ state: 'refused', reason: 'Mike texted STOP.' })],
      CONV,
      new Set(),
      true,
      T0,
    );
    expect(pendingLine(refused!, 'Mike')).toEqual({
      text: 'Not sent. Mike texted STOP.',
      tone: 'danger',
      action: 'Edit',
    });
  });

  it('leaves a held text out of the thread as soon as it’s cancelled here', () => {
    const cancel = row('message.cancel_scheduled', { messageId: 'm-held' });
    const refused = row('message.cancel_scheduled', { messageId: 'm-gone' }, { state: 'refused' });
    expect([...cancelledHere([cancel, refused])]).toEqual(['m-held']);
  });
});

describe('the thread', () => {
  const item = (id: string, occurredAt: string): ThreadItemShape =>
    ({ id, occurredAt: new Date(occurredAt).toISOString(), type: 'message' }) as ThreadItemShape;

  it('puts messages, calls and notes in order, with a divider where the day changes, and replies written here last', () => {
    const now = new Date('2026-09-17T15:00:00');
    const note = noteOf({
      id: 'n1',
      body: 'Gate code 4471',
      occurred_at: '2026-09-17T08:00:00',
      created_at: null,
      author_name: 'Dale Porter',
    });
    const [pending] = pendingReplies(
      [row('message.send', { conversationId: CONV, body: 'Coming', clientId: 'x' })],
      CONV,
      new Set(),
      true,
      T0,
    );
    const entries = threadEntries(
      [item('b', '2026-09-17T09:00:00'), item('a', '2026-09-16T09:00:00')],
      [note],
      [pending!],
      now,
    );
    expect(entries.map((e) => (e.kind === 'day' ? `day:${e.label}` : e.key))).toEqual([
      'day:Yesterday',
      'item-a',
      'day:Today',
      `note-n1`,
      'item-b',
      `pending-${pending!.row.id}`,
    ]);
  });
});

describe('Call, asked for from anywhere', () => {
  afterEach(() => callRequests.clear());

  it('is taken once, by the sheet of the business it’s for', () => {
    startCall({ conversationId: CONV }, { workspaceId: WS });
    expect(callRequests.take(OTHER)).toBeNull();
    expect(callRequests.take(WS)).toMatchObject({
      target: { conversationId: CONV },
      workspaceId: WS,
    });
    expect(callRequests.take(WS)).toBeNull();
    // Without a business, the one on screen takes it.
    startCall({ personId: 'p1' });
    expect(callRequests.take(OTHER)).toMatchObject({ target: { personId: 'p1' } });
  });

  it('asking again is a new request, and one nobody took for a minute is dropped', () => {
    startCall({ personId: 'p1' });
    const first = callRequests.current();
    startCall({ personId: 'p1' });
    expect(callRequests.current()!.seq).toBe(first!.seq + 1);
    expect(callRequests.take(WS, Date.now() + CALL_REQUEST_KEPT_MS + 1)).toBeNull();
    expect(callRequests.current()).toBeNull();
  });
});
