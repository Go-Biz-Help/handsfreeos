/**
 * M10 step 6b, the worker's nightly housekeeping for phones.
 * - **The sync-window sweep:** the plan gives each business one sweep, spread over the night, and comes back the next
 *   night; a business's sweep hides what aged out in rounds (never an open conversation's), and carries on later
 *   when a night's rounds weren't enough.
 * - **The receipts clean-up:** receipts older than 90 days go a batch at a time, recent ones stay, and it comes back
 *   the next night.
 * - **The problem reports clean-up:** reports older than 30 days go, handled or not; recent ones stay.
 * - **Problem reports clearing themselves** (hourly): a limit once it's over, a problem quiet for 3 days, and a fixed
 *   problem's reports from before the fix, to Handled with why.
 * - **The notifications clean-up:** what the bell lists goes after 30 days, a batch at a time, read or not; recent
 *   ones stay, and it comes back the next night.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { executeCommand, organizationCreate, type HumanActor } from '@hfos/core/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOTIFICATION_JOBS, nextNotificationCleanUp } from '../src/housekeeping/notifications';
import {
  nextProblemReportCleanUp,
  nextProblemReportClearing,
  PROBLEM_REPORT_JOBS,
} from '../src/housekeeping/problem-reports';
import { nextReceiptCleanUp, RECEIPT_JOBS } from '../src/housekeeping/receipts';
import {
  nextSweepNight,
  SWEEP_SPREAD_MS,
  SWEEP_UTC_HOUR,
  SYNC_WINDOW_JOBS,
  syncWindowSweepKey,
} from '../src/housekeeping/sync-window';
import { processJobs } from '../src/jobs';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let s: TestServices;
let workspaceId: string;
let organizationId: string;
let personId: string;

/** Runs one job row as the runner would, alone (it's locked for this runner only). */
async function runJob(id: string, clock?: number) {
  const runner = `vitest-housekeeping-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${runner} where id = ${id}`,
  );
  return processJobs({
    ...s,
    jobs,
    workerId: runner,
    batchSize: 5,
    reservedOnly: true,
    ...(clock ? { clock: () => clock } : {}),
  });
}

async function job(kind: string, payload: Record<string, unknown>, scoped: boolean) {
  const [row] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${scoped ? organizationId : null}, ${scoped ? workspaceId : null}, ${kind},
          ${`test:${kind}:${randomUUID()}`}, now(), ${JSON.stringify(payload)}::jsonb) returning id`,
  );
  return row!.id;
}

const jobRow = async (id: string) =>
  (
    await rows<{ status: string; run_at: Date }>(
      admin(),
      sql`select status::text as status, run_at from app.scheduled_jobs where id = ${id}`,
    )
  )[0]!;

beforeAll(async () => {
  owner = await createTestUser('housekeeping-owner');
  const org = (
    await executeCommand(
      testDbs().api.db,
      organizationCreate,
      { businessName: 'Housekeeping HVAC' },
      actor(owner),
      meta(),
    )
  ).output;
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.people (workspace_id, first_name, last_name, phone_e164)
        values (${workspaceId}, 'Old', 'Customer', '+15125550142') returning id`,
  );
  personId = p!.id;
  s = testServices();
});
afterAll(closeTestDbs);

