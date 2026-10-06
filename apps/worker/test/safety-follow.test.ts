/**
 * A check-in follows the phone (Real Estate round seven, step 1; Chris 2026-10-05): with Share where I am on, the
 * phone sends where it is until the check-in ends, and only the latest spot is kept, never a trail. A spot taken
 * after the check-in ended, or older than the one kept, changes nothing; a check-in that doesn't share refuses one.
 * Every spot is cleared 30 days after its check-in ended (safety/spots.ts).
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  HfosError,
  organizationCreate,
  safetyCheckIn,
  safetyCheckOut,
  safetyWhere,
  scheduleJob,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processJobs } from '../src/jobs';
import { jobs } from '../src/scheduled';
import { CLEAR_SPOTS_KEY, SPOT_JOBS } from '../src/safety/spots';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const api = () => testDbs().api.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
/** A change made on the phone at `at` (its corrected moment). */
const meta = (at?: Date) => ({
  correlationId: randomUUID(),
  channel: 'test' as const,
  ...(at ? { occurredAt: at } : {}),
});
const MINUTE = 60_000;

let owner: TestUser;
let agent: TestUser;
let ws: string;
let s: TestServices;

const spot = async (id: string) => {
  const [c] = await rows<{
    latitude: string | null;
    longitude: string | null;
    located_at: Date | null;
  }>(
    admin(),
    sql`select latitude, longitude, located_at from app.safety_checkins where id = ${id}`,
  );
  return {
    latitude: c!.latitude === null ? null : Number(c!.latitude),
    longitude: c!.longitude === null ? null : Number(c!.longitude),
    at: c!.located_at ? new Date(c!.located_at).getTime() : null,
  };
};

const checkIn = (id: string, follow: boolean, located = true) =>
  executeCommand(
    api(),
    safetyCheckIn,
    {
      workspaceId: ws,
      id,
      place: '418 Cedar Hollow',
      plannedEndAt: new Date(Date.now() + 60 * MINUTE).toISOString(),
      ...(located ? { latitude: 30.21, longitude: -97.79 } : {}),
      follow,
    },
    actor(agent),
    meta(),
  );

