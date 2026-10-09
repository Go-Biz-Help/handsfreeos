/**
 * The public booking page's calls to the worker's /public routes. No token: customers are signed out.
 *
 * The page's shell (the site and a calendar's settings) is read on the server, cached for 30 seconds in
 * production so a busy page doesn't spend the worker's per-address limits. Open times, bookings and the
 * change-or-cancel page are asked from the customer's own browser, so those limits count per customer.
 */
import type { BusinessPageParts } from '@hfos/core';
import { notFound } from 'next/navigation';
import { publicEnv } from '../env';
import { ApiError } from './errors';

export interface PublicBusiness {
  readonly name: string;
  readonly phone: string | null;
  readonly phoneDisplay: string | null;
  /** The separate box for offers under "Text me", for a business that sends them. */
  readonly offersConsent?: { readonly title: string; readonly detail: string } | null;
  /**
   * Its logo and colour (the worker's look/public.ts); a page without them draws the initials in HandsFreeOS's
   * blue.
   */
  readonly look?: {
    readonly logo: { readonly url: string; readonly width: number; readonly height: number } | null;
    /** As picked (#rrggbb); the buttons are worked out from it (`brandLook`). */
    readonly color: string | null;
  };
}

export interface PublicSite {
  readonly business: PublicBusiness;
  readonly site: {
    readonly slug: string;
    readonly name: string;
    readonly intro: string | null;
    readonly enabled: boolean;
  };
  readonly timezone: string;
  readonly timezoneLabel: string;
  readonly calendars: readonly {
    readonly slug: string;
    readonly name: string;
    readonly description: string | null;
  }[];
  /** The simple page, while the business has it on: the booking page grown into a one-page site. */
  readonly page: PublicBusinessPage | null;
}

/**
 * What the simple page shows (the worker's booking/page.ts), all from what the business keeps: Knowledge → Business
 * profile, its open hours and address, and its privacy policy and terms.
 */
export type PublicBusinessPage = BusinessPageParts;

export type LocationKind = 'customer_address' | 'business' | 'virtual' | 'phone';

export interface IntakeQuestion {
  readonly id: string;
  readonly label: string;
  readonly kind:
    'short_text' | 'long_text' | 'select' | 'multi_select' | 'checkbox' | 'number' | 'date';
  readonly required: boolean;
  readonly options: readonly string[];
}

export interface PublicService {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** For display only. */
  readonly priceCents: number | null;
  readonly durations: readonly number[];
}

export interface BookingInfo {
  readonly services: readonly PublicService[];
  /** Lengths when there are no services. */
  readonly durations: readonly number[];
  /** Filled when customers pick who comes. */
  readonly people: readonly { readonly id: string; readonly name: string }[];
  readonly locations: readonly {
    readonly kind: LocationKind;
    readonly label: string;
    readonly address: string | null;
  }[];
  readonly customerChoosesLocation: boolean;
  readonly intake: readonly IntakeQuestion[];
  readonly policies: {
    readonly text: string;
    readonly cancel: { readonly allowed: boolean; readonly cutoffHours: number };
    readonly reschedule: {
      readonly allowed: boolean;
      readonly cutoffHours: number;
      readonly maxTimes: number;
    };
  };
  /**
   * The ZIP codes it comes to, when it routes by service area. `byAddress` (M18): some areas go by distance or
   * a drawn map area, so the page asks for the street address instead and the times show whether it's served.
   */
  readonly zipRouting: {
    readonly postalCodes: readonly string[];
    readonly byAddress?: boolean;
  } | null;
  readonly mode: 'hours' | 'sessions';
  readonly capacity: {
    readonly seats: number;
    readonly maxPartySize: number;
    readonly showSeatsLeft: boolean;
  };
  readonly waitlist: { readonly enabled: boolean };
  readonly window: {
    readonly minNoticeMinutes: number;
    readonly maxDaysAhead: number;
    readonly dateFrom: string | null;
    readonly dateTo: string | null;
  };
  readonly confirmation: { readonly text: boolean; readonly email: boolean };
  /**
   * What this calendar asks for before it will hold a time. Null when it asks for nothing, so the booking
   * page can say what is due before anyone types their details.
   */
  readonly payment: {
    readonly mode: 'deposit' | 'full';
    readonly amountCents: number;
    readonly priceCents: number;
    readonly dueAfterCents: number;
    /** False when no connected account could take it. */
    readonly canPay: boolean;
  } | null;
  /** Present when the worker checks for bots; its site key, or null to use this app's own. */
  readonly botCheck: { readonly siteKey: string | null } | null;
}