describe('the nightly sync-window sweep', () => {
  it('plans one sweep per business, spread over the night, and comes back the next night', async () => {
    const started = new Date();
    const night = nextSweepNight(Date.now()).getTime();
    try {
      const plan = await job(SYNC_WINDOW_JOBS.plan, {}, false);
      expect(await runJob(plan, night)).toMatchObject({ claimed: 1, rescheduled: 1, failed: 0 });
      const again = await job(SYNC_WINDOW_JOBS.plan, {}, false);
      await runJob(again, night);
      const sweeps = await rows<{ run_at: Date }>(
        admin(),
        sql`select run_at from app.scheduled_jobs
            where kind = ${SYNC_WINDOW_JOBS.sweep} and dedupe_key = ${syncWindowSweepKey(workspaceId)}
              and status = 'pending'`,
      );
      expect(sweeps).toHaveLength(1);
      const at = new Date(sweeps[0]!.run_at).getTime();
      expect(at).toBeGreaterThanOrEqual(night);
      expect(at).toBeLessThan(night + SWEEP_SPREAD_MS);
      const next = (await jobRow(plan)).run_at;
      expect(new Date(next).getUTCHours()).toBe(SWEEP_UTC_HOUR);
      expect(new Date(next).getTime()).toBeGreaterThan(night);
    } finally {
      // The plan made a sweep for every business in the shared database: only this one keeps its own.
      await rows(
        admin(),
        sql`delete from app.scheduled_jobs
            where status = 'pending' and created_at >= ${started.toISOString()}::timestamptz
              and (kind = ${SYNC_WINDOW_JOBS.plan}
                or (kind = ${SYNC_WINDOW_JOBS.sweep} and workspace_id is distinct from ${workspaceId}))`,
      );
    }
  });

  it('hides what aged out in rounds, never an open conversation’s, and carries on when the rounds run out', async () => {
    const [closed] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, status)
          values (${workspaceId}, 'sms', '+15125550101', ${personId}, 'closed') returning id`,
    );
    const [open] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, status)
          values (${workspaceId}, 'sms', '+15125550102', ${personId}, 'open') returning id`,
    );
    const insert = async (conversationId: string, ago: string) =>
      (
        await rows<{ id: string }>(
          admin(),
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at)
              values (${workspaceId}, ${conversationId}, 'sms', 'inbound', 'received', 'Hi', now() - ${ago}::interval)
              returning id`,
        )
      )[0]!.id;
    const old = [];
    for (let i = 0; i < 7; i++) old.push(await insert(closed!.id, '13 months'));
    const recent = await insert(closed!.id, '2 months');
    const keptOpen = await insert(open!.id, '14 months');
    const shown = async () =>
      Object.fromEntries(
        (
          await rows<{ id: string; sync_window: boolean }>(
            admin(),
            sql`select id, sync_window from app.messages where workspace_id = ${workspaceId}`,
          )
        ).map((r) => [r.id, r.sync_window]),
      );

    // Batches of 2 hide all seven in one run (four rounds).
    const sweep = await job(SYNC_WINDOW_JOBS.sweep, { batch: 2 }, true);
    expect(await runJob(sweep)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    const after = await shown();
    for (const id of old) expect(after[id]).toBe(false);
    expect(after[recent]).toBe(true);
    expect(after[keptOpen]).toBe(true);

    // More than a night's rounds (25 of 1, 30 rows): the rest a few minutes later.
    for (let i = 0; i < 30; i++) await insert(closed!.id, '15 months');
    const busy = await job(SYNC_WINDOW_JOBS.sweep, { batch: 1 }, true);
    expect(await runJob(busy)).toMatchObject({ claimed: 1, rescheduled: 1, failed: 0 });
    const later = new Date((await jobRow(busy)).run_at).getTime();
    expect(later).toBeGreaterThan(Date.now() + 3 * 60_000);
    const left = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.messages where workspace_id = ${workspaceId} and sync_window and occurred_at < now() - interval '12 months' and conversation_id = ${closed!.id}`,
    );
    expect(left[0]!.n).toBe(5);
    await rows(admin(), sql`update app.scheduled_jobs set status = 'done' where id = ${busy}`);
  }, 60_000);
});

