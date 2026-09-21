/**
 * The inbox's logic and words (M10), which the web and the phone app both show: times, the list's rows and chips,
 * a thread's items, the composer, a conversation's banners, the AI teammate's words and drafts, and calls.
 */
import { describe, expect, it } from 'vitest';
import {
  approvedToast,
  boxLabel,
  callCardWords,
  callLogWords,
  canTextOf,
  closedBanner,
  composerPlaceholder,
  CONVERSATION_DONE,
  conversationChips,
  crossChannelCanText,
  dayDivider,
  decideRefusal,
  deliveryStateOf,
  deliveryWords,
  draftActionLine,
  draftShort,
  draftTitle,
  emailNote,
  emailStatusLine,
  expiresLine,
  handBackQuestion,
  handedLine,
  handlingView,
  handoffWhy,
  handoverNote,
  heldLine,
  heldWhen,
  inboxEmptyWords,
  keywordLine,
  listTime,
  notCustomerBanner,
  previewLine,
  progressShort,
  quietQuestion,
  quietStrip,
  segmentCounterLabel,
  senderOf,
  snoozedBanner,
  snoozeOptions,
  takeOverToast,
  teammateLabel,
  textFailureHelp,
  textNote,
  threadChannelLine,
  THREAD_WORDS,
  waitingFor,
  zonedWhen,
  type CallLogRowFacts,
  type DraftFacts,
  type RowFacts,
  type ThreadItemFacts,
} from '../src/index';

const TZ = 'America/Chicago';
const ME = 'u-dale';

describe('times', () => {
  it('says how long a customer has waited', () => {
    expect(waitingFor(0)).toBe('just now');
    expect(waitingFor(10, { capital: true })).toBe('Waiting 10 min');
    expect(waitingFor(125)).toBe('waiting 2 h');
    expect(waitingFor(60 * 50, { short: true })).toBe('2 d');
  });

  it('puts a time on a row: today, yesterday, this week, then the date', () => {
    const now = new Date(2026, 8, 17, 11, 0);
    expect(listTime(new Date(2026, 8, 17, 10, 24).toISOString(), now)).toBe('10:24 AM');
    expect(listTime(new Date(2026, 8, 17, 0, 5).toISOString(), now)).toBe('12:05 AM');
    expect(listTime(new Date(2026, 8, 16, 18, 0).toISOString(), now)).toBe('Yesterday');
    expect(listTime(new Date(2026, 8, 14, 9, 0).toISOString(), now)).toBe('Mon');
    expect(listTime(new Date(2026, 8, 3, 9, 0).toISOString(), now)).toBe('Sep 3');
    expect(listTime(new Date(2025, 11, 30, 9, 0).toISOString(), now)).toBe('Dec 30, 2025');
    expect(listTime(null, now)).toBe('');
  });

  it('divides a thread by day', () => {
    const now = new Date(2026, 8, 17, 11, 0);
    expect(dayDivider(new Date(2026, 8, 17, 7, 0).toISOString(), now)).toBe('Today');
    expect(dayDivider(new Date(2026, 8, 16, 7, 0).toISOString(), now)).toBe('Yesterday');
    expect(dayDivider(new Date(2026, 8, 14, 7, 0).toISOString(), now)).toBe('Monday');
    expect(dayDivider(new Date(2026, 8, 9, 7, 0).toISOString(), now)).toBe(
      'Wednesday, September 9',
    );
    expect(dayDivider(new Date(2025, 8, 9, 7, 0).toISOString(), now)).toBe(
      'Tuesday, September 9, 2025',
    );
  });

  it('says when a held text goes, in plain spaces', () => {
    const now = new Date(2026, 8, 16, 21, 40);
    expect(heldWhen(new Date(2026, 8, 16, 23, 0).toISOString(), now)).toBe('at 11:00 PM');
    expect(heldWhen(new Date(2026, 8, 17, 8, 0).toISOString(), now)).toBe('tomorrow at 8:00 AM');
    expect(heldWhen(new Date(2026, 8, 19, 8, 0).toISOString(), now)).toBe('Saturday at 8:00 AM');
  });

  it('reads snooze times where the business is', () => {
    // 3:10 PM in Chicago on Thursday, September 17.
    const now = new Date('2026-09-17T20:10:00Z');
    expect(zonedWhen(new Date('2026-09-17T21:10:00Z'), TZ, now)).toBe('4:10 PM');
    expect(zonedWhen(new Date('2026-09-18T13:00:00Z'), TZ, now)).toBe('Fri 8:00 AM');
    expect(snoozeOptions(TZ, now).map((o) => [o.key, o.label, o.when])).toEqual([
      ['1h', 'In 1 hour', '4:10 PM'],
      ['3h', 'In 3 hours', '6:10 PM'],
      ['tomorrow', 'Tomorrow morning', 'Fri 8:00 AM'],
      ['next_week', 'Next week', 'Mon 8:00 AM'],
    ]);
  });
});

