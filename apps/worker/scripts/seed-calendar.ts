/**
 * Milestone 5 demo data for Lone Star (design/m5): one universal calendar in four shapes, each built the way an
 * owner would build it.
 * - Catalogs: six services, Truck 2, the office and the duct vacuums, three ZIP territories and the booking site.
 * - Hours: everyone sets their own; Dale takes a week off in about four weeks.
 * - Calendars, each created from a preset, then saved and turned on: Dale's own (Personal), "AC tune-up"
 *   (Dispatch · Round Robin · Service), "Install walkthrough" (Collective) and "Homeowner HVAC class" (Event,
 *   three sessions, one of them full with people waiting).
 * - About two weeks of appointments the team books without messaging the customers (some done, a no-show, a
 *   cancel), and one customer booking online through the booking page's own command, so one confirmation text
 *   goes to the fake carrier.
 * - Dale connects his stand-in Google calendar through the worker's real sign-in routes, and its busy times are
 *   read in.
 *
 * Staff actions run as the person who would do them; only the booking page's command runs as the system, on the
 * booking_page channel, the way the worker's public route runs it.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  appointmentAddAttendee,
  appointmentBookOnline,
  appointmentCancel,
  appointmentCreate,
  appointmentSetStatus,
  applyPatch,
  bookingSiteUpdate,
  calendarConnectionConnect,
  calendarCreate,
  calendarGet,
  calendarSave,
  calendarSetStatus,
  executeCommand,
  executeQuery,
  formatLabels,
  HfosError,
  inferLabels,
  localDateOf,
  localInstant,
  messageUpdateStatus,
  resourceCreate,
  scheduleSet,
  serviceCreate,
  sessionPublish,
  territoryCreate,
  timeOffAdd,
  waitlistAdd,
  weekdayOf,
  type CalendarConfig,
  type CommandDef,
  type ConfigPatch,
  type HumanActor,
  type PresetKey,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql, type Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { buildHttpServer } from '../src/http/server';
import type { OutboxDeps } from '../src/outbox';
import { systemActor, workerMeta } from '../src/services';
import { settle } from './seed-messaging';

export interface SeedCalendarDeps {
  readonly api: Db;
  readonly admin: Db;
  /** The worker's services and loop settings, as the seed built them (the stand-in calendars included). */
  readonly worker: OutboxDeps;
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
  /** Only work created after this is claimed (other suites leave rows behind). */
  readonly since: string;
}

export interface SeedCalendarWorkspace {
  readonly id: string;
  readonly organizationId: string;
  readonly dale: TestUser;
  readonly priya: TestUser;
  readonly marco: TestUser;
}

export interface SeededCalendars {
  /** The booking site's link name. */
  readonly site: string;
  readonly calendars: readonly { name: string; labels: string; slug: string }[];
  readonly appointments: number;
  readonly waiting: number;
  readonly busyTimes: number;
  readonly seconds: number;
}

/** Customers book at /book/lone-star-hvac. */
export const LONE_STAR_SITE = 'lone-star-hvac';
/** Dale's stand-in Google account; the fake provider keeps its busy times in memory. */
const DALE_GOOGLE = 'dale.ramsey@gmail.fake';
const OFFICE = 'Lone Star office, 4410 Westpark Dr, Houston, TX 77027';
const MIN = 60_000;

type Who = 'dale' | 'priya' | 'marco';
type ServiceKey = 'tuneup' | 'furnace' | 'rooftop' | 'duct' | 'walkthrough' | 'class';

