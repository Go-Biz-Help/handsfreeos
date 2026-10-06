/**
 * What the onboarding setup's answers do (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5), with what
 * will change in words. Browser-safe: the screens show the same lines the commands then carry out.
 *
 * Most answers are kept until "Stay in the loop", which saves everything at once (`planOnboardingSetup`): the AI
 * quick setup's plan (open hours, the business profile, facts, a website chat and the teammate), the price list,
 * and the person's own hours. A few can't wait, because later stops or other people need them: the business itself
 * (the AI starts reading the website), invitations, where customers are, the booking page (`planOnboardingBooking`:
 * the carriers look at it on the number stop), and the review link.
 */
import { setupFor } from '../ai-setup/kinds';
import {
  planAiSetup,
  serviceNameKey,
  serviceWriteOf,
  type AiSetupPlan,
  type AiSetupServiceWrite,
} from '../ai-setup/plan';
import type { WeeklyHours } from '../calendar/config';
import { formatHours } from '../calendar/format';
import { money } from '../money/format';
import type { OnboardingSetupAnswers } from './answers';
import type { OnboardingSetupState } from './state';

const joinAnd = (items: readonly string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const the = (noun: string, names: readonly string[]) =>
  `the ${names.length === 1 ? noun : `${noun}s`} ${joinAnd(names)}`;

/** The hours someone has before they save their own: weekdays 9 to 5 (`DEFAULT_WEEKLY_HOURS`). */
const PERSON_DEFAULT_HOURS: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '09:00',
  end: '17:00',
}));
const hoursKey = (h: WeeklyHours) =>
  JSON.stringify(
    [...h].sort(
      (a, b) => a.day - b.day || a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
    ),
  );

/**
 * The person's own hours from the open hours, so what customers can book and when they're on follow the business:
 * only while they have none of their own saved, and never to no hours at all.
 */
export function myHoursFrom(
  state: Pick<OnboardingSetupState, 'myHours'>,
  answers: Pick<OnboardingSetupAnswers, 'ai'>,
): WeeklyHours | null {
  const open = answers.ai.openHours;
  if (state.myHours || !open.length || hoursKey(open) === hoursKey(PERSON_DEFAULT_HOURS))
    return null;
  return open.map((h) => ({ ...h }));
}

/** "Your hours: Mon–Fri 7:00 AM–6:00 PM", for what will change. */
export const myHoursChange = (hours: WeeklyHours): string => `Your hours: ${formatHours(hours)}`;

// ---- The booking page ----

export interface OnboardingBookingPlan {
  /** Services to add to Calendars → Services, with their lengths and prices. */
  readonly services: readonly AiSetupServiceWrite[];
  /** The booking calendar to make with every service on it; null when customers can book one already. */
  readonly calendar: string | null;
  /** The person's own hours, from the open hours; null when they keep theirs. */
  readonly myHours: WeeklyHours | null;
  /** The booking site to make, or to turn back on; null when it's on. */
  readonly site: 'make' | 'turn_on' | null;
  /** What will change, one line each. */
  readonly changes: readonly string[];
}

/** What leaving "Your booking page is ready" does: the services and hours answered so far become a booking page. */
export function planOnboardingBooking(
  state: OnboardingSetupState,
  answers: OnboardingSetupAnswers,
): OnboardingBookingPlan {
  const lines: string[] = [];
  const needsCalendar = !state.calendars.length;
  const known = new Set(state.services.map((s) => serviceNameKey(s.name)));
  const services = needsCalendar
    ? answers.ai.services
        .filter((s) => {
          const key = serviceNameKey(s.name);
          if (known.has(key)) return false;
          known.add(key);
          return true;
        })
        .map(serviceWriteOf)
    : [];
  // A calendar needs something to book.
  const calendar =
    needsCalendar && state.services.length + services.length > 0
      ? setupFor(state.industry).calendar
      : null;
  const myHours = myHoursFrom(state, answers);
  const site = !state.booking.site ? 'make' : state.booking.site.enabled ? null : 'turn_on';
  if (services.length)
    lines.push(
      `Adds ${the(
        'service',
        services.map((s) => s.name),
      )} to Calendars`,
    );
  if (calendar) lines.push(`Makes the booking calendar ${calendar}, with your services on it`);
  if (myHours) lines.push(myHoursChange(myHours));
  if (site) lines.push('Turns on your booking page');
  return { services, calendar, myHours, site, changes: lines };
}

// ---- The price list ----

export interface OnboardingPriceListPlan {
  /** Services with a price to add to the price list, each the price of the bookable service of its name, if any. */
  readonly create: readonly {
    readonly name: string;
    readonly priceCents: number;
    readonly serviceId: string | null;
  }[];
  /** Ones on the list already, at a new price. */
  readonly update: readonly {
    readonly id: string;
    readonly name: string;
    readonly priceCents: number;
  }[];
}

/** The services with a price, on the price list by name. Nothing on it is ever taken off here. */
export function planPriceList(
  state: Pick<OnboardingSetupState, 'priceList' | 'bookable'>,
  answers: Pick<OnboardingSetupAnswers, 'ai'>,
): OnboardingPriceListPlan {
  const create: { name: string; priceCents: number; serviceId: string | null }[] = [];
  const update: { id: string; name: string; priceCents: number }[] = [];
  const priced = new Set(state.priceList.flatMap((p) => (p.serviceId ? [p.serviceId] : [])));
  const seen = new Set<string>();
  for (const s of answers.ai.services) {
    const key = serviceNameKey(s.name);
    if (s.priceCents == null || seen.has(key)) continue;
    seen.add(key);
    const listed = state.priceList.find((p) => serviceNameKey(p.name) === key);
    if (listed) {
      if (listed.priceCents !== s.priceCents)
        update.push({ id: listed.id, name: listed.name, priceCents: s.priceCents });
      continue;
    }
    const service = state.bookable.find((b) => serviceNameKey(b.name) === key && !priced.has(b.id));
    if (service) priced.add(service.id);
    create.push({ name: s.name, priceCents: s.priceCents, serviceId: service?.id ?? null });
  }
  return { create, update };
}

/** What the price list plan changes, one line each. */
export function priceListChanges(plan: OnboardingPriceListPlan): string[] {
  const lines: string[] = [];
  if (plan.create.length)
    lines.push(
      `Adds ${joinAnd(plan.create.map((p) => `${p.name} (${money(p.priceCents)})`))} to your price list`,
    );
  for (const p of plan.update) lines.push(`Price list: ${p.name} is now ${money(p.priceCents)}`);
  return lines;
}

// ---- Saving everything ----

export interface OnboardingSetupPlan {
  /** The AI quick setup's plan for the AI part's answers: hours, profile, facts, chat and the teammate. */
  readonly ai: AiSetupPlan;
  readonly priceList: OnboardingPriceListPlan;
  /** The person's own hours, from the open hours; null when they keep theirs. */
  readonly myHours: WeeklyHours | null;
  /** What will change, one line each. */
  readonly changes: readonly string[];
}

/** What "Stay in the loop" saves. */
export function planOnboardingSetup(
  state: OnboardingSetupState,
  answers: OnboardingSetupAnswers,
): OnboardingSetupPlan {
  const ai = planAiSetup(state, answers.ai);
  const priceList = planPriceList(state, answers);
  const myHours = myHoursFrom(state, answers);
  const lines = [...ai.changes, ...priceListChanges(priceList)];
  if (myHours) lines.push(myHoursChange(myHours));
  return { ai, priceList, myHours, changes: lines };
}