const row = (over: Partial<RowFacts> = {}): RowFacts => ({
  channel: 'sms',
  counterpartDisplay: '(713) 555-0142',
  status: 'open',
  person: { id: 'p-mike', fullName: 'Mike Johnson' },
  unreadCount: 0,
  lastMessageAt: '2026-09-17T12:30:00.000Z',
  lastPreview: 'Is Marco still coming?',
  lastDirection: 'inbound',
  lastSentBy: null,
  awaitingReplySince: null,
  snoozedUntil: null,
  openLead: null,
  handledBy: 'none',
  teammate: null,
  needsPersonSince: null,
  onSiteNow: false,
  ...over,
});

describe('the list', () => {
  it('labels the boxes with their counts', () => {
    expect(boxLabel('mine', 3)).toBe('Mine · 3');
    expect(boxLabel('unassigned', 2)).toBe('Unassigned · 2');
    expect(boxLabel('all', 9)).toBe('All · 9');
  });

  it('previews the latest message, naming who on the team sent it', () => {
    expect(previewLine(row(), ME)).toBe('Is Marco still coming?');
    const sent = row({
      lastDirection: 'outbound',
      lastPreview: 'On my way.',
      lastSentBy: { id: 'u-marco', fullName: 'Marco Diaz' },
    });
    expect(previewLine(sent, ME)).toBe('Marco: On my way.');
    expect(previewLine({ ...sent, lastSentBy: { id: ME, fullName: 'Dale' } }, ME)).toBe(
      'You: On my way.',
    );
    expect(previewLine(row({ lastMessageAt: null }), ME)).toBe('No messages yet');
  });

  it('shows what needs attention under a row, in order', () => {
    const now = Date.parse('2026-09-17T12:40:00Z');
    const chips = (over: Partial<RowFacts>, draftWaiting = false) =>
      conversationChips(row(over), { waitThreshold: 10, draftWaiting, timeZone: TZ, now }).map(
        (c) => `${c.kind}:${c.label}`,
      );
    expect(chips({ awaitingReplySince: '2026-09-17T12:30:00Z' })).toEqual(['wait:Waiting 10 min']);
    expect(chips({ awaitingReplySince: '2026-09-17T12:35:00Z' })).toEqual([]);
    expect(
      chips(
        {
          handledBy: 'ai',
          teammate: { name: 'Ava' },
          person: null,
          counterpartDisplay: '(713) 555-0168',
        },
        true,
      ),
    ).toEqual(['ai:Ava · draft waiting', 'new_number:New number']);
    expect(
      chips({
        needsPersonSince: '2026-09-17T12:17:00Z',
        awaitingReplySince: '2026-09-17T12:00:00Z',
      }),
    ).toEqual(['needs_person:Needs a person', 'wait:Waiting 23 min']);
    expect(chips({ openLead: { stageName: 'Quoted' } })).toEqual(['stage:Quoted']);
    expect(chips({ status: 'snoozed', snoozedUntil: '2026-09-18T13:00:00Z' })).toEqual([
      'snoozed:Snoozed until Fri 8:00 AM',
    ]);
    expect(chips({ status: 'closed', awaitingReplySince: '2026-09-17T11:00:00Z' })).toEqual([
      'closed:Closed',
    ]);
    // A website chat is never a "new number".
    expect(chips({ channel: 'chat', person: null, onSiteNow: true })).toEqual([
      'on_site:On the site now',
    ]);
  });

  it('says why a list is empty', () => {
    expect(inboxEmptyWords('all', 'open', 'duct', 'Ava').title).toBe('Nothing matches “duct”');
    expect(inboxEmptyWords('mine', 'open', '', 'Ava').title).toBe('Nothing waiting on you');
    expect(inboxEmptyWords('ai', 'open', '', 'Ava')).toEqual({
      title: 'Ava isn’t handling anything right now',
      body: 'Conversations Ava answers show here, until someone takes one over.',
    });
    expect(inboxEmptyWords('all', 'snoozed', '', 'Ava').title).toBe('Nothing snoozed');
  });
});

