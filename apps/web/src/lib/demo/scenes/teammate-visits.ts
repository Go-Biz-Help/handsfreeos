import { businessOf, wallTime, type DemoWorld } from '../world';
import { idsFor } from './ask-kit';
import { clock, conversationIn, openConversation, shortDay, startConversation } from './kit';
import {
  APPROVED,
  approveDraft,
  customerSays,
  draftReply,
  NEW_MESSAGE,
  newPerson,
  regular,
  teammateSays,
} from './teammate-kit';
import type { DemoScene } from './types';

/**
 * The AI teammate keeps the calendar full: a missed call texted back and booked (12), a photo asked for before
 * anyone drives out (13), a visit the customer moves (14), and a cancelled time the waitlist fills (16).
 */

const DAY = 24 * 3600_000;
const VISIT_CHANGED = ['message', 'conversation', 'appointment', 'activity'] as const;

/** A teammate past its training, replying on its own. */
const automatic = (w: DemoWorld) => {
  w.teammateAutomatic = true;
};

// ------------------------------------------------------------------------------------------------ 12. missed call

const s12 = idsFor(12);
const HANNAH = s12(1);
const HANNAH_CALL = s12(2);

export const missedCall: DemoScene = {
  id: 'missed-call',
  number: 12,
  title: 'A missed call gets a text back',
  kind: 'teammate',
  startsOn: 'inbox',
  setup: automatic,
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'You’re up a ladder on a roof with both hands busy, and your phone starts ringing. There’s no way you’re picking up.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Hannah calls, and nobody picks up',
      voiceover:
        'It’s Hannah, someone you’ve never worked with. On most days, that’s a missed call, and she calls the next company on Google.',
      change: (w, at) => {
        startConversation(w, at, {
          id: HANNAH,
          person: newPerson(s12(3), 'Hannah', 'Pierce', 1204, 'Sugar Land'),
          firstId: HANNAH_CALL,
          body: '',
          call: { status: 'missed', answeredByAi: false, seconds: null, transcript: null },
        });
      },
      live: ['conversation', 'message', 'call'],
      run: async (p) => {
        await openConversation(p, HANNAH);
        await p.point(`@call-${HANNAH_CALL}`);
      },
    },
    {
      label: 'Seconds later, it texts her back',
      voiceover:
        'Not today. Seconds after the call, your AI teammate texts her in your business’s name: sorry we missed you, how can we help?',
      change: (w, at) => {
        conversationIn(w, HANNAH).unread = 0;
        teammateSays(w, HANNAH, {
          id: s12(11),
          at,
          body: `Hi, this is ${w.state.teammate} with ${businessOf(w)}. Sorry we missed your call! Our techs are out on jobs right now. How can we help?`,
        });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s12(11)}`),
    },
    {
      label: 'Hannah says her AC is blowing warm',
      voiceover:
        'Hannah writes back. Her AC is blowing warm air, and it’s getting hot in the house.',
      change: (w, at) => {
        customerSays(w, HANNAH, {
          id: s12(12),
          at,
          body: 'Hi! Our AC is blowing warm air and it’s already 84 in here. Can someone come take a look?',
        });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s12(12)}`),
    },
    {
      label: 'It offers two times from your calendar',
      voiceover:
        'Your teammate is sorry about the heat, and offers two real openings from your calendar.',
      change: (w, at) => {
        teammateSays(w, HANNAH, {
          id: s12(13),
          at,
          body: 'So sorry, Hannah, that’s no fun in this heat! We can come tomorrow at 9:00 AM or 1:00 PM. Which works better?',
        });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s12(13)}`),
    },
    {
      label: 'Hannah picks 9:00 AM',
      voiceover: 'She takes the morning.',
      change: (w, at) => {
        customerSays(w, HANNAH, { id: s12(14), at, body: '9 please! Thank you so much.' });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s12(14)}`),
    },
    {
      label: 'It books the visit and tells her',
      voiceover:
        'And it books her. The visit is on your calendar, Hannah knows when you’re coming, and you never came down off the ladder. A missed call turned into a booked job.',
      change: (w, at) => {
        const starts = wallTime(at, w.state.timeZone, 1, 9);
        teammateSays(w, HANNAH, {
          id: s12(15),
          at,
          body: 'You’re all set for tomorrow at 9:00 AM, Hannah. Our tech will text you when they’re on the way. Stay cool till then!',
        });
        conversationIn(w, HANNAH).visits.push({
          id: s12(21),
          title: 'AC repair',
          startsAt: starts,
          minutes: 90,
          bookedAt: at,
        });
      },
      live: VISIT_CHANGED,
      run: async (p) => {
        await p.waitFor(`@message-${s12(15)}`);
        await p.point('@context-panel');
      },
    },
  ],
};

