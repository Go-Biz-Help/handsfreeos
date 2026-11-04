import { businessOf, demoId, wallTime, type DemoPerson } from '../world';
import {
  answered,
  clock,
  confirmEach,
  conversationIn,
  myFirstName,
  openConversation,
  shortDay,
  weekdayOf,
  zoneName,
} from './kit';
import type { DemoScene } from './types';

/**
 * Scene 10: "What's my day tomorrow?" Ask HandsFreeOS lists tomorrow's jobs. "Move the Johnson job to Friday": it
 * finds the same time open, you say yes on its card, and Dave gets a text with the new time and answers it.
 */
const QUESTION = 'What’s my day tomorrow?';
const MOVE = demoId(0xa0001);
const CONVERSATION = demoId(0xa0002);
const PERSON = demoId(0xa0003);
const NOTICE = demoId(0xa0011);
const REPLY = demoId(0xa0012);
const VISIT = demoId(0xa0021);
const DAY = 24 * 3600_000;

/** Tomorrow's jobs: when, what, who. Dave Johnson's is the one that moves. */
const JOBS: readonly (readonly [hour: number, minute: number, what: string, who: string])[] = [
  [8, 0, 'Water heater flush', 'Rachel'],
  [9, 30, 'Leak repair', 'Kevin'],
  [11, 0, 'Drain cleaning', 'Angela'],
  [13, 30, 'Water heater install', 'Dave'],
  [15, 30, 'Toilet repair', 'Helen'],
];
const DAVE_HOUR = 13;
const DAVE_MINUTE = 30;
const DAVE_MINUTES = 120;

const DAVE: DemoPerson = {
  id: PERSON,
  firstName: 'Dave',
  lastName: 'Johnson',
  phone: '+15125550143',
  city: 'Pflugerville',
  tags: ['Customer'],
  customerSince: null,
};

/** The day it moves to: the first weekday after tomorrow. */
function moveDays(at: number, timeZone: string): number {
  let days = 2;
  while ([0, 6].includes(weekdayOf(at + days * DAY, timeZone))) days++;
  return days;
}

const weekdayName = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(new Date(ms));

const shortZone = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(ms))
    .find((x) => x.type === 'timeZoneName')?.value ?? '';

/** "Thu, Nov 5, 1:30–3:30 PM", as the move card writes a time. */
function range(start: number, minutes: number, timeZone: string): string {
  const end = start + minutes * 60_000;
  const from = clock(start, timeZone);
  const to = clock(end, timeZone);
  const sameHalf = from.slice(-2) === to.slice(-2);
  return `${shortDay(start, timeZone)}, ${sameHalf ? from.slice(0, -3) : from}–${to}`;
}

/** The question as the presenter asks it: "Move the Johnson job to Friday." */
const moveQuestion = (at: number, timeZone: string) =>
  `Move the Johnson job to ${weekdayName(wallTime(at, timeZone, moveDays(at, timeZone), 12), timeZone)}.`;

