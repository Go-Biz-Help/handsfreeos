/**
 * What a job is costing, and what the jobs made (docs/contractor.md, "Time and job costing"; the owner's decisions
 * 10 and 11). Everything here is for people who may see job costs and profit (`contractor.costs`); row security
 * keeps the tables it reads from everyone else. The math (planned, so far, heading for, profit) is pure, in
 * ../job-costing.ts.
 *
 * - **So far** is added up in the database, the same way for one job and for the profit page: each stretch of work
 *   or travel at what its hour cost (`time_costs`), each material the job has taken at what one costs
 *   (`material_costs`), and the job's other costs. It rounds each line the way ../time.ts and ../materials.ts do, so
 *   a job's cards agree to the cent.
 * - **Other costs** are added and removed, never edited: what a permit or a subcontractor's bill came to. Both ask
 *   first when the AI does them (spending is a person's call).
 * - **The amounts stay off events and timelines:** a line says a cost was added, not what it came to.
 */
import { and, count, desc, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  costJob,
  groupProfit,
  headsUnderMargin,
  periodOf,
  profitTotal,
  type JobCosting,
  type ProfitJob,
} from '../job-costing';
import { contractorAddon } from '../manifest';
import { isOpen, OPEN_STATUSES, todayIn, type JobStatus } from '../progress';
import {
  JobCostingInput,
  JobCostingOutput,
  LIMITS,
  OtherCostAddInput,
  OtherCostOutput,
  OtherCostRemoveInput,
  ProfitInput,
  ProfitOutput,
} from '../schemas';
import { otherCosts } from '../tables';
import { hoursOf } from '../time';
import { isTrade, TRADE_NAMES } from '../trades';
import { CONTRACTOR_WORDS as W, REFUSALS } from '../words';
import { inWorkspace, jobLine, loadJob, relationshipTypeIds, timeZoneOf, type Ctx } from './common';
import { estimatingOf } from './estimates';

const jobPath = (jobId: string) => `a/contractor/jobs/${jobId}`;
const pathOf = (io: unknown) => {
  const jobId = (io as { jobId?: unknown } | null)?.jobId;
  return typeof jobId === 'string' ? jobPath(jobId) : 'a/contractor';
};
const nameIn = (io: unknown) => String((io as { name?: unknown } | null)?.name ?? 'The cost');

// ------------------------------------------------------------------------------------------------ adding it up

/** One job with its budget and everything it has cost, as the database adds it up. */
type CostRow = {
  record_id: string;
  name: string;
  status: JobStatus;
  percent_done: number;
  trade: string | null;
  price_cents: number | null;
  labor_budget: number | null;
  materials_budget: number | null;
  other_budget: number | null;
  labor_hours: number | null;
  labor_cents: number;
  labor_seconds: number;
  uncosted_seconds: number;
  materials_cents: number;
  materials_planned: number;
  uncosted_materials: number;
  other_cents: number;
  customer_id: string | null;
  customer_name: string | null;
  crew_id: string | null;
  crew_name: string | null;
};

/**
 * The jobs `picked` selects (their `record_id`s, in the order wanted), each with its budget and what it has cost.
 * Rounds each stretch and each material to the cent as ../time.ts and ../materials.ts do (`floor(x + 0.5)` on
 * doubles is JavaScript's `Math.round`), so this and the job's Time and Materials cards never differ by a cent.
 */
