/**
 * The guided calendar setup's questions (the owner, 22 Nov 2026: "all the settings" one question at a time; his
 * picks C1 a, C2 a, C3 a and C4 b): what customers book, who does the work, what it is and how long it takes, when,
 * where, what customers hear, and whether they pay when they book. What each kind of calendar asks, what is wrong
 * with an answer, the lines beside the questions and the settings the answers become live here once, for the web and
 * the phone. Nothing is made before Check it over: calendar_setup.save then makes the services added, the calendar
 * and its dates together. Browser-safe.
 */
import { z } from 'zod';
import type { DepositTerms } from '../money/totals';
import { money } from '../money/format';
import { formatClock } from '../messaging/quiet-hours';
import { isoDateTime, uuid } from '../schemas/common';
import {
  applyPatch,
  goesOut,
  LocationKind,
  Reminder,
  WeeklyHours,
  weeklyHoursDayProblem,
  type CalendarConfig,
  type ConfigPatch,
} from '../calendar/config';
import type { CalendarCatalogs, CatalogTerritory } from '../calendar/catalogs';
import { isClock, isLocalDate, localInstant } from '../calendar/engine/zoned';
import { countOf, formatDuration, formatHours, formatNotice } from '../calendar/format';
import { configFromPreset, type PresetKey } from '../calendar/presets';
import { fmtDateLong } from '../calendar/when';
import { moduleSummary, type CalendarSectionKey } from '../calendar/describe';

// ---- The kinds, and what each one asks ----

export const CALENDAR_SETUP_KINDS = [
  'appointment',
  'visit',
  'meeting',
  'class',
  'event',
  'webinar',
  'resource',
  'collective',
  'scratch',
] as const;
export type CalendarSetupKind = (typeof CALENDAR_SETUP_KINDS)[number];
/** The five shown first (the owner's C1 a); the rest sit under More kinds. */
export const CALENDAR_SETUP_FIRST_KINDS: readonly CalendarSetupKind[] = [
  'appointment',
  'visit',
  'meeting',
  'class',
  'event',
];
export const CALENDAR_SETUP_MORE_KINDS: readonly CalendarSetupKind[] = [
  'webinar',
  'resource',
  'collective',
  'scratch',
];

export const CALENDAR_SETUP_QUESTIONS = [
  'kind',
  'who',
  'what',
  'when',
  'where',
  'remind',
  'pay',
] as const;
export type CalendarSetupQuestion = (typeof CALENDAR_SETUP_QUESTIONS)[number];
export type CalendarSetupScreen = CalendarSetupQuestion | 'review';

interface KindShape {
  /** Today's starting point it fills in from (calendar/presets.ts). */
  readonly preset: PresetKey;
  /** Who: people to pick from, people who run it, people who all go, or nobody (a room). */
  readonly who: 'pick' | 'run' | 'together' | null;
  /** What: services (or a length instead), a length with seats, or a room or equipment. */
  readonly what: 'services' | 'length' | 'seats' | 'resource';
  /** When: open hours, or dates you post. */
  readonly when: 'hours' | 'dates';
  /** Where: places to tick, a visit to the customer, or nothing to ask (a webinar is on video). */
  readonly where: 'places' | 'visit' | null;
  readonly name: string;
  readonly places: readonly LocationKind[];
}

const KINDS: Record<CalendarSetupKind, KindShape> = {
  appointment: {
    preset: 'service',
    who: 'pick',
    what: 'services',
    when: 'hours',
    where: 'places',
    name: 'Appointments',
    places: ['business'],
  },
  visit: {
    preset: 'dispatch',
    who: 'pick',
    what: 'services',
    when: 'hours',
    where: 'visit',
    name: 'Service visits',
    places: ['customer_address'],
  },
  meeting: {
    preset: 'personal',
    who: 'pick',
    what: 'length',
    when: 'hours',
    where: 'places',
    name: 'Meetings',
    places: ['phone'],
  },
  class: {
    preset: 'group',
    who: 'run',
    what: 'seats',
    when: 'hours',
    where: 'places',
    name: 'Classes',
    places: ['business'],
  },
  event: {
    preset: 'event',
    who: 'run',
    what: 'seats',
    when: 'dates',
    where: 'places',
    name: 'Events',
    places: ['business'],
  },
  webinar: {
    preset: 'webinar',
    who: 'run',
    what: 'seats',
    when: 'dates',
    where: null,
    name: 'Webinars',
    places: ['virtual'],
  },
  resource: {
    preset: 'resource',
    who: null,
    what: 'resource',
    when: 'hours',
    where: 'places',
    name: 'Rooms and equipment',
    places: ['business'],
  },
  collective: {
    preset: 'collective',
    who: 'together',
    what: 'services',
    when: 'hours',
    where: 'places',
    name: 'Walkthroughs',
    places: ['business'],
  },
  scratch: {
    preset: 'scratch',
    who: null,
    what: 'length',
    when: 'hours',
    where: null,
    name: 'New calendar',
    places: [],
  },
};

export const calendarSetupKind = (kind: CalendarSetupKind): KindShape => KINDS[kind];

// ---- The answers ----

const minutes = z.int().min(5).max(720);

const ServiceRow = z.object({
  /** The row's own name on the screen: the service's id, or one made up for a service added here. */
  key: z.string().min(1).max(60),
  /** A service the business has; null for one added here, made when the calendar is. */
  id: uuid.nullable(),
  name: z.string().max(120),
  on: z.boolean(),
  minutes,
  priceCents: z.int().min(0).max(100_000_000).nullable(),
  /** Who does it; empty means everyone picked in question 2. */
  userIds: z.array(uuid).max(50),
});
export type CalendarSetupService = z.infer<typeof ServiceRow>;

const AskRow = z.object({
  id: z.string().min(1).max(40),
  label: z.string().max(200),
  required: z.boolean(),
});

const ASSIGNMENTS = ['first_available', 'round_robin', 'customer_choice', 'collective'] as const;
export type CalendarSetupAssignment = (typeof ASSIGNMENTS)[number];

/**
 * A setup's answers as its screens keep them and as calendar_setup.save takes them. Loose where a half-typed answer
 * is still worth keeping (an empty name, a service with no name yet): `calendarSetupProblems` says what is wrong, and
 * the command asks it again before anything is made.
 */
