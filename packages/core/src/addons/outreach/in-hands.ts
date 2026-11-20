/**
 * In your hands, on Social Outreach (docs/outreach.md, decision 182; core's side is messaging/hands.ts): someone a
 * person on the team wrote to themselves, or took over from the menu on their name, is theirs. The AI sends them no
 * message of any kind until someone gives them back: Today leaves their messages off, and a draft for them can't be
 * queued or OK'd. Likes and comments still go, and so does everything else on their way.
 *
 * - **What puts them there:** a Send the extension saw the person press themselves (`outreach.touch.save` with `auto`
 *   off), or a message of theirs in a chat the extension read that HandsFreeOS didn't draft (`byHand`), in the last 30
 *   days. A draft of the AI's they OK'd, changed or copied stays the AI's (the owner, 19 Nov 2026), and so does one the
 *   extension handed them to send. A profile on a customer someone has in core's hands is held too, and one put in
 *   hands here puts its customer in that person's hands in core.
 * - **The ask** (`HandsAsk`, on Needs you): when they wrote back and an hour of the person's working hours went by with
 *   no answer, or when the AI would have followed up by now, "Let the AI take it" gives them back and "Keep it mine"
 *   keeps them till the next time; their phone hears it once each time.
 * - **Giving back** is for anyone on the team, from the menu on their name, the In your hands list or the ask.
 *
 * Browser-safe and pure: the web, the phone and the worker read these shapes and words.
 */
import { z } from 'zod';
import { HANDS_HOW_KEYS } from '../../schemas/hands';
import { HANDS_WORDS, handsLine } from '../../crm/hands-words';
import { nextInHours, workWindow, type WorkingHours } from './automation';
import { WORDLESS } from './chat-collect';
import { PLATFORM_KEYS, PLATFORMS, type Platform } from './networks';

/** How far back a message by hand counts: the owner's 30 days. */
export const HANDS_LOOK_BACK_DAYS = 30;

/** How much of the person's working hours their message waits unanswered before the ask: an hour (the owner's 4a). */
export const HANDS_ASK_AFTER_MS = 60 * 60 * 1000;

/** A message of the person's within this of one the extension sent them is the extension's. */
export const HANDS_NEAR_SEND_MS = 15 * 60 * 1000;

/** A message read in a chat within this after the person copied a draft for them is that draft. */
export const HANDS_COPIED_MS = 2 * 60 * 60 * 1000;

/** The most given back by name at once; Give all back takes everyone. */
export const HANDS_GIVE_BACK_MOST = 500;

// ------------------------------------------------------------------------------------------------- shapes

export const HandsTakeInput = z.object({ workspaceId: z.uuid(), profileId: z.uuid() });
export type HandsTakeInput = z.input<typeof HandsTakeInput>;
export const HandsTakeOutput = z.object({
  profileId: z.uuid(),
  /** They were in someone's hands already: nothing changed. */
  already: z.boolean(),
  /** The AI's messages to them, waiting for an OK or OK'd and not sent, that were skipped. */
  skipped: z.number().int().min(0),
});
export type HandsTakeOutput = z.output<typeof HandsTakeOutput>;

export const HandsGiveBackInput = z.object({
  workspaceId: z.uuid(),
  profileIds: z
    .array(z.uuid())
    .max(HANDS_GIVE_BACK_MOST, `Give back up to ${HANDS_GIVE_BACK_MOST} at a time.`)
    .default([]),
  /** Give all back: everyone in the business's list (or only yours, with `mine`). */
  all: z.boolean().default(false),
  /** With `all`: only those in your own hands. */
  mine: z.boolean().default(false),
});
export type HandsGiveBackInput = z.input<typeof HandsGiveBackInput>;
export const HandsGiveBackOutput = z.object({
  /** People who were in someone's hands and now aren't. */
  handedBack: z.number().int().min(0),
});
export type HandsGiveBackOutput = z.output<typeof HandsGiveBackOutput>;

export const HandsKeepInput = z.object({ workspaceId: z.uuid(), profileId: z.uuid() });
export type HandsKeepInput = z.input<typeof HandsKeepInput>;
export const HandsKeepOutput = z.object({ profileId: z.uuid(), keptAt: z.iso.datetime() });
export type HandsKeepOutput = z.output<typeof HandsKeepOutput>;

export const HandsReleaseInput = z.object({ workspaceId: z.uuid(), personId: z.uuid() });
export const HandsReleaseOutput = z.object({ released: z.number().int().min(0) });

export const HandsAskedInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
  userId: z.uuid(),
});
export const HandsAskedOutput = z.object({
  /** What the phone hears now: null when there's nothing to ask, or it was asked already. */
  push: z.object({ title: z.string(), body: z.string() }).nullable(),
  /** When to look again: the ask isn't due yet, or it goes outside the person's working hours. */
  again: z.iso.datetime().nullable(),
});

