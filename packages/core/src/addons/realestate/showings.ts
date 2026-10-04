/**
 * Showings of our listings (round five, step 8), in words, and the seller's open times. Browser-safe and pure: the
 * agent's page, the listing's public page, the seller's portal and the Assistant say the same thing.
 *
 * Chris decided (2026-10-02): a buyer's agent asks for one of the seller's open times on the listing's page; the
 * seller says yes in their portal unless the listing confirms on its own; the access instructions go only to that
 * agent, just before; a feedback link after. ShowingTime's emails are read into the same showings, to be checked.
 */
import { localDateOf, localInstant, zonedParts } from '../../calendar/engine/zoned';
import { intlTimeZone } from '../../intl/engine-zones';

export const SHOWING_STATES = {
  requested: 'Waiting on the seller',
  confirmed: 'Confirmed',
  declined: 'Declined',
  cancelled: 'Cancelled',
  done: 'Done',
} as const;
export type ShowingState = keyof typeof SHOWING_STATES;
export const SHOWING_STATE_KEYS = Object.keys(SHOWING_STATES) as [ShowingState, ...ShowingState[]];
/** Still ahead: it holds its time. */
export const SHOWING_HOLDS: readonly ShowingState[] = ['requested', 'confirmed'];

export const SHOWING_SOURCES = {
  page: 'Our page',
  showingtime: 'ShowingTime email',
  agent: 'Added by hand',
} as const;
export type ShowingSource = keyof typeof SHOWING_SOURCES;
export const SHOWING_SOURCE_KEYS = Object.keys(SHOWING_SOURCES) as [
  ShowingSource,
  ...ShowingSource[],
];

export const PRICE_FEELS = { low: 'Low', right: 'About right', high: 'High' } as const;
export type PriceFeel = keyof typeof PRICE_FEELS;
export const PRICE_FEEL_KEYS = Object.keys(PRICE_FEELS) as [PriceFeel, ...PriceFeel[]];

export const SHOWING_CONFIRMS = {
  seller: 'The seller says yes in their portal',
  auto: 'Confirmed on its own',
} as const;
export type ShowingConfirm = keyof typeof SHOWING_CONFIRMS;

/** What a buyer's agent said after a showing. */
export interface ShowingFeedback {
  /** Their buyers' interest, 1 to 5. */
  readonly interest: number | null;
  readonly liked: string | null;
  readonly pause: string | null;
  readonly price: PriceFeel | null;
}

/** How showings work on a listing. */
export interface ShowingSettings {
  readonly open: boolean;
  readonly confirm: ShowingConfirm;
  /** The days of the week the seller is open to them, 0 for Sunday. */
  readonly days: readonly number[];
  /** 'HH:MM', in the business's time zone. */
  readonly from: string;
  readonly to: string;
  readonly minutes: number;
  readonly accessHours: number;
  readonly feedbackHours: number;
}

/** A listing's own columns for how showings work on it, as the server and the phone read them. */
export interface ListingShowingColumns {
  readonly showingsOpen: boolean | null;
  readonly showingConfirm: ShowingConfirm | null;
  readonly showingDays: readonly number[] | null;
  /** 'HH:MM' or Postgres's 'HH:MM:SS'. */
  readonly showingFrom: string | null;
  readonly showingTo: string | null;
  readonly showingMinutes: number | null;
  readonly showingAccessHours: number | null;
  readonly showingFeedbackHours: number | null;
}

/** How showings work on a listing, with the defaults until they're set. How to get in is the server's alone. */
export function showingSettingsOf(
  l: ListingShowingColumns | null,
): Omit<ShowingSettings, 'days'> & { days: number[] } {
  return {
    open: l?.showingsOpen ?? true,
    confirm: l?.showingConfirm ?? 'seller',
    days: [...(l?.showingDays ?? [0, 1, 2, 3, 4, 5, 6])].sort(),
    from: (l?.showingFrom ?? '10:00').slice(0, 5),
    to: (l?.showingTo ?? '18:00').slice(0, 5),
    minutes: l?.showingMinutes ?? 30,
    accessHours: l?.showingAccessHours ?? 1,
    feedbackHours: l?.showingFeedbackHours ?? 1,
  };
}