/** Where each customer is visited (the canvas's addresses where it has them). */
const ADDRESSES: Readonly<Record<string, string>> = {
  'Angela Brooks': '918 Heights Blvd, Houston, TX 77008',
  'Bill Hayes': 'Cypress Creek Church, 12800 Cypress Creek Pkwy, Houston, TX 77429',
  'Carlos Mendoza': '14803 Kimberley Ln, Houston, TX 77079',
  'David Kim': '8726 Braesmont Dr, Houston, TX 77096',
  'Denise Walker': '3406 Nottingham St, Houston, TX 77005',
  'Elena Duarte': 'Bayou Bistro, 318 Gray St, Houston, TX 77002',
  'Greg Thompson': '1107 Bingle Rd, Houston, TX 77055',
  'Hannah Nguyen': '2419 Dunstan Rd, Houston, TX 77005',
  'Isaac Boone': '14410 Memorial Dr, Houston, TX 77079',
  'James Whitfield': '1820 Oxford St, Houston, TX 77008',
  'Jasmine Carter': '2111 Welch St, Houston, TX 77019',
  'Kendra Lee': '9102 Bissonnet St, Houston, TX 77074',
  "Kevin O'Brien": '1918 Kipling St, Houston, TX 77098',
  'Laura Fischer': '11807 Westheimer Rd, Houston, TX 77077',
  'Linda Okafor': '5107 Evergreen St, Bellaire, TX 77401',
  'Maria Santos': '2200 Riverside Dr, Building C, Houston, TX 77004',
  'Mike Johnson': '1402 Oak Hollow Dr, Houston, TX 77006',
  'Nathan Price': '7702 Westview Dr, Houston, TX 77055',
  'Olivia Grant': '4620 Bissonnet St, Bellaire, TX 77401',
  'Quincy Adams': 'Heights Auto Care, 1520 Heights Blvd, Houston, TX 77008',
  'Rachel Stein': 'Memorial Pediatrics, 9055 Memorial Dr, Houston, TX 77024',
  'Robert Chen': 'ABC Dental, 4521 Kirby Dr, Houston, TX 77098',
  'Sam Patel': '4015 Drake St, Houston, TX 77005',
  'Sarah Alvarez': '3612 Rice Blvd, Houston, TX 77005',
  'Tina Morales': '6011 Braesheather Dr, Houston, TX 77096',
  'Tom Reyes': '2410 Cinco Ranch Blvd, Katy, TX 77494',
  'Victor Hale': '12615 Briar Forest Dr, Houston, TX 77077',
  'Wendy Liu': '5202 Braeburn Dr, Bellaire, TX 77401',
  'Yusuf Ali': '11910 Riverview Dr, Houston, TX 77077',
};

/**
 * One visit: a business day (0 is today, or the next weekday on a weekend; -1 the weekday before today), a local
 * start, and who books it. Times are spaced so nobody's travel runs into their next visit: any warning on a visit
 * still ahead stops the seed.
 */
interface Visit {
  readonly day: number;
  readonly at: string;
  readonly on: 'dale' | 'dispatch' | 'walkthrough';
  readonly service?: ServiceKey;
  readonly minutes: number;
  /** Who works it; left out, the calendar chooses (the walkthrough needs Dale and Marco both). */
  readonly staff?: readonly Who[];
  readonly customer: string;
  readonly title?: string;
  readonly notes?: string;
  /** A past visit that wasn't simply done, or one called off ahead of time. */
  readonly outcome?: 'no_show' | 'cancelled';
  readonly by: Who;
}