export const CalendarSetupAnswers = z.object({
  kind: z.enum(CALENDAR_SETUP_KINDS).nullable(),
  name: z.string().max(200),
  // Who
  people: z.array(uuid).max(50),
  assignment: z.enum(ASSIGNMENTS),
  // What
  what: z.enum(['services', 'length']),
  services: z.array(ServiceRow).max(50),
  minutes,
  seats: z.int().min(1).max(500),
  /** A room or equipment the business has (id), or one named here and made with the calendar. */
  resource: z.object({ id: uuid.nullable(), name: z.string().max(120) }),
  // When
  hours: z.enum(['people', 'own']),
  ownHours: WeeklyHours,
  noticeMinutes: z.int().min(0).max(129_600),
  daysAhead: z.int().min(1).max(365),
  gapMinutes: z.int().min(0).max(240),
  dates: z.array(z.object({ date: z.string().max(10), time: z.string().max(5) })).max(24),
  // Where
  places: z.array(LocationKind).max(5),
  address: z.string().max(300),
  meetingUrl: z.string().max(500),
  areas: z.enum(['anywhere', 'areas']),
  areaIds: z.array(uuid).max(100),
  travelMinutes: z.int().min(0).max(240),
  drive: z.boolean(),
  // What customers hear
  confirm: z.boolean(),
  reminders: z.array(Reminder).max(5),
  byText: z.boolean(),
  byEmail: z.boolean(),
  /** Hours before the booking they can still cancel or move it online; null when they can't online at all. */
  changeHours: z.int().min(0).max(720).nullable(),
  ask: z.array(AskRow).max(20),
  tellStaff: z.boolean(),
  // Paying
  pay: z.enum(['none', 'deposit', 'full']),
  /** The business's usual deposit (Settings → Payments), or this calendar's own share or amount. */
  deposit: z.enum(['business', 'percent', 'amount']),
  depositPercent: z.int().min(1).max(100),
  depositCents: z.int().min(0).max(100_000_000).nullable(),
  /** Check it over's tick: open it for booking as soon as it's made. */
  open: z.boolean(),
});
export type CalendarSetupAnswers = z.infer<typeof CalendarSetupAnswers>;

export const CALENDAR_SETUP_LENGTHS = [15, 20, 30, 45, 60, 90, 120, 180, 240] as const;
export const CALENDAR_SETUP_NOTICE = [0, 60, 120, 240, 720, 1440, 2880] as const;
export const CALENDAR_SETUP_DAYS_AHEAD = [14, 30, 60, 90, 180, 365] as const;
export const CALENDAR_SETUP_GAPS = [0, 5, 10, 15, 30, 60] as const;
export const CALENDAR_SETUP_TRAVEL = [0, 15, 30, 45, 60, 90] as const;
export const CALENDAR_SETUP_REMIND_BEFORE = [30, 60, 120, 240, 2880, 4320] as const;
export const CALENDAR_SETUP_CHANGE_HOURS = [0, 2, 12, 24, 48, 72] as const;
export const CALENDAR_SETUP_DEPOSIT_PERCENTS = [10, 20, 25, 50] as const;
export const CALENDAR_SETUP_MAX_REMINDERS = 3;
export const CALENDAR_SETUP_MAX_DATES = 12;
export const CALENDAR_SETUP_MAX_ASK = 5;

// ---- What the screens know ----

export interface CalendarSetupPerson {
  readonly userId: string;
  readonly name: string;
  /** The person going through the setup. */
  readonly me: boolean;
  readonly weekly: WeeklyHours;
  /** No hours saved yet: weekdays 9 to 5 apply until they set their own. */
  readonly defaultHours: boolean;
}
export interface CalendarSetupCatalogService {
  readonly id: string;
  readonly name: string;
  /** Its lengths, the usual one first. One with several is changed in Settings → Calendars → Services. */
  readonly lengths: readonly number[];
  readonly priceCents: number | null;
  readonly userIds: readonly string[];
}
export interface CalendarSetupArea {
  readonly id: string;
  readonly name: string;
  /** "12 ZIP codes", "25 miles around Huntsville". */
  readonly covers: string;
  readonly userIds: readonly string[];
}
export interface CalendarSetupContext {
  readonly businessName: string;
  /** One line, where the business has said. */
  readonly businessAddress: string | null;
  readonly timeZone: string;
  readonly people: readonly CalendarSetupPerson[];
  readonly services: readonly CalendarSetupCatalogService[];
  readonly resources: readonly { readonly id: string; readonly name: string }[];
  readonly areas: readonly CalendarSetupArea[];
  /** A payment account is connected, so money taken at booking has somewhere to land. */
  readonly paymentsReady: boolean;
  /** What the business asks for up front (Settings → Payments). */
  readonly businessDeposit: DepositTerms;
  /** The carriers approved the number: reminders can go by text. */
  readonly textingReady: boolean;
}

const WEEKDAYS_9_TO_5: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '09:00',
  end: '17:00',
}));

/** "12 ZIP codes", "25 miles around 214 Clinton Ave E", "An area drawn on the map". */
export function calendarSetupAreaCovers(t: CatalogTerritory): string {
  if (t.kind === 'zip') return countOf(t.postalCodes.length, 'ZIP code', 'ZIP codes');
  if (t.kind === 'radius')
    return `${t.radiusMiles ?? 0} miles around ${t.centerAddress || 'a point on the map'}`;
  return 'An area drawn on the map';
}

/**
 * What the setup knows, from the calendar catalogs the builder and the server already load: the people still on the
 * team, the services and rooms not archived, the areas, and whether money and texts can go out. `me` is the person
 * going through it; `ownHours` the people who saved hours of their own (everyone else has weekdays 9 to 5 for now).
 */
export function calendarSetupContextFrom(
  catalogs: CalendarCatalogs,
  opts: {
    readonly businessName: string;
    readonly businessAddress: string | null;
    readonly me: string | null;
    readonly ownHours?: ReadonlySet<string>;
  },
): CalendarSetupContext {
  return {
    businessName: opts.businessName,
    businessAddress: opts.businessAddress,
    timeZone: catalogs.timeZone,
    people: catalogs.team
      .filter((p) => p.active)
      .map((p) => ({
        userId: p.userId,
        name: p.name,
        me: p.userId === opts.me,
        weekly: p.hours ?? WEEKDAYS_9_TO_5,
        defaultHours: opts.ownHours ? !opts.ownHours.has(p.userId) : false,
      }))
      // The person going through it first, as question 2 lists them.
      .sort((a, b) => Number(b.me) - Number(a.me)),
    services: catalogs.services
      .filter((s) => !s.archived)
      .map((s) => ({
        id: s.id,
        name: s.name,
        lengths: s.durations,
        priceCents: s.priceCents ?? null,
        userIds: s.eligibleUserIds,
      })),
    resources: catalogs.resources
      .filter((r) => !r.archived)
      .map((r) => ({ id: r.id, name: r.name })),
    areas: catalogs.territories.map((t) => ({
      id: t.id,
      name: t.name,
      covers: calendarSetupAreaCovers(t),
      userIds: t.userIds,
    })),
    paymentsReady: catalogs.paymentsAvailable,
    businessDeposit: catalogs.businessDeposit,
    textingReady: catalogs.textingReady,
  };
}

/** A service the business has, as a row of question 3. */
function rowOf(s: CalendarSetupCatalogService, on: boolean): CalendarSetupService {
  return {
    key: s.id,
    id: s.id,
    name: s.name,
    on,
    minutes: s.lengths[0] ?? 60,
    priceCents: s.priceCents,
    userIds: [...s.userIds],
  };
}

