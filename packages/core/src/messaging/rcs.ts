/**
 * RCS (0103): the rules a rich text keeps, the same in the composer, the command and the worker. Browser-safe.
 *
 * **RCS is how a text travels, never a channel of its own.** A business with an RCS sender still texts its
 * customers in their ordinary text thread; Twilio tries RCS first and, when the customer's phone can't show it,
 * sends the same message as an SMS or MMS from the thread's own number. So everything here is about one text
 * that has two faces: the rich one (a card, a carousel, buttons to tap) and the plain one a phone without RCS
 * gets instead, with the choices written out and a number to text back for each.
 *
 * **The plain face is written here, once.** The command stores it on the message (`rich.smsText`), the worker
 * hands it to Twilio as the template's text fallback, the composer shows it before anything is sent, and a
 * customer who texts back "2" is matched against the same numbering. Four places, one function.
 */
import type { ButtonReply, RichButtonRef, RichCardRef, RichText } from '@hfos/db/schema';
import { plainSmsText } from '../ai-team/guardrails';
import { formatPhone } from '../crm/phone';
import { smsKeyword, yesWord } from './sms';

/**
 * Twilio's limits for RCS content, as tight as the tightest place they apply. A template that breaks one is
 * refused when the worker creates it — long after the person pressed Send — so the composer and the command
 * hold every message to these first.
 */
export const RCS_LIMITS = {
  /** A button's name on RCS. */
  buttonTitle: 20,
  /** Suggested replies and actions under a message (a "chip list"). */
  chips: 11,
  /** Buttons on a rich card, and on a message that carries a photo (it goes as a card). */
  cardButtons: 4,
  cardTitle: 200,
  carouselCards: { min: 2, max: 10 },
  carouselCardButtons: { min: 1, max: 2 },
  carouselCardTitle: 80,
  /** A carousel card's title and words together. */
  carouselCardText: 160,
  /** The plain face: one message's worth, the most Twilio takes in a body. */
  smsText: 1600,
} as const;

export type RichKind = RichText['kind'];
export type RichButtonType = RichButtonRef['type'];

/** A button as a person (or a workflow) describes it, before it has an id. */
export type RichButtonDraft =
  | { readonly type: 'reply'; readonly title: string }
  | { readonly type: 'link'; readonly title: string; readonly url: string }
  | { readonly type: 'call'; readonly title: string; readonly phone: string };

/** A carousel card before its picture is stored and its buttons have ids. */
export interface RichCardDraft<M> {
  readonly title?: string | null;
  readonly body: string;
  readonly media: M;
  readonly buttons: readonly RichButtonDraft[];
}

/**
 * Whether a button's name is a word carriers act on by themselves. Tapping a button sends its name as the
 * customer's reply, so a button called "Cancel" would opt the customer out of every text from this business —
 * the carriers read CANCEL as STOP — and "Help" would bring back the carrier's help message instead of an
 * answer. YES is the one exception: it is also START, but only means anything to somebody who stopped, and a
 * customer tapping a button on a text they just got hasn't.
 */
export function carrierWordTitle(title: string): boolean {
  return smsKeyword(title) !== null && !yesWord(title);
}

/** A full https address: RCS opens only those, and a carrier filter trusts nothing else in a text. */
export function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !!u.hostname && u.hostname.includes('.');
  } catch {
    return false;
  }
}

/** The part of a sender's address after `rcs:`, as people paste it: `rcs:lonestar_agent` or `lonestar_agent`. */
export function rcsSenderIdOf(value: string): string {
  return value.trim().replace(/^rcs:/i, '').trim();
}

export const RCS_SENDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,99}$/;

/** What a carrier puts in front of an RCS address: `rcs:+15551234567` for a customer, `rcs:<id>` for a sender. */
export const isRcsAddress = (value: string | null | undefined): boolean =>
  /^rcs:/i.test((value ?? '').trim());

/** A customer's phone number from an address that may be an RCS one: `rcs:+15551234567` → `+15551234567`. */
export function phoneOfAddress(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().replace(/^rcs:/i, '');
  return /^\+[1-9][0-9]{6,14}$/.test(v) ? v : null;
}

/**
 * The ids Twilio hands back when a button is tapped (`ButtonPayload`). Built from the message's own id, so a tap
 * finds the message it came from even when it is not the newest one, and numbered by type so every id in one
 * message is different: `9b1f04c2.r1` is the first reply button, `9b1f04c2.2l1` the first link on card two.
 */
