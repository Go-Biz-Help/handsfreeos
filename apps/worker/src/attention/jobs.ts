/**
 * The Action Center's jobs (M8):
 * - `attention.plan`: global and hourly (ensureRecurringJobs). The empty scope sees no businesses, so it lists them
 *   through private.workspace_timezones() and makes sure each has what it needs waiting (BUSINESS_PLANNERS: its
 *   sweep now; step 6 adds the morning email).
 * - `attention.sweep`: one per business, hourly. The whole business reconciled; nothing written when nothing
 *   changed. A new business's first sweep lands somewhere in the hour after planning (spread by its id).
 * - `attention.recheck`: one per subject, at the exact moment one of its kinds turns.
 * - `attention.unsnooze`: one per snoozed item, at its time (the `attention.snoozed` event schedules it).
 * Each business's jobs run bound to it, as every job does.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { uuidArray } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { attentionItems } from '@hfos/db/schema';
import type { JobHandler, JobMap } from '../jobs';
import { tenantOf, type TenantScope } from '../services';
import { urgentAlertJob } from './alerts';
import { autoHandleJob } from './auto';
import {
  ATTENTION_JOBS,
  HOUR,
  SWEEP_EVERY_MS,
  SWEEP_HORIZON_MARGIN_MS,
  sweepJobKey,
} from './constants';
import { ensureEvening } from '../automations/evening';
import { ensureMaintenance } from '../automations/maintenance';
import { ensureReengage } from '../automations/reengage';
import { ensureDigests, sendAttentionDigest } from './digest';
import { settle, type SettleCause, type SettleOutcome } from './settle';
import { isUuid, subjectRefOf } from './subjects';

/** A business, as the plan lists them. */
export interface PlannedBusiness {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly timeZone: string;
}

/** Makes sure every business has one of its jobs waiting (one pending row per dedupe key). */
export type BusinessPlanner = (
  tx: Tx,
  businesses: readonly PlannedBusiness[],
  now: number,
) => Promise<void>;

/** Businesses per statement (three parameters each, well under Postgres's 65,535). */
const PLAN_CHUNK = 2000;

/**
 * Each business's sweep, a statement per 2,000 businesses; one already waiting stays as it is. A new one runs
 * somewhere in the next hour, spread by the business's id, so sweeps don't all land at once.
 */
export async function ensureSweeps(
  tx: Tx,
  businesses: readonly PlannedBusiness[],
  now: number,
): Promise<void> {
  const from = new Date(now).toISOString();
  for (let i = 0; i < businesses.length; i += PLAN_CHUNK) {
    const chunk = businesses.slice(i, i + PLAN_CHUNK);
    const keys = chunk.map((b) => sql`${sweepJobKey(b.workspaceId)}`);
    await tx.execute(
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          select b.org, b.ws, ${ATTENTION_JOBS.sweep}, b.key,
            ${from}::timestamptz
              + (abs(hashtext(b.ws::text)::bigint) % ${SWEEP_EVERY_MS}::bigint) * interval '1 millisecond',
            '{}'::jsonb
          from unnest(${uuidArray(chunk.map((b) => b.workspaceId))},
            ${uuidArray(chunk.map((b) => b.organizationId))},
            array[${sql.join(keys, sql`, `)}]::text[]) as b(ws, org, key)
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
    );
  }
}

/**
 * What every business needs waiting: its hourly sweep, its morning summary at 7 AM where it is, and Automations'
 * daily re-engage run at 10 AM (which does nothing while that's off).
 */
export const BUSINESS_PLANNERS: readonly BusinessPlanner[] = [
  ensureSweeps,
  ensureDigests,
  ensureReengage,
  ensureMaintenance,
  ensureEvening,
];

/** Hourly: every business has its sweep (new ones get theirs within the next hour). */
export const planAttention: JobHandler = async (ctx) => {
  await asWorker(ctx.db, {}, async (tx) => {
    const list = await rows<{ workspace_id: string; organization_id: string; timezone: string }>(
      tx,
      sql`select workspace_id, organization_id, timezone from private.workspace_timezones()`,
    );
    const businesses = list.map((b) => ({
      workspaceId: b.workspace_id,
      organizationId: b.organization_id,
      timeZone: b.timezone || 'UTC',
    }));
    for (const plan of BUSINESS_PLANNERS) await plan(tx, businesses, ctx.now);
  });
  return { rescheduleAt: new Date(ctx.now + HOUR) };
};

