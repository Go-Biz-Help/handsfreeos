import {
  businessOf,
  demoId,
  wallTime,
  type DemoConfirmCard,
  type DemoPerson,
  type DemoWorld,
} from '../world';
import {
  answered,
  clock,
  confirmEach,
  conversationIn,
  myFirstName,
  openConversation,
  shortDay,
  textedConversation,
  weekdayOf,
  zoneName,
} from './kit';
import type { DemoScene } from './types';

/**
 * Scene 11: "Ask everyone we finished a job for this week for a review." Ask HandsFreeOS finds the jobs marked done,
 * writes a thank-you with the review link for each on its own card, you say yes to each, and one leaves five stars.
 */
const QUESTION = 'Ask everyone we finished a job for this week for a review.';
const DAY = 24 * 3600_000;
const LINDA_REPLY = demoId(0xb0001);

interface Job {
  readonly first: string;
  readonly last: string;
  /** Which working day before today it was done on (1 is the last one), and at what hour. */
  readonly workday: number;
  readonly hour: number;
  readonly what: string;
  /** "clear your kitchen drain", for the thank-you. */
  readonly thanks: string;
}

const JOBS: readonly Job[] = [
  {
    first: 'Linda',
    last: 'Park',
    workday: 2,
    hour: 9,
    what: 'Drain cleaning',
    thanks: 'clear your kitchen drain',
  },
  {
    first: 'Marcus',
    last: 'Bell',
    workday: 2,
    hour: 11,
    what: 'Leak repair',
    thanks: 'fix the leak under your sink',
  },
  {
    first: 'Priya',
    last: 'Shah',
    workday: 1,
    hour: 14,
    what: 'Shower valve',
    thanks: 'replace your shower valve',
  },
  {
    first: 'Kevin',
    last: 'Nguyen',
    workday: 1,
    hour: 10,
    what: 'Toilet repair',
    thanks: 'fix your running toilet',
  },
];

const idOf = (i: number, kind: number) => demoId(0xb0000 + kind * 0x100 + i);
const CARD = 1;
const CONVERSATION = 2;
const TEXT = 3;
const PERSON = 4;

const person = (j: Job, i: number, at: number): DemoPerson => ({
  id: idOf(i, PERSON),
  firstName: j.first,
  lastName: j.last,
  phone: `+1512555${String(3300 + i * 41).padStart(4, '0')}`,
  city: 'Round Rock',
  tags: ['Customer'],
  customerSince: at - 30 * DAY,
});

/** How many days back the `n`th working day before today is, where the business is (weekends skipped). */
function workdaysBack(at: number, n: number, timeZone: string): number {
  let days = 0;
  for (let found = 0; found < n;) {
    days++;
    if (![0, 6].includes(weekdayOf(at - days * DAY, timeZone))) found++;
  }
  return days;
}

const phoneOf = (e164: string) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;

/** The business's Google review link, as it's saved in Settings. */
const reviewLink = (business: string) =>
  `https://g.page/r/${business.toLowerCase().replace(/[^a-z0-9]+/g, '')}/review`;

const textFor = (w: DemoWorld, j: Job) =>
  `Hi ${j.first}, thanks for having us out to ${j.thanks}! If we did a good job, would you leave us a quick review? It means a lot to a small business: ${reviewLink(businessOf(w))} – ${myFirstName(w)}, ${businessOf(w)}`;

/** A send_text card for each, worded as the Assistant words it. */
const textCards = (w: DemoWorld, at: number): DemoConfirmCard[] =>
  JOBS.map((j, i) => ({
    toolCallId: idOf(i, CARD),
    tool: 'send_text',
    title: `Send this text to ${j.first}?`,
    fields: [
      { label: 'To', value: `${j.first} ${j.last} · ${phoneOf(person(j, i, at).phone)}` },
      { label: 'From', value: 'Your business number' },
    ],
    body: textFor(w, j),
    confirmLabel: 'Send text',
    outcome: `Sent to ${j.first} ${j.last}`,
  }));

export const reviewRequests: DemoScene = {
  id: 'review-requests',
  number: 11,
  title: 'Ask this week’s customers for a review',
  kind: 'assistant',
  startsOn: '',
  steps: [
    {
      label: 'Open Ask HandsFreeOS (⌘J)',
      voiceover:
        'Reviews bring in new customers, but asking for them is easy to forget. Open Ask HandsFreeOS.',
      run: (p) => p.openAssistant(),
    },
    {
      label: 'Ask for reviews from this week’s jobs',
      voiceover:
        'Ask it to get a review from everyone you finished a job for this week. It finds the jobs marked done and writes a thank-you for each, with your Google review link.',
      change: (w, at) => {
        const tz = w.state.timeZone;
        const all = textCards(w, at);
        for (const c of all) w.cards[c.toolCallId] = c;
        const since = wallTime(at, tz, -workdaysBack(at, JOBS[0]!.workday, tz), 12);
        const sinceDay = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(
          new Date(since),
        );
        w.answer = {
          steps: [
            { id: 'done', label: 'Looking at appointments' },
            ...JOBS.map((_, i) => ({ id: `text-${i}`, label: 'Preparing it for your OK' })),
          ],
          shows: [
            {
              type: 'list',
              title: 'Appointments',
              aside: `Since ${shortDay(since, tz)} · ${zoneName(tz, at)}`,
              items: JOBS.map((j) => {
                const start = wallTime(at, tz, -workdaysBack(at, j.workday, tz), j.hour);
                return {
                  title: `${clock(start, tz)} · ${j.what} · ${j.first}`,
                  detail: `${shortDay(start, tz)} · Done`,
                  tone: 'muted' as const,
                  href: null,
                };
              }),
            },
          ],
          text: `${JOBS.length} jobs were marked done since ${sinceDay}. Here’s a short thank-you for each, with your Google review link. Each one waits for your OK.`,
          cards: all,
        };
        w.chat.push({ question: QUESTION, answer: w.answer, at });
      },
      run: async (p) => {
        await p.ask(QUESTION);
        await answered(p);
        await p.point('@assistant-card-list');
      },
    },
    {
      label: 'Say yes to each text',
      voiceover:
        'Each one is personal: it says what you did for them. Say yes to each, and they go out from your business number.',
      change: (w, at) => {
        w.answer = null;
        JOBS.forEach((j, i) => {
          w.confirmed.push(idOf(i, CARD));
          textedConversation(w, at + i * 2_000, {
            id: idOf(i, CONVERSATION),
            person: person(j, i, at),
            messageId: idOf(i, TEXT),
            body: textFor(w, j),
          });
        });
      },
      live: ['conversation'],
      run: (p) => confirmEach(p, JOBS.length),
    },
    {
      label: 'Linda leaves five stars',
      voiceover:
        'Linda leaves five stars, and texts to say so. More reviews, and you didn’t have to remember a single one.',
      change: (w, at) => {
        const c = conversationIn(w, idOf(0, CONVERSATION));
        c.unread = 1;
        c.messages.push({
          id: LINDA_REPLY,
          at,
          direction: 'inbound',
          body: 'Done! Five stars. Your tech was great, and so quick.',
        });
      },
      live: ['conversation', 'message'],
      run: async (p) => {
        await p.closeAssistant();
        await p.go('inbox');
        await openConversation(p, idOf(0, CONVERSATION));
        await p.point(`@message-${LINDA_REPLY}`);
      },
    },
  ],
};
