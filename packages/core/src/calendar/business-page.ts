/**
 * The business's simple page (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, "A simple page"): the
 * booking page grown into a one-page site for a business with no website. Everything on it comes from what the
 * business already keeps, so these are only its words and the way its hours read, the same in the public page and
 * in the setup's preview of it. Browser-safe.
 */
import { formatClock } from '../messaging/quiet-hours';
import { onboardingKindFor } from '../onboarding-setup/kinds';
import type { WeeklyHours } from './config';

/**
 * What the simple page shows, as the worker's public booking route sends it (booking/page.ts) and the setup's preview
 * draws it before the page goes live.
 */
export interface BusinessPageParts {
  /** What the business does, in its own words. */
  readonly description: string;
  /** What it calls what it sells: "Services", "Menu", "How we help". */
  readonly servicesTitle: string;
  /** With a price only when the business tells customers its prices. */
  readonly services: readonly {
    readonly name: string;
    readonly description: string;
    readonly price: string | null;
  }[];
  /** Where it works, as it says it. */
  readonly area: string;
  /** "Austin, Texas", from its address. Never the street: plenty of businesses work from home. */
  readonly place: string | null;
  /** Its open hours; null when it has none set, and `hours` says them in words instead. */
  readonly openHours: WeeklyHours | null;
  readonly hours: string;
  readonly privacyPath: string;
  readonly termsPath: string;
  /** The number customers text, once the carriers have approved texting; null before. */
  readonly textTo: string | null;
  /** Its website chat's key, when that chat is on and set up for the page's address; null otherwise. */
  readonly chat: string | null;
}

/** A service as the page lists it: its price only when the business tells customers its prices. */
export const businessPageService = (
  s: { readonly name: string; readonly description: string; readonly price: string | null },
  allowPrices: boolean,
): BusinessPageParts['services'][number] => ({
  name: s.name,
  description: s.description,
  price: allowPrices && s.price?.trim() ? s.price.trim() : null,
});

export const BUSINESS_PAGE_WORDS = {
  /** The buttons under what the business does. */
  book: 'Book a time',
  call: 'Call',
  text: 'Text',
  chat: 'Chat',
  hours: 'Hours',
  area: 'Where we work',
  closed: 'Closed',
  privacy: 'Privacy policy',
  terms: 'Terms',
  /** The line at the bottom, instead of the booking page's "Booking by HandsFreeOS". */
  byline: 'Made with HandsFreeOS',
} as const;

/** Settings → Workspace's "Your page": the same switch as the setup's "Use this page". */
export const BUSINESS_PAGE_SETTINGS_WORDS = {
  title: 'Your page',
  hint: 'A one-page site made from your answers, with Book, Call, Text and Chat buttons. Handy when you don’t have a website: the phone carriers look for one before they approve texting.',
  label: 'Show your page',
  at: 'Your page is at',
  open: 'Open it',
  copied: 'Copied your page’s link',
  fill: 'What it says comes from Knowledge → Business profile and the open hours above. Change them there and the page follows.',
  turnedOn: 'Your page is live.',
  turnedOff: 'Your page is off. Its address shows your booking page again.',
  cantChange: 'Ask an owner of this business to turn your page on or off.',
} as const;

/**
 * The heading over the services: what this kind of business calls what it sells, in the business's own voice:
 * "Services", "Classes and sessions", "How we help".
 */
export const businessPageServicesTitle = (industry: string | null | undefined): string =>
  onboardingKindFor(industry).services.replace(/\byou\b/g, 'we');

export interface BusinessPageHoursRow {
  /** "Mon–Fri", "Sat". */
  readonly days: string;
  /** "7:00 AM–6:00 PM", "9:00 AM–12:00 PM, 1:00 PM–5:00 PM", or "Closed". */
  readonly times: string;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday first, the way a week of opening hours is read. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/**
 * The open hours as the page lists them: Monday first, days in a row with the same hours on one line, and the days
 * it's closed said so. None at all when it's closed every day, so the page leaves the hours out.
 */
export function businessPageHours(hours: WeeklyHours): BusinessPageHoursRow[] {
  if (!hours.length) return [];
  const timesOn = (day: number) =>
    hours
      .filter((h) => h.day === day)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((h) => `${formatClock(h.start)}–${h.end === '24:00' ? 'midnight' : formatClock(h.end)}`)
      .join(', ') || BUSINESS_PAGE_WORDS.closed;
  const rows: { from: number; to: number; times: string }[] = [];
  for (const day of WEEK) {
    const times = timesOn(day);
    const last = rows.at(-1);
    if (last && last.times === times) last.to = day;
    else rows.push({ from: day, to: day, times });
  }
  return rows.map((r) => ({
    days: r.from === r.to ? DAYS[r.from]! : `${DAYS[r.from]}–${DAYS[r.to]}`,
    times: r.times,
  }));
}