const VISITS: readonly Visit[] = [
  // The week before
  {
    day: -5,
    at: '09:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 90,
    staff: ['marco'],
    customer: 'James Whitfield',
    by: 'priya',
  },
  {
    day: -4,
    at: '08:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['priya'],
    customer: 'Olivia Grant',
    by: 'priya',
  },
  {
    day: -4,
    at: '13:00',
    on: 'dispatch',
    service: 'furnace',
    minutes: 60,
    staff: ['marco'],
    customer: 'Isaac Boone',
    by: 'priya',
  },
  {
    day: -3,
    at: '10:00',
    on: 'dale',
    minutes: 60,
    customer: 'Maria Santos',
    title: 'Estimate visit',
    notes: 'Three rooftop units on building C. Bring the lift quote.',
    by: 'dale',
  },
  {
    day: -2,
    at: '14:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['priya'],
    customer: 'David Kim',
    outcome: 'no_show',
    by: 'priya',
  },
  {
    day: -1,
    at: '09:00',
    on: 'dispatch',
    service: 'duct',
    minutes: 180,
    staff: ['marco'],
    customer: 'Laura Fischer',
    by: 'priya',
  },
  {
    day: -1,
    at: '13:30',
    on: 'walkthrough',
    service: 'walkthrough',
    minutes: 90,
    customer: 'Sarah Alvarez',
    notes: 'Leaning toward the 16 SEER unit. Wants it in before the heat.',
    by: 'dale',
  },
  // Today, as on the canvas
  {
    day: 0,
    at: '08:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['priya'],
    customer: 'Linda Okafor',
    by: 'priya',
  },
  {
    day: 0,
    at: '08:30',
    on: 'dispatch',
    service: 'duct',
    minutes: 90,
    staff: ['marco'],
    customer: 'Tom Reyes',
    notes: 'Greenway’s model home. Key in the lockbox, code 2190.',
    by: 'priya',
  },
  {
    day: 0,
    at: '09:30',
    on: 'dale',
    minutes: 60,
    customer: 'Robert Chen',
    title: 'Estimate visit',
    notes: 'Front office unit is grinding. Ask for Robert at the front desk.',
    by: 'dale',
  },
  {
    day: 0,
    at: '10:00',
    on: 'dispatch',
    service: 'furnace',
    minutes: 60,
    staff: ['priya'],
    customer: 'Sarah Alvarez',
    by: 'priya',
  },
  {
    day: 0,
    at: '11:00',
    on: 'walkthrough',
    service: 'walkthrough',
    minutes: 90,
    customer: 'Angela Brooks',
    notes: 'New 3-ton system for the upstairs. Measure the attic access.',
    by: 'dale',
  },
  {
    day: 0,
    at: '13:30',
    on: 'dispatch',
    service: 'rooftop',
    minutes: 120,
    staff: ['marco', 'priya'],
    customer: 'Maria Santos',
    notes: 'Gate code 4412. Tenants on the third floor say it’s warm.',
    by: 'priya',
  },
  // The next two weeks
  {
    day: 1,
    at: '10:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['marco'],
    customer: 'Mike Johnson',
    notes: 'Gate code 4471. Prefers texts over calls.',
    by: 'priya',
  },
  {
    day: 1,
    at: '10:30',
    on: 'dale',
    minutes: 60,
    customer: 'Bill Hayes',
    title: 'Estimate visit',
    notes: 'Show the two-unit option first. The building committee meets Tuesday.',
    by: 'dale',
  },
  {
    day: 1,
    at: '13:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['priya'],
    customer: 'Kendra Lee',
    by: 'priya',
  },
  {
    day: 2,
    at: '09:00',
    on: 'dispatch',
    service: 'furnace',
    minutes: 120,
    staff: ['marco'],
    customer: 'Greg Thompson',
    by: 'priya',
  },
  {
    day: 2,
    at: '11:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 90,
    staff: ['priya'],
    customer: 'Hannah Nguyen',
    notes: 'Two systems, upstairs and down.',
    by: 'priya',
  },
  {
    day: 2,
    at: '13:00',
    on: 'dispatch',
    service: 'duct',
    minutes: 180,
    staff: ['marco'],
    customer: 'Quincy Adams',
    notes: 'The shop bays close at 5.',
    by: 'priya',
  },
  {
    day: 3,
    at: '09:00',
    on: 'dispatch',
    service: 'rooftop',
    minutes: 120,
    staff: ['marco', 'priya'],
    customer: 'Elena Duarte',
    notes: 'Roof access through the kitchen. Finish before the lunch rush.',
    by: 'priya',
  },
  {
    day: 3,
    at: '09:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['dale'],
    customer: 'Sam Patel',
    by: 'priya',
  },
  {
    day: 4,
    at: '09:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['marco'],
    customer: 'Nathan Price',
    by: 'marco',
  },
  {
    day: 4,
    at: '10:00',
    on: 'dale',
    minutes: 60,
    customer: 'Rachel Stein',
    title: 'Estimate visit',
    notes: 'Waiting room split system. Bring two options.',
    by: 'dale',
  },
  {
    day: 4,
    at: '13:00',
    on: 'dispatch',
    service: 'furnace',
    minutes: 60,
    staff: ['priya'],
    customer: 'Wendy Liu',
    outcome: 'cancelled',
    by: 'priya',
  },
  {
    day: 5,
    at: '10:00',
    on: 'walkthrough',
    service: 'walkthrough',
    minutes: 90,
    customer: 'Jasmine Carter',
    notes: 'Replacing a 20-year-old system.',
    by: 'dale',
  },
  {
    day: 5,
    at: '13:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['priya'],
    customer: 'Olivia Grant',
    by: 'priya',
  },
  {
    day: 6,
    at: '09:00',
    on: 'dispatch',
    service: 'duct',
    minutes: 180,
    staff: ['marco'],
    customer: 'Victor Hale',
    by: 'priya',
  },
  {
    day: 6,
    at: '10:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['priya'],
    customer: 'Denise Walker',
    by: 'priya',
  },
  {
    day: 6,
    at: '13:30',
    on: 'dispatch',
    service: 'furnace',
    minutes: 60,
    staff: ['marco'],
    customer: 'Carlos Mendoza',
    notes: 'Furnace check before winter.',
    by: 'priya',
  },
  {
    day: 7,
    at: '09:00',
    on: 'dale',
    minutes: 60,
    customer: 'Maria Santos',
    title: 'Site walk',
    notes: 'Building C rooftop units: final numbers with Maria.',
    by: 'dale',
  },
  {
    day: 7,
    at: '13:00',
    on: 'dispatch',
    service: 'furnace',
    minutes: 60,
    staff: ['priya'],
    customer: 'Tina Morales',
    by: 'priya',
  },
  {
    day: 8,
    at: '08:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['priya'],
    customer: "Kevin O'Brien",
    by: 'priya',
  },
  {
    day: 8,
    at: '13:00',
    on: 'walkthrough',
    service: 'walkthrough',
    minutes: 90,
    customer: 'Yusuf Ali',
    by: 'dale',
  },
  {
    day: 9,
    at: '10:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['marco'],
    customer: 'Laura Fischer',
    by: 'priya',
  },
  {
    day: 9,
    at: '11:00',
    on: 'dispatch',
    service: 'tuneup',
    minutes: 60,
    staff: ['dale'],
    customer: 'Robert Chen',
    notes: 'Follow-up on the front office unit.',
    by: 'dale',
  },
];

