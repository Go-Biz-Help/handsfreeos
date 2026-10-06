import {
  CONVERSATION_DONE,
  conversationOf,
  threadChannelLine,
  threadItemsOf,
  type ConversationListRow,
  type MessageThreadRow,
  type ThreadItemShape,
} from '@hfos/core';

import { change } from '@/changes';
import { FakePowerSync } from '@/changes/__tests__/fake-powersync';
import type { ChangeOptions } from '@/changes/controller';
import type { OutboxRow } from '@/changes/outbox';
import { pendingLine, quietFactsOf } from '@/components/inbox/pending-reply';
import { toast } from '@/components/ui/toast';

import { conversationActions } from '../actions';
import { CALL_REQUEST_KEPT_MS, callRequests, startCall } from '../calls';
import {
  cancelledHere,
  forgetMovedHere,
  markMovedHere,
  pendingReplies,
  replyStage,
  withMovedHere,
  withOwnChanges,
} from '../outbox';
import { CONVERSATIONS_SQL, MESSAGES_SQL, OWN_ADDRESS_SQL } from '../queries';
import { FROM_ADDRESS_SQL } from '../use-email';
import { noteOf, threadEntries } from '../thread-entries';

// A change made here writes its optimistic rows to the phone's copy (real SQLite) and waits for signal.
let mockCopy: FakePowerSync;
jest.mock('@/changes', () => ({
  change: jest.fn(async (_name: string, _input: unknown, options?: ChangeOptions) => {
    await mockCopy.writeTransaction(async (tx) => {
      await options?.optimistic?.(tx);
    });
    return { id: 'change-1', queued: true };
  }),
}));

