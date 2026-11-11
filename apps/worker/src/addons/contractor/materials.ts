/**
 * What a visit is still missing (docs/contractor.md, "Materials"; the owner's decision 9). Before each visit on a
 * job, as long before as the business's settings say (a day to start; never when it's 0), the job's lead and the
 * people going are told which of the job's materials aren't all here yet: an alert on Home, their phones and their
 * email. It's looked at again whenever the visit moves or the job's materials change, so the alert says what's true
 * now and goes away once everything is here.
 *
 * - **`contractor.materials_check`**: one job per visit, queued when the visit is booked or moved, for the moment
 *   its alert is due. A visit moved later finds itself early and sleeps until then; one whose alert is up looks
 *   once more when the visit is over, to take it down.
 * - **A material picked from the price list by someone who can't see costs** gets the item's cost here, as the
 *   system (`contractor.material.stamp_cost`), so the job's costing is whole whoever added it.
 * - Safe to run again: the alert's key is the visit's, raising it again only updates it, and clearing one that
 *   isn't there does nothing.
 */
import {
  DEFAULT_MATERIALS_ALERT_HOURS,
  isMissing,
  materialsCheckAt,
  shortOf,
} from '@hfos/core/addons/contractor/materials';
import { materialStampCost } from '@hfos/core/addons/contractor/ops/materials';
import { materialsAlertWords } from '@hfos/core/addons/contractor/words';
import { executeCommand, fmtAt } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';

export const MATERIALS_CHECK = 'contractor.materials_check';

const keyOf = (appointmentId: string) => `materials:${appointmentId}`;
/** A check that comes up to a minute early still counts: neither the clock nor the queue is exact. */
const SLACK_MS = 60_000;
/** The visits on one job looked at after its materials change. */
const VISITS = 25;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;

interface VisitState {
  readonly jobId: string;
  readonly job: string;
  /** The job is open and not archived, and the visit is still to come: there's something to be ready for. */
  readonly live: boolean;
  readonly leadUserId: string | null;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly timeZone: string;
  /** How long before the visit the business wants to hear; 0 is never. */
  readonly hours: number;
}