export interface PublicCalendarPage {
  readonly state: 'open' | 'off';
  /** The calendar's current address: old names and /book/c/<id> redirect here. */
  readonly canonical: { readonly site: string; readonly calendar: string };
  readonly business: PublicBusiness;
  readonly timezone: string;
  readonly timezoneLabel: string;
  readonly calendar: {
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
  };
  readonly booking: BookingInfo | null;
}

export interface PublicSlot {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly seatsLeft: number | null;
  /** Joining this session or group time. */
  readonly sessionId: string | null;
  readonly people: readonly string[];
}

export interface FullSession {
  readonly sessionId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly waiting: number;
}

export interface OpenTimes {
  readonly timezone: string;
  readonly durationMinutes: number;
  readonly slots: readonly PublicSlot[];
  readonly full?: readonly FullSession[];
}

export interface PublicAppointment {
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly durationMinutes: number;
  readonly timezone: string;
  readonly timezoneLabel: string;
  readonly where: string | null;
  readonly with: readonly string[];
  readonly seats: number;
  readonly kind: 'booking' | 'session';
}

export interface ManagePolicies {
  readonly text: string;
  readonly reschedule: {
    readonly allowed: boolean;
    readonly reason: 'not_allowed' | 'cutoff' | 'limit' | 'calendar_off' | null;
    readonly until: string;
    readonly cutoffHours: number;
    readonly movesLeft: number;
  };
  readonly cancel: {
    readonly allowed: boolean;
    readonly reason: 'not_allowed' | 'cutoff' | null;
    readonly until: string;
    readonly cutoffHours: number;
  };
}

export interface Booked {
  readonly booking: PublicAppointment;
  readonly manageToken: string;
  readonly manageUrl: string;
  readonly policies: ManagePolicies;
  readonly contact: {
    readonly email: string | null;
    readonly phoneDisplay: string | null;
    readonly texts: boolean;
  };
  readonly joined: boolean;
  readonly duplicate: boolean;
}

/** How a customer may pay a deposit. Bank transfer leads: it is the cheap rail. */
export type PayMethod = 'ach' | 'card';

/** What the account behind a deposit can take, and the public keys the browser needs. Never a secret. */
export interface HoldPaySession {
  readonly provider: string;
  readonly flow: 'client_confirm' | 'server_charge';
  readonly publishableKey: string;
  readonly accountId: string;
  readonly locationId: string | null;
}

/**
 * A time held while a deposit is paid. `state` is the whole story: 'held' while they pay, 'booked' once the
 * deposit is in hand, 'gone' if the time went — and then nothing was charged, because a card is only ever held.
 */
export interface Held {
  readonly state: 'held' | 'booked' | 'gone';
  readonly business: PublicBusiness;
  readonly calendar: { readonly name: string; readonly bookingPath: string | null };
  readonly appointment: PublicAppointment;
  readonly deposit: {
    /** 'deposit': part now, the rest on the invoice for the job. 'full': the whole price now. */
    readonly mode: 'deposit' | 'full';
    readonly what: string;
    readonly amountCents: number;
    readonly priceCents: number;
    readonly dueAfterCents: number;
    readonly paidCents: number;
    readonly number: string | null;
    readonly method: string | null;
    readonly cardBrand: string | null;
    readonly cardLast4: string | null;
    readonly receivedAt: string | null;
  };
  readonly pay: {
    readonly canPay: boolean;
    readonly reason: 'gone' | 'paid' | 'no_account' | null;
    readonly methods: readonly PayMethod[];
    readonly session: HoldPaySession | null;
  };
  readonly holdToken: string;
  readonly expiresAt: string | null;
  readonly holdMinutes: number;
  /** Filled once the deposit is paid: the booking, exactly as a booking without one answers. */
  readonly booked: Booked | null;
}

export interface DepositPayRequest {
  /** One per press, kept across the trip to the provider: a retry is answered, never charged again. */
  readonly clientId: string;
  readonly method?: PayMethod;
  readonly providerPaymentId?: string;
  readonly sourceToken?: string;
  readonly website?: string;
}

