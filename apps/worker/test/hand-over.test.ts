import { randomUUID } from 'node:crypto';
import { executeCommand, organizationCreate, type HumanActor } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimableDeliveries, processDeliveries } from '../src/deliveries';
import { recordDelivery } from '../src/http/common';
import { claimableJobs, processJobs } from '../src/jobs';
import { claimableEvents, processOnce } from '../src/outbox';
import { queuesWaiting } from '../src/queues';
import { countOf, testServices, type TestServices } from './helpers';

/**
 * How work moves between the worker's queues without waiting for a poll (speed audit, Nov 2026).
 *
 * - Each pass tells main.ts when it did something that may have left work for another queue, and the HTTP side
 *   tells it when a webhook is stored: the loop for that queue is woken (main.ts, queues.ts).
 * - The one look a second (`queuesWaiting`) asks with the claims' own words (`claimable…`), so it finds exactly
 *   what a claim would take.
 *
 * The database is shared with the other suites, so every row here is this test's own, held under its own worker
 * id, and "nothing is waiting" is only ever asked about those rows.
 */

const ME = `vitest-handover-${process.pid}`;
const OTHER = `vitest-handover-other-${process.pid}`;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

let s: TestServices;
let owner: TestUser;
const jobIds: string[] = [];
const deliveryKeys: string[] = [];

beforeAll(async () => {
  s = testServices();
  owner = await createTestUser('handover-owner');
});
afterAll(async () => {
  for (const id of jobIds)
    await rows(admin(), sql`delete from app.scheduled_jobs where id = ${id}`);
  for (const key of deliveryKeys)
    await rows(
      admin(),
      sql`delete from app.webhook_deliveries where provider = 'fake' and dedupe_key = ${key}`,
    );
  await closeTestDbs();
});

