/**
 * What a funnel hears (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "How it runs"), as event handlers that run
 * before the teammate's, so a person a funnel just took in isn't also greeted by "Message new leads first":
 * - **Getting in:** a new lead in a funnel's pipeline (any, or by how they came in), a form sent, a booking made,
 *   each by the funnel's rules (`funnel.add_person` as HandsFreeOS). Someone a person took out, or who asked for no
 *   more texts, isn't taken in again by a rule.
 * - **Moving on:** what they do (a form, a booking or a cancellation, joining, being there or not, writing back) is
 *   noted at their stage for its "only if"s, and moves them when one of the stage's moves names it.
 * - **Pausing:** someone on the team taking the conversation, or the teammate handing it over, pauses their funnel;
 *   handing it back picks it up. STOP, or their lead archived or deleted, takes them out.
 * - **Waking:** reaching a stage, being picked up, the funnel saved or turned on, or the teammate turned back on wakes
 *   the people concerned (tick.ts); leaving or pausing stops their tick.
 *
 * A funnel's own trouble never holds up the event's other work: each step runs in a savepoint of its own and is
 * logged when it fails.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  definitionOf,
  executeCommandIn,
  funnelAddPerson,
  funnelMovePerson,
  funnelNoteProgress,
  funnelPausePerson,
  funnelRemovePerson,
  uuidArray,
  waitingLeadsSql,
  type FunnelEvent,
  type FunnelPauseReason,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { funnelPeople, funnels } from '@hfos/db/schema';
import type { EventHandler, EventRow, HandlerContext, HandlerMap } from '../handlers/types';
import { handlersFor } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { scheduleDebouncedJob } from '../jobs';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { ADD_EXISTING_BATCH, addExistingJobKey, FUNNEL_JOBS } from './constants';
import { dropFunnelTick, pokeFunnel, pokeFunnelPerson } from './tick';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];

const scopeOf = (e: EventRow): TenantScope | null =>
  e.workspaceId && e.organizationId
    ? { workspaceId: e.workspaceId, organizationId: e.organizationId }
    : null;
const payloadOf = (e: EventRow): Record<string, unknown> => (isRecord(e.payload) ? e.payload : {});

/** Runs a funnel step in a savepoint: its failure is logged, and the event's other work goes on. */
async function quietly(ctx: HandlerContext, what: string, fn: (tx: Tx) => Promise<unknown>) {
  try {
    await ctx.tx.transaction(async (sp) => {
      await fn(sp);
    });
  } catch (e) {
    ctx.log.warn(
      { err: e, eventId: ctx.event.id, eventType: ctx.event.eventType },
      `funnel: ${what}`,
    );
  }
}

const cmd = (ctx: HandlerContext, scope: TenantScope) => ({
  actor: systemActor(scope),
  meta: workerMeta(ctx.event.correlationId, ctx.event.id),
});

type Row = typeof funnelPeople.$inferSelect;

/** Their row in a funnel now (in it, or paused). */
async function currentRow(tx: Tx, personId: string): Promise<Row | null> {
  const [r] = await tx
    .select()
    .from(funnelPeople)
    .where(
      and(eq(funnelPeople.personId, personId), inArray(funnelPeople.status, ['active', 'paused'])),
    );
  return r ?? null;
}

/** Whether a rule may take them into this funnel: not in it, and not taken out by a person or by STOP. */
async function ruleMayAdd(tx: Tx, funnelId: string, personId: string): Promise<boolean> {
  const [r] = await rows<{ blocked: boolean }>(
    tx,
    sql`select exists (select 1 from app.funnel_people fp where fp.funnel_id = ${funnelId}
          and fp.person_id = ${personId}
          and (fp.status in ('active', 'paused') or fp.left_reason in ('removed', 'opted_out'))) as blocked`,
  );
  return !r?.blocked;
}