/**
 * The inbox on the phone: a conversation as this phone's own changes leave it, the replies written here that the thread
 * shows until HandsFreeOS sends them back, the thread's order with its day dividers, Call asked for from anywhere, and
 * email's folders and someone's own mail (M19): what the list reads, the From address, moving and sharing.
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
    // A Messenger or Instagram reply waits as itself, never as a text.
    const [instagram] = pendingReplies(
      [reply({}, { clientId: 'client-5', channel: 'instagram' })],
      CONV,
      new Set(),
      false,
      T0,
    );
    expect(instagram).toMatchObject({ channel: 'instagram', extras: null });
  });

  it('says in a few words what goes with a text: its buttons, card or carousel (RCS)', () => {
    const shown = pendingReplies(
      [
        reply(
          {},
          {
            clientId: 'r-1',
            rich: {
              kind: 'buttons',
              buttons: [
                { type: 'reply', title: 'Confirm' },
                { type: 'reply', title: 'Reschedule' },
              ],
            },
          },
        ),
        reply({}, { clientId: 'r-2', rich: { kind: 'card', title: 'Tune-up: $89', buttons: [] } }),
        reply(
          {},
          { clientId: 'r-3', rich: { kind: 'carousel', cards: [{ body: 'A' }, { body: 'B' }] } },
        ),
        // Buttons go with texts only.
        reply({}, { clientId: 'r-4', channel: 'email', rich: { kind: 'buttons', buttons: [] } }),
        reply({}, { clientId: 'r-5', rich: { kind: 'hologram' } }),
        reply({}, { clientId: 'r-6' }),
      ],
      CONV,
      new Set(),
      false,
      T0,
    );
    expect(shown.map((p) => p.extras)).toEqual([
      '2 buttons',
      'Card',
      'Carousel of 2',
      null,
      null,
      null,
    ]);
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

  it('cancelled here, a held text leaves the thread and a failed one tried again goes back, not delivered', async () => {
    mockCopy = new FakePowerSync();
    const morning = '2026-09-18T13:00:00.000Z';
    const failedAt = '2026-09-17T14:05:00.000Z';
    const insert = (id: string, body: string, failedAttempt: object | null) =>
      mockCopy.execute(
        `INSERT INTO messages (id, workspace_id, conversation_id, channel, direction, status, body_text, media,
           error_code, error_message, occurred_at, failed_attempt)
         VALUES (?, ?, ?, 'sms', 'outbound', 'queued', ?, '[]', 'scheduled', NULL, ?, ?)`,
        [id, WS, CONV, body, morning, failedAttempt ? JSON.stringify(failedAttempt) : null],
      );
    await insert('m-new', 'See you at 8', null);
    await insert('m-retry', 'Your filter came in', {
      status: 'undelivered',
      errorCode: '30003',
      errorMessage: 'The carrier turned it away.',
      occurredAt: failedAt,
    });
    // The thread as useThread reads it: the phone's copy, less held texts cancelled here.
    const thread = async (outbox: OutboxRow[] = []) =>
      threadItemsOf(
        await mockCopy.getAll<MessageThreadRow>(MESSAGES_SQL, [WS, JSON.stringify([CONV])]),
        [],
      ).filter((i) => !(i.scheduledFor && cancelledHere(outbox).has(i.id)));
    expect((await thread()).map((i) => [i.id, i.scheduledFor])).toEqual([
      ['m-new', morning],
      ['m-retry', morning],
    ]);

    const show = jest.spyOn(toast, 'show').mockImplementation(() => 1);
    const actions = conversationActions({
      workspaceId: WS,
      conversationId: CONV,
      myUserId: DALE.id,
    });
    expect(await actions.cancelHeld('m-new')).toBe(true);
    expect(show).toHaveBeenLastCalledWith(CONVERSATION_DONE.heldCancelled);
    expect(await actions.cancelHeld('m-retry')).toBe(true);
    expect(show).toHaveBeenLastCalledWith(CONVERSATION_DONE.retryCancelled);
    show.mockRestore();

    // At once, with no signal: the new one is gone, and the retry is back where it was, as it was.
    const cancels = ['m-new', 'm-retry'].map((messageId) =>
      row('message.cancel_scheduled', { messageId }),
    );
    expect(await thread(cancels)).toEqual([
      expect.objectContaining({
        id: 'm-retry',
        occurredAt: failedAt,
        status: 'undelivered',
        errorCode: '30003',
        errorMessage: 'The carrier turned it away.',
        scheduledFor: null,
      }),
    ]);
    expect(
      await mockCopy.getOptional('SELECT failed_attempt FROM messages WHERE id = ?', ['m-retry']),
    ).toEqual({ failed_attempt: null });
  });

  it('sends a text that didn’t go out again, once however often it’s tapped, and says when a held one goes', async () => {
    const show = jest.spyOn(toast, 'show').mockImplementation(() => 1);
    const error = jest.spyOn(toast, 'error').mockImplementation(() => 1);
    const actions = conversationActions({
      workspaceId: WS,
      conversationId: CONV,
      myUserId: DALE.id,
    });
    const retries = () =>
      jest.mocked(change).mock.calls.filter(([name]) => name === 'message.retry');
    const before = retries().length;

    let answer: (value: unknown) => void = () => undefined;
    jest.mocked(change).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }) as never,
    );
    const first = actions.retry('m-failed', 'Mike', 'America/Chicago');
    // A second tap before HandsFreeOS answers sends nothing more.
    expect(await actions.retry('m-failed', 'Mike', 'America/Chicago')).toBe(false);
    answer({ id: 'x', queued: false, output: { messageId: 'm-failed' } });
    expect(await first).toBe(true);
    expect(retries().slice(before)).toEqual([
      ['message.retry', { workspaceId: WS, messageId: 'm-failed' }],
    ]);
    expect(show).toHaveBeenLastCalledWith(CONVERSATION_DONE.retrying);

    // In quiet hours it waits for them to end, on the business's clock.
    jest.mocked(change).mockResolvedValueOnce({
      id: 'x',
      queued: false,
      output: { messageId: 'm-failed', scheduledFor: '2026-09-18T13:00:00.000Z' },
    } as never);
    expect(await actions.retry('m-failed', 'Mike', 'America/Chicago')).toBe(true);
    expect(show).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Held\. It goes to Mike .*8:00 AM, when quiet hours end\./),
    );

    // Refused, or no signal: the words say why, and it can be tapped again.
    const still = 'This message is still on its way, so there’s nothing to send again yet.';
    jest.mocked(change).mockRejectedValueOnce(new Error(still));
    expect(await actions.retry('m-failed', 'Mike', 'America/Chicago')).toBe(false);
    expect(error).toHaveBeenLastCalledWith(still);
    expect(retries().length - before).toBe(3);
    show.mockRestore();
    error.mockRestore();
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

describe('email’s folders and someone’s own mail (M19)', () => {
  const ME = DALE.id;
  const thread = (
    id: string,
    over: { folder?: string | null; privateTo?: string | null; address?: string | null } = {},
  ) =>
    mockCopy.execute(
      `INSERT INTO conversations (id, workspace_id, channel, counterpart, status, unread_count, last_message_at,
         created_at, folder, private_to, email_address_id)
       VALUES (?, ?, 'email', ?, 'open', 1, '2026-09-17T12:30:00.000Z', '2026-09-17T12:00:00.000Z', ?, ?, ?)`,
      [
        id,
        WS,
        `${id}@example.com`,
        over.folder === undefined ? 'inbox' : over.folder,
        over.privateTo ?? null,
        over.address ?? null,
      ],
    );
  const address = (id: string, owner: string | null, isDefault = false) =>
    mockCopy.execute(
      `INSERT INTO email_addresses (id, workspace_id, address, is_default, owner_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, WS, `${id}@lonestarhvac.com`, isDefault ? 1 : 0, owner, '2026-09-01T12:00:00.000Z'],
    );

  beforeEach(() => {
    mockCopy = new FakePowerSync();
    forgetMovedHere();
  });

  it('lists the team’s threads and the person’s own, in their folders, and never anyone else’s', async () => {
    await thread('team');
    await thread('before-folders', { folder: null });
    await thread('deals', { folder: 'other' });
    await thread('prize', { folder: 'spam' });
    await thread('mine', { privateTo: ME });
    await thread('marcos', { privateTo: MARCO });
    const rows = await mockCopy.getAll<ConversationListRow>(CONVERSATIONS_SQL, [WS, ME]);
    expect(
      rows
        .map(conversationOf)
        .map((c) => [c.id, c.folder, c.privateTo, c.private])
        .sort(),
    ).toEqual([
      ['before-folders', 'inbox', null, false],
      ['deals', 'other', null, false],
      ['mine', 'inbox', ME, true],
      ['prize', 'spam', null, false],
      ['team', 'inbox', null, false],
    ]);
    // My mail shows for someone with an address of their own, before any mail has come to it.
    await address('dale', ME);
    expect(await mockCopy.getAll(OWN_ADDRESS_SQL, [WS, ME])).toEqual([{ own: 1 }]);
    expect(await mockCopy.getAll(OWN_ADDRESS_SQL, [WS, MARCO])).toEqual([{ own: 0 }]);
  });

  it('answers someone’s own mail from its own address, and the team’s only from the team’s', async () => {
    await address('office', null, true);
    await address('sales', null);
    await address('dale', ME);
    await address('marco', MARCO);
    await thread('own', { privateTo: ME, address: 'dale' });
    await thread('sales-thread', { address: 'sales' });
    // Shared with the team from someone's own mail: the team answers from a team address, even its owner.
    await thread('shared-by-dale', { address: 'dale' });
    await thread('shared-by-marco', { address: 'marco' });
    const from = async (conversationId: string) =>
      mockCopy.getAll<{ id: string; own: number }>(FROM_ADDRESS_SQL, [conversationId, WS]);
    expect(await from('own')).toMatchObject([{ id: 'dale', own: 1 }]);
    expect(await from('sales-thread')).toMatchObject([{ id: 'sales', own: 0 }]);
    expect(await from('shared-by-dale')).toMatchObject([{ id: 'office', own: 0 }]);
    expect(await from('shared-by-marco')).toMatchObject([{ id: 'office', own: 0 }]);
    // Writing to a customer from a text thread, or a thread not on this phone: the business's default.
    expect(await from('not-here')).toMatchObject([{ id: 'office', own: 0 }]);
  });

  it('moves a thread online, shows it moved at once, and says so', async () => {
    const show = jest.spyOn(toast, 'show').mockImplementation(() => 1);
    const error = jest.spyOn(toast, 'error').mockImplementation(() => 1);
    const actions = conversationActions({ workspaceId: WS, conversationId: CONV, myUserId: ME });
    const mail = conversationOf({ ...base, channel: 'email', counterpart: 'mike@example.com' });

    jest.mocked(change).mockResolvedValueOnce({
      id: 'x',
      queued: false,
      output: { conversationId: CONV, folder: 'spam', changed: true },
    } as never);
    expect(await actions.move('spam')).toBe(true);
    expect(change).toHaveBeenLastCalledWith('conversation.move', {
      workspaceId: WS,
      conversationId: CONV,
      folder: 'spam',
      remember: false,
    });
    expect(show).toHaveBeenLastCalledWith('Moved to Spam.');
    // Until the synced row arrives, and not a moment longer.
    expect(withMovedHere(mail).folder).toBe('spam');
    expect(withMovedHere({ ...mail, folder: 'spam' }).folder).toBe('spam');
    expect(withMovedHere(mail).folder).toBe('inbox');

    jest.mocked(change).mockResolvedValueOnce({
      id: 'x',
      queued: false,
      output: { conversationId: CONV, folder: 'other', changed: false },
    } as never);
    expect(await actions.move('other')).toBe(false);
    expect(show).toHaveBeenLastCalledWith(CONVERSATION_DONE.alreadyThere);

    jest.mocked(change).mockResolvedValueOnce({
      id: 'x',
      queued: false,
      output: { conversationId: CONV, folder: 'inbox', changed: true },
    } as never);
    expect(await actions.move('inbox', true)).toBe(true);
    expect(show).toHaveBeenLastCalledWith(
      'Moved to the Inbox. Their next email lands in the Inbox too.',
    );

    // Refused, or no signal: the words say why, and nothing moves.
    jest
      .mocked(change)
      .mockRejectedValueOnce(
        new Error(
          'Where a sender’s mail goes is the team’s to remember, so it can’t be saved from your own mailbox.',
        ),
      );
    expect(await actions.move('spam', true)).toBe(false);
    expect(error).toHaveBeenLastCalledWith(
      'Where a sender’s mail goes is the team’s to remember, so it can’t be saved from your own mailbox.',
    );
    show.mockRestore();
    error.mockRestore();
  });

  it('shares someone’s own mail with the team, out of My mail at once', async () => {
    const show = jest.spyOn(toast, 'show').mockImplementation(() => 1);
    const actions = conversationActions({ workspaceId: WS, conversationId: CONV, myUserId: ME });
    jest.mocked(change).mockResolvedValueOnce({
      id: 'x',
      queued: false,
      output: { conversationId: CONV, personId: null },
    } as never);
    expect(await actions.share()).toBe(true);
    expect(change).toHaveBeenLastCalledWith('conversation.share', {
      workspaceId: WS,
      conversationId: CONV,
    });
    expect(show).toHaveBeenLastCalledWith(CONVERSATION_DONE.shared);
    const own = conversationOf({
      ...base,
      channel: 'email',
      person_id: null,
      private_to: ME,
    });
    expect(withMovedHere(own)).toMatchObject({ privateTo: null, private: false });
    // A move made here stands a minute at most, since someone may have moved it again since.
    markMovedHere(OTHER, { folder: 'other' }, Date.now() - 61_000);
    expect(withMovedHere({ ...own, id: OTHER }).folder).toBe('inbox');
    show.mockRestore();
  });
});

describe('a client’s portal thread (round six)', () => {
  const ANN = '33333333-3333-4333-8333-333333333333';
  const DEAL = '44444444-4444-4444-8444-444444444444';
  const GONE = '55555555-5555-4555-8555-555555555555';
  const portal = (id: string, record: string | null) =>
    mockCopy.execute(
      `INSERT INTO conversations (id, workspace_id, channel, counterpart, person_id, status, unread_count,
         last_message_at, created_at)
       VALUES (?, ?, 'portal', ?, ?, 'open', 1, '2026-10-01T15:31:00.000Z', '2026-10-01T15:00:00.000Z')`,
      [id, WS, record ? `portal:${ANN}:${record}` : `portal:${ANN}`, ANN],
    );

  beforeEach(async () => {
    mockCopy = new FakePowerSync();
    await mockCopy.execute(
      'INSERT INTO people (id, workspace_id, first_name, last_name) VALUES (?, ?, ?, ?)',
      [ANN, WS, 'Ann', 'Smith'],
    );
    await mockCopy.execute(
      'INSERT INTO custom_records (id, workspace_id, type_id, name) VALUES (?, ?, ?, ?)',
      [DEAL, WS, 'deal-kind', 'Smith purchase'],
    );
  });

  it('reads as Portal with its deal’s name when the phone keeps the deal, and the client’s name always', async () => {
    await portal('with-deal', DEAL);
    await portal('deal-not-here', GONE);
    await portal('no-deal-yet', null);
    const rows = await mockCopy.getAll<ConversationListRow>(CONVERSATIONS_SQL, [WS, DALE.id]);
    const byId = new Map(rows.map((r) => [r.id, conversationOf(r)]));
    const withDeal = byId.get('with-deal')!;
    expect(withDeal).toMatchObject({
      channel: 'portal',
      counterpartDisplay: 'Ann Smith',
      record: { id: DEAL, name: 'Smith purchase' },
      lineDisplay: 'Client portal · Smith purchase',
    });
    expect(threadChannelLine(withDeal, null, { compact: true })).toBe('Portal · Smith purchase');
    expect(byId.get('deal-not-here')!.record).toBeNull();
    expect(threadChannelLine(byId.get('deal-not-here')!, null, { compact: true })).toBe('Portal');
    expect(byId.get('no-deal-yet')!.record).toBeNull();
  });

  it('keeps a reply written here as a portal reply, and asks after 30 minutes as for any reply', () => {
    const waiting = row('message.send', {
      conversationId: CONV,
      channel: 'portal',
      body: 'I’ll send you the draft tonight to look over.',
      clientId: 'portal-1',
    });
    const [shown] = pendingReplies([waiting], CONV, new Set(), false, T0 + 45 * 60_000);
    expect(shown).toMatchObject({ channel: 'portal', stage: 'still-send' });
    expect(pendingLine(shown!, 'Ann')).toEqual({
      text: 'A reply that waits more than 30 minutes checks with you first.',
      tone: 'warning',
      action: 'Still send?',
    });
  });
});
