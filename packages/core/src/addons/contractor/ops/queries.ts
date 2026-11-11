/**
 * What Contractor Operations' pages read (docs/contractor.md): the overview (settings, counts, people), the jobs
 * list, one job whole, and the business's properties. Everything is read as the person asking, under row security:
 * a job's money only reaches people with `contractor.costs` (its table's own policy), and nothing here trusts the
 * screen to hide it. A job's visits are read the way dispatch reads them (./visits.ts).
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { scopeCan } from '../../../kernel/execute';
import type { Permission } from '../../../permissions';
import { defineAddonQuery } from '../../server';
import { contractorAddon } from '../manifest';
import {
  budgetTotal,
  daysBetween,
  isOpen,
  plannedProfit,
  todayIn,
  type JobStatus,
} from '../progress';
import {
  ContractorSettingsSchema,
  InWorkspace,
  JobDetail,
  JobGetInput,
  JobListInput,
  JobListOutput,
  LIMITS,
  OverviewOutput,
  PropertyListInput,
  PropertyListOutput,
  type JobRow,
} from '../schemas';
import { isTrade } from '../trades';
import { REFUSALS } from '../words';
import {
  inWorkspace,
  kindIds,
  relationshipTypeIds,
  settingsOf,
  timeZoneOf,
  type Ctx,
} from './common';
import { estimatingOf } from './estimates';
import { checklistOf, stageOf, VISIT_COLUMNS, VISIT_JOINS, type VisitSqlRow } from './visits';

type JobSqlRow = {
  id: string;
  name: string;
  archived: boolean;
  kind: JobRow['kind'];
  status: JobStatus;
  status_at: string;
  status_reason: string | null;
  trade: string | null;
  percent_done: number;
  starts_on: string | null;
  due_on: string | null;
  lead_user_id: string | null;
  lead_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  property_id: string | null;
  property_name: string | null;
  phases_count: number;
  phases_done: number;
  next_visit_at: string | null;
  updated_at: string;
  details: string | null;
  done_at: string | null;
};

/** The select every job read shares: the job, its record, lead, customer, property, phases and next visit. */
export async function jobsSql(
  ctx: Ctx,
  where: ReturnType<typeof sql>,
  limit: number,
): Promise<JobSqlRow[]> {
  const ws = ctx.scope.workspaceId!;
  const types = await relationshipTypeIds(ctx);
  const customerType = types.get('contractor_customer') ?? null;
  const siteType = types.get('contractor_site') ?? null;
  return rows<JobSqlRow>(
    ctx.tx,
    sql`select j.record_id as id, r.name, r.archived_at is not null as archived, j.kind, j.status,
          j.status_at::text, j.status_reason, j.trade, j.percent_done, j.starts_on::text, j.due_on::text,
          j.lead_user_id, coalesce(nullif(btrim(lu.full_name), ''), lu.email::text) as lead_name,
          c.person_id as customer_id, c.name as customer_name, s.record_id as property_id, s.name as property_name,
          (select count(*)::int from addon_contractor.phases p where p.record_id = j.record_id) as phases_count,
          (select count(*)::int from addon_contractor.phases p where p.record_id = j.record_id and p.status = 'done')
            as phases_done,
          (select min(a.starts_at)::text from app.appointments a
            where a.custom_record_id = j.record_id and a.workspace_id = ${ws} and a.status <> 'cancelled'
              and a.ends_at > now()) as next_visit_at,
          j.updated_at::text, j.details, j.done_at::text
        from addon_contractor.jobs j
        join app.custom_records r on r.id = j.record_id
        left join app.users lu on lu.id = j.lead_user_id
        left join lateral (
          select p.id as person_id,
            coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.email::text, p.phone_e164, 'Customer') as name
          from app.relationships x join app.people p on p.id = x.a_id
          where x.type_id = ${customerType} and x.b_id = j.record_id
          order by x.created_at limit 1
        ) c on true
        left join lateral (
          select pr.id as record_id, pr.name
          from app.relationships x join app.custom_records pr on pr.id = x.b_id
          where x.type_id = ${siteType} and x.a_id = j.record_id
          order by x.created_at limit 1
        ) s on true
        where j.workspace_id = ${ws} and ${where}
        order by (j.status in ('done', 'cancelled')), j.due_on nulls last, j.updated_at desc
        limit ${limit}`,
  );
}