export function buttonIdsFor<B extends RichButtonDraft>(
  messageId: string,
  buttons: readonly B[],
  card?: number,
): (B & { readonly id: string })[] {
  const tag = messageId.replace(/-/g, '').slice(0, 8);
  const counts = { reply: 0, link: 0, call: 0 };
  return buttons.map((b) => {
    counts[b.type] += 1;
    const letter = b.type === 'reply' ? 'r' : b.type === 'link' ? 'l' : 'c';
    return { ...b, id: `${tag}.${card ?? ''}${letter}${counts[b.type]}` };
  });
}

/** Just the fields a stored button keeps, whatever else the draft carried. */
function refOf(b: RichButtonDraft & { readonly id: string }): RichButtonRef {
  if (b.type === 'link')
    return { type: 'link', title: b.title.trim(), id: b.id, url: b.url.trim() };
  if (b.type === 'call') return { type: 'call', title: b.title.trim(), id: b.id, phone: b.phone };
  return { type: 'reply', title: b.title.trim(), id: b.id };
}

/** One reply choice, numbered the way the plain face numbers it. */
export interface ReplyChoice {
  readonly number: number;
  readonly button: RichButtonRef;
  /** What the plain face calls it: the button's name, with its card's title in front in a carousel. */
  readonly label: string;
}

/**
 * Every reply button in a rich text, numbered 1, 2, 3 … in the order they appear — card by card in a carousel.
 * The plain face lists them this way, and a customer who texts a number back is matched against this list.
 */
export function replyChoices(rich: Pick<RichText, 'kind' | 'buttons' | 'cards'>): ReplyChoice[] {
  const out: ReplyChoice[] = [];
  const add = (button: RichButtonRef, label: string) =>
    out.push({ number: out.length + 1, button, label });
  if (rich.kind === 'carousel')
    for (const card of rich.cards)
      for (const b of card.buttons)
        if (b.type === 'reply') add(b, card.title ? `${card.title}: ${b.title}` : b.title);
  if (rich.kind !== 'carousel')
    for (const b of rich.buttons) if (b.type === 'reply') add(b, b.title);
  return out;
}

/** "Book online: https://…", "Call us: (713) 555-0142": an action button as the plain face writes it. */
function actionLine(b: RichButtonRef): string | null {
  if (b.type === 'link' && b.url) return `${b.title}: ${b.url}`;
  if (b.type === 'call' && b.phone) return `${b.title}: ${formatPhone(b.phone)}`;
  return null;
}

