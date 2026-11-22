/**
 * Texting rules shared by the browser (composer counter) and the server (segments on the message row,
 * keyword handling on inbound texts). No Node APIs here: '@hfos/core' exports it to the web.
 */

/** GSM 03.38 basic characters. Anything outside it (and the extension table) sends the text as UCS-2. */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
/** Extension-table characters cost two units each. */
const GSM_EXTENDED = '^{}\\[~]|€';

export interface SmsSegments {
  readonly encoding: 'gsm7' | 'ucs2';
  /** Characters as the carrier counts them (GSM units, or UTF-16 code units for UCS-2). */
  readonly units: number;
  readonly segments: number;
  /** Units that fit in each part at the current length (160/153 for GSM-7, 70/67 for UCS-2). */
  readonly perSegment: number;
}

/**
 * How many segments a text the business sends costs. The worker sends its plain form (`plainSmsText`), as Twilio's
 * Smart Encoding would anyway, so a curly apostrophe from a phone's keyboard doesn't turn a one-segment text into a
 * two-segment Unicode one. Counting the text as typed charged the business for segments it never sent. A text
 * coming in is counted as it arrived, with `smsSegments`.
 */
export function sentSmsSegments(text: string): SmsSegments {
  return smsSegments(plainSmsText(text));
}

export function smsSegments(text: string): SmsSegments {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXTENDED.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (!gsm) {
    const u = text.length;
    const segments = u === 0 ? 0 : u <= 70 ? 1 : Math.ceil(u / 67);
    return { encoding: 'ucs2', units: u, segments, perSegment: segments > 1 ? 67 : 70 };
  }
  const segments = units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153);
  return { encoding: 'gsm7', units, segments, perSegment: segments > 1 ? 153 : 160 };
}

/** A character class from code points, so no invisible characters sit in the source. */
const charClass = (...codes: number[]) => new RegExp(`[${String.fromCodePoint(...codes)}]`, 'g');
/** ‘ ’ ‚ ‛ ′ */
const SINGLE_QUOTES = charClass(0x2018, 0x2019, 0x201a, 0x201b, 0x2032);
/** “ ” „ ‟ ″ */
const DOUBLE_QUOTES = charClass(0x201c, 0x201d, 0x201e, 0x201f, 0x2033);
/** Figure dash, en dash, em dash, horizontal bar, minus sign. */
const DASHES = charClass(0x2012, 0x2013, 0x2014, 0x2015, 0x2212);
const ELLIPSIS = charClass(0x2026);
/** No-break, en, em, figure, thin, hair and narrow no-break spaces. */
const ODD_SPACES = charClass(0x00a0, 0x2002, 0x2003, 0x2007, 0x2009, 0x200a, 0x202f);
/** Zero-width space, non-joiner and joiner, word joiner, byte-order mark. */
const INVISIBLE = charClass(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff);

/**
 * The plain form of a text: curly quotes, long dashes, ellipses and odd spaces become plain ones and
 * invisible characters go, so it stays in the cheaper GSM-7 encoding. The worker sends this form, and the
 * length check counts it.
 */
export function plainSmsText(text: string): string {
  return text
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(ELLIPSIS, '...')
    .replace(ODD_SPACES, ' ')
    .replace(INVISIBLE, '')
    .split('\n')
    .map(withoutTrailingBlanks)
    .join('\n')
    .trim();
}

/**
 * A line without the spaces and tabs at its end. A loop rather than a pattern: one that looks for blanks before a
 * line break reads a long run of them again from every blank in it, which a text of nothing but spaces makes slow.
 */
function withoutTrailingBlanks(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return end === line.length ? line : line.slice(0, end);
}

export type SmsKeyword = 'stop' | 'start' | 'help';

/**
 * The carrier keywords, in one place.
 *
 * **Exported because the carrier is told these too.** A 10DLC campaign registration declares which words
 * stop, start and help, and a declaration that does not match what the code does is the kind of thing a
 * carrier audit finds. `apps/worker/src/telephony/twilio.ts` sends these arrays; nothing retypes them.
 */