/** The funnels that are on in the business, with their definitions. */
async function liveFunnels(tx: Tx, workspaceId: string) {
  const list = await tx
    .select()
    .from(funnels)
    .where(and(eq(funnels.workspaceId, workspaceId), eq(funnels.status, 'on')));
  return list.map((f) => ({ row: f, def: definitionOf(f) }));
}

// ---- Getting in ----

/** `lead.created`: a funnel on that lead's pipeline takes in new leads, or ones that came in this way. */
export const onLeadCreatedForFunnel: EventHandler = async (ctx) => {
  const e = ctx.event;
  const scope = scopeOf(e);
  if (!scope || !e.entityId) return;
  // An import works for the person importing: nobody is taken in on their behalf.
  if (e.actorType === 'system' && str(payloadOf(e)['onBehalfOf'])) return;
  const [lead] = await rows<{
    pipeline_id: string;
    person_id: string | null;
    source: string | null;
    status: string;
    archived_at: Date | null;
  }>(
    ctx.tx,
    sql`select pipeline_id, person_id, source, status::text as status, archived_at
        from app.leads where id = ${e.entityId}`,
  );
  if (!lead?.person_id || lead.status !== 'open' || lead.archived_at) return;
  const [funnel] = await ctx.tx
    .select()
    .from(funnels)
    .where(and(eq(funnels.pipelineId, lead.pipeline_id), eq(funnels.status, 'on')));
  if (!funnel) return;
  const def = definitionOf(funnel);
  const ways = def.entry.rules.flatMap((r) => (r.kind === 'came_in' ? r.ways : []));
  let takes = def.entry.rules.some((r) => r.kind === 'new_lead');
  if (!takes && ways.length && lead.source) {
    const [k] = await rows<{ yes: boolean }>(
      ctx.tx,
      sql`select exists (select 1 from app.intake_sources s where s.workspace_id = ${scope.workspaceId}
            and s.name = ${lead.source} and s.kind::text = any(${sql`${`{${ways.join(',')}}`}::text[]`})) as yes`,
    );
    takes = !!k?.yes;
  }
  if (!takes || !(await ruleMayAdd(ctx.tx, funnel.id, lead.person_id))) return;
  const { actor, meta } = cmd(ctx, scope);
  await quietly(ctx, 'couldn’t take in a new lead', (tx) =>
    executeCommandIn(
      tx,
      funnelAddPerson,
      {
        workspaceId: scope.workspaceId,
        funnelId: funnel.id,
        personId: lead.person_id,
        leadId: e.entityId,
        addedBy: 'rule',
      },
      actor,
      meta,
    ),
  );
};

// ---- What they do ----

interface Happening {
  readonly event: FunnelEvent;
  readonly personIds: readonly string[];
  readonly formId: string | null;
  readonly calendarId: string | null;
  readonly appointmentId: string | null;
}

