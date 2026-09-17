/**
 * The Action Center's words: item titles, what a customer said, a time as a card or a text says it, the confirmation
 * request HandsFreeOS sends on its own, and the next action it suggests. Browser-safe, so the preview on Home shows
 * exactly what the worker sends. Texts are plain (straight apostrophes, no dashes outside the texting alphabet); a
 * confirmation request never asks anyone to reply CANCEL (that's STOP) or YES (that's START).
 */
import { plainSmsText } from '../ai-team/guardrails';
import type { WeeklyHours } from '../calendar/config';
import {
  addDays,
  localDateOf,
  localInstant,
  weekdayOf,
  zonedParts,
} from '../calendar/engine/zoned';
import { messagePreview } from '../messaging/sms';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An item title's most characters (`attention_items.title` holds 200). */
export const TITLE_MAX = 200;
/** An item detail's most characters (the column holds 1,000; cards show a line or two). */
export const DETAIL_MAX = 300;

/** At most `max` characters on one line, with an ellipsis. */
export function clipLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** "Maria Lopez · AC replacement": the parts that are there, joined, within the title's length. */
export function itemTitle(...parts: readonly (string | null | undefined)[]): string {
  const title = clipLine(parts.filter((p): p is string => !!p?.trim()).join(' · '), TITLE_MAX);
  return title || 'Needs attention';
}

/**
 * A customer's own message in one line, as a card, the urgent email and a push quote it: a text's or chat's words,
 * an email's subject and first line, or "Sent a photo." when it had only photos. The business's messages are never
 * quoted as theirs (loadCustomerSaid picks the message).
 */
export function customerMessageLine(m: {
  readonly channel: string;
  readonly subject?: string | null;
  readonly body: string | null;
  readonly photos: number;
}): string {
  const firstLine = (m.body ?? '').split('\n').find((l) => l.trim()) ?? '';
  const words = messagePreview(
    m.channel === 'email'
      ? [m.subject?.trim(), firstLine.trim()].filter(Boolean).join(' · ')
      : m.body,
  );
  if (words) return words;
  if (m.photos > 1) return `Sent ${m.photos} photos.`;
  return m.photos === 1 ? 'Sent a photo.' : '';
}

/** "10:40 AM". */
export function clockLabel(at: number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.hour % 12 || 12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/** "Thu, Sep 17". */
export function dayLabel(at: number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${WEEKDAYS[p.weekday]}, ${MONTHS[p.month - 1]} ${p.day}`;
}

/** "Thu, Sep 17 at 10:00 AM". */
export function whenLabel(at: number, timeZone: string): string {
  return `${dayLabel(at, timeZone)} at ${clockLabel(at, timeZone)}`;
}

/** "today at 10:00 AM", "tomorrow, Fri, Sep 18 at 10:00 AM", "on Fri, Sep 18 at 10:00 AM" (as a text says it). */
export function whenFrom(at: number, now: number, timeZone: string): string {
  const day = localDateOf(at, timeZone);
  const today = localDateOf(now, timeZone);
  if (day === today) return `today at ${clockLabel(at, timeZone)}`;
  if (day === addDays(today, 1)) return `tomorrow, ${whenLabel(at, timeZone)}`;
  return `on ${whenLabel(at, timeZone)}`;
}

const LEGAL = /^(llc|inc|co|corp|company|corporation|ltd|lp|llp|pllc)\.?,?$/i;

/** "Lone Star" for "Lone Star HVAC & Roofing" (as the booking texts shorten it). */
export function shortBusinessName(name: string): string {
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

/** "furnace repair" for "Furnace repair"; "AC tune-up" keeps its capitals. */
const inSentence = (title: string): string => {
  const t = title.trim();
  return /^[A-Z][a-z]/.test(t) ? t[0]!.toLowerCase() + t.slice(1) : t;
};

export const STOP_WORDING = 'Reply STOP to opt out.';
/** What the preview shows where the worker puts the customer's own booking link. */
export const BOOKING_LINK_PLACEHOLDER = '[their booking link]';

export interface ConfirmRequestInput {
  readonly firstName: string | null;
  readonly businessName: string;
  /** The appointment's title ("AC tune-up"). */
  readonly title: string;
  readonly startsAt: number;
  readonly timeZone: string;
  /** When it goes out (for "today" and "tomorrow"). */
  readonly now: number;
  /** The business lets customers reply C to confirm (`attention.replyToConfirm`). */
  readonly replyToConfirm: boolean;
  /** Their change-or-cancel link, with its Confirm button; null in a preview. */
  readonly manageUrl: string | null;
  /** The first text to this number carries the STOP wording. */
  readonly firstText: boolean;
}

/** The one confirmation request HandsFreeOS texts on its own. */
export function confirmRequestText(i: ConfirmRequestInput): string {
  const hello = `Hi ${i.firstName?.trim() || 'there'}, it's ${shortBusinessName(i.businessName)}.`;
  const ask = `Can you confirm your ${inSentence(i.title)} ${whenFrom(i.startsAt, i.now, i.timeZone)}?`;
  const how = i.replyToConfirm
    ? 'Reply C to confirm.'
    : `Confirm here: ${i.manageUrl ?? BOOKING_LINK_PLACEHOLDER}`;
  return plainSmsText(
    [hello, ask, how, i.firstText ? STOP_WORDING : null].filter(Boolean).join(' '),
  );
}

/** The same request by email: the Confirm button lives on the booking link (email scanners never confirm). */
export function confirmRequestEmail(i: ConfirmRequestInput): { subject: string; body: string } {
  const when = whenFrom(i.startsAt, i.now, i.timeZone);
  return {
    subject: `Please confirm: ${i.title} ${when}`,
    body: [
      `Hi ${i.firstName?.trim() || 'there'},`,
      `Can you confirm your ${inSentence(i.title)} ${when}?`,
      `Confirm or change it here: ${i.manageUrl ?? BOOKING_LINK_PLACEHOLDER}`,
      i.businessName,
    ].join('\n\n'),
  };
}

/** A follow-up nudge's subject, when it goes by email. */
export function nudgeEmailSubject(businessName: string): string {
  return `Checking in from ${businessName}`;
}

/**
 * The next action HandsFreeOS suggests for a lead with none: follow up at the start of the next open day (9 AM
 * tomorrow when the business has no open hours).
 */
export function suggestedNextAction(
  firstName: string | null,
  hours: WeeklyHours,
  timeZone: string,
  now: number,
): { text: string; dueAt: string } {
  const text = `Follow up with ${firstName?.trim() || 'them'}`;
  const today = localDateOf(now, timeZone);
  for (let i = 1; i <= 14; i++) {
    const date = addDays(today, i);
    const starts = hours
      .filter((h) => h.day === weekdayOf(date))
      .map((h) => h.start)
      .sort();
    if (starts[0])
      return { text, dueAt: new Date(localInstant(date, starts[0], timeZone)).toISOString() };
  }
  return {
    text,
    dueAt: new Date(localInstant(addDays(today, 1), '09:00', timeZone)).toISOString(),
  };
}
