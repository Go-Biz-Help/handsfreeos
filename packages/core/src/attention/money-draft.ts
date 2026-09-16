/**
 * The follow-up a person sends about their own money document (M9): the words Home puts in front of them when
 * they press Handle or Let HandsFreeOS Handle on an estimate nobody answered or an invoice nobody paid.
 *
 * **Nobody's words but the business's own.** No AI writes this: it is the document read back — its number, what
 * is owed or quoted, and the day it was due or stops being good — in one short message a person can send as it
 * is or rewrite entirely. HandsFreeOS never sends it; a person presses send.
 *
 * It also never carries a fresh payment link, because the link is signed by the worker and this is written in
 * the browser and the API, neither of which may hold that key. The one the customer was already sent still
 * works (the reference and its version don't change), so the draft points at that and offers to resend it.
 *
 * **The guard that matters:** the business's own reminder ladder texts and emails this customer about this
 * invoice on the schedule they agreed when they sent it. Two messages an hour apart about the same bill is what
 * makes a business look broken, so the draft says when the last one went out and holds the send for a day after
 * it. Browser-safe.
 */
import { plainSmsText } from '../ai-team/guardrails';
import { localInstant } from '../calendar/engine/zoned';
import { money } from '../money/format';
import { dayLabel, STOP_WORDING } from './wording';

/** A person's own follow-up about one document. */
export interface MoneyDraftInput {
  readonly kind: 'estimate_waiting' | 'invoice_overdue';
  /** The customer's first name; null when nobody recorded one. */
  readonly firstName: string | null;
  readonly businessName: string;
  /** Who is writing it: their first name, for "it's Dale at Lone Star". */
  readonly senderFirstName: string | null;
  /** What the document is for ("Ductwork repair"), when it says. */
  readonly title: string | null;
  /** "INV-1036"; null for one that somehow went out unnumbered. */
  readonly number: string | null;
  /** What is owed on an invoice, or what was quoted on an estimate. */
  readonly amountCents: number;
  /** The invoice's due day, or the estimate's last good day, as a local date (`2026-09-04`). */
  readonly day: string | null;
  readonly timeZone: string;
  readonly now: number;
  /** A first text to this number carries the STOP wording, as every other first text does. */
  readonly firstText: boolean;
}

const dayOf = (day: string, timeZone: string): string =>
  dayLabel(localInstant(day, '12:00', timeZone), timeZone);

/** "invoice INV-1036" / "your invoice", the same nouns the business's own reminders use. */
const noun = (i: MoneyDraftInput): string =>
  i.kind === 'invoice_overdue'
    ? i.number
      ? `invoice ${i.number}`
      : 'your invoice'
    : i.number
      ? `estimate ${i.number}`
      : 'your estimate';

/** "it's Dale at Lone Star HVAC", or the business alone when nobody is named. */
const from = (i: MoneyDraftInput): string =>
  i.senderFirstName?.trim()
    ? `it's ${i.senderFirstName.trim()} at ${i.businessName}`
    : `it's ${i.businessName}`;

const hello = (i: MoneyDraftInput): string => `Hi ${i.firstName?.trim() || 'there'}, ${from(i)}.`;

/** The one sentence about the money itself, which both the text and the email are built from. */
function fact(i: MoneyDraftInput): string {
  const amount = money(i.amountCents);
  const when = i.day ? dayOf(i.day, i.timeZone) : null;
  if (i.kind === 'invoice_overdue')
    return when
      ? `I'm following up on ${noun(i)} for ${amount}, which was due ${when}.`
      : `I'm following up on ${noun(i)} for ${amount}, which is still open.`;
  return when
    ? `Just checking in on ${noun(i)} for ${amount}. It's good until ${when}.`
    : `Just checking in on ${noun(i)} for ${amount}.`;
}

