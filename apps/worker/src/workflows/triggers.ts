/**
 * Schedules and date triggers.
 *
 * A scheduled workflow has one `workflow.schedule` job that re-arms itself for the next occurrence (weekly or
 * monthly, in the workspace's time zone; there is no cron). At an occurrence it enrols the audience a page of
 * people at a time, resumable (workflow_schedules.page_cursor) and deduped per occurrence, with start times
 * spread over a minute. A paused workflow skips occurrences rather than queueing them.
 *
 * A date trigger ("2 hours after the appointment ends") arms one `workflow.date` job per record whenever an
 * event sets or moves its anchor. When the job runs it reads the anchor again: moved later, it waits again;
 * gone or cancelled, it's dropped; otherwise it enrols the record's people, once per anchor time.
 *
 * A trigger whose time already passed when its anchor was set doesn't start, unless it passed only because the change
 * that set the anchor reached HandsFreeOS late (made on a phone with no signal, late.ts): then it starts at once,
 * marked late, so its steps that would contact the customer wait while it's more than 30 minutes behind.
 */
import {
  nextOccurrence,
  scheduleJob,
  workspaceZone,
  type AnyConditionGroup,
  type DateAnchorKey,
  type WorkflowDefinition,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import type { EventRow } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { tenantOf, type TenantScope } from '../services';
import { ANCHOR_EVENTS, anchorRecord, readAnchor, type AnchorRecord } from './anchors';
import { BATCH, dateJobKey, EARLY_MS, JOB, scheduleJobKey, SPREAD_MS } from './constants';
import { RunData } from './data';
import { readableVersionDefinition, versionDefinition } from './defs';
import { enrol, type LiveRoom } from './enrol';
import { lateDateStart, lateOf } from './late';
import { dateOffsetInstant } from './waits';

/** A date trigger whose time passed this long before its anchor was set doesn't fire (late changes aside). */
const TOO_LATE_MS = 5 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** A late start's own job, beside the record's usual one: the enrolment is once per anchor time either way. */
const lateDateJobKey = (workflowId: string, recordId: string, at: number): string =>
  `${dateJobKey(workflowId, recordId)}:late:${iso(at)}`;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface Subject {
  readonly personId: string;
  readonly leadId: string | null;
  readonly appointmentId: string | null;
  readonly conversationId: string | null;
}

/** The people a record's run is for: an appointment's customers, a lead's person, the person. */
async function subjectsForRecord(
  tx: Tx,
  workspaceId: string,
  record: AnchorRecord,
  id: string,
): Promise<Subject[]> {
  if (record === 'appointment') {
    const list = await rows<{ person_id: string }>(
      tx,
      sql`select distinct person_id from app.appointment_attendees
          where appointment_id = ${id} and workspace_id = ${workspaceId} and status in ('booked', 'attended')`,
    );
    return list.map((r) => ({
      personId: r.person_id,
      leadId: null,
      appointmentId: id,
      conversationId: null,
    }));
  }
  if (record === 'lead') {
    const [l] = await rows<{ person_id: string | null }>(
      tx,
      sql`select person_id from app.leads where id = ${id} and workspace_id = ${workspaceId}`,
    );
    return l?.person_id
      ? [{ personId: l.person_id, leadId: id, appointmentId: null, conversationId: null }]
      : [];
  }
  return [{ personId: id, leadId: null, appointmentId: null, conversationId: null }];
}

/** The record an anchor-setting event is about. */
function recordOf(e: EventRow, record: AnchorRecord): string | null {
  if (e.entityType === record && e.entityId) return e.entityId;
  const p = isRecord(e.payload) ? e.payload : {};
  const id = p[`${record}Id`];
  return typeof id === 'string' ? id : null;
}

/** An event set or moved a date some active workflow counts from: arm (or pull forward) its job. */
export async function armDateTriggers(
  tx: Tx,
  scope: TenantScope,
  e: EventRow,
  now: number,
): Promise<void> {
  const anchors = ANCHOR_EVENTS[e.eventType];
  if (!anchors?.length) return;
  const flows = await rows<{ id: string; version: string }>(
    tx,
    sql`select id, active_version_id as version from app.workflows
        where workspace_id = ${scope.workspaceId} and status = 'active' and trigger_kind = 'date'
          and active_version_id is not null
          and trigger_event in (${sql.join(
            anchors.map((a) => sql`${a}`),
            sql`, `,
          )})`,
  );
  if (!flows.length) return;
  const tz = await workspaceZone(tx, scope.workspaceId);
  for (const f of flows) {
    // One workflow that can't be read never stops the event it rides on, nor the others (WF-3).
    const def = await readableVersionDefinition(tx, f.version);
    if (!def) continue;
    const t = def.trigger;
    if (t.kind !== 'date' || !anchors.includes(t.anchor)) continue;
    const recordId = recordOf(e, anchorRecord(t.anchor));
    const at = await readAnchor(tx, scope.workspaceId, t.anchor, recordId);
    if (!recordId || at === null) continue;
    const fire = dateOffsetInstant(at, t.offset, t.at, tz);
    if (fire < now - TOO_LATE_MS) {
      // Passed only because the change that set the date arrived late: it starts now, and knows how far behind.
      const late = lateDateStart(e, fire, now, TOO_LATE_MS);
      if (!late) continue;
      await scheduleJob(tx, {
        kind: JOB.date,
        dedupeKey: lateDateJobKey(f.id, recordId, at),
        runAt: new Date(now),
        payload: { workflowId: f.id, recordId, late },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      });
      continue;
    }
    await scheduleJob(
      tx,
      {
        kind: JOB.date,
        dedupeKey: dateJobKey(f.id, recordId),
        runAt: new Date(fire),
        payload: { workflowId: f.id, recordId },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      },
      { pullEarlier: true },
    );
  }
}

interface FlowRow extends Record<string, unknown> {
  id: string;
  name: string;
  status: string;
  version: string | null;
}

async function flow(tx: Tx, workspaceId: string, id: string): Promise<FlowRow | null> {
  const [w] = await rows<FlowRow>(
    tx,
    sql`select id, name, status::text as status, active_version_id as version from app.workflows
        where id = ${id} and workspace_id = ${workspaceId}`,
  );
  return w ?? null;
}

/** A date trigger's time came for one record. */
export const workflowDateJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const workflowId = String(ctx.job.payload['workflowId'] ?? '');
  const recordId = String(ctx.job.payload['recordId'] ?? '');
  // Armed late, because the change that set the date reached HandsFreeOS late (armDateTriggers).
  const lateFrom = ctx.job.payload['late'];
  return asWorker(ctx.db, scope, async (tx) => {
    const wf = await flow(tx, scope.workspaceId, workflowId);
    // Paused or archived: ignored, not queued for later.
    if (!wf || wf.status !== 'active' || !wf.version) return;
    const def = await versionDefinition(tx, wf.version);
    const t = def.trigger;
    if (t.kind !== 'date') return;
    const tz = await workspaceZone(tx, scope.workspaceId);
    const at = await readAnchor(tx, scope.workspaceId, t.anchor, recordId);
    if (at === null) return;
    const fire = dateOffsetInstant(at, t.offset, t.at, tz);
    if (fire > ctx.now + EARLY_MS) return { rescheduleAt: new Date(fire) };
    // How far behind a late start is now; a run that's caught up (the date moved on since) isn't late.
    const late = isRecord(lateFrom)
      ? lateOf({ _late: { ...lateFrom, ms: ctx.now - fire, happenedAt: iso(fire) } })
      : null;
    const liveRoom: LiveRoom = { left: null };
    for (const sub of await subjectsForRecord(
      tx,
      scope.workspaceId,
      anchorRecord(t.anchor),
      recordId,
    )) {
      const data = new RunData(
        tx,
        { workspaceId: scope.workspaceId, ...sub },
        { timeZone: tz, webUrl: ctx.webUrl, workflowName: wf.name, context: {} },
      );
      if (!(await data.passes(t.filters as AnyConditionGroup, ctx.now))) continue;
      await enrol(tx, {
        scope,
        workflow: { id: wf.id, name: wf.name },
        versionId: wf.version,
        def,
        ...sub,
        dedupeKey: `date:${t.anchor}:${recordId}:${iso(at)}:${sub.personId}`,
        context: {
          trigger: { event: 'date', anchor: t.anchor, anchorAt: iso(at) },
          ...(late ? { _late: late } : {}),
        },
        log: ctx.log,
        liveRoom,
      });
    }
  });
};