export function rowOut(r: JobSqlRow, today: string): JobRow {
  const open = isOpen(r.status);
  const late = open && r.due_on && r.due_on < today ? daysBetween(r.due_on, today) : null;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    statusAt: new Date(r.status_at).toISOString(),
    statusReason: r.status_reason,
    trade: r.trade && isTrade(r.trade) ? r.trade : null,
    percentDone: r.percent_done,
    startsOn: r.starts_on,
    dueOn: r.due_on,
    daysLate: late,
    lead: r.lead_user_id && r.lead_name ? { userId: r.lead_user_id, name: r.lead_name } : null,
    customer: r.customer_id
      ? { personId: r.customer_id, name: r.customer_name ?? 'Customer' }
      : null,
    property: r.property_id ? { recordId: r.property_id, name: r.property_name ?? '' } : null,
    phases: { count: r.phases_count, done: r.phases_done },
    nextVisitAt: r.next_visit_at ? new Date(r.next_visit_at).toISOString() : null,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/** The people who may use the add-on here (everyone on the team when the person asking can't see who holds what). */
async function peopleOf(ctx: Ctx) {
  const ws = ctx.scope.workspaceId!;
  const held = await rows<{ user_id: string; role: string; permissions: string[] | null }>(
    ctx.tx,
    sql`select user_id, role, permissions from private.workspace_member_permissions(${ws}::uuid)`,
  );
  const may = held.length
    ? new Set(
        held
          .filter((h) => h.role === 'owner' || (h.permissions ?? []).includes('contractor.use'))
          .map((h) => h.user_id),
      )
    : null;
  const list = await rows<{ user_id: string; name: string }>(
    ctx.tx,
    sql`select m.user_id, coalesce(nullif(btrim(u.full_name), ''), u.email::text) as name
        from app.workspace_memberships m join app.users u on u.id = m.user_id
        where m.workspace_id = ${ws}
        order by 2`,
  );
  return list
    .filter((p) => !may || may.has(p.user_id))
    .map((p) => ({ userId: p.user_id, name: p.name }));
}

export const overview = defineAddonQuery(contractorAddon, {
  name: 'contractor.overview',
  description:
    'Contractor Operations here: its settings (trades, phases for a new project, the checklist a new visit starts with), how many jobs are open, late, on hold and done this month, who can be on a job, how the business estimates (for people who may see job costs), and how many estimates wait for this person’s OK.',
  input: InWorkspace,
  output: OverviewOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_overview',
    description:
      'Contractor Operations’ settings (the business’s trades, the phases a new project starts with and the checklist a new visit’s work order starts with), counts of open, late, on-hold and done-this-month jobs, the team members who can be put on jobs (with their user ids), the estimating rules (lowest margin, starting markup, labor’s hourly price and cost; only for people who may see job costs), and how many estimates are waiting for this person’s OK.',
  },
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const today = todayIn(await timeZoneOf(ctx));
    const [c] = await rows<{ open: number; late: number; on_hold: number; done_month: number }>(
      ctx.tx,
      sql`select
            count(*) filter (where j.status in ('new', 'scheduled', 'in_progress', 'on_hold'))::int as open,
            count(*) filter (where j.status in ('new', 'scheduled', 'in_progress', 'on_hold')
              and j.due_on < ${today}::date)::int as late,
            count(*) filter (where j.status = 'on_hold')::int as on_hold,
            count(*) filter (where j.status = 'done'
              and j.done_at >= date_trunc('month', ${today}::date))::int as done_month
          from addon_contractor.jobs j join app.custom_records r on r.id = j.record_id
          where j.workspace_id = ${ws} and r.archived_at is null`,
    );
    const stored = await settingsOf(ctx);
    const settings = ContractorSettingsSchema.safeParse(stored);
    const costs = scopeCan(ctx.scope, 'contractor.costs' as Permission);
    const approve = scopeCan(ctx.scope, 'contractor.approve' as Permission);
    // Drafts someone asked an OK for: only the people who can give it are counted any.
    const [waiting] = approve
      ? await rows<{ n: number }>(
          ctx.tx,
          sql`select count(*)::int as n
              from addon_contractor.estimates x join app.estimates e on e.id = x.estimate_id
              where x.workspace_id = ${ws} and x.asked_at is not null and e.status = 'draft'`,
        )
      : [];
    return {
      name: contractorAddon.name,
      settings: settings.success ? settings.data : { trades: [], phases: [], checklist: [] },
      may: {
        manage: scopeCan(ctx.scope, 'contractor.manage' as Permission),
        costs,
        assign: scopeCan(ctx.scope, 'records.assign'),
        approve,
        skipChecks: scopeCan(ctx.scope, 'contractor.skip_checks' as Permission),
      },
      estimating: costs ? await estimatingOf(ctx) : null,
      estimatesWaitingOk: waiting?.n ?? 0,
      counts: {
        open: c?.open ?? 0,
        late: c?.late ?? 0,
        onHold: c?.on_hold ?? 0,
        doneThisMonth: c?.done_month ?? 0,
      },
      today,
      kinds: await kindIds(ctx),
      people: await peopleOf(ctx),
    };
  },
});

