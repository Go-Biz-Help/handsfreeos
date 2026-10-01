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