// ------------------------------------------------------------------------------------------ 13. send me a photo

const s13 = idsFor(13);
const DEREK = s13(1);
const PHOTO_TEXT = s13(13);

export const sendAPhoto: DemoScene = {
  id: 'send-a-photo',
  number: 13,
  title: '“Send me a photo of it”',
  kind: 'teammate',
  startsOn: 'inbox',
  setup: automatic,
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'Some problems are hard to describe in a text. Your AI teammate knows when a picture will save everyone a trip.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Derek texts: water under his water heater',
      voiceover:
        'Derek, a new customer, finds water pooling under his water heater. He doesn’t know where it’s coming from.',
      change: (w, at) => {
        startConversation(w, at, {
          id: DEREK,
          person: newPerson(s13(2), 'Derek', 'Lowe', 1307, 'Katy'),
          firstId: s13(11),
          body: 'Hey, there’s water pooling under my water heater in the garage. Not sure where it’s coming from. Can someone take a look?',
        });
      },
      live: NEW_MESSAGE,
      run: (p) => openConversation(p, DEREK),
    },
    {
      label: 'It asks for a photo',
      voiceover:
        'Before anyone drives out, your teammate asks for a photo, including the pipes on the side. That way the tech brings the right parts.',
      change: (w, at) => {
        conversationIn(w, DEREK).unread = 0;
        teammateSays(w, DEREK, {
          id: s13(12),
          at,
          body: `Hi Derek, this is ${w.state.teammate} with ${businessOf(w)}. Sorry about the water! Could you text me a photo of the water heater, with the pipes on the side in it? That helps us bring the right parts.`,
        });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s13(12)}`),
    },
    {
      label: 'Derek sends the photo',
      voiceover: 'A minute later, Derek sends the picture.',
      change: (w, at) => {
        customerSays(w, DEREK, {
          id: PHOTO_TEXT,
          at,
          body: 'Here you go',
          media: [
            {
              name: 'IMG_4127.jpg',
              contentType: 'image/svg+xml',
              path: '/demo/water-heater-leak.svg',
              sizeBytes: 412_000,
            },
          ],
        });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`[data-testid="message-${PHOTO_TEXT}"] [data-testid="media-thumb"]`),
    },
    {
      label: 'Open the photo',
      voiceover:
        'Here’s what Derek sent. The drip is coming down the pipe from the valve on the side of the tank.',
      run: async (p) => {
        await p.click(`[data-testid="message-${PHOTO_TEXT}"] [data-testid="media-thumb"]`);
        await p.waitFor('@photo-viewer');
        await p.wait(1500);
        await p.click('[data-testid="photo-viewer"] button:last-of-type');
      },
    },
    {
      label: 'It reads the photo and offers a time',
      voiceover:
        'Your teammate saw it too. It tells Derek the relief valve is the likely culprit, that it’s a quick fix, and offers a time tomorrow. The photo stays right here on his conversation, so whoever goes out has seen it before they get there.',
      change: (w, at) => {
        teammateSays(w, DEREK, {
          id: s13(14),
          at,
          body: 'Thanks, Derek! It looks like the water is coming from the relief valve pipe on the side of the tank. That usually means the valve needs replacing, which is a quick fix. We can come tomorrow at 10:00 AM. Does that work?',
        });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s13(14)}`),
    },
  ],
};

// ----------------------------------------------------------------------------------------- 14. move my visit

const s14 = idsFor(14);
const PAULA = s14(1);
const PAULA_VISIT = s14(21);
const MOVE = s14(31);