/** Class sessions from 3 to 5 PM on the first Monday to Thursday at least `days` out: who took seats, who waits. */
const SESSIONS: readonly {
  readonly days: number;
  readonly seats: readonly (readonly [string, number])[];
  readonly waiting?: readonly (readonly [string, number])[];
}[] = [
  {
    days: 4,
    seats: [
      ['Hannah Nguyen', 2],
      ['Carlos Mendoza', 2],
      ['Laura Fischer', 1],
      ['Denise Walker', 1],
    ],
  },
  {
    days: 10,
    seats: [
      ['Greg Thompson', 3],
      ['Isaac Boone', 2],
      ['Jasmine Carter', 2],
      ["Kevin O'Brien", 1],
      ['Nathan Price', 2],
      ['Olivia Grant', 2],
    ],
    waiting: [
      ['Tina Morales', 2],
      ['Victor Hale', 1],
      ['Yusuf Ali', 1],
    ],
  },
  {
    days: 21,
    seats: [
      ['Wendy Liu', 2],
      ['Sam Patel', 1],
    ],
  },
];

const iso = (ms: number): string => new Date(ms).toISOString();
const zipOf = (address: string): string | null => /(\d{5})$/.exec(address)?.[1] ?? null;
const reasonOf = (e: unknown): string =>
  e instanceof HfosError ? `${e.message} ${JSON.stringify(e.details ?? {})}` : String(e);

/** Dale signs in to his stand-in Google calendar through the worker's routes, as the worker tests do. */
async function connectGoogle(
  d: SeedCalendarDeps,
  ws: SeedCalendarWorkspace,
  account: string,
): Promise<string> {
  const { output } = await executeCommand(
    d.api,
    calendarConnectionConnect,
    { workspaceId: ws.id, provider: 'google' },
    d.actor(ws.dale),
    d.meta(),
  );
  const app = await buildHttpServer({
    ...d.worker,
    httpDb: d.worker.db,
    verifyToken: null,
    webOrigins: [d.worker.webUrl],
  });
  try {
    const hop = async (url: string) => {
      const res = await app.inject({ method: 'GET', url });
      if (res.statusCode !== 302)
        throw new Error(
          `Connecting Dale’s calendar: ${url.split('?')[0]} answered ${res.statusCode}`,
        );
      return new URL(String(res.headers.location));
    };
    // Start, then the stand-in page's Allow, then the callback that seals the sign-in and activates it.
    const authorize = await hop(`/oauth/google/start?state=${encodeURIComponent(output.state)}`);
    const callback = await hop(
      `/oauth/fake/google/approve?${new URLSearchParams({
        state: output.state,
        code_challenge: authorize.searchParams.get('code_challenge') ?? '',
        redirect_uri: authorize.searchParams.get('redirect_uri') ?? '',
        email: account,
        decision: 'allow',
      })}`,
    );
    const back = await hop(`${callback.pathname}${callback.search}`);
    if (back.searchParams.get('calendar') !== 'connected')
      throw new Error(`Dale’s calendar did not connect (${back.search}).`);
  } finally {
    await app.close();
  }
  return output.connectionId;
}