/** A visit on a job as the check needs it; null when it isn't one, or it's gone. */
async function visitState(
  ctx: AddonScopeContext,
  appointmentId: string,
  now: number,
): Promise<VisitState | null> {
  const [v] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      job_id: string;
      job: string;
      job_status: string;
      archived: boolean;
      lead_user_id: string | null;
      status: string;
      binned: boolean;
      starts_at: string;
      ends_at: string;
      tz: string | null;
      hours: string | null;
    }>(
      tx,
      sql`select j.record_id as job_id, r.name as job, j.status as job_status,
            (r.archived_at is not null) as archived, j.lead_user_id, a.status::text as status,
            (a.bin_item_id is not null) as binned, a.starts_at::text as starts_at, a.ends_at::text as ends_at,
            w.timezone as tz, i.settings ->> 'materialsAlertHours' as hours
          from app.appointments a
          join addon_contractor.jobs j on j.record_id = a.custom_record_id
          join app.custom_records r on r.id = j.record_id
          join app.workspaces w on w.id = a.workspace_id
          left join app.addon_installations i on i.workspace_id = a.workspace_id and i.addon_id = 'contractor'
          where a.id = ${appointmentId} and a.workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  if (!v) return null;
  const hours = v.hours === null ? Number.NaN : Number(v.hours);
  return {
    jobId: v.job_id,
    job: v.job,
    live:
      !v.archived &&
      !v.binned &&
      v.status === 'scheduled' &&
      ['new', 'scheduled', 'in_progress', 'on_hold'].includes(v.job_status) &&
      new Date(v.ends_at).getTime() > now,
    leadUserId: v.lead_user_id,
    startsAt: new Date(v.starts_at).getTime(),
    endsAt: new Date(v.ends_at).getTime(),
    timeZone: v.tz || 'America/Chicago',
    hours: Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_MATERIALS_ALERT_HOURS,
  };
}

/** Queues a visit's check for the moment its alert is due; sooner when one is waiting for later. */
async function arm(ctx: AddonScopeContext, appointmentId: string, at: number): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: MATERIALS_CHECK,
        dedupeKey: keyOf(appointmentId),
        runAt: new Date(at),
        payload: { appointmentId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/**
 * Looks at one visit: tells its people what's missing when its alert is due, and takes the alert down when nothing
 * is (or the visit is over, cancelled or its job closed). Says when to look again: when its alert is due, if
 * that's still ahead, or just after the visit, if its alert is up.
 */
async function check(
  ctx: AddonScopeContext,
  appointmentId: string,
  now: number,
): Promise<{ readonly again: number | null }> {
  const v = await visitState(ctx, appointmentId, now);
  if (!v) return { again: null };
  const due = v.live ? materialsCheckAt(v.startsAt, v.hours, now) : null;
  if (due === null) {
    await clearAddonAlert(ctx, keyOf(appointmentId), v.live ? 'off' : 'gone');
    return { again: null };
  }
  if (due > now + SLACK_MS) {
    // Moved later since it was last told about: nothing to say yet.
    await clearAddonAlert(ctx, keyOf(appointmentId), 'moved');
    return { again: due };
  }
  const { missing, people } = await asWorker(ctx.db, ctx.scope, async (tx) => ({
    missing: (
      await rows<{ name: string; unit_label: string; needed: number; delivered: number }>(
        tx,
        sql`select m.name, m.unit_label, m.needed::float8 as needed, m.delivered::float8 as delivered
            from addon_contractor.materials m
            where m.record_id = ${v.jobId} and m.workspace_id = ${ctx.scope.workspaceId}
              and (m.appointment_id is null or m.appointment_id = ${appointmentId})
            order by m.position, m.created_at, m.id`,
      )
    )
      .map((m) => ({
        name: m.name,
        unitLabel: m.unit_label,
        needed: Number(m.needed),
        delivered: Number(m.delivered),
      }))
      .filter(isMissing),
    people: await rows<{ user_id: string }>(
      tx,
      sql`select s.user_id from app.appointment_staff s
          where s.appointment_id = ${appointmentId} and s.workspace_id = ${ctx.scope.workspaceId} and s.active`,
    ),
  }));
  if (!missing.length) {
    await clearAddonAlert(ctx, keyOf(appointmentId), 'done');
    return { again: null };
  }
  const words = materialsAlertWords({
    job: v.job,
    when: fmtAt(v.startsAt, v.timeZone),
    missing: missing.map((m) => ({ name: m.name, unitLabel: m.unitLabel, short: shortOf(m) })),
  });
  // The job's lead and the people going. With neither, everyone who uses the add-on hears: someone has to.
  const audience = [
    ...new Set([...(v.leadUserId ? [v.leadUserId] : []), ...people.map((p) => p.user_id)]),
  ].slice(0, 50);
  await raiseAddonAlert(ctx, {
    key: keyOf(appointmentId),
    severity: 'attention',
    title: words.title,
    detail: words.detail,
    href: `/a/contractor/jobs/${v.jobId}`,
    permission: 'contractor.use',
    customRecordId: v.jobId,
    audienceUserIds: audience,
    dueAt: new Date(v.startsAt),
  });
  // Once the visit is over there's nothing left to be ready for: look once more then, to take it down.
  return { again: v.endsAt + SLACK_MS };
}

/** `contractor.materials_check`: a visit's alert is due. */
export async function materialsCheckJob(ctx: AddonJobContext): Promise<JobResult> {
  const appointmentId = str(ctx.job.payload['appointmentId']);
  if (!appointmentId) return;
  const { again } = await check(ctx, appointmentId, ctx.now);
  if (again !== null) return { rescheduleAt: new Date(again) };
}

/** A visit was booked or moved: its check waits for the moment its alert is due, or runs now when that's passed. */
export async function visitMoved(ctx: AddonEventContext): Promise<void> {
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  const { again } = await check(ctx, appointmentId, Date.now());
  if (again !== null) await arm(ctx, appointmentId, again);
}

/** A visit was cancelled: nobody needs to be ready for it. */
export async function visitCancelled(ctx: AddonEventContext): Promise<void> {
  if (ctx.event.entityId) await clearAddonAlert(ctx, keyOf(ctx.event.entityId), 'gone');
}

/**
 * A job's materials changed: every visit still to come on it is looked at again, so an alert that's up says what's
 * missing now (or comes down), and a visit whose alert isn't due yet has its check waiting.
 */
export async function materialsChanged(ctx: AddonEventContext): Promise<void> {
  const jobId = str(payloadOf(ctx)['jobId']) ?? ctx.event.entityId;
  if (!jobId) return;
  const now = Date.now();
  const visits = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`select a.id from app.appointments a
          where a.custom_record_id = ${jobId} and a.workspace_id = ${ctx.scope.workspaceId}
            and a.status = 'scheduled' and a.bin_item_id is null and a.ends_at > now()
          order by a.starts_at
          limit ${VISITS}`,
    ),
  );
  for (const visit of visits) {
    const { again } = await check(ctx, visit.id, now);
    if (again !== null) await arm(ctx, visit.id, again);
  }
}

/** `contractor.material.added`: its cost, when the person who added it couldn't see costs; then the visits. */
export async function materialAdded(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const materialId = str(p['materialId']);
  if (materialId && p['needsCost'] === true)
    await executeCommand(
      ctx.db,
      materialStampCost,
      { workspaceId: ctx.scope.workspaceId, materialId },
      ctx.actor,
      ctx.meta,
    );
  await materialsChanged(ctx);
}
