/**
 * A workspace for the booking-messages tests: an owner who works every hour of every day, a booking site
 * ("Lone Star Test HVAC"), the worker's HTTP server with room to spare and the test route, texting ready on the
 * fake carrier when asked (rows written directly: the purchase flow has its own tests), quiet hours off unless
 * a test turns them on, and the worker's loops drained over this workspace's work only.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  applyPatch,
  bookingSiteUpdate,
  calendarCreate,
  calendarGet,
  calendarSave,
  calendarSetStatus,
  executeCommand,
  executeQuery,
  localDateOf,
  localInstant,
  organizationCreate,
  parseReminderState,
  phoneUpdateSettings,
  scheduleSet,
  zonedParts,
  type CalendarConfig,
  type CommandDef,
  type ConfigPatch,
  type HumanActor,
  type ReminderState,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { phoneNumbers, telephonyAccounts, telephonyRegistrations } from '@hfos/db/schema';
import { createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { z } from 'zod';
import { passThroughBotCheck } from '../src/booking/bot-check';
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import type { JobStats } from '../src/jobs';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { FAKE_AUTH_TOKEN, fakeSid } from '../src/telephony/fake';
import { testServices, type TestServices } from './helpers';

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const CHI = 'America/Chicago';
export const BUSINESS = 'Lone Star Test HVAC';
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));
const ROOM = { max: 10_000, timeWindow: MIN };

export const api = () => testDbs().api.db;
export const admin = () => testDbs().admin.db;
export const iso = (ms: number): string => new Date(ms).toISOString();
const shortId = () => randomUUID().slice(0, 8);
const env = testEnv();

export interface World {
  readonly label: string;
  readonly owner: TestUser;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly site: string;
  readonly s: TestServices;
  readonly app: FastifyInstance;
  readonly workerId: string;
  /** The business number, once texting is ready. */
  number: string | null;
}

const actorOf = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

/** A command as the world's owner. */
export function run<I extends z.ZodType, O extends z.ZodType>(
  w: World,
  cmd: CommandDef<I, O>,
  input: unknown,
): Promise<z.output<O>> {
  return executeCommand(api(), cmd, input, actorOf(w.owner), meta()).then((r) => r.output);
}

export async function makeWorld(label: string): Promise<World> {
  const owner = await createTestUser(`${label}-dale`, { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: `${label} Booking HVAC`, timezone: CHI },
    actorOf(owner),
    meta(),
  );
  const s = testServices();
  const app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
    booking: {
      botCheck: passThroughBotCheck,
      limits: { read: ROOM, book: ROOM, manageRead: ROOM, manageWrite: ROOM },
    },
    testRoutes: { jobs },
  });
  const w: World = {
    label,
    owner,
    workspaceId: output.workspaceId,
    organizationId: output.organizationId,
    site: `${label}-${shortId()}`,
    s,
    app,
    workerId: `vitest-${label}-${process.pid}`,
    number: null,
  };
  await run(w, scheduleSet, { workspaceId: w.workspaceId, ownerId: owner.id, weekly: ALL_WEEK });
  await run(w, bookingSiteUpdate, { workspaceId: w.workspaceId, slug: w.site, name: BUSINESS });
  // Off by default, so no test depends on the time of day it runs at.
  await setQuietHours(w, null);
  return w;
}

