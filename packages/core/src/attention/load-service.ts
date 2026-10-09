/**
 * The Action Center's loaders for Automations' service and revenue cards (stage 4a): regular customers who may
 * have gone quiet (`client_quiet`), promises the team made (`promise_due`), and last week's money in against the
 * usual week (`revenue_moved`). Server-only, beside load.ts, which runs them.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { maintenanceLines } from '../automations/maintenance-load';
import { automationSettingsOf } from '../automations/settings';
import { addDays, localDateOf, localInstant, weekdayOf } from '../calendar/engine/zoned';
import { uuidArray } from '../calendar/load';
import { money } from '../money/format';
import type { LinkedLeadFacts } from './facts';
import type { AttentionFacts } from './registry';
import { CLIENT_QUIET_MIN_DAYS, CLIENT_QUIET_MIN_VISITS } from './detectors/client-quiet';
import { PROMISE_CARD_DAYS } from './detectors/promise-due';
import { REVENUE_MOVED_MIN_WEEKS } from './detectors/revenue-moved';
import { whenLabel } from './wording';

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
const nameOf = (first: string | null, last: string | null): string | null =>
  `${first ?? ''} ${last ?? ''}`.trim() || null;
const leadOf = (
  id: string | null,
  value: number | null,
  status: 'open' | 'won' | 'lost' | null,
): LinkedLeadFacts | null => (id && status ? { id, valueCents: Number(value ?? 0), status } : null);

// ---------- regulars ----------

export interface RegularInfo {
  readonly regular: AttentionFacts<'client_quiet'>['regular'];
  readonly personName: string | null;
  readonly lead: LinkedLeadFacts | null;
  readonly assigneeUserId: string | null;
}

/** The customers "Maintenance due" reminds already: a service of theirs repeats and isn't a year overdue. */
async function coveredPeople(
  tx: Tx,
  workspaceId: string,
  personIds: readonly string[] | null,
  rawSettings: Readonly<Record<string, unknown>>,
  now: Date,
  timeZone: string,
): Promise<Set<string>> {
  if (!automationSettingsOf(rawSettings).switches.maintenance) return new Set();
  const oldest = addDays(localDateOf(now.getTime(), timeZone), -365);
  const lines =
    personIds === null
      ? await maintenanceLines(tx, workspaceId, { timeZone, now: now.getTime() })
      : await (async () => {
          const out = [];
          for (const personId of personIds)
            out.push(
              ...(await maintenanceLines(tx, workspaceId, {
                personId,
                timeZone,
                now: now.getTime(),
              })),
            );
          return out;
        })();
  return new Set(
    lines
      .filter((l) => l.schedule.everyMonths !== null && l.dueOn !== null && l.dueOn >= oldest)
      .map((l) => l.personId),
  );
}

/**
 * Customers with three or more visits done: the ones named, and in a sweep every one whose last visit was at
 * least 60 days ago (anyone sooner can't be quiet yet), with how often they usually come and whether anything
 * since says they haven't gone anywhere.
 */
export async function loadRegulars(
  tx: Tx,
  workspaceId: string,
  personIds: readonly string[],
  all: boolean,
  now: Date,
  timeZone: string,
  rawSettings: Readonly<Record<string, unknown>>,
): Promise<Map<string, RegularInfo>> {
  if (!all && personIds.length === 0) return new Map();
  const nowIso = now.toISOString();
  const named = uuidArray([...personIds]);
  const who = all ? sql`true` : sql`aa.person_id = any(${named})`;
  const list = await rows<{
    person_id: string;
    visits: number;
    last_visit: Date;
    gap_days: number | null;
    first_name: string | null;
    last_name: string | null;
    booked_ahead: boolean;
    last_contact: Date | null;
    reminding: boolean;
    lead_id: string | null;
    lead_value: number | null;
    lead_status: 'open' | 'won' | 'lost' | null;
    assignee_user_id: string | null;
  }>(
    tx,
    sql`with v as (
          select aa.person_id, a.starts_at,
            a.starts_at - lag(a.starts_at) over (partition by aa.person_id order by a.starts_at) as gap
          from app.appointment_attendees aa join app.appointments a on a.id = aa.appointment_id
          where a.workspace_id = ${workspaceId} and a.status = 'completed' and aa.status = 'attended'
            and ${who}
        ),
        s as (
          select person_id, count(*)::int as visits, max(starts_at) as last_visit,
            (percentile_cont(0.5) within group (order by extract(epoch from gap) / 86400)
              filter (where gap is not null))::float8 as gap_days
          from v group by person_id
          having count(*) >= ${CLIENT_QUIET_MIN_VISITS}
            ${
              all
                ? sql`and (max(starts_at) < ${nowIso}::timestamptz - ${`${CLIENT_QUIET_MIN_DAYS} days`}::interval
                    or person_id = any(${named}))`
                : sql``
            }
        )
        select s.person_id, s.visits, s.last_visit, s.gap_days, p.first_name, p.last_name,
          exists (select 1 from app.appointment_attendees fa join app.appointments f on f.id = fa.appointment_id
            where fa.person_id = s.person_id and fa.status = 'booked' and f.status = 'scheduled'
              and f.starts_at > ${nowIso}::timestamptz) as booked_ahead,
          greatest(
            (select max(m.created_at) from app.messages m join app.conversations c on c.id = m.conversation_id
              where c.person_id = s.person_id),
            (select max(k.started_at) from app.calls k where k.person_id = s.person_id)
          ) as last_contact,
          exists (select 1 from app.maintenance_reminders r where r.person_id = s.person_id
            and r.status in ('reminding', 'card')) as reminding,
          l.id as lead_id, l.value_cents::float8 as lead_value, l.status::text as lead_status,
          l.assignee_user_id
        from s
        join app.people p on p.id = s.person_id and p.archived_at is null
        left join lateral (
          select x.id, x.value_cents, x.status, x.assignee_user_id from app.leads x
          where x.person_id = s.person_id and x.archived_at is null
          order by (x.status = 'open') desc, x.created_at desc limit 1
        ) l on true`,
  );
  if (list.length === 0) return new Map();
  const covered = await coveredPeople(
    tx,
    workspaceId,
    all ? null : list.map((r) => r.person_id),
    rawSettings,
    now,
    timeZone,
  );
  return new Map(
    list.map((r) => [
      r.person_id,
      {
        regular: {
          personId: r.person_id,
          visits: r.visits,
          lastVisitAt: iso(r.last_visit)!,
          usualGapDays: Math.max(1, Math.round(Number(r.gap_days ?? CLIENT_QUIET_MIN_DAYS))),
          bookedAhead: r.booked_ahead,
          covered: r.reminding || covered.has(r.person_id),
          lastContactAt: iso(r.last_contact),
        },
        personName: nameOf(r.first_name, r.last_name),
        lead: leadOf(r.lead_id, r.lead_value, r.lead_status),
        assigneeUserId: r.assignee_user_id,
      },
    ]),
  );
}