export async function seedCalendar(
  d: SeedCalendarDeps,
  ws: SeedCalendarWorkspace,
): Promise<SeededCalendars> {
  const started = Date.now();
  const workspaceId = ws.id;
  const team: Record<Who, TestUser> = { dale: ws.dale, priya: ws.priya, marco: ws.marco };
  const ids = (list: readonly Who[]) => list.map((w) => team[w].id);
  const run = <I extends z.ZodType, O extends z.ZodType>(
    who: Who,
    command: CommandDef<I, O>,
    input: z.input<I>,
  ) => executeCommand(d.api, command, input, d.actor(team[who]), d.meta()).then((r) => r.output);

  const [w] = await rows<{ timezone: string }>(
    d.admin,
    sql`select timezone from app.workspaces where id = ${workspaceId}`,
  );
  const tz = w!.timezone;
  const today = localDateOf(Date.now(), tz);
  const at = (date: string, clock: string) => localInstant(date, clock, tz);
  const isWeekday = (date: string) => weekdayOf(date) >= 1 && weekdayOf(date) <= 5;
  const businessDay = (n: number): string => {
    let date = today;
    if (n >= 0) {
      while (!isWeekday(date)) date = addDays(date, 1);
      for (let i = 0; i < n;) if (isWeekday((date = addDays(date, 1)))) i++;
    } else for (let i = 0; i > n;) if (isWeekday((date = addDays(date, -1)))) i--;
    return date;
  };
  // Monday to Thursday: everyone's hours and the office's fit a class until 5 (with its half hour after).
  const classDay = (days: number): string => {
    let date = addDays(today, days);
    while (weekdayOf(date) < 1 || weekdayOf(date) > 4) date = addDays(date, 1);
    return date;
  };

  d.step(
    'Lone Star: services, Truck 2, the office, the duct vacuums, three ZIP territories and the booking site',
  );
  const days = (list: readonly number[], start: string, end: string) =>
    list.map((day) => ({ day, start, end }));
  const WEEKDAYS = [1, 2, 3, 4, 5];
  const truck = (
    await run('dale', resourceCreate, {
      workspaceId,
      name: 'Truck 2',
      kind: 'vehicle',
      quantity: 1,
      hours: days([...WEEKDAYS, 6], '07:00', '18:00'),
    })
  ).resourceId;
  const office = (
    await run('dale', resourceCreate, {
      workspaceId,
      name: 'Office',
      kind: 'room',
      quantity: 1,
      location: '4410 Westpark Dr, Houston, TX 77027',
      hours: days(WEEKDAYS, '08:00', '17:00'),
    })
  ).resourceId;
  await run('dale', resourceCreate, {
    workspaceId,
    name: 'Duct vacuum',
    kind: 'equipment',
    quantity: 2,
  });
  const service = (input: Omit<z.input<typeof serviceCreate.input>, 'workspaceId'>) =>
    run('dale', serviceCreate, { workspaceId, ...input }).then((o) => o.serviceId);
  const atHome = ['customer_address' as const];
  const services: Record<ServiceKey, string> = {
    tuneup: await service({
      name: 'AC tune-up',
      description: 'Cleaning and a full check of your AC',
      durations: [60, 90],
      bufferAfter: 15,
      color: '#0e7490',
      priceCents: 8900,
      locationKinds: atHome,
    }),
    furnace: await service({
      name: 'Furnace repair',
      description: 'We find the problem and fix it',
      durations: [60, 120],
      bufferBefore: 15,
      bufferAfter: 15,
      color: '#b45309',
      priceCents: 12000,
      locationKinds: atHome,
      staffUserIds: ids(['priya', 'marco']),
    }),
    rooftop: await service({
      name: 'Rooftop unit tune-up',
      description: 'For apartments and businesses. Two of us come with Truck 2.',
      durations: [120],
      bufferBefore: 15,
      bufferAfter: 15,
      color: '#0f766e',
      priceCents: 24900,
      locationKinds: atHome,
      staffUserIds: ids(['marco', 'priya']),
      resources: [{ resourceId: truck, quantity: 1 }],
    }),
    duct: await service({
      name: 'Duct cleaning',
      description: 'Every supply and return duct, vacuumed and sanitized',
      durations: [90, 180, 240],
      defaultDuration: 180,
      bufferBefore: 15,
      bufferAfter: 30,
      color: '#4d7c0f',
      locationKinds: atHome,
      staffUserIds: ids(['marco', 'priya']),
      resources: [{ resourceId: truck, quantity: 1 }],
    }),
    walkthrough: await service({
      name: 'Install walkthrough',
      description: 'We measure your home and plan the new system with you',
      durations: [90],
      color: '#7c3aed',
      locationKinds: atHome,
      staffUserIds: ids(['dale', 'marco']),
    }),
    class: await service({
      name: 'Homeowner HVAC class',
      description: 'Two hours at our office on keeping your AC running. Free.',
      durations: [120],
      bufferBefore: 30,
      bufferAfter: 30,
      color: '#c2410c',
      locationKinds: ['business'],
      staffUserIds: ids(['dale']),
      resources: [{ resourceId: office, quantity: 1 }],
    }),
  };
  const territory = (name: string, postalCodes: string[], people: Who[]) =>
    run('priya', territoryCreate, { workspaceId, name, postalCodes, userIds: ids(people) }).then(
      (o) => o.territoryId,
    );
  const territories = [
    await territory(
      'Houston Central',
      ['77002', '77003', '77004', '77005', '77006', '77008', '77098'],
      ['priya', 'marco'],
    ),
    await territory(
      'West Houston & Katy',
      ['77024', '77055', '77077', '77079', '77494'],
      ['marco'],
    ),
    await territory('Bellaire & Southwest', ['77074', '77096', '77401'], ['priya']),
  ];
  await run('priya', bookingSiteUpdate, {
    workspaceId,
    slug: LONE_STAR_SITE,
    name: 'Lone Star HVAC & Roofing',
    intro:
      'Tune-ups, repairs and duct cleaning in Houston, Katy and Bellaire, and a free class for homeowners.',
    enabled: true,
  });

  d.step('Lone Star: everyone’s hours, and Dale’s week off in about four weeks');
  await run('dale', scheduleSet, {
    workspaceId,
    weekly: [
      ...days([1, 2, 3, 4], '08:00', '18:00'),
      ...days([5], '08:00', '17:00'),
      ...days([6], '09:00', '13:00'),
    ],
  });
  await run('priya', scheduleSet, { workspaceId, weekly: days(WEEKDAYS, '07:00', '16:00') });
  await run('marco', scheduleSet, { workspaceId, weekly: days(WEEKDAYS, '08:00', '17:00') });
  let away = addDays(today, 28);
  while (weekdayOf(away) !== 1) away = addDays(away, 1);
  await run('dale', timeOffAdd, {
    workspaceId,
    startDate: away,
    endDate: addDays(away, 4),
    note: 'Vacation',
  });

  d.step(
    'Lone Star: four calendars from presets (Personal, Dispatch, Collective, Event), saved and turned on',
  );
  const calendar = async (spec: {
    name: string;
    preset: PresetKey;
    color: string;
    description: string;
    teammates?: Who[];
    patch: ConfigPatch;
  }) => {
    const created = await run('dale', calendarCreate, {
      workspaceId,
      name: spec.name,
      preset: spec.preset,
      color: spec.color,
      description: spec.description,
      teammates: ids(spec.teammates ?? []),
    });
    const { calendar: c } = await executeQuery(
      d.api,
      calendarGet,
      { workspaceId, calendarId: created.calendarId },
      d.actor(ws.dale),
      d.meta(),
    );
    const draft = applyPatch(c.config as CalendarConfig, spec.patch);
    await run('dale', calendarSave, {
      workspaceId,
      calendarId: created.calendarId,
      baseRevision: c.revision,
      draft,
    });
    await run('dale', calendarSetStatus, {
      workspaceId,
      calendarId: created.calendarId,
      status: 'active',
    });
    return {
      id: created.calendarId,
      slug: created.slug,
      name: spec.name,
      labels: formatLabels(inferLabels(draft)),
    };
  };
  const calendars = {
    dale: await calendar({
      name: 'Dale’s calendar',
      preset: 'personal',
      color: '#2d69d8',
      description: 'Estimates and site visits with Dale.',
      patch: { locations: { options: [{ kind: 'customer_address' }] } },
    }),
    dispatch: await calendar({
      name: 'AC tune-up',
      preset: 'dispatch',
      color: '#0e7490',
      description: 'Tune-ups, repairs and duct cleaning at your home or business.',
      teammates: ['priya', 'marco', 'dale'],
      patch: {
        // Weighted turns: Priya and Marco take two for each one of Dale's.
        team: {
          assignment: 'weighted',
          members: [
            { userId: ws.priya.id, weight: 2 },
            { userId: ws.marco.id, weight: 2 },
            { userId: ws.dale.id, weight: 1 },
          ],
        },
        services: {
          mode: 'choice',
          items: [services.tuneup, services.furnace, services.rooftop, services.duct].map(
            (serviceId) => ({ serviceId }),
          ),
        },
        territory: { routing: 'zip', territoryIds: territories },
      },
    }),
    walkthrough: await calendar({
      name: 'Install walkthrough',
      preset: 'collective',
      color: '#7c3aed',
      description: 'Dale and Marco plan your new system with you, at your home.',
      teammates: ['marco'],
      patch: {
        services: { mode: 'one', items: [{ serviceId: services.walkthrough }] },
        durations: { minutes: [90] },
        locations: { options: [{ kind: 'customer_address' }] },
      },
    }),
    class: await calendar({
      name: 'Homeowner HVAC class',
      preset: 'event',
      color: '#c2410c',
      description: 'Two hours at our office on keeping your AC running. Free.',
      patch: {
        capacity: { seats: 12, maxPartySize: 4 },
        durations: { minutes: [120] },
        services: { mode: 'one', items: [{ serviceId: services.class }] },
        locations: { options: [{ kind: 'business', address: OFFICE }] },
      },
    }),
  };

  d.step('Lone Star: about two weeks of appointments, booked by the team without messaging anyone');
  const people = await rows<{ id: string; name: string }>(
    d.admin,
    sql`select id, btrim(first_name || ' ' || last_name) as name from app.people
        where workspace_id = ${workspaceId} and archived_at is null`,
  );
  const person = (name: string) => {
    const p = people.find((x) => x.name === name);
    if (!p) throw new Error(`The CRM seed has no customer ${name}.`);
    return p.id;
  };
  const now = Date.now();
  // The worker's loops keep up in the background while the team books, as they do in the app (reminders are
  // armed and recorded meanwhile). They stop after the class sessions; anything that failed there is rethrown.
  let booking = true;
  let failed: unknown = null;
  const loops = (async () => {
    while (booking && !failed)
      await settle(d).then(
        () => new Promise((r) => setTimeout(r, 50)),
        (e: unknown) => {
          failed = e;
        },
      );
  })();
  for (const v of VISITS) {
    const start = at(businessDay(v.day), v.at);
    const address = ADDRESSES[v.customer];
    if (!address) throw new Error(`No address for ${v.customer}.`);
    let appointmentId: string;
    try {
      ({ appointmentId } = await run(v.by, appointmentCreate, {
        workspaceId,
        calendarId: calendars[v.on].id,
        startsAt: iso(start),
        durationMinutes: v.minutes,
        serviceId: v.service ? services[v.service] : undefined,
        userIds: v.staff ? ids(v.staff) : undefined,
        personId: person(v.customer),
        title: v.title,
        notes: v.notes,
        location: { kind: 'customer_address', address, postalCode: zipOf(address) },
        // Only a visit that has started hears "That time has already passed"; any other warning is a mistake here.
        acknowledgeWarnings: start < now,
        notify: false,
      }));
    } catch (e) {
      throw new Error(`Booking ${v.customer} (day ${v.day}, ${v.at}) failed: ${reasonOf(e)}`, {
        cause: e,
      });
    }
    if (v.outcome === 'cancelled')
      await run(v.by, appointmentCancel, {
        workspaceId,
        appointmentId,
        reason: 'Her home warranty covers the repair.',
        notify: false,
      });
    else if (start + v.minutes * MIN <= now)
      await run(v.staff?.[0] ?? v.by, appointmentSetStatus, {
        workspaceId,
        appointmentId,
        status: v.outcome ?? 'completed',
      });
  }

  d.step('Lone Star: three class sessions, one of them full with three people waiting');
  let waiting = 0;
  for (const s of SESSIONS) {
    const session = await run('dale', sessionPublish, {
      workspaceId,
      calendarId: calendars.class.id,
      startsAt: iso(at(classDay(s.days), '15:00')),
      serviceId: services.class,
      userIds: [ws.dale.id],
    });
    for (const [name, seats] of s.seats)
      await run('priya', appointmentAddAttendee, {
        workspaceId,
        appointmentId: session.appointmentId,
        personId: person(name),
        seats,
        notify: false,
      });
    for (const [name, seats] of s.waiting ?? []) {
      await run('priya', waitlistAdd, {
        workspaceId,
        calendarId: calendars.class.id,
        appointmentId: session.appointmentId,
        personId: person(name),
        seats,
      });
      waiting++;
    }
  }
  booking = false;
  await loops;
  if (failed) throw failed;
  await settle(d);

  d.step(
    'Lone Star: Linda Park books an AC tune-up online and ticks "Text me"; one confirmation text goes out',
  );
  const online = await executeCommand(
    d.worker.db,
    appointmentBookOnline,
    {
      workspaceId,
      calendarId: calendars.dispatch.id,
      startsAt: iso(at(businessDay(2), '14:00')),
      serviceId: services.tuneup,
      durationMinutes: 60,
      locationKind: 'customer_address',
      address: '4309 Palmetto St, Bellaire, TX 77401',
      postalCode: '77401',
      customer: {
        firstName: 'Linda',
        lastName: 'Park',
        phone: '+18325550126',
        email: 'linda.park@example.com',
      },
      smsConsent: true,
      notes: 'The upstairs unit rattles when it starts.',
      clientId: `seed-${randomUUID()}`,
    },
    systemActor({ workspaceId, organizationId: ws.organizationId }),
    { correlationId: randomUUID(), causationId: null, channel: 'booking_page' },
  );
  await settle(d);
  // Nothing reports back to the seed (the fake carrier's callbacks are off): the confirmation is marked
  // delivered, as the messaging seed does with its texts.
  const [confirmation] = await rows<{ id: string | null }>(
    d.admin,
    sql`select reminder_state -> 'confirmation' ->> 'messageId' as id from app.appointment_attendees
        where id = ${online.output.attendeeId}`,
  );
  if (confirmation?.id)
    await executeCommand(
      d.worker.db,
      messageUpdateStatus,
      { workspaceId, messageId: confirmation.id, status: 'delivered' },
      systemActor({ workspaceId, organizationId: ws.organizationId }),
      workerMeta(),
    );

  d.step('Lone Star: Dale connects his stand-in Google calendar, and three busy times are read in');
  const fake = d.worker.calendars.fake;
  if (!fake) throw new Error('The calendar seed needs the stand-in calendars.');
  for (const [day, from, to] of [
    [1, '12:00', '13:00'],
    [2, '09:00', '11:00'],
    [4, '12:00', '13:00'],
  ] as const)
    fake.addBusy(
      DALE_GOOGLE,
      new Date(at(businessDay(day), from)),
      new Date(at(businessDay(day), to)),
    );
  const connectionId = await connectGoogle(d, ws, DALE_GOOGLE);
  // The first refresh reads the busy times, then writes Dale's appointments into the calendar as events.
  await settle(d);

  const [count] = await rows<{ appointments: number; busy: number }>(
    d.admin,
    sql`select
          (select count(*)::int from app.appointments
            where workspace_id = ${workspaceId} and kind = 'booking') as appointments,
          (select count(*)::int from app.calendar_busy_blocks where connection_id = ${connectionId}) as busy`,
  );
  if (!count?.busy) throw new Error('Dale’s calendar connected, but no busy times were read in.');
  return {
    site: LONE_STAR_SITE,
    calendars: Object.values(calendars).map(({ name, labels, slug }) => ({ name, labels, slug })),
    appointments: count.appointments,
    waiting,
    busyTimes: count.busy,
    seconds: (Date.now() - started) / 1000,
  };
}
