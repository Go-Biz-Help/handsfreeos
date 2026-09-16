import { eq } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import { events, outbox } from '@hfos/db/schema';
import { handlersFor, type HandlerMap } from './handlers/types';
import type { WorkerServices } from './services';

export interface OutboxDeps extends WorkerServices {
  readonly handlers: HandlerMap;
  readonly workerId: string;
  readonly batchSize: number;
  /** Only claim rows this worker id already reserved (tests and the seed, which share a database with other pollers). */
  readonly reservedOnly?: boolean;
}

export const MAX_ATTEMPTS = 5;
/** 5s, 10s, 20s, 40s ... capped at 10 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000);
}

/** One line for logs and last_error columns, including the driver's cause. */
export function errorMessage(e: unknown): string {
  return e instanceof Error
    ? `${e.message}${e.cause instanceof Error ? ` (${e.cause.message})` : ''}`
    : String(e);
}

type Claimed = {
  event_id: string;
  organization_id: string | null;
  workspace_id: string | null;
  event_type: string;
  attempts: number;
};

export interface OutboxStats {
  claimed: number;
  done: number;
  retried: number;
  failed: number;
}

/** One pass: claim a batch of pending rows, run each handler in a tenant-scoped transaction, record the outcome. */
export async function processOnce(deps: OutboxDeps): Promise<OutboxStats> {
  const stats: OutboxStats = { claimed: 0, done: 0, retried: 0, failed: 0 };
  const claimed = await asWorker(deps.db, {}, (tx) =>
    rows<Claimed>(
      tx,
      sql`with claimed as (update app.outbox o set locked_at = now(), locked_by = ${deps.workerId}
          where o.event_id in (
            select event_id from app.outbox
            where status = 'pending' and next_attempt_at <= now()
              and (locked_at is null or locked_at < now() - interval '5 minutes' or locked_by = ${deps.workerId})
              ${deps.reservedOnly ? sql`and locked_by = ${deps.workerId}` : sql``}
            order by created_at
            limit ${deps.batchSize}
            for update skip locked)
          returning o.event_id, o.organization_id, o.workspace_id, o.event_type, o.attempts, o.created_at)
          select event_id, organization_id, workspace_id, event_type, attempts from claimed
          order by created_at, event_id`,
    ),
  );
  stats.claimed = claimed.length;

  for (const row of claimed) {
    // A person's own account events (no organization, no business: a profile saved, the Assistant's OK, deleting an
    // account that belongs to no business) have no tenant for a handler to act in, and the worker can't read them.
    const list =
      row.organization_id || row.workspace_id ? handlersFor(deps.handlers, row.event_type) : [];
    try {
      if (list.length === 0) {
        await asWorker(deps.db, {}, (tx) =>
          tx
            .update(outbox)
            .set({ status: 'done', lockedAt: null, lockedBy: null })
            .where(eq(outbox.eventId, row.event_id)),
        );
        stats.done++;
        continue;
      }
      const scope = { organizationId: row.organization_id, workspaceId: row.workspace_id };
      await asWorker(deps.db, scope, async (tx) => {
        const [event] = await tx.select().from(events).where(eq(events.id, row.event_id));
        if (!event) throw new Error(`event ${row.event_id} not visible in its own scope`);
        const ctx = {
          ...deps,
          tx,
          event,
          scope,
          attempt: row.attempts + 1,
          maxAttempts: MAX_ATTEMPTS,
          log: deps.log.child({ eventId: event.id, eventType: event.eventType }),
        };
        // In order, in this one transaction; a retry runs every one of them again.
        for (const handler of list) await handler(ctx);
        await tx
          .update(outbox)
          .set({ status: 'done', lockedAt: null, lockedBy: null, lastError: null })
          .where(eq(outbox.eventId, row.event_id));
      });
      stats.done++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const message = errorMessage(e);
      deps.log.warn(
        { eventId: row.event_id, eventType: row.event_type, attempts, failed, err: message },
        'outbox handler failed',
      );
      await asWorker(deps.db, {}, (tx) =>
        tx
          .update(outbox)
          .set({
            status: failed ? 'failed' : 'pending',
            attempts,
            nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
            lastError: message.slice(0, 2000),
            lockedAt: null,
            lockedBy: null,
          })
          .where(eq(outbox.eventId, row.event_id)),
      );
      if (failed) stats.failed++;
      else stats.retried++;
    }
  }
  return stats;
}