const item = (over: Partial<ThreadItemFacts> = {}): ThreadItemFacts => ({
  type: 'message',
  id: 'm1',
  occurredAt: '2026-09-17T12:30:00.000Z',
  direction: 'outbound',
  status: 'delivered',
  channel: 'sms',
  body: 'Marco can be there at 9:00.',
  subject: null,
  fromAddress: null,
  media: [],
  sentBy: { id: 'u-priya', fullName: 'Priya Shah' },
  errorCode: null,
  errorMessage: null,
  durationSeconds: null,
  isVoicemail: false,
  answeredVia: null,
  answeredBy: null,
  scheduledFor: null,
  teammate: null,
  approvedBy: null,
  aiDraftId: null,
  handoffLine: false,
  ...over,
});

describe('a thread', () => {
  it('says where a reply is, and who sent it', () => {
    expect(deliveryWords(deliveryStateOf('queued'))).toBe('Sending…');
    expect(deliveryWords(deliveryStateOf('delivered'))).toBe('Delivered');
    expect(deliveryWords(deliveryStateOf('delivered'), true)).toBe('Seen');
    expect(deliveryWords(deliveryStateOf('undelivered'))).toBe('Not delivered');
    expect(deliveryWords(deliveryStateOf('received'))).toBeNull();
    expect(senderOf(item()).label).toBe('Priya');
    expect(senderOf(item({ sentBy: null })).label).toBe('HandsFreeOS');
    expect(
      senderOf(
        item({
          sentBy: null,
          teammate: { id: 't1', name: 'Ava' },
          approvedBy: { id: 'u-priya', fullName: 'Priya Shah' },
        }),
      ).label,
    ).toBe('Ava (AI) · approved by Priya');
  });

  it('explains a text that didn’t arrive', () => {
    expect(textFailureHelp({ errorCode: '30006', errorMessage: null })).toBe(
      'This number can’t receive texts. It may be a landline.',
    );
    expect(textFailureHelp({ errorCode: null, errorMessage: null })).toBe(
      'The carrier didn’t deliver this text.',
    );
  });

  it('notes a customer texting STOP or START', () => {
    expect(keywordLine({ direction: 'inbound', body: 'STOP' }, 'Mike')).toEqual({
      kind: 'stop',
      text: 'Mike opted out of texts',
    });
    expect(keywordLine({ direction: 'inbound', body: 'start' }, null)?.text).toBe(
      'This number opted back in to texts',
    );
    expect(keywordLine({ direction: 'outbound', body: 'STOP' }, 'Mike')).toBeNull();
  });

  it('says when a held text goes', () => {
    const now = new Date(2026, 8, 16, 21, 40);
    expect(
      heldLine(
        { sentBy: { id: ME, fullName: 'Dale Porter' } },
        new Date(2026, 8, 17, 8, 0).toISOString(),
        now,
      ),
    ).toBe('Dale · Sends tomorrow at 8:00 AM, when quiet hours end');
  });

  it('words an email’s state', () => {
    expect(emailStatusLine({ status: 'bounced', errorMessage: null })).toEqual({
      bad: true,
      text: 'Bounced: it could not be delivered',
    });
    expect(emailStatusLine({ status: 'complained', errorMessage: null }).text).toBe(
      'Marked as spam',
    );
    expect(emailStatusLine({ status: 'sent', errorMessage: null })).toEqual({
      bad: false,
      text: 'Sent',
    });
  });

  it('words calls and voicemails, a call through someone’s cell included', () => {
    const call = (over: Partial<ThreadItemFacts>) =>
      callCardWords(item({ type: 'call', channel: null, body: null, sentBy: null, ...over }));
    expect(call({ isVoicemail: true, direction: 'inbound' })).toMatchObject({
      kind: 'voicemail',
      title: 'Missed call · left a voicemail',
    });
    expect(call({ direction: 'inbound', status: 'no_answer' })).toMatchObject({
      title: 'Missed call',
      icon: 'missed',
      tone: 'warning',
      length: null,
    });
    expect(
      call({
        direction: 'outbound',
        status: 'completed',
        answeredVia: 'bridge',
        durationSeconds: 134,
        sentBy: { id: ME, fullName: 'Dale Porter' },
      }),
    ).toMatchObject({
      title: 'Dale called',
      detail: 'from their cell, showing the business number',
      icon: 'outgoing',
      length: '2:14',
    });
    expect(
      call({
        direction: 'inbound',
        status: 'completed',
        answeredVia: 'forwarding',
        durationSeconds: 7,
      }),
    ).toMatchObject({
      title: 'Incoming call',
      detail: 'answered on a forwarding phone',
      length: '0:07',
    });
    expect(call({ direction: 'outbound', status: 'ringing' })).toMatchObject({
      title: 'Calling…',
      detail: 'ringing',
      live: true,
    });
  });

  /**
   * A voicemail whose audio never reached storage is the thing the business actually hit: the recording and the
   * words fail separately now that the words come from the carrier's copy, so the card has to be able to say
   * "here is what they said, and here is why you can't hear it".
   */
  it('says which of the recording and the words is missing', () => {
    const vm = (over: Partial<ThreadItemFacts>) =>
      callCardWords(
        item({
          type: 'call',
          channel: null,
          body: null,
          sentBy: null,
          isVoicemail: true,
          direction: 'inbound',
          ...over,
        }),
      ).note;
    expect(vm({ hasRecording: true, transcript: 'Hi, it’s Mike.' })).toBeNull();
    expect(vm({ hasRecording: true, transcript: null, transcriptStatus: 'pending' })).toBe(
      THREAD_WORDS.transcribing,
    );
    expect(vm({ hasRecording: true, transcript: null, transcriptStatus: 'failed' })).toBe(
      THREAD_WORDS.noWords,
    );
    expect(
      vm({ hasRecording: false, transcript: 'Hi, it’s Mike.', transcriptStatus: 'completed' }),
    ).toBe(THREAD_WORDS.wordsOnly);
    expect(vm({ hasRecording: false, transcript: null, transcriptStatus: 'pending' })).toBe(
      THREAD_WORDS.transcribing,
    );
    expect(vm({ hasRecording: false, transcript: null, transcriptStatus: 'failed' })).toBe(
      THREAD_WORDS.noWordsNoRecording,
    );
    expect(vm({ hasRecording: false, transcript: null, transcriptStatus: 'completed' })).toBe(
      THREAD_WORDS.noRecording,
    );
  });
});