/** The funnel event an event is, and whom it's about; null for one a funnel doesn't hear. */
async function happeningOf(tx: Tx, e: EventRow): Promise<Happening | null> {
  const p = payloadOf(e);
  const one = str(p['personId']);
  const base = { formId: null, calendarId: str(p['calendarId']), appointmentId: e.entityId };
  switch (e.eventType) {
    case 'form.submitted':
    case 'form.stopped':
      return one
        ? {
            event: e.eventType,
            personIds: [one],
            formId: str(p['formId']),
            calendarId: null,
            appointmentId: null,
          }
        : null;
    case 'appointment.booked':
      return { ...base, event: 'appointment.booked', personIds: strs(p['personIds']) };
    case 'attendee.added':
      return one ? { ...base, event: 'appointment.booked', personIds: [one] } : null;
    case 'appointment.cancelled':
      return { ...base, event: 'appointment.cancelled', personIds: strs(p['personIds']) };
    case 'attendee.cancelled':
    case 'attendee.removed':
      return one ? { ...base, event: 'appointment.cancelled', personIds: [one] } : null;
    case 'attendee.joined':
    case 'attendee.attended':
    case 'attendee.no_show':
      return one ? { ...base, event: e.eventType, personIds: [one] } : null;
    case 'message.received': {
      const conversationId = str(p['conversationId']);
      if (!conversationId || str(p['keyword'])) return null;
      const [c] = await rows<{ person_id: string | null }>(
        tx,
        sql`select person_id from app.conversations where id = ${conversationId}`,
      );
      return c?.person_id
        ? {
            event: 'message.received',
            personIds: [c.person_id],
            formId: null,
            calendarId: null,
            appointmentId: null,
          }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Something they did: noted at their stage, a move that names it taken, and a funnel whose rules start on it takes
 * them in (a form sent, a booking made).
 */
export const onHappening: EventHandler = async (ctx) => {
  const scope = scopeOf(ctx.event);
  if (!scope) return;
  const h = await happeningOf(ctx.tx, ctx.event);
  if (!h || !h.personIds.length) return;
  const { actor, meta } = cmd(ctx, scope);
  const ws = scope.workspaceId;
  for (const personId of h.personIds) {
    const row = await currentRow(ctx.tx, personId);
    if (row?.stageId) {
      const [funnel] = await ctx.tx.select().from(funnels).where(eq(funnels.id, row.funnelId));
      const stage = funnel
        ? definitionOf(funnel).stages.find((s) => s.stageId === row.stageId)
        : undefined;
      const appointment =
        h.event === 'appointment.booked'
          ? h.appointmentId
          : h.event === 'appointment.cancelled' && row.appointmentId === h.appointmentId
            ? null
            : undefined;
      await quietly(ctx, 'couldn’t note what they did', (tx) =>
        executeCommandIn(
          tx,
          funnelNoteProgress,
          {
            workspaceId: ws,
            funnelPersonId: row.id,
            stageId: row.stageId!,
            seen: h.event,
            ...(appointment !== undefined ? { appointmentId: appointment } : {}),
          },
          actor,
          meta,
        ),
      );
      const move =
        funnel?.status === 'on'
          ? stage?.moves.find(
              (m) =>
                m.kind === 'event' &&
                m.event === h.event &&
                (!m.formId || m.formId === h.formId) &&
                (!m.calendarId || m.calendarId === h.calendarId),
            )
          : undefined;
      if (move)
        await quietly(ctx, 'couldn’t move them on', (tx) =>
          executeCommandIn(
            tx,
            funnelMovePerson,
            { workspaceId: ws, funnelPersonId: row.id, stageId: move.to, moveId: move.id },
            actor,
            meta,
          ),
        );
      // An "only if" may hold now: look again.
      else if (row.status === 'active') await pokeFunnelPerson(ctx.tx, scope, row.id);
    }
    // A funnel that starts on this takes them in (unless it's the one they're in).
    if (h.event !== 'form.submitted' && h.event !== 'appointment.booked') continue;
    for (const f of await liveFunnels(ctx.tx, ws)) {
      if (row?.funnelId === f.row.id) continue;
      const fits = f.def.entry.rules.some((r) =>
        h.event === 'form.submitted'
          ? r.kind === 'form' && r.formId === h.formId
          : r.kind === 'booking' && r.calendarId === h.calendarId,
      );
      if (!fits || !(await ruleMayAdd(ctx.tx, f.row.id, personId))) continue;
      await quietly(ctx, 'couldn’t take them in', (tx) =>
        executeCommandIn(
          tx,
          funnelAddPerson,
          { workspaceId: ws, funnelId: f.row.id, personId, addedBy: 'rule' },
          actor,
          meta,
        ),
      );
      break;
    }
  }
};

// ---- Pausing, and taking them out ----

const pauseOn =
  (reason: FunnelPauseReason): EventHandler =>
  async (ctx) => {
    const scope = scopeOf(ctx.event);
    const personId = str(payloadOf(ctx.event)['personId']);
    if (!scope || !personId) return;
    const row = await currentRow(ctx.tx, personId);
    if (row?.status !== 'active') return;
    const { actor, meta } = cmd(ctx, scope);
    await quietly(ctx, 'couldn’t pause their funnel', (tx) =>
      executeCommandIn(
        tx,
        funnelPausePerson,
        { workspaceId: scope.workspaceId, funnelPersonId: row.id, paused: true, reason },
        actor,
        meta,
      ),
    );
  };

/** `conversation.handed_to_ai`: the team handed them back, so their funnel picks up (unless paused by hand). */
export const onHandedBack: EventHandler = async (ctx) => {
  const scope = scopeOf(ctx.event);
  const personId = str(payloadOf(ctx.event)['personId']);
  if (!scope || !personId) return;
  const row = await currentRow(ctx.tx, personId);
  if (row?.status !== 'paused') return;
  const { actor, meta } = cmd(ctx, scope);
  await quietly(ctx, 'couldn’t pick their funnel up', (tx) =>
    executeCommandIn(
      tx,
      funnelPausePerson,
      { workspaceId: scope.workspaceId, funnelPersonId: row.id, paused: false },
      actor,
      meta,
    ),
  );
};

/** STOP, or their lead gone: out of their funnel. */
const takeOut =
  (reason: 'opted_out' | 'lead_gone', by: 'person' | 'lead'): EventHandler =>
  async (ctx) => {
    const e = ctx.event;
    const scope = scopeOf(e);
    if (!scope || !e.entityId || e.entityType !== by) return;
    const [row] = await ctx.tx
      .select()
      .from(funnelPeople)
      .where(
        and(
          by === 'person'
            ? eq(funnelPeople.personId, e.entityId)
            : eq(funnelPeople.leadId, e.entityId),
          inArray(funnelPeople.status, ['active', 'paused']),
        ),
      );
    if (!row) return;
    const { actor, meta } = cmd(ctx, scope);
    await quietly(ctx, 'couldn’t take them out', (tx) =>
      executeCommandIn(
        tx,
        funnelRemovePerson,
        { workspaceId: scope.workspaceId, funnelPersonId: row.id, reason },
        actor,
        meta,
      ),
    );
  };

// ---- Waking ----

const funnelPersonIdOf = (e: EventRow) => str(payloadOf(e)['funnelPersonId']);

export const onPoke: EventHandler = async (ctx) => {
  const scope = scopeOf(ctx.event);
  const id = funnelPersonIdOf(ctx.event);
  if (scope && id) await pokeFunnelPerson(ctx.tx, scope, id);
};

export const onStop: EventHandler = async (ctx) => {
  const id = funnelPersonIdOf(ctx.event);
  if (id) await dropFunnelTick(ctx.tx, id);
};

/** Saved: what changed reaches everyone in it right away. */
export const onFunnelSaved: EventHandler = async (ctx) => {
  const scope = scopeOf(ctx.event);
  const funnelId = str(payloadOf(ctx.event)['funnelId']);
  if (scope && funnelId) await pokeFunnel(ctx.tx, scope, { funnelId });
};

/** Turned on: everyone in it wakes, and the leads already there are taken in when it was asked to. */
export const onTurnedOn: EventHandler = async (ctx) => {
  const scope = scopeOf(ctx.event);
  const p = payloadOf(ctx.event);
  const funnelId = str(p['funnelId']);
  if (!scope || !funnelId) return;
  await pokeFunnel(ctx.tx, scope, { funnelId });
  if (p['addExisting'] === true)
    await scheduleDebouncedJob(ctx.tx, {
      kind: FUNNEL_JOBS.addExisting,
      dedupeKey: addExistingJobKey(funnelId),
      runAt: new Date(),
      payload: { funnelId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    });
};

/** The teammate back on: every funnel that's on carries on. */
export const onTeammateStatus: EventHandler = async (ctx) => {
  const scope = scopeOf(ctx.event);
  const p = payloadOf(ctx.event);
  if (scope && p['from'] === 'off' && p['to'] !== 'off')
    await pokeFunnel(ctx.tx, scope, { all: true });
};

/** `funnel.add_existing`: the open leads already in its pipeline, a batch at a time, each at the stage they're at. */
export const addExistingJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const funnelId = str(ctx.job.payload['funnelId']);
  if (!funnelId) return;
  const skipped = strs(ctx.job.payload['skipped']).slice(0, 500);
  const left = await asWorker(ctx.db, scope, async (tx) => {
    const [funnel] = await tx.select().from(funnels).where(eq(funnels.id, funnelId));
    if (!funnel || funnel.status !== 'on') return 0;
    const def = definitionOf(funnel);
    const open = await rows<{ id: string }>(
      tx,
      sql`select id from app.pipeline_stages where pipeline_id = ${funnel.pipelineId} and kind = 'open'
            and id = any(${uuidArray(def.stages.map((s) => s.stageId))})`,
    );
    if (!open.length) return 0;
    const batch = await rows<{ person_id: string; lead_id: string; stage_id: string }>(
      tx,
      sql`select * from (${waitingLeadsSql(
        funnel.pipelineId,
        open.map((s) => s.id),
      )}) w
          where not (w.person_id = any(${uuidArray(skipped)})) limit ${ADD_EXISTING_BATCH}`,
    );
    const actor = systemActor(scope);
    const meta = workerMeta(null, ctx.job.id);
    for (const b of batch)
      try {
        await tx.transaction((sp) =>
          executeCommandIn(
            sp,
            funnelAddPerson,
            {
              workspaceId: scope.workspaceId,
              funnelId,
              personId: b.person_id,
              leadId: b.lead_id,
              addedBy: 'turn_on',
            },
            actor,
            meta,
          ),
        );
      } catch (e) {
        ctx.log.warn(
          { err: e, funnelId, personId: b.person_id },
          'funnel: couldn’t take in a lead already there',
        );
        skipped.push(b.person_id);
      }
    if (skipped.length)
      await tx.execute(
        sql`update app.scheduled_jobs set payload = payload || ${JSON.stringify({ skipped })}::jsonb
            where id = ${ctx.job.id}`,
      );
    return batch.length;
  });
  if (left === ADD_EXISTING_BATCH) return { rescheduleAt: new Date(Date.now() + 1_000) };
};

/** Event type → the funnel's handler. */
export const FUNNEL_HANDLERS: Readonly<Record<string, EventHandler>> = {
  'lead.created': onLeadCreatedForFunnel,
  'form.submitted': onHappening,
  'form.stopped': onHappening,
  'appointment.booked': onHappening,
  'attendee.added': onHappening,
  'appointment.cancelled': onHappening,
  'attendee.cancelled': onHappening,
  'attendee.removed': onHappening,
  'attendee.joined': onHappening,
  'attendee.attended': onHappening,
  'attendee.no_show': onHappening,
  'message.received': onHappening,
  'conversation.taken_over': pauseOn('taken_over'),
  'conversation.handed_off': pauseOn('handed_off'),
  'conversation.handed_to_ai': onHandedBack,
  'person.opted_out': takeOut('opted_out', 'person'),
  'lead.archived': takeOut('lead_gone', 'lead'),
  'lead.deleted': takeOut('lead_gone', 'lead'),
  'funnel.person_added': onPoke,
  'funnel.stage_reached': onPoke,
  'funnel.resumed_for_person': onPoke,
  'funnel.person_left': onStop,
  'funnel.paused_for_person': onStop,
  'funnel.saved': onFunnelSaved,
  'funnel.turned_on': onTurnedOn,
  'ai_teammate.status_changed': onTeammateStatus,
};

/** The handler map with the funnel's handlers after each event's own (and before the teammate's). */
export function withFunnels(handlers: HandlerMap): HandlerMap {
  const out: Record<string, EventHandler | readonly EventHandler[]> = { ...handlers };
  for (const [type, handler] of Object.entries(FUNNEL_HANDLERS))
    out[type] = [...handlersFor(handlers, type), handler];
  return out;
}
