import { and, eq } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import { events, outbox } from '@hfos/db/schema';
import { handlersFor, type HandlerMap } from './handlers/types';
import type { WorkerServices } from './services';
import { renewAfterRefusal } from './telephony/tokens';

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
  // Ours only while the lease holds: an event still waiting its turn after the ones before it ran for five
  // minutes can be claimed by another worker, and its handlers must then run there, not twice.
  const ours = (eventId: string) =>
    and(eq(outbox.eventId, eventId), eq(outbox.lockedBy, deps.workerId));

  for (const row of claimed) {
    // A person's own account events (no organization, no business: a profile saved, the Assistant's OK, deleting an
    // account that belongs to no business) have no tenant for a handler to act in, and the worker can't read them.
    // The support desk's events (M13) also have no tenant, on purpose — they belong to HandsFreeOS itself —
    // and the worker does read those.
    const platformEvent =
      row.event_type.startsWith('support') || row.event_type.startsWith('platform.');
    const list =
      row.organization_id || row.workspace_id || platformEvent
        ? handlersFor(deps.handlers, row.event_type)
        : [];
    try {
      if (list.length === 0) {
        await asWorker(deps.db, {}, (tx) =>
          tx
            .update(outbox)
            .set({ status: 'done', lockedAt: null, lockedBy: null })
            .where(ours(row.event_id)),
        );
        stats.done++;
        continue;
      }
      const scope = { organizationId: row.organization_id, workspaceId: row.workspace_id };
      const ran = await asWorker(deps.db, scope, async (tx) => {
        // Still ours, and locked by this transaction until it ends: no other worker claims it while it runs.
        const [mine] = await tx
          .update(outbox)
          .set({ lockedAt: sql`now()` })
          .where(and(ours(row.event_id), eq(outbox.status, 'pending')))
          .returning({ eventId: outbox.eventId });
        if (!mine) return false;
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
        return true;
      });
      if (ran) stats.done++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const message = errorMessage(e);
      deps.log.warn(
        { eventId: row.event_id, eventType: row.event_type, attempts, failed, err: message },
        'outbox handler failed',
      );
      // Twilio refusing a business's own sign-in can mean its token was rotated: the retry gets the new one.
      await renewAfterRefusal(deps, e);
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
          .where(ours(row.event_id)),
      );
      if (failed) stats.failed++;
      else stats.retried++;
    }
  }
  return stats;
}
