/**
 * The trigger dispatcher. `withWorkflows(handlers)` appends `onWorkflowEvent` as the last handler for every
 * event the engine watches, so it runs inside the outbox transaction after the event's own handlers (and an
 * outbox retry runs it again: everything here is safe to repeat).
 *
 * For a trigger event:
 * 1. Loop guards: an event a workflow run caused carries `_workflow` (the kernel writes it). A workflow never
 *    triggers itself, and a chain goes at most MAX_DEPTH deep.
 * 2. Subjects: the customers it's about, by TRIGGER_EVENTS[event].subject.
 * 3. Matching: the active workflows it starts (the trigger index), each with its version's definition.
 * 4. Filters: evaluated on fresh records.
 * 5. Enrol (enrol.ts).
 * Then any event: arm date triggers it sets or moves; wake runs waiting for it; stop runs that stop on it.
 * The engine's own events (workflow.*) are handled in lifecycle.ts.
 */
import {
  findStep,
  TRIGGER_EVENT_KEYS,
  TRIGGER_EVENTS,
  workspaceZone,
  type AnyConditionGroup,
  type StopOn,
  type TriggerEventDef,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  handlersFor,
  type EventHandler,
  type EventRow,
  type HandlerContext,
  type HandlerMap,
} from '../handlers/types';
import type { TenantScope } from '../services';
import { ANCHOR_EVENTS } from './anchors';
import { MAX_DEPTH } from './constants';
import { RunData } from './data';
import { runDefinition, versionDefinition } from './defs';
import { enrol } from './enrol';
import { lateOfEvent } from './late';
import { LIFECYCLE_EVENTS, onLifecycleEvent } from './lifecycle';
import { liveSql, stopRuns, wakeRun } from './runs';
import { armDateTriggers } from './triggers';

/** What stops runs that stop on it (a customer's reply, a booking, the lead won or lost). */
const STOP_KEYS: Readonly<Record<string, StopOn>> = {
  'message.received': 'reply',
  'appointment.booked': 'booking',
  'lead.won': 'lead_won',
  'lead.lost': 'lead_lost',
};

export const WATCHED_EVENTS: readonly string[] = [
  ...new Set([
    ...TRIGGER_EVENT_KEYS,
    ...Object.keys(STOP_KEYS),
    ...Object.keys(ANCHOR_EVENTS),
    ...LIFECYCLE_EVENTS,
  ]),
];

