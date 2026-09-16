/**
 * What customers read about money (M9): an estimate sent, an invoice sent, each reminder on the business's
 * schedule, a receipt, and a payment that didn't go through — each as a text and as an email.
 *
 * The rules are the booking messages' (booking/messages.ts), because they go out the same way: texts are
 * plain, straight apostrophes only (one curly one splits a text into 70-character parts), no ranges, and
 * "Reply STOP to opt out." on the first text to a number. **Never "reply CANCEL" or "reply YES"** — those are
 * the carriers' own keywords. Emails go through message.send as plain text, which the worker renders with
 * clickable links, so the customer's own link is the one thing on its own line.
 *
 * Every message carries **the customer's own link** (`/e/…` or `/i/…`, money/links.ts). It is the only place
 * they can read the document, approve it or pay it: there is no attachment and no PDF.
 *
 * **Nothing here ever says what a way of paying costs the business.** Bank transfer leads on the page because
 * it is the cheap rail, and that is the page's business alone: no message prices a way of paying, compares
 * two, or asks a customer to choose one to save anybody money. Every message says "Pay it here" and leaves
 * the choice where it belongs.
 */
import {
  dayLabel,
  localInstant,
  money,
  PAYMENT_METHOD_WORDS,
  soonLabel,
  whenLabel,
  type PaymentMethod,
  type ReminderStep,
} from '@hfos/core/server';
import {
  inSentence,
  plainSms,
  STOP_WORDING,
  withArticle,
  type EmailText,
} from '../booking/messages';

/** The business as a customer knows it on a document: its name, and a number to call about it. */
export interface MoneyBusiness {
  readonly name: string;
  readonly phoneDisplay: string | null;
}

/**
 * Which message an invoice's job is: the one that goes with the invoice itself, or one rung of the business's
 * reminder ladder. `sent` rides the same rails so one job, one record and one client id cover both.
 */
export const INVOICE_SENT_KEY = 'sent';

/** `before_3`, `on_due`, `after_7`: how a rung is named in the job's key and in the invoice's reminder state. */
export const reminderKeyOf = (step: ReminderStep): string =>
  step.when === 'on' ? 'on_due' : `${step.when}_${step.days}`;

/** How many days after the due day a rung lands (negative before it). */
export const reminderOffsetOf = (step: ReminderStep): number =>
  step.when === 'before' ? -step.days : step.when === 'after' ? step.days : 0;

const text = (parts: readonly (string | null | false | undefined)[], first: boolean): string =>
  plainSms([...parts, first ? STOP_WORDING : null].filter(Boolean).join(' '));

const paragraphs = (parts: readonly (string | null | false | undefined)[]): string =>
  parts.filter(Boolean).join('\n\n');

const lines = (parts: readonly (string | null | false)[]): string =>
  parts.filter(Boolean).join('\n');

const hello = (firstName: string) => (firstName ? `Hi ${firstName},` : 'Hi,');

const capital = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The business's line at the foot of an email: who it is from, and how to ask them about it. */
const footer = (b: MoneyBusiness): string =>
  `${b.name}${b.phoneDisplay ? ` · ${b.phoneDisplay}` : ''}`;

/** "invoice INV-1001", or "your invoice" for one that has somehow gone out unnumbered. */
export const invoiceNoun = (number: string | null): string =>
  number ? `invoice ${number}` : 'your invoice';

/** "estimate EST-1001", or "your estimate". */
export const estimateNoun = (number: string | null): string =>
  number ? `estimate ${number}` : 'your estimate';

/** "for an AC tune-up", or nothing when the document has no title. */
const forWhat = (title: string | null): string =>
  title?.trim() ? ` for ${withArticle(inSentence(title.trim()))}` : '';

/** A stored day as a moment people can read: midday where the business is, so no zone can move the date. */
const middayOf = (day: string, timeZone: string): number => localInstant(day, '12:00', timeZone);

/** "today", "tomorrow", "Fri" within the week, "Fri, Oct 24" beyond it. */
const dayWord = (day: string, now: number, timeZone: string): string =>
  soonLabel(middayOf(day, timeZone), now, timeZone);

/** "Fri, Oct 24": a day named in full, for an email's details. */
const dayFull = (day: string, timeZone: string): string =>
  dayLabel(middayOf(day, timeZone), timeZone);

