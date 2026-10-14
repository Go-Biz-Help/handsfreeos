/**
 * What customers read about their bookings (design/m5/Messages.dc.html): the confirmation, change and cancel
 * notices, the reminders and waitlist offers, each as a text and as an email.
 *
 * Texts are plain. Straight apostrophes only (one curly one sends a text as 70-character parts), no dashes or
 * dots outside the texting alphabet, times without ranges, and "Reply STOP to opt out." on the first text to
 * a number. Emails go through message.send as plain text, which the worker renders with clickable links.
 */
import { plainSpaces, type Reminder } from '@hfos/core/server';
import {
  clock,
  dayLong,
  dayShort,
  hoursLabel,
  lengthLabel,
  relativeDay,
  sameLocalDay,
  timeRange,
  zoneName,
} from './when';

export interface Business {
  readonly name: string;
  readonly phone: string | null;
  readonly phoneDisplay: string | null;
  /** The calendar's public booking page, when customers can book it online. */
  readonly bookingUrl: string | null;
}

export interface Visit {
  readonly title: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly timeZone: string;
  readonly kind: 'booking' | 'session';
  readonly seats: number;
  readonly locationKind: string | null;
  /** The street address (the customer's, or the business's), when there is one. */
  readonly address: string | null;
  readonly meetingUrl: string | null;
  /** The call is recorded and transcribed (Zoom with Record and transcribe on): the customer is told. */
  readonly recorded?: boolean;
  /** First names of the people who come, the host first. */
  readonly staff: readonly string[];
}

export interface Policies {
  readonly cancel: { readonly allowed: boolean; readonly cutoffHours: number };
  readonly reschedule: { readonly allowed: boolean; readonly cutoffHours: number };
}

export interface EmailText {
  readonly subject: string;
  readonly body: string;
}

export const STOP_WORDING = 'Reply STOP to opt out.';
/**
 * How the day-before text asks for a confirmation (M8). Never "reply YES" or "reply CANCEL": those are the
 * carriers' START and STOP.
 */
export const CONFIRM_WORDING = 'Reply C to confirm.';
/** The manage page with its Confirm button pointed at, never pressed (email scanners open links). */
export const confirmLink = (manageUrl: string): string => `${manageUrl}?confirm=1`;

/** Plain characters for a text: straight quotes, plain dashes and spaces. */
export function plainSms(text: string): string {
  return plainSpaces(
    text
      .replace(/[\u2018\u2019\u201a\u02bc\u2032]/g, "'")
      .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
      .replace(/[\u2013\u2014\u2212]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u00b7/g, '-'),
  );
}

const text = (parts: readonly (string | null | false | undefined)[], first: boolean): string =>
  plainSms([...parts, first ? STOP_WORDING : null].filter(Boolean).join(' '));

const paragraphs = (parts: readonly (string | null | false | undefined)[]): string =>
  parts.filter(Boolean).join('\n\n');

/** "furnace repair" for "Furnace repair"; "AC tune-up" keeps its capitals. */
export function inSentence(title: string): string {
  const t = title.trim();
  return /^[A-Z][a-z]/.test(t) ? t[0]!.toLowerCase() + t.slice(1) : t;
}

/** "an AC tune-up", "a furnace repair", "an HVAC class". */
export function withArticle(phrase: string): string {
  const first = phrase.trim().split(/\s+/)[0] ?? '';
  const acronym = /^[A-Z0-9]{2,}$/.test(first);
  const an = acronym ? /^[AEFHILMNORSX8]/.test(first) : /^[aeiou]/i.test(first);
  return `${an ? 'an' : 'a'} ${phrase.trim()}`;
}

/** "Priya", "Priya and Marco", "Ana, Priya and Marco". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const LEGAL = /^(llc|inc|co|corp|company|corporation|ltd|lp|llp|pllc)\.?,?$/i;

/**
 * "Lone Star" for "Lone Star HVAC & Roofing": the name before any "&" or "and", less trailing trade letters
 * (HVAC) and legal words (LLC, Inc.). A name that would come out empty stays whole.
 */
export function shortBusiness(name: string): string {
  const full = name.trim();
  let words = full.split(/\s+/);
  const cut = words.findIndex((w, i) => i > 0 && (w === '&' || w.toLowerCase() === 'and'));
  if (cut > 0) words = words.slice(0, cut);
  while (words.length > 1) {
    const last = words[words.length - 1]!;
    if (LEGAL.test(last) || /^[A-Z0-9]{2,}$/.test(last.replace(/[.,]$/, ''))) words.pop();
    else break;
  }
  return words.join(' ').replace(/[,]$/, '') || full;
}