async function costRows(ctx: Ctx, picked: ReturnType<typeof sql>): Promise<CostRow[]> {
  const ws = ctx.scope.workspaceId!;
  const customerType = (await relationshipTypeIds(ctx)).get('contractor_customer') ?? null;
  return rows<CostRow>(
    ctx.tx,
    sql`with picked as (${picked})
        select j.record_id, r.name, j.status, j.percent_done, j.trade,
          m.price_cents::float8 as price_cents, m.labor_cents::float8 as labor_budget,
          m.materials_cents::float8 as materials_budget, m.other_cents::float8 as other_budget,
          m.labor_hours::float8 as labor_hours,
          labor.cents as labor_cents, labor.seconds as labor_seconds, labor.uncosted as uncosted_seconds,
          mat.taken as materials_cents, mat.planned as materials_planned, mat.uncosted as uncosted_materials,
          other.cents as other_cents,
          cust.id as customer_id, cust.name as customer_name, crew.id as crew_id, crew.name as crew_name
        from picked p
        join addon_contractor.jobs j on j.record_id = p.record_id
        join app.custom_records r on r.id = j.record_id
        left join addon_contractor.money m on m.record_id = j.record_id
        left join lateral (
          select coalesce(sum(s.secs), 0)::float8 as seconds,
            coalesce(sum(s.secs) filter (where s.rate is null), 0)::float8 as uncosted,
            coalesce(sum(floor(s.secs / 3600::float8 * s.rate + 0.5)), 0)::float8 as cents
          from (
            select greatest(0, round(extract(epoch from (coalesce(t.ended_at, now()) - t.started_at))))::float8
                as secs,
              c.rate_cents::float8 as rate
            from addon_contractor.time_entries t
            left join addon_contractor.time_costs c on c.entry_id = t.id
            where t.record_id = j.record_id and t.workspace_id = ${ws} and t.kind <> 'break'
          ) s
        ) labor on true
        left join lateral (
          select coalesce(sum(floor(
                greatest(0, x.delivered - x.returned, x.used + x.wasted)::float8 * c.unit_cost_cents::float8 + 0.5
              )), 0)::float8 as taken,
            coalesce(sum(floor(x.needed::float8 * c.unit_cost_cents::float8 + 0.5)), 0)::float8 as planned,
            (count(*) filter (where c.material_id is null))::int as uncosted
          from addon_contractor.materials x
          left join addon_contractor.material_costs c on c.material_id = x.id
          where x.record_id = j.record_id and x.workspace_id = ${ws}
        ) mat on true
        left join lateral (
          select coalesce(sum(o.amount_cents), 0)::float8 as cents
          from addon_contractor.other_costs o
          where o.record_id = j.record_id and o.workspace_id = ${ws}
        ) other on true
        left join lateral (
          select pe.id,
            coalesce(nullif(btrim(concat_ws(' ', pe.first_name, pe.last_name)), ''), pe.email::text, pe.phone_e164,
              'Customer') as name
          from app.relationships rel
          join app.people pe on pe.id = rel.a_id
          where rel.workspace_id = ${ws} and rel.type_id = ${customerType} and rel.b_id = j.record_id
          order by rel.created_at
          limit 1
        ) cust on true
        left join lateral (
          -- The crew on most of the job's visits (the first by name when two tie).
          select w.crew_id as id, c.name
          from addon_contractor.work_orders w
          join app.appointments a on a.id = w.appointment_id and a.status::text <> 'cancelled'
          join addon_contractor.crews c on c.id = w.crew_id
          where w.record_id = j.record_id and w.workspace_id = ${ws}
          group by w.crew_id, c.name
          order by count(*) desc, c.name, w.crew_id
          limit 1
        ) crew on true
        order by p.position`,
  );
}

const num = (v: number | null) => (v === null ? null : Number(v));

/** A job's costing, from what the database added up. */
const costingOf = (r: CostRow): JobCosting =>
  costJob(
    { status: r.status, percentDone: r.percent_done },
    {
      priceCents: num(r.price_cents),
      laborCents: num(r.labor_budget),
      materialsCents: num(r.materials_budget),
      otherCents: num(r.other_budget),
      laborHours: num(r.labor_hours),
    },
    {
      laborCents: Number(r.labor_cents),
      laborSeconds: Number(r.labor_seconds),
      uncostedSeconds: Number(r.uncosted_seconds),
      materialsCents: Number(r.materials_cents),
      materialsPlannedCents: Number(r.materials_planned),
      uncostedMaterials: Number(r.uncosted_materials),
      otherCents: Number(r.other_cents),
    },
  );

// ------------------------------------------------------------------------------------------------ one job

