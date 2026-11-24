import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADDON_JOBS } from '../src/addons/queue';
import type { JobContext } from '../src/jobs';
import { ADDON_DELIVERED_KEEP, sweepDeliveries } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

/**
 * How long the daily sweep keeps a finished job (scheduled.ts): 30 days, and 2 days for an event that was handed to
 * an add-on and went well (the owner's pick from the speed audit, 24 Nov 2026). Those were 7 in 10 of the job table.
 *
 * The database is shared with the other suites, so each row here has a key of this run's own to be found by.
 */

const RUN = `vitest-sweep-${process.pid}`;
const admin = () => testDbs().admin.db;
let s: TestServices;

beforeAll(() => {
  s = testServices();
});
afterAll(async () => {
  await rows(admin(), sql`delete from app.scheduled_jobs where dedupe_key like ${`${RUN}:%`}`);
  await closeTestDbs();
});

/** A job that ended `daysAgo` days ago. An insert doesn't touch the row's own "last changed", so it says so too. */
async function ended(name: string, kind: string, status: 'done' | 'failed', daysAgo: number) {
  await rows(
    admin(),
    sql`insert into app.scheduled_jobs (kind, dedupe_key, run_at, payload, status, finished_at, updated_at)
        values (${kind}, ${`${RUN}:${name}`}, now() - make_interval(days => ${daysAgo}), '{}', ${status},
          now() - make_interval(days => ${daysAgo}), now() - make_interval(days => ${daysAgo}))`,
  );
}

const left = async () =>
  (
    await rows<{ name: string }>(
      admin(),
      sql`select substr(dedupe_key, ${RUN.length + 2}) as name from app.scheduled_jobs
          where dedupe_key like ${`${RUN}:%`} order by 1`,
    )
  ).map((r) => r.name);

describe('the daily sweep of finished jobs', () => {
  it('keeps an add-on’s delivered event 2 days, and everything else 30', async () => {
    expect(ADDON_DELIVERED_KEEP).toBe('2 days');
    await ended('delivered-3-days', ADDON_JOBS.deliver, 'done', 3);
    await ended('delivered-1-day', ADDON_JOBS.deliver, 'done', 1);
    await ended('delivery-failed-3-days', ADDON_JOBS.deliver, 'failed', 3);
    await ended('delivery-failed-31-days', ADDON_JOBS.deliver, 'failed', 31);
    await ended('other-3-days', `${RUN}.other`, 'done', 3);
    await ended('other-31-days', `${RUN}.other`, 'done', 31);

    const out = await sweepDeliveries({
      ...s,
      job: { id: '00000000-0000-4000-8000-000000000000', kind: 'webhook_deliveries.sweep' },
      scope: {},
      attempt: 1,
      now: Date.now(),
    } as unknown as JobContext);

    expect(await left()).toEqual(['delivered-1-day', 'delivery-failed-3-days', 'other-3-days']);
    // Nothing was left over, so it comes back tomorrow.
    expect(out && out.rescheduleAt.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
  });
});