/** A job of this test's own, due now and held for `ME`, so no other suite's runner takes it. */
async function heldJob(kind: string): Promise<string> {
  const [row] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.scheduled_jobs (kind, run_at, payload, locked_at, locked_by)
        values (${kind}, now(), '{}', now(), ${ME}) returning id`,
  );
  jobIds.push(row!.id);
  return row!.id;
}

async function storedDelivery(onDeliveryStored?: () => void): Promise<string> {
  const key = `handover-${randomUUID()}`;
  deliveryKeys.push(key);
  await recordDelivery(
    {
      ...s,
      httpDb: testDbs().worker.db,
      verifyToken: null,
      webOrigins: [],
      ...(onDeliveryStored ? { onDeliveryStored } : {}),
    },
    {
      provider: 'fake',
      kind: 'handover.ping',
      dedupeKey: key,
      accountRef: null,
      url: 'https://hooks.worker.test/handover',
      params: {},
      workspaceId: null,
      organizationId: null,
    },
  );
  await rows(
    admin(),
    sql`update app.webhook_deliveries set locked_at = now(), locked_by = ${ME}
        where provider = 'fake' and dedupe_key = ${key}`,
  );
  return key;
}

type HeldEvent = {
  event_id: string;
  event_type: string;
  /** Whether it belongs to a business or an organization: the outbox runs handlers only for those. */
  tenant: boolean;
};

/** A new business's events, held for `ME`. */
async function heldEvents(): Promise<HeldEvent[]> {
  const correlationId = randomUUID();
  await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Hand-over Plumbing' },
    actor(owner),
    { correlationId, channel: 'test' as const },
  );
  return rows<HeldEvent>(
    admin(),
    sql`update app.outbox o set locked_at = now(), locked_by = ${ME}
        from app.events e
        where e.id = o.event_id and e.correlation_id = ${correlationId} and o.status = 'pending'
        returning o.event_id, o.event_type,
          (o.organization_id is not null or o.workspace_id is not null) as tenant`,
  );
}

describe('a hand-over between the worker’s queues', () => {
  it('is told when a job’s handler ran, and not for a job that never ran', async () => {
    await heldJob('test.handover.runs');
    await heldJob('test.handover.unknown');
    let ran = 0;
    const stats = await processJobs({
      ...s,
      jobs: { 'test.handover.runs': async () => {} },
      workerId: ME,
      batchSize: 5,
      reservedOnly: true,
      onRan: () => ran++,
    });
    expect(stats).toMatchObject({ claimed: 2, done: 1, failed: 1 });
    expect(ran).toBe(1);
  });

  it('is told when a job’s handler threw: what it did before that still stands', async () => {
    await heldJob('test.handover.throws');
    let ran = 0;
    const stats = await processJobs({
      ...s,
      jobs: {
        'test.handover.throws': async () => {
          throw new Error('half done');
        },
      },
      workerId: ME,
      batchSize: 5,
      reservedOnly: true,
      onRan: () => ran++,
    });
    expect(stats).toMatchObject({ claimed: 1, retried: 1 });
    expect(ran).toBe(1);
  });

  it('is told when a webhook is stored, and again when it was processed', async () => {
    let stored = 0;
    await storedDelivery(() => stored++);
    expect(stored).toBe(1);
    let processed = 0;
    const stats = await processDeliveries({
      ...s,
      processors: { 'fake:handover.ping': async () => {} },
      workerId: ME,
      batchSize: 5,
      reservedOnly: true,
      onProcessed: () => processed++,
    });
    expect(stats).toMatchObject({ claimed: 1, done: 1 });
    expect(processed).toBe(1);
  });

  it('is told for each event that had a handler, and not for the ones with nothing to do', async () => {
    const mine = await heldEvents();
    const handled = mine.find((e) => e.tenant)?.event_type;
    expect(handled).toBeDefined();
    const withHandler = mine.filter((e) => e.tenant && e.event_type === handled).length;
    let told = 0;
    const stats = await processOnce({
      ...s,
      handlers: { [handled!]: async () => {} },
      workerId: ME,
      batchSize: 50,
      reservedOnly: true,
      onHandled: () => told++,
    });
    expect(stats).toMatchObject({ claimed: mine.length, done: mine.length, failed: 0 });
    expect(told).toBe(withHandler);
  });
});

describe('the one look a second at the queues', () => {
  it('finds a job exactly when a claim would take it', async () => {
    const id = await heldJob('test.handover.look');
    const claimable = (workerId: string) =>
      countOf(
        sql`select count(*)::int as count from app.scheduled_jobs
            where id = ${id} and ${claimableJobs(workerId)}`,
      );
    const set = (change: ReturnType<typeof sql>) =>
      rows(admin(), sql`update app.scheduled_jobs set ${change} where id = ${id}`);

    // Held by this worker: its own to take, and nobody else's while the lease is young.
    expect(await claimable(ME)).toBe(1);
    expect(await claimable(OTHER)).toBe(0);
    await set(sql`locked_at = now() - interval '6 minutes'`);
    expect(await claimable(OTHER)).toBe(1);
    await set(sql`locked_at = null, locked_by = null, run_at = now() + interval '1 hour'`);
    expect(await claimable(ME)).toBe(0);
    await set(sql`run_at = now()`);
    expect(await claimable(OTHER)).toBe(1);
    expect((await queuesWaiting(s.db, OTHER)).jobs).toBe(true);
    await set(sql`status = 'done', finished_at = now()`);
    expect(await claimable(ME)).toBe(0);
  });

  it('finds a webhook exactly when a claim would take it', async () => {
    const key = await storedDelivery();
    const claimable = (workerId: string) =>
      countOf(
        sql`select count(*)::int as count from app.webhook_deliveries
            where provider = 'fake' and dedupe_key = ${key} and ${claimableDeliveries(workerId)}`,
      );
    const set = (change: ReturnType<typeof sql>) =>
      rows(
        admin(),
        sql`update app.webhook_deliveries set ${change} where provider = 'fake' and dedupe_key = ${key}`,
      );

    expect(await claimable(ME)).toBe(1);
    expect(await claimable(OTHER)).toBe(0);
    await set(sql`locked_at = now() - interval '6 minutes'`);
    expect(await claimable(OTHER)).toBe(1);
    await set(sql`locked_at = null, locked_by = null, next_attempt_at = now() + interval '1 hour'`);
    expect(await claimable(ME)).toBe(0);
    await set(sql`next_attempt_at = now()`);
    expect(await claimable(OTHER)).toBe(1);
    expect((await queuesWaiting(s.db, OTHER)).webhook).toBe(true);
    await set(sql`status = 'ignored', processed_at = now()`);
    expect(await claimable(ME)).toBe(0);
  });

  it('finds an event exactly when a claim would take it', async () => {
    const [mine] = await heldEvents();
    const id = mine!.event_id;
    const claimable = (workerId: string) =>
      countOf(
        sql`select count(*)::int as count from app.outbox
            where event_id = ${id} and ${claimableEvents(workerId)}`,
      );
    const set = (change: ReturnType<typeof sql>) =>
      rows(admin(), sql`update app.outbox set ${change} where event_id = ${id}`);

    expect(await claimable(ME)).toBe(1);
    expect(await claimable(OTHER)).toBe(0);
    expect((await queuesWaiting(s.db, ME)).outbox).toBe(true);
    await set(sql`locked_at = now() - interval '6 minutes'`);
    expect(await claimable(OTHER)).toBe(1);
    await set(
      sql`locked_by = ${ME}, locked_at = now(), next_attempt_at = now() + interval '1 hour'`,
    );
    expect(await claimable(ME)).toBe(0);
    // Closed, like the rest of this business's events, so nothing of this test's is left waiting.
    await rows(
      admin(),
      sql`update app.outbox set status = 'done', locked_at = null, locked_by = null
          where locked_by = ${ME} and status = 'pending'`,
    );
    expect(await claimable(ME)).toBe(0);
  });
});
