/**
 * Automations' daily briefings: what the morning and evening emails read beyond the Action Center's items.
 * - Today's jobs: every visit on the business's calendars today (a member sees the ones they're on).
 * - Follow-ups due today: open leads whose next step falls today and hasn't come due yet (once it's overdue it
 *   is an Action Center item already).
 * - The day in numbers, for the evening: leads, jobs, money and the AI teammate, counted from the day's events.
 */
import { addDays, localDateOf, localInstant } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';

/** The day where the business is, as instants: [start, end). */
export function dayWindow(
  now: number,
  timeZone: string,
): { day: string; from: number; to: number } {
  const day = localDateOf(now, timeZone);
  return {
    day,
    from: localInstant(day, '00:00', timeZone),
    to: localInstant(addDays(day, 1), '00:00', timeZone),
  };
}

export interface TodaysJob {
  readonly id: string;
  readonly startsAt: number;
  readonly title: string;
  readonly customers: string;
  readonly status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
  /** Everyone on it has confirmed (only one-on-one bookings are asked). */
  readonly confirmed: boolean;
  readonly endsAt: number;
  /** Who's on it: its owner and its staff. */
  readonly userIds: readonly string[];
}

/** Every visit today that isn't cancelled, earliest first. */
export async function todaysJobs(
  tx: Tx,
  workspaceId: string,
  window: { from: number; to: number },
): Promise<TodaysJob[]> {
  const list = await rows<{
    id: string;
    starts_at: Date;
    ends_at: Date;
    title: string;
    status: TodaysJob['status'];
    customers: string | null;
    unconfirmed: boolean;
    user_ids: string[] | null;
  }>(
    tx,
    sql`select a.id, a.starts_at, a.ends_at, a.title, a.status::text as status,
          (select string_agg(btrim(p.first_name || ' ' || p.last_name), ', ' order by aa.created_at)
            from app.appointment_attendees aa join app.people p on p.id = aa.person_id
            where aa.appointment_id = a.id and aa.status <> 'cancelled') as customers,
          exists (select 1 from app.appointment_attendees aa where aa.appointment_id = a.id
            and aa.status = 'booked' and aa.confirmed_at is null) as unconfirmed,
          array(select distinct u from (
            select a.owner_user_id as u
            union all select s.user_id from app.appointment_staff s where s.appointment_id = a.id
          ) x where u is not null) as user_ids
        from app.appointments a
        where a.workspace_id = ${workspaceId} and a.status <> 'cancelled'
          and a.starts_at >= ${new Date(window.from).toISOString()}::timestamptz
          and a.starts_at < ${new Date(window.to).toISOString()}::timestamptz
        order by a.starts_at, a.id`,
  );
  return list.map((r) => ({
    id: r.id,
    startsAt: new Date(r.starts_at).getTime(),
    endsAt: new Date(r.ends_at).getTime(),
    title: r.title,
    customers: r.customers?.trim() || 'No customer',
    status: r.status,
    confirmed: !r.unconfirmed,
    userIds: r.user_ids ?? [],
  }));
}

export interface FollowUpDue {
  readonly leadId: string;
  readonly title: string;
  readonly name: string;
  readonly nextAction: string | null;
  readonly dueAt: number;
  readonly assigneeUserId: string | null;
}

/** Open leads whose next step is due later today (from `now` to the end of the day). */
export async function followUpsDueToday(
  tx: Tx,
  workspaceId: string,
  now: number,
  window: { to: number },
): Promise<FollowUpDue[]> {
  const list = await rows<{
    id: string;
    title: string;
    name: string | null;
    next_action: string | null;
    next_action_at: Date;
    assignee_user_id: string | null;
  }>(
    tx,
    sql`select l.id, l.title, btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) as name,
          l.next_action, l.next_action_at, l.assignee_user_id
        from app.leads l left join app.people p on p.id = l.person_id
        where l.workspace_id = ${workspaceId} and l.status = 'open' and l.archived_at is null
          and l.next_action_at >= ${new Date(now).toISOString()}::timestamptz
          and l.next_action_at < ${new Date(window.to).toISOString()}::timestamptz
        order by l.next_action_at, l.id
        limit 50`,
  );
  return list.map((r) => ({
    leadId: r.id,
    title: r.title,
    name: r.name?.trim() || 'A lead',
    nextAction: r.next_action,
    dueAt: new Date(r.next_action_at).getTime(),
    assigneeUserId: r.assignee_user_id,
  }));
}