/**
 * The call log, which the web and the phone both draw from these words. It exists because a call in the thread it
 * belongs to is no use to somebody who has just missed one: they go looking for the call, not the conversation.
 */
describe('the call log', () => {
  const row = (over: Partial<CallLogRowFacts> = {}): CallLogRowFacts => ({
    direction: 'inbound',
    isVoicemail: false,
    answeredVia: null,
    answeredByName: null,
    hasRecording: false,
    transcript: null,
    transcriptStatus: null,
    durationSeconds: null,
    ...over,
  });

  it('words each kind of call', () => {
    expect(callLogWords(row({ isVoicemail: true, hasRecording: true }))).toMatchObject({
      title: 'Voicemail',
      detail: 'they left a message',
      icon: 'voicemail',
      tone: 'warning',
      openable: true,
    });
    expect(callLogWords(row())).toMatchObject({
      title: 'Missed call',
      icon: 'missed',
      tone: 'warning',
      openable: false,
    });
    expect(
      callLogWords(
        row({ answeredVia: 'browser', answeredByName: 'Dale Porter', durationSeconds: 134 }),
      ),
    ).toMatchObject({ title: 'Incoming call', detail: 'Dale Porter answered', length: '2:14' });
    expect(callLogWords(row({ answeredVia: 'forwarding' }))).toMatchObject({
      detail: 'answered on a forwarding phone',
    });
    expect(
      callLogWords(row({ direction: 'outbound', answeredVia: 'bridge', hasRecording: true })),
    ).toMatchObject({
      title: 'Outgoing call',
      detail: 'from their cell, showing the business number',
      icon: 'outgoing',
      openable: true,
    });
  });

  it('opens a voicemail that has words but no audio, and says why it can’t be played', () => {
    expect(
      callLogWords(
        row({
          isVoicemail: true,
          hasRecording: false,
          transcript: 'Hi, it’s Mike. Call me back.',
          transcriptStatus: 'completed',
        }),
      ),
    ).toMatchObject({ openable: true, note: THREAD_WORDS.wordsOnly });
  });

  it('opens a voicemail with neither, rather than showing an empty row', () => {
    expect(callLogWords(row({ isVoicemail: true }))).toMatchObject({
      openable: true,
      note: THREAD_WORDS.transcribing,
    });
  });

  it('promises nothing for a plain call, so it does not open', () => {
    expect(callLogWords(row({ answeredVia: 'browser' }))).toMatchObject({
      openable: false,
      note: null,
    });
  });
});