/** The handler map with the dispatcher last for every watched event. */
export function withWorkflows(handlers: HandlerMap): HandlerMap {
  const out: Record<string, EventHandler | readonly EventHandler[]> = { ...handlers };
  for (const type of WATCHED_EVENTS) out[type] = [...handlersFor(handlers, type), onWorkflowEvent];
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

interface LoopGuard {
  readonly runId: string;
  readonly workflowId: string;
  readonly depth: number;
  readonly originRunId: string | null;
}

function guardOf(payload: unknown): LoopGuard | null {
  const w = isRecord(payload) ? payload['_workflow'] : null;
  if (!isRecord(w) || !str(w['runId']) || !str(w['workflowId'])) return null;
  return {
    runId: str(w['runId'])!,
    workflowId: str(w['workflowId'])!,
    depth: typeof w['depth'] === 'number' ? w['depth'] : 0,
    originRunId: str(w['originRunId']),
  };
}

export interface Subject {
  readonly personId: string;
  readonly leadId: string | null;
  readonly appointmentId: string | null;
  readonly conversationId: string | null;
}

const subject = (personId: string, extra: Partial<Subject> = {}): Subject => ({
  personId,
  leadId: null,
  appointmentId: null,
  conversationId: null,
  ...extra,
});

/** The customers an event is about (payloads are thin: the rest is read). */
export async function subjectsOf(tx: Tx, e: EventRow): Promise<Subject[]> {
  const p = isRecord(e.payload) ? e.payload : {};
  const def = (TRIGGER_EVENTS as Readonly<Record<string, TriggerEventDef>>)[e.eventType];
  const rule =
    def?.subject ??
    (e.eventType === 'lead.won' || e.eventType === 'lead.lost' ? 'lead_person' : null);
  const id = e.entityId;
  const personOfLead = async (leadId: string) => {
    const [l] = await rows<{ person_id: string | null }>(
      tx,
      sql`select person_id from app.leads where id = ${leadId}`,
    );
    return l?.person_id ?? null;
  };
  switch (rule) {
    case 'person':
      return id ? [subject(id)] : [];
    case 'payload_person': {
      const personId = str(p['personId']);
      return personId ? [subject(personId, { conversationId: str(p['conversationId']) })] : [];
    }
    case 'lead_person': {
      const personId = id ? await personOfLead(id) : null;
      return personId ? [subject(personId, { leadId: id })] : [];
    }
    case 'appointment_people': {
      if (!id) return [];
      let ids = Array.isArray(p['personIds'])
        ? p['personIds'].filter((x): x is string => typeof x === 'string')
        : null;
      ids ??= (
        await rows<{ person_id: string }>(
          tx,
          sql`select person_id from app.appointment_attendees where appointment_id = ${id} and status <> 'cancelled'`,
        )
      ).map((r) => r.person_id);
      return [...new Set(ids)].map((personId) => subject(personId, { appointmentId: id }));
    }
    case 'task_person': {
      const [t] = id
        ? await rows<{ person_id: string | null; lead_id: string | null }>(
            tx,
            sql`select person_id, lead_id from app.tasks where id = ${id}`,
          )
        : [];
      return t?.person_id ? [subject(t.person_id, { leadId: t.lead_id })] : [];
    }
    case 'record': {
      if (!id) return [];
      if (e.entityType === 'person') return [subject(id)];
      if (e.entityType !== 'lead') return [];
      const personId = await personOfLead(id);
      return personId ? [subject(personId, { leadId: id })] : [];
    }
    default:
      return [];
  }
}

/** The trigger's own values a run keeps (`trigger.*` in conditions and templates). */
function triggerContext(e: EventRow): Record<string, unknown> {
  const p = isRecord(e.payload) ? e.payload : {};
  return {
    event: e.eventType,
    eventId: e.id,
    at: e.createdAt.toISOString(),
    ...(str(p['channel']) ? { channel: p['channel'] } : {}),
    // The button a customer's reply came from (0103), by its words: "Confirm", "Reschedule".
    ...(isRecord(p['button']) && str(p['button']['title']) ? { button: p['button']['title'] } : {}),
    ...(str(p['fromStageId']) ? { from_stage_id: p['fromStageId'] } : {}),
    ...(str(p['toStageId']) ? { to_stage_id: p['toStageId'] } : {}),
  };
}

function lazy<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

async function startRuns(
  ctx: HandlerContext,
  scope: TenantScope,
  guard: LoopGuard | null,
  subjects: () => Promise<Subject[]>,
): Promise<void> {
  const e = ctx.event;
  const flows = await rows<{ id: string; name: string; version: string }>(
    ctx.tx,
    sql`select id, name, active_version_id as version from app.workflows
        where workspace_id = ${scope.workspaceId} and status = 'active' and trigger_kind = 'event'
          and trigger_event = ${e.eventType} and active_version_id is not null`,
  );
  if (!flows.length) return;
  const list = await subjects();
  if (!list.length) return;
  const depth = guard ? guard.depth + 1 : 0;
  const tz = await workspaceZone(ctx.tx, scope.workspaceId);
  const trigger = triggerContext(e);
  // Made on a phone with no signal and recorded when it reconnected: the run knows how far behind it starts.
  const late = lateOfEvent(e);
  const now = Date.now();
  for (const f of flows) {
    if (guard && f.id === guard.workflowId) continue;
    if (depth > MAX_DEPTH) {
      ctx.log.warn(
        { workflowId: f.id, depth, originRunId: guard?.originRunId ?? guard?.runId },
        'workflow chain is too deep; not starting another run',
      );
      continue;
    }
    const def = await versionDefinition(ctx.tx, f.version);
    if (def.trigger.kind !== 'event' || def.trigger.event !== e.eventType) continue;
    for (const sub of list) {
      const data = new RunData(
        ctx.tx,
        { workspaceId: scope.workspaceId, ...sub },
        { timeZone: tz, webUrl: ctx.webUrl, workflowName: f.name, context: { trigger } },
      );
      if (!(await data.passes(def.trigger.filters as AnyConditionGroup, now))) continue;
      await enrol(ctx.tx, {
        scope,
        workflow: { id: f.id, name: f.name },
        versionId: f.version,
        def,
        ...sub,
        triggerEventId: e.id,
        dedupeKey: `evt:${e.id}:${sub.personId}`,
        depth,
        originRunId: guard ? (guard.originRunId ?? guard.runId) : null,
        context: { trigger, ...(late ? { _late: late } : {}) },
        log: ctx.log,
      });
    }
  }
}

interface WatchedRun extends Record<string, unknown> {
  id: string;
  version_id: string | null;
  test_definition: unknown;
  person_id: string | null;
  lead_id: string | null;
  appointment_id: string | null;
  conversation_id: string | null;
  cursor: string | null;
  visits: Record<string, number>;
  stop_on: string[];
  waiting_for: string[];
  context: Record<string, unknown>;
  workflow_name: string;
}

async function wake(ctx: HandlerContext, scope: TenantScope, r: WatchedRun): Promise<void> {
  const e = ctx.event;
  const def = await runDefinition(ctx.tx, {
    versionId: r.version_id,
    testDefinition: r.test_definition,
  }).catch(() => null);
  const loc = def && r.cursor ? findStep(def, r.cursor) : null;
  if (!loc || loc.step.type !== 'wait' || loc.step.until.kind !== 'event') return;
  if (!(loc.step.until.events as readonly string[]).includes(e.eventType)) return;
  const p = isRecord(e.payload) ? e.payload : {};
  const conversationId = str(p['conversationId']);
  const data = new RunData(
    ctx.tx,
    {
      workspaceId: scope.workspaceId,
      personId: r.person_id,
      leadId: r.lead_id,
      appointmentId: r.appointment_id,
      conversationId: conversationId ?? r.conversation_id,
    },
    {
      timeZone: await workspaceZone(ctx.tx, scope.workspaceId),
      webUrl: ctx.webUrl,
      workflowName: r.workflow_name,
      // The wait's own filter reads the event it waited for as the trigger.
      context: { ...r.context, trigger: triggerContext(e) },
    },
  );
  if (!(await data.passes(loc.step.until.filter as AnyConditionGroup, Date.now()))) return;
  const woke = {
    stepKey: `${r.cursor}#${r.visits[r.cursor!] ?? 1}`,
    event: e.eventType,
    eventId: e.id,
    at: e.createdAt.toISOString(),
    conversationId,
    // A reply that came from a button carries it on, for the steps after the wait (`wait.button`, 0103).
    button: triggerContext(e)['button'] ?? null,
    // What it woke for can have reached HandsFreeOS late too: the run is then as far behind as it was.
    late: lateOfEvent(e),
  };
  await ctx.tx.execute(
    sql`update app.workflow_runs set context = context || ${JSON.stringify({ _woke: woke })}::jsonb, waiting_for = '{}'
        where id = ${r.id}`,
  );
  await wakeRun(ctx.tx, scope, r.id);
}

async function wakeAndStop(
  ctx: HandlerContext,
  scope: TenantScope,
  guard: LoopGuard | null,
  subjects: () => Promise<Subject[]>,
): Promise<void> {
  const e = ctx.event;
  const stopKey = STOP_KEYS[e.eventType] ?? null;
  const wakeKey = e.eventType in TRIGGER_EVENTS ? e.eventType : null;
  if (!stopKey && !wakeKey) return;
  const matches = sql`(${stopKey ? sql`stop_on @> array[${stopKey}]::text[]` : sql`false`}
    or ${wakeKey ? sql`waiting_for @> array[${wakeKey}]::text[]` : sql`false`})`;
  // Most events concern no waiting run: a cheap look first, on the GIN indexes.
  const probe = await rows(
    ctx.tx,
    sql`select 1 from app.workflow_runs
        where workspace_id = ${scope.workspaceId} and status in (${liveSql}) and ${matches} limit 1`,
  );
  if (!probe.length) return;
  const persons = [...new Set((await subjects()).map((s) => s.personId))];
  if (!persons.length) return;
  const runs = await rows<WatchedRun>(
    ctx.tx,
    sql`select r.id, r.version_id, r.test_definition, r.person_id, r.lead_id, r.appointment_id, r.conversation_id,
          r.cursor, r.visits, r.stop_on, r.waiting_for, r.context, w.name as workflow_name
        from app.workflow_runs r join app.workflows w on w.id = r.workflow_id
        where r.workspace_id = ${scope.workspaceId} and r.status in (${liveSql}) and ${matches}
          and r.person_id in (${sql.join(
            persons.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
          and (r.trigger_event_id is null or r.trigger_event_id <> ${e.id})
        order by r.id for update of r`,
  );
  const leadId = e.eventType.startsWith('lead.') ? e.entityId : null;
  for (const r of runs) {
    // What a run did itself neither wakes nor stops it.
    if (guard?.runId === r.id) continue;
    if (stopKey && r.stop_on.includes(stopKey) && (!leadId || !r.lead_id || r.lead_id === leadId)) {
      await stopRuns(ctx.tx, scope, [r.id], `stop_on:${stopKey}`);
      continue;
    }
    if (wakeKey && r.waiting_for.includes(wakeKey)) await wake(ctx, scope, r);
  }
}

export const onWorkflowEvent: EventHandler = async (ctx) => {
  const e = ctx.event;
  if (!e.workspaceId || !e.organizationId) return;
  const scope: TenantScope = { workspaceId: e.workspaceId, organizationId: e.organizationId };
  if (await onLifecycleEvent(ctx, scope)) return;
  const guard = guardOf(e.payload);
  const subjects = lazy(() => subjectsOf(ctx.tx, e));
  if (e.eventType in TRIGGER_EVENTS) await startRuns(ctx, scope, guard, subjects);
  await armDateTriggers(ctx.tx, scope, e, Date.now());
  await wakeAndStop(ctx, scope, guard, subjects);
};