export interface DayNumbers {
  readonly newLeads: number;
  /** Of today's new leads, how many have had a first reply. */
  readonly leadsReached: number;
  readonly jobsBooked: number;
  readonly jobsDone: number;
  readonly noShows: number;
  readonly paidCents: number;
  readonly payments: number;
  readonly invoicesSent: number;
  readonly estimatesSent: number;
  /** Conversations the AI teammate answered today. */
  readonly aiAnswered: number;
  /** AI drafts waiting for someone to approve, right now. */
  readonly aiDraftsWaiting: number;
}

/** The day in numbers, from its events and the day's payments. */
export async function dayNumbers(
  tx: Tx,
  workspaceId: string,
  window: { from: number; to: number },
): Promise<DayNumbers> {
  const from = new Date(window.from).toISOString();
  const to = new Date(window.to).toISOString();
  const [r] = await rows<{
    new_leads: number;
    leads_reached: number;
    jobs_booked: number;
    jobs_done: number;
    no_shows: number;
    paid_cents: number;
    payments: number;
    invoices_sent: number;
    estimates_sent: number;
    ai_answered: number;
    ai_drafts: number;
  }>(
    tx,
    sql`with ev as (
          select event_type, count(*)::int as n from app.events
          where workspace_id = ${workspaceId}
            and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz
            and event_type in ('appointment.booked', 'attendee.added', 'appointment.completed',
              'appointment.no_show', 'invoice.sent', 'estimate.sent')
          group by event_type
        )
        select
          (select count(*)::int from app.leads where workspace_id = ${workspaceId}
            and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz) as new_leads,
          (select count(*)::int from app.leads where workspace_id = ${workspaceId}
            and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz
            and first_response_at is not null) as leads_reached,
          coalesce((select sum(n) from ev where event_type in ('appointment.booked', 'attendee.added')), 0)::int
            as jobs_booked,
          coalesce((select n from ev where event_type = 'appointment.completed'), 0) as jobs_done,
          coalesce((select n from ev where event_type = 'appointment.no_show'), 0) as no_shows,
          coalesce((select sum(amount_cents) from app.payments where workspace_id = ${workspaceId}
            and status = 'succeeded' and received_at >= ${from}::timestamptz
            and received_at < ${to}::timestamptz), 0)::float8 as paid_cents,
          (select count(*)::int from app.payments where workspace_id = ${workspaceId}
            and status = 'succeeded' and received_at >= ${from}::timestamptz
            and received_at < ${to}::timestamptz) as payments,
          coalesce((select n from ev where event_type = 'invoice.sent'), 0) as invoices_sent,
          coalesce((select n from ev where event_type = 'estimate.sent'), 0) as estimates_sent,
          (select count(distinct conversation_id)::int from app.ai_teammate_runs
            where workspace_id = ${workspaceId} and outcome = 'replied' and not is_test
              and started_at >= ${from}::timestamptz and started_at < ${to}::timestamptz) as ai_answered,
          (select count(*)::int from app.ai_teammate_drafts d
            where d.workspace_id = ${workspaceId} and d.status = 'pending') as ai_drafts`,
  );
  return {
    newLeads: r?.new_leads ?? 0,
    leadsReached: r?.leads_reached ?? 0,
    jobsBooked: r?.jobs_booked ?? 0,
    jobsDone: r?.jobs_done ?? 0,
    noShows: r?.no_shows ?? 0,
    paidCents: Math.round(Number(r?.paid_cents ?? 0)),
    payments: r?.payments ?? 0,
    invoicesSent: r?.invoices_sent ?? 0,
    estimatesSent: r?.estimates_sent ?? 0,
    aiAnswered: r?.ai_answered ?? 0,
    aiDraftsWaiting: r?.ai_drafts ?? 0,
  };
}

/** Whether the business has an AI teammate that isn't off (the evening's AI line shows only then). */
export async function hasTeammate(tx: Tx, workspaceId: string): Promise<boolean> {
  const [t] = await rows(
    tx,
    sql`select 1 from app.ai_teammates where workspace_id = ${workspaceId} and status <> 'off' limit 1`,
  );
  return !!t;
}
