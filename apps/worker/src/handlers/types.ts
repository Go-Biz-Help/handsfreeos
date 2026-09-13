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

/**
 * Event type → its handler, or several that run in order in the one transaction. A retry runs them all again,
 * so every handler must be safe to repeat: fixed clientIds for messages, state re-read, markers for emails.
 */
export type HandlerMap = Readonly<Record<string, EventHandler | readonly EventHandler[]>>;

/** An event type's handlers in order (none when it has none). */
export function handlersFor(map: HandlerMap, eventType: string): readonly EventHandler[] {
  const found = map[eventType];
  if (!found) return [];
  return typeof found === 'function' ? [found] : found;
}