export interface PreparedPay {
  readonly stage: 'prepared';
  readonly payment: {
    readonly status: 'requires_payment';
    readonly amountCents: number;
    readonly method: PayMethod;
    readonly flow: 'client_confirm' | 'server_charge';
    readonly publishableKey: string;
    readonly accountId: string;
    readonly locationId: string | null;
    readonly clientSecret: string | null;
    readonly providerPaymentId: string | null;
    /** The stand-in's own page; null with the real providers, which run in the browser. */
    readonly hostedUrl: string | null;
    readonly returnUrl: string;
  };
  readonly hold: Held;
}

export interface RecordedPay {
  readonly stage: 'recorded';
  /** Set only when the time went while they were paying. */
  readonly state?: 'gone';
  readonly payment?: {
    readonly status: string;
    readonly amountCents: number;
    readonly method: PayMethod;
    readonly failureCode: string | null;
    readonly failureMessage: string | null;
    /** On a lost time: nothing was taken, and whether a bank transfer had to be sent back. */
    readonly charged?: boolean;
    readonly refunded?: boolean;
  };
  readonly hold: Held;
  /** Other times to pick from, when this one went. */
  readonly times?: readonly PublicSlot[];
}

/** How a booking was confirmed: a text (C, or YES while asked), the Confirm button, staff, or the AI teammate. */
export type ConfirmedVia = 'sms' | 'link' | 'staff' | 'ai';

/** Whether the customer confirmed a one-on-one booking, and whether the business asked them to (M8). */
export interface ManageConfirmation {
  readonly confirmedAt: string | null;
  readonly confirmedVia: ConfirmedVia | null;
  /** When the business asked (the day-before reminder or HandsFreeOS's request), or null. */
  readonly askedAt: string | null;
}

export interface ManageView {
  readonly state: 'booked' | 'cancelled' | 'past';
  readonly business: PublicBusiness;
  readonly calendar: { readonly name: string; readonly bookingPath: string | null };
  readonly appointment: PublicAppointment;
  readonly policies: ManagePolicies;
  readonly manageToken: string;
  readonly manageUrl: string;
  /** After a reschedule: a seat moved to another session has a new link. */
  readonly newLink?: boolean;
  /** Confirmed yet, and asked to (M8). Null for a group time or a session seat, which don't confirm. */
  readonly confirmation: ManageConfirmation | null;
}

interface CustomerFields {
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly smsConsent: boolean;
  /** The separate box for offers, for a business that sends them. */
  readonly offersConsent?: boolean;
  /** The honeypot: always empty from a person. */
  readonly website: string;
  readonly turnstileToken?: string;
}

export interface BookingRequest extends CustomerFields {
  /** One per booking attempt: a doubled tap or a retry books once. */
  readonly clientId: string;
  readonly startsAt: string;
  readonly sessionId?: string | null;
  readonly serviceId?: string | null;
  readonly durationMinutes?: number;
  readonly partySize: number;
  readonly locationKind?: LocationKind | null;
  readonly address?: string | null;
  readonly postalCode?: string | null;
  readonly chosenUserId?: string | null;
  readonly intake: Readonly<Record<string, string | number | boolean | readonly string[] | null>>;
  readonly notes?: string | null;
  /** The `ref` the page was opened with, for whoever's link it was. */
  readonly ref?: string | null;
}

export interface WaitlistRequest extends CustomerFields {
  readonly sessionId?: string | null;
  readonly wantedFrom?: string;
  readonly wantedTo?: string;
  readonly partySize: number;
}

/** Cloudflare Turnstile's public site key for this domain, when the worker doesn't name one. */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;

const PAGE_CACHE: RequestInit =
  process.env.NODE_ENV === 'production' ? { next: { revalidate: 30 } } : { cache: 'no-store' };
const FRESH: RequestInit = { cache: 'no-store' };
const PRIVATE: RequestInit = { cache: 'no-store', referrerPolicy: 'no-referrer' };

type ErrorBody = {
  error?: { code?: string; message?: string; rule?: string; details?: unknown };
} | null;

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, init);
  } catch {
    throw new ApiError(
      0,
      'internal',
      'We couldn’t reach the booking service. Check your connection and try again.',
    );
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as ErrorBody)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'internal',
      err?.message ?? 'Something went wrong. Please try again.',
      err?.rule,
      err?.details,
    );
  }
  return json as T;
}

