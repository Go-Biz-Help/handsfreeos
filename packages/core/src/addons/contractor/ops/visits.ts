/**
 * A visit on a job (docs/contractor.md, "Crews and work orders"): an ordinary HandsFreeOS appointment whose record is
 * the job. What its commands and queries share: reading a visit with where it stands, its crew and its checklist's
 * progress; loading one for a change; and starting its work order, with the checklist a new visit starts with.
 * Server-only.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import type { CommandContext } from '../../../kernel/types';
import { JOB_STATUSES as VISIT_STAGES, type JobStatus as VisitStage } from '../../../schemas/job';
import { checklistForNewVisit, type ChecklistProgress } from '../checklists';
import { isOpen } from '../progress';
import { LIMITS } from '../schemas';
import { workOrderItems, workOrders } from '../tables';
import { JOB_STATUS_WORDS, REFUSALS } from '../words';
import { loadJob, madeWhileOpen, settingsOf, type Ctx, type Job } from './common';

/** A visit as the job's page and dispatch read it. */
export type VisitSqlRow = {
  readonly id: string;
  readonly title: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly status: string;
  /** Core's job status for the visit: on the way, started, done. */
  readonly stage: string | null;
  readonly crew: string | null;
  /** Whether it has a work order yet. */
  readonly started: boolean;
  readonly items: number;
  readonly items_done: number;
  readonly items_left: number;
  /** The job's materials needed on it (its own, and the ones for any visit) that aren't all here yet. */
  readonly materials_missing: number;
};

/** Read with `app.appointments a` and VISIT_JOINS. */
export const VISIT_COLUMNS = sql`a.id, a.title, a.starts_at::text, a.ends_at::text, a.status::text,
  cj.status::text as stage, wc.name as crew, (w.appointment_id is not null) as started,
  (select count(*)::int from addon_contractor.work_order_items i where i.appointment_id = a.id) as items,
  (select count(*)::int from addon_contractor.work_order_items i
    where i.appointment_id = a.id and i.done_at is not null) as items_done,
  (select count(*)::int from addon_contractor.work_order_items i
    where i.appointment_id = a.id and i.required and i.done_at is null and i.skipped_at is null) as items_left,
  (select count(*)::int from addon_contractor.materials m
    where m.record_id = a.custom_record_id and (m.appointment_id is null or m.appointment_id = a.id)
      and m.delivered < m.needed) as materials_missing`;

export const VISIT_JOINS = sql`left join app.jobs cj on cj.id = a.job_id
  left join addon_contractor.work_orders w on w.appointment_id = a.id
  left join addon_contractor.crews wc on wc.id = w.crew_id`;

const isStage = (s: string): s is VisitStage => (VISIT_STAGES as readonly string[]).includes(s);

/** Where a visit stands: its crew's own status for it, and a cancelled visit is cancelled whatever that says. */
export function stageOf(v: { readonly status: string; readonly stage: string | null }): VisitStage {
  if (v.status === 'cancelled') return 'cancelled';
  if (v.stage && isStage(v.stage)) return v.stage;
  return v.status === 'completed' ? 'done' : 'scheduled';
}

/** A visit's checklist progress; null while it has no work order. */
export const checklistOf = (v: {
  readonly started: boolean;
  readonly items: number;
  readonly items_done: number;
  readonly items_left: number;
}): ChecklistProgress | null =>
  v.started ? { total: v.items, done: v.items_done, requiredLeft: v.items_left } : null;

/** A visit as its commands need it. */
export interface Visit {
  readonly appointmentId: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: string;
  /** The job it's on: the record it was booked for, when that's one of the add-on's jobs. */
  readonly jobId: string | null;
}

/** Loads a visit of this business; refused as gone when it isn't here. */
export async function loadVisit(ctx: Ctx, appointmentId: string): Promise<Visit> {
  const [a] = await rows<{
    id: string;
    title: string;
    starts_at: string;
    ends_at: string;
    status: string;
    job_id: string | null;
  }>(
    ctx.tx,
    sql`select a.id, a.title, a.starts_at::text, a.ends_at::text, a.status::text, j.record_id as job_id
        from app.appointments a
        left join addon_contractor.jobs j on j.record_id = a.custom_record_id
        where a.id = ${appointmentId} and a.workspace_id = ${ctx.scope.workspaceId!}`,
  );
  if (!a) throw HfosError.notFound(REFUSALS.visitGone);
  return {
    appointmentId: a.id,
    title: a.title,
    startsAt: new Date(a.starts_at),
    endsAt: new Date(a.ends_at),
    status: a.status,
    jobId: a.job_id,
  };
}

