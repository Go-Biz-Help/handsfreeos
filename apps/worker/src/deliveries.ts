import { and, eq } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import { webhookDeliveries } from '@hfos/db/schema';
import { backoffMs, errorMessage, MAX_ATTEMPTS } from './outbox';
import type { WorkerServices } from './services';
import { renewAfterRefusal } from './telephony/tokens';

export type DeliveryRow = typeof webhookDeliveries.$inferSelect;

export interface DeliveryContext extends WorkerServices {
  readonly delivery: DeliveryRow;
  /** 1 on the first try. */
  readonly attempt: number;
}

/** Returns 'ignored' for deliveries that need no work (a status we do not track, a number nobody owns). */
export type DeliveryProcessor = (ctx: DeliveryContext) => Promise<void | 'ignored'>;
/** `provider:kind` → processor; `provider:*` takes every kind of a provider without its own. */
export type ProcessorMap = Readonly<Record<string, DeliveryProcessor>>;

export interface DeliveryDeps extends WorkerServices {
  readonly processors: ProcessorMap;
  readonly workerId: string;
  readonly batchSize: number;
  /** Only claim rows this worker id already reserved (tests and the seed, which share a database with other pollers). */
  readonly reservedOnly?: boolean;
}

export interface DeliveryStats {
  claimed: number;
  done: number;
  ignored: number;
  retried: number;
  failed: number;
}

/**
 * Webhooks are stored and acknowledged by the HTTP server, then processed here with the outbox's rules:
 * claimed with SKIP LOCKED, retried with backoff, failed after MAX_ATTEMPTS.
 */
export async function processDeliveries(deps: DeliveryDeps): Promise<DeliveryStats> {
  const stats: DeliveryStats = { claimed: 0, done: 0, ignored: 0, retried: 0, failed: 0 };
  const claimed = await asWorker(deps.db, {}, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`with claimed as (update app.webhook_deliveries d set locked_at = now(), locked_by = ${deps.workerId}
          where d.id in (
            select id from app.webhook_deliveries
            where status = 'pending' and next_attempt_at <= now()
              and (locked_at is null or locked_at < now() - interval '5 minutes' or locked_by = ${deps.workerId})
              ${deps.reservedOnly ? sql`and locked_by = ${deps.workerId}` : sql``}
            order by received_at
            limit ${deps.batchSize}
            for update skip locked)
          returning d.id, d.received_at)
          select id from claimed order by received_at, id`,
    ),
  );
  stats.claimed = claimed.length;
  // Ours only while the lease holds: a delivery still waiting its turn after the ones before it ran for five
  // minutes can be claimed by another worker, and must then be processed there, not twice.
  const ours = (id: string) =>
    and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.lockedBy, deps.workerId));
  for (const { id } of claimed) {
    // Read as its turn comes, and the lease renewed from now for the processor's own five minutes. One that came
    // for an add-on asks, in the same transaction, whether the add-on still runs in its business.
    const { delivery, addonRuns } = await asWorker(deps.db, {}, async (tx) => {
      const [row] = await tx
        .update(webhookDeliveries)
        .set({ lockedAt: sql`now()` })
        .where(and(ours(id), eq(webhookDeliveries.status, 'pending')))
        .returning();
      if (!row?.addonId) return { delivery: row, addonRuns: true };
      const [check] = await rows<{ ok: boolean }>(
        tx,
        sql`select private.addon_runs_now(${row.workspaceId}::uuid, ${row.addonId}, null) as ok`,
      );
      return { delivery: row, addonRuns: check?.ok === true };
    });
    if (!delivery) continue;
    // A provider whose kinds aren't ours to list (an add-on's service) has one processor for all of them.
    const processor =
      deps.processors[`${delivery.provider}:${delivery.kind}`] ??
      deps.processors[`${delivery.provider}:*`];
    try {
      // An add-on that is off takes nothing in: what its provider sent is set aside, not processed later.
      const outcome = !addonRuns
        ? 'ignored'
        : processor
          ? await processor({
              ...deps,
              delivery,
              attempt: delivery.attempts + 1,
              log: deps.log.child({
                deliveryId: id,
                kind: `${delivery.provider}:${delivery.kind}`,
              }),
            })
          : 'ignored';
      await asWorker(deps.db, {}, (tx) =>
        tx
          .update(webhookDeliveries)
          .set({
            status: outcome === 'ignored' ? 'ignored' : 'done',
            processedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
            lastError: addonRuns ? null : 'addon_inactive',
          })
          .where(ours(id)),
      );
      if (outcome === 'ignored') stats.ignored++;
      else stats.done++;
    } catch (e) {
      const attempts = delivery.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const message = errorMessage(e);
      deps.log.warn(
        {
          deliveryId: id,
          kind: `${delivery.provider}:${delivery.kind}`,
          attempts,
          failed,
          err: message,
        },
        'webhook delivery failed',
      );
      // Twilio refusing a business's own sign-in can mean its token was rotated: the retry gets the new one.
      await renewAfterRefusal(deps, e);
      await asWorker(deps.db, {}, (tx) =>
        tx
          .update(webhookDeliveries)
          .set({
            status: failed ? 'failed' : 'pending',
            attempts,
            nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
            lastError: message.slice(0, 2000),
            lockedAt: null,
            lockedBy: null,
          })
          .where(ours(id)),
      );
      if (failed) stats.failed++;
      else stats.retried++;
    }
  }
  return stats;
}