const where = (id: string, lat: number, lng: number, at: Date) =>
  executeCommand(
    api(),
    safetyWhere,
    { workspaceId: ws, checkInId: id, latitude: lat, longitude: lng },
    actor(agent),
    meta(at),
  ).then((r) => r.output as { checkInId: string; kept: boolean; open: boolean });

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('follow-owner'),
    createTestUser('follow-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = (
    (
      await executeCommand(
        api(),
        organizationCreate,
        { businessName: 'Cedar Realty' },
        actor(owner),
        meta(),
      )
    ).output as { workspaceId: string }
  ).workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${agent.id}, 'member')`,
  );
  s = testServices();
}, 120_000);

afterAll(closeTestDbs);

describe('a check-in that shares where the phone is', () => {
  const id = randomUUID();

  it('follows the phone from its first reading', async () => {
    await checkIn(id, true);
    const [r] = await rows<{ follows: boolean }>(
      admin(),
      sql`select follows from app.safety_checkins where id = ${id}`,
    );
    expect(r!.follows).toBe(true);
    expect(await spot(id)).toMatchObject({ latitude: 30.21, longitude: -97.79 });
  });

  it('keeps only the latest spot, by when it was taken', async () => {
    const later = new Date(Date.now() + 2 * MINUTE);
    expect(await where(id, 30.25, -97.75, later)).toEqual({
      checkInId: id,
      kept: true,
      open: true,
    });
    expect(await spot(id)).toEqual({ latitude: 30.25, longitude: -97.75, at: later.getTime() });
    // One taken earlier arrives late (it waited on the phone): the later spot stays.
    expect(await where(id, 30.22, -97.78, new Date(later.getTime() - MINUTE))).toEqual({
      checkInId: id,
      kept: false,
      open: true,
    });
    expect(await spot(id)).toMatchObject({ latitude: 30.25, longitude: -97.75 });
  });

  it('changes nothing once the check-in has ended, and tells the phone to stop', async () => {
    await executeCommand(
      api(),
      safetyCheckOut,
      { workspaceId: ws, checkInId: id },
      actor(agent),
      meta(),
    );
    expect(await where(id, 30.3, -97.7, new Date(Date.now() + 5 * MINUTE))).toEqual({
      checkInId: id,
      kept: false,
      open: false,
    });
    expect(await spot(id)).toMatchObject({ latitude: 30.25, longitude: -97.75 });
  });
});

describe('a check-in that doesn’t share where the phone is', () => {
  it('refuses a spot, saying how to share one', async () => {
    const id = randomUUID();
    await checkIn(id, false);
    const err = await where(id, 30.3, -97.7, new Date()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HfosError);
    expect((err as HfosError).rule).toBe('safety_not_shared');
    expect((err as HfosError).message).toMatch(/Share where I am/);
  });

  it('never follows without a first reading, even when asked to', async () => {
    const id = randomUUID();
    await checkIn(id, true, false);
    const [r] = await rows<{ follows: boolean }>(
      admin(),
      sql`select follows from app.safety_checkins where id = ${id}`,
    );
    expect(r!.follows).toBe(false);
  });
});

describe('checking in somewhere new', () => {
  it('checks out of the one still open', async () => {
    const first = randomUUID();
    const second = randomUUID();
    await checkIn(first, true);
    await checkIn(second, true);
    const states = await rows<{ id: string; state: string }>(
      admin(),
      sql`select id, state from app.safety_checkins where id in (${first}, ${second})`,
    );
    expect(Object.fromEntries(states.map((r) => [r.id, r.state]))).toEqual({
      [first]: 'out',
      [second]: 'in',
    });
    expect(await where(first, 30.3, -97.7, new Date(Date.now() + MINUTE))).toMatchObject({
      kept: false,
      open: false,
    });
  });
});

describe('where a phone was, kept 30 days', () => {
  it('is cleared 30 days after the check-in ended, and kept until then', async () => {
    const old = randomUUID();
    const recent = randomUUID();
    const open = randomUUID();
    await checkIn(old, true);
    await executeCommand(
      api(),
      safetyCheckOut,
      { workspaceId: ws, checkInId: old },
      actor(agent),
      meta(),
    );
    await checkIn(recent, true);
    await executeCommand(
      api(),
      safetyCheckOut,
      { workspaceId: ws, checkInId: recent },
      actor(agent),
      meta(),
    );
    await rows(
      admin(),
      sql`update app.safety_checkins set checked_out_at = now() - interval '31 days' where id = ${old}`,
    );
    await rows(
      admin(),
      sql`update app.safety_checkins set checked_out_at = now() - interval '29 days' where id = ${recent}`,
    );
    await checkIn(open, true);
    const runner = `vitest-spots-${randomUUID().slice(0, 8)}`;
    await asWorker(s.db, {}, (tx) =>
      scheduleJob(tx, {
        kind: SPOT_JOBS.clear,
        dedupeKey: CLEAR_SPOTS_KEY,
        runAt: new Date(),
        payload: {},
        workspaceId: null,
        organizationId: null,
      }),
    );
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${runner}
          where status = 'pending' and kind = ${SPOT_JOBS.clear} and dedupe_key = ${CLEAR_SPOTS_KEY}`,
    );
    await processJobs({ ...s, jobs, workerId: runner, batchSize: 5, reservedOnly: true });
    expect(await spot(old)).toEqual({ latitude: null, longitude: null, at: null });
    expect((await spot(recent)).latitude).toBe(30.21);
    expect((await spot(open)).latitude).toBe(30.21);
    // It comes back the next night.
    const [next] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.scheduled_jobs
          where kind = ${SPOT_JOBS.clear} and dedupe_key = ${CLEAR_SPOTS_KEY} and status = 'pending'`,
    );
    expect(next!.n).toBe(1);
  });
});