const post = <T>(path: string, body: unknown, init: RequestInit = FRESH) =>
  call<T>(path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const seg = encodeURIComponent;
const bookPath = (site: string, calendar: string) => `/public/book/${seg(site)}/${seg(calendar)}`;
const managePath = (token: string) => `/public/manage/${seg(token)}`;
const holdPath = (token: string) => `/public/hold/${seg(token)}`;

/** A page's data, or the 404 page when the worker says there's no such page. */
export async function pageData<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
}

/** The booking site, and its simple page with the chat set up for `origin`, the address it's shown at. */
export const getSite = (site: string, origin?: string | null) =>
  call<PublicSite>(
    `/public/book/${seg(site)}${origin ? `?origin=${seg(origin)}` : ''}`,
    PAGE_CACHE,
  );

export const getCalendarPage = (site: string, calendar: string) =>
  call<PublicCalendarPage>(bookPath(site, calendar), PAGE_CACHE);

export function getOpenTimes(
  site: string,
  calendar: string,
  q: {
    from: string;
    to: string;
    serviceId?: string | null;
    durationMinutes?: number;
    partySize?: number;
    postalCode?: string | null;
    address?: string | null;
    chosenUserId?: string | null;
    locationKind?: LocationKind | null;
  },
): Promise<OpenTimes> {
  const params = new URLSearchParams({ from: q.from, to: q.to });
  if (q.serviceId) params.set('serviceId', q.serviceId);
  if (q.durationMinutes) params.set('durationMinutes', String(q.durationMinutes));
  if (q.partySize && q.partySize > 1) params.set('partySize', String(q.partySize));
  if (q.postalCode) params.set('postalCode', q.postalCode);
  if (q.address) params.set('address', q.address);
  if (q.chosenUserId) params.set('chosenUserId', q.chosenUserId);
  if (q.locationKind) params.set('locationKind', q.locationKind);
  return call<OpenTimes>(`${bookPath(site, calendar)}/slots?${params}`, FRESH);
}

/**
 * Booking a calendar that asks for money answers with a **hold**, not a booking: the time is taken for a few
 * minutes while the customer pays, and nobody is told anything until the deposit is in hand.
 */
export const bookOnline = (site: string, calendar: string, body: BookingRequest) =>
  post<Booked | Held>(`${bookPath(site, calendar)}/bookings`, body);

export const isHeld = (answer: Booked | Held): answer is Held =>
  typeof (answer as Held).holdToken === 'string';

export const getHold = (token: string) => call<Held>(holdPath(token), PRIVATE);

export const payDeposit = (token: string, body: DepositPayRequest) =>
  post<PreparedPay | RecordedPay>(`${holdPath(token)}/pay`, body, PRIVATE);

export const joinWaitlist = (site: string, calendar: string, body: WaitlistRequest) =>
  post<{ position: number; alreadyWaiting: boolean }>(`${bookPath(site, calendar)}/waitlist`, body);

export const getManage = (token: string) => call<ManageView>(managePath(token), PRIVATE);

export const getManageTimes = (token: string, from: string, to: string) =>
  call<OpenTimes>(`${managePath(token)}/slots?${new URLSearchParams({ from, to })}`, PRIVATE);

export const rescheduleBooking = (
  token: string,
  body: { startsAt: string; sessionId?: string | null },
) => post<ManageView>(`${managePath(token)}/reschedule`, body, PRIVATE);

export const cancelBooking = (token: string, reason: string | null) =>
  post<ManageView>(`${managePath(token)}/cancel`, { reason }, PRIVATE);

/**
 * The Confirm button. Always a POST: email scanners open links, so opening one never confirms. It answers with the
 * booking as the page shows it, plus `changed` (false when it was already confirmed).
 */
export const confirmBooking = (token: string) =>
  post<ManageView & { readonly changed: boolean }>(`${managePath(token)}/confirm`, {}, PRIVATE);

/** The booking as an .ics file (Apple Calendar and anything else that opens one). */
export const calendarFileUrl = (token: string) => `${publicEnv.workerUrl}${managePath(token)}/ics`;
