import { businessOf, type DemoPerson, type DemoWebinarLead, type DemoWorld } from '../world';
import { idsFor } from './ask-kit';
import { calendarPath, DAY, halfHourBefore, MIN, openVisit } from './calendar-kit';
import { conversationIn, openConversation } from './kit';
import { customerSays, NEW_MESSAGE, newPerson, regular } from './teammate-kit';
import type { DemoScene } from './types';

/**
 * A webinar that finds buyers (44): everyone who came, scored Hot, Warm or Cold from the live poll, with the AI
 * teammate's text already out to the hot ones. And search that reads notes and messages, not just names (65).
 */

// --------------------------------------------------------------------------------- 44. a webinar that finds buyers

const s44 = idsFor(44);
const WEBINAR = s44(0x21);
const WEBINAR_CALL = s44(0x22);
const POLL = 'Free home energy check';
const TITLE = 'Cut your summer energy bill';

/** Who came, hottest first, with what the poll heard from them. */
const CAME: readonly (Omit<DemoWebinarLead, 'id' | 'person'> & {
  readonly first: string;
  readonly last: string;
  readonly city: string;
})[] = [
  {
    first: 'Jill',
    last: 'Ostrander',
    city: 'Katy',
    label: 'hot',
    points: 85,
    stayed: true,
    seconds: 1_740,
    parts: [
      { what: 'Asked for the free home energy check', points: 50 },
      { what: 'Said her AC is over 12 years old', points: 25 },
      { what: 'Stayed to the end', points: 10 },
    ],
    reason: 'Wants the energy check this month, and her AC is old enough to replace.',
    outcome: 'sent',
  },
  {
    first: 'Mateo',
    last: 'Silva',
    city: 'Cypress',
    label: 'hot',
    points: 75,
    stayed: true,
    seconds: 1_710,
    parts: [
      { what: 'Asked for the free home energy check', points: 50 },
      { what: 'Asked about financing in the chat', points: 15 },
      { what: 'Stayed to the end', points: 10 },
    ],
    reason: 'Asked about paying monthly, which people ask when they’re ready to buy.',
    outcome: 'sent',
  },
  {
    first: 'Lorraine',
    last: 'Haskins',
    city: 'Spring',
    label: 'warm',
    points: 45,
    stayed: true,
    seconds: 1_690,
    parts: [
      { what: 'Said “maybe later” to the energy check', points: 25 },
      { what: 'Stayed to the end', points: 10 },
      { what: 'Answered both questions', points: 10 },
    ],
    reason: null,
    outcome: null,
  },
  {
    first: 'Desmond',
    last: 'Achebe',
    city: 'Pearland',
    label: 'warm',
    points: 35,
    stayed: false,
    seconds: 1_080,
    parts: [
      { what: 'Said his upstairs never cools down', points: 25 },
      { what: 'Answered both questions', points: 10 },
    ],
    reason: null,
    outcome: null,
  },
  {
    first: 'Ingrid',
    last: 'Holm',
    city: 'Bellaire',
    label: 'cold',
    points: 10,
    stayed: true,
    seconds: 1_700,
    parts: [{ what: 'Stayed to the end', points: 10 }],
    reason: null,
    outcome: null,
  },
  {
    first: 'Silas',
    last: 'Grant',
    city: 'Humble',
    label: 'cold',
    points: 0,
    stayed: false,
    seconds: 420,
    parts: [],
    reason: null,
    outcome: null,
  },
];

const JILL_CHAT = s44(0x11);
const JILL_TEXT = s44(0x12);
const JILL_REPLY = s44(0x13);

const attendees = (): DemoWebinarLead[] =>
  CAME.map(({ first, last, city, ...lead }, i) => ({
    ...lead,
    id: s44(0x41 + i),
    person: newPerson(s44(1 + i), first, last, 4401 + i, city),
  }));

const jillsText = (w: DemoWorld) =>
  `Hi Jill, it’s ${w.state.teammate} with ${businessOf(w)}. Thanks for coming to today’s webinar! You asked for the free home energy check. Want to pick a time this week?`;