// ---- The estimate ----

export interface EstimateMessageInput {
  readonly business: MoneyBusiness;
  readonly firstName: string;
  /** The number it took when it was sent. */
  readonly number: string | null;
  readonly title: string | null;
  readonly totalCents: number;
  /** The day it stops being good (a local date), or null when it never does. */
  readonly expiresOn: string | null;
  readonly timeZone: string;
  readonly now: number;
  /** The customer's own page: `${WEB_URL}/e/<token>`. */
  readonly url: string;
  /** The first text to this number: it carries the STOP wording. */
  readonly first: boolean;
}

const goodThrough = (i: EstimateMessageInput): string | null =>
  i.expiresOn ? `It's good through ${dayWord(i.expiresOn, i.now, i.timeZone)}.` : null;

/** "Lone Star HVAC: Your estimate for an AC tune-up is ready, $180. ... Approve it here: <link>" */
export function estimateSentText(i: EstimateMessageInput): string {
  return text(
    [
      `${i.business.name}: Your estimate${forWhat(i.title)} is ready, ${money(i.totalCents)}.`,
      goodThrough(i),
      `Approve it here: ${i.url}`,
    ],
    i.first,
  );
}

export function estimateSentEmail(i: EstimateMessageInput): EmailText {
  return {
    subject: i.number
      ? `Estimate ${i.number} from ${i.business.name}`
      : `Your estimate from ${i.business.name}`,
    body: paragraphs([
      `${hello(i.firstName)} here’s your estimate${forWhat(i.title)}.`,
      lines([
        i.number ? `Estimate: ${i.number}` : null,
        `Total: ${money(i.totalCents)}`,
        i.expiresOn ? `Good through: ${dayFull(i.expiresOn, i.timeZone)}` : null,
      ]),
      `Approve or decline it here: ${i.url}`,
      footer(i.business),
    ]),
  };
}

/** The one nudge a business can set: sent once, this many days after the estimate went out. */
export function estimateNudgeText(i: EstimateMessageInput): string {
  return text(
    [
      `${i.business.name}: Just checking you saw your estimate${forWhat(i.title)}, ${money(i.totalCents)}.`,
      goodThrough(i),
      `Approve it here: ${i.url}`,
    ],
    i.first,
  );
}

export function estimateNudgeEmail(i: EstimateMessageInput): EmailText {
  return {
    subject: i.number
      ? `Still thinking it over? Estimate ${i.number}`
      : `Still thinking it over? Your estimate from ${i.business.name}`,
    body: paragraphs([
      `${hello(i.firstName)} just checking you saw the estimate${forWhat(i.title)} we sent.`,
      lines([
        i.number ? `Estimate: ${i.number}` : null,
        `Total: ${money(i.totalCents)}`,
        i.expiresOn ? `Good through: ${dayFull(i.expiresOn, i.timeZone)}` : null,
      ]),
      `Approve or decline it here: ${i.url}`,
      'If the timing isn’t right, just tell us — there’s no rush.',
      footer(i.business),
    ]),
  };
}

// ---- The invoice, and its reminders ----

export interface InvoiceMessageInput {
  readonly business: MoneyBusiness;
  readonly firstName: string;
  readonly number: string | null;
  readonly title: string | null;
  readonly totalCents: number;
  /** What is still owed: the same figure the reminders chase. */
  readonly balanceCents: number;
  /** The day it is due (a local date), or null. */
  readonly dueOn: string | null;
  readonly timeZone: string;
  readonly now: number;
  /** The customer's own page: `${WEB_URL}/i/<token>`. */
  readonly url: string;
  readonly first: boolean;
}

const dueSentence = (i: InvoiceMessageInput): string | null =>
  i.dueOn ? `It's due ${dayWord(i.dueOn, i.now, i.timeZone)}.` : null;

/** "Lone Star HVAC: Invoice INV-1001 for $180 is ready. It's due Fri. Pay it here: <link>" */
export function invoiceSentText(i: InvoiceMessageInput): string {
  return text(
    [
      `${i.business.name}: ${capital(invoiceNoun(i.number))}${forWhat(i.title)} is ready, ${money(i.totalCents)}.`,
      dueSentence(i),
      `Pay it here: ${i.url}`,
    ],
    i.first,
  );
}