/** What to do about it: the link they already have, and an offer rather than a demand. */
const ask = (i: MoneyDraftInput): string =>
  i.kind === 'invoice_overdue'
    ? 'The payment link we sent still works. Let me know if you would like it again, or if something needs sorting out.'
    : 'The link we sent still works if you want to approve it. Happy to answer any questions.';

/** The text as it would go out: plain, straight apostrophes, and never a word a carrier reads as an opt-out. */
export function moneyDraftText(i: MoneyDraftInput): string {
  return plainSmsText(
    [hello(i), fact(i), ask(i), i.firstText ? STOP_WORDING : null].filter(Boolean).join(' '),
  );
}

/** The same follow-up by email, with the document's details where an email can hold them. */
export function moneyDraftEmail(i: MoneyDraftInput): { subject: string; body: string } {
  const amount = money(i.amountCents);
  const when = i.day ? dayOf(i.day, i.timeZone) : null;
  const subject =
    i.kind === 'invoice_overdue'
      ? i.number
        ? `Following up on invoice ${i.number}`
        : `Following up on your invoice`
      : i.number
        ? `Checking in on estimate ${i.number}`
        : `Checking in on your estimate`;
  const detail = [
    i.number ? `${i.kind === 'invoice_overdue' ? 'Invoice' : 'Estimate'}: ${i.number}` : null,
    i.title?.trim() ? `For: ${i.title.trim()}` : null,
    `${i.kind === 'invoice_overdue' ? 'Amount due' : 'Total'}: ${amount}`,
    when ? `${i.kind === 'invoice_overdue' ? 'Due' : 'Good through'}: ${when}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  return {
    subject,
    body: [
      `Hi ${i.firstName?.trim() || 'there'},`,
      fact(i),
      detail,
      ask(i),
      [i.senderFirstName?.trim(), i.businessName].filter(Boolean).join('\n'),
    ].join('\n\n'),
  };
}

// ---------- the business's own reminders, and not talking over them ----------

/**
 * The last thing the business's own ladder sent this customer about this invoice: one of its reminders, or the
 * invoice itself going out. Both are reasons not to write again an hour later, and a person should be told
 * which it was.
 */
export interface LastReminder {
  readonly at: string;
  readonly channel: 'sms' | 'email' | null;
  /** 'document' when it was the invoice itself; 'reminder' for a rung of the ladder. */
  readonly kind: 'document' | 'reminder';
}

/** A reminder this recently is reason enough to leave it alone until tomorrow. */
export const REMINDER_QUIET_MS = 24 * 60 * 60 * 1000;

const channelWord = (channel: LastReminder['channel']): string =>
  channel === 'sms' ? 'by text' : channel === 'email' ? 'by email' : '';

const agoWords = (ms: number): string => {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours === 1) return 'an hour ago';
  return `${hours} hours ago`;
};

/** "Your last reminder went out by text on Fri, Sep 18." — what the sheet says before it offers anything. */
export function lastReminderNote(
  last: LastReminder | null,
  now: number,
  timeZone: string,
): string | null {
  if (!last) return null;
  const at = Date.parse(last.at);
  if (!Number.isFinite(at)) return null;
  const words = channelWord(last.channel);
  const when = now - at < REMINDER_QUIET_MS ? agoWords(now - at) : `on ${dayLabel(at, timeZone)}`;
  const what =
    last.kind === 'document'
      ? 'The invoice itself went out'
      : 'Your last reminder about this invoice went out';
  return `${what}${words ? ` ${words}` : ''} ${when}.`;
}

/**
 * Why not to send another one today, or null. Money the business already chased on the schedule it agreed
 * doesn't need a person chasing it an hour later.
 */
export function tooSoonAfterReminder(
  last: LastReminder | null,
  now: number,
  timeZone: string,
): string | null {
  if (!last) return null;
  const at = Date.parse(last.at);
  if (!Number.isFinite(at) || now - at >= REMINDER_QUIET_MS) return null;
  return `${lastReminderNote(last, now, timeZone)} Give it a day before you follow up, so they don't get two messages about the same bill.`;
}
