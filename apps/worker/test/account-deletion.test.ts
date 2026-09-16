/**
 * M10 step 6b, the worker: deleting an account end to end, against the local Supabase Auth.
 * - Marco asks; the worker's job takes him off every calendar team (a calendar left with nobody to book is paused
 *   first) and every service staff list he shares, keeps his upcoming visit as it is, disconnects his mailbox,
 *   anonymizes his profile (memberships, cell and all), ends every session, blocks sign-in, and notes it once in the
 *   business's log. A second run changes nothing.
 * - A job for someone who is (now) a business's only owner does nothing at all.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createClient } from '@supabase/supabase-js';
import {
  accountDelete,
  calendarCreate,
  calendarSetStatus,
  executeCommand,
  organizationCreate,
  parseConfig,
  serviceCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  calendars,
  events,
  mailboxConnections,
  userPhones,
  users,
  workspaceMemberships,
} from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthAdmin } from '../src/account/auth-admin';
import { ACCOUNT_JOBS, accountDeleteJobKey, deletedEmailOf } from '../src/account/delete';
import { handlers } from '../src/handlers/index';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

const env = testEnv();
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const anon = () =>
  createClient(env.supabaseUrl, env.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
const authAdmin = () =>
  createClient(env.supabaseUrl, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

let dale: TestUser;
let priya: TestUser;
let marco: TestUser;
let workspaceId: string;
let organizationId: string;
let tuneUps: string;
let installs: string;
let shared: string;
let solo: string;
let visit: string;
let mailbox: string;
let s: TestServices;

const run = <T>(cmd: Parameters<typeof executeCommand>[1], input: unknown, u: TestUser) =>
  executeCommand(api(), cmd, input, actor(u), meta()).then((r) => r.output as T);

/** Runs pending work for these rows only (the outbox event or a job), as the loops would. */
async function runOutbox(eventType: string, entityId: string) {
  const runner = `vitest-delete-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.outbox set locked_at = now(), locked_by = ${runner}
        where status = 'pending' and event_id in
          (select id from app.events where event_type = ${eventType} and entity_id = ${entityId})`,
  );
  return processOnce({ ...s, handlers, workerId: runner, batchSize: 20, reservedOnly: true });
}
async function runJobs(kind: string, dedupeKey: string) {
  const runner = `vitest-delete-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${runner}
        where status = 'pending' and kind = ${kind} and dedupe_key = ${dedupeKey}`,
  );
  return processJobs({ ...s, jobs, workerId: runner, batchSize: 5, reservedOnly: true });
}

beforeAll(async () => {
  [dale, priya, marco] = await Promise.all([
    createTestUser('delete-dale', { fullName: 'Dale Owner' }),
    createTestUser('delete-priya', { fullName: 'Priya Admin' }),
    createTestUser('delete-marco', { fullName: 'Marco Member' }),
  ]);
  const org = await run<{ workspaceId: string; organizationId: string }>(
    organizationCreate,
    { businessName: 'Deletion Test HVAC' },
    dale,
  );
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  for (const [u, role] of [
    [priya, 'admin'],
    [marco, 'member'],
  ] as const)
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${u.id}, ${role})`,
    );
  s = { ...testServices(), authAdmin: createAuthAdmin(env.supabaseUrl, env.secretKey) };

  const calendar = async (name: string, teammates: string[]) => {
    const { calendarId } = await run<{ calendarId: string }>(
      calendarCreate,
      { workspaceId, name, preset: 'round_robin', teammates },
      dale,
    );
    await run(calendarSetStatus, { workspaceId, calendarId, status: 'active' }, dale);
    return calendarId;
  };
  tuneUps = await calendar('Tune-ups', [marco.id, priya.id]);
  installs = await calendar('Marco’s installs', [marco.id]);
  shared = (
    await run<{ serviceId: string }>(
      serviceCreate,
      { workspaceId, name: 'AC tune-up', durations: [60], staffUserIds: [marco.id, priya.id] },
      dale,
    )
  ).serviceId;
  solo = (
    await run<{ serviceId: string }>(
      serviceCreate,
      { workspaceId, name: 'Heat pump install', durations: [240], staffUserIds: [marco.id] },
      dale,
    )
  ).serviceId;
  // Marco's visit tomorrow stays his until someone reassigns it: nothing reaches the customer on its own.
  const [appt] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at)
        values (${workspaceId}, ${tuneUps}, 1, 'Tune-up at the Johnsons', now() + interval '1 day', now() + interval '1 day 1 hour')
        returning id`,
  );
  visit = appt!.id;
  await rows(
    admin(),
    sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id) values (${workspaceId}, ${visit}, ${marco.id})`,
  );
  const [box] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.mailbox_connections (workspace_id, provider, account_email, user_id, status, token_enc, next_sync_at, created_by)
        values (${workspaceId}, 'google', ${`marco-${randomUUID().slice(0, 6)}@gmail.test`}, ${marco.id}, 'active', 'sealed', now(), ${marco.id})
        returning id`,
  );
  mailbox = box!.id;
  await rows(
    admin(),
    sql`insert into app.user_phones (user_id, e164, verified_at, verification_count, last_verification_at)
        values (${marco.id}, '+15125550143', now(), 1, now())`,
  );
});
afterAll(closeTestDbs);

