/**
 * The inbox from a phone's own copy (M10): synced rows turned into what the inbox's words take, the list's boxes,
 * order and counts as `inbox.list` and `inbox.summary` work them out, what phones hide from a thread, drafts, and
 * where a call's recording is kept.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_LINES_WORDS,
  bridgeOver,
  CALL_SHEET_WORDS,
  callRecordingFolder,
  callRecordingPath,
  recordingFileIn,
  callSheetWords,
  cellVerifiedOn,
  CONTACT_CARD_WORDS,
  conversationOf,
  groupByCustomer,
  hiddenCall,
  hiddenMessage,
  inboxCounts,
  inboxOrder,
  inInbox,
  mailMoves,
  MY_CELL_WORDS,
  teammateDraftOf,
  telephonySettingsOf,
  threadItemsOf,
  type CallThreadRow,
  type ConversationListRow,
  type MessageThreadRow,
} from '../src/index';

const ME = 'u-dale';

const conv = (over: Partial<ConversationListRow> = {}): ConversationListRow => ({
  id: 'c-mike',
  channel: 'sms',
  counterpart: '+17135550142',
  status: 'open',
  person_id: 'p-mike',
  first_name: 'Mike',
  last_name: 'Johnson',
  assignee_user_id: null,
  assignee_name: null,
  unread_count: 0,
  last_message_at: '2026-09-17 12:30:00.000Z',
  last_preview: 'Is Marco still coming? It’s 84 in the house.',
  last_direction: 'inbound',
  last_sender_id: null,
  last_sender_name: null,
  awaiting_reply_since: null,
  snoozed_until: null,
  created_at: '2026-09-01T10:00:00Z',
  handled_by: 'none',
  ai_teammate_id: null,
  teammate_name: null,
  needs_person_since: null,
  handoff_reason: null,
  handoff_note: null,
  taken_over_by: null,
  taken_over_name: null,
  ...over,
});

describe('conversations from the copy', () => {
  it('turns a synced row into the list’s shape', () => {
    const c = conversationOf(
      conv({
        assignee_user_id: ME,
        assignee_name: 'Dale Porter',
        last_direction: 'outbound',
        last_sender_id: ME,
        last_sender_name: 'Dale Porter',
        lead_id: 'l1',
        lead_title: 'AC replacement',
        lead_stage_name: 'Quoted',
        lead_value_cents: '850000',
      }),
    );
    expect(c).toMatchObject({
      counterpartDisplay: '(713) 555-0142',
      person: { id: 'p-mike', fullName: 'Mike Johnson' },
      assignee: { id: ME, fullName: 'Dale Porter' },
      lastMessageAt: '2026-09-17T12:30:00.000Z',
      lastSentBy: { id: ME, fullName: 'Dale Porter' },
      openLead: { id: 'l1', title: 'AC replacement', stageName: 'Quoted', valueCents: 850000 },
      onSiteNow: false,
    });
    expect(conversationOf(conv({ channel: 'chat', person_id: null })).counterpartDisplay).toBe(
      'Website visitor',
    );
    expect(
      conversationOf(conv({ assignee_user_id: 'u-gone', assignee_name: null })).assignee,
    ).toEqual({ id: 'u-gone', fullName: 'Former member' });
  });

  it('keeps each box to its conversations, and searches names, numbers and messages', () => {
    const all = [
      conv({ id: 'a', assignee_user_id: ME }),
      conv({ id: 'b', assignee_user_id: 'u-marco' }),
      conv({
        id: 'c',
        person_id: null,
        first_name: null,
        last_name: null,
        counterpart: '+17135550168',
        handled_by: 'ai',
        ai_teammate_id: 't1',
        teammate_name: 'Ava',
      }),
      conv({ id: 'd', status: 'snoozed', snoozed_until: '2026-09-18T13:00:00Z' }),
      conv({ id: 'e', needs_person_since: '2026-09-17T12:00:00Z' }),
      conv({ id: 'f', last_message_at: null }),
    ].map(conversationOf);
    const ids = (
      box: Parameters<typeof inInbox>[1]['box'],
      status: 'open' | 'snoozed' = 'open',
      q?: string,
    ) => all.filter((c) => inInbox(c, { box, status, q }, ME)).map((c) => c.id);
    expect(ids('all')).toEqual(['a', 'b', 'c', 'e']);
    expect(ids('mine')).toEqual(['a']);
    expect(ids('unassigned')).toEqual(['c', 'e']);
    expect(ids('ai')).toEqual(['c']);
    expect(ids('needs_person')).toEqual(['e']);
    expect(ids('all', 'snoozed')).toEqual(['d']);
    expect(ids('all', 'open', 'JOHNSON')).toEqual(['a', 'b', 'e']);
    expect(ids('all', 'open', '555-0168')).toEqual(['c']);
    expect(ids('all', 'open', '84 in the')).toEqual(['a', 'b', 'c', 'e']);
  });

  it('narrows any box to the ones with something unread, as `inbox.list` does', () => {
    const all = [
      conv({ id: 'a', assignee_user_id: ME, unread_count: 2 }),
      conv({ id: 'b', assignee_user_id: ME }),
      conv({ id: 'c', person_id: 'p-c', unread_count: 1 }),
      conv({ id: 'd', status: 'snoozed', snoozed_until: '2026-09-18T13:00:00Z', unread_count: 1 }),
    ].map(conversationOf);
    const ids = (box: 'mine' | 'all', status: 'open' | 'snoozed' = 'open') =>
      all.filter((c) => inInbox(c, { box, status, unread: true }, ME)).map((c) => c.id);
    expect(ids('all')).toEqual(['a', 'c']);
    expect(ids('mine')).toEqual(['a']);
    expect(ids('all', 'snoozed')).toEqual(['d']);
    // Grouped, the row stands for the customer's unread lane rather than a newer one they have read.
    const lanes = [
      conv({
        id: 'old',
        person_id: 'p-x',
        unread_count: 1,
        last_message_at: '2026-01-08T22:43:00Z',
      }),
      conv({ id: 'new', person_id: 'p-x', channel: 'email', counterpart: 'x@example.com' }),
    ].map((row) => ({ conversation: conversationOf(row) }));
    const rows = groupByCustomer(lanes, { box: 'all', status: 'open', unread: true }, ME);
    expect(rows.map((r) => [r.conversation.id, r.conversation.unreadTotal])).toEqual([['old', 1]]);
  });

  it('orders newest first, and "Needs a person" by who waited longest', () => {
    const list = [
      conv({
        id: 'x1',
        last_message_at: '2026-09-17T11:00:00Z',
        needs_person_since: '2026-09-17T09:00:00Z',
      }),
      conv({
        id: 'x2',
        last_message_at: '2026-09-17T12:00:00Z',
        needs_person_since: '2026-09-17T08:00:00Z',
      }),
      conv({
        id: 'x3',
        last_message_at: '2026-09-17T12:00:00Z',
        needs_person_since: '2026-09-17T10:00:00Z',
      }),
    ].map(conversationOf);
    expect([...list].sort(inboxOrder('all')).map((c) => c.id)).toEqual(['x3', 'x2', 'x1']);
    expect([...list].sort(inboxOrder('needs_person')).map((c) => c.id)).toEqual(['x2', 'x1', 'x3']);
  });

  it('counts the boxes as the web’s badges do', () => {
    const now = Date.parse('2026-09-17T12:40:00Z');
    // Six customers, one conversation each.
    const counts = inboxCounts(
      [
        conv({
          id: 'a',
          person_id: 'p-a',
          assignee_user_id: ME,
          unread_count: 2,
          awaiting_reply_since: '2026-09-17T12:20:00Z',
        }),
        conv({ id: 'b', person_id: 'p-b', assignee_user_id: 'u-marco' }),
        conv({
          id: 'c',
          person_id: 'p-c',
          handled_by: 'ai',
          unread_count: 1,
          awaiting_reply_since: '2026-09-17T12:35:00Z',
        }),
        conv({ id: 'd', person_id: 'p-d', needs_person_since: '2026-09-17T12:00:00Z' }),
        conv({ id: 'e', person_id: 'p-e', status: 'closed', unread_count: 4 }),
        conv({ id: 'f', person_id: 'p-f', last_message_at: null }),
      ].map(conversationOf),
      ME,
      10,
      now,
    );
    expect(counts).toEqual({
      open: { mine: 1, unassigned: 2, all: 4 },
      unread: { mine: 1, unassigned: 1, all: 2 },
      waiting: 1,
      waitingThresholdMinutes: 10,
      needsPerson: 1,
      ai: 1,
      mail: { mine: 0, other: 0, spam: 0, own: false },
    });
  });

  it('counts a customer once, however many lines they write on, as the web’s badges do (0089)', () => {
    const counts = inboxCounts(
      [
        // Mike texts and emails: one customer.
        conv({ id: 'm-sms', unread_count: 1, assignee_user_id: ME }),
        conv({ id: 'm-mail', channel: 'email', counterpart: 'mike@example.com', unread_count: 2 }),
        // An unknown number and an unknown address: nothing says they are the same person.
        conv({ id: 'n-sms', person_id: null, counterpart: '+17135550168', unread_count: 1 }),
        conv({
          id: 'n-mail',
          person_id: null,
          channel: 'email',
          counterpart: 'someone@example.com',
        }),
      ].map(conversationOf),
      ME,
      10,
    );
    expect(counts.open).toEqual({ mine: 1, unassigned: 3, all: 3 });
    expect(counts.unread).toEqual({ mine: 1, unassigned: 2, all: 2 });
  });

  it('lists each customer once, with every line of theirs and the unread across them (0089)', () => {
    const items = [
      conv({
        id: 'm-sms',
        unread_count: 1,
        last_message_at: '2026-09-17T12:00:00Z',
        line_e164: '+17135550100',
        line_label: 'Front desk',
      }),
      conv({
        id: 'm-mail',
        channel: 'email',
        counterpart: 'mike@example.com',
        unread_count: 2,
        assignee_user_id: ME,
        last_message_at: '2026-09-17T12:30:00Z',
        line_address: 'info@lonestarhvac.com',
      }),
      conv({ id: 'm-closed', status: 'closed', last_message_at: '2026-09-10T09:00:00Z' }),
      conv({
        id: 'kim',
        person_id: 'p-kim',
        first_name: 'Kim',
        last_name: 'Alvarez',
        last_message_at: '2026-09-17T11:00:00Z',
      }),
    ].map((r) => ({ conversation: conversationOf(r) }));
    const rows = (box: 'all' | 'mine' | 'unassigned', status: 'open' | 'closed' = 'open') =>
      groupByCustomer(items, { box, status }, ME).map((i) => i.conversation);

    const [mike, kim] = rows('all');
    expect(rows('all')).toHaveLength(2);
    // The newest open lane stands for Mike, carrying every lane of his, closed ones included.
    expect(mike!.id).toBe('m-mail');
    expect(mike!.lanes!.map((l) => [l.id, l.lineDisplay])).toEqual([
      ['m-mail', 'info@lonestarhvac.com'],
      ['m-sms', 'Front desk · (713) 555-0100'],
      ['m-closed', 'Text'],
    ]);
    expect(mike!.unreadTotal).toBe(3);
    expect(kim!.lanes).toHaveLength(1);
    // The filter runs on threads first: "Unassigned" is Mike's text, not his assigned email.
    expect(rows('unassigned').map((c) => c.id)).toEqual(['m-sms', 'kim']);
    expect(rows('mine').map((c) => c.id)).toEqual(['m-mail']);
    expect(rows('all', 'closed').map((c) => c.id)).toEqual(['m-closed']);
  });

  it('keeps Other mail, Spam and the viewer’s own mail to their own boxes, as `inbox.list` does (M19)', () => {
    const mail = { channel: 'email', person_id: null, first_name: null, last_name: null };
    const all = [
      conv({ id: 'text' }),
      conv({ ...mail, id: 'old-copy', counterpart: 'kim@example.com', folder: null }),
      conv({ ...mail, id: 'other', counterpart: 'deals@shop.example', folder: 'other' }),
      conv({ ...mail, id: 'spam', counterpart: 'win@prize.example', folder: 'spam' }),
      conv({ ...mail, id: 'own', counterpart: 'mom@example.com', private_to: ME }),
      conv({
        ...mail,
        id: 'own-other',
        counterpart: 'news@example.com',
        private_to: ME,
        folder: 'other',
      }),
      conv({
        ...mail,
        id: 'own-spam',
        counterpart: 'x@spam.example',
        private_to: ME,
        folder: 'spam',
      }),
      // Someone else's own mail never reaches this phone, and would be in no box if it did.
      conv({ ...mail, id: 'theirs', counterpart: 'a@example.com', private_to: 'u-marco' }),
    ].map(conversationOf);
    expect(all.find((c) => c.id === 'own')).toMatchObject({
      folder: 'inbox',
      privateTo: ME,
      private: true,
    });
    expect(all.find((c) => c.id === 'old-copy')).toMatchObject({
      folder: 'inbox',
      privateTo: null,
      private: false,
    });
    const ids = (box: Parameters<typeof inInbox>[1]['box'], mailbox?: 'team' | 'mine') =>
      all.filter((c) => inInbox(c, { box, status: 'open', mailbox }, ME)).map((c) => c.id);
    expect(ids('all')).toEqual(['text', 'old-copy']);
    expect(ids('unassigned', 'team')).toEqual(['text', 'old-copy']);
    expect(ids('other')).toEqual(['other']);
    expect(ids('spam')).toEqual(['spam']);
    expect(ids('all', 'mine')).toEqual(['own']);
    expect(ids('other', 'mine')).toEqual(['own-other']);
    expect(ids('spam', 'mine')).toEqual(['own-spam']);
    // Grouped, a box still means its folder: the stranger's Other mail isn't a row in the Inbox.
    const items = all.map((conversation) => ({ conversation }));
    expect(
      groupByCustomer(items, { box: 'all', status: 'open', mailbox: 'mine' }, ME).map(
        (i) => i.conversation.id,
      ),
    ).toEqual(['own']);
  });

  it('counts Other mail, Spam and the viewer’s own mail apart from the team’s badges, as `inbox.summary` does (M19)', () => {
    const mail = { channel: 'email', person_id: null, first_name: null, last_name: null };
    const rows = [
      conv({ id: 'a', person_id: 'p-a', unread_count: 1 }),
      // Other mail: unread ones count, one by one, however many a sender has.
      conv({
        ...mail,
        id: 'o1',
        counterpart: 'deals@shop.example',
        folder: 'other',
        unread_count: 2,
      }),
      conv({
        ...mail,
        id: 'o2',
        counterpart: 'deals@shop.example',
        folder: 'other',
        unread_count: 1,
      }),
      conv({ ...mail, id: 'o3', counterpart: 'news@shop.example', folder: 'other' }),
      // Spam: every open one, read or not.
      conv({ ...mail, id: 's1', counterpart: 'win@prize.example', folder: 'spam' }),
      conv({
        ...mail,
        id: 's2',
        counterpart: 'win@prize.example',
        folder: 'spam',
        status: 'closed',
      }),
      // The viewer's own Inbox: unread ones.
      conv({ ...mail, id: 'm1', counterpart: 'mom@example.com', private_to: ME, unread_count: 3 }),
      conv({ ...mail, id: 'm2', counterpart: 'bank@example.com', private_to: ME }),
      conv({
        ...mail,
        id: 'm3',
        counterpart: 'list@example.com',
        private_to: ME,
        folder: 'other',
        unread_count: 1,
      }),
    ].map(conversationOf);
    const counts = inboxCounts(rows, ME, 10);
    expect(counts.open).toEqual({ mine: 0, unassigned: 1, all: 1 });
    expect(counts.unread).toEqual({ mine: 0, unassigned: 1, all: 1 });
    expect(counts.mail).toEqual({ mine: 1, other: 2, spam: 1, own: true });
    // My mail shows for someone with an address of their own before any mail has come to it, and for nobody else.
    const team = rows.filter((c) => !c.private);
    expect(inboxCounts(team, ME, 10).mail.own).toBe(false);
    expect(inboxCounts(team, ME, 10, Date.now(), true).mail.own).toBe(true);
  });

  it('offers the other folders, and for the team’s mail the same with the sender remembered (M19)', () => {
    expect(mailMoves('inbox', false).map((m) => [m.folder, m.remember, m.label])).toEqual([
      ['other', false, 'Move to Other mail'],
      ['spam', false, 'Move to Spam'],
      ['other', true, 'Always put their mail in Other mail'],
      ['spam', true, 'Always put their mail in Spam'],
    ]);
    expect(mailMoves('other', false).map((m) => m.label)).toEqual([
      'Move to Inbox',
      'Move to Spam',
      'Always put their mail in the Inbox',
      'Always put their mail in Spam',
    ]);
    // Out of Spam, "Not spam" puts it in Other mail; someone's own mail moves one thread at a time.
    expect(mailMoves('spam', true)).toEqual([
      { folder: 'other', remember: false, label: 'Not spam' },
      { folder: 'inbox', remember: false, label: 'Move to Inbox' },
    ]);
  });

  it('reads the business’s texting settings, with the defaults for what isn’t set', () => {
    expect(telephonySettingsOf(null)).toEqual({
      quietHours: { enabled: true, start: '20:00', end: '08:00' },
      unansweredReminderMinutes: 10,
    });
    expect(
      telephonySettingsOf(JSON.stringify({ telephony: { unansweredReminderMinutes: 15 } }))
        .unansweredReminderMinutes,
    ).toBe(15);
  });
});

const message = (over: Partial<MessageThreadRow> = {}): MessageThreadRow => ({
  id: 'm1',
  conversation_id: 'c-mike',
  channel: 'sms',
  direction: 'outbound',
  status: 'delivered',
  from_address: null,
  to_addresses: null,
  cc_addresses: null,
  subject: null,
  body_text: 'Marco can be there at 9:00.',
  media: null,
  error_code: null,
  error_message: null,
  sent_by: 'u-priya',
  sent_by_name: 'Priya Shah',
  sent_by_teammate_id: null,
  approved_by: null,
  client_id: null,
  occurred_at: '2026-09-17T12:12:00Z',
  delivered_at: '2026-09-17T12:12:03Z',
  ...over,
});

const call = (over: Partial<CallThreadRow> = {}): CallThreadRow => ({
  id: 'k1',
  conversation_id: 'c-mike',
  direction: 'inbound',
  from_e164: '+17135550142',
  to_e164: '+17135550100',
  status: 'completed',
  answered_via: null,
  answered_by_user_id: null,
  placed_by: null,
  started_at: '2026-09-17T10:05:00Z',
  answered_at: null,
  ended_at: '2026-09-17T10:06:00Z',
  duration_seconds: 40,
  is_voicemail: 1,
  recording_seconds: 18,
  transcript: 'Hi, this is Mike Johnson on Oak Hollow.',
  ...over,
});

describe('a thread from the copy', () => {
  it('hides what the web’s thread hides: a cancelled held text, and a call through a cell nobody pressed 1 on', () => {
    expect(hiddenMessage({ error_code: 'cancelled' })).toBe(true);
    expect(hiddenMessage({ error_code: 'scheduled' })).toBe(false);
    expect(hiddenCall({ answered_via: 'bridge', answered_by_user_id: null })).toBe(true);
    expect(hiddenCall({ answered_via: 'bridge', answered_by_user_id: ME })).toBe(false);
    expect(hiddenCall({ answered_via: null, answered_by_user_id: null })).toBe(false);
  });

  it('says which lane each item is on, for "All lines" to name its line (0089)', () => {
    const [text, mail] = threadItemsOf(
      [
        message({ id: 'm1', conversation_id: 'c-text', occurred_at: '2026-09-17T12:00:00Z' }),
        message({
          id: 'm2',
          conversation_id: 'c-mail',
          channel: 'email',
          direction: 'inbound',
          occurred_at: '2026-09-17T12:30:00Z',
        }),
      ],
      [],
    );
    expect([text!.conversationId, mail!.conversationId]).toEqual(['c-text', 'c-mail']);
    expect(ALL_LINES_WORDS.line('outbound', 'Front desk · (713) 555-0100')).toBe(
      'From Front desk · (713) 555-0100',
    );
    expect(ALL_LINES_WORDS.line('inbound', 'info@lonestarhvac.com')).toBe(
      'To info@lonestarhvac.com',
    );
  });

  it('puts messages and calls in order, with a held text’s time and a voicemail’s words', () => {
    const items = threadItemsOf(
      [
        message(),
        message({
          id: 'm0',
          direction: 'inbound',
          sent_by: null,
          sent_by_name: null,
          body_text: 'Is Marco still coming?',
          occurred_at: '2026-09-17T12:10:00Z',
        }),
        message({
          id: 'm2',
          status: 'queued',
          error_code: 'scheduled',
          occurred_at: '2026-09-18T13:00:00Z',
        }),
        message({ id: 'm3', error_code: 'cancelled', status: 'failed' }),
        message({
          id: 'm4',
          sent_by: null,
          sent_by_teammate_id: 't1',
          teammate_name: 'Ava',
          approved_by: 'u-priya',
          approved_name: 'Priya Shah',
          client_id: 'handoff:abc',
          media: JSON.stringify([
            {
              bucket: 'attachments',
              objectPath: 'ws/p/photo.jpg',
              contentType: 'image/jpeg',
              sizeBytes: 1200,
              name: 'photo.jpg',
            },
          ]),
          occurred_at: '2026-09-17T12:20:00Z',
        }),
      ],
      [call(), call({ id: 'k2', answered_via: 'bridge', direction: 'outbound', is_voicemail: 0 })],
    );
    expect(items.map((i) => i.id)).toEqual(['k1', 'm0', 'm1', 'm4', 'm2']);
    expect(items[0]).toMatchObject({
      type: 'call',
      isVoicemail: true,
      hasRecording: true,
      recordingSeconds: 18,
    });
    expect(items.find((i) => i.id === 'm2')?.scheduledFor).toBe('2026-09-18T13:00:00.000Z');
    expect(items.find((i) => i.id === 'm4')).toMatchObject({
      teammate: { id: 't1', name: 'Ava' },
      approvedBy: { id: 'u-priya', fullName: 'Priya Shah' },
      handoffLine: true,
      media: [{ name: 'photo.jpg', bucket: 'attachments' }],
    });
  });

  it('reads RCS from the copy: how a text went, when it was read, what it carried, and the button a reply came from', () => {
    const picture = {
      bucket: 'attachments',
      objectPath: 'ws/p/tune-up.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 900,
      name: 'tune-up.jpg',
    };
    const [sent, tapped, odd] = threadItemsOf(
      [
        message({
          status: 'read',
          transport: 'rcs',
          read_at: '2026-09-17 12:14:00.000Z',
          rich: JSON.stringify({
            kind: 'carousel',
            title: null,
            buttons: [],
            cards: [
              {
                title: 'Tune-up',
                body: '$89 this week',
                media: picture,
                buttons: [{ type: 'reply', title: 'Book it', id: 'm1.c0.b0' }],
              },
            ],
            smsText: 'Marco can be there at 9:00.\n\nReply 1 for Book it.',
          }),
        }),
        message({
          id: 'm5',
          direction: 'inbound',
          sent_by: null,
          sent_by_name: null,
          body_text: 'Book it',
          transport: 'rcs',
          button_reply: JSON.stringify({
            type: 'reply',
            title: 'Book it',
            id: 'm1.c0.b0',
            messageId: 'm1',
            via: 'tap',
          }),
          occurred_at: '2026-09-17T12:15:00Z',
        }),
        // Not what the server writes: an ordinary text rather than a thread that won't open.
        message({
          id: 'm6',
          transport: 'fax',
          rich: '{"kind":"hologram"}',
          button_reply: 'not json',
          occurred_at: '2026-09-17T12:16:00Z',
        }),
      ],
      [],
    );
    expect(sent).toMatchObject({
      transport: 'rcs',
      readAt: '2026-09-17T12:14:00.000Z',
      rich: {
        kind: 'carousel',
        title: null,
        buttons: [],
        cards: [{ title: 'Tune-up', media: picture, buttons: [{ title: 'Book it' }] }],
        smsText: 'Marco can be there at 9:00.\n\nReply 1 for Book it.',
      },
      buttonReply: null,
    });
    expect(tapped).toMatchObject({
      direction: 'inbound',
      rich: null,
      buttonReply: { type: 'reply', title: 'Book it', via: 'tap' },
    });
    expect(odd).toMatchObject({ transport: null, readAt: null, rich: null, buttonReply: null });
  });
});

describe('drafts from the copy', () => {
  it('reads a waiting draft’s preview, and who may decide it', () => {
    const row = {
      id: 'd1',
      teammate_id: 't1',
      teammate_name: 'Ava',
      conversation_id: 'c1',
      channel: 'sms',
      person_id: 'p1',
      first_name: 'Angela',
      last_name: 'Brooks',
      lead_id: null,
      kind: 'reply',
      status: 'pending',
      preview: JSON.stringify({
        message: { channel: 'sms', body: 'Thursday works.', subject: null },
        actions: [
          {
            kind: 'reschedule',
            appointmentId: 'a1',
            startsAt: '2026-09-24T19:00:00Z',
            summary: 'Move Thu tune-up to 2:00 PM',
          },
          { kind: 'mystery' },
        ],
        discount: null,
      }),
      edits: null,
      expires_at: '2026-09-17T13:00:00Z',
      created_at: '2026-09-17T12:48:00Z',
    };
    expect(teammateDraftOf(row, { canManage: false })).toMatchObject({
      kind: 'reply',
      teammate: { name: 'Ava' },
      person: { fullName: 'Angela Brooks' },
      preview: {
        message: { body: 'Thursday works.', subject: null },
        actions: [{ kind: 'reschedule', summary: 'Move Thu tune-up to 2:00 PM' }],
      },
      canDecide: true,
    });
    expect(teammateDraftOf({ ...row, kind: 'approval' }, { canManage: false }).canDecide).toBe(
      false,
    );
    expect(teammateDraftOf({ ...row, kind: 'approval' }, { canManage: true }).canDecide).toBe(true);
  });
});

describe('calls', () => {
  it('keeps a call’s recording where the worker stores it', () => {
    expect(callRecordingFolder('ws1', 'k1')).toBe('ws1/calls/k1');
    expect(callRecordingPath('ws1', 'k1', 'voicemail', 'mp3')).toBe('ws1/calls/k1/voicemail.mp3');
    expect(recordingFileIn(['voicemail.wav'], true)).toBe('voicemail.wav');
    expect(recordingFileIn(['recording.mp3'], true)).toBeNull();
    expect(recordingFileIn(['recording.mp3', 'x.txt'], false)).toBe('recording.mp3');
  });

  it('words the call sheet', () => {
    const words = callSheetWords({
      status: 'calling_cell',
      customerName: 'Mike Johnson',
      cell: '+15125550142',
      callerId: '+17135550100',
      businessName: 'Lone Star HVAC & Roofing',
    });
    expect(words).toEqual({
      hint: 'Answer to be connected to Mike Johnson.',
      cellLabel: 'Your cell',
      cell: '(512) 555-0142',
      seesLabel: 'Mike sees',
      sees: 'Lone Star HVAC & Roofing’s number, (713) 555-0100',
    });
    expect(
      callSheetWords({
        status: 'cell_unanswered',
        customerName: '(713) 555-0168',
        cell: null,
        callerId: null,
        businessName: 'X',
      }).seesLabel,
    ).toBe('They see');
    expect(bridgeOver('calling_customer')).toBe(false);
    expect(bridgeOver('customer_busy')).toBe(true);
    expect(CALL_SHEET_WORDS.needsSignal).toBe('This needs signal.');
  });

  it('words My cell phone and the contacts card', () => {
    expect(cellVerifiedOn(new Date(2026, 8, 21, 16, 10).toISOString())).toBe(
      'Verified Mon, Sep 21',
    );
    expect(MY_CELL_WORDS.calling('+15125550142')).toBe(
      'We’ll call (512) 555-0142. Press 1 when you answer.',
    );
    expect(MY_CELL_WORDS.callsFrom('Lone Star HVAC & Roofing', '+17135550100')).toBe(
      'The call comes from Lone Star HVAC & Roofing’s number, (713) 555-0100. It only proves the phone is yours.',
    );
    expect(CONTACT_CARD_WORDS.contactLine('+17135550100')).toBe(
      '(713) 555-0100 · the contact it adds',
    );
  });
});