describe('the daily receipts clean-up', () => {
  it('removes receipts older than 90 days a batch at a time, keeps recent ones, and comes back the next night', async () => {
    const insert = async (ago: string) =>
      (
        await rows<{ id: string }>(
          admin(),
          sql`insert into app.command_receipts (user_id, command_id, workspace_id, command, input_hash, outcome, answer, occurred_at, received_at)
              values (${owner.id}, ${randomUUID()}, ${workspaceId}, 'person.update', ${'a'.repeat(64)}, 'applied', '{}'::jsonb,
                now() - ${ago}::interval, now() - ${ago}::interval) returning id`,
        )
      )[0]!.id;
    const old = [await insert('100 days'), await insert('120 days'), await insert('91 days')];
    const recent = await insert('30 days');
    const clean = await job(RECEIPT_JOBS.cleanUp, { batch: 1 }, false);
    expect(await runJob(clean)).toMatchObject({ claimed: 1, rescheduled: 1, failed: 0 });
    const left = await rows<{ id: string }>(
      admin(),
      sql`select id from app.command_receipts where user_id = ${owner.id}`,
    );
    expect(left.map((r) => r.id)).toEqual([recent]);
    expect(old).toHaveLength(3);
    const next = new Date((await jobRow(clean)).run_at);
    expect(next.getTime()).toBe(nextReceiptCleanUp(next.getTime() - 60 * 60_000).getTime());
    expect(next.getUTCMinutes()).toBe(30);
    await rows(admin(), sql`update app.scheduled_jobs set status = 'done' where id = ${clean}`);
  });
});

describe('the daily problem reports clean-up', () => {
  it('removes reports older than 30 days, handled or not, keeps recent ones, and comes back the next night', async () => {
    const insert = async (ago: string, handled: boolean) =>
      (
        await rows<{ id: string }>(
          admin(),
          sql`insert into app.problem_reports (workspace_id, user_id, addon_id, source, area, job, page, created_at, handled_at)
              values (${workspaceId}, ${owner.id}, 'outreach', 'extension', 'linkedin', 'like', 'activity',
                now() - ${ago}::interval, ${handled ? sql`now()` : sql`null`}) returning id`,
        )
      )[0]!.id;
    await insert('31 days', false);
    await insert('45 days', true);
    const recent = await insert('29 days', false);
    const clean = await job(PROBLEM_REPORT_JOBS.cleanUp, { batch: 1 }, false);
    expect(await runJob(clean)).toMatchObject({ claimed: 1, rescheduled: 1, failed: 0 });
    const left = await rows<{ id: string }>(
      admin(),
      sql`select id from app.problem_reports where user_id = ${owner.id}`,
    );
    expect(left.map((r) => r.id)).toEqual([recent]);
    const next = new Date((await jobRow(clean)).run_at);
    expect(next.getTime()).toBe(nextProblemReportCleanUp(next.getTime() - 60 * 60_000).getTime());
    await rows(admin(), sql`update app.scheduled_jobs set status = 'done' where id = ${clean}`);
  });
});