/** Publishing a scheduled workflow (re-)arms its next occurrence; any other trigger clears it. */
export async function armSchedule(
  tx: Tx,
  scope: TenantScope,
  workflowId: string,
  versionId: string,
  def: WorkflowDefinition,
  now: number,
): Promise<void> {
  const t = def.trigger;
  if (t.kind !== 'schedule') {
    await tx.execute(
      sql`update app.workflow_schedules set next_run_at = null, page_cursor = null where workflow_id = ${workflowId}`,
    );
    return;
  }
  const next = nextOccurrence(t.cadence, now, await workspaceZone(tx, scope.workspaceId));
  await tx.execute(
    sql`insert into app.workflow_schedules (workspace_id, workflow_id, version_id, next_run_at)
        values (${scope.workspaceId}, ${workflowId}, ${versionId}, ${iso(next)}::timestamptz)
        on conflict (workflow_id) do update
          set version_id = excluded.version_id, next_run_at = excluded.next_run_at, page_cursor = null`,
  );
  await scheduleJob(
    tx,
    {
      kind: JOB.schedule,
      dedupeKey: scheduleJobKey(workflowId),
      runAt: new Date(next),
      payload: { workflowId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
}

/** A scheduled workflow's occurrence: enrol one page of its audience, then the next page or occurrence. */
export const workflowScheduleJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const workflowId = String(ctx.job.payload['workflowId'] ?? '');
  return asWorker(ctx.db, scope, async (tx) => {
    const wf = await flow(tx, scope.workspaceId, workflowId);
    if (!wf || !wf.version || (wf.status !== 'active' && wf.status !== 'paused')) return;
    const def = await versionDefinition(tx, wf.version);
    const t = def.trigger;
    if (t.kind !== 'schedule') return;
    const tz = await workspaceZone(tx, scope.workspaceId);
    const [sched] = await rows<{ next_run_at: string | null; page_cursor: string | null }>(
      tx,
      sql`select next_run_at, page_cursor from app.workflow_schedules where workflow_id = ${workflowId}`,
    );
    const occurrence = sched?.next_run_at
      ? new Date(sched.next_run_at).getTime()
      : nextOccurrence(t.cadence, ctx.now, tz);
    if (!sched) {
      await tx.execute(
        sql`insert into app.workflow_schedules (workspace_id, workflow_id, version_id, next_run_at)
            values (${scope.workspaceId}, ${workflowId}, ${wf.version}, ${iso(occurrence)}::timestamptz)
            on conflict (workflow_id) do nothing`,
      );
    }
    if (occurrence > ctx.now + EARLY_MS) return { rescheduleAt: new Date(occurrence) };
    const next = nextOccurrence(t.cadence, occurrence, tz);
    const finish = async () => {
      await tx.execute(
        sql`update app.workflow_schedules
            set last_run_at = now(), last_occurrence_at = ${iso(occurrence)}::timestamptz, page_cursor = null,
              next_run_at = ${iso(next)}::timestamptz, version_id = ${wf.version}
            where workflow_id = ${workflowId}`,
      );
      return { rescheduleAt: new Date(next) };
    };
    if (wf.status === 'paused') return finish();
    const cursor = sched?.page_cursor ?? null;
    const page = await rows<{ id: string }>(
      tx,
      sql`select id from app.people
          where workspace_id = ${scope.workspaceId} and archived_at is null
            ${cursor ? sql`and id > ${cursor}::uuid` : sql``}
          order by id limit ${BATCH}`,
    );
    const stamp = iso(occurrence);
    const liveRoom: LiveRoom = { left: null };
    for (const [i, p] of page.entries()) {
      const data = new RunData(
        tx,
        {
          workspaceId: scope.workspaceId,
          personId: p.id,
          leadId: null,
          appointmentId: null,
          conversationId: null,
        },
        { timeZone: tz, webUrl: ctx.webUrl, workflowName: wf.name, context: {} },
      );
      if (!(await data.passes(t.audience as AnyConditionGroup, ctx.now))) continue;
      await enrol(tx, {
        scope,
        workflow: { id: wf.id, name: wf.name },
        versionId: wf.version,
        def,
        personId: p.id,
        dedupeKey: `sched:${stamp}:${p.id}`,
        startAt: new Date(Date.now() + Math.floor((i * SPREAD_MS) / BATCH)),
        context: { trigger: { event: 'schedule', occurrence: stamp } },
        log: ctx.log as Logger,
        liveRoom,
      });
    }
    if (page.length === BATCH) {
      await tx.execute(
        sql`update app.workflow_schedules set page_cursor = ${page.at(-1)!.id} where workflow_id = ${workflowId}`,
      );
      return { rescheduleAt: new Date() };
    }
    return finish();
  });
};

export type { DateAnchorKey };
