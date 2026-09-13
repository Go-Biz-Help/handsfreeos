/**
 * Glow Red Light Studio, a fourth Go Biz Help client: a calendar with no staff. Customers book one of four red
 * light beds by the studio's hours alone; a session is 15 or 20 minutes with 10 minutes' cleanup after.
 * - Built the way an owner would, by chris (the agency's owner reaches every client workspace): the booking
 *   site, the "Red light bed" resource (four of them), the "Red light session" service, and "Book a bed" from
 *   the Resource preset, open Monday to Friday 7 AM to 8 PM and Saturday 8 AM to 4 PM.
 * - Ten bookings over the next three weekdays, made with appointment.create without messaging anyone:
 *   staggered starts, and one time with all four beds taken (a fifth is refused with resource_full). Then one
 *   customer books online through the booking page's own command, so a confirmation email and the team's
 *   "New booking" email reach Mailpit.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  appointmentBookOnline,
  appointmentCreate,
  applyPatch,
  bookingSiteUpdate,
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
  personCreate,
  resourceCreate,
  serviceCreate,
  weekdayOf,
  workspaceCreate,
  type CalendarConfig,
  type CommandDef,
  type HumanActor,
  type RequestMeta,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import type { OutboxDeps } from '../src/outbox';
import { systemActor } from '../src/services';
import { settle } from './seed-messaging';

export interface SeedGlowDeps {
  readonly api: Db;
  readonly admin: Db;
  /** The worker's services and loop settings, as the seed built them. */
  readonly worker: OutboxDeps;
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
  /** Only work created after this is claimed (other suites leave rows behind). */
  readonly since: string;
}

export interface SeededGlow {
  readonly site: string;
  readonly calendar: { readonly name: string; readonly labels: string; readonly slug: string };
  readonly bookings: number;
  readonly seconds: number;
}

/** Customers book at /book/glow-studio. */
export const GLOW_SITE = 'glow-studio';
const TZ = 'America/Chicago';
const WEEKDAYS = [1, 2, 3, 4, 5];
const CUSTOMERS = [
  ['Ava', 'Martin'],
  ['Ben', 'Ortiz'],
  ['Chloe', 'Nguyen'],
  ['Diego', 'Reyes'],
  ['Emma', 'Sato'],
  ['Farah', 'Khan'],
] as const;

/** [weekday counted from tomorrow (0 is the first), local start, minutes, customer]. */
const BOOKINGS: readonly (readonly [number, string, 15 | 20, number])[] = [
  // Staggered starts: three beds in use at once around 10:20.
  [0, '10:00', 20, 0],
  [0, '10:10', 15, 1],
  [0, '10:20', 20, 2],
  [0, '12:30', 20, 3],
  // After work: every bed taken at 5 PM.
  [1, '17:00', 20, 0],
  [1, '17:00', 20, 1],
  [1, '17:00', 15, 4],
  [1, '17:00', 20, 5],
  [2, '07:30', 15, 2],
  [2, '08:00', 20, 3],
];

const reasonOf = (e: unknown): string =>
  e instanceof HfosError ? `${e.message} ${JSON.stringify(e.details ?? {})}` : String(e);