// ---------- promises ----------

export interface PromiseInfo {
  readonly promise: AttentionFacts<'promise_due'>['promise'];
  readonly keptAt: string | null;
  readonly personId: string;
  readonly personName: string | null;
  readonly conversationId: string | null;
  readonly lead: LinkedLeadFacts | null;
  readonly assigneeUserId: string | null;
}

/**
 * Promises by id, and in a sweep every open one due within its card's days, with the first thing of its kind that
 * reached the customer afterwards. What the person sent in the same breath (within 15 minutes) doesn't count.
 */
export async function loadPromises(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
  now: Date,
  timeZone: string,
): Promise<Map<string, PromiseInfo>> {
  if (!all && ids.length === 0) return new Map();
  const list = await rows<{
    id: string;
    person_id: string;
    conversation_id: string | null;
    promised_by: string | null;
    what: string;
    kind: 'call' | 'send' | 'visit' | 'other';
    due_at: Date;
    status: 'open' | 'dismissed';
    first_name: string | null;
    last_name: string | null;
    kept_at: Date | null;
    lead_id: string | null;
    lead_value: number | null;
    lead_status: 'open' | 'won' | 'lost' | null;
  }>(
    tx,
    sql`select pr.id, pr.person_id, pr.conversation_id, pr.promised_by, pr.what, pr.kind, pr.due_at, pr.status,
          p.first_name, p.last_name,
          (select min(t) from (
            select m.created_at as t from app.messages m join app.conversations c on c.id = m.conversation_id
            where c.person_id = pr.person_id and m.direction = 'outbound'
              and m.created_at > pr.created_at + interval '15 minutes'
            union all
            select k.started_at from app.calls k
            where k.person_id = pr.person_id and k.answered_at is not null
              and k.started_at > pr.created_at + interval '15 minutes'
            union all
            select e.sent_at from app.estimates e
            where pr.kind = 'send' and e.person_id = pr.person_id and e.sent_at > pr.created_at
            union all
            select i.sent_at from app.invoices i
            where pr.kind = 'send' and i.person_id = pr.person_id and i.sent_at > pr.created_at
            union all
            select aa.created_at from app.appointment_attendees aa
            where pr.kind = 'visit' and aa.person_id = pr.person_id and aa.created_at > pr.created_at
          ) x) as kept_at,
          l.id as lead_id, l.value_cents::float8 as lead_value, l.status::text as lead_status
        from app.promises pr
        join app.people p on p.id = pr.person_id
        left join lateral (
          select x.id, x.value_cents, x.status from app.leads x
          where x.person_id = pr.person_id and x.status = 'open' and x.archived_at is null
          order by x.created_at desc limit 1
        ) l on true
        where pr.workspace_id = ${workspaceId}
          and (pr.id = any(${uuidArray([...ids])})
            ${
              all
                ? sql`or (pr.status = 'open'
                    and pr.due_at > ${now.toISOString()}::timestamptz - ${`${PROMISE_CARD_DAYS} days`}::interval)`
                : sql``
            })
          -- Not about a customer in the Deleted bin (20261027000400).
          and p.bin_item_id is null`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        promise: {
          id: r.id,
          what: r.what,
          kind: r.kind,
          dueAt: iso(r.due_at)!,
          dueLabel: whenLabel(new Date(r.due_at).getTime(), timeZone),
          status: r.status,
        },
        keptAt: iso(r.kept_at),
        personId: r.person_id,
        personName: nameOf(r.first_name, r.last_name),
        conversationId: r.conversation_id,
        lead: leadOf(r.lead_id, r.lead_value, r.lead_status),
        assigneeUserId: r.promised_by,
      },
    ]),
  );
}

