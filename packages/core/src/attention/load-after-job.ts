/**
 * The Action Center's loaders for Automations' "After the job" cards: a customer nobody could thank
 * (`job_not_thanked`, one per app.thank_yous row), a referral a customer mentioned (`referral_mentioned`,
 * one per app.referrals row), and a regular service that's due and not booked (`maintenance_due`, one per
 * app.maintenance_reminders row). Server-only, beside load.ts, which runs them.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { automationSettingsOf } from '../automations/settings';
import { uuidArray } from '../calendar/load';
import type { LinkedLeadFacts } from './facts';
import type { AttentionFacts } from './registry';
import { THANK_YOU_CARD_DAYS } from './detectors/job-not-thanked';
import { MAINTENANCE_CARD_DAYS } from './detectors/maintenance-due';
import { REFERRAL_CARD_DAYS } from './detectors/referral-mentioned';

const DAY = 86_400_000;
const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
const nameOf = (first: string | null, last: string | null): string | null =>
  `${first ?? ''} ${last ?? ''}`.trim() || null;

export interface ThankYouInfo {
  readonly thankYou: AttentionFacts<'job_not_thanked'>['thankYou'];
  readonly personId: string;
  readonly personName: string | null;
  readonly title: string;
  readonly reason: string | null;
  readonly lead: LinkedLeadFacts | null;
  readonly conversationId: string | null;
  readonly assigneeUserId: string | null;
}

/**
 * Thank-yous by id, and in a sweep every `card` one still within its days. `contactedAt` is the latest message
 * that went to the customer since the job was done, on any of their conversations: whoever wrote, they were
 * thanked (or at least talked to), which is what the card asks for.
 */
export async function loadThankYous(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
  now: Date,
): Promise<Map<string, ThankYouInfo>> {
  if (!ids.length && !all) return new Map();
  const since = new Date(now.getTime() - THANK_YOU_CARD_DAYS * DAY).toISOString();
  const list = await rows<{
    id: string;
    completed_at: Date;
    outcome: 'sent' | 'drafted' | 'card' | 'skipped';
    reason: string | null;
    person_id: string;
    first_name: string | null;
    last_name: string | null;
    person_archived: boolean;
    title: string;
    lead_id: string | null;
    lead_value: number | null;
    lead_status: 'open' | 'won' | 'lost' | null;
    lead_assignee: string | null;
    contacted_at: Date | null;
    conversation_id: string | null;
    conversation_assignee: string | null;
  }>(
    tx,
    sql`select t.id, t.completed_at, t.outcome, t.reason, t.person_id, p.first_name, p.last_name,
          p.archived_at is not null as person_archived, a.title,
          l.id as lead_id, l.value_cents::float8 as lead_value, l.status::text as lead_status,
          l.assignee_user_id as lead_assignee,
          (select max(m.occurred_at) from app.messages m join app.conversations c on c.id = m.conversation_id
            where c.workspace_id = t.workspace_id and c.person_id = t.person_id
              and m.direction = 'outbound' and m.occurred_at > t.completed_at) as contacted_at,
          lc.id as conversation_id, lc.assignee_user_id as conversation_assignee
        from app.thank_yous t
        join app.people p on p.id = t.person_id
        join app.appointments a on a.id = t.appointment_id
        left join app.leads l on l.id = a.lead_id
        left join lateral (select c.id, c.assignee_user_id from app.conversations c
          where c.workspace_id = t.workspace_id and c.person_id = t.person_id
          order by c.last_message_at desc nulls last, c.created_at desc limit 1) lc on true
        where t.workspace_id = ${workspaceId}
          and (t.id = any(${uuidArray([...ids])})
            ${all ? sql`or (t.outcome = 'card' and t.completed_at > ${since}::timestamptz)` : sql``})`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        thankYou: {
          id: r.id,
          completedAt: iso(r.completed_at)!,
          outcome: r.outcome,
          contactedAt: iso(r.contacted_at),
          personArchived: r.person_archived,
        },
        personId: r.person_id,
        personName: nameOf(r.first_name, r.last_name),
        title: r.title,
        reason: r.reason,
        lead:
          r.lead_id && r.lead_status
            ? { id: r.lead_id, valueCents: Number(r.lead_value ?? 0), status: r.lead_status }
            : null,
        conversationId: r.conversation_id,
        assigneeUserId: r.conversation_assignee ?? r.lead_assignee,
      },
    ]),
  );
}

export interface ReferralInfo {
  readonly referral: AttentionFacts<'referral_mentioned'>['referral'];
  readonly referrerPersonId: string;
  readonly referrerName: string | null;
  readonly referredName: string | null;
  readonly quote: string | null;
  readonly conversationId: string | null;
  readonly assigneeUserId: string | null;
}

