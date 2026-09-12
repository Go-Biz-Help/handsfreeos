import type { SystemScope, Tx } from '@hfos/db/client';
import type { events } from '@hfos/db/schema';
import type { WorkerServices } from '../services';

export type EventRow = typeof events.$inferSelect;

export interface HandlerContext extends WorkerServices {
  /** Transaction as service_actor, scoped to the event's tenant. Marked done with the handler's own writes. */
  readonly tx: Tx;
  readonly event: EventRow;
  /** The tenant scope of the job, for handlers that must commit in steps (imports) via `asWorker(db, scope, …)`. */
  readonly scope: SystemScope;
  /** 1 on the first try; MAX_ATTEMPTS on the last. */
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type EventHandler = (ctx: HandlerContext) => Promise<void>;
export type HandlerMap = Readonly<Record<string, EventHandler>>;