/** Where a kind's questions start: today's defaults for it, with the business's own people, services and address. */
export function calendarSetupStart(
  kind: CalendarSetupKind | null,
  ctx: CalendarSetupContext,
): CalendarSetupAnswers {
  const shape = kind ? KINDS[kind] : null;
  const me = ctx.people.find((p) => p.me);
  const first = me ?? ctx.people[0];
  // A setup for one person starts with them; one where people share the work starts with everyone.
  const people =
    !shape || !shape.who
      ? []
      : shape.who === 'pick' && kind !== 'meeting'
        ? ctx.people.map((p) => p.userId)
        : shape.who === 'together'
          ? ctx.people.slice(0, 2).map((p) => p.userId)
          : first
            ? [first.userId]
            : [];
  return {
    kind,
    name: shape?.name ?? '',
    people,
    assignment: shape?.who === 'together' ? 'collective' : 'first_available',
    what: shape?.what === 'services' ? 'services' : 'length',
    services: ctx.services.map((s) => rowOf(s, true)),
    minutes: 60,
    seats: kind === 'webinar' ? 500 : kind === 'event' ? 50 : 10,
    resource: { id: ctx.resources[0]?.id ?? null, name: '' },
    hours: shape?.who ? 'people' : 'own',
    ownHours: WEEKDAYS_9_TO_5,
    noticeMinutes: 240,
    daysAhead: 60,
    gapMinutes: 0,
    dates: [],
    places: [...(shape?.places ?? [])],
    address: ctx.businessAddress ?? '',
    meetingUrl: '',
    areas: ctx.areas.length ? 'areas' : 'anywhere',
    areaIds: ctx.areas.map((a) => a.id),
    travelMinutes: 30,
    drive: false,
    confirm: true,
    reminders: [
      { kind: 'day_before', at: '16:00' },
      { kind: 'before', minutes: 120 },
    ],
    byText: true,
    byEmail: true,
    changeHours: 24,
    ask: [],
    tellStaff: true,
    pay: 'none',
    deposit: ctx.businessDeposit.kind === 'none' ? 'percent' : 'business',
    depositPercent: 25,
    depositCents: null,
    open: true,
  };
}

/**
 * Saved answers read back over where the setup starts: each answer that still makes sense is kept, and the rest
 * start again. People, services and areas that are gone since are dropped, and services added since are offered.
 */
export function calendarSetupAnswersOf(
  raw: unknown,
  start: CalendarSetupAnswers,
  ctx: CalendarSetupContext,
): CalendarSetupAnswers {
  const from = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...start };
  for (const [key, schema] of Object.entries(CalendarSetupAnswers.shape)) {
    const got = (schema as z.ZodType).safeParse(from[key]);
    if (got.success) out[key] = got.data;
  }
  const a = out as CalendarSetupAnswers;
  const people = new Set(ctx.people.map((p) => p.userId));
  const areas = new Set(ctx.areas.map((x) => x.id));
  const known = new Map(ctx.services.map((s) => [s.id, s]));
  const kept = a.services
    .filter((s) => s.id === null || known.has(s.id))
    .map((s) => ({ ...s, userIds: s.userIds.filter((u) => people.has(u)) }));
  const seen = new Set(kept.map((s) => s.id));
  return {
    ...a,
    people: a.people.filter((u) => people.has(u)),
    services: [...kept, ...ctx.services.filter((s) => !seen.has(s.id)).map((s) => rowOf(s, false))],
    resource:
      a.resource.id && !ctx.resources.some((r) => r.id === a.resource.id)
        ? { id: null, name: a.resource.name }
        : a.resource,
    areaIds: a.areaIds.filter((id) => areas.has(id)),
  };
}

/** What question 3 is about for these answers: a kind that books services can book a length of time instead. */
export function calendarSetupWhat(a: CalendarSetupAnswers): KindShape['what'] {
  const shape = a.kind ? KINDS[a.kind] : null;
  if (!shape) return 'length';
  if (shape.what === 'services' || shape.what === 'length') return a.what;
  return shape.what;
}

/** The team goes to the customer: areas, travel time and drive times are worth asking. */
export function calendarSetupGoesOut(a: CalendarSetupAnswers): boolean {
  return calendarSetupPlaces(a).some((p) => goesOut(p));
}

/** The places these answers book at: a visit is always the customer's address, a webinar always on video. */
export function calendarSetupPlaces(a: CalendarSetupAnswers): readonly LocationKind[] {
  const shape = a.kind ? KINDS[a.kind] : null;
  if (!shape) return [];
  if (shape.where === 'visit') return ['customer_address'];
  if (shape.where === null) return shape.places;
  return a.places;
}

/** The questions these answers are asked, in order. Start from scratch asks none: it opens every setting. */
export function calendarSetupQuestions(a: CalendarSetupAnswers): CalendarSetupQuestion[] {
  if (!a.kind || a.kind === 'scratch') return ['kind'];
  const shape = KINDS[a.kind];
  return CALENDAR_SETUP_QUESTIONS.filter(
    (q) => (q !== 'who' || shape.who !== null) && (q !== 'where' || shape.where !== null),
  );
}

// ---- What is wrong with an answer ----

export interface CalendarSetupProblem {
  readonly screen: CalendarSetupQuestion;
  /** The answer it is about, as the screens name their fields ("name", "services.0.name"). */
  readonly field: string;
  readonly message: string;
  /** For clients that branch: 'needs_payment_account' offers Settings → Payments. */
  readonly rule?: 'needs_payment_account';
}

const servicesOn = (a: CalendarSetupAnswers) => a.services.filter((s) => s.on);