export const STOP_KEYWORDS = [
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'OPTOUT',
  'REVOKE',
] as const;
export const START_KEYWORDS = ['START', 'UNSTOP', 'YES', 'SUBSCRIBE', 'OPTIN'] as const;
export const HELP_KEYWORDS = ['HELP', 'INFO'] as const;

/**
 * What a customer gets back when they text STOP, START or HELP, and so what the carriers are told they get.
 *
 * **A campaign's declared replies have to be the ones customers really receive.** STOP and START are
 * answered by Twilio's own opt-out handling before HandsFreeOS sees the text, and once a number has said
 * STOP nothing else may be sent to it, so those two are Twilio's standard wording, word for word. HELP is
 * answered by HandsFreeOS (apps/worker/src/handlers/help-reply.ts), with the business's name and a number to
 * reach it on, because that is what a reviewer texting HELP looks for.
 *
 * Twilio's Advanced Opt-Out (set up by hand in its console, for one business at a time) can change the STOP
 * and START wording; a business that has it keeps these answers in step with what it set there.
 */
export interface KeywordReplies {
  readonly stop: string;
  readonly start: string;
  readonly help: string;
}

export const TWILIO_STOP_REPLY =
  'You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.';
export const TWILIO_START_REPLY =
  'You have successfully been re-subscribed to messages from this number. Reply HELP for help. Reply STOP to unsubscribe. Msg&Data Rates May Apply.';

/**
 * The replies for one business. `business` is the name its customers know it by; `contact` is how to reach
 * it, already formatted ("(512) 555-0100").
 */
export function keywordReplies(business: string, contact: string): KeywordReplies {
  const who = business.trim().slice(0, 60) || 'This business';
  const reach = contact.trim();
  return {
    stop: TWILIO_STOP_REPLY,
    start: TWILIO_START_REPLY,
    help: (reach
      ? `${who}: for help, call or text us at ${reach}. Msg & data rates may apply. Reply STOP to stop texts.`
      : `${who}: for help, reply to this text and we'll get back to you. Msg & data rates may apply. Reply STOP to stop texts.`
    ).slice(0, 320),
  };
}

const STOP = new Set<string>(STOP_KEYWORDS);
const START = new Set<string>(START_KEYWORDS);
const HELP = new Set<string>(HELP_KEYWORDS);

/** A carrier keyword when it is the whole text (case, spaces and punctuation ignored), else null. */
export function smsKeyword(body: string): SmsKeyword | null {
  const word = body
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (!word || word.length > 12) return null;
  if (STOP.has(word)) return 'stop';
  if (START.has(word)) return 'start';
  if (HELP.has(word)) return 'help';
  return null;
}

const wordOf = (body: string) =>
  body
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

/**
 * A reply that confirms an appointment, when it is the whole text (case, spaces and punctuation ignored): C,
 * CONFIRM or CONFIRMED. Not a carrier keyword: HandsFreeOS answers it by confirming the sender's outstanding
 * asks. (CANCEL is never a way to cancel: it's STOP.)
 */
export function confirmWord(body: string): boolean {
  const word = wordOf(body);
  return word === 'C' || word === 'CONFIRM' || word === 'CONFIRMED';
}

/** YES as the whole text: START to the carriers, and also a confirmation while an ask is outstanding. */
export function yesWord(body: string): boolean {
  return wordOf(body) === 'YES';
}

/**
 * One line for the inbox list: the text itself, or what was attached. `videos` says how many of the attachments are
 * videos: when they all are, it says videos rather than photos.
 */
export function messagePreview(
  body: string | null | undefined,
  mediaCount = 0,
  videos = 0,
): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  const kind = mediaCount > 0 && videos >= mediaCount ? 'video' : 'photo';
  if (mediaCount > 1) return `Sent ${mediaCount} ${kind}s`;
  if (mediaCount === 1) return `Sent a ${kind}`;
  return '';
}
