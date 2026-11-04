import {
  demoId,
  fullName,
  phoneDisplay,
  type DemoAnswer,
  type DemoConfirmCard,
  type DemoPerson,
  type DemoWorld,
} from '../world';
import { answered, clock, confirmEach, conversationIn, openConversation, shortDay } from './kit';
import type { DemoPlayer, DemoScene, DemoStep } from './types';

/**
 * The shape most Ask HandsFreeOS scenes share, so each one is only its words: open Ask HandsFreeOS, ask, look at the
 * answer, say yes to its cards, ask again. Every answer is worded as the worker words that tool's cards and look-ups
 * (apps/worker/src/assistant), and its steps carry the labels the worker shows while each tool runs.
 */

/** A question, typed as the presenter asks it; a function when it names a day the scene works out. */
type Question = string | ((at: number, timeZone: string) => string);

export type Beat =
  /** Asks, and the answer streams in with its look-ups and cards. */
  | {
      readonly ask: Question;
      readonly label: string;
      readonly voiceover: string;
      readonly answer: (w: DemoWorld, at: number) => DemoAnswer;
      /** What else the question makes up (the answer itself stays free of side effects). */
      readonly change?: (w: DemoWorld, at: number) => void;
      readonly live?: readonly string[];
      /** What the pointer rests on once it has answered; the answer's first card, else its first look-up. */
      readonly point?: string;
    }
  /** Says yes to the waiting cards, one after another. */
  | {
      readonly confirm: number;
      readonly label: string;
      readonly voiceover: string;
      readonly change?: (w: DemoWorld, at: number) => void;
      readonly live?: readonly string[];
      readonly then?: (p: DemoPlayer) => Promise<void>;
    }
  /** Anything else, as a step of its own. */
  | { readonly step: DemoStep };

const asked = (q: Question, at: number, timeZone: string) =>
  typeof q === 'string' ? q : q(at, timeZone);

/** The answer just given: the chat's last message (the log lists the newest last). */
const LAST = '[data-testid="assistant-message"]:last-child';
/** A card of `type` in the answer just given, not one higher up the chat. */
export const lastCard = (type: string) => `${LAST} [data-testid="assistant-card-${type}"]`;

/** Where the pointer goes after an answer: its first card to say yes to, else its first look-up. */
function pointOf(a: DemoAnswer): string {
  if (a.cards?.length) return lastCard('confirm');
  const first = a.shows?.[0];
  return first ? lastCard(first.type) : LAST;
}

/** One beat as a step: so a scene that isn't all Ask HandsFreeOS can still ask it something along the way. */
export function beatStep(b: Beat): DemoStep {
  if ('step' in b) return b.step;
  if ('ask' in b)
    return {
      label: b.label,
      voiceover: b.voiceover,
      change: (w, at) => {
        b.change?.(w, at);
        const a = b.answer(w, at);
        for (const c of a.cards ?? []) w.cards[c.toolCallId] = c;
        w.answer = a;
        w.chat.push({ question: asked(b.ask, at, w.state.timeZone), answer: a, at });
      },
      live: b.live,
      run: async (p) => {
        await p.ask(asked(b.ask, Date.now(), p.timeZone));
        await answered(p);
        // The answer is scripted, so what it shows is known: point at it as it would be pointed at in person.
        await p.point(b.point ?? pointFor(b));
      },
    };
  return {
    label: b.label,
    voiceover: b.voiceover,
    change: (w, at) => {
      const waiting = (w.answer?.cards ?? []).map((c) => c.toolCallId);
      w.answer = null;
      w.confirmed.push(...waiting.filter((id) => !w.confirmed.includes(id)));
      b.change?.(w, at);
    },
    live: b.live,
    run: async (p) => {
      await confirmEach(p, b.confirm);
      await b.then?.(p);
    },
  };
}

export function askScene(s: {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  /** The first step's voiceover, as Ask HandsFreeOS opens. */
  readonly open: string;
  readonly setup?: DemoScene['setup'];
  readonly beats: readonly Beat[];
}): DemoScene {
  const steps: DemoStep[] = [
    { label: 'Open Ask HandsFreeOS (⌘J)', voiceover: s.open, run: (p) => p.openAssistant() },
  ];
  steps.push(...s.beats.map(beatStep));
  return {
    id: s.id,
    number: s.number,
    title: s.title,
    kind: 'assistant',
    startsOn: '',
    setup: s.setup,
    steps,
  };
}

/** The pointer's target for an answer, read off the answer the world would give (the browser has it too). */
function pointFor(b: Extract<Beat, { ask: Question }>): string {
  // Build the answer from an empty world just to see its shape; ids and words don't matter here.
  try {
    return pointOf(b.answer(EMPTY, Date.now()));
  } catch {
    return LAST;
  }
}

const EMPTY: DemoWorld = {
  state: {
    scene: '',
    steps: [],
    startedAt: 0,
    business: 'Your business',
    teammate: 'Ava',
    timeZone: 'America/Chicago',
    me: { id: '00000000-0000-4000-8000-000000000000', name: 'You' },
  },
  workspaceId: '00000000-0000-4000-8000-000000000000',
  conversations: [],
  campaigns: [],
  estimates: [],
  invoices: [],
  services: [],
  lessons: [],
  leads: [],
  visits: [],
  google: { connected: false, busy: [] },
  documents: [],
  referrals: [],
  answer: null,
  cards: {},
  chat: [],
  confirmed: [],
  teammateAutomatic: false,
  reviews: [],
  reviewsConnected: false,
  offers: [],
  imports: [],
  notes: [],
  coach: null,
  setup: null,
  outreach: [],
};