/** Everything wrong with these answers, in the order the questions come. Empty means the calendar can be made. */
export function calendarSetupProblems(
  a: CalendarSetupAnswers,
  ctx: CalendarSetupContext,
  now: number = Date.now(),
): CalendarSetupProblem[] {
  const out: CalendarSetupProblem[] = [];
  const add = (screen: CalendarSetupQuestion, field: string, message: string) =>
    out.push({ screen, field, message });
  if (!a.kind) {
    add('kind', 'kind', 'Pick what customers book.');
    return out;
  }
  if (!a.name.trim()) add('kind', 'name', 'Give this calendar a name.');
  else if (a.name.trim().length > 120) add('kind', 'name', 'Keep the name under 120 characters.');
  if (a.kind === 'scratch') return out;
  const shape = KINDS[a.kind];
  const asked = calendarSetupQuestions(a);

  if (asked.includes('who')) {
    if (!ctx.people.length)
      add('who', 'people', 'Nobody is on your team yet. Add someone in Settings → Team first.');
    else if (!a.people.length) add('who', 'people', 'Tick at least one person.');
    else if (shape.who === 'together' && a.people.length < 2)
      add(
        'who',
        'people',
        ctx.people.length < 2
          ? 'This kind needs two people, and your team has one. Invite someone in Settings → Team, or go back and pick another kind.'
          : 'Tick at least two people. Every booking needs all of them.',
      );
  }

  const what = calendarSetupWhat(a);
  if (what === 'services') {
    const on = servicesOn(a);
    if (!on.length)
      add(
        'what',
        'services',
        a.services.length ? 'Tick at least one service.' : 'Add at least one service.',
      );
    const names = new Map<string, number>();
    a.services.forEach((s, i) => {
      if (!s.on) return;
      const name = s.name.trim().toLowerCase();
      if (!name) add('what', `services.${i}.name`, 'Give this service a name.');
      else if (names.has(name))
        add('what', `services.${i}.name`, `Two services are called ${s.name.trim()}. Rename one.`);
      else names.set(name, i);
      if (asked.includes('who')) {
        const picked = s.userIds.filter((u) => a.people.includes(u));
        if (s.userIds.length && !picked.length)
          add(
            'what',
            `services.${i}.userIds`,
            `Nobody you picked in question 2 does ${s.name.trim() || 'this service'}. Tick someone for it, or untick the service.`,
          );
      }
    });
  } else if (what === 'resource') {
    if (!a.resource.id && !a.resource.name.trim())
      add('what', 'resource', 'Pick what gets booked, or type a name to add it.');
  }

  if (shape.when === 'dates') {
    a.dates.forEach((d, i) => {
      if (!isLocalDate(d.date) || !isClock(d.time))
        add('when', `dates.${i}`, 'Pick a date and a start time, or remove this row.');
      else if (localInstant(d.date, d.time, ctx.timeZone) <= now)
        add('when', `dates.${i}`, `${fmtDateLong(d.date)} has passed. Pick a later date.`);
    });
  } else if (a.hours === 'own' || shape.who === null) {
    if (!a.ownHours.length) add('when', 'ownHours', 'Turn on at least one day.');
    else
      for (const day of [0, 1, 2, 3, 4, 5, 6]) {
        const wrong = weeklyHoursDayProblem(a.ownHours.filter((h) => h.day === day));
        if (wrong) {
          add('when', `ownHours.${day}`, wrong);
          break;
        }
      }
  }

  if (asked.includes('where')) {
    const places = calendarSetupPlaces(a);
    if (!places.length) add('where', 'places', 'Tick at least one place.');
    if (places.includes('business') && !a.address.trim())
      add('where', 'address', 'Type the address customers come to.');
    if (places.includes('virtual') && a.meetingUrl.trim() && !isUrl(a.meetingUrl.trim()))
      add(
        'where',
        'meetingUrl',
        'That link doesn’t look right. Paste the whole link, starting with https://.',
      );
    if (calendarSetupGoesOut(a) && a.areas === 'areas' && !a.areaIds.length)
      add(
        'where',
        'areaIds',
        ctx.areas.length
          ? 'Tick at least one area, or pick Anywhere.'
          : 'You have no areas yet. Add one, or pick Anywhere.',
      );
  }

  if ((a.confirm || a.reminders.length) && !a.byText && !a.byEmail)
    add('remind', 'channels', 'Tick Text or Email, so the messages have a way to go out.');
  a.ask.forEach((q, i) => {
    if (!q.label.trim()) add('remind', `ask.${i}`, 'Write the question, or remove this row.');
  });

  if (a.pay !== 'none') {
    if (!ctx.paymentsReady)
      out.push({
        screen: 'pay',
        field: 'pay',
        rule: 'needs_payment_account',
        message:
          'Connect a payment account first, so the money has somewhere to go. Your answers are saved. Or pick No, they pay later.',
      });
    const terms = calendarSetupDeposit(a, ctx);
    const setAmount = a.pay === 'deposit' && terms?.kind === 'amount';
    if (a.pay === 'deposit' && a.deposit === 'amount' && !(a.depositCents && a.depositCents > 0))
      add('pay', 'depositCents', 'Type how much the deposit is.');
    else if (!setAmount) {
      const priced = what === 'services' && servicesOn(a).some((s) => (s.priceCents ?? 0) > 0);
      if (!priced)
        add(
          'pay',
          'pay',
          what === 'services'
            ? 'None of these services has a price, so there is nothing to charge. Add a price in question 3, ask for a set amount, or pick No, they pay later.'
            : 'There is no price to charge here. Ask for a deposit of a set amount, or pick No, they pay later.',
        );
    }
  }
  return out;
}

function isUrl(value: string): boolean {
  return z.url().safeParse(value).success && /^https?:\/\//i.test(value);
}

export function calendarSetupFirstProblem(
  problems: readonly CalendarSetupProblem[],
  screen: CalendarSetupQuestion,
): CalendarSetupProblem | null {
  return problems.find((p) => p.screen === screen) ?? null;
}

/** The deposit these answers ask for, as the calendar keeps it; null when it's the business's own. */
export function calendarSetupDeposit(
  a: CalendarSetupAnswers,
  ctx: Pick<CalendarSetupContext, 'businessDeposit'>,
): DepositTerms | null {
  if (a.pay !== 'deposit') return null;
  if (a.deposit === 'business' && ctx.businessDeposit.kind !== 'none') return ctx.businessDeposit;
  if (a.deposit === 'amount') return { kind: 'amount', amountCents: a.depositCents ?? 0 };
  return { kind: 'percent', percentBp: a.depositPercent * 100 };
}

// ---- The answers in words ----

const andJoin = (list: readonly string[]): string =>
  list.length <= 1
    ? (list[0] ?? '')
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** "9:00 AM to 5:00 PM" for a clock pair. */
const span = (start: string, end: string) => `${formatClock(start)} to ${formatClock(end)}`;

/** A person's hours on the Who question: theirs, or the weekday hours that apply until they set them. */
export function calendarSetupPersonHours(p: CalendarSetupPerson): string {
  return p.defaultHours
    ? `Hasn’t set hours yet, so weekdays ${span('09:00', '17:00')}`
    : p.weekly.length
      ? formatHours(p.weekly)
      : 'No working hours set';
}

/** "45 min", "2 hours": a length beside a service. */
export function calendarSetupLength(minutesLong: number): string {
  return minutesLong < 60 || minutesLong % 60 ? `${minutesLong} min` : formatDuration(minutesLong);
}

export function calendarSetupNoticeLabel(m: number): string {
  return m === 0 ? 'Right up to the start' : `${capital(formatNotice(m))} ahead or more`;
}
export function calendarSetupDaysAheadLabel(days: number): string {
  return days >= 365 ? 'Up to a year' : `Up to ${days} days`;
}
export function calendarSetupGapLabel(m: number): string {
  return m === 0 ? 'None' : calendarSetupLength(m);
}
export function calendarSetupChangeLabel(hours: number | null): string {
  if (hours === null) return 'No, they call or message us';
  if (hours === 0) return 'Yes, right up to the start';
  return `Yes, up to ${hours >= 48 ? `${hours / 24} days` : countOf(hours, 'hour', 'hours')} before`;
}
/** "The day before at 4:00 PM", "2 hours before". */
export function calendarSetupReminderLabel(r: Reminder): string {
  if (r.kind === 'day_before') return `The day before at ${formatClock(r.at)}`;
  return `${capital(formatNotice(r.minutes))} before`;
}
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

export interface CalendarSetupLine {
  readonly key: CalendarSetupQuestion;
  readonly label: string;
  /** Null until it's answered. */
  readonly value: string | null;
  /** A second, quieter line (Check it over and the Settings card). */
  readonly detail: string | null;
}