/** Texting set up: an active toll-free number on the fake carrier, its verification approved. */
export async function readyTexting(w: World): Promise<string> {
  const [account] = await admin()
    .insert(telephonyAccounts)
    .values({
      workspaceId: w.workspaceId,
      provider: 'fake',
      accountSid: fakeSid('AC'),
      authTokenEnc: w.s.sealer.seal(FAKE_AUTH_TOKEN),
      keyId: w.s.sealer.keyId,
      status: 'active',
    })
    .returning({ id: telephonyAccounts.id });
  const e164 = `+18335${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
  const [number] = await admin()
    .insert(phoneNumbers)
    .values({
      workspaceId: w.workspaceId,
      accountId: account!.id,
      providerSid: fakeSid('PN'),
      e164,
      numberType: 'toll_free',
      status: 'active',
    })
    .returning({ id: phoneNumbers.id });
  await admin()
    .insert(telephonyRegistrations)
    .values({
      workspaceId: w.workspaceId,
      accountId: account!.id,
      phoneNumberId: number!.id,
      kind: 'toll_free_verification',
      status: 'approved',
      providerSid: fakeSid('HH'),
      approvedAt: new Date(),
    });
  w.number = e164;
  return e164;
}

/** Quiet hours from `start` to `end` (HH:MM, the business's time), or off. */
export async function setQuietHours(
  w: World,
  window: { start: string; end: string } | null,
): Promise<void> {
  await run(w, phoneUpdateSettings, {
    workspaceId: w.workspaceId,
    quietHours: window
      ? { enabled: true, ...window }
      : { enabled: false, start: '20:00', end: '08:00' },
  });
}

/** 13 → '13:00'; wraps past midnight. */
export const hh = (hour: number): string =>
  `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`;
/** The hour it is now where the business is. */
export const hourNow = (): number => zonedParts(Date.now(), CHI).hour;
/** A local time `days` from today, in Chicago. */
export const at = (days: number, clock: string): number =>
  localInstant(addDays(localDateOf(Date.now(), CHI), days), clock, CHI);

/** A public, active calendar for the owner, bookable right away, changes and cancels allowed until the start. */
export async function makeCalendar(
  w: World,
  name: string,
  patch: ConfigPatch = {},
): Promise<{ id: string; slug: string }> {
  const created = await run(w, calendarCreate, {
    workspaceId: w.workspaceId,
    name,
    preset: 'scratch',
  });
  const { calendar } = await executeQuery(
    api(),
    calendarGet,
    { workspaceId: w.workspaceId, calendarId: created.calendarId },
    actorOf(w.owner),
    meta(),
  );
  const draft = applyPatch(
    applyPatch(calendar.config as CalendarConfig, {
      public: true,
      team: { members: [{ userId: w.owner.id }] },
      window: { minNoticeMinutes: 0 },
      policies: { cancel: { cutoffHours: 0 }, reschedule: { cutoffHours: 0, maxTimes: 2 } },
    }),
    patch,
  );
  await run(w, calendarSave, {
    workspaceId: w.workspaceId,
    calendarId: created.calendarId,
    baseRevision: calendar.revision,
    draft,
  });
  await run(w, calendarSetStatus, {
    workspaceId: w.workspaceId,
    calendarId: created.calendarId,
    status: 'active',
  });
  return { id: created.calendarId, slug: created.slug };
}

let phoneSeq = 0;
/** A distinct US mobile number per call. */
export const nextPhone = (): string =>
  `+1713555${String(1000 + ((phoneSeq++ * 37 + Math.floor(Math.random() * 30)) % 9000)).padStart(4, '0')}`;

export const customer = (first: string) => ({
  name: `${first} Customer`,
  phone: nextPhone(),
  email: `${first.toLowerCase()}-${shortId()}@example.com`,
});

/** At the customer's house (the canvas's "Priya is coming to 123 Main St"). */
export const AT_HOME = {
  locationKind: 'customer_address',
  address: '123 Main St, Houston, TX 77002',
  postalCode: '77002',
};

export const get = (w: World, url: string) =>
  w.app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': '203.0.113.10' } });
export const post = (w: World, url: string, body: unknown) =>
  w.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
    payload: JSON.stringify(body),
  });
export const errorOf = (res: LightMyRequestResponse) =>
  (res.json() as { error: { code: string; rule?: string; message: string } }).error;

export interface Booked {
  manageToken: string;
  manageUrl: string;
  duplicate: boolean;
  joined: boolean;
  booking: { startsAt: string };
}

/** Books on the public page. */
export async function bookOnline(
  w: World,
  slug: string,
  startsAt: number,
  body: Record<string, unknown>,
): Promise<Booked> {
  const res = await post(w, `/public/book/${w.site}/${slug}/bookings`, {
    clientId: randomUUID(),
    startsAt: iso(startsAt),
    ...body,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Booked;
}

/** The booking a change-or-cancel link names. */
export async function attendeeByToken(
  manageToken: string,
): Promise<{ id: string; appointment_id: string }> {
  const [a] = await rows<{ id: string; appointment_id: string }>(
    admin(),
    sql`select id, appointment_id from app.appointment_attendees where public_ref = ${manageToken.slice(0, 8)}`,
  );
  return a!;
}

export async function stateOf(attendeeId: string): Promise<ReminderState> {
  const [a] = await rows<{ reminder_state: unknown }>(
    admin(),
    sql`select reminder_state from app.appointment_attendees where id = ${attendeeId}`,
  );
  return parseReminderState(a?.reminder_state);
}

/** Texts the fake carrier took for a number. */
export const textsTo = (w: World, phone: string) =>
  w.s.telephony.sent.filter((m) => m.to === phone);

/** Outbound emails HandsFreeOS queued to an address (sent or not). */
export async function emailsTo(w: World, address: string): Promise<string[]> {
  const list = await rows<{ subject: string }>(
    admin(),
    sql`select m.subject from app.messages m join app.conversations c on c.id = m.conversation_id
        where c.workspace_id = ${w.workspaceId} and c.channel = 'email' and c.counterpart = ${address}
          and m.direction = 'outbound'`,
  );
  return list.map((m) => m.subject);
}

async function reserve(w: World): Promise<void> {
  for (const table of ['outbox', 'webhook_deliveries', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${w.workerId}
          where status = 'pending' and workspace_id = ${w.workspaceId}`,
    );
}