export const HANDS_ASK_WHYS = ['reply', 'follow_up'] as const;
export type HandsAskWhy = (typeof HANDS_ASK_WHYS)[number];

const User = z.object({ id: z.uuid(), fullName: z.string() });

export const HandsPerson = z.object({
  profileId: z.uuid(),
  personId: z.uuid().nullable(),
  name: z.string(),
  platform: z.enum(PLATFORM_KEYS),
  /** Their page on their network. */
  url: z.string(),
  /** Their chat, where it's known. */
  threadKey: z.string().nullable(),
  /** Whose hands: null for someone who has left, or a customer someone outside HandsFreeOS wrote to. */
  user: User.nullable(),
  how: z.enum(HANDS_HOW_KEYS),
  /** Where they last wrote to them by hand: a network, or core's channel; null for Take over. */
  place: z.string().nullable(),
  since: z.iso.datetime(),
  lastAt: z.iso.datetime(),
  /** Held through their customer in Contacts: giving back gives the customer back too. */
  inContacts: z.boolean(),
  /** The ask waiting for the person, when there is one. */
  ask: z.enum(HANDS_ASK_WHYS).nullable(),
});
export type HandsPerson = z.output<typeof HandsPerson>;

export const HandsInput = z.object({
  workspaceId: z.uuid(),
  /** Only those in your own hands. */
  mine: z.boolean().default(false),
  /** One person: whether they're in someone's hands (none or one row). */
  profileId: z.uuid().optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HandsInput = z.input<typeof HandsInput>;
export const HandsOutput = z.object({
  people: z.array(HandsPerson),
  /** Everyone in the list, more than `people` when it's cut at the limit. */
  total: z.number().int().min(0),
});
export type HandsOutput = z.output<typeof HandsOutput>;

/** The ask on Needs you: give someone in the person's hands back to the AI, or keep them. */
export const HandsAsk = z.object({
  profileId: z.uuid(),
  personId: z.uuid().nullable(),
  name: z.string(),
  platform: z.enum(PLATFORM_KEYS),
  url: z.string(),
  threadKey: z.string().nullable(),
  why: z.enum(HANDS_ASK_WHYS),
  /** When it came due: their message an hour of working hours on, or when the AI would have followed up. */
  at: z.iso.datetime(),
  /** Their latest message, for a reply: cut short. */
  theirs: z.string().nullable(),
});
export type HandsAsk = z.output<typeof HandsAsk>;

// ------------------------------------------------------------------------------------------------- words

const W = HANDS_WORDS;

export const HANDS_OUTREACH_WORDS = {
  title: W.title,
  about:
    'People someone on your team wrote to themselves, or took over. The AI sends them no messages until someone gives them back. Likes and comments still go.',
  empty:
    'Nobody’s in your hands. When you write to someone yourself, or press Take over in the menu on their name, they show here.',
  takeOver: W.takeOver,
  takeOverHint:
    'The AI stops sending them messages, here and in Contacts, until someone gives them back. Likes and comments still go.',
  giveBack: W.giveBack,
  giveBackHint: 'The AI picks up their messages again, starting with anything they’re waiting on.',
  giveAllBack: W.giveAllBack,
  mine: W.mine,
  everyone: W.everyone,
  tookOver: (name: string) =>
    `${name} is in your hands. The AI won’t message them until someone gives them back.`,
  gaveBack: W.gaveBackToast,
  kept: (name: string) =>
    `${name} stays in your hands. You’ll be asked again if they need an answer.`,
  /** The ask's buttons. */
  letAi: 'Let the AI take it',
  keepMine: 'Keep it mine',
  askTitle: (why: HandsAskWhy, name: string) =>
    why === 'reply'
      ? `${name} wrote back. Let the AI answer?`
      : `Time to follow up with ${name}. Let the AI do it?`,
  askBody: (why: HandsAskWhy) =>
    why === 'reply'
      ? 'You wrote to them yourself, so the AI is holding off. It can take it from here, or you can keep it.'
      : 'You wrote to them yourself, so the AI is holding off. It can follow up from here, or you can keep it.',
  /** The ask's heading on Needs you. */
  asksTitle: 'In your hands',
  /** Where they're held, under their name in the menu. */
  line: (p: Pick<HandsPerson, 'how' | 'place' | 'user'>, me: string | null) =>
    `${W.title}: ${handsLine(p, me)}`,
  heldOff: 'The AI is holding off: someone on your team has them in their hands.',
} as const;

/** The phone's push for an ask: the network and what happened, short enough that a phone never cuts it. */
export function handsPushWords(
  why: HandsAskWhy,
  name: string,
  platform: Platform,
): { title: string; body: string } {
  return why === 'reply'
    ? {
        title: `${name} wrote back on ${PLATFORMS[platform]}`,
        body: 'They’re in your hands. Tap to answer, or let the AI take it.',
      }
    : {
        title: `Follow up with ${name}?`,
        body: `They’re in your hands on ${PLATFORMS[platform]}. Tap to let the AI follow up, or keep it.`,
      };
}

// ------------------------------------------------------------------------------------------------- when to ask

/**
 * The moment `ms` of the person's working hours have gone by since `from`: from itself with none, moved to the start of
 * their working hours when it falls outside them. Null only when their hours have no working day.
 */
export function workingAfter(
  hours: WorkingHours,
  timeZone: string,
  from: number,
  ms: number,
): number | null {
  let at = from;
  let left = ms;
  for (let day = 0; day < 14; day++) {
    const start = nextInHours(hours, timeZone, at);
    if (start === null) return null;
    const w = workWindow(hours, timeZone, start);
    if (!w) return null;
    if (w.to - start >= left) return start + left;
    left -= w.to - start;
    at = w.to;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------- who wrote it

/** A message's words as compared: letters and numbers only, in lower case. */
export const sameWords = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Shorter than this, a message of the person's is the AI's only when it's the whole of a draft or a paragraph of one. */
const WITHIN_MOST = 12;

/**
 * Whether a message of the person's says what one of HandsFreeOS's drafts for them said: the whole draft, one of its
 * paragraphs (a long one goes as a bubble each), or, when long enough not to be chance, part of it.
 */
export function saysADraft(text: string, drafts: readonly string[]): boolean {
  const said = sameWords(text);
  if (!said) return true;
  return drafts.some((d) => {
    const all = sameWords(d);
    if (all === said) return true;
    if (
      d
        .split(/\n+/)
        .map(sameWords)
        .some((p) => p === said)
    )
      return true;
    return said.length >= WITHIN_MOST && (all.includes(said) || said.includes(all));
  });
}

/**
 * A line the chat reader took from the page rather than from anyone: a picture or sticker alone, a group's member
 * count, a message headed with their own name (LinkedIn's "Amanda Herber\nAmanda: …", which is theirs), or a row of
 * LinkedIn's list of chats, whoever's chat it is ("Jennifer Jones, MHR\nYou: Hey Jennifer… Press return to go to…",
 * read into other people's chats on 17 Nov 2026).
 */
export function notSaidByHand(text: string, name: string): boolean {
  return (
    text === WORDLESS ||
    !sameWords(text) ||
    /·\s*\d[\d,.]*k?\s+members/i.test(text) ||
    (name.length > 0 && text.startsWith(`${name}\n`)) ||
    aChatListRow(text)
  );
}

/** A row of a list of chats: a name, then "You: …" or "<their first name>: …" under it, or LinkedIn's "Press return". */
function aChatListRow(text: string): boolean {
  if (/press return to go to/i.test(text)) return true;
  const row = /^([^\n]{1,80})\n([^\n:]{1,40}): /.exec(text);
  if (!row) return false;
  const first = row[1]!.trim().split(/\s+/)[0] ?? '';
  return row[2] === 'You' || (first.length > 0 && row[2] === first);
}

export interface ChatMessageSaid {
  readonly fromMe: boolean;
  readonly text: string;
  readonly at: string;
}

export interface ByHandClues {
  /** The chat's name, as read. */
  readonly name: string;
  /** What HandsFreeOS drafted for them in the last while: each send's words. */
  readonly drafts: readonly string[];
  /** When the extension sent them something: its own steps and the sends it noted. */
  readonly sentAt: readonly number[];
  /** When the person last copied a draft for them from Today. */
  readonly copiedAt: number | null;
  /** When someone last gave them back to the AI: a message from before then never takes them again. */
  readonly backAt: number | null;
  readonly now: number;
}

/**
 * The person's latest message in a chat, among those `fresh` (new since the last read), when it was theirs by hand and
 * nothing the extension sent them came after it: its time. Null when the latest is the AI's, or none counts.
 */
export function byHandAt(
  recent: readonly ChatMessageSaid[],
  fresh: (m: ChatMessageSaid) => boolean,
  clues: ByHandClues,
): number | null {
  const since = clues.now - HANDS_LOOK_BACK_DAYS * 86_400_000;
  const mine = recent.filter((m) => m.fromMe && !notSaidByHand(m.text, clues.name));
  const latest = mine.at(-1);
  if (!latest || !fresh(latest)) return null;
  const at = Date.parse(latest.at);
  if (!(at > since) || at > clues.now + 60_000) return null;
  if (clues.backAt !== null && at <= clues.backAt) return null;
  if (saysADraft(latest.text, clues.drafts)) return null;
  if (
    clues.sentAt.some((s) => Math.abs(s - at) <= HANDS_NEAR_SEND_MS || s > at + HANDS_NEAR_SEND_MS)
  )
    return null;
  if (
    clues.copiedAt !== null &&
    clues.copiedAt <= at + HANDS_NEAR_SEND_MS &&
    at - clues.copiedAt <= HANDS_COPIED_MS
  )
    return null;
  return at;
}