/** The answers so far, one line a question: beside the questions, on Check it over and on the calendar's card. */
export function calendarSetupLines(
  a: CalendarSetupAnswers,
  ctx: CalendarSetupContext,
): CalendarSetupLine[] {
  const W = CALENDAR_SETUP_WORDS;
  if (!a.kind)
    return CALENDAR_SETUP_QUESTIONS.map((key) => ({
      key,
      label: W.lines[key],
      value: null,
      detail: null,
    }));
  const shape = KINDS[a.kind];
  const names = a.people
    .map((u) => ctx.people.find((p) => p.userId === u))
    .filter((p): p is CalendarSetupPerson => !!p)
    .map((p) => (ctx.people.length > 1 ? firstName(p.name) : p.name));
  const what = calendarSetupWhat(a);
  const on = servicesOn(a);
  const places = calendarSetupPlaces(a);
  const lines: Record<CalendarSetupQuestion, Omit<CalendarSetupLine, 'key' | 'label'>> = {
    kind: { value: W.kinds[a.kind].title, detail: a.name.trim() || null },
    who: {
      value: names.length ? andJoin(names) : null,
      detail:
        a.people.length > 1
          ? shape.who === 'run'
            ? null
            : W.assignment[shape.who === 'together' ? 'collective' : a.assignment].line
          : null,
    },
    what:
      what === 'services'
        ? {
            value: on.length ? andJoin(on.map((s) => s.name.trim()).filter(Boolean)) : null,
            detail: on.length ? serviceRange(on) : null,
          }
        : what === 'resource'
          ? {
              value:
                (a.resource.id
                  ? ctx.resources.find((r) => r.id === a.resource.id)?.name
                  : a.resource.name.trim()) || null,
              detail: `${capital(formatDuration(a.minutes))} at a time`,
            }
          : {
              value: capital(formatDuration(a.minutes)),
              detail: what === 'seats' ? `${countOf(a.seats, 'seat', 'seats')}` : null,
            },
    when:
      shape.when === 'dates'
        ? {
            value: a.dates.length ? countOf(a.dates.length, 'date', 'dates') : 'No dates yet',
            detail:
              a.dates[0] && isLocalDate(a.dates[0].date)
                ? `First: ${fmtDateLong(a.dates[0].date)}`
                : null,
          }
        : {
            value:
              a.hours === 'own' || shape.who === null
                ? formatHours(a.ownHours)
                : W.when.people.line,
            detail: `${calendarSetupNoticeLabel(a.noticeMinutes)}, ${calendarSetupDaysAheadLabel(a.daysAhead).toLowerCase()} out.`,
          },
    where: {
      value: places.length
        ? andJoin(places.map((p, i) => (i ? lowerFirst(W.places[p].title) : W.places[p].title)))
        : null,
      detail: calendarSetupGoesOut(a)
        ? a.areas === 'areas'
          ? `${countOf(a.areaIds.length, 'area', 'areas')}, ${calendarSetupLength(a.travelMinutes)} to get there`
          : `Anywhere, ${calendarSetupLength(a.travelMinutes)} to get there`
        : places.includes('business') && a.address.trim()
          ? a.address.trim()
          : null,
    },
    remind: {
      value: remindValue(a),
      detail: `${calendarSetupChangeLabel(a.changeHours)
        .replace(/^Yes, /, 'Cancel or move online ')
        .replace(/^No, .*/, 'No cancelling or moving online')}.`,
    },
    pay: {
      value: W.pay[a.pay].line,
      detail: a.pay === 'deposit' ? depositWords(calendarSetupDeposit(a, ctx)) : null,
    },
  };
  const asked = new Set(calendarSetupQuestions(a));
  return CALENDAR_SETUP_QUESTIONS.filter((key) => asked.has(key)).map((key) => ({
    key,
    label:
      key === 'what'
        ? W.whatLine[what]
        : key === 'who' && shape.who === 'run'
          ? W.linesRun
          : W.lines[key],
    ...lines[key],
  }));
}

// ---- The calendar's card in Settings (C3 a) ----

/**
 * Which of the setup's kinds a calendar's settings look like, for its card: a calendar made with All settings, or
 * changed there since, still gets the closest one.
 */
export function calendarSetupKindOf(config: CalendarConfig): Exclude<CalendarSetupKind, 'scratch'> {
  const options = config.locations.options;
  if (config.schedule.mode === 'sessions')
    return options.length > 0 &&
      options.every((o) => o.kind === 'virtual' && o.video === 'handsfree')
      ? 'webinar'
      : 'event';
  if (config.team.assignment === 'none') return 'resource';
  if (config.team.assignment === 'collective') return 'collective';
  if (config.capacity.seats > 1) return 'class';
  if (options.some((o) => o.kind === 'customer_address')) return 'visit';
  if (config.services.mode !== 'none') return 'appointment';
  return 'meeting';
}

/** One line of a calendar's card: the setup's question, what the calendar does now, and where Change opens. */
export interface CalendarCardLine extends CalendarSetupLine {
  /** The section of All settings that Change opens (null: the top). */
  readonly section: CalendarSectionKey | null;
}

/**
 * The calendar's card in Settings → Calendars (the owner, 22 Nov 2026, C3 a): the setup's seven answers, read back
 * from what the calendar does now, each with a Change that opens that part of All settings. Nothing on the card
 * changes anything by itself, so every setting is still where it was.
 */
