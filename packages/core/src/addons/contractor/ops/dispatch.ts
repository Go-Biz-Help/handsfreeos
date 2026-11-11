/**
 * Dispatch (docs/contractor.md, "Dispatch"): one day's visits on jobs, by who's on them, with what isn't given to
 * anyone and where each visit stands (on the way, started, done); and the open jobs with nothing booked. Read as the
 * person asking, under row security: a visit in the Deleted bin isn't here.
 */
import { rows, sql } from '@hfos/db/client';
import { defineAddonQuery } from '../../server';
import { contractorAddon } from '../manifest';
import { todayIn } from '../progress';
import { DispatchInput, DispatchOutput, LIMITS } from '../schemas';
import { inWorkspace, timeZoneOf } from './common';
import { jobsSql, rowOut } from './queries';
import { checklistOf, stageOf, VISIT_COLUMNS, VISIT_JOINS, type VisitSqlRow } from './visits';

/** The jobs still waiting on a visit: on hold ones are waiting on something else. */
const NEEDS_VISIT = 50;

export const dispatch = defineAddonQuery(contractorAddon, {
  name: 'contractor.dispatch',
  description:
    'One day’s visits on jobs: who’s on each, the ones nobody is on, where each stands (scheduled, on the way, started, done), its crew, subcontractors and checklist; and the open jobs with nothing booked.',
  input: DispatchInput,
  output: DispatchOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_get_dispatch',
    description:
      'Dispatch for a day (today when no day is given, in the business’s time zone): each visit on a job with its appointment id, time, where it stands (scheduled, on the way, started, waiting on parts, done), its job, customer, property and crew, the team members on it (userIds; empty means nobody is on it yet), how many subcontractors are on it and done, and its checklist’s progress; plus the open jobs with no visit booked from now on.',
    keywords: ['dispatch', 'schedule', 'today', 'unassigned'],
  },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const timeZone = await timeZoneOf(ctx);
    const today = todayIn(timeZone);
    const day = input.day ?? today;
    const found = await rows<
      VisitSqlRow & { job_id: string; user_ids: string[] | null; subs: number; subs_done: number }
    >(
      ctx.tx,
      sql`select ${VISIT_COLUMNS}, j.record_id as job_id,
            (select array_agg(s.user_id order by s.created_at, s.user_id) from app.appointment_staff s
              where s.appointment_id = a.id and s.workspace_id = ${ws} and s.active) as user_ids,
            (select count(*)::int from addon_contractor.work_order_subs ws where ws.appointment_id = a.id) as subs,
            (select count(*)::int from addon_contractor.work_order_subs ws
              where ws.appointment_id = a.id and ws.done_at is not null) as subs_done
          from app.appointments a
          join addon_contractor.jobs j on j.record_id = a.custom_record_id
          join app.custom_records r on r.id = j.record_id and r.archived_at is null
          ${VISIT_JOINS}
          where a.workspace_id = ${ws} and a.status <> 'cancelled'
            and a.starts_at < ((${day}::date + 1)::timestamp at time zone ${timeZone})
            and a.ends_at > (${day}::date::timestamp at time zone ${timeZone})
          order by a.starts_at, a.id
          limit ${LIMITS.dispatch + 1}`,
    );
    const visits = found.slice(0, LIMITS.dispatch);
    const jobIds = [...new Set(visits.map((v) => v.job_id))];
    const userIds = [...new Set(visits.flatMap((v) => v.user_ids ?? []))];
    const [jobRows, people, waiting] = await Promise.all([
      jobIds.length
        ? jobsSql(ctx, sql`j.record_id = any(${`{${jobIds.join(',')}}`}::uuid[])`, jobIds.length)
        : Promise.resolve([]),
      userIds.length
        ? rows<{ user_id: string; name: string }>(
            ctx.tx,
            sql`select u.id as user_id, coalesce(nullif(btrim(u.full_name), ''), u.email::text) as name
                from app.users u where u.id = any(${`{${userIds.join(',')}}`}::uuid[])
                order by 2, 1`,
          )
        : Promise.resolve([]),
      jobsSql(
        ctx,
        sql`j.status in ('new', 'scheduled', 'in_progress') and r.archived_at is null
            and not exists (
              select 1 from app.appointments a
              where a.custom_record_id = j.record_id and a.workspace_id = ${ws}
                and a.status <> 'cancelled' and a.ends_at > now())`,
        NEEDS_VISIT,
      ),
    ]);
    const jobs = new Map(jobRows.map((r) => [r.id, rowOut(r, today)]));
    return {
      day,
      today,
      timeZone,
      visits: visits.flatMap((v) => {
        const job = jobs.get(v.job_id);
        if (!job) return [];
        return [
          {
            appointmentId: v.id,
            title: v.title,
            startsAt: new Date(v.starts_at).toISOString(),
            endsAt: new Date(v.ends_at).toISOString(),
            stage: stageOf(v),
            job: { id: job.id, name: job.name, status: job.status },
            customer: job.customer?.name ?? null,
            property: job.property?.name ?? null,
            crew: v.crew,
            userIds: v.user_ids ?? [],
            subs: { total: v.subs, done: v.subs_done },
            checklist: checklistOf(v),
          },
        ];
      }),
      people: people.map((p) => ({ userId: p.user_id, name: p.name })),
      needsVisit: waiting.map((r) => {
        const job = rowOut(r, today);
        return {
          id: job.id,
          name: job.name,
          status: job.status,
          customer: job.customer,
          property: job.property?.name ?? null,
          dueOn: job.dueOn,
          daysLate: job.daysLate,
        };
      }),
      truncated: found.length > LIMITS.dispatch,
    };
  },
});