/**
 * The whole business reconciled as of `now`, the way the hourly sweep does (the seed and the test route use it
 * too). Only the rechecks due before the next sweep are scheduled; that sweep sees the rest.
 */
export function sweepBusiness(
  tx: Tx,
  scope: TenantScope,
  now: number,
  cause: SettleCause,
): Promise<SettleOutcome> {
  return settle(tx, scope, 'all', new Date(now), {
    cause,
    horizon: new Date(now + SWEEP_EVERY_MS + SWEEP_HORIZON_MARGIN_MS),
  });
}

/** One business, hourly. */
export const sweepAttention: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [ws] = await rows<{ id: string }>(
      tx,
      sql`select id from app.workspaces where id = ${scope.workspaceId}`,
    );
    if (!ws) return false;
    await sweepBusiness(tx, scope, ctx.now, {
      correlationId: randomUUID(),
      causationId: ctx.job.id,
    });
    return true;
  });
  // The business is gone.
  if (!found) return;
  return { rescheduleAt: new Date(ctx.now + SWEEP_EVERY_MS) };
};

/** The moment a job looks as of: its due time at the earliest (a clock a little behind the database's still sees it due). */
const asOf = (ctx: Parameters<JobHandler>[0]): number => Math.max(ctx.now, ctx.job.runAt.getTime());

/** One subject, at the moment one of its kinds turns (it schedules its own next look). */
export const recheckAttention: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const subject = subjectRefOf(ctx.job.payload['subjectType'], ctx.job.payload['subjectId']);
  if (!subject) return;
  const now = new Date(asOf(ctx));
  await asWorker(ctx.db, scope, (tx) =>
    settle(tx, scope, [subject], now, {
      cause: { correlationId: randomUUID(), causationId: ctx.job.id },
    }),
  );
};

/**
 * A snooze ran out: the item is read again, and its subject reconciled, which brings it back (snooze ended), or
 * back with what changed, or clears it when its facts are gone. One snoozed again for later waits until then.
 */
export const unsnoozeAttention: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const itemId = ctx.job.payload['itemId'];
  if (!isUuid(itemId)) return;
  const now = asOf(ctx);
  return asWorker(ctx.db, scope, async (tx) => {
    const [item] = await tx
      .select({
        state: attentionItems.state,
        snoozedUntil: attentionItems.snoozedUntil,
        subjectType: attentionItems.subjectType,
        subjectId: attentionItems.subjectId,
      })
      .from(attentionItems)
      .where(and(eq(attentionItems.id, itemId), eq(attentionItems.workspaceId, scope.workspaceId)));
    if (!item || item.state !== 'snoozed' || !item.snoozedUntil) return;
    if (item.snoozedUntil.getTime() > now + 250) return { rescheduleAt: item.snoozedUntil };
    const subject = subjectRefOf(item.subjectType, item.subjectId);
    if (!subject) return;
    await settle(tx, scope, [subject], new Date(now), {
      cause: { correlationId: randomUUID(), causationId: ctx.job.id },
    });
  });
};

/** Job kind → handler, for scheduled.ts's jobs map. */
export const attentionJobs: JobMap = {
  [ATTENTION_JOBS.plan]: planAttention,
  [ATTENTION_JOBS.sweep]: sweepAttention,
  [ATTENTION_JOBS.recheck]: recheckAttention,
  [ATTENTION_JOBS.unsnooze]: unsnoozeAttention,
  // What HandsFreeOS does on its own, the urgent email, and the morning summary (auto.ts, alerts.ts, digest.ts).
  [ATTENTION_JOBS.autoHandle]: autoHandleJob,
  [ATTENTION_JOBS.urgentAlert]: urgentAlertJob,
  [ATTENTION_JOBS.digest]: sendAttentionDigest,
};