/** "Reply 1 for Confirm or 2 for Reschedule.", or a numbered list when there are more than three. */
function choicesText(choices: readonly ReplyChoice[]): string | null {
  if (choices.length === 0) return null;
  if (choices.length <= 3) {
    const parts = choices.map((c) => `${c.number} for ${c.label}`);
    const list =
      parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`;
    return `Reply ${list}.`;
  }
  return ['Reply with a number:', ...choices.map((c) => `${c.number}. ${c.label}`)].join('\n');
}

/**
 * The plain face of a rich text: what a phone without RCS gets instead, written in the message's own words with
 * the choices listed after them. A card's title goes first; a carousel's cards are listed one to a line.
 */
export function richSmsText(
  body: string,
  rich: Pick<RichText, 'kind' | 'title' | 'buttons' | 'cards'>,
): string {
  const words = body.trim();
  const blocks: string[] = [];
  if (rich.kind === 'card' && rich.title) blocks.push(`${rich.title.trim()}\n${words}`.trim());
  else if (words) blocks.push(words);
  if (rich.kind === 'carousel') {
    const lines = rich.cards.map((c, i) => {
      const head = c.title ? `${c.title} - ${c.body}` : c.body;
      const actions = c.buttons.map(actionLine).filter((l): l is string => !!l);
      return [`${i + 1}) ${head}`, ...actions].join('\n');
    });
    if (lines.length) blocks.push(lines.join('\n'));
  } else {
    const actions = rich.buttons.map(actionLine).filter((l): l is string => !!l);
    if (actions.length) blocks.push(actions.join('\n'));
  }
  const choices = choicesText(replyChoices(rich));
  if (choices) blocks.push(choices);
  return plainSmsText(blocks.join('\n\n'));
}

/**
 * Builds the rich text a message stores: every button given its id, the plain face written. `media` is the
 * carousel's pictures, already stored, in card order (a card or a message with buttons keeps its one photo in
 * the message's own `media`, like any picture message).
 */
export function buildRichText<M extends RichCardRef['media']>(
  messageId: string,
  body: string,
  draft:
    | { readonly kind: 'buttons'; readonly buttons: readonly RichButtonDraft[] }
    | {
        readonly kind: 'card';
        readonly title: string;
        readonly buttons: readonly RichButtonDraft[];
      }
    | { readonly kind: 'carousel'; readonly cards: readonly RichCardDraft<M>[] },
): RichText {
  if (draft.kind === 'carousel') {
    const cards: RichCardRef[] = draft.cards.map((c, i) => ({
      title: c.title?.trim() || null,
      body: c.body.trim(),
      media: c.media,
      buttons: buttonIdsFor(messageId, c.buttons, i + 1).map(refOf),
    }));
    const base = { kind: 'carousel' as const, title: null, buttons: [], cards };
    return { ...base, smsText: richSmsText(body, base) };
  }
  const buttons = buttonIdsFor(messageId, draft.buttons).map(refOf);
  const base = {
    kind: draft.kind,
    title: draft.kind === 'card' ? draft.title.trim() : null,
    buttons,
    cards: [],
  };
  return { ...base, smsText: richSmsText(body, base) };
}

/** Every button of a rich text, card buttons included. */
export function allButtons(rich: Pick<RichText, 'buttons' | 'cards'>): RichButtonRef[] {
  return [...rich.buttons, ...rich.cards.flatMap((c) => c.buttons)];
}

const squash = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Which button a tap came from. Twilio hands back the id we gave it; a button that could not carry one (a call
 * button, on some phones) comes back with its name instead, so the name is the second way to find it.
 */
export function buttonForTap(
  rich: Pick<RichText, 'buttons' | 'cards'>,
  payload: string | null | undefined,
  text: string | null | undefined,
): RichButtonRef | null {
  const list = allButtons(rich);
  const id = (payload ?? '').trim();
  const byId = id ? list.find((b) => b.id === id) : undefined;
  if (byId) return byId;
  const words = squash(text ?? id);
  if (!words) return null;
  const byName = list.filter((b) => squash(b.title) === words);
  return byName.length === 1 ? byName[0]! : null;
}

/**
 * A customer who got the plain face and texted back their choice: "2", "#2", "2." or the button's own name.
 * Only a reply that is nothing but the choice counts — "2 people are coming" is a sentence, not an answer.
 */
export function choiceForText(
  rich: Pick<RichText, 'kind' | 'buttons' | 'cards'>,
  body: string,
): ReplyChoice | null {
  const choices = replyChoices(rich);
  if (choices.length === 0) return null;
  const n = /^\s*#?\s*(\d{1,2})\s*[.)!]?\s*$/.exec(body);
  if (n) return choices.find((c) => c.number === Number(n[1])) ?? null;
  const words = squash(body);
  if (!words) return null;
  const byName = choices.filter(
    (c) => squash(c.button.title) === words || squash(c.label) === words,
  );
  return byName.length === 1 ? byName[0]! : null;
}

/** The button a reply came from, as the message keeps it. */
export function buttonReplyOf(
  button: RichButtonRef,
  messageId: string | null,
  via: ButtonReply['via'],
): ButtonReply {
  return { type: button.type, title: button.title, id: button.id, messageId, via };
}

/** "RCS", "SMS", "MMS": how a text went, under it in the thread. */
export function transportWord(transport: string | null | undefined): string | null {
  if (transport === 'rcs') return 'RCS';
  if (transport === 'mms') return 'MMS';
  if (transport === 'sms') return 'SMS';
  return null;
}

/** What a customer's button reply says under it: "Tapped Confirm", or "Texted 2 for Confirm". */
export function buttonReplyLine(
  reply: Pick<ButtonReply, 'type' | 'title' | 'via'>,
  body?: string | null,
): string {
  if (reply.via === 'text') {
    const n = /\d{1,2}/.exec(body ?? '')?.[0];
    return n ? `Texted ${n} for “${reply.title}”` : `Chose “${reply.title}”`;
  }
  if (reply.type === 'link') return `Opened “${reply.title}”`;
  if (reply.type === 'call') return `Tapped “${reply.title}” to call`;
  return `Tapped “${reply.title}”`;
}

/** A short line for a rich text in lists and previews: "3 buttons", "Card", "Carousel of 4". */
export function richSummary(rich: Pick<RichText, 'kind' | 'buttons' | 'cards'>): string {
  if (rich.kind === 'carousel') return `Carousel of ${rich.cards.length}`;
  if (rich.kind === 'card') return 'Card';
  const n = rich.buttons.length;
  return n === 1 ? '1 button' : `${n} buttons`;
}