export function invoiceSentEmail(i: InvoiceMessageInput): EmailText {
  return {
    subject: i.number
      ? `Invoice ${i.number} from ${i.business.name}`
      : `Your invoice from ${i.business.name}`,
    body: paragraphs([
      `${hello(i.firstName)} here’s your invoice${forWhat(i.title)}.`,
      lines([
        i.number ? `Invoice: ${i.number}` : null,
        `Amount: ${money(i.totalCents)}`,
        i.balanceCents !== i.totalCents ? `Owed: ${money(i.balanceCents)}` : null,
        i.dueOn ? `Due: ${dayFull(i.dueOn, i.timeZone)}` : null,
      ]),
      `Pay it here: ${i.url}`,
      footer(i.business),
    ]),
  };
}

export interface InvoiceReminderInput extends InvoiceMessageInput {
  /** Which rung of the business's ladder this is. */
  readonly step: ReminderStep;
}

/** Each rung in its own words: before the due day, on it, and after it. */
export function invoiceReminderText(i: InvoiceReminderInput): string {
  const owed = money(i.balanceCents);
  const noun = invoiceNoun(i.number);
  const when = i.dueOn ? dayWord(i.dueOn, i.now, i.timeZone) : null;
  const lead =
    i.step.when === 'before'
      ? `${i.business.name}: A reminder that ${noun} for ${owed} is due${when ? ` ${when}` : ''}.`
      : i.step.when === 'on'
        ? `${i.business.name}: ${capital(noun)} for ${owed} is due today.`
        : `${i.business.name}: ${capital(noun)} for ${owed} was due${when ? ` ${when}` : ''} and is still unpaid.`;
  return text([lead, `Pay it here: ${i.url}`], i.first);
}

export function invoiceReminderEmail(i: InvoiceReminderInput): EmailText {
  const owed = money(i.balanceCents);
  const noun = invoiceNoun(i.number);
  const when = i.dueOn ? dayWord(i.dueOn, i.now, i.timeZone) : null;
  const subject =
    i.step.when === 'before'
      ? `${capital(noun)} is due${when ? ` ${when}` : ' soon'}`
      : i.step.when === 'on'
        ? `${capital(noun)} is due today`
        : `${capital(noun)} is past due`;
  const opening =
    i.step.when === 'before'
      ? `${hello(i.firstName)} a reminder that ${noun}${forWhat(i.title)} is due${when ? ` ${when}` : ''}.`
      : i.step.when === 'on'
        ? `${hello(i.firstName)} ${noun}${forWhat(i.title)} is due today.`
        : `${hello(i.firstName)} ${noun}${forWhat(i.title)} was due${when ? ` ${when}` : ''} and is still unpaid.`;
  return {
    subject,
    body: paragraphs([
      opening,
      lines([
        i.number ? `Invoice: ${i.number}` : null,
        `Owed: ${owed}`,
        i.dueOn ? `Due: ${dayFull(i.dueOn, i.timeZone)}` : null,
      ]),
      `Pay it here: ${i.url}`,
      'If you’ve already sent it, thank you — this crossed in the post.',
      footer(i.business),
    ]),
  };
}

// ---- The plan's card ----

export interface PlanCardMessageInput {
  readonly business: MoneyBusiness;
  readonly firstName: string;
  /**
   * **A name, not a description.** `inSentence` lowercases "Furnace repair" into a sentence because a service
   * title says what is being done; a plan is a product the business named, and "your comfort Club plan" reads
   * as a typo. Written exactly as they typed it — in the text, the email and the subject alike — with the
   * sentences around it shaped so it sits mid-sentence with its capitals intact.
   */
  readonly planName: string;
  /** "$29 a month", worked out where the plan is read, so one wording serves the text and the email. */
  readonly priceLabel: string;
  readonly includes: readonly string[];
  /** The customer's own plan page: `${WEB_URL}/p/<token>`. */
  readonly url: string;
  /** Changing a card that already works reads differently from a plan that cannot bill at all. */
  readonly replacing: boolean;
  readonly first: boolean;
}

/**
 * "Lone Star HVAC: Your Comfort Club plan is $29 a month. Add a card to start it here: <link>"
 *
 * A plan bills at the provider, and neither provider will bill a customer they have no card for. This is the
 * one message that closes that: the customer's own page, where the card goes in the provider's own fields.
 */
