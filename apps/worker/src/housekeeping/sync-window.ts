/**
 * The phones' time window (M10). A business kept on a phone carries messages, calls and the timeline from the last
 * 12 months, appointments from 90 days back, and documents closed within the year; PowerSync can't compare dates, so
 * each of those rows carries a `sync_window` flag, and this nightly sweep turns it off for what aged out
 * (private.sync_window_sweep; triggers turn it back on when something comes back into range).
 *
 * Quiet for the database: `sync_window.plan` runs once a night and gives every business its own
 * `sync_window.sweep`, spread over the night hours. A sweep hides at most SWEEP_BATCH rows per table per round,
 * pauses between rounds, and stops after SWEEP_ROUNDS; a business with more carries on a few minutes later.
 */
import { uuidArray } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import { tenantOf } from '../services';

export const SYNC_WINDOW_JOBS = {
  /** Global, nightly (ensureRecurringJobs): every business gets its sweep for the night. */
  plan: 'sync_window.plan',
  /** One per business, nightly. */
  sweep: 'sync_window.sweep',
} as const;
export const SYNC_WINDOW_PLAN_KEY = 'plan:sync_window';
export const syncWindowSweepKey = (workspaceId: string): string => `sync-window:${workspaceId}`;

const MIN = 60_000;
const HOUR = 60 * MIN;
/** When the night's sweeps start (UTC): 3 AM in Chicago, 1 AM in Los Angeles, 4 AM in New York (summer time). */
export const SWEEP_UTC_HOUR = 8;
/** The sweeps spread over this long, by each business's id. */
export const SWEEP_SPREAD_MS = 3 * HOUR;
/** Rows hidden per table per round. */
export const SWEEP_BATCH = 2000;
/** Rounds per run, and the pause between them. */
export const SWEEP_ROUNDS = 25;
const SWEEP_PAUSE_MS = 250;
/** A business with more to hide carries on this much later. */
const SWEEP_AGAIN_MS = 5 * MIN;
/** Businesses per planning statement. */
const PLAN_CHUNK = 2000;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The batch a job was given (tests use small ones to see the rounds), or the usual. */
export function batchOf(payload: Record<string, unknown>, usual: number): number {
  const b = payload['batch'];
  return typeof b === 'number' && Number.isInteger(b) && b > 0 && b <= usual ? b : usual;
}

/** The next start of the night's sweeps after `now`. */
export function nextSweepNight(now: number): Date {
  const at = new Date(now);
  at.setUTCHours(SWEEP_UTC_HOUR, 0, 0, 0);
  if (at.getTime() <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

/** Nightly: every business has its sweep waiting, spread over the night. */
export const planSyncWindow: JobHandler = async (ctx) => {
  await asWorker(ctx.db, {}, async (tx) => {
    const list = await rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select workspace_id, organization_id from private.workspace_timezones()`,
    );
    const from = new Date(ctx.now).toISOString();
    for (let i = 0; i < list.length; i += PLAN_CHUNK) {
      const chunk = list.slice(i, i + PLAN_CHUNK);
      const keys = chunk.map((b) => sql`${syncWindowSweepKey(b.workspace_id)}`);
      await tx.execute(
        sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
            select b.org, b.ws, ${SYNC_WINDOW_JOBS.sweep}, b.key,
              ${from}::timestamptz
                + (abs(hashtext(b.ws::text)::bigint) % ${SWEEP_SPREAD_MS}::bigint) * interval '1 millisecond',
              '{}'::jsonb
            from unnest(${uuidArray(chunk.map((b) => b.workspace_id))},
              ${uuidArray(chunk.map((b) => b.organization_id))},
              array[${sql.join(keys, sql`, `)}]::text[]) as b(ws, org, key)
            on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
      );
    }
  });
  return { rescheduleAt: nextSweepNight(ctx.now + MIN) };
};

/** One business: rounds of hiding what aged out, until a round leaves every table with less than a batch. */
export const sweepSyncWindow: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const batch = batchOf(ctx.job.payload, SWEEP_BATCH);
  for (let round = 0; round < SWEEP_ROUNDS; round++) {
    if (round > 0) await pause(SWEEP_PAUSE_MS);
    const tables = await asWorker(ctx.db, scope, (tx) =>
      rows<{ table_name: string; hidden: number }>(
        tx,
        sql`select table_name, hidden from private.sync_window_sweep(${scope.workspaceId}, ${batch})`,
      ),
    );
    if (!tables.some((t) => t.hidden >= batch)) return;
  }
  return { rescheduleAt: new Date(Date.now() + SWEEP_AGAIN_MS) };
};

export const syncWindowJobs = {
  [SYNC_WINDOW_JOBS.plan]: planSyncWindow,
  [SYNC_WINDOW_JOBS.sweep]: sweepSyncWindow,
};
