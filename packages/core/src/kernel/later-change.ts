/**
 * Newest wins for a change of state (M10). A phone's change can reach the server after a later change to the same thing
 * by someone else, or after a customer's message, and the later one stands: closing a conversation the customer wrote
 * in since, ticking a task someone reopened since, moving a lead someone moved since. The phone's change isn't applied.
 * Like an edit a later edit beat (field merge), it's answered as applied with `notApplied` naming what didn't change,
 * so the phone's queue shows it as sent, and it's written on the record's timeline: "Dale tried to close the
 * conversation, but Maria wrote again after that".
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { events } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { notAppliedWords } from '../crm/not-applied';
import { userRef } from '../crm/records';
import { changeMoment } from './moment';
import type { CommandContext, RequestMeta } from './types';

/** Whether something changed after this change was made. A change with no moment of its own (the web's) is made now. */
export function changedSince(meta: RequestMeta, at: Date | string | null | undefined): boolean {
  if (!meta.occurredAt || at === null || at === undefined) return false;
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(ms) && ms > meta.occurredAt.getTime();
}

/** A change of state a later change overtook. */
export interface LaterChange {
  /** What didn't change, as the input names it ('stageId', 'tagId', 'answers.need'): returned in `notApplied`. */
  readonly key: string;
  /** What the person tried, after "tried to": "close the conversation". */
  readonly tried: string;
  /** Why it stays as it is: "Maria wrote again after that". */
  readonly because: string;
  /** When the change that stands was made, when it's known. */
  readonly changedAt?: Date | string | null;
}

/**
 * Who made the later change, when this person may see it: the latest of these events on the record, made no earlier
 * than the change's time (less 5 seconds for the clocks), by a person. A member reads only their own events, so this
 * is best effort, and the words then say "it was …".
 */
export async function whoChangedIt(
  tx: Tx,
  entity: { readonly type: string; readonly id: string },
  eventTypes: readonly string[],
  since: Date | string | null | undefined,
  payload?: Readonly<Record<string, unknown>>,
): Promise<string | null> {
  if (since === null || since === undefined) return null;
  const from = new Date((since instanceof Date ? since.getTime() : Date.parse(since)) - 5_000);
  if (Number.isNaN(from.getTime())) return null;
  const [e] = await tx
    .select({ actorType: events.actorType, actorId: events.actorId })
    .from(events)
    .where(
      and(
        eq(events.entityType, entity.type),
        eq(events.entityId, entity.id),
        inArray(events.eventType, [...eventTypes]),
        sql`coalesce(${events.occurredAt}, ${events.createdAt}) >= ${from.toISOString()}::timestamptz`,
        ...(payload ? [sql`${events.payload} @> ${JSON.stringify(payload)}::jsonb`] : []),
      ),
    )
    .orderBy(desc(sql`coalesce(${events.occurredAt}, ${events.createdAt})`))
    .limit(1);
  if (!e || e.actorType !== 'human') return null;
  return (await userRef(tx, e.actorId))?.fullName ?? null;
}

/**
 * Writes the timeline entry for a change of state a later change overtook, on the record's customer, company or lead
 * (nothing when it has none). It happened when the person made the change, like the entry it would have been.
 */
export async function logLaterChange(
  ctx: CommandContext,
  change: LaterChange,
  entity: { readonly type: string; readonly id: string },
  on: {
    readonly personId?: string | null;
    readonly companyId?: string | null;
    readonly leadId?: string | null;
  },
): Promise<void> {
  if (!on.personId && !on.companyId && !on.leadId) return;
  const changedAt = change.changedAt ? new Date(change.changedAt).toISOString() : null;
  const meta = {
    entityType: entity.type,
    entityId: entity.id,
    field: change.key,
    tried: change.tried,
    because: change.because,
    changedAt,
    madeAt: changeMoment(ctx.meta).toISOString(),
  };
  const words = notAppliedWords(meta);
  await logSystemActivity(ctx, {
    subtype: 'edit_not_applied',
    personId: on.personId ?? null,
    companyId: on.companyId ?? null,
    leadId: on.leadId ?? null,
    body: `${words.charAt(0).toUpperCase()}${words.slice(1)}.`,
    meta,
  });
}