export async function seedGlow(
  d: SeedGlowDeps,
  org: { readonly organizationId: string; readonly chris: TestUser },
): Promise<SeededGlow> {
  const started = Date.now();
  const run = <I extends z.ZodType, O extends z.ZodType>(
    command: CommandDef<I, O>,
    input: z.input<I>,
  ) => executeCommand(d.api, command, input, d.actor(org.chris), d.meta()).then((r) => r.output);

  d.step('Glow Red Light Studio: a client whose calendar books four red light beds with no staff');
  const { workspaceId } = await run(workspaceCreate, {
    organizationId: org.organizationId,
    name: 'Glow Red Light Studio',
    timezone: TZ,
  });
  await run(bookingSiteUpdate, {
    workspaceId,
    slug: GLOW_SITE,
    name: 'Glow Red Light Studio',
    intro: 'Red light therapy in the Heights. Pick a time and a bed is yours.',
    enabled: true,
  });
  const bed = (
    await run(resourceCreate, {
      workspaceId,
      name: 'Red light bed',
      kind: 'equipment',
      quantity: 4,
    })
  ).resourceId;
  const session = (
    await run(serviceCreate, {
      workspaceId,
      name: 'Red light session',
      description: '15 or 20 minutes on one of our red light beds.',
      durations: [15, 20],
      defaultDuration: 20,
      bufferAfter: 10,
      color: '#dc2626',
      priceCents: 3500,
      resources: [{ resourceId: bed, quantity: 1 }],
    })
  ).serviceId;

  const created = await run(calendarCreate, {
    workspaceId,
    name: 'Book a bed',
    preset: 'resource',
    resources: [bed],
    color: '#dc2626',
    description: 'Pick a time and a bed is yours. No staff needed.',
  });
  const calendarId = created.calendarId;
  const { calendar } = await executeQuery(
    d.api,
    calendarGet,
    { workspaceId, calendarId },
    d.actor(org.chris),
    d.meta(),
  );
  const draft = applyPatch(calendar.config as CalendarConfig, {
    services: { mode: 'one', items: [{ serviceId: session }] },
    durations: { customerChooses: true, step: 10 },
    schedule: {
      hours: [
        ...WEEKDAYS.map((day) => ({ day, start: '07:00', end: '20:00' })),
        { day: 6, start: '08:00', end: '16:00' },
      ],
    },
    // No business number yet: confirmations and reminders go by email.
    notifications: {
      confirmation: { text: false, email: true },
      reminderChannels: { text: false, email: true },
    },
  });
  await run(calendarSave, { workspaceId, calendarId, baseRevision: calendar.revision, draft });
  await run(calendarSetStatus, { workspaceId, calendarId, status: 'active' });

  d.step('Glow Red Light Studio: ten bookings over three weekdays, every bed taken at 5 PM once');
  const people: string[] = [];
  for (const [firstName, lastName] of CUSTOMERS)
    people.push(
      (
        await run(personCreate, {
          workspaceId,
          firstName,
          lastName,
          email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
          ignoreDuplicates: true,
        })
      ).personId,
    );
  const today = localDateOf(Date.now(), TZ);
  const weekday = (n: number): string => {
    let date = today;
    for (let i = -1; i < n;) if (WEEKDAYS.includes(weekdayOf((date = addDays(date, 1))))) i++;
    return date;
  };
  const at = (day: number, clock: string) =>
    new Date(localInstant(weekday(day), clock, TZ)).toISOString();
  const book = (day: number, clock: string, minutes: number, personId: string | null) =>
    run(appointmentCreate, {
      workspaceId,
      calendarId,
      serviceId: session,
      startsAt: at(day, clock),
      durationMinutes: minutes,
      personId,
      notify: false,
    });
  for (const [day, clock, minutes, who] of BOOKINGS) {
    try {
      await book(day, clock, minutes, people[who]!);
    } catch (e) {
      throw new Error(`Booking a Glow bed (weekday ${day}, ${clock}) failed: ${reasonOf(e)}`, {
        cause: e,
      });
    }
  }
  const fifth = await book(1, '17:00', 20, null).then(
    () => null,
    (e: unknown) => e,
  );
  if (!(fifth instanceof HfosError) || fifth.rule !== 'resource_full')
    throw new Error(
      `A fifth Glow booking at 5 PM should find every bed taken; it got ${fifth ? reasonOf(fifth) : 'a bed'}.`,
    );

  d.step(
    'Glow Red Light Studio: Grace Lee books a bed online; the confirmation and "New booking" go by email',
  );
  await executeCommand(
    d.worker.db,
    appointmentBookOnline,
    {
      workspaceId,
      calendarId,
      startsAt: at(2, '09:00'),
      serviceId: session,
      durationMinutes: 20,
      customer: { firstName: 'Grace', lastName: 'Lee', email: 'grace.lee@example.com' },
      smsConsent: false,
      clientId: `seed-${randomUUID()}`,
    },
    systemActor({ workspaceId, organizationId: org.organizationId }),
    { correlationId: randomUUID(), causationId: null, channel: 'booking_page' },
  );
  await settle(d);

  return {
    site: GLOW_SITE,
    calendar: { name: 'Book a bed', labels: formatLabels(inferLabels(draft)), slug: created.slug },
    bookings: BOOKINGS.length + 1,
    seconds: (Date.now() - started) / 1000,
  };
}