describe('problem reports clearing themselves (20261027023100)', () => {
  const AREA = `t${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const insert = async (r: {
    ago: string;
    job?: string;
    note?: string;
    kind?: 'fix' | 'limit';
    limitKind?: string | null;
    version?: string | null;
  }) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`insert into app.problem_reports (workspace_id, user_id, addon_id, source, area, job, page, note, version,
              kind, limit_kind, created_at)
            values (${workspaceId}, ${owner.id}, 'outreach', 'extension', ${AREA}, ${r.job ?? 'like'}, 'activity',
              ${r.note ?? null}, ${r.version ?? null}, ${r.kind ?? 'fix'}, ${r.limitKind ?? null},
              now() - ${r.ago}::interval) returning id`,
      )
    )[0]!.id;
  const stateOf = async (id: string) =>
    (
      await rows<{ open: boolean; cleared: string | null; fixed_in: string | null }>(
        admin(),
        sql`select handled_at is null as open, cleared, fixed_in from app.problem_reports where id = ${id}`,
      )
    )[0]!;

  it('clears limits once they’re over and problems quiet for 3 days, and comes back every hour', async () => {
    const aiYesterday = await insert({ ago: '2 days', kind: 'limit', limitKind: 'ai_daily' });
    const aiNow = await insert({ ago: '1 minute', kind: 'limit', limitKind: 'ai_daily' });
    const networkOld = await insert({ ago: '25 hours', kind: 'limit', limitKind: 'network' });
    const networkNew = await insert({ ago: '1 hour', kind: 'limit', limitKind: 'network' });
    const quiet = await insert({ ago: '4 days', note: 'Gone quiet' });
    const stillOld = await insert({ ago: '4 days', note: 'Still happening' });
    const stillNew = await insert({ ago: '1 hour', note: 'Still happening' });
    const recent = await insert({ ago: '2 days', note: 'Only two days ago' });

    const clear = await job(PROBLEM_REPORT_JOBS.clear, {}, false);
    expect(await runJob(clear)).toMatchObject({ claimed: 1, rescheduled: 1, failed: 0 });

    expect(await stateOf(aiYesterday)).toEqual({
      open: false,
      cleared: 'limit_over',
      fixed_in: null,
    });
    expect((await stateOf(aiNow)).open).toBe(true);
    expect(await stateOf(networkOld)).toMatchObject({ open: false, cleared: 'limit_over' });
    expect((await stateOf(networkNew)).open).toBe(true);
    expect(await stateOf(quiet)).toMatchObject({ open: false, cleared: 'quiet' });
    expect((await stateOf(stillOld)).open).toBe(true);
    expect((await stateOf(stillNew)).open).toBe(true);
    expect((await stateOf(recent)).open).toBe(true);

    const next = new Date((await jobRow(clear)).run_at);
    expect(next.getTime()).toBe(nextProblemReportClearing(next.getTime() - 60 * 60_000).getTime());
    expect(next.getUTCMinutes()).toBe(7);
    await rows(admin(), sql`update app.scheduled_jobs set status = 'done' where id = ${clear}`);
  });

  it('clears a fixed problem’s reports from versions before the fix, by number, and keeps the rest', async () => {
    const note = 'Couldn’t find Add friend';
    const before = await insert({ ago: '1 hour', job: 'friend_request', note, version: '0.126.9' });
    const lexical = await insert({ ago: '1 hour', job: 'friend_request', note, version: '0.99.1' });
    const fixed = await insert({ ago: '1 hour', job: 'friend_request', note, version: '0.127.0' });
    const other = await insert({
      ago: '1 hour',
      job: 'friend_request',
      note: 'Another problem',
      version: '0.126.0',
    });
    const [row] = await rows<{ cleared: number }>(
      admin(),
      sql`select private.clear_fixed_problem_reports('extension', ${AREA}, 'friend_request', 'Couldn’t find',
            '0.127.0', null, 100) as cleared`,
    );
    expect(row?.cleared).toBe(2);
    expect(await stateOf(before)).toEqual({ open: false, cleared: 'fixed', fixed_in: '0.127.0' });
    expect((await stateOf(lexical)).cleared).toBe('fixed');
    expect((await stateOf(fixed)).open).toBe(true);
    expect((await stateOf(other)).open).toBe(true);
  });
});

describe('the daily notifications clean-up', () => {
  it('removes notifications older than 30 days a batch at a time, read or not, keeps recent ones, and comes back the next night', async () => {
    const insert = async (ago: string, read: boolean) => {
      const pushId = randomUUID();
      return (
        await rows<{ id: string }>(
          admin(),
          sql`insert into app.notifications (user_id, workspace_id, push_id, collapse_key, category, title, body, path,
                sent_at, seen_at, read_at)
              values (${owner.id}, ${workspaceId}, ${pushId}, ${pushId}, 'customer_message', 'Old Customer',
                'Is anyone there?', ${`/app/w/${workspaceId}/inbox`}, now() - ${ago}::interval,
                ${read ? sql`now()` : sql`null`}, ${read ? sql`now()` : sql`null`}) returning id`,
        )
      )[0]!.id;
    };
    await insert('31 days', false);
    await insert('45 days', true);
    const recent = await insert('29 days', false);
    const clean = await job(NOTIFICATION_JOBS.cleanUp, { batch: 1 }, false);
    expect(await runJob(clean)).toMatchObject({ claimed: 1, rescheduled: 1, failed: 0 });
    const left = await rows<{ id: string }>(
      admin(),
      sql`select id from app.notifications where user_id = ${owner.id}`,
    );
    expect(left.map((r) => r.id)).toEqual([recent]);
    const next = new Date((await jobRow(clean)).run_at);
    expect(next.getTime()).toBe(nextNotificationCleanUp(next.getTime() - 60 * 60_000).getTime());
    await rows(admin(), sql`update app.scheduled_jobs set status = 'done' where id = ${clean}`);
  });
});