export const visitNotOnJob = () =>
  HfosError.rule('contractor_visit_not_on_job', 409, REFUSALS.visitNotOnJob);

export interface StartedWorkOrder {
  readonly visit: Visit;
  readonly job: Job;
  /** false: it had one already. */
  readonly started: boolean;
  /** How many items its checklist started with, when it was started now. */
  readonly items: number;
}

/**
 * A visit's work order, started now if it has none: its checklist begins as the business's starter checklist (or its
 * job's trade's). Safe to run again, and by two people at once: the job's row is locked while it's made.
 */
export async function ensureWorkOrder(
  ctx: CommandContext,
  appointmentId: string,
): Promise<StartedWorkOrder> {
  const visit = await loadVisit(ctx, appointmentId);
  if (!visit.jobId) throw visitNotOnJob();
  const job = await loadJob(ctx, visit.jobId, { lock: true });
  const ws = ctx.scope.workspaceId!;
  const made = await ctx.tx
    .insert(workOrders)
    .values({
      appointmentId,
      workspaceId: ws,
      recordId: job.recordId,
      createdBy: userIdOf(ctx.actor),
    })
    .onConflictDoNothing()
    .returning({ appointmentId: workOrders.appointmentId });
  if (!made.length) return { visit, job, started: false, items: 0 };
  const starters = checklistForNewVisit(await settingsOf(ctx), job.trade).slice(
    0,
    LIMITS.checklist,
  );
  if (starters.length)
    await ctx.tx.insert(workOrderItems).values(
      starters.map((item, position) => ({
        workspaceId: ws,
        appointmentId,
        recordId: job.recordId,
        position,
        label: item.label,
        kind: item.kind,
        required: item.required,
        createdBy: userIdOf(ctx.actor),
      })),
    );
  await ctx.emit({
    type: 'contractor.work_order.started',
    // Filed under the job, so the job's history tells its work orders' story.
    entityType: 'custom_record',
    entityId: job.recordId,
    payload: { appointmentId, jobId: job.recordId, items: starters.length },
  });
  return { visit, job, started: true, items: starters.length };
}

/**
 * A visit's work order for a change: started if it has none, and refused when the visit was cancelled or its job is
 * done, cancelled or archived (a closed job is read-only until it's moved back). `late` lets through what someone
 * did on their phone while the job was still open, which reached HandsFreeOS after it closed.
 */
export async function workOrderForChange(
  ctx: CommandContext,
  appointmentId: string,
  opts: { readonly late?: boolean } = {},
): Promise<StartedWorkOrder> {
  const order = await ensureWorkOrder(ctx, appointmentId);
  if (order.job.archived) throw HfosError.notFound(REFUSALS.jobGone);
  if (order.visit.status === 'cancelled')
    throw HfosError.rule(
      'contractor_visit_cancelled',
      409,
      REFUSALS.visitCancelled(order.visit.title),
    );
  if (!isOpen(order.job.status) && !(opts.late && (await madeWhileOpen(ctx, order.job))))
    throw HfosError.rule(
      'contractor_job_closed',
      409,
      REFUSALS.closedJob(order.job.name, JOB_STATUS_WORDS[order.job.status]),
    );
  return order;
}

/** The work order of the visit a checklist item is on, for a change to that item. */
export async function workOrderOfItem(
  ctx: CommandContext,
  itemId: string,
  opts: { readonly late?: boolean } = {},
): Promise<StartedWorkOrder & { readonly item: typeof workOrderItems.$inferSelect }> {
  const [found] = await ctx.tx
    .select({ appointmentId: workOrderItems.appointmentId })
    .from(workOrderItems)
    .where(
      and(eq(workOrderItems.id, itemId), eq(workOrderItems.workspaceId, ctx.scope.workspaceId!)),
    );
  if (!found) throw HfosError.notFound(REFUSALS.itemGone);
  const order = await workOrderForChange(ctx, found.appointmentId, opts);
  // Read again under the job's lock: someone may have changed or removed it meanwhile.
  const [item] = await ctx.tx.select().from(workOrderItems).where(eq(workOrderItems.id, itemId));
  if (!item) throw HfosError.notFound(REFUSALS.itemGone);
  return { ...order, item };
}