describe('deleting an account', () => {
  it('a job for a business’s only owner does nothing at all', async () => {
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (kind, dedupe_key, run_at, payload)
          values (${ACCOUNT_JOBS.delete}, ${accountDeleteJobKey(dale.id)}, now(),
            ${JSON.stringify({ userId: dale.id, [`ws:${workspaceId}`]: organizationId })}::jsonb)`,
    );
    expect(await runJobs(ACCOUNT_JOBS.delete, accountDeleteJobKey(dale.id))).toMatchObject({
      claimed: 1,
      done: 1,
      failed: 0,
    });
    const [profile] = await admin().select().from(users).where(eq(users.id, dale.id));
    expect(profile).toMatchObject({ fullName: 'Dale Owner', deletedAt: null });
    const [cal] = await admin().select().from(calendars).where(eq(calendars.id, installs));
    expect(cal!.revision).toBe(1);
    const got = await authAdmin().auth.admin.getUserById(dale.id);
    expect(got.data.user?.banned_until ?? null).toBeNull();
  });

  it('takes the person off each business, anonymizes them, ends their sessions and blocks sign-in', async () => {
    const signedIn = await anon().auth.signInWithPassword({
      email: marco.email,
      password: marco.password,
    });
    expect(signedIn.data.session).toBeTruthy();

    await run(accountDelete, { confirmEmail: marco.email }, marco);
    expect(await runOutbox('account.deletion_requested', marco.id)).toMatchObject({
      done: 1,
      failed: 0,
    });
    expect(await runJobs(ACCOUNT_JOBS.delete, accountDeleteJobKey(marco.id))).toMatchObject({
      claimed: 1,
      done: 1,
      failed: 0,
    });

    // Off every calendar team, through a new revision; the calendar left with nobody to book is paused.
    const calendarRow = async (id: string) =>
      (await admin().select().from(calendars).where(eq(calendars.id, id)))[0]!;
    const team = (config: unknown) => parseConfig(config).team.members.map((m) => m.userId);
    const tune = await calendarRow(tuneUps);
    expect(team(tune.config)).toEqual([priya.id]);
    expect(tune).toMatchObject({ status: 'active', revision: 2 });
    const inst = await calendarRow(installs);
    expect(team(inst.config)).toEqual([]);
    expect(inst).toMatchObject({ status: 'paused', revision: 2 });
    const members = await rows<{ user_id: string }>(
      admin(),
      sql`select user_id from app.calendar_members where calendar_id in (${tuneUps}, ${installs})`,
    );
    expect(members.map((m) => m.user_id)).toEqual([priya.id]);
    // Off the staff list he shared; the service only he did stays as it was (an empty list means everyone).
    const staff = async (serviceId: string) =>
      (
        await rows<{ user_id: string }>(
          admin(),
          sql`select user_id from app.service_staff where service_id = ${serviceId} order by user_id`,
        )
      ).map((r) => r.user_id);
    expect(await staff(shared)).toEqual([priya.id]);
    expect(await staff(solo)).toEqual([marco.id]);
    // His visit is kept as it was.
    const visitStaff = await rows<{ user_id: string }>(
      admin(),
      sql`select user_id from app.appointment_staff where appointment_id = ${visit}`,
    );
    expect(visitStaff.map((r) => r.user_id)).toEqual([marco.id]);
    // His mailbox is disconnected and forgets its sign-in.
    const [box] = await admin()
      .select()
      .from(mailboxConnections)
      .where(eq(mailboxConnections.id, mailbox));
    expect(box).toMatchObject({ status: 'disconnected', tokenEnc: null, nextSyncAt: null });
    expect(box!.disconnectedAt).toBeInstanceOf(Date);

    // The profile: "Former teammate", no memberships, no cell.
    const [profile] = await admin().select().from(users).where(eq(users.id, marco.id));
    expect(profile).toMatchObject({ fullName: 'Former teammate', email: deletedEmailOf(marco.id) });
    expect(profile!.deletedAt).toBeInstanceOf(Date);
    expect(
      await admin()
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.userId, marco.id)),
    ).toHaveLength(0);
    expect(
      await admin().select().from(userPhones).where(eq(userPhones.userId, marco.id)),
    ).toHaveLength(0);

    // Sign-in: every session is gone, and nothing gets back in.
    const sessions = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from auth.sessions where user_id = ${marco.id}`,
    );
    expect(sessions[0]!.n).toBe(0);
    const refreshed = await anon().auth.refreshSession({
      refresh_token: signedIn.data.session!.refresh_token,
    });
    expect(refreshed.data.session).toBeNull();
    const again = await anon().auth.signInWithPassword({
      email: marco.email,
      password: marco.password,
    });
    expect(again.data.session).toBeNull();
    const got = await authAdmin().auth.admin.getUserById(marco.id);
    expect(got.data.user!.email).toBe(deletedEmailOf(marco.id));
    expect(Date.parse(got.data.user!.banned_until!)).toBeGreaterThan(
      Date.now() + 50 * 365 * 86_400_000,
    );
    expect(got.data.user!.user_metadata['full_name']).toBeUndefined();
    const banned = await anon().auth.signInWithPassword({
      email: deletedEmailOf(marco.id),
      password: marco.password,
    });
    expect(banned.error?.code).toBe('user_banned');

    // Noted once in the business's log; a second run changes nothing.
    const notes = () =>
      admin()
        .select()
        .from(events)
        .where(and(eq(events.eventType, 'account.deleted'), eq(events.entityId, marco.id)));
    expect(await notes()).toHaveLength(1);
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (kind, dedupe_key, run_at, payload)
          values (${ACCOUNT_JOBS.delete}, ${accountDeleteJobKey(marco.id)}, now(),
            ${JSON.stringify({ userId: marco.id, [`ws:${workspaceId}`]: organizationId })}::jsonb)`,
    );
    expect(await runJobs(ACCOUNT_JOBS.delete, accountDeleteJobKey(marco.id))).toMatchObject({
      done: 1,
      failed: 0,
    });
    expect(await notes()).toHaveLength(1);
    expect((await calendarRow(tuneUps)).revision).toBe(2);
  }, 60_000);
});
