/**
 * The Action Center in the worker (M8 step 4): reconciling as events happen (withAttention), the hourly plan and
 * sweep, exact-time rechecks and snoozes running out (jobs.ts). Step 6 plugs its automatic handling, urgent alerts
 * and morning email into follow-ups.ts and BUSINESS_PLANNERS.
 */
import {
  MONEY_FOLLOW_UP_REST_DAYS,
  MONEY_KINDS,
  scheduleJob,
  type AttentionKind,
} from '@hfos/core/server';
import { sql } from '@hfos/db/client';
import { handlersFor, type EventHandler, type HandlerMap } from '../handlers/types';
import { errorMessage } from '../outbox';
import { onHandleRequested } from './auto';
import { ATTENTION_JOBS, RETRY_RECHECK_MS, unsnoozeJobKey } from './constants';
import { scheduleRechecks, settle } from './settle';
import { ATTENTION_EVENTS, isUuid, subjectsOf } from './subjects';

export * from './constants';
export {
  actionCenterActor,
  armAutoAction,
  autoHandleJob,
  autoSwitchOn,
  SKIP_REASONS,
} from './auto';
export { alertUrgent, urgentAlertJob, waitOf, type AlertResult } from './alerts';
export { armDigestNow, ensureDigests, nextAttentionDigestAt, sendAttentionDigest } from './digest';
export {
  attentionJobs,
  BUSINESS_PLANNERS,
  ensureSweeps,
  sweepBusiness,
  type BusinessPlanner,
  type PlannedBusiness,
} from './jobs';
export {
  scheduleRechecks,
  settle,
  type AutoCandidate,
  type SettleCause,
  type SettleOptions,
  type SettleOutcome,
  type UrgentItem,
} from './settle';
export { ATTENTION_EVENTS, subjectRefOf, subjectsOf } from './subjects';

/**
 * After an event's own handlers: the subjects it touched are reconciled in the same transaction. It runs in a
 * savepoint, so a failure here never stops what the other handlers did (a reply, a workflow); the subjects are
 * looked at again a minute later by their recheck job, which retries.
 */
export const onAttentionEvent: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  if (!workspaceId || !organizationId) return;
  const scope = { workspaceId, organizationId };
  const subjects = await subjectsOf(ctx.tx, workspaceId, ctx.event);
  if (subjects.length === 0) return;
  const cause = { correlationId: ctx.event.correlationId, causationId: ctx.event.id };
  try {
    await ctx.tx.transaction((sp) => settle(sp, scope, subjects, new Date(), { cause }));
  } catch (e) {
    ctx.log.warn(
      { err: errorMessage(e), subjects },
      'could not update the Action Center; its recheck will',
    );
    const at = new Date(Date.now() + RETRY_RECHECK_MS).toISOString();
    await scheduleRechecks(
      ctx.tx,
      scope,
      subjects.map((s) => ({ subjectType: s.type, subjectId: s.id, at })),
    );
  }
};

/**
 * A person followed a money card up (M9). The invoice is still owed and the estimate still unanswered, so the
 * card rests a week instead of for good: `handled_until` brings it back, and a change in the figures brings it
 * back sooner. The column is the worker's — 0039's guard says so — which is why it is set here and not by the
 * command that handled it.
 */
export const onItemHandled: EventHandler = async (ctx) => {
  const { workspaceId } = ctx.scope;
  const p = ctx.event.payload as Record<string, unknown>;
  const itemId = p['itemId'];
  if (!workspaceId || !isUuid(itemId) || !MONEY_KINDS.has(String(p['kind'] ?? '') as AttentionKind))
    return;
  await ctx.tx.execute(
    sql`update app.attention_items
        set handled_until = now() + ${`${MONEY_FOLLOW_UP_REST_DAYS} days`}::interval
        where id = ${itemId} and workspace_id = ${workspaceId}
          and state = 'handled' and handled_until is null`,
  );
};

/** A person snoozed an item: it comes back at its time (a later snooze moves nothing; the job waits again). */
export const onItemSnoozed: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const p = ctx.event.payload as Record<string, unknown>;
  const itemId = p['itemId'];
  const until = Date.parse(String(p['until'] ?? ''));
  if (!workspaceId || !organizationId || !isUuid(itemId) || !Number.isFinite(until)) return;
  await scheduleJob(
    ctx.tx,
    {
      kind: ATTENTION_JOBS.unsnooze,
      dedupeKey: unsnoozeJobKey(itemId),
      runAt: new Date(until),
      payload: { itemId },
      workspaceId,
      organizationId,
    },
    { pullEarlier: true },
  );
};

/** The handler map with the Action Center last for every event that can change what needs attention. */
export function withAttention(handlers: HandlerMap): HandlerMap {
  const out: Record<string, EventHandler | readonly EventHandler[]> = { ...handlers };
  for (const type of ATTENTION_EVENTS)
    out[type] = [...handlersFor(handlers, type), onAttentionEvent];
  out['attention.snoozed'] = [...handlersFor(handlers, 'attention.snoozed'), onItemSnoozed];
  out['attention.handled'] = [...handlersFor(handlers, 'attention.handled'), onItemHandled];
  // A person asked HandsFreeOS to handle a safe item: the worker alone schedules and sends it (auto.ts).
  out['attention.handle_requested'] = [
    ...handlersFor(handlers, 'attention.handle_requested'),
    onHandleRequested,
  ];
  return out;
}