export const jobCosting = defineAddonQuery(contractorAddon, {
  name: 'contractor.job.costing',
  description:
    'What a job is costing: what was planned, what it has cost so far and what it’s heading for, in labor, materials and other costs, with its hours, the profit that leaves, labor by person and its other costs. For people who may see job costs and profit.',
  input: JobCostingInput,
  output: JobCostingOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_get_job_costing',
    description:
      'A job’s costs against its plan (by job id), in cents: for labor, materials, other costs and the total, what was planned (budgetCents; null when not set), what it has cost so far (actualCents: time tracked at what each hour cost, materials taken at what each costs, and its other costs) and what it’s heading for (headingCents: labor paced by the job’s % done, the rest the larger of plan and spent; a finished job heads for what it cost). Also its labor hours (planned, so far, heading for), its price, the profit planned, so far and heading for with margins in hundredths of a percent, how far over plan it’s heading (overCents), whether it’s heading under the business’s lowest margin (underMargin), time and materials with no cost yet (uncostedHours, uncostedMaterials), labor by person, and each other cost with its cost id.',
    keywords: [
      'job costing',
      'job cost',
      'over budget',
      'estimate vs actual',
      'profit on a job',
      'margin',
      'labor cost',
    ],
  },
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId);
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const ws = ctx.scope.workspaceId!;
    const [[row], people, others, estimating] = await Promise.all([
      costRows(ctx, sql`select ${job.recordId}::uuid as record_id, 0 as position`),
      rows<{ user_id: string | null; name: string | null; seconds: number; cents: number }>(
        ctx.tx,
        sql`select s.user_id, s.name, sum(s.secs)::float8 as seconds,
              coalesce(sum(floor(s.secs / 3600::float8 * s.rate + 0.5)), 0)::float8 as cents
            from (
              select t.user_id, coalesce(nullif(btrim(u.full_name), ''), u.email::text) as name,
                greatest(0, round(extract(epoch from (coalesce(t.ended_at, now()) - t.started_at))))::float8
                  as secs,
                c.rate_cents::float8 as rate
              from addon_contractor.time_entries t
              left join addon_contractor.time_costs c on c.entry_id = t.id
              left join app.users u on u.id = t.user_id
              where t.record_id = ${job.recordId} and t.workspace_id = ${ws} and t.kind <> 'break'
            ) s
            group by s.user_id, s.name
            order by sum(s.secs) desc, s.name`,
      ),
      ctx.tx
        .select()
        .from(otherCosts)
        .where(and(eq(otherCosts.recordId, job.recordId), eq(otherCosts.workspaceId, ws)))
        .orderBy(desc(otherCosts.spentOn), desc(otherCosts.createdAt))
        .limit(LIMITS.otherCosts),
      estimatingOf(ctx),
    ]);
    if (!row) throw HfosError.notFound(REFUSALS.jobGone);
    const c = costingOf(row);
    return {
      jobId: job.recordId,
      name: job.name,
      status: job.status,
      percentDone: job.percentDone,
      ...c,
      minMarginBp: estimating.minMarginBp,
      underMargin: headsUnderMargin(c, estimating.minMarginBp),
      people: people.map((p) => ({
        userId: p.user_id,
        name: p.name ?? W.time.gone,
        hours: hoursOf(Number(p.seconds)),
        costCents: Number(p.cents),
      })),
      otherCosts: others.map((o) => ({
        id: o.id,
        name: o.name,
        amountCents: Number(o.amountCents),
        spentOn: o.spentOn,
        note: o.note,
      })),
      canChange: true,
    };
  },
});

// ------------------------------------------------------------------------------------------------ other costs

export const otherCostAdd = defineAddonCommand(contractorAddon, {
  name: 'contractor.other_cost.add',
  description:
    'Add something else a job cost: a permit, a dump fee, a subcontractor’s bill. It counts in the job’s costs and profit. For people who may see job costs and profit.',
  risk: 2,
  input: OtherCostAddInput,
  output: OtherCostOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_add_job_cost',
    description:
      'Add another cost to a job (jobId, name: what it was for, amountCents; spentOn as YYYY-MM-DD, today when left out; an optional note): a permit, a dump fee, a subcontractor’s bill. Not labor or materials, which come from time tracked and the job’s materials. Asks the person first.',
    autonomy: 'confirm',
    what: 'Add a cost to the job',
    keywords: ['permit', 'fee', 'subcontractor bill', 'expense', 'other cost'],
    outcome: (output) => ({ words: W.costing.otherAdded(nameIn(output)), path: pathOf(output) }),
  },
  emits: ['contractor.other_cost.added'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const ws = ctx.scope.workspaceId!;
    const [has] = await ctx.tx
      .select({ n: count() })
      .from(otherCosts)
      .where(and(eq(otherCosts.recordId, job.recordId), eq(otherCosts.workspaceId, ws)));
    if ((has?.n ?? 0) >= LIMITS.otherCosts)
      throw HfosError.rule(
        'contractor_too_many_other_costs',
        409,
        REFUSALS.tooManyOtherCosts(LIMITS.otherCosts),
      );
    const [made] = await ctx.tx
      .insert(otherCosts)
      .values({
        workspaceId: ws,
        recordId: job.recordId,
        name: input.name,
        amountCents: input.amountCents,
        spentOn: input.spentOn ?? todayIn(await timeZoneOf(ctx)),
        note: input.note || null,
        createdBy: userIdOf(ctx.actor),
      })
      .returning({ id: otherCosts.id });
    // What it came to stays off the event and the timeline: only people with job-cost access see amounts.
    const eventId = await ctx.emit({
      type: 'contractor.other_cost.added',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { jobId: job.recordId, costId: made!.id },
    });
    await jobLine(ctx, job.recordId, `added a cost: ${input.name}`, { eventId });
    return { costId: made!.id, jobId: job.recordId, name: input.name };
  },
});

