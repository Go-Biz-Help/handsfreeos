/** Shared setup for the calendar suites that run against the local database. */
import { randomUUID } from 'node:crypto';
import { rows, sql, type Db } from '@hfos/db/client';
import { createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { expect } from 'vitest';
import type { z } from 'zod';
import {
  addDays,
  applyPatch,
  localDateOf,
  localInstant,
  weekdayOf,
  type CalendarConfig,
  type ConfigPatch,
  type PresetKey,
  type WeeklyHours,
} from '../src/calendar/index';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  appointmentBookOnline,
  calendarCreate,
  calendarGet,
  calendarSave,
  calendarSetStatus,
  organizationCreate,
  personCreate,
  scheduleSet,
} from '../src/server';

export const CHI = 'America/Chicago';
export const MIN = 60_000;
export const DAY = 86_400_000;
export const WEEKDAYS: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '08:00',
  end: '17:00',
}));

export const admin = () => testDbs().admin.db;
export const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
export const meta = (channel: RequestMeta['channel'] = 'test'): RequestMeta => ({
  correlationId: randomUUID(),
  channel,
});

export function run<I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
  db: Db = testDbs().api.db,
): Promise<z.output<O>> {
  return executeCommand(db, cmd, input, human(u), meta()).then((r) => r.output);
}

export function ask<I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
): Promise<z.output<O>> {
  return executeQuery(testDbs().api.db, q, input, human(u), meta());
}

export interface Scope {
  readonly workspaceId: string;
  readonly organizationId: string;
}
export const system = (s: Scope): SystemActor => ({ type: 'system', ...s });

export function runSystem<I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  s: Scope,
  db: Db = testDbs().worker.db,
): Promise<z.output<O>> {
  return executeCommand(db, cmd, input, system(s), meta('booking_page')).then((r) => r.output);
}

export function askSystem<I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  s: Scope,
): Promise<z.output<O>> {
  return executeQuery(testDbs().worker.db, q, input, system(s), meta('booking_page'));
}

/** Runs `fn` and returns the HfosError it throws; `rule` is the error's rule, else its code. */
export async function expectHfos(
  fn: () => Promise<unknown>,
  rule: string,
  status?: number,
): Promise<HfosError> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof HfosError)) throw e;
    expect(e.rule ?? e.code, e.message).toBe(rule);
    if (status) expect(e.status).toBe(status);
    return e;
  }
  throw new Error(`expected ${rule}, but the call succeeded`);
}

export const warningCodes = (e: HfosError) =>
  ((e.details as { warnings?: { code: string }[] }).warnings ?? []).map((w) => w.code);

export interface Team {
  readonly owner: TestUser;
  readonly member: TestUser;
  readonly priya: TestUser;
  readonly marco: TestUser;
  readonly wsId: string;
  readonly orgId: string;
  readonly scope: Scope;
}

/** A Chicago business: Dale (owner), Mike (member who books), Priya and Marco, all weekdays 8 to 5. */
export async function setupTeam(label: string): Promise<Team> {
  const [owner, member, priya, marco] = await Promise.all([
    createTestUser(`${label}-dale`, { fullName: 'Dale Owner' }),
    createTestUser(`${label}-mike`, { fullName: 'Mike Member' }),
    createTestUser(`${label}-priya`, { fullName: 'Priya Tech' }),
    createTestUser(`${label}-marco`, { fullName: 'Marco Tech' }),
  ]);
  const org = await run(
    organizationCreate,
    { businessName: `${label} HVAC`, timezone: CHI },
    owner,
  );
  const wsId = org.workspaceId;
  for (const u of [member, priya, marco])
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${u.id}, 'member')`,
    );
  for (const u of [owner, member, priya, marco])
    await run(scheduleSet, { workspaceId: wsId, ownerId: u.id, weekly: WEEKDAYS }, owner);
  return {
    owner,
    member,
    priya,
    marco,
    wsId,
    orgId: org.organizationId,
    scope: { workspaceId: wsId, organizationId: org.organizationId },
  };
}

/** The first local date (Chicago) at least `minDays` from today that falls on `weekday` (0 is Sunday). */
export function nextWeekday(weekday: number, minDays = 3): string {
  let date = addDays(localDateOf(Date.now(), CHI), minDays);
  while (weekdayOf(date) !== weekday) date = addDays(date, 1);
  return date;
}
export const at = (date: string, clock: string) => localInstant(date, clock, CHI);
export const isoAt = (date: string, clock: string) => new Date(at(date, clock)).toISOString();

/** A calendar from a preset, patched (no minimum notice unless the patch says so), saved and active. */
export async function makeCalendar(
  t: Team,
  name: string,
  patch: ConfigPatch,
  opts: { preset?: PresetKey; activate?: boolean } = {},
) {
  const created = await run(
    calendarCreate,
    { workspaceId: t.wsId, name, preset: opts.preset ?? 'scratch' },
    t.owner,
  );
  const { calendar } = await ask(
    calendarGet,
    { workspaceId: t.wsId, calendarId: created.calendarId },
    t.owner,
  );
  const draft = applyPatch(
    applyPatch(calendar.config as CalendarConfig, { window: { minNoticeMinutes: 0 } }),
    patch,
  );
  const saved = await run(
    calendarSave,
    { workspaceId: t.wsId, calendarId: created.calendarId, baseRevision: calendar.revision, draft },
    t.owner,
  );
  if (opts.activate ?? true)
    await run(
      calendarSetStatus,
      { workspaceId: t.wsId, calendarId: created.calendarId, status: 'active' },
      t.owner,
    );
  return { id: created.calendarId, slug: created.slug, revision: saved.revision, config: draft };
}

/** Saves a patch over a calendar's current settings. */
export async function saveCalendar(
  t: Team,
  calendarId: string,
  patch: ConfigPatch,
  extra: Record<string, unknown> = {},
  u: TestUser = t.owner,
) {
  const { calendar } = await ask(calendarGet, { workspaceId: t.wsId, calendarId }, t.owner);
  return run(
    calendarSave,
    {
      workspaceId: t.wsId,
      calendarId,
      baseRevision: calendar.revision,
      draft: applyPatch(calendar.config as CalendarConfig, patch),
      ...extra,
    },
    u,
  );
}

let phoneSeq = 0;
/** A distinct valid-looking US mobile number per call. */
export const nextPhone = () => `+1713555${String(1000 + (phoneSeq++ % 9000)).padStart(4, '0')}`;

export async function customer(t: Team, firstName: string, phone: string | null = null) {
  const out = await run(
    personCreate,
    { workspaceId: t.wsId, firstName, lastName: 'Customer', phone, ignoreDuplicates: true },
    t.owner,
  );
  return out.personId;
}

let guest = 0;
/** A signed-out customer books on the booking page (the worker, as the system actor). */
export function bookOnline(
  t: Team,
  calendarId: string,
  startsAt: string,
  extra: Record<string, unknown> = {},
  db?: Db,
) {
  guest += 1;
  return runSystem(
    appointmentBookOnline,
    {
      workspaceId: t.wsId,
      calendarId,
      startsAt,
      customer: { firstName: 'Online', lastName: `Guest ${guest}`, phone: nextPhone() },
      clientId: randomUUID(),
      ...extra,
    },
    t.scope,
    db,
  );
}