const webinarBuyers: DemoScene = {
  id: 'webinar-buyers',
  number: 44,
  title: 'A webinar that finds buyers',
  kind: 'app',
  startsOn: 'calendar',
  // Earlier today: a 30-minute webinar on a HandsFreeOS video call, with a live poll, over half an hour ago.
  setup: (w, at) => {
    w.teammateAutomatic = true;
    const came = attendees();
    const starts = halfHourBefore(at - 60 * MIN);
    w.visits.push({
      id: WEBINAR,
      person: came[0]!.person,
      seats: came.map((c) => c.person),
      title: TITLE,
      startsAt: starts,
      minutes: 30,
      bookedAt: at - 9 * 24 * 60 * MIN,
      source: 'booking_page',
      video: 'handsfree',
      completed: true,
      webinar: { callId: WEBINAR_CALL, poll: POLL, hot: 70, warm: 30, leads: came },
    });
    const jill = came[0]!.person;
    w.conversations.unshift({
      id: JILL_CHAT,
      person: jill,
      createdAt: starts + 32 * MIN,
      unread: 0,
      messages: [
        {
          id: JILL_TEXT,
          at: starts + 32 * MIN,
          direction: 'outbound',
          teammate: true,
          body: jillsText(w),
        },
      ],
      drafts: [],
      visits: [],
    });
  },
  steps: [
    {
      label: 'Open today’s webinar',
      voiceover:
        'Earlier today you ran a short webinar on cutting your summer energy bill, on a HandsFreeOS video call with a live poll.',
      run: async (p) => {
        await p.go(calendarPath(p, 0));
        await openVisit(p, WEBINAR);
      },
    },
    {
      label: 'Who came, and for how long',
      voiceover: 'It kept who came, and how long each of them stayed.',
      run: (p) => p.point('@sheet-call-people'),
    },
    {
      label: 'Everyone is scored',
      voiceover:
        'A minute after it ended, everyone who came was scored Hot, Warm or Cold, from what they answered in the poll and what they said in the chat.',
      run: async (p) => {
        await p.waitFor('@sheet-webinar-leads', 15_000);
        await p.point('@sheet-webinar-lead-counts');
      },
    },
    {
      label: 'The hot ones already have a text',
      voiceover:
        'Jill asked for the free energy check, and her AC is twelve years old. She’s Hot, with the reason in a line, and your AI teammate has already texted her.',
      run: (p) => p.point('[data-testid="sheet-webinar-lead"]'),
    },
    {
      label: 'Jill books her energy check',
      voiceover:
        'Jill texts back, ready to book. The webinar did the selling. You just show up to the ones who want you.',
      change: (w, at) => {
        conversationIn(w, JILL_CHAT).unread = 1;
        customerSays(w, JILL_CHAT, {
          id: JILL_REPLY,
          at,
          body: 'Yes! That was really helpful. Is tomorrow afternoon open?',
        });
      },
      live: NEW_MESSAGE,
      run: async (p) => {
        await p.go('inbox');
        await openConversation(p, JILL_CHAT);
        await p.point(`@message-${JILL_REPLY}`);
      },
    },
  ],
};

// ----------------------------------------------------------- 65. "Find the customer with the leaky skylight"

const s65 = idsFor(65);
const GLORIA: DemoPerson = newPerson(s65(1), 'Gloria', 'Fenwick', 6501, 'West University');
const GLORIA_CHAT = s65(0x11);
const GLORIA_TEXT = s65(0x12);
const GLORIA_ANSWER = s65(0x13);
const GLORIA_NOTE = s65(0x21);
const PHRASE = 'leaky skylight';

/** The note from the visit: its first line is what Search shows as its title. */
const NOTE_TEXT =
  'Up in the attic for the AC\nThe leaky skylight over the hallway drips onto the duct. Told her to get a roofer first, then we’ll swap the wet duct insulation.';
const TEXT_TEXT =
  'Hi, it’s Gloria. The roofer fixed the leaky skylight! Can you come replace the wet duct insulation now, like you said?';

const skylightSearch: DemoScene = {
  id: 'skylight-search',
  number: 65,
  title: '“Find the customer with the leaky skylight”',
  kind: 'app',
  startsOn: '',
  setup: (w, at) => {
    const gloria = regular(GLORIA, at, 3);
    w.conversations.push({
      id: GLORIA_CHAT,
      person: gloria,
      createdAt: at - 26 * DAY,
      unread: 0,
      messages: [
        { id: GLORIA_TEXT, at: at - 26 * DAY, direction: 'inbound', body: TEXT_TEXT },
        {
          id: GLORIA_ANSWER,
          at: at - 26 * DAY + 40 * MIN,
          direction: 'outbound',
          byMe: true,
          body: 'Great news, Gloria! We’ll get the new insulation ordered and call you to pick a day.',
        },
      ],
      drafts: [],
      visits: [],
    });
    w.notes.push({ id: GLORIA_NOTE, person: gloria, body: NOTE_TEXT, at: at - 41 * DAY });
  },
  steps: [
    {
      label: 'Search for what you remember',
      voiceover:
        'You remember the job, not the name: the customer with the leaky skylight. Type that into Search.',
      run: async (p) => {
        await p.click('@shell-search');
        await p.type('@shell-search', PHRASE);
        await p.waitFor('@search-group-notes', 15_000);
      },
    },
    {
      label: 'It finds her note and her text',
      voiceover:
        'It searches every note and every message, not just names. There’s the note from the attic, and her text after the roofer came.',
      run: (p) => p.point('@search-group-notes'),
    },
    {
      label: 'Open her text',
      voiceover:
        'Open her text, and you’re right where you left off: you said you’d call her to pick a day.',
      run: async (p) => {
        await p.click('[data-testid="search-group-messages"] [data-testid="search-hit-messages"]');
        await p.waitFor(`@message-${GLORIA_TEXT}`, 15_000);
        await p.point(`@message-${GLORIA_TEXT}`);
      },
    },
  ],
};

export const WEBINAR_SEARCH_SCENES: readonly DemoScene[] = [webinarBuyers, skylightSearch];