const draft = (over: Partial<DraftFacts> = {}): DraftFacts => ({
  kind: 'reply',
  channel: 'sms',
  teammate: { id: 't1', name: 'Ava' },
  person: { fullName: 'Mike Johnson' },
  preview: {
    message: { body: 'Thursday works. I have 1:00 PM or 3:00 PM.' },
    actions: [],
    discount: null,
  },
  ...over,
});

describe('the AI teammate', () => {
  it('names what it sent and why it handed a conversation over', () => {
    expect(
      teammateLabel({
        teammate: { id: 't1', name: 'Ava' },
        approvedBy: null,
        draftId: null,
        handoffLine: true,
      }),
    ).toBe('Ava (AI) · hand-off message');
    expect(handoffWhy('cant_answer', 'Ava')).toBe('Ava couldn’t answer it from your Knowledge');
    expect(handoffWhy(null, 'Ava')).toBeNull();
    expect(
      handlingView({
        handledBy: 'ai',
        teammate: null,
        needsPersonSince: '2026-09-17T12:00:00Z',
        handoffReason: null,
        handoffNote: null,
        takenOverBy: null,
      }),
    ).toBe('needs_person');
    expect(
      handedLine('Ava', null, ME, '2026-09-17T20:10:00Z', TZ, new Date('2026-09-17T21:00:00Z')),
    ).toBe('Ava handed this to a person at 3:10 PM.');
    expect(takeOverToast('Ava', false)).toBe('It’s yours. Ava stays quiet until you hand it back.');
    expect(handBackQuestion('Ava', 'Mike').title).toBe('Hand Mike back to Ava?');
    expect(handoverNote('ai', 'Ava')).toBe(
      'Sending takes this conversation over from Ava. It stays quiet until someone hands it back.',
    );
    expect(handoverNote('person', 'Ava')).toBeNull();
  });

  it('words a draft and what deciding it did', () => {
    expect(draftTitle(draft())).toBe('Ava’s reply to Mike Johnson');
    const booking = draft({
      preview: {
        message: { body: 'See you Thursday.' },
        actions: [
          {
            kind: 'book',
            startsAt: '2026-09-24T14:00:00Z',
            summary: 'Book Thu, Sep 24 at 9:00 AM on AC tune-up',
          },
        ],
        discount: null,
      },
    });
    expect(draftTitle(booking)).toBe('Ava’s reply to Mike Johnson, with a booking');
    expect(draftShort(booking)).toBe('Ava’s reply and a booking for Thu, Sep 24 at 9:00 AM');
    expect(draftActionLine(booking.preview.actions[0]!)).toBe(
      'Will book Thu, Sep 24 at 9:00 AM on AC tune-up',
    );
    expect(
      draftTitle(
        draft({
          kind: 'approval',
          preview: { message: null, actions: [], discount: { percent: 10, reason: 'loyal' } },
        }),
      ),
    ).toBe('Ava asks to offer Mike Johnson 10% off');
    expect(expiresLine('2026-09-17T17:36:00Z', TZ, Date.parse('2026-09-17T17:00:00Z'))).toBe(
      'Expires 12:36 PM',
    );
    expect(expiresLine('2026-09-17T17:36:00Z', TZ, Date.parse('2026-09-17T18:00:00Z'))).toBe(
      'Expired',
    );
    expect(decideRefusal('draft_decided', 'Mike', 'Ava')).toBe(
      'Someone already decided this draft.',
    );
    expect(progressShort({ status: 'training', approvedCount: 17, approvalsNeeded: 20 })).toBe(
      '17 of 20 approved',
    );
    expect(
      approvedToast(
        booking,
        { status: 'training', approvedCount: 18, approvalsNeeded: 20, becameAutomatic: false },
        false,
        'Mike',
      ),
    ).toBe('Approved. Ava makes the change and texts Mike now. 18 of 20 approved.');
    expect(
      approvedToast(
        draft(),
        { status: 'training', approvedCount: 20, approvalsNeeded: 20, becameAutomatic: true },
        true,
        'Mike',
      ),
    ).toBe('Approved. That’s 20: Ava replies on its own from now on.');
  });
});