/** Ids for one scene's made-up records: its number keeps them apart from every other scene's. */
export const idsFor =
  (scene: number) =>
  (n: number): string =>
    demoId(scene * 0x10000 + n);

/** The answer's steps, one per tool it ran, with the label the worker shows for that tool. */
export const ran = (...labels: readonly string[]) =>
  labels.map((label, i) => ({ id: `step-${i}`, label }));

/** What the worker shows while a tool that waits for an OK and has no label of its own gets its card ready. */
export const PREPARING = 'Preparing it for your OK';

/** A made-up customer, with a 555 number, near Houston like the demo business. */
export function customer(
  id: string,
  first: string,
  last: string,
  phoneTail: number,
  city = 'Houston',
  customerSince: number | null = null,
): DemoPerson {
  return {
    id,
    firstName: first,
    lastName: last,
    phone: `+1713555${String(phoneTail).padStart(4, '0')}`,
    city,
    tags: ['Customer'],
    customerSince,
  };
}

/** "$1,250", as the worker writes money on cards (no cents). */
export const dollars = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);

/** "Fri, Nov 6, 9:00 AM", as the worker writes a due time. */
export const dueWords = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(new Date(ms))
    .replace(/\u202f/g, ' ');

/** "Fri, Nov 6, 10:00–11:00 AM", as the calendar's cards write a visit. */
export function rangeWords(start: number, minutes: number, timeZone: string): string {
  const a = clock(start, timeZone).replace(/\u202f/g, ' ');
  const b = clock(start + minutes * 60_000, timeZone).replace(/\u202f/g, ' ');
  return `${shortDay(start, timeZone)}, ${a.slice(-2) === b.slice(-2) ? a.slice(0, -3) : a}–${b}`;
}

/** "Fri, Nov 6 at 10:00 AM". */
export const atWords = (ms: number, timeZone: string) =>
  `${shortDay(ms, timeZone)} at ${clock(ms, timeZone).replace(/\u202f/g, ' ')}`;

/** A link into the business, as the cards need one. */
export const pageOf = (w: DemoWorld, path: string) => `/app/w/${w.workspaceId}/${path}`;

/** A customer's page, as the cards link to it. */
export const personPage = (w: DemoWorld, p: DemoPerson) => pageOf(w, `customers/people/${p.id}`);

/** send_text's card, as tools-write.ts words it. */
export const textCard = (toolCallId: string, p: DemoPerson, body: string): DemoConfirmCard => ({
  toolCallId,
  tool: 'send_text',
  title: `Send this text to ${p.firstName}?`,
  fields: [
    { label: 'To', value: `${fullName(p)} · ${phoneDisplay(p.phone)}` },
    { label: 'From', value: 'Your business number' },
  ],
  body,
  confirmLabel: 'Send text',
  outcome: `Sent to ${fullName(p)}`,
});

/** decide_teammate_draft's card for a text the AI teammate wrote, approved, as tools-content.ts words it. */
export const approveTextCard = (
  w: DemoWorld,
  toolCallId: string,
  p: DemoPerson,
  c: { readonly theyWrote: string; readonly body: string; readonly discount?: string },
): DemoConfirmCard => {
  const name = w.state.teammate;
  const who = fullName(p);
  return {
    toolCallId,
    tool: 'decide_teammate_draft',
    title: c.discount
      ? `Approve ${c.discount.split('%')[0]}% off for ${who}?`
      : `Send ${name}’s text to ${who}?`,
    fields: [
      { label: 'To', value: `${who} · text` },
      { label: 'They wrote', value: `“${c.theyWrote}”` },
      ...(c.discount ? [{ label: 'Discount', value: c.discount }] : []),
    ],
    body: c.body,
    warnings: [
      {
        kind: 'caution',
        text: `It goes to ${p.firstName} as soon as you confirm, from ${name} with your name on it.`,
      },
      ...(c.discount ? [] : [{ kind: 'note', text: `It counts toward ${name}’s training.` }]),
    ],
    confirmLabel: 'Approve and send',
    outcome: `Approved. It goes to ${p.firstName} now.`,
  };
};

/**
 * The texts the presenter said yes to, now in the inbox as their own conversations; `reply` steps open one of them
 * when the customer writes back.
 */
export function textsSent(
  w: DemoWorld,
  at: number,
  sent: readonly {
    readonly conversation: string;
    readonly message: string;
    readonly person: DemoPerson;
    readonly body: string;
  }[],
): void {
  sent.forEach((s, i) =>
    w.conversations.unshift({
      id: s.conversation,
      person: s.person,
      createdAt: at + i * 2_000,
      unread: 0,
      messages: [
        { id: s.message, at: at + i * 2_000, direction: 'outbound', byMe: true, body: s.body },
      ],
      drafts: [],
      visits: [],
    }),
  );
}

/** A customer texts back on a conversation the scene started, and the player opens it in the inbox. */
export function reply(s: {
  readonly label: string;
  readonly voiceover: string;
  readonly conversation: string;
  readonly message: string;
  readonly body: string;
}): Beat {
  return {
    step: {
      label: s.label,
      voiceover: s.voiceover,
      change: (w, at) => {
        const c = conversationIn(w, s.conversation);
        c.unread = 1;
        c.messages.push({ id: s.message, at, direction: 'inbound', body: s.body });
      },
      live: ['conversation', 'message'],
      run: async (p) => {
        await p.closeAssistant();
        await p.go('inbox');
        await openConversation(p, s.conversation);
        await p.point(`@message-${s.message}`);
      },
    },
  };
}

/** The `n`th weekday (0 Sunday … 6 Saturday) of a month, as a local date `YYYY-MM-DD`. */
export function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The year, month and day it is where the business is. */
export function today(at: number, timeZone: string): { y: number; m: number; d: number } {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day') };
}