/**
 * Runs the outbox, webhook and job loops over this workspace's due work until it is idle; events go through
 * `map` (the worker's own handlers unless a test adds one).
 */
export async function drain(
  w: World,
  timeoutMs = 20_000,
  map: typeof handlers = handlers,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await reserve(w);
    const d = { ...w.s, workerId: w.workerId, batchSize: 200, reservedOnly: true };
    const passes = [
      await processOnce({ ...d, handlers: map }),
      await processDeliveries({ ...d, processors }),
      await processJobs({ ...d, jobs }),
    ];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select kind as what, last_error from app.scheduled_jobs
              where workspace_id = ${w.workspaceId} and last_error is not null and status <> 'done'
            union all select event_type, last_error from app.outbox
              where workspace_id = ${w.workspaceId} and last_error is not null and status <> 'done'`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

/** The test route: named jobs run as of when they were due; then the messages they queued go out. */
export async function runDue(
  w: World,
  dedupeKeys: string[],
): Promise<{ moved: { dedupeKey: string; dueAt: string }[]; ran: JobStats }> {
  const res = await post(w, '/test/scheduled-jobs/run-due', {
    workspaceId: w.workspaceId,
    dedupeKeys,
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { moved: { dedupeKey: string; dueAt: string }[]; ran: JobStats };
  if (body.ran.retried + body.ran.failed > 0) {
    const errors = await rows(
      admin(),
      sql`select kind, last_error from app.scheduled_jobs
          where workspace_id = ${w.workspaceId} and last_error is not null`,
    );
    throw new Error(`a job failed: ${JSON.stringify(errors)}`);
  }
  await drain(w);
  return body;
}

/** The newest job with this key. */
export async function jobRow(
  dedupeKey: string,
): Promise<{ id: string; run_at: Date; status: string } | undefined> {
  const [j] = await rows<{ id: string; run_at: Date; status: string }>(
    admin(),
    sql`select id, run_at, status::text as status from app.scheduled_jobs
        where dedupe_key = ${dedupeKey} order by created_at desc limit 1`,
  );
  return j;
}

interface MailpitSummary {
  ID: string;
  Subject: string;
}

export async function mailTo(to: string): Promise<MailpitSummary[]> {
  const res = await fetch(
    `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
  return ((await res.json()) as { messages: MailpitSummary[] }).messages;
}

/** The newest email to `to` whose subject starts with `subject`, with its text. */
export async function waitForMail(
  to: string,
  subject: string,
  timeoutMs = 10_000,
): Promise<{ subject: string; text: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = (await mailTo(to)).find((m) => m.Subject.startsWith(subject));
    if (hit) {
      const full = (await (await fetch(`${env.mailpitUrl}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
      };
      return { subject: hit.Subject, text: full.Text };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no email starting "${subject}" reached ${to}`);
}
