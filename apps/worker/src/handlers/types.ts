import type { Tx } from '@hfos/db/client';
import type { events } from '@hfos/db/schema';
import type { Logger } from 'pino';
import type { Mailer } from '../mailer';

export type EventRow = typeof events.$inferSelect;

export interface HandlerContext {
  /** Transaction as service_actor, scoped to the event's tenant. */
  readonly tx: Tx;
  readonly event: EventRow;
  readonly mailer: Mailer;
  readonly webUrl: string;
  readonly log: Logger;
}

export type EventHandler = (ctx: HandlerContext) => Promise<void>;
export type HandlerMap = Readonly<Record<string, EventHandler>>;