export const moveMyVisit: DemoScene = {
  id: 'move-my-visit',
  number: 14,
  title: 'A customer moves their own visit',
  kind: 'teammate',
  startsOn: 'inbox',
  // Booked two days ago for tomorrow afternoon.
  setup: (w, at) => {
    const booked = at - 2 * DAY;
    const starts = wallTime(at, w.state.timeZone, 1, 14);
    w.conversations.unshift({
      id: PAULA,
      person: regular(newPerson(s14(2), 'Paula', 'Brennan', 1411, 'Bellaire'), at, 3),
      createdAt: booked,
      unread: 0,
      messages: [
        {
          id: s14(11),
          at: booked,
          direction: 'inbound',
          body: 'Hi, can I get my AC tuned up this week?',
        },
        {
          id: s14(12),
          at: booked + 60_000,
          direction: 'outbound',
          teammate: true,
          approved: true,
          body: `Hi Paula! You’re booked for an AC tune-up on ${shortDay(starts, w.state.timeZone)} at 2:00 PM. See you then!`,
        },
      ],
      drafts: [],
      visits: [
        { id: PAULA_VISIT, title: 'AC tune-up', startsAt: starts, minutes: 60, bookedAt: booked },
      ],
    });
  },
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'Paula, a longtime customer, has an AC tune-up booked for tomorrow afternoon. Then her plans change.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Paula asks for the morning instead',
      voiceover:
        'She texts: can we do the morning instead? Usually that’s a phone call and five minutes in your calendar.',
      change: (w, at) => {
        customerSays(w, PAULA, {
          id: s14(13),
          at,
          body: 'Hi! Something came up tomorrow afternoon. Can we do the morning instead?',
        });
        conversationIn(w, PAULA).unread = 1;
      },
      live: NEW_MESSAGE,
      run: (p) => openConversation(p, PAULA),
    },
    {
      label: 'It finds an open morning',
      voiceover:
        'Your AI teammate finds 9:00 AM open and writes back. While it’s still in training, it asks you first. The line above the text says exactly what approving does: it moves her visit.',
      change: (w, at) => {
        conversationIn(w, PAULA).unread = 0;
        draftReply(w, PAULA, {
          id: MOVE,
          at,
          inReplyTo: s14(13),
          body: 'No problem, Paula! I’ve moved your AC tune-up to tomorrow at 9:00 AM. You’ll get a new confirmation in a moment.',
          action: {
            kind: 'reschedule',
            visitId: PAULA_VISIT,
            startsAt: wallTime(at, w.state.timeZone, 1, 9),
            summary: 'Move her AC tune-up to tomorrow at 9:00 AM',
          },
        });
      },
      live: ['ai_teammate_draft', 'conversation'],
      run: async (p) => {
        await p.waitFor('@draft-card');
        await p.point('@draft-action');
      },
    },
    {
      label: 'Approve: the visit moves',
      voiceover: 'One tap. The visit moves on your calendar, and Paula gets the new time.',
      change: (w, at) => {
        approveDraft(w, PAULA, MOVE, s14(14), at);
        const v = conversationIn(w, PAULA).visits[0]!;
        v.startsAt = wallTime(at, w.state.timeZone, 1, 9);
      },
      live: [...APPROVED, 'appointment', 'activity'],
      run: async (p) => {
        await p.click('@draft-approve');
        await p.waitFor(`@message-${s14(14)}`);
        await p.point('@context-panel');
      },
    },
    {
      label: 'Paula says thanks',
      voiceover: 'Paula’s happy, and nobody had to pick up the phone.',
      change: (w, at) => {
        customerSays(w, PAULA, { id: s14(15), at, body: 'Perfect, thank you!' });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s14(15)}`),
    },
  ],
};

// ------------------------------------------------------------------------------------- 16. a cancellation fills

const s16 = idsFor(16);
const MARK = s16(1);
const TARA = s16(2);
const MARK_VISIT = s16(21);
const OFFER = s16(15);
const BOOKED = s16(16);
const OFFER_LINK = 'https://app.handsfreeos.com/w/8mXq2vLt';
const MANAGE_LINK = 'https://app.handsfreeos.com/m/3hTn6pWd';

/** "CST", as the booking texts write the zone. */
const shortZone = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(ms))
    .find((x) => x.type === 'timeZoneName')?.value ?? '';

export const cancellationFills: DemoScene = {
  id: 'cancellation-fills',
  number: 16,
  title: 'A cancellation fills itself',
  kind: 'teammate',
  startsOn: 'inbox',
  setup: (w, at) => {
    automatic(w);
    const tz = w.state.timeZone;
    const starts = wallTime(at, tz, 1, 9);
    const booked = at - 5 * DAY;
    const waited = at - 6 * DAY;
    // Tara asked for something sooner last week, and went on the waitlist.
    w.conversations.unshift({
      id: TARA,
      person: newPerson(s16(4), 'Tara', 'Lindqvist', 1622, 'West University'),
      createdAt: waited,
      unread: 0,
      messages: [
        {
          id: s16(11),
          at: waited,
          direction: 'inbound',
          body: 'Do you have anything sooner for a furnace tune-up? Next week is the first opening I see.',
        },
        {
          id: s16(12),
          at: waited + 60_000,
          direction: 'outbound',
          teammate: true,
          body: 'Nothing sooner right now, Tara, but I’ve put you on the waitlist. If an earlier time opens up, we’ll text you right away.',
        },
      ],
      drafts: [],
      visits: [],
    });
    w.conversations.unshift({
      id: MARK,
      person: regular(newPerson(s16(3), 'Mark', 'Haddad', 1618, 'Meyerland'), at),
      createdAt: booked,
      unread: 0,
      messages: [
        {
          id: s16(13),
          at: booked,
          direction: 'outbound',
          teammate: true,
          body: `You’re booked for a furnace tune-up on ${shortDay(starts, tz)} at 9:00 AM, Mark. See you then!`,
        },
      ],
      drafts: [],
      visits: [
        {
          id: MARK_VISIT,
          title: 'Furnace tune-up',
          startsAt: starts,
          minutes: 60,
          bookedAt: booked,
        },
      ],
    });
  },
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'Tomorrow at nine you have a furnace tune-up booked for Mark. And Tara has been waiting for an earlier time since last week.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Mark cancels tomorrow at 9:00 AM',
      voiceover: 'Then Mark texts. Something came up, and he has to cancel.',
      change: (w, at) => {
        customerSays(w, MARK, {
          id: s16(14),
          at,
          body: 'Hi, I have to cancel my appointment tomorrow morning. Work thing came up, sorry!',
        });
        const c = conversationIn(w, MARK);
        c.unread = 1;
        // Newest at the top.
        w.conversations.splice(w.conversations.indexOf(c), 1);
        w.conversations.unshift(c);
      },
      live: NEW_MESSAGE,
      run: (p) => openConversation(p, MARK),
    },
    {
      label: 'It cancels and says no problem',
      voiceover:
        'Your AI teammate cancels the visit and tells Mark no problem. Normally that’s an empty hour on your schedule and money you don’t make.',
      change: (w, at) => {
        const c = conversationIn(w, MARK);
        c.unread = 0;
        teammateSays(w, MARK, {
          id: s16(17),
          at,
          body: 'No problem, Mark. Your furnace tune-up tomorrow at 9:00 AM is cancelled. Text us whenever you’d like a new time.',
        });
        c.visits[0]!.cancelled = true;
      },
      live: VISIT_CHANGED,
      run: (p) => p.point(`@message-${s16(17)}`),
    },
    {
      label: 'Tara, first on the waitlist, gets the time',
      voiceover:
        'But the moment that time opens, HandsFreeOS texts the first person on the waitlist. That’s Tara. The slot is held for her for an hour.',
      change: (w, at) => {
        const tz = w.state.timeZone;
        const starts = wallTime(at, tz, 1, 9);
        const c = conversationIn(w, TARA);
        c.messages.push({
          id: OFFER,
          at,
          direction: 'outbound',
          body: `${businessOf(w)}: A time opened on ${shortDay(starts, tz)} at 9:00 AM (Furnace tune-up). It's held for you until ${clock(at + 3600_000, tz)}: ${OFFER_LINK}`,
        });
        w.conversations.splice(w.conversations.indexOf(c), 1);
        w.conversations.unshift(c);
      },
      live: NEW_MESSAGE,
      run: async (p) => {
        await p.click(`@conversation-row-${TARA}`);
        await p.waitFor(`@message-${OFFER}`);
        await p.point(`@message-${OFFER}`);
      },
    },
    {
      label: 'Tara takes it',
      voiceover:
        'Tara taps the link and takes it. She’s booked, she gets her confirmation, and your morning is full again. You didn’t make a single call.',
      change: (w, at) => {
        const tz = w.state.timeZone;
        const starts = wallTime(at, tz, 1, 9);
        const c = conversationIn(w, TARA);
        c.messages.push({
          id: BOOKED,
          at,
          direction: 'outbound',
          body: `${businessOf(w)}: You're booked for ${shortDay(starts, tz)} at 9:00 AM ${shortZone(starts, tz)} (Furnace tune-up). Change or cancel: ${MANAGE_LINK}`,
        });
        c.visits.push({
          id: s16(22),
          title: 'Furnace tune-up',
          startsAt: starts,
          minutes: 60,
          bookedAt: at,
        });
      },
      live: VISIT_CHANGED,
      run: async (p) => {
        await p.waitFor(`@message-${BOOKED}`);
        await p.point(`@message-${BOOKED}`);
        await p.wait(800);
        await p.point('@context-panel');
      },
    },
  ],
};

export const TEAMMATE_VISIT_SCENES: readonly DemoScene[] = [
  missedCall,
  sendAPhoto,
  moveMyVisit,
  cancellationFills,
];
