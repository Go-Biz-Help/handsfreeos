/**
 * One reconcile as the worker runs it (after an event, at a recheck, when a snooze runs out, in the hourly sweep):
 * core's `reconcile` brings the business's items in line with what holds now; then this records an
 * `attention_item.*` event for each real transition only (opened, reopened, snooze ended, resolved, became
 * urgent), so live updates and the audit log never flood; schedules the exact-time rechecks; and hands the outcome
 * to step 6 (follow-ups.ts). Everything runs in the caller's transaction, under reconcile's per-business lock.
 *
 * "Became urgent" is the worker's own: an open item whose urgent_from has come, recorded once per fingerprint
 * (the event's payload carries it, and a new fingerprint may become urgent again). The first-sweep guard: an item
 * that should have been urgent more than STALE_URGENCY_MS before the worker noticed (data from before the Action
 * Center, or a worker that was down) never "becomes urgent". It is marked instead, with alert_fingerprint set to
 * its fingerprint (and alerted_at to that moment), which is exactly what "an urgent email already went out for
 * these facts" looks like to step 6's sender; no event is recorded for it.
 */
import {
  ATTENTION_KIND_LABELS,
  autoActionOf,
  reconcile,
  scheduleJob,
  uuidArray,
  type AttentionKind,
  type AttentionRecheck,
  type AttentionSubjectRef,
  type AttentionTransition,
  type AutoAction,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import type { TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import { ATTENTION_JOBS, ITEM_EVENTS, recheckJobKey, STALE_URGENCY_MS } from './constants';
import { afterSettle } from './follow-ups';

/** What the recorded events are chained to: the event handled, or the job that ran. */
export interface SettleCause {
  readonly correlationId: string;
  readonly causationId: string;
}

export interface SettleOptions {
  readonly cause: SettleCause;
  /** Rechecks later than this are left to the next sweep (a sweep's own); by default every recheck is scheduled. */
  readonly horizon?: Date;
}

/** An open item that turned urgent now (after the first-sweep guard): step 6's urgent alert. */
export interface UrgentItem {
  readonly itemId: string;
  readonly kind: AttentionKind;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly personId: string | null;
  readonly leadId: string | null;
  readonly conversationId: string | null;
  readonly fingerprint: string;
  readonly title: string;
  readonly urgentFrom: string;
  readonly assigneeUserId: string | null;
}

/** An item that opened, came back or woke from a snooze, of a kind that may run on its own: step 6's automatic handling. */
export interface AutoCandidate {
  readonly transition: AttentionTransition;
  readonly action: AutoAction;
}

export interface SettleOutcome {
  readonly scope: TenantScope;
  /** The moment reconciled as of. */
  readonly now: Date;
  readonly cause: SettleCause;
  /** Every real transition, in reconcile's order. */
  readonly transitions: readonly AttentionTransition[];
  /** Items refreshed quietly (no event). */
  readonly updated: readonly string[];
  /** Items that turned urgent now, each recorded as attention_item.became_urgent. */
  readonly becameUrgent: readonly UrgentItem[];
  /** Items the first-sweep guard marked as already alerted instead (alert_fingerprint set, no event). */
  readonly urgentMarkedQuietly: readonly string[];
  /** Transitions to open for kinds that may run on their own (autoActionOf), with the action. */
  readonly autoCandidates: readonly AutoCandidate[];
}

/** Reconciles some subjects (or the whole business), records the transitions, schedules rechecks, runs step 6's follow-ups. */
export async function settle(
  tx: Tx,
  scope: TenantScope,
  subjects: readonly AttentionSubjectRef[] | 'all',
  now: Date,
  opts: SettleOptions,
): Promise<SettleOutcome> {
  const result = await reconcile(tx, scope.workspaceId, subjects, now);
  const urgent = await noticeUrgent(tx, scope.workspaceId, now);
  for (const t of result.transitions) await recordTransition(tx, scope, t, opts.cause);
  for (const u of urgent.became) await recordUrgent(tx, scope, u, opts.cause);
  await scheduleRechecks(tx, scope, result.rechecks, opts.horizon);
  const autoCandidates: AutoCandidate[] = [];
  for (const t of result.transitions) {
    if (t.type === 'resolved' || t.state !== 'open') continue;
    const action = autoActionOf(t.kind, t.reasons);
    if (action) autoCandidates.push({ transition: t, action });
  }
  const outcome: SettleOutcome = {
    scope,
    now,
    cause: opts.cause,
    transitions: result.transitions,
    updated: result.updated,
    becameUrgent: urgent.became,
    urgentMarkedQuietly: urgent.quiet,
    autoCandidates,
  };
  await afterSettle(tx, outcome);
  return outcome;
}

interface UrgentRow extends Record<string, unknown> {
  id: string;
  kind: AttentionKind;
  subject_type: string;
  subject_id: string;
  person_id: string | null;
  lead_id: string | null;
  conversation_id: string | null;
  fingerprint: string;
  title: string;
  urgent_from: Date | string;
  assignee_user_id: string | null;
}

/**
 * The business's open items whose urgent time has come and that haven't turned urgent for these facts yet (no
 * became_urgent event with this fingerprint, and no alert for it). Old ones are marked quietly (the guard above).
 */
async function noticeUrgent(
  tx: Tx,
  workspaceId: string,
  now: Date,
): Promise<{ became: UrgentItem[]; quiet: string[] }> {
  const at = now.toISOString();
  const list = await rows<UrgentRow>(
    tx,
    sql`select i.id, i.kind, i.subject_type, i.subject_id, i.person_id, i.lead_id, i.conversation_id,
          i.fingerprint, i.title, i.urgent_from, i.assignee_user_id
        from app.attention_items i
        where i.workspace_id = ${workspaceId} and i.state = 'open'
          and i.urgent_from is not null and i.urgent_from <= ${at}::timestamptz
          and i.alert_fingerprint is distinct from i.fingerprint
          and not exists (
            select 1 from app.events e
            where e.entity_type = 'attention_item' and e.entity_id = i.id
              and e.event_type = ${ITEM_EVENTS.urgent} and e.payload ->> 'fingerprint' = i.fingerprint)
        order by i.urgent_from, i.id`,
  );
  const became: UrgentItem[] = [];
  const quiet: string[] = [];
  for (const r of list) {
    const urgentFrom = new Date(r.urgent_from);
    if (urgentFrom.getTime() < now.getTime() - STALE_URGENCY_MS) {
      quiet.push(r.id);
      continue;
    }
    became.push({
      itemId: r.id,
      kind: r.kind,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      personId: r.person_id,
      leadId: r.lead_id,
      conversationId: r.conversation_id,
      fingerprint: r.fingerprint,
      title: r.title,
      urgentFrom: urgentFrom.toISOString(),
      assigneeUserId: r.assignee_user_id,
    });
  }
  if (quiet.length)
    await tx.execute(
      sql`update app.attention_items set alert_fingerprint = fingerprint, alerted_at = ${at}::timestamptz
          where workspace_id = ${workspaceId} and id = any(${uuidArray(quiet)})`,
    );
  return { became, quiet };
}

const itemPayload = (t: {
  itemId: string;
  kind: AttentionKind;
  subjectType: string;
  subjectId: string;
  personId: string | null;
  leadId: string | null;
  conversationId: string | null;
  fingerprint: string;
  urgentFrom: string | null;
  assigneeUserId: string | null;
}) => ({
  itemId: t.itemId,
  kind: t.kind,
  subjectType: t.subjectType,
  subjectId: t.subjectId,
  personId: t.personId,
  leadId: t.leadId,
  conversationId: t.conversationId,
  fingerprint: t.fingerprint,
  urgentFrom: t.urgentFrom,
  assigneeUserId: t.assigneeUserId,
});

function recordTransition(
  tx: Tx,
  scope: TenantScope,
  t: AttentionTransition,
  cause: SettleCause,
): Promise<string> {
  const type = ITEM_EVENTS[t.type];
  return recordSystemEvent(tx, {
    type,
    action: type,
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    entityType: 'attention_item',
    entityId: t.itemId,
    payload: { ...itemPayload(t), from: t.from, state: t.state, resolution: t.resolution },
    before: t.from ? { state: t.from } : null,
    after: {
      item: t.title,
      kind: ATTENTION_KIND_LABELS[t.kind],
      state: t.state,
      ...(t.resolution ? { resolution: t.resolution } : {}),
    },
    correlationId: cause.correlationId,
    causationId: cause.causationId,
  });
}

function recordUrgent(
  tx: Tx,
  scope: TenantScope,
  u: UrgentItem,
  cause: SettleCause,
): Promise<string> {
  return recordSystemEvent(tx, {
    type: ITEM_EVENTS.urgent,
    action: ITEM_EVENTS.urgent,
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    entityType: 'attention_item',
    entityId: u.itemId,
    payload: itemPayload(u),
    after: { item: u.title, kind: ATTENTION_KIND_LABELS[u.kind], urgentFrom: u.urgentFrom },
    correlationId: cause.correlationId,
    causationId: cause.causationId,
  });
}

/**
 * One `attention.recheck` per subject at the earliest moment asked for. A pending one that already runs by then
 * stays as it is (nothing written); a later one is pulled earlier, and a running one wakes again then (jobs.ts's
 * `_wakeAt`). Rechecks after `horizon` are left out.
 */
export async function scheduleRechecks(
  tx: Tx,
  scope: TenantScope,
  rechecks: readonly AttentionRecheck[],
  horizon?: Date,
): Promise<number> {
  const wanted = new Map<string, { subjectType: string; subjectId: string; at: number }>();
  for (const r of rechecks) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || (horizon && at > horizon.getTime())) continue;
    const key = recheckJobKey(r.subjectType, r.subjectId);
    const was = wanted.get(key);
    if (!was || at < was.at)
      wanted.set(key, { subjectType: r.subjectType, subjectId: r.subjectId, at });
  }
  if (wanted.size === 0) return 0;
  const pending = await rows<{ dedupe_key: string; next_at: Date | string | null }>(
    tx,
    sql`select dedupe_key,
          case when locked_at is not null and run_at <= now() then (payload ->> '_wakeAt')::timestamptz
            else run_at end as next_at
        from app.scheduled_jobs
        where kind = ${ATTENTION_JOBS.recheck} and status = 'pending'
          and dedupe_key in (${sql.join(
            [...wanted.keys()].map((k) => sql`${k}`),
            sql`, `,
          )})`,
  );
  const next = new Map(
    pending.map((p) => [p.dedupe_key, p.next_at === null ? null : new Date(p.next_at).getTime()]),
  );
  let scheduled = 0;
  for (const [key, r] of wanted) {
    const already = next.get(key);
    if (already !== undefined && already !== null && already <= r.at) continue;
    await scheduleJob(
      tx,
      {
        kind: ATTENTION_JOBS.recheck,
        dedupeKey: key,
        runAt: new Date(r.at),
        payload: { subjectType: r.subjectType, subjectId: r.subjectId },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      },
      { pullEarlier: true },
    );
    scheduled++;
  }
  return scheduled;
}
