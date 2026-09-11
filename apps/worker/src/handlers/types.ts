import type { Db, SystemScope, Tx } from '@hfos/db/client';
import type { events } from '@hfos/db/schema';
import type { Logger } from 'pino';
import type { Mailer } from '../mailer';
import type { ObjectStore } from '../storage';

export type EventRow = typeof events.$inferSelect;

export interface HandlerContext {
  /** Transaction as service_actor, scoped to the event's tenant. Marked done with the handler's own writes. */
  readonly tx: Tx;
  readonly event: EventRow;
  /** The tenant scope of the job, for handlers that must commit in steps (imports) via `asWorker(db, scope, …)`. */
  readonly db: Db;
  readonly scope: SystemScope;
  /** 1 on the first try; MAX_ATTEMPTS on the last. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly mailer: Mailer;
  readonly store: ObjectStore;
  readonly webUrl: string;
  readonly log: Logger;
}

export type EventHandler = (ctx: HandlerContext) => Promise<void>;
export type HandlerMap = Readonly<Record<string, EventHandler>>;