describe('the composer', () => {
  it('works out whether a text can go from what the phone knows', () => {
    const base = { hasActiveNumber: true, optedOut: false, personSmsConsent: 'unknown' };
    expect(canTextOf({ ...base, channel: 'sms' })).toEqual({ ok: true, reason: null });
    expect(canTextOf({ ...base, channel: 'email' }).reason).toBe('email_channel');
    expect(canTextOf({ ...base, channel: 'sms', hasActiveNumber: false }).reason).toBe('no_number');
    expect(canTextOf({ ...base, channel: 'sms', optedOut: true }).reason).toBe('opted_out');
    expect(canTextOf({ ...base, channel: 'sms', personSmsConsent: 'opted_out' }).reason).toBe(
      'opted_out',
    );
    expect(
      crossChannelCanText('email', { ok: false, reason: 'email_channel' }, '', '(713) 555-0100')
        .reason,
    ).toBe('no_phone');
  });

  it('says why the box is off, and what it says then', () => {
    const optedOut = textNote('opted_out', { firstName: 'Mike', offerEmail: true })!;
    expect(optedOut.parts).toEqual([
      'Texting is off for Mike. They can text ',
      { strong: 'START' },
      ' to turn it back on.',
    ]);
    expect(optedOut.placeholder).toBe('You can’t text Mike right now');
    expect(optedOut.action).toEqual({ kind: 'email', label: 'Email' });
    expect(
      textNote('not_ready', { firstName: null, inReviewSince: 'Sep 3', tollFree: false })!.parts,
    ).toEqual([
      'Texting turns on when the carriers approve your registration. In review since Sep 3, usually 1 to 3 weeks. Calls already work.',
    ]);
    expect(
      emailNote(
        { ok: false, reason: 'suppressed' },
        {
          to: 'mike@example.com',
          suppressedReason: 'bounce',
          firstName: 'Mike',
          canEditPerson: true,
        },
      ),
    ).toMatchObject({
      parts: [
        { strong: 'mike@example.com' },
        ' bounced, so we stopped sending to it. Fix the address on Mike’s record and send again.',
      ],
      action: { kind: 'edit_person', label: 'Edit Mike’s details' },
    });
    expect(
      composerPlaceholder({
        mode: 'sms',
        off: false,
        note: null,
        firstName: 'Maria',
        phoneDisplay: '',
        compact: true,
      }),
    ).toBe('Text Maria…');
    expect(
      composerPlaceholder({
        mode: 'email',
        off: false,
        note: null,
        firstName: 'Maria',
        phoneDisplay: '',
        compact: true,
      }),
    ).toBe('Reply by email…');
  });

  it('counts a text’s length and asks about quiet hours', () => {
    expect(segmentCounterLabel('')).toBe('160 characters per text');
    expect(segmentCounterLabel('Hi Mike')).toBe('7 / 160 · 1 text');
    expect(segmentCounterLabel('Hi', 2)).toBe('2 photos · 1 picture message');
    const q = { quiet: true, localTime: '21:40', endsAt: '08:00' };
    expect(quietStrip(q)).toBe('Quiet hours until 8:00 AM');
    expect(quietQuestion(q, 'Maria')).toMatchObject({
      title: 'It’s 9:40 PM, inside quiet hours',
      body: 'Send this text to Maria now, or at 8:00 AM when quiet hours end?',
      later: 'Send at 8:00 AM',
    });
  });
});