// ---------- revenue ----------

export type RevenueFacts = Omit<AttentionFacts<'revenue_moved'>, 'business'>;

const median = (list: readonly number[]): number => {
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** This week's Monday where the business is (YYYY-MM-DD). */
export function mondayOf(now: number, timeZone: string): string {
  const today = localDateOf(now, timeZone);
  return addDays(today, -((weekdayOf(today) + 6) % 7));
}

/**
 * Last week's money in (payments less refunds, Monday to Sunday where the business is) against the median of the
 * eight weeks before it, counting only weeks with any money in; and the main reason when it moved.
 */
export async function loadRevenue(
  tx: Tx,
  workspaceId: string,
  now: Date,
  timeZone: string,
): Promise<RevenueFacts> {
  const monday = mondayOf(now.getTime(), timeZone);
  // Week 0 is last week; weeks 1–8 are the ones it's compared with.
  const starts = Array.from({ length: 9 }, (_, k) =>
    localInstant(addDays(monday, -7 * (k + 1)), '00:00', timeZone),
  );
  const from = new Date(starts[8]!).toISOString();
  const to = new Date(localInstant(monday, '00:00', timeZone)).toISOString();
  const moves = await rows<{ at: Date; cents: number; kind: 'payment' | 'refund' | 'job' }>(
    tx,
    sql`select received_at as at, amount_cents::float8 as cents, 'payment' as kind from app.payments
        where workspace_id = ${workspaceId} and status = 'succeeded'
          and received_at >= ${from}::timestamptz and received_at < ${to}::timestamptz
        union all
        select refunded_at, amount_cents::float8, 'refund' from app.refunds r
        join app.invoices i on i.id = r.invoice_id
        where i.workspace_id = ${workspaceId} and r.status = 'succeeded'
          and r.refunded_at >= ${from}::timestamptz and r.refunded_at < ${to}::timestamptz
        union all
        select a.starts_at, 0, 'job' from app.appointments a
        where a.workspace_id = ${workspaceId} and a.status = 'completed'
          and a.starts_at >= ${from}::timestamptz and a.starts_at < ${to}::timestamptz`,
  );
  const weekOfAt = (t: number) => starts.findIndex((s) => t >= s);
  const cents = Array<number>(9).fill(0);
  const jobs = Array<number>(9).fill(0);
  let biggest = 0;
  for (const m of moves) {
    const t = new Date(m.at).getTime();
    const k = weekOfAt(t);
    if (k < 0) continue;
    if (m.kind === 'job') jobs[k]! += 1;
    else if (m.kind === 'refund') cents[k]! -= Number(m.cents);
    else {
      cents[k]! += Number(m.cents);
      if (k === 0) biggest = Math.max(biggest, Number(m.cents));
    }
  }
  const before = cents.slice(1).filter((c) => c > 0);
  const usualCents = before.length >= REVENUE_MOVED_MIN_WEEKS ? Math.round(median(before)) : null;
  const lastCents = Math.round(cents[0]!);
  let reason: string | null = null;
  if (usualCents !== null) {
    const usualJobs = Math.round(median(jobs.slice(1)));
    const jobsOff = usualJobs > 0 ? (jobs[0]! - usualJobs) / usualJobs : 0;
    const jobsWords = `${jobs[0]} ${jobs[0] === 1 ? 'job' : 'jobs'} done, usually ${usualJobs}`;
    if (lastCents < usualCents) {
      const [owed] = await rows<{ cents: number }>(
        tx,
        sql`select coalesce(sum(balance_cents), 0)::float8 as cents from app.invoices
            where workspace_id = ${workspaceId} and status in ('sent', 'partly_paid', 'overdue')
              and due_on >= ${addDays(monday, -7)}::date and due_on < ${monday}::date`,
      );
      const unpaid = Math.round(Number(owed?.cents ?? 0));
      if (unpaid >= usualCents * 0.2) reason = `${money(unpaid)} due last week still unpaid`;
      else if (jobsOff <= -0.2) reason = jobsWords;
    } else if (lastCents > 0 && biggest >= lastCents * 0.5) {
      reason = `one ${money(biggest)} payment`;
    } else if (jobsOff >= 0.2) reason = jobsWords;
  }
  return {
    week: {
      start: addDays(monday, -7),
      opensAt: new Date(localInstant(monday, '06:00', timeZone)).toISOString(),
      endsAt: new Date(localInstant(addDays(monday, 7), '06:00', timeZone)).toISOString(),
    },
    lastCents,
    usualCents,
    weeksCounted: before.length,
    reason,
  };
}
