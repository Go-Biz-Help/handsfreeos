/**
 * M8 step 4 on the real database: the hourly sweep opens a stale lead after its days and writes nothing when nothing
 * changed; the test route sweeps as of a time; the plan gives every business exactly one sweep; and the first sweep
 * over data from before the Action Center never counts an old clock as "became urgent" (no urgent email).
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATTENTION_JOBS } from '../src/attention/index';
import {
  attentionWorld,
  backdate,
  DAY,
  filedCustomer,
  inboundLead,
  itemEvents,
  itemOf,
  itemsOf,
  pendingSweeps,
  runPlan,
  runSweep,
  typedLead,
  type AttentionWorld,
} from './attention-world';
import { admin, drain, HOUR, iso, makeWorld, post, type World } from './booking-world';

let w: AttentionWorld;

beforeAll(async () => {
  w = await attentionWorld('attnsw');
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

/** Everything a sweep could write for the business (its own job's next run aside). */
async function footprint(x: World) {
  const [counts] = await rows<{ events: number; audits: number; outbox: number }>(
    admin(),
    sql`select
          (select count(*)::int from app.events where workspace_id = ${x.workspaceId}) as events,
          (select count(*)::int from app.audit_logs where workspace_id = ${x.workspaceId}) as audits,
          (select count(*)::int from app.outbox where workspace_id = ${x.workspaceId}) as outbox`,
  );
  const items = await rows(
    admin(),
    sql`select id, state::text as state, updated_at, fingerprint from app.attention_items
        where workspace_id = ${x.workspaceId} order by id`,
  );
  const jobs = await rows(
    admin(),
    sql`select id, kind, status::text as status, run_at, payload from app.scheduled_jobs
        where workspace_id = ${x.workspaceId} and kind <> ${ATTENTION_JOBS.sweep} order by id`,
  );
  return { counts, items, jobs };
}

describe('the hourly sweep', () => {
  it('opens a stale lead after its days, and writes nothing when nothing changed', async () => {
    const ken = await filedCustomer(w, 'Ken');
    const leadId = await typedLead(w, ken.id, 'Duct cleaning', { nextActionInDays: 60 });
    await drain(w);
    expect(await itemsOf(w, [leadId])).toEqual([]);

    // Eight days go by with nothing happening (the lead's clock moves back; no event).
    await backdate(leadId, 8 * 24 * 60);
    await runSweep(w);
    const stale = await itemOf(w, leadId, 'stale_opportunity');
    expect(stale).toMatchObject({ state: 'open', urgentFrom: null });
    expect(await itemEvents(stale.id)).toEqual(['opened']);

    // An hour on, nothing new: the next sweep writes nothing at all.
    const before = await footprint(w);
    await runSweep(w, Date.now() + HOUR);
    expect(await footprint(w)).toEqual(before);
  });

  it('runs as of a time through the test route', async () => {
    const joe = await filedCustomer(w, 'Joe');
    const leadId = await typedLead(w, joe.id, 'Thermostat', { nextActionInDays: 60 });
    await drain(w);
    const res = await post(w, '/test/attention/sweep', {
      workspaceId: w.workspaceId,
      at: iso(Date.now() + 8 * DAY),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { transitions: unknown[] }).transitions).toContainEqual(
      expect.objectContaining({ type: 'opened', kind: 'stale_opportunity', subjectId: leadId }),
    );
    await drain(w);
    expect(await itemEvents((await itemOf(w, leadId, 'stale_opportunity')).id)).toEqual(['opened']);
  });
});

describe('the hourly plan', () => {
  it('gives every business exactly one sweep, within the next hour', async () => {
    const other = await makeWorld('attnsw2');
    const started = new Date();
    try {
      await runPlan(w);
      await runPlan(w);
      for (const x of [w, other]) expect(await pendingSweeps(x)).toHaveLength(1);
      const [fresh] = await pendingSweeps(other);
      const runAt = new Date(fresh!.run_at).getTime();
      expect(runAt).toBeGreaterThanOrEqual(started.getTime() - 1000);
      expect(runAt).toBeLessThan(Date.now() + HOUR);
    } finally {
      // The plan waits for every business in the shared database: only these two keep theirs.
      await rows(
        admin(),
        sql`delete from app.scheduled_jobs
            where status = 'pending' and created_at >= ${started.toISOString()}::timestamptz
              and (kind = ${ATTENTION_JOBS.plan}
                or (kind = ${ATTENTION_JOBS.sweep}
                  and workspace_id not in (${w.workspaceId}, ${other.workspaceId})))`,
      );
      await other.app.close();
    }
  });
});

describe('the first sweep over data from before the Action Center', () => {
  it('never counts an old clock as becoming urgent', async () => {
    const x = await attentionWorld('attnfirst');
    try {
      const amy = await filedCustomer(x, 'Amy');
      const bob = await filedCustomer(x, 'Bob');
      const old = await inboundLead(x, amy.id, 'Old furnace', 3 * 24 * 60);
      const recent = await inboundLead(x, bob.id, 'New furnace', 20);
      // Their events were handled before the Action Center existed.
      await rows(
        admin(),
        sql`update app.outbox set status = 'done'
            where workspace_id = ${x.workspaceId} and status = 'pending'`,
      );
      expect(await itemsOf(x, [old, recent])).toEqual([]);

      await runSweep(x);
      // Three days waiting: listed (and urgent on Home), but marked as if its alert went out, and no event says
      // it became urgent.
      const was = await itemOf(x, old, 'unanswered_lead');
      expect(was.state).toBe('open');
      expect(was.urgentFrom).not.toBeNull();
      expect(was.alertFingerprint).toBe(was.fingerprint);
      expect(was.alertedAt).not.toBeNull();
      expect(await itemEvents(was.id)).toEqual(['opened']);
      // Twenty minutes waiting: it did become urgent just now.
      const now = await itemOf(x, recent, 'unanswered_lead');
      expect(now.alertFingerprint).toBeNull();
      expect(await itemEvents(now.id)).toEqual(['became_urgent', 'opened']);

      // And the next sweep stays quiet about both.
      await runSweep(x);
      expect(await itemEvents(was.id)).toEqual(['opened']);
      expect(await itemEvents(now.id)).toEqual(['became_urgent', 'opened']);
    } finally {
      await x.app.close();
    }
  });
});
