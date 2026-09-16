import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  organizationCreate,
  personCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { STALE_SKIP_NOTE } from '../src/http/test-routes';
import { jobs } from '../src/scheduled';
import { testServices } from './helpers';

/**
 * Playwright's POST /test/outbox/skip-stale: pending events written before a browser run began are marked done
 * (with a note), and later ones stay pending. POST /test/scheduled-jobs/skip-stale (step 7) does the same for due
 * business jobs, leaving jobs not yet due and the worker's own recurring ones. Only this test's own rows are backdated
 * (to 2001), so the other suites' rows in the shared database are never touched.
 */

const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const admin = () => testDbs().admin.db;

let owner: TestUser;
let app: FastifyInstance;

beforeAll(async () => {
  owner = await createTestUser('outbox-skip-owner');
  app = await buildHttpServer({
    ...testServices(),
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
    testRoutes: { jobs },
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

const post = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/test/outbox/skip-stale', payload });

type OutboxRow = {
  event_id: string;
  status: string;
  last_error: string | null;
  locked_by: string | null;
};

describe('POST /test/outbox/skip-stale', () => {
  it('marks pending rows written before `before` done, and leaves later ones pending', async () => {
    const correlationId = randomUUID();
    const meta = { correlationId, channel: 'test' as const };
    const { output } = await executeCommand(
      testDbs().api.db,
      organizationCreate,
      { businessName: 'Stale Outbox HVAC' },
      actor(owner),
      meta,
    );
    await executeCommand(
      testDbs().api.db,
      personCreate,
      { workspaceId: output.workspaceId, firstName: 'Olive', lastName: 'Outbox' },
      actor(owner),
      meta,
    );
    const mine = await rows<{ event_id: string }>(
      admin(),
      sql`select o.event_id from app.outbox o join app.events e on e.id = o.event_id
          where e.correlation_id = ${correlationId} and o.status = 'pending'
          order by o.created_at, o.event_id`,
    );
    expect(mine.length).toBeGreaterThanOrEqual(2);
    const [stale, ...fresh] = mine.map((r) => r.event_id);
    // One row from "before the run", the rest from "during it"; nothing else in the database is that old.
    await rows(
      admin(),
      sql`update app.outbox set created_at = '2001-01-01T00:00:00Z', locked_by = 'someone' where event_id = ${stale!}`,
    );
    await rows(
      admin(),
      sql`update app.outbox set created_at = '2001-01-03T00:00:00Z'
          where event_id in (${sql.join(
            fresh.map((id) => sql`${id}`),
            sql`, `,
          )})`,
    );

    const res = await post({ before: '2001-01-02T00:00:00Z' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ skipped: 1 });

    const after = await rows<OutboxRow>(
      admin(),
      sql`select event_id, status::text as status, last_error, locked_by from app.outbox
          where event_id in (${sql.join(
            mine.map((r) => sql`${r.event_id}`),
            sql`, `,
          )})`,
    );
    expect(after.find((r) => r.event_id === stale)).toEqual({
      event_id: stale,
      status: 'done',
      last_error: STALE_SKIP_NOTE,
      locked_by: null,
    });
    for (const id of fresh)
      expect(after.find((r) => r.event_id === id)).toMatchObject({
        status: 'pending',
        last_error: null,
      });

    // The later rows go back to their real time, for the worker suites' next pass.
    await rows(
      admin(),
      sql`update app.outbox set created_at = now() where event_id in (${sql.join(
        fresh.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  });

  it('refuses a `before` that isn’t a time', async () => {
    expect((await post({ before: 'yesterday' })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
  });
});

describe('POST /test/scheduled-jobs/skip-stale', () => {
  it('cancels due business jobs written before `before`, and leaves the rest', async () => {
    const { output } = await executeCommand(
      testDbs().api.db,
      organizationCreate,
      { businessName: 'Stale Jobs HVAC' },
      actor(owner),
      { correlationId: randomUUID(), channel: 'test' as const },
    );
    const tag = randomUUID();
    const job = async (
      name: string,
      opts: { createdAt: string; runAt: string; business: boolean },
    ) => {
      const [row] = await rows<{ id: string }>(
        admin(),
        sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload, created_at)
            values (${opts.business ? output.organizationId : null}, ${opts.business ? output.workspaceId : null},
              'test.stale', ${`${tag}:${name}`}, ${opts.runAt}::timestamptz, '{}'::jsonb, ${opts.createdAt}::timestamptz)
            returning id`,
      );
      return row!.id;
    };
    const stale = await job('stale', {
      createdAt: '2001-01-01T00:00:00Z',
      runAt: '2001-01-01T00:05:00Z',
      business: true,
    });
    // A plan that fans out over every business, left pending with no business of its own.
    const plan = await job('plan', {
      createdAt: '2001-01-01T00:00:00Z',
      runAt: '2001-01-01T00:05:00Z',
      business: false,
    });
    // Due during the run (a recheck an hour from now).
    const soon = await job('soon', {
      createdAt: '2001-01-01T00:00:00Z',
      runAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      business: true,
    });
    // Due long after it (a seeded business's reminder next week).
    const later = await job('later', {
      createdAt: '2001-01-01T00:00:00Z',
      runAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      business: true,
    });
    const fresh = await job('fresh', {
      createdAt: '2001-01-03T00:00:00Z',
      runAt: '2001-01-03T00:05:00Z',
      business: true,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/test/scheduled-jobs/skip-stale',
      payload: { before: '2001-01-02T00:00:00Z' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ skipped: 3 });
    const after = await rows<{ id: string; status: string; last_error: string | null }>(
      admin(),
      sql`select id, status::text as status, last_error from app.scheduled_jobs where dedupe_key like ${`${tag}:%`}`,
    );
    const statusOf = (id: string) => after.find((r) => r.id === id);
    for (const id of [stale, plan, soon])
      expect(statusOf(id)).toEqual({ id, status: 'cancelled', last_error: STALE_SKIP_NOTE });
    for (const id of [later, fresh])
      expect(statusOf(id)).toMatchObject({ status: 'pending', last_error: null });
    await rows(admin(), sql`delete from app.scheduled_jobs where dedupe_key like ${`${tag}:%`}`);
  });
});