/** "Priya from Lone Star", or null when nobody is named. */
export function whoFrom(staff: readonly string[], business: string): string | null {
  return staff.length ? `${joinNames(staff)} from ${shortBusiness(business)}` : null;
}

const streetOf = (address: string): string => address.split(',')[0]!.trim();
const be = (staff: readonly string[]) => (staff.length > 1 ? 'are' : 'is');

/** Where it is, for an email's details. */
export function whereLine(v: Visit): string | null {
  if (v.locationKind === 'customer_address') return v.address ?? 'At your address';
  if (v.locationKind === 'business') return v.address;
  if (v.locationKind === 'virtual')
    return `${v.meetingUrl ? `Online: ${v.meetingUrl}` : 'Online'}${v.recorded ? ' (this call is recorded and transcribed)' : ''}`;
  if (v.locationKind === 'phone') return 'By phone';
  return v.address;
}

function whatLine(v: Visit): string {
  const size =
    v.kind === 'session' || v.seats > 1
      ? `${v.seats} ${v.seats === 1 ? 'seat' : 'seats'}`
      : lengthLabel(Math.round((v.endsAt - v.startsAt) / 60_000));
  return `${v.title} · ${size}`;
}

const whenLine = (v: Visit): string =>
  `${dayLong(v.startsAt, v.timeZone)}, ${timeRange(v.startsAt, v.endsAt, v.timeZone)} ${zoneName(v.timeZone, 'long', v.startsAt)}`;

/** What, When, Where and Who, one per line. */
function details(v: Visit, b: Business): string {
  const where = whereLine(v);
  const who = whoFrom(v.staff, b.name);
  return [
    `What: ${whatLine(v)}`,
    `When: ${whenLine(v)}`,
    where ? `Where: ${where}` : null,
    who ? `Who: ${who}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

const footer = (b: Business): string =>
  `${b.name}${b.phoneDisplay ? ` · ${b.phoneDisplay}` : ''}\nBooking by HandsFreeOS`;

const upTo = (h: number): string => (h > 0 ? `up to ${hoursLabel(h)} before` : 'up to the start');

/** "You can change or cancel up to 24 hours before. After that, call us at (713) 555-0100." */
export function policyLine(p: Policies, b: Business): string {
  const call = b.phoneDisplay ? `call us at ${b.phoneDisplay}` : `contact ${b.name}`;
  const { reschedule: r, cancel: c } = p;
  if (!r.allowed && !c.allowed) return `To change or cancel, ${call}.`;
  const can =
    r.allowed && c.allowed
      ? r.cutoffHours === c.cutoffHours
        ? `You can change or cancel ${upTo(r.cutoffHours)}.`
        : `You can change it ${upTo(r.cutoffHours)} and cancel ${upTo(c.cutoffHours)}.`
      : r.allowed
        ? `You can change it ${upTo(r.cutoffHours)}.`
        : `You can cancel ${upTo(c.cutoffHours)}.`;
  return `${can} After that, ${call}.`;
}

const hello = (firstName: string) => (firstName ? `Hi ${firstName},` : 'Hi,');

// ---- The confirmation ----

export interface ConfirmationInput {
  readonly visit: Visit;
  readonly business: Business;
  readonly firstName: string;
  readonly manageUrl: string | null;
  /** The booking's calendar file (Apple Calendar, Outlook, anything that opens .ics). */
  readonly icsUrl: string | null;
  readonly policies: Policies;
  /** Booked into a session from its waitlist. */
  readonly fromWaitlist: boolean;
  /** The first text to this number: it carries the STOP wording. */
  readonly first: boolean;
}

export function confirmationText(i: ConfirmationInput): string {
  const v = i.visit;
  const tz = v.timeZone;
  const lead = i.fromWaitlist ? "A seat opened, so you're booked for" : "You're booked for";
  const seats = v.seats > 1 ? ` (${v.seats} seats)` : '';
  return text(
    [
      `${i.business.name}: ${lead} ${withArticle(inSentence(v.title))}${seats} on ${dayShort(v.startsAt, tz)} at ${clock(v.startsAt, tz)} ${zoneName(tz, 'short', v.startsAt)}.`,
      i.manageUrl && `Change or cancel: ${i.manageUrl}`,
    ],
    i.first,
  );
}

export function confirmationEmail(i: ConfirmationInput): EmailText {
  const v = i.visit;
  const tz = v.timeZone;
  const name = i.firstName ? `, ${i.firstName}` : '';
  return {
    subject: `You’re booked: ${v.title} on ${dayShort(v.startsAt, tz)} at ${clock(v.startsAt, tz)}`,
    body: paragraphs([
      i.fromWaitlist ? `A seat opened, so you’re booked${name}.` : `You’re booked${name}`,
      details(v, i.business),
      i.manageUrl &&
        [
          `Change or cancel: ${i.manageUrl}`,
          i.icsUrl ? `Add it to your calendar: ${i.icsUrl}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      i.manageUrl && policyLine(i.policies, i.business),
      footer(i.business),
    ]),
  };
}

