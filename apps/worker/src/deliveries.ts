import { eq } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import { webhookDeliveries } from '@hfos/db/schema';
import { backoffMs, errorMessage, MAX_ATTEMPTS } from './outbox';
import type { WorkerServices } from './services';

export type DeliveryRow = typeof webhookDeliveries.$inferSelect;

export interface DeliveryContext extends WorkerServices {
  readonly delivery: DeliveryRow;
  /** 1 on the first try. */
  readonly attempt: number;
}

/** Returns 'ignored' for deliveries that need no work (a status we do not track, a number nobody owns). */
export type DeliveryProcessor = (ctx: DeliveryContext) => Promise<void | 'ignored'>;
/** `provider:kind` → processor. */
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
  for (const { id } of claimed) {
    const [delivery] = await asWorker(deps.db, {}, (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)),
    );
    if (!delivery) continue;
    const processor = deps.processors[`${delivery.provider}:${delivery.kind}`];
    try {
      const outcome = processor
        ? await processor({
            ...deps,
            delivery,
            attempt: delivery.attempts + 1,
            log: deps.log.child({ deliveryId: id, kind: `${delivery.provider}:${delivery.kind}` }),
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
            lastError: null,
          })
          .where(eq(webhookDeliveries.id, id)),
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
          .where(eq(webhookDeliveries.id, id)),
      );
      if (failed) stats.failed++;
      else stats.retried++;
    }
  }
  return stats;
}