export const myDay: DemoScene = {
  id: 'my-day',
  number: 10,
  title: '“What’s my day tomorrow?”',
  kind: 'assistant',
  startsOn: '',
  steps: [
    {
      label: 'Open Ask HandsFreeOS (⌘J)',
      run: (p) => p.openAssistant(),
    },
    {
      label: 'Ask: what’s my day tomorrow?',
      say: 'Your whole day at a glance, without opening the calendar.',
      change: (w, at) => {
        const tz = w.state.timeZone;
        const tomorrow = wallTime(at, tz, 1, 12);
        w.answer = {
          steps: [{ id: 'appointments', label: 'Looking at appointments' }],
          shows: [
            {
              type: 'list',
              title: 'Appointments',
              aside: `${shortDay(tomorrow, tz)} · ${zoneName(tz, tomorrow)}`,
              items: JOBS.map(([h, m, what, who]) => {
                const start = wallTime(at, tz, 1, h, m);
                return {
                  title: `${clock(start, tz)} · ${what} · ${who}`,
                  detail: `${shortDay(start, tz)} · Scheduled`,
                  tone: 'accent' as const,
                  href: null,
                };
              }),
            },
          ],
          text: `Tomorrow you have **${JOBS.length} jobs**, from 8:00 AM to about 4:30 PM. The biggest is Dave Johnson’s water heater install at 1:30 PM, booked for two hours. The first is Rachel’s water heater flush at 8:00 AM.`,
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
      label: 'Ask: move the Johnson job to Friday',
      say: 'It checks the new time is free, and tells Dave for you.',
      change: (w, at) => {
        const tz = w.state.timeZone;
        const days = moveDays(at, tz);
        const was = wallTime(at, tz, 1, DAVE_HOUR, DAVE_MINUTE);
        const now = wallTime(at, tz, days, DAVE_HOUR, DAVE_MINUTE);
        const card = {
          toolCallId: MOVE,
          tool: 'reschedule_appointment',
          title: 'Move Dave Johnson’s water heater install?',
          fields: [
            { label: 'Was', value: range(was, DAVE_MINUTES, tz) },
            { label: 'Now', value: range(now, DAVE_MINUTES, tz) },
            { label: 'With', value: myFirstName(w) },
            { label: 'Tell Dave', value: 'A text with the new time' },
          ],
          confirmLabel: 'Move',
          outcome: `Moved to ${shortDay(now, tz)} at ${clock(now, tz)}.`,
        };
        w.cards[MOVE] = card;
        w.answer = {
          steps: [
            { id: 'find', label: 'Looking at appointments' },
            { id: 'free', label: 'Checking when you’re free' },
          ],
          text: `${weekdayName(now, tz)} at ${clock(now, tz)} is open, the same time as tomorrow. Dave gets a text with the new time once you say yes.`,
          cards: [card],
        };
        w.chat.push({ question: moveQuestion(at, tz), answer: w.answer, at });
      },
      run: async (p) => {
        await p.ask(moveQuestion(Date.now(), p.timeZone));
        await answered(p);
        await p.point('@assistant-confirm');
      },
    },
    {
      label: 'Say yes: it moves, and Dave gets a text',
      change: (w, at) => {
        const tz = w.state.timeZone;
        const now = wallTime(at, tz, moveDays(at, tz), DAVE_HOUR, DAVE_MINUTE);
        w.answer = null;
        w.confirmed.push(MOVE);
        w.conversations.unshift({
          id: CONVERSATION,
          person: DAVE,
          createdAt: at - 9 * DAY,
          unread: 0,
          messages: [
            {
              id: NOTICE,
              at,
              direction: 'outbound',
              body: `${businessOf(w)}: Your appointment is now ${shortDay(now, tz)} at ${clock(now, tz)} ${shortZone(now, tz)}. Change or cancel: https://app.handsfreeos.com/v/9pLx2Rk`,
            },
          ],
          drafts: [],
          visits: [
            {
              id: VISIT,
              title: 'Water heater install',
              startsAt: now,
              minutes: DAVE_MINUTES,
              bookedAt: at - 9 * DAY,
            },
          ],
        });
      },
      live: ['conversation'],
      run: (p) => confirmEach(p, 1),
    },
    {
      label: 'Dave texts back',
      say: 'One sentence from you. The calendar, the customer and the text are all handled.',
      change: (w, at) => {
        const c = conversationIn(w, CONVERSATION);
        c.unread = 1;
        c.messages.push({
          id: REPLY,
          at,
          direction: 'inbound',
          body: 'Friday works even better for me. Thanks for the heads up!',
        });
      },
      live: ['conversation', 'message'],
      run: async (p) => {
        await p.closeAssistant();
        await p.go('inbox');
        await openConversation(p, CONVERSATION);
        await p.point(`@message-${REPLY}`);
        await p.point('@context-panel');
      },
    },
  ],
};