export const jobList = defineAddonQuery(contractorAddon, {
  name: 'contractor.job.list',
  description:
    'The business’s jobs, open ones first by deadline: all, mine (I lead it or am on its team) or late, by status, by customer or property, or by words in its name, customer or property.',
  input: JobListInput,
  output: JobListOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_list_jobs',
    description:
      'List jobs (filter: all, mine or late; status; includeClosed for done and cancelled ones; customerPersonId; propertyId; search words in its name, customer or property). Each with its status, % done, deadline, days late, lead, customer, property, phases and next visit.',
    keywords: ['jobs', 'projects', 'late jobs', 'job board'],
  },
  async handler(ctx, input) {
    const today = todayIn(await timeZoneOf(ctx));
    const me = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    const types = await relationshipTypeIds(ctx);
    const parts = [sql`r.archived_at is null`];
    if (!input.includeClosed && !input.status?.length)
      parts.push(sql`j.status in ('new', 'scheduled', 'in_progress', 'on_hold')`);
    if (input.status?.length) parts.push(sql`j.status = any(${input.status}::text[])`);
    if (input.filter === 'mine')
      parts.push(
        sql`(j.lead_user_id = ${me} or exists (select 1 from addon_contractor.team t
              where t.record_id = j.record_id and t.user_id = ${me}))`,
      );
    if (input.filter === 'late')
      parts.push(
        sql`j.status in ('new', 'scheduled', 'in_progress', 'on_hold') and j.due_on < ${today}::date`,
      );
    if (input.customerPersonId)
      parts.push(
        sql`exists (select 1 from app.relationships x where x.type_id = ${types.get('contractor_customer') ?? null}
              and x.b_id = j.record_id and x.a_id = ${input.customerPersonId})`,
      );
    if (input.propertyId)
      parts.push(
        sql`exists (select 1 from app.relationships x where x.type_id = ${types.get('contractor_site') ?? null}
              and x.a_id = j.record_id and x.b_id = ${input.propertyId})`,
      );
    const where = sql.join(parts, sql` and `);
    let list = await jobsSql(ctx, where, LIMITS.list + 1);
    if (input.search) {
      const words = input.search.toLowerCase().split(/\s+/).filter(Boolean);
      list = list.filter((r) => {
        const hay = [r.name, r.customer_name, r.property_name].join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    return {
      jobs: list.slice(0, LIMITS.list).map((r) => rowOut(r, today)),
      truncated: list.length > LIMITS.list,
    };
  },
});

export const jobGet = defineAddonQuery(contractorAddon, {
  name: 'contractor.job.get',
  description:
    'One job whole: its status, customer, property, trade, dates, work to do, lead and team, phases, visits, and (for people who may see job costs) its price and budget.',
  input: JobGetInput,
  output: JobDetail,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_get_job',
    description:
      'One job whole: status, customer, property, trade, dates, work to do, lead and team (with user ids), phases (with phase ids, status, % done and dates), visits, and its price and budget when the person may see job costs.',
  },
  async handler(ctx, input) {
    const today = todayIn(await timeZoneOf(ctx));
    const [r] = await jobsSql(ctx, sql`j.record_id = ${input.jobId}`, 1);
    if (!r) throw HfosError.notFound(REFUSALS.jobGone);
    const ws = ctx.scope.workspaceId!;
    const [teamRows, phaseRows, visitRows, moneyRows, kinds] = await Promise.all([
      rows<{ user_id: string; name: string }>(
        ctx.tx,
        sql`select t.user_id, coalesce(nullif(btrim(u.full_name), ''), u.email::text) as name
            from addon_contractor.team t join app.users u on u.id = t.user_id
            where t.record_id = ${input.jobId} order by t.created_at`,
      ),
      rows<{
        id: string;
        name: string;
        position: number;
        status: 'not_started' | 'in_progress' | 'done';
        percent_done: number;
        starts_on: string | null;
        due_on: string | null;
        done_at: string | null;
      }>(
        ctx.tx,
        sql`select id, name, position, status, percent_done, starts_on::text, due_on::text, done_at::text
            from addon_contractor.phases where record_id = ${input.jobId} order by position, created_at`,
      ),
      rows<VisitSqlRow>(
        ctx.tx,
        sql`select ${VISIT_COLUMNS}
            from app.appointments a
            ${VISIT_JOINS}
            where a.custom_record_id = ${input.jobId} and a.workspace_id = ${ws}
            order by a.starts_at desc limit 50`,
      ),
      // Row security keeps these from anyone without `contractor.costs`: they read none.
      scopeCan(ctx.scope, 'contractor.costs' as Permission)
        ? rows<{
            price_cents: string | null;
            labor_cents: string | null;
            materials_cents: string | null;
            other_cents: string | null;
            labor_hours: string | null;
          }>(
            ctx.tx,
            sql`select price_cents, labor_cents, materials_cents, other_cents, labor_hours
                from addon_contractor.money where record_id = ${input.jobId}`,
          )
        : Promise.resolve(null),
      kindIds(ctx),
    ]);
    const num = (v: string | null | undefined) =>
      v === null || v === undefined ? null : Number(v);
    const m = moneyRows ? (moneyRows[0] ?? null) : undefined;
    const budget = {
      laborCents: num(m?.labor_cents),
      materialsCents: num(m?.materials_cents),
      otherCents: num(m?.other_cents),
    };
    const profit = plannedProfit(num(m?.price_cents), budget);
    return {
      ...rowOut(r, today),
      details: r.details,
      doneAt: r.done_at ? new Date(r.done_at).toISOString() : null,
      archived: r.archived,
      team: teamRows.map((t) => ({ userId: t.user_id, name: t.name })),
      phaseList: phaseRows.map((p) => ({
        id: p.id,
        name: p.name,
        position: p.position,
        status: p.status,
        percentDone: p.status === 'done' ? 100 : p.percent_done,
        startsOn: p.starts_on,
        dueOn: p.due_on,
        doneAt: p.done_at ? new Date(p.done_at).toISOString() : null,
        daysLate:
          p.status !== 'done' && p.due_on && p.due_on < today ? daysBetween(p.due_on, today) : null,
      })),
      visits: visitRows.map((v) => ({
        appointmentId: v.id,
        title: v.title,
        startsAt: new Date(v.starts_at).toISOString(),
        endsAt: new Date(v.ends_at).toISOString(),
        status: v.status,
        stage: stageOf(v),
        crew: v.crew,
        checklist: checklistOf(v),
      })),
      money:
        m === undefined
          ? null
          : {
              priceCents: num(m?.price_cents),
              ...budget,
              laborHours: num(m?.labor_hours),
              totalCents: budgetTotal(budget),
              profitCents: profit?.cents ?? null,
              marginBp: profit?.marginBp ?? null,
            },
      recordTypeId: kinds.job,
    };
  },
});

export const propertyList = defineAddonQuery(contractorAddon, {
  name: 'contractor.property.list',
  description:
    'The business’s properties, each with its owners and how many jobs it has had: a customer’s first (or only theirs), or found by words in the address.',
  input: PropertyListInput,
  output: PropertyListOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_list_properties',
    description:
      'List properties (customerPersonId puts theirs first; onlyTheirs keeps to theirs; search words in the address), each with its owners and how many jobs it has had.',
  },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const kinds = await kindIds(ctx);
    const types = await relationshipTypeIds(ctx);
    const ownerType = types.get('contractor_owner') ?? null;
    const siteType = types.get('contractor_site') ?? null;
    const search = input.search ? `%${input.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const list = await rows<{
      id: string;
      name: string;
      owners: { personId: string; name: string }[] | null;
      jobs: number;
      theirs: boolean;
    }>(
      ctx.tx,
      sql`select r.id, r.name,
            (select json_agg(json_build_object('personId', p.id, 'name',
                coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.email::text, 'Customer'))
                order by x.created_at)
              from app.relationships x join app.people p on p.id = x.a_id
              where x.type_id = ${ownerType} and x.b_id = r.id) as owners,
            (select count(*)::int from app.relationships x where x.type_id = ${siteType} and x.b_id = r.id) as jobs,
            exists (select 1 from app.relationships x where x.type_id = ${ownerType} and x.b_id = r.id
              and x.a_id = ${input.customerPersonId ?? null}) as theirs
          from app.custom_records r
          where r.workspace_id = ${ws} and r.type_id = ${kinds.property} and r.archived_at is null
            and (${search}::text is null or r.name ilike ${search})
          order by 5 desc, r.name
          limit 200`,
    );
    return {
      properties: list
        .filter((p) => !input.onlyTheirs || p.theirs)
        .map((p) => ({ recordId: p.id, name: p.name, owners: p.owners ?? [], jobs: p.jobs })),
    };
  },
});
