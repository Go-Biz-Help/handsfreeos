/**
 * "Maintenance due", server side: for each customer and each service they've had done, when they're due
 * again. Read by the worker's daily job (who to remind) and by a customer's page (their schedule).
 *
 * One row per customer and service with a completed visit, or a schedule of their own. How often follows
 * `maintenanceScheduleOf`: the customer's own schedule, then an active plan covering the service, then the
 * service's "repeats every". The due day is the last visit's day where the business is, plus that.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { localDateOf } from '../calendar/engine/zoned';
import { maintenanceDueOn, maintenanceScheduleOf, type MaintenanceSchedule } from './maintenance';

export interface MaintenanceLine {
  readonly personId: string;
  readonly serviceId: string;
  readonly serviceName: string;
  /** The last completed visit for the service, or null (a schedule set before any visit). */
  readonly lastVisitId: string | null;
  /** Its day where the business is (YYYY-MM-DD). */
  readonly lastVisitOn: string | null;
  readonly schedule: MaintenanceSchedule;
  /** The plan they're on that covers the service, when that's where the schedule comes from. */
  readonly plan: { readonly subscriptionId: string; readonly name: string } | null;
  /** When the next visit is due, or null (no schedule, or no visit to count from). */
  readonly dueOn: string | null;
  /** They already have one of this service booked ahead. */
  readonly bookedAhead: boolean;
}

interface Raw extends Record<string, unknown> {
  person_id: string;
  service_id: string;
  service_name: string;
  repeat_months: number | null;
  visit_id: string | null;
  visit_at: Date | null;
  has_override: boolean;
  override_months: number | null;
  subscription_id: string | null;
  plan_name: string | null;
  plan_months: number | null;
  booked_ahead: boolean;
}

/**
 * Every customer and service with a completed visit or a schedule of their own, in one business (or for one
 * customer). Archived services and archived customers are left out.
 */
export async function maintenanceLines(
  tx: Tx,
  workspaceId: string,
  opts: { readonly personId?: string; readonly timeZone: string; readonly now?: number },
): Promise<MaintenanceLine[]> {
  const now = opts.now ?? Date.now();
  const person = opts.personId ? sql`and x.person_id = ${opts.personId}` : sql``;
  const list = await rows<Raw>(
    tx,
    sql`with visits as (
          select distinct on (aa.person_id, a.service_id) aa.person_id, a.service_id,
            a.id as visit_id, a.starts_at as visit_at
          from app.appointment_attendees aa
          join app.appointments a on a.id = aa.appointment_id
          where a.workspace_id = ${workspaceId} and a.status = 'completed' and aa.status = 'attended'
            and a.service_id is not null
          order by aa.person_id, a.service_id, a.starts_at desc
        ),
        pairs as (
          select person_id, service_id from visits
          union
          select person_id, service_id from app.service_schedules where workspace_id = ${workspaceId}
        )
        select x.person_id, x.service_id, s.name as service_name, s.repeat_months,
          v.visit_id, v.visit_at,
          ss.id is not null as has_override, ss.every_months as override_months,
          pl.subscription_id, pl.plan_name, pl.plan_months,
          exists (select 1 from app.appointment_attendees fa join app.appointments f on f.id = fa.appointment_id
            where fa.person_id = x.person_id and f.service_id = x.service_id and f.status = 'scheduled'
              and fa.status = 'booked' and f.starts_at > ${new Date(now).toISOString()}::timestamptz)
            as booked_ahead
        from pairs x
        join app.services s on s.id = x.service_id and s.archived_at is null
        join app.people p on p.id = x.person_id and p.archived_at is null
        left join visits v on v.person_id = x.person_id and v.service_id = x.service_id
        left join app.service_schedules ss on ss.person_id = x.person_id and ss.service_id = x.service_id
        left join lateral (
          select sub.id as subscription_id, p2.name as plan_name, p2.visit_every_months as plan_months
          from app.subscriptions sub join app.plans p2 on p2.id = sub.plan_id
          where sub.person_id = x.person_id and sub.status in ('active', 'past_due')
            and p2.service_id = x.service_id
          order by sub.started_on desc nulls last limit 1
        ) pl on true
        where true ${person}`,
  );
  return list.map((r) => {
    const schedule = maintenanceScheduleOf({
      ...(r.has_override ? { customer: r.override_months } : {}),
      plan: r.plan_months,
      service: r.repeat_months,
    });
    const lastVisitOn = r.visit_at
      ? localDateOf(new Date(r.visit_at).getTime(), opts.timeZone)
      : null;
    return {
      personId: r.person_id,
      serviceId: r.service_id,
      serviceName: r.service_name,
      lastVisitId: r.visit_id,
      lastVisitOn,
      schedule,
      plan:
        schedule.source === 'plan' && r.subscription_id
          ? { subscriptionId: r.subscription_id, name: r.plan_name ?? 'plan' }
          : null,
      dueOn:
        lastVisitOn && schedule.everyMonths
          ? maintenanceDueOn(lastVisitOn, schedule.everyMonths)
          : null,
      bookedAhead: r.booked_ahead,
    };
  });
}
