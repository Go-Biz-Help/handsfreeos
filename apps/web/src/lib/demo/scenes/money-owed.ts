import { businessOf, demoId, type DemoConfirmCard, type DemoPerson } from '../world';
import { answered, confirmEach, conversationIn, openConversation, textedConversation } from './kit';
import type { DemoScene } from './types';

/**
 * Scene 9: "Who owes me money?" Ask HandsFreeOS adds up what's unpaid and what's late. You ask it to text the late
 * ones, it writes a text for each with a card, you say yes to each, and the first one texts back.
 */
const QUESTION = 'Who owes me money?';
const FOLLOW_UP = 'Text the three that are late a friendly nudge.';
const DAY = 24 * 3600_000;

interface Owed {
  readonly number: string;
  readonly first: string;
  readonly last: string;
  readonly cents: number;
  /** Days past its due date; below zero, days until it's due. */
  readonly late: number;
  readonly job: string;
}

const OWED: readonly Owed[] = [
  {
    number: 'INV-1162',
    first: 'Gary',
    last: 'Holt',
    cents: 98_000,
    late: 34,
    job: 'water heater install',
  },
  {
    number: 'INV-1171',
    first: 'Angela',
    last: 'Brooks',
    cents: 61_500,
    late: 12,
    job: 'garbage disposal',
  },
  {
    number: 'INV-1175',
    first: 'Derek',
    last: 'Lane',
    cents: 24_500,
    late: 5,
    job: 'slab leak repair',
  },
  { number: 'INV-1183', first: 'Monica', last: 'Ruiz', cents: 125_000, late: -8, job: 'sump pump' },
  {
    number: 'INV-1185',
    first: 'Sam',
    last: 'Patel',
    cents: 112_500,
    late: -11,
    job: 'kitchen faucet',
  },
];
const LATE = OWED.filter((o) => o.late > 0);

const dollars = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const sum = (list: readonly Owed[]) => list.reduce((n, o) => n + o.cents, 0);
const monthDay = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(
    new Date(ms),
  );

const idOf = (i: number, kind: number) => demoId(0x90000 + kind * 0x100 + i);
const CARD = 1;
const CONVERSATION = 2;
const TEXT = 3;
const PERSON = 4;
const GARY_REPLY = demoId(0x90001);

const person = (o: Owed, i: number, at: number): DemoPerson => ({
  id: idOf(i, PERSON),
  firstName: o.first,
  lastName: o.last,
  phone: `+1512555${String(1100 + i * 37).padStart(4, '0')}`,
  city: 'Austin',
  tags: ['Customer'],
  customerSince: at - (200 + i * 40) * DAY,
});

const phoneOf = (e164: string) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;

const textFor = (o: Owed, business: string) =>
  `Hi ${o.first}, it’s ${business}. Just a friendly nudge on invoice ${o.number} for ${dollars(o.cents)}, for your ${o.job}. You can pay it here in a minute: https://app.handsfreeos.com/i/${o.number.slice(4)}kQ7m`;

/** A send_text card for each late one, worded as the Assistant words it. */
const textCards = (business: string, at: number): DemoConfirmCard[] =>
  LATE.map((o, i) => {
    const p = person(o, i, at);
    return {
      toolCallId: idOf(i, CARD),
      tool: 'send_text',
      title: `Send this text to ${o.first}?`,
      fields: [
        { label: 'To', value: `${o.first} ${o.last} · ${phoneOf(p.phone)}` },
        { label: 'From', value: 'Your business number' },
      ],
      body: textFor(o, business),
      confirmLabel: 'Send text',
      outcome: `Sent to ${o.first} ${o.last}`,
    };
  });

export const moneyOwed: DemoScene = {
  id: 'money-owed',
  number: 9,
  title: '“Who owes me money?”',
  kind: 'assistant',
  startsOn: '',
  steps: [
    {
      label: 'Open Ask HandsFreeOS (⌘J)',
      run: (p) => p.openAssistant(),
    },
    {
      label: 'Ask: who owes me money?',
      say: 'No reports to run. It adds it up and tells you who’s late.',
      change: (w, at) => {
        const tz = w.state.timeZone;
        w.answer = {
          steps: [{ id: 'owed', label: 'Adding up what you are owed' }],
          shows: [
            {
              type: 'money',
              title: 'What you are owed',
              value: dollars(sum(OWED)),
              detail: `${OWED.length} invoices`,
              tone: 'danger',
              stats: [{ value: dollars(sum(LATE)), label: `overdue · ${LATE.length}` }],
              items: OWED.map((o) => ({
                title: `${o.number} · ${o.first} ${o.last}`,
                detail: `${dollars(o.cents)} · due ${monthDay(at - o.late * DAY, tz)}`,
                status: o.late > 0 ? 'Overdue' : 'Sent',
                tone: o.late > 0 ? ('danger' as const) : ('accent' as const),
                href: null,
              })),
              href: null,
            },
          ],
          text: `You’re owed **${dollars(sum(OWED))}** on ${OWED.length} invoices, and **${dollars(sum(LATE))}** of it is late. Gary Holt’s is the oldest: ${dollars(OWED[0]!.cents)}, ${OWED[0]!.late} days past due. All three late ones have had their automatic reminders. Want me to text them a friendly nudge?`,
        };
        w.chat.push({ question: QUESTION, answer: w.answer, at });
      },
      run: async (p) => {
        await p.ask(QUESTION);
        await answered(p);
        await p.point('@assistant-card-money');
      },
    },
    {
      label: 'Ask it to text the three that are late',
      say: 'It writes each one with the amount and a link to pay.',
      change: (w, at) => {
        const all = textCards(businessOf(w), at);
        for (const c of all) w.cards[c.toolCallId] = c;
        w.answer = {
          steps: [{ id: 'write', label: 'Writing the texts' }],
          text: 'Here’s a text for each of the three, with the amount and their link to pay. They go from your business number once you say yes.',
          cards: all,
        };
        w.chat.push({ question: FOLLOW_UP, answer: w.answer, at });
      },
      run: async (p) => {
        await p.ask(FOLLOW_UP);
        await answered(p);
        await p.point('@assistant-confirm');
      },
    },
    {
      label: 'Say yes to each text',
      say: 'Anything that reaches a customer waits for your OK.',
      change: (w, at) => {
        w.answer = null;
        const business = businessOf(w);
        LATE.forEach((o, i) => {
          w.confirmed.push(idOf(i, CARD));
          textedConversation(w, at + i * 2_000, {
            id: idOf(i, CONVERSATION),
            person: person(o, i, at),
            messageId: idOf(i, TEXT),
            body: textFor(o, business),
          });
        });
      },
      live: ['conversation'],
      run: (p) => confirmEach(p, LATE.length),
    },
    {
      label: 'Gary texts back',
      say: 'Thirty-four days late, and paid the same night.',
      change: (w, at) => {
        const c = conversationIn(w, idOf(0, CONVERSATION));
        c.unread = 1;
        c.messages.push({
          id: GARY_REPLY,
          at,
          direction: 'inbound',
          body: 'So sorry, that one slipped by me. Paying it tonight!',
        });
      },
      live: ['conversation', 'message'],
      run: async (p) => {
        await p.closeAssistant();
        await p.go('inbox');
        await openConversation(p, idOf(0, CONVERSATION));
        await p.point(`@message-${GARY_REPLY}`);
      },
    },
  ],
};