/** Referrals by id, and in a sweep every one still only mentioned within its days. */
export async function loadReferrals(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
  now: Date,
): Promise<Map<string, ReferralInfo>> {
  if (!ids.length && !all) return new Map();
  const since = new Date(now.getTime() - REFERRAL_CARD_DAYS * DAY).toISOString();
  const list = await rows<{
    id: string;
    status: 'mentioned' | 'lead_created' | 'dismissed';
    created_at: Date;
    relation: string | null;
    need: string | null;
    referred_name: string | null;
    quote: string | null;
    referrer_person_id: string;
    first_name: string | null;
    last_name: string | null;
    conversation_id: string | null;
    conversation_assignee: string | null;
  }>(
    tx,
    sql`select r.id, r.status, r.created_at, r.relation, r.need, r.referred_name, r.quote,
          r.referrer_person_id, p.first_name, p.last_name, r.conversation_id,
          c.assignee_user_id as conversation_assignee
        from app.referrals r
        join app.people p on p.id = r.referrer_person_id
        left join app.conversations c on c.id = r.conversation_id
        where r.workspace_id = ${workspaceId}
          and (r.id = any(${uuidArray([...ids])})
            ${all ? sql`or (r.status = 'mentioned' and r.created_at > ${since}::timestamptz)` : sql``})`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        referral: {
          id: r.id,
          status: r.status,
          createdAt: iso(r.created_at)!,
          relation: r.relation,
          need: r.need,
        },
        referrerPersonId: r.referrer_person_id,
        referrerName: nameOf(r.first_name, r.last_name),
        referredName: r.referred_name,
        quote: r.quote,
        conversationId: r.conversation_id,
        assigneeUserId: r.conversation_assignee,
      },
    ]),
  );
}

/** Automations' "Thank-you after the job" switch, from the business's settings. */
export const thankYouSwitchOn = (raw: Readonly<Record<string, unknown>>): boolean =>
  automationSettingsOf(raw).switches.thankYou;

export interface MaintenanceInfo {
  readonly reminder: AttentionFacts<'maintenance_due'>['reminder'];
  readonly personId: string;
  readonly personName: string | null;
  readonly serviceName: string;
  readonly lead: LinkedLeadFacts | null;
  readonly conversationId: string | null;
  readonly assigneeUserId: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Oct 5" from 2026-10-05. */
const shortDay = (d: string): string => {
  const [, m, day] = d.split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${day}`;
};

/**
 * Maintenance reminders by id, and in a sweep every one that asks a person, still within its days. `booked` is
 * any booking of that service made since the reminder began; `contactedAt` the latest message or call to them
 * since the card opened.
 */
export async function loadMaintenance(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
  now: Date,
): Promise<Map<string, MaintenanceInfo>> {
  if (!ids.length && !all) return new Map();
  const since = new Date(now.getTime() - MAINTENANCE_CARD_DAYS * DAY).toISOString();
  const list = await rows<{
    id: string;
    status: 'reminding' | 'booked' | 'card' | 'stopped';
    card_at: Date | null;
    due_on: string;
    person_id: string;
    first_name: string | null;
    last_name: string | null;
    owner_user_id: string | null;
    service_name: string;
    booked: boolean;
    contacted_at: Date | null;
    lead_id: string | null;
    lead_value: number | null;
    conversation_id: string | null;
    conversation_assignee: string | null;
  }>(
    tx,
    sql`select r.id, r.status, r.card_at, r.due_on::text as due_on, r.person_id, p.first_name, p.last_name,
          p.owner_user_id, s.name as service_name,
          exists (select 1 from app.appointment_attendees aa join app.appointments a on a.id = aa.appointment_id
            where aa.person_id = r.person_id and a.service_id = r.service_id
              and aa.status in ('booked', 'attended') and a.status in ('scheduled', 'completed')
              and a.id is distinct from r.last_visit_id
              and a.starts_at > coalesce((select lv.starts_at from app.appointments lv
                where lv.id = r.last_visit_id), r.created_at)) as booked,
          greatest(
            (select max(m.occurred_at) from app.messages m join app.conversations c on c.id = m.conversation_id
              where c.workspace_id = r.workspace_id and c.person_id = r.person_id
                and m.direction = 'outbound' and m.occurred_at > r.card_at),
            (select max(k.started_at) from app.calls k
              where k.workspace_id = r.workspace_id and k.person_id = r.person_id
                and k.direction = 'outbound' and k.started_at > r.card_at)) as contacted_at,
          l.id as lead_id, l.value_cents::float8 as lead_value,
          lc.id as conversation_id, lc.assignee_user_id as conversation_assignee
        from app.maintenance_reminders r
        join app.people p on p.id = r.person_id
        join app.services s on s.id = r.service_id
        left join lateral (select l.id, l.value_cents from app.leads l
          where l.person_id = r.person_id and l.status = 'open' and l.archived_at is null
          order by l.value_cents desc limit 1) l on true
        left join lateral (select c.id, c.assignee_user_id from app.conversations c
          where c.workspace_id = r.workspace_id and c.person_id = r.person_id
          order by c.last_message_at desc nulls last, c.created_at desc limit 1) lc on true
        where r.workspace_id = ${workspaceId}
          and (r.id = any(${uuidArray([...ids])})
            ${all ? sql`or (r.status = 'card' and r.card_at > ${since}::timestamptz)` : sql``})`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        reminder: {
          id: r.id,
          status: r.status,
          cardAt: iso(r.card_at),
          label: `${r.service_name} due ${shortDay(r.due_on)}`,
          booked: r.booked,
          contactedAt: iso(r.contacted_at),
        },
        personId: r.person_id,
        personName: nameOf(r.first_name, r.last_name),
        serviceName: r.service_name,
        lead: r.lead_id
          ? { id: r.lead_id, valueCents: Number(r.lead_value ?? 0), status: 'open' as const }
          : null,
        conversationId: r.conversation_id,
        assigneeUserId: r.conversation_assignee ?? r.owner_user_id,
      },
    ]),
  );
}