// ---- Change and cancel notices ----

export interface MovedInput {
  readonly visit: Visit;
  readonly business: Business;
  readonly firstName: string;
  /** Where it was. */
  readonly from: number | null;
  readonly manageUrl: string | null;
  readonly icsUrl: string | null;
  readonly policies: Policies;
  readonly first: boolean;
}

export function movedText(i: MovedInput): string {
  const v = i.visit;
  const tz = v.timeZone;
  return text(
    [
      `${i.business.name}: Your ${inSentence(v.title)} is now ${dayShort(v.startsAt, tz)} at ${clock(v.startsAt, tz)} ${zoneName(tz, 'short', v.startsAt)}.`,
      i.manageUrl && `Change or cancel: ${i.manageUrl}`,
    ],
    i.first,
  );
}

export function movedEmail(i: MovedInput): EmailText {
  const v = i.visit;
  const tz = v.timeZone;
  const was = i.from ? ` It was ${dayLong(i.from, tz)} at ${clock(i.from, tz)}.` : '';
  return {
    subject: `Moved: ${v.title} is now ${dayShort(v.startsAt, tz)} at ${clock(v.startsAt, tz)}`,
    body: paragraphs([
      `${hello(i.firstName)} your ${inSentence(v.title)} moved to ${whenLine(v)}.${was}`,
      details(v, i.business),
      i.manageUrl &&
        [
          `Change or cancel: ${i.manageUrl}`,
          i.icsUrl ? `Add it to your calendar: ${i.icsUrl}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      i.manageUrl && policyLine(i.policies, i.business),
      footer(i.business),
    ]),
  };
}

export interface ReassignedInput {
  readonly visit: Visit;
  readonly business: Business;
  readonly firstName: string;
  readonly manageUrl: string | null;
  readonly first: boolean;
}

export function reassignedText(i: ReassignedInput): string {
  const v = i.visit;
  const tz = v.timeZone;
  const t = inSentence(v.title);
  const who = joinNames(v.staff);
  const at = `${dayShort(v.startsAt, tz)} at ${clock(v.startsAt, tz)} ${zoneName(tz, 'short', v.startsAt)}`;
  return text(
    [
      v.locationKind === 'customer_address'
        ? `${i.business.name}: ${who} ${be(v.staff)} now coming for your ${t} on ${at}.`
        : `${i.business.name}: Your ${t} on ${at} is now with ${who}.`,
      i.manageUrl && `Change or cancel: ${i.manageUrl}`,
    ],
    i.first,
  );
}

export function reassignedEmail(i: ReassignedInput): EmailText {
  const v = i.visit;
  const tz = v.timeZone;
  const t = inSentence(v.title);
  const who = joinNames(v.staff);
  return {
    subject: `Update: ${v.title} on ${dayShort(v.startsAt, tz)} at ${clock(v.startsAt, tz)}`,
    body: paragraphs([
      v.locationKind === 'customer_address'
        ? `${hello(i.firstName)} ${who} ${be(v.staff)} now coming for your ${t} on ${whenLine(v)}.`
        : `${hello(i.firstName)} your ${t} on ${whenLine(v)} is now with ${who}.`,
      details(v, i.business),
      i.manageUrl && `Change or cancel: ${i.manageUrl}`,
      footer(i.business),
    ]),
  };
}

export interface CancelledInput {
  readonly visit: Visit;
  readonly business: Business;
  readonly firstName: string;
  /** They cancelled it themselves, online. */
  readonly byCustomer: boolean;
  readonly first: boolean;
  /** Repeat visits after this one cancelled with it: one notice says so, rather than a text for each. */
  readonly laterToo?: number;
}

const laterLine = (n: number | undefined): string =>
  n ? ` So ${n === 1 ? 'is the visit' : `are the ${n} visits`} after it.` : '';

export function cancelledText(i: CancelledInput): string {
  const v = i.visit;
  const tz = v.timeZone;
  const b = i.business;
  return text(
    [
      `${b.name}: Your ${inSentence(v.title)} on ${dayShort(v.startsAt, tz)} at ${clock(v.startsAt, tz)} ${zoneName(tz, 'short', v.startsAt)} is cancelled.${laterLine(i.laterToo)}`,
      b.bookingUrl
        ? `Book again: ${b.bookingUrl}`
        : b.phoneDisplay
          ? `Questions? Call ${b.phoneDisplay}.`
          : null,
    ],
    i.first,
  );
}

export function cancelledEmail(i: CancelledInput): EmailText {
  const v = i.visit;
  const tz = v.timeZone;
  const b = i.business;
  return {
    subject: `Cancelled: ${v.title} on ${dayShort(v.startsAt, tz)} at ${clock(v.startsAt, tz)}`,
    body: paragraphs([
      `${hello(i.firstName)} your ${inSentence(v.title)} on ${whenLine(v)} is cancelled.${laterLine(i.laterToo)}${i.byCustomer ? ' You cancelled it online.' : ''}`,
      b.bookingUrl
        ? `Book another time: ${b.bookingUrl}`
        : b.phoneDisplay
          ? `Questions? Call us at ${b.phoneDisplay}.`
          : null,
      footer(b),
    ]),
  };
}

// ---- Reminders ----

export interface ReminderInput {
  readonly reminder: Reminder;
  readonly visit: Visit;
  readonly business: Business;
  readonly firstName: string;
  /** When it goes out (for "today" and "tomorrow"). */
  readonly now: number;
  readonly manageUrl: string | null;
  readonly first: boolean;
  /** Why an email came instead of a text ("Sent by email because Sarah didn’t ask for texts."). */
  readonly why: string | null;
  /**
   * The day-before reminder asks them to confirm (a one-on-one booking not yet confirmed, with the business's
   * "Reply C to confirm" on): the text ends "Reply C to confirm.", the email carries a Confirm link.
   */
  readonly askToConfirm?: boolean;
}

/** "today at 10:00 AM", "tomorrow, Fri, Sep 18 at 10:00 AM" ("tomorrow at 10:00 AM" in a subject), or "on Fri, Sep 18 at 10:00 AM". */
function whenFrom(at: number, now: number, tz: string, style: 'text' | 'subject'): string {
  const rel = relativeDay(at, now, tz);
  if (rel === 'today') return `today at ${clock(at, tz)}`;
  if (rel === 'tomorrow')
    return style === 'subject'
      ? `tomorrow at ${clock(at, tz)}`
      : `tomorrow, ${dayShort(at, tz)} at ${clock(at, tz)}`;
  return `on ${dayShort(at, tz)} at ${clock(at, tz)}`;
}

export function reminderText(i: ReminderInput): string {
  const v = i.visit;
  const tz = v.timeZone;
  const b = i.business;
  const t = inSentence(v.title);
  const who = v.staff.length ? joinNames(v.staff) : null;
  const when = whenFrom(v.startsAt, i.now, tz, 'text');
  const visit = v.locationKind === 'customer_address';
  const joinLink =
    v.locationKind === 'virtual' && v.meetingUrl ? `Join here: ${v.meetingUrl}` : null;
  if (i.reminder.kind === 'day_before') {
    const place = visit
      ? who
        ? `${who} ${be(v.staff)} coming${v.address ? ` to ${streetOf(v.address)}` : ''}.`
        : null
      : v.locationKind === 'business' && v.address
        ? `See you at ${streetOf(v.address)}.`
        : v.locationKind === 'phone' && who
          ? `${who} will call you.`
          : joinLink;
    return text(
      [`Reminder from ${b.name}: your ${t} is ${when}.`, place, i.askToConfirm && CONFIRM_WORDING],
      i.first,
    );
  }
  const lead =
    visit && who
      ? `${b.name}: ${who} ${be(v.staff)} coming ${when} for your ${t}.`
      : `${b.name}: Your ${t}${who ? ` with ${who}` : ''} is ${when}${v.locationKind === 'business' && v.address ? ` at ${streetOf(v.address)}` : ''}.`;
  return text(
    [lead, joinLink, b.phoneDisplay ? `Questions? Call ${b.phoneDisplay}.` : null],
    i.first,
  );
}

export function reminderEmail(i: ReminderInput): EmailText {
  const v = i.visit;
  const tz = v.timeZone;
  const t = inSentence(v.title);
  const rel = relativeDay(v.startsAt, i.now, tz);
  const who = v.staff.length ? joinNames(v.staff) : null;
  const place =
    (v.locationKind === 'customer_address' || v.locationKind === 'business') && v.address
      ? `, at ${v.address}`
      : v.locationKind === 'virtual'
        ? v.meetingUrl
          ? `, online at ${v.meetingUrl}`
          : ', online'
        : v.locationKind === 'phone'
          ? ', by phone'
          : '';
  const whoSentence = !who
    ? ''
    : v.locationKind === 'customer_address'
      ? ` ${who} ${be(v.staff)} coming.`
      : v.locationKind === 'phone'
        ? ` ${who} will call you.`
        : ` You’ll meet with ${who}.`;
  return {
    subject: `Reminder: ${v.title} ${whenFrom(v.startsAt, i.now, tz, 'subject')}`,
    body: paragraphs([
      `${hello(i.firstName)} your ${t} is ${rel ? `${rel}, ` : 'on '}${whenLine(v)}${place}.${whoSentence}`,
      i.askToConfirm &&
        i.reminder.kind === 'day_before' &&
        i.manageUrl &&
        `Will this time work? Confirm here: ${confirmLink(i.manageUrl)}`,
      i.manageUrl && `Change or cancel: ${i.manageUrl}`,
      i.why,
      footer(i.business),
    ]),
  };
}

// ---- After a customer confirms by text ----

export interface ConfirmedThanksInput {
  /** The bookings the reply confirmed, soonest first (one C answers every open ask for the number). */
  readonly startsAt: readonly number[];
  readonly timeZone: string;
  readonly firstName: string;
  /** When it goes out (for "today" and "tomorrow"). */
  readonly now: number;
  readonly first: boolean;
}

/** "Thanks, Denise. You're confirmed for tomorrow at 10:00 AM." (design/m8 Confirm). */
export function confirmedThanksText(i: ConfirmedThanksInput): string {
  const tz = i.timeZone;
  const when = (at: number) =>
    `${relativeDay(at, i.now, tz) ?? dayShort(at, tz)} at ${clock(at, tz)}`;
  return text(
    [
      `Thanks${i.firstName ? `, ${i.firstName}` : ''}. You're confirmed for ${joinNames(i.startsAt.map(when))}.`,
    ],
    i.first,
  );
}

/** The line a reminder email ends with when it came instead of a text, or null. */
export function emailInsteadWhy(reason: string | null, firstName: string): string | null {
  const who = firstName || 'you';
  if (reason === 'no_consent') return `Sent by email because ${who} didn’t ask for texts.`;
  if (reason === 'opted_out') return `Sent by email because ${who} asked us not to text.`;
  if (reason === 'quiet_hours') return 'Sent by email because it’s too early to text.';
  return null;
}

// ---- Waitlist offers ----

export interface OfferInput {
  readonly title: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly timeZone: string;
  /** When the hold runs out. */
  readonly until: number;
  readonly now: number;
  readonly url: string;
  readonly business: Business;
  readonly firstName: string;
  readonly first: boolean;
}

const untilText = (i: OfferInput) =>
  sameLocalDay(i.until, i.now, i.timeZone)
    ? clock(i.until, i.timeZone)
    : `${dayShort(i.until, i.timeZone)} at ${clock(i.until, i.timeZone)}`;

export function offerText(i: OfferInput): string {
  const tz = i.timeZone;
  return text(
    [
      `${i.business.name}: ${withArticle(inSentence(i.title))} time opened on ${dayShort(i.startsAt, tz)} at ${clock(i.startsAt, tz)}. It's held for you until ${untilText(i)}: ${i.url}`,
    ],
    i.first,
  );
}

export function offerEmail(i: OfferInput): EmailText {
  const tz = i.timeZone;
  return {
    subject: `A time opened: ${i.title} on ${dayShort(i.startsAt, tz)} at ${clock(i.startsAt, tz)}`,
    body: paragraphs([
      `${hello(i.firstName)} ${withArticle(inSentence(i.title))} time opened: ${dayLong(i.startsAt, tz)}, ${timeRange(i.startsAt, i.endsAt, tz)} ${zoneName(tz, 'long', i.startsAt)}. We’re holding it for you until ${untilText(i)}.`,
      `Book it: ${i.url}`,
      'If you don’t want it, there’s nothing to do. We’ll offer it to the next person after that.',
      footer(i.business),
    ]),
  };
}