export const otherCostRemove = defineAddonCommand(contractorAddon, {
  name: 'contractor.other_cost.remove',
  description:
    'Take one of a job’s other costs off it. It stops counting in the job’s costs and profit. For people who may see job costs and profit.',
  risk: 2,
  input: OtherCostRemoveInput,
  output: OtherCostOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_remove_job_cost',
    description:
      'Take one of a job’s other costs off it (costId, from contractor_get_job_costing). To change what one came to, remove it and add it again. Asks the person first.',
    autonomy: 'confirm',
    what: 'Remove a cost from the job',
    outcome: (output) => ({ words: W.costing.otherRemoved(nameIn(output)), path: pathOf(output) }),
  },
  emits: ['contractor.other_cost.removed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const mine = and(eq(otherCosts.id, input.costId), eq(otherCosts.workspaceId, ws));
    const [found] = await ctx.tx.select().from(otherCosts).where(mine);
    if (!found) throw HfosError.notFound(REFUSALS.otherCostGone);
    const job = await loadJob(ctx, found.recordId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    // Someone else may have removed it while this waited for the job.
    const gone = await ctx.tx.delete(otherCosts).where(mine).returning({ id: otherCosts.id });
    if (!gone.length) throw HfosError.notFound(REFUSALS.otherCostGone);
    const eventId = await ctx.emit({
      type: 'contractor.other_cost.removed',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { jobId: job.recordId, costId: found.id },
    });
    await jobLine(ctx, job.recordId, `removed a cost: ${found.name}`, { eventId });
    return { costId: found.id, jobId: job.recordId, name: found.name };
  },
});

// ------------------------------------------------------------------------------------------------ the profit page

export const profit = defineAddonQuery(contractorAddon, {
  name: 'contractor.profit',
  description:
    'What the jobs made: price, cost, profit and margin for the jobs done in a stretch of time (or the open jobs, at what they’re heading for), split by job, customer, crew or service. For people who may see job costs and profit.',
  input: ProfitInput,
  output: ProfitOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_get_profit',
    description:
      'Profit across jobs, in cents. period picks the jobs: done this month (month, the default), last_month, quarter, year, all (every done job), or open (jobs not finished, counted at what they’re heading for). by splits them: job (the default), customer, crew (the crew on most of a job’s visits) or trade (the kind of work). Each row has its key (the job’s, customer’s or crew’s id, or the trade), name, how many jobs, price, cost (labor from time tracked, materials taken and other costs), profit, margin in hundredths of a percent and labor hours, the most profit first; total is all of them together. Cancelled jobs aren’t counted. from and to are the days the period covers in the business’s time zone.',
    keywords: [
      'profit',
      'profitability',
      'margin',
      'most profitable',
      'losing money',
      'profit by crew',
      'profit by customer',
    ],
  },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const max = LIMITS.profitJobs;
    const timeZone = await timeZoneOf(ctx);
    const days = periodOf(input.period, todayIn(timeZone));
    const which =
      input.period === 'open'
        ? sql`j.status = any(${`{${OPEN_STATUSES.join(',')}}`}::text[])`
        : days
          ? sql`j.status = 'done'
              and j.done_at >= (${days.from}::date::timestamp at time zone ${timeZone})
              and j.done_at < ((${days.to}::date + 1)::timestamp at time zone ${timeZone})`
          : sql`j.status = 'done'`;
    // The newest first, so when there are too many to count it's the oldest that are left out.
    const [list, estimating] = await Promise.all([
      costRows(
        ctx,
        sql`select j.record_id,
              row_number() over (order by coalesce(j.done_at, j.created_at) desc, j.record_id) as position
            from addon_contractor.jobs j
            join app.custom_records r on r.id = j.record_id
            where j.workspace_id = ${ws} and r.archived_at is null and ${which}
            order by position
            limit ${max + 1}`,
      ),
      estimatingOf(ctx),
    ]);
    const jobs: ProfitJob[] = list.slice(0, max).map((r) => {
      const c = costingOf(r);
      const open = isOpen(r.status);
      return {
        jobId: r.record_id,
        name: r.name,
        priceCents: c.priceCents ?? 0,
        // A done job counts at what it cost; an open one at where it's heading.
        costCents: c.total.headingCents,
        laborSeconds: open ? Math.round(c.hours.heading * 3600) : Number(r.labor_seconds),
        customer:
          r.customer_id && r.customer_name ? { id: r.customer_id, name: r.customer_name } : null,
        crew: r.crew_id && r.crew_name ? { id: r.crew_id, name: r.crew_name } : null,
        trade: r.trade,
      };
    });
    const split = groupProfit(jobs, input.by).map((row) =>
      // A trade is kept by its key; the page shows its name.
      input.by === 'trade' && isTrade(row.key) ? { ...row, name: TRADE_NAMES[row.key] } : row,
    );
    return {
      period: input.period,
      by: input.by,
      from: days?.from ?? null,
      to: days?.to ?? null,
      total: profitTotal(jobs),
      rows: split,
      minMarginBp: estimating.minMarginBp,
      truncated: list.length > max,
    };
  },
});
