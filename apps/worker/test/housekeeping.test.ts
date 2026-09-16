/**
 * M10 step 6b, the worker's nightly housekeeping for phones.
 * - **The sync-window sweep:** the plan gives each business one sweep, spread over the night, and comes back the next
 *   night; a business's sweep hides what aged out in rounds (never an open conversation's), and carries on later
 *   when a night's rounds weren't enough.
 * - **The receipts clean-up:** receipts older than 90 days go a batch at a time, recent ones stay, and it comes back
 *   the next night.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { executeCommand, organizationCreate, type HumanActor } from '@hfos/core/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