describe('a conversation', () => {
  const c = {
    channel: 'sms' as const,
    counterpart: '+17135550168',
    counterpartDisplay: '(713) 555-0168',
  };
  it('says who and how under the name, and what each banner says', () => {
    expect(threadChannelLine(c, null)).toBe('Texts · not in Customers yet');
    expect(threadChannelLine(c, { phone: '(713) 555-0142' })).toBe('(713) 555-0142 · Texts');
    expect(
      threadChannelLine({ ...c, channel: 'email', counterpart: 'mike@example.com' }, null),
    ).toBe('mike@example.com · Email');
    expect(notCustomerBanner('(713) 555-0168', 'sms').parts).toEqual([
      { strong: '(713) 555-0168 isn’t a customer yet.' },
      ' Add them, or link the number to someone you already have.',
    ]);
    expect(
      snoozedBanner('2026-09-18T13:00:00Z', 'Mike', TZ, new Date('2026-09-17T20:00:00Z')).parts,
    ).toEqual([
      'Snoozed until ',
      { strong: 'Fri 8:00 AM' },
      '. It comes back sooner if Mike writes again.',
    ]);
    expect(closedBanner('Mike').text).toBe('Closed. A new message from Mike opens it again.');
    expect(CONVERSATION_DONE.assigned('u-marco', ME, 'Marco Diaz')).toBe('Assigned to Marco');
    expect(CONVERSATION_DONE.assigned(ME, ME)).toBe('Assigned to you');
    expect(CONVERSATION_DONE.assigned(null, ME)).toBe('Unassigned');
  });
});