export function calendarCardLines(
  config: CalendarConfig,
  catalogs: CalendarCatalogs,
): CalendarCardLine[] {
  const W = CALENDAR_SETUP_WORDS;
  const kind = calendarSetupKindOf(config);
  const team = config.team;
  const sessions = config.schedule.mode === 'sessions';
  const names = team.members
    .map((m) => catalogs.team.find((p) => p.userId === m.userId)?.name)
    .filter((n): n is string => !!n)
    .map((n) => (team.members.length > 1 ? firstName(n) : n));
  const services = config.services.items
    .map((i) => catalogs.services.find((s) => s.id === i.serviceId)?.name)
    .filter((n): n is string => !!n);
  const resources = config.resources.required
    .map((r) => catalogs.resources.find((x) => x.id === r.resourceId)?.name)
    .filter((n): n is string => !!n);
  const n = config.notifications;
  const confirm = n.confirmation.text || n.confirmation.email;
  const messages = [
    confirm ? 'A confirmation' : null,
    n.reminders.length ? countOf(n.reminders.length, 'reminder', 'reminders') : null,
  ].filter((p): p is string => !!p);
  const cancel = config.policies.cancel;
  const places = [...new Set(config.locations.options.map((o) => o.kind))];
  const lines: CalendarCardLine[] = [
    {
      key: 'kind',
      label: W.lines.kind,
      value: W.kinds[kind].title,
      detail: null,
      section: null,
    },
  ];
  if (team.assignment !== 'none')
    lines.push({
      key: 'who',
      label: sessions ? W.linesRun : W.lines.who,
      value: names.length ? andJoin(names) : 'Nobody yet',
      detail:
        team.members.length > 1 && !sessions && team.assignment !== 'fixed'
          ? team.assignment === 'collective'
            ? W.assignment.collective.line
            : team.assignment in W.assignment
              ? W.assignment[team.assignment as keyof typeof W.assignment].line
              : null
          : null,
      section: 'team',
    });
  lines.push(
    team.assignment === 'none' && resources.length
      ? {
          key: 'what',
          label: W.whatLine.resource,
          value: andJoin(resources),
          detail: `${capital(formatDuration(config.durations.minutes[0] ?? 60))} at a time`,
          section: 'resources',
        }
      : config.services.mode !== 'none'
        ? {
            key: 'what',
            label: W.whatLine.services,
            value: services.length ? andJoin(services) : 'None yet',
            detail: null,
            section: 'services',
          }
        : {
            key: 'what',
            label: config.capacity.seats > 1 ? W.whatLine.seats : W.whatLine.length,
            value: moduleSummary('services', config, catalogs),
            detail:
              config.capacity.seats > 1 ? countOf(config.capacity.seats, 'seat', 'seats') : null,
            section: config.capacity.seats > 1 ? 'capacity' : 'services',
          },
    {
      key: 'when',
      label: W.lines.when,
      value: sessions
        ? 'On the dates you post'
        : config.schedule.hours || team.assignment === 'none'
          ? moduleSummary('availability', config, catalogs)
          : W.when.people.line,
      detail: sessions ? null : `${moduleSummary('window', config, catalogs)}.`,
      section: 'availability',
    },
    {
      key: 'where',
      label: W.lines.where,
      value: places.length
        ? andJoin(places.map((p, i) => (i ? lowerFirst(W.places[p].title) : W.places[p].title)))
        : null,
      detail: config.locations.options.some((o) => goesOut(o.kind))
        ? config.territory.routing === 'zip'
          ? moduleSummary('territories', config, catalogs)
          : 'Anywhere'
        : (config.locations.options.find((o) => o.kind === 'business')?.address ?? null),
      section: 'locations',
    },
    {
      key: 'remind',
      label: W.lines.remind,
      value: messages.length ? messages.join(' and ') : 'No messages',
      detail: cancel.allowed
        ? cancel.cutoffHours
          ? `Cancel or move online up to ${countOf(cancel.cutoffHours, 'hour', 'hours')} before.`
          : 'Cancel or move online any time before.'
        : 'No cancelling or moving online.',
      section: 'notify',
    },
    {
      key: 'pay',
      label: W.lines.pay,
      value: moduleSummary('payments', config, catalogs),
      detail: null,
      section: 'payments',
    },
  );
  return lines;
}

function serviceRange(on: readonly CalendarSetupService[]): string {
  const lengths = on.map((s) => s.minutes);
  const prices = on.map((s) => s.priceCents).filter((p): p is number => p !== null);
  const range = (lo: string, hi: string) => (lo === hi ? lo : `${lo} to ${hi}`);
  const parts = [
    range(calendarSetupLength(Math.min(...lengths)), calendarSetupLength(Math.max(...lengths))),
  ];
  if (prices.length) parts.push(range(money(Math.min(...prices)), money(Math.max(...prices))));
  return parts.join(' · ');
}