/** Where a showing stands, for the agent: "Waiting on Maria". */
export function showingStateWords(state: ShowingState, sellerFirstName: string | null): string {
  return state === 'requested' && sellerFirstName
    ? `Waiting on ${sellerFirstName}`
    : SHOWING_STATES[state];
}

/** "Fri, Oct 9 · 2:00 PM" in the business's time zone. */
export function showingWhen(at: Date | string | number, timeZone: string): string {
  const t = new Date(at);
  const day = t.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: intlTimeZone(timeZone),
  });
  const clock = t.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: intlTimeZone(timeZone),
  });
  return `${day} · ${clock}`;
}

const DAY_MS = 86_400_000;
/** How far ahead the page offers times, and how soon a time may be. */
export const SHOWING_DAYS_AHEAD = 7;
export const SHOWING_NOTICE_MINUTES = 60;

/**
 * The seller's open times for the next week: each slot of the listing's length inside its hours on its days, an
 * hour's notice at least, and none that overlaps a showing already asked for or confirmed.
 */
export function openShowingTimes(
  settings: Pick<ShowingSettings, 'days' | 'from' | 'to' | 'minutes'>,
  timeZone: string,
  taken: readonly { readonly startsAt: Date | string; readonly endsAt: Date | string }[],
  now = Date.now(),
): string[] {
  const busy = taken.map((t) => [new Date(t.startsAt).getTime(), new Date(t.endsAt).getTime()]);
  const step = settings.minutes * 60_000;
  const earliest = now + SHOWING_NOTICE_MINUTES * 60_000;
  const out: string[] = [];
  for (let d = 0; d <= SHOWING_DAYS_AHEAD; d++) {
    const date = localDateOf(now + d * DAY_MS, timeZone);
    const weekday = zonedParts(localInstant(date, '12:00', timeZone), timeZone).weekday;
    if (!settings.days.includes(weekday)) continue;
    const opens = localInstant(date, settings.from.slice(0, 5), timeZone);
    const closes = localInstant(date, settings.to.slice(0, 5), timeZone);
    for (let at = opens; at + step <= closes; at += step) {
      if (at < earliest) continue;
      if (busy.some(([s, e]) => at < e! && at + step > s!)) continue;
      out.push(new Date(at).toISOString());
    }
  }
  return [...new Set(out)];
}

/** What buyers said, counted: how many showings, how many answered, the average interest, how the price felt. */
export function feedbackSummary(
  showings: readonly { readonly state: ShowingState; readonly feedback: ShowingFeedback | null }[],
): {
  readonly showings: number;
  readonly answered: number;
  readonly averageInterest: number | null;
  readonly price: Readonly<Record<PriceFeel, number>>;
  readonly words: string;
} {
  const held = showings.filter((s) => s.state === 'done' || s.state === 'confirmed');
  const answered = showings.filter((s) => s.feedback);
  const ratings = answered
    .map((s) => s.feedback!.interest)
    .filter((n): n is number => typeof n === 'number');
  const price = { low: 0, right: 0, high: 0 };
  for (const s of answered) if (s.feedback!.price) price[s.feedback!.price] += 1;
  const average = ratings.length
    ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
    : null;
  return {
    showings: held.length,
    answered: answered.length,
    averageInterest: average,
    price,
    words: `${held.length} ${held.length === 1 ? 'showing' : 'showings'} · ${answered.length} answered`,
  };
}

/** "3.5 of 5 on average" */
export const interestWords = (average: number | null) =>
  average === null ? 'No ratings yet' : `${average} of 5 on average`;

/** The themes the AI drew from buyers' words: each with how many said it, and their words. */
export interface ShowingThemes {
  readonly liked: readonly ShowingTheme[];
  readonly disliked: readonly ShowingTheme[];
}
export interface ShowingTheme {
  readonly theme: string;
  readonly count: number;
  readonly quotes: readonly string[];
}

/** "The patio and the oaks (3), the main-floor suite (2)" */
export const themesWords = (themes: readonly ShowingTheme[]) =>
  themes.length
    ? themes
        .map(
          (t, i) =>
            `${i === 0 ? t.theme : t.theme.charAt(0).toLowerCase() + t.theme.slice(1)} (${t.count})`,
        )
        .join(', ')
    : 'Nothing yet';