export function planCardText(i: PlanCardMessageInput): string {
  return text(
    [
      i.replacing
        ? `${i.business.name}: You can update the card on your ${i.planName} plan here: ${i.url}`
        : `${i.business.name}: Your ${i.planName} plan is ${i.priceLabel}.`,
      i.replacing ? null : `Add a card to start it here: ${i.url}`,
    ],
    i.first,
  );
}

export function planCardEmail(i: PlanCardMessageInput): EmailText {
  return {
    subject: i.replacing
      ? `Update the card on your ${i.planName} plan`
      : `Start your ${i.planName} plan with ${i.business.name}`,
    body: paragraphs([
      i.replacing
        ? `${hello(i.firstName)} you can put a new card on your ${i.planName} plan whenever you like — nothing changes until you do.`
        : `${hello(i.firstName)} here’s your ${i.planName} plan. Add a card and it starts straight away.`,
      lines([
        `Plan: ${i.planName}`,
        `Price: ${i.priceLabel}`,
        ...i.includes.slice(0, 6).map((what) => `· ${what}`),
      ]),
      i.replacing ? `Update your card here: ${i.url}` : `Add your card here: ${i.url}`,
      'The card is held by our payment company, never by us.',
      footer(i.business),
    ]),
  };
}

// ---- What a payment brings ----

export interface PaymentMessageInput {
  readonly business: MoneyBusiness;
  readonly firstName: string;
  /** The invoice it was against. */
  readonly number: string | null;
  readonly amountCents: number;
  /** What is left owed after it (0 when the invoice is settled). */
  readonly balanceCents: number;
  readonly method: PaymentMethod;
  /** When the money landed; null falls back to `now`. */
  readonly receivedAt: number | null;
  readonly timeZone: string;
  readonly now: number;
  readonly url: string;
  readonly first: boolean;
}

const stillOwed = (i: PaymentMessageInput): string | null =>
  i.balanceCents > 0 ? `${money(i.balanceCents)} is still owed.` : null;

/** "Lone Star HVAC: Thanks, Maria. We got your $180 payment for invoice INV-1001. Your receipt: <link>" */
export function receiptText(i: PaymentMessageInput): string {
  return text(
    [
      `${i.business.name}: Thanks${i.firstName ? `, ${i.firstName}` : ''}. We got your ${money(i.amountCents)} payment for ${invoiceNoun(i.number)}.`,
      stillOwed(i),
      `Your receipt: ${i.url}`,
    ],
    i.first,
  );
}

export function receiptEmail(i: PaymentMessageInput): EmailText {
  const at = i.receivedAt ?? i.now;
  return {
    subject: `Receipt from ${i.business.name}: ${money(i.amountCents)}`,
    body: paragraphs([
      `${hello(i.firstName)} thanks — we got your payment.`,
      lines([
        `Paid: ${money(i.amountCents)} by ${PAYMENT_METHOD_WORDS[i.method]}`,
        i.number ? `Invoice: ${i.number}` : null,
        `When: ${whenLabel(at, i.timeZone)}`,
        i.balanceCents > 0 ? `Still owed: ${money(i.balanceCents)}` : null,
      ]),
      `Your receipt: ${i.url}`,
      footer(i.business),
    ]),
  };
}

/**
 * A payment that didn't go through where nobody was watching: a bank transfer the bank sent back days later,
 * or a plan's card refused. A card declined on the page says so on the page, and gets none of this.
 */
export function paymentFailedText(i: PaymentMessageInput): string {
  return text(
    [
      `${i.business.name}: Your ${money(i.amountCents)} payment for ${invoiceNoun(i.number)} didn't go through, so nothing was taken.`,
      `You can try again here: ${i.url}`,
    ],
    i.first,
  );
}

export function paymentFailedEmail(i: PaymentMessageInput): EmailText {
  return {
    subject: `Your payment to ${i.business.name} didn’t go through`,
    body: paragraphs([
      `${hello(i.firstName)} the ${money(i.amountCents)} payment for ${invoiceNoun(i.number)} didn’t go through, so nothing was taken.`,
      lines([
        i.number ? `Invoice: ${i.number}` : null,
        `Owed: ${money(i.balanceCents > 0 ? i.balanceCents : i.amountCents)}`,
      ]),
      `You can try again here: ${i.url}`,
      footer(i.business),
    ]),
  };
}