function remindValue(a: CalendarSetupAnswers): string {
  const n = a.reminders.length;
  const parts = [
    a.confirm ? 'A confirmation' : null,
    n ? countOf(n, 'reminder', 'reminders') : null,
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(' and ') : 'No messages';
}

function depositWords(terms: DepositTerms | null): string | null {
  if (!terms || terms.kind === 'none') return null;
  return terms.kind === 'amount'
    ? `${money(terms.amountCents ?? 0)} when they book`
    : `${(terms.percentBp ?? 0) / 100}% when they book`;
}

export interface CalendarSetupCheck {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  /** The person it is about, when taking them off is a way out. */
  readonly userId?: string;
}

/**
 * Things worth a look before the calendar is made, that don't stop it: someone picked who hasn't set their hours,
 * texts that wait on the carriers, an event with no dates yet.
 */
export function calendarSetupChecks(
  a: CalendarSetupAnswers,
  ctx: CalendarSetupContext,
): CalendarSetupCheck[] {
  if (!a.kind || a.kind === 'scratch') return [];
  const shape = KINDS[a.kind];
  const out: CalendarSetupCheck[] = [];
  if (shape.who && shape.when === 'hours' && a.hours === 'people')
    for (const u of a.people) {
      const p = ctx.people.find((x) => x.userId === u);
      if (!p?.defaultHours) continue;
      const who = p.me ? 'You' : firstName(p.name);
      out.push({
        key: `hours:${u}`,
        userId: u,
        title: p.me ? 'You haven’t set your hours yet' : `${who} hasn’t set hours yet`,
        detail: p.me
          ? `Customers can book you on weekdays from ${span('09:00', '17:00')} until you set them under My calendar.`
          : `Customers can book ${who} on weekdays from ${span('09:00', '17:00')} until ${who} sets them under My calendar.`,
      });
    }
  if (a.byText && !ctx.textingReady && (a.confirm || a.reminders.length))
    out.push({
      key: 'texts',
      title: 'Texts wait on the carriers',
      detail: a.byEmail
        ? 'Until the carriers approve your number, these go by email. Texts start by themselves the day approval lands.'
        : 'Until the carriers approve your number, nothing can be sent by text. Tick Email in question 6 so customers still hear from you.',
    });
  if (shape.when === 'dates' && !a.dates.length)
    out.push({
      key: 'dates',
      title: 'No dates yet',
      detail:
        'Customers see nothing to book until you add a date. Add them here, or later from Calendar.',
    });
  return out;
}

// ---- The settings the answers become ----

export interface CalendarSetupIds {
  /** Each ticked service's id, by its row's key: its own, or the one just made for it. */
  readonly services: Readonly<Record<string, string>>;
  /** The room or equipment's id: its own, or the one just made. */
  readonly resourceId: string | null;
}

/** A complete settings document from the answers, starting from the kind's own starting point. */
export function calendarSetupConfig(
  a: CalendarSetupAnswers,
  ctx: Pick<CalendarSetupContext, 'businessDeposit'>,
  ids: CalendarSetupIds,
): CalendarConfig {
  if (!a.kind) throw new RangeError('Pick what customers book first.');
  const shape = KINDS[a.kind];
  const base = configFromPreset(shape.preset, { me: null });
  if (a.kind === 'scratch') return base;
  const what = calendarSetupWhat(a);
  const places = calendarSetupPlaces(a);
  const out = calendarSetupGoesOut(a);
  const on = servicesOn(a);
  const people = shape.who ? a.people : [];
  const assignment =
    shape.who === null
      ? 'none'
      : shape.who === 'together'
        ? 'collective'
        : people.length <= 1 || shape.who === 'run'
          ? people.length > 1
            ? 'first_available'
            : 'fixed'
          : a.assignment;
  const deposit =
    a.pay === 'deposit' && a.deposit !== 'business' ? calendarSetupDeposit(a, ctx) : null;
  const patch: ConfigPatch = {
    public: true,
    team: {
      members: people.map((userId) => ({
        userId,
        weight: 1,
        priority: 0,
        required: assignment === 'collective',
      })),
      assignment,
    },
    services:
      what === 'services'
        ? {
            mode: on.length === 1 ? 'one' : 'choice',
            items: on
              .map((s) => ids.services[s.key])
              .filter((id): id is string => !!id)
              .map((serviceId) => ({ serviceId })),
          }
        : { mode: 'none', items: [] },
    durations: { minutes: [a.minutes] },
    ...(what === 'seats' ? { capacity: { seats: a.seats } } : {}),
    schedule:
      shape.when === 'dates'
        ? { mode: 'sessions', hours: null }
        : { mode: 'hours', hours: a.hours === 'own' || shape.who === null ? a.ownHours : null },
    locations: {
      options: places.map((kind) => ({
        kind,
        address: kind === 'business' ? a.address.trim() || null : null,
        meetingUrl: kind === 'virtual' ? a.meetingUrl.trim() || null : null,
        ...(a.kind === 'webinar' ? { video: 'handsfree' as const } : {}),
      })),
      customerChooses: places.length > 1,
    },
    resources: {
      required:
        what === 'resource' && ids.resourceId ? [{ resourceId: ids.resourceId, quantity: 1 }] : [],
    },
    buffers: {
      after: a.gapMinutes,
      travelMinutes: out ? a.travelMinutes : 0,
      driveBetween: out && a.drive,
    },
    territory:
      out && a.areas === 'areas'
        ? { routing: 'zip', territoryIds: a.areaIds }
        : { routing: 'off', territoryIds: [] },
    window: { minNoticeMinutes: a.noticeMinutes, maxDaysAhead: a.daysAhead },
    intake: {
      questions: a.ask.map((q) => ({
        id: q.id,
        label: q.label.trim(),
        kind: 'short_text' as const,
        required: q.required,
        options: [],
      })),
    },
    policies: {
      cancel: { allowed: a.changeHours !== null, cutoffHours: a.changeHours ?? 24 },
      reschedule: { allowed: a.changeHours !== null, cutoffHours: a.changeHours ?? 24 },
    },
    notifications: {
      confirmation: { text: a.confirm && a.byText, email: a.confirm && a.byEmail },
      reminders: a.reminders,
      reminderChannels: { text: a.byText, email: a.byEmail },
      staffEmail: a.tellStaff,
    },
    payments: {
      mode: a.pay,
      deposit:
        deposit && deposit.kind !== 'none'
          ? deposit.kind === 'amount'
            ? { kind: 'amount', amountCents: deposit.amountCents ?? 0 }
            : { kind: 'percent', percentBp: deposit.percentBp ?? 0 }
          : null,
    },
  };
  return applyPatch(base, patch);
}

// ---- The command ----

export const CalendarSetupSaveInput = z.object({
  workspaceId: uuid,
  answers: CalendarSetupAnswers,
});
export const CalendarSetupSaveOutput = z.object({
  calendarId: uuid,
  slug: z.string(),
  /** 'active' when it opened for booking; 'draft' when they chose that, or something still stops it opening. */
  status: z.enum(['draft', 'active']),
  /** What stopped it opening, in the calendar's own words; empty when it opened or was meant as a draft. */
  blocked: z.array(z.string()),
  servicesMade: z.int(),
  /** Dates published, and the ones that couldn't be with why. */
  dates: z.array(
    z.object({ startsAt: isoDateTime, published: z.boolean(), why: z.string().nullable() }),
  ),
});
export type CalendarSetupSaveOutput = z.infer<typeof CalendarSetupSaveOutput>;

// ---- The words ----

export const CALENDAR_SETUP_WORDS = {
  pageTitle: 'A new calendar',
  settingUp: (business: string) => `Setting up a calendar for ${business}`,
  soFar: 'Your calendar so far',
  skip: 'Skip the questions and open all settings',
  lines: {
    kind: 'What they book',
    who: 'Who does the work',
    what: 'Services',
    when: 'When',
    where: 'Where',
    remind: 'Reminders and rules',
    pay: 'Paying',
  } satisfies Record<CalendarSetupQuestion, string>,
  linesRun: 'Who runs it',
  whatLine: {
    services: 'Services',
    length: 'How long',
    seats: 'Length and seats',
    resource: 'What gets booked',
  },
  kind: {
    title: 'What do customers book?',
    hint: 'Pick the closest one. You can change anything later.',
    more: 'More kinds',
    fewer: 'Fewer kinds',
    name: 'What should we call this calendar?',
    nameHint: 'Customers see this name on the booking page.',
    scratchNext: 'Open all settings',
  },
  kinds: {
    appointment: {
      title: 'An appointment for a service',
      hint: 'They pick a service, then a time with whoever is free.',
    },
    visit: {
      title: 'A visit to their home or business',
      hint: 'You go to them, in the areas you cover.',
    },
    meeting: {
      title: 'A meeting or a call',
      hint: 'A consult, a quote or a check-in with one person.',
    },
    class: { title: 'A class or group session', hint: 'Several people book the same time.' },
    event: { title: 'An event on set dates', hint: 'You post the dates. People save a seat.' },
    webinar: {
      title: 'A webinar',
      hint: 'You present on a HandsFreeOS video call and people save a seat to watch.',
    },
    resource: {
      title: 'A room or equipment',
      hint: 'A bed, a room or a machine gets booked. No staff needed.',
    },
    collective: {
      title: 'Two of you at every booking',
      hint: 'Everyone you pick has to be free at the same time.',
    },
    scratch: {
      title: 'Start from scratch',
      hint: 'No questions. Every setting opens at its default.',
    },
  } satisfies Record<CalendarSetupKind, { title: string; hint: string }>,
  who: {
    title: {
      pick: 'Who does the work?',
      run: 'Who runs it?',
      together: 'Who goes to every booking?',
    },
    hint: {
      pick: 'Tick everyone customers can book here.',
      run: 'Tick whoever leads it.',
      together: 'Tick everyone who has to be there. A time shows only when all of them are free.',
    },
    you: 'You',
    invite: 'Invite someone to your team',
    assignTitle: 'When more than one of them is free, who gets the booking?',
  },
  assignment: {
    first_available: {
      title: 'The first one free',
      hint: 'The first person on your list who is free takes it.',
      line: 'The first one free gets the booking.',
    },
    round_robin: {
      title: 'They take turns',
      hint: 'Bookings spread out evenly across them.',
      line: 'They take turns.',
    },
    customer_choice: {
      title: 'The customer picks',
      hint: 'They choose who they want, or anyone.',
      line: 'The customer picks who.',
    },
    collective: {
      title: 'They all go together',
      hint: 'Every booking needs all of them free.',
      line: 'They all go together.',
    },
  } satisfies Record<CalendarSetupAssignment, { title: string; hint: string; line: string }>,
  best: 'Best',
  what: {
    services: {
      title: 'What can they book, and how long does it take?',
      hint: 'Tick what this calendar offers. A change here changes the service everywhere.',
    },
    length: { title: 'How long is each booking?', hint: 'Every booking here takes this long.' },
    seats: {
      title: 'How long is it, and how many can come?',
      hint: 'Bookings stop when the seats are gone, and the rest can join a waitlist.',
    },
    resource: {
      title: 'What gets booked, and for how long?',
      hint: 'Pick the room or equipment. One booking holds it for the whole time.',
    },
    takes: 'Takes',
    price: 'Price',
    whoDoes: 'Who does it',
    everyone: 'Everyone',
    add: 'Add a service',
    newName: 'Name of the service',
    remove: 'Remove',
    severalLengths: (lengths: string) =>
      `${lengths}. Change its lengths in Settings → Calendars → Services.`,
    toLength: 'Let customers book a length of time instead',
    toServices: 'Let customers pick a service instead',
    lengthLabel: 'How long',
    seatsLabel: 'How many can come',
    resourcePick: 'Room or equipment',
    resourceNew: 'Add a new one',
    resourceName: 'What is it called?',
  },
  when: {
    title: 'When can customers book?',
    datesTitle: 'When is it?',
    datesHint: 'Add each date and its start time. You can add more later from Calendar.',
    people: {
      title: 'Any time the people you picked are working',
      hint: 'Each person’s own hours decide. They set them under My calendar.',
      line: 'Any time the people you picked are working',
    },
    own: {
      title: 'Only during hours I set for this calendar',
      hint: 'Still only when the person is working.',
    },
    roomHours: 'The hours it can be booked',
    notice: 'How soon can they book?',
    daysAhead: 'How far out?',
    gap: 'Time between bookings',
    addDate: 'Add a date',
    date: 'Date',
    time: 'Starts at',
    connectNote:
      'After this, each person can connect their Google or Outlook calendar, so their own plans block these times too.',
  },
  where: {
    title: 'Where does it happen?',
    hint: 'Tick every place that fits. With more than one, the customer picks.',
    visitTitle: 'Where do you go?',
    visitHint: 'Customers type their address when they book.',
    address: 'Your address',
    meetingUrl: 'Your meeting link',
    meetingUrlHint:
      'Paste a Zoom, Google Meet or other link. Leave it empty to use HandsFreeOS video calls.',
    anywhere: { title: 'Anywhere', hint: 'Any address can book.' },
    areas: {
      title: 'Only the areas we cover',
      hint: 'Customers type their ZIP code first. Outside your areas, they can’t book.',
    },
    addArea: 'Add an area',
    noAreas: 'You have no areas yet.',
    travel: 'Time to leave around every visit',
    travelHint: 'Kept free before and after each visit, for the drive and setting up.',
    drive: 'Also work out the real drive between visits',
    driveHint: 'Times show only when the person can get there from their visit before.',
  },
  places: {
    business: { title: 'At your place', hint: 'Customers come to you.' },
    customer_address: { title: 'At the customer’s address', hint: 'You go to them.' },
    phone: { title: 'On a phone call', hint: 'You call the number they give.' },
    virtual: { title: 'On a video call', hint: 'They get a link in their confirmation.' },
    meetup: { title: 'At a spot you agree on', hint: 'A coffee shop or a job site.' },
  } satisfies Record<LocationKind, { title: string; hint: string }>,
  remind: {
    title: 'What should customers hear from you?',
    hint: 'These go out by themselves for every booking.',
    confirm: 'A confirmation when they book',
    reminders: 'Reminders',
    addReminder: 'Add a reminder',
    dayBefore: 'The day before at',
    before: 'before',
    sendBy: 'Send by',
    text: 'Text',
    email: 'Email',
    textsWait:
      'Until the carriers approve your number, these go by email. Texts start by themselves the day approval lands.',
    change: 'Can they cancel or move it online?',
    ask: 'Anything to ask when they book?',
    askHint: 'Name, phone and email are always asked.',
    addAsk: 'Add a question',
    askPlaceholder: 'Anything we should know before you come in?',
    required: 'Must answer',
    tellStaff: 'Email whoever got the booking',
  },
  pay: {
    title: 'Do they pay when they book?',
    none: {
      title: 'No, they pay later',
      hint: 'Nothing is charged at booking.',
      line: 'They pay later',
    },
    deposit: {
      title: 'A deposit',
      hint: 'They pay part now and the rest later.',
      line: 'A deposit when they book',
      badge: 'Cuts no-shows',
    },
    full: {
      title: 'The full price',
      hint: 'They pay it all when they book.',
      line: 'The full price when they book',
    },
    howMuch: 'How much?',
    usual: (terms: string) => `Your usual deposit (${terms})`,
    percent: (n: number) => `${n}% of the price`,
    amount: 'A set amount',
    connect: 'Connect a payment account',
    connectNote:
      'Taking money at booking needs a payment account. Connect one in Settings → Payments, then come back. Your answers are saved.',
  },
  review: {
    title: 'Check it over',
    hint: 'Nothing is made until you press Make this calendar.',
    toCheck: (n: number) => (n === 1 ? 'One thing to check' : `${n} things to check`),
    takeOff: (name: string) => `Take ${name} off for now`,
    open: 'Open it for booking right away',
    openHint: 'Untick to keep it as a draft until you’re ready.',
    make: 'Make this calendar',
    next: 'What happens next',
    nextLines: [
      'The calendar is made with these answers.',
      'It gets its own link to share or put on your website.',
      'Every other setting stays one click away, under All settings.',
    ],
  },
  done: {
    open: (name: string) => `${name} is open for booking`,
    draft: (name: string) => `${name} is saved as a draft`,
    draftHint:
      'Customers can’t book it yet. Open it for booking from its page in Settings → Calendars.',
    blocked: 'It couldn’t open for booking yet:',
    link: 'Its link, to share anywhere',
    copy: 'Copy',
    copied: 'Link copied',
    see: 'See it as a customer',
    next: 'Good next steps',
    website: {
      title: 'Put it on your website',
      hint: 'One line of code shows this calendar on any page. Copy it, or email it to your web person.',
      button: 'Get the code',
    },
    connect: {
      title: 'Connect your Google or Outlook calendar',
      hint: 'Your own plans then block booking times, and bookings show on your calendar. Each person does this once.',
      button: 'Connect mine',
    },
    dates: {
      title: 'Add your dates',
      hint: 'Customers see nothing to book until a date is posted.',
      button: 'Open Calendar',
    },
    later: (name: string) => `Change anything later in Settings → Calendars → ${name}.`,
    another: 'Set up another calendar',
    all: 'Go to Calendars',
    settings: 'Open its settings',
  },
} as const;

/** The calendar's card in Settings → Calendars (C3 a), shared with the phone. */
export const CALENDAR_CARD_WORDS = {
  change: 'Change',
  link: 'Its booking link',
  copy: 'Copy',
  copied: 'Link copied.',
  see: 'See it as a customer',
  draft: 'It’s a draft, so customers can’t book it yet.',
  paused: 'It’s paused. Its link says it isn’t taking bookings, and upcoming appointments stay.',
  archived: 'It’s archived. Bring it back from All settings.',
  open: 'Open for booking',
  pause: 'Pause booking',
  resume: 'Open it again',
  opened: (name: string) => `${name} is open for booking.`,
  pausedNow: (name: string) =>
    `${name} is paused. Its link says it isn’t taking bookings; upcoming appointments stay.`,
  toCheck: 'Things to check',
  fix: 'Fix it',
  all: {
    title: 'All settings',
    hint: 'Every setting this calendar has, like buffers, intake questions, repeats, the waitlist and its design. Its history and Archive are there too.',
    button: 'Open all settings',
  },
  again: 'Set up another calendar',
} as const;
