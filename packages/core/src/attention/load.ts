/**
 * The Action Center's server side (M8): batch loaders that fill every detector's facts for a set of subjects, and
 * `reconcile`, which runs the detectors, folds them into one card per lead and brings app.attention_items in line
 * with what holds now: it opens, updates, reopens and resolves rows by the fingerprint rules, and writes nothing
 * when nothing changed. Server-only; the worker runs it as the service actor bound to one workspace.
 *
 * The fingerprint rules:
 * - a dismissed, snoozed or handled item comes back only when its fingerprint changes (a snooze also ends at its
 *   time, and a handled item at the worker's handled_until);
 * - an item whose facts stop holding is resolved, except a handled one, which stays handled (it's the record of
 *   what was done: "3 handled today");
 * - an item that folded into another card is resolved only while it's open (resolving a dismissed or snoozed one
 *   would lose that).
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { attentionItems } from '@hfos/db/schema';
import { uuidArray } from '../calendar/load';
import { formatPhone } from '../crm/phone';
import type { QuietHoursWindow } from '../messaging/quiet-hours';
import { workspaceMessaging } from '../messaging/store';
import { openHoursOf } from '../schemas/workspace';
import type { BusinessFacts, LeadFacts, LinkedLeadFacts } from './facts';
import { foldCandidates } from './folding';
import { ATTENTION_SUBJECT_OF, type AttentionKind, type AttentionSubjectType } from './kinds';
import { attentionWakeAt, detectAttention, type AttentionFacts } from './registry';
import { attentionSettingsOf, type AttentionSettings } from './settings';
import type { AttentionCandidate, AttentionChip, Detection } from './types';
import { clipLine, DETAIL_MAX, itemTitle, whenLabel } from './wording';

export type AttentionItemRow = typeof attentionItems.$inferSelect;
export type AttentionState = AttentionItemRow['state'];

/** What changed, and whose facts to look at again: a record, or a customer (their leads and conversations). */
export interface AttentionSubjectRef {
  readonly type: 'lead' | 'person' | 'conversation' | 'attendee' | 'approval' | 'task';
  readonly id: string;
}

/** One business's Action Center settings and the facts every detector shares. */
export interface AttentionContext {
  readonly workspaceId: string;
  readonly organizationId: string;
  /** The business's name. */
  readonly name: string;
  readonly timeZone: string;
  readonly settings: AttentionSettings;
  readonly business: BusinessFacts;
  /** The reply threshold for a waiting customer (`telephony.unansweredReminderMinutes`). */
  readonly replyThresholdMinutes: number;
  /** When texts wait (`telephony.quietHours`). */
  readonly quietHours: QuietHoursWindow;
  readonly rawSettings: Readonly<Record<string, unknown>>;
}

/** A real change of state, for the worker to record as an event and act on (alerts, automatic actions). */
export interface AttentionTransition {
  /** opened: a new item. reopened: back after being resolved, or because its facts changed. unsnoozed: its
   * snooze ran out. resolved: its facts stopped holding (or it folded into another card). */
  readonly type: 'opened' | 'reopened' | 'unsnoozed' | 'resolved';
  readonly itemId: string;
  readonly kind: AttentionKind;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly personId: string | null;
  readonly leadId: string | null;
  readonly conversationId: string | null;
  readonly from: AttentionState | null;
  readonly state: AttentionState;
  readonly fingerprint: string;
  readonly title: string;
  readonly urgentFrom: string | null;
  readonly assigneeUserId: string | null;
  readonly reasons: readonly AttentionChip[];
  readonly resolution: string | null;
}

/** When to look at a subject again: the earliest moment one of its kinds turns (urgent, starts, expires) or begins to hold. */
export interface AttentionRecheck {
  readonly subjectType: AttentionSubjectType | 'person';
  readonly subjectId: string;
  readonly at: string;
}

export interface ReconcileResult {
  readonly transitions: readonly AttentionTransition[];
  /** Items whose facts changed without a change of state (a quiet refresh: no event). */
  readonly updated: readonly string[];
  readonly rechecks: readonly AttentionRecheck[];
}

/** Resolutions that mean someone (or HandsFreeOS) dealt with it: they count as handled today. */
export const DONE_RESOLUTIONS = [
  'contacted',
  'replied',
  'confirmed',
  'decided',
  'done',
  'next_action_set',
  'closed',
] as const;

/** Kinds whose assignee is the item's own (for the rest it follows the lead, conversation or task). */
const ITEM_OWNED: ReadonlySet<AttentionKind> = new Set(['unconfirmed_appointment', 'ai_approval']);

const DAY = 86_400_000;
const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();
const timeOf = (d: Date | string | null | undefined): number | null =>
  d === null || d === undefined ? null : new Date(d).getTime();
const tsParam = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const nameOf = (first: string | null, last: string | null): string | null =>
  `${first ?? ''} ${last ?? ''}`.trim() || null;

// ---------- the business ----------

export async function loadAttentionContext(
  tx: Tx,
  workspaceId: string,
  now: Date = new Date(),
): Promise<AttentionContext> {
  const m = await workspaceMessaging(tx, workspaceId);
  const [won] = await rows<{ cents: number | null }>(
    tx,
    sql`select percentile_cont(0.5) within group (order by value_cents)::float8 as cents
        from app.leads
        where workspace_id = ${workspaceId} and status = 'won' and value_cents > 0
          and won_at > ${tsParam(now)} - interval '365 days'`,
  );
  const timeZone = m.timezone || 'UTC';
  return {
    workspaceId,
    organizationId: m.organizationId,
    name: m.name,
    timeZone,
    settings: attentionSettingsOf(m.rawSettings),
    business: {
      timeZone,
      openHours: openHoursOf(m.rawSettings),
      medianWonCents: won?.cents === null || won?.cents === undefined ? null : Number(won.cents),
    },
    replyThresholdMinutes: m.settings.unansweredReminderMinutes,
    quietHours: m.settings.quietHours,
    rawSettings: m.rawSettings,
  };
}

/** Everyone who works in the business: an assignee must be one of them. */
async function workspaceUsers(tx: Tx, workspaceId: string, organizationId: string) {
  const list = await rows<{ user_id: string }>(
    tx,
    sql`select user_id from app.workspace_memberships where workspace_id = ${workspaceId}
        union select user_id from app.organization_memberships where organization_id = ${organizationId}`,
  );
  return new Set(list.map((r) => r.user_id));
}

// ---------- which subjects ----------

interface SubjectSets {
  readonly leads: Set<string>;
  readonly conversations: Set<string>;
  readonly attendees: Set<string>;
  readonly approvals: Set<string>;
  readonly tasks: Set<string>;
  readonly persons: Set<string>;
}

const emptySets = (): SubjectSets => ({
  leads: new Set(),
  conversations: new Set(),
  attendees: new Set(),
  approvals: new Set(),
  tasks: new Set(),
  persons: new Set(),
});

function addSubject(s: SubjectSets, type: string, id: string): void {
  if (type === 'lead') s.leads.add(id);
  else if (type === 'conversation') s.conversations.add(id);
  else if (type === 'attendee') s.attendees.add(id);
  else if (type === 'approval') s.approvals.add(id);
  else if (type === 'task') s.tasks.add(id);
  else if (type === 'person') s.persons.add(id);
}

/**
 * The subjects to look at, widened to what folding needs: a lead or a conversation brings in its customer, and a
 * customer brings in all their leads and conversations (one card per lead, and a waiting conversation joins it).
 */
async function expand(
  tx: Tx,
  workspaceId: string,
  subjects: readonly AttentionSubjectRef[],
): Promise<SubjectSets> {
  const s = emptySets();
  for (const x of subjects) addSubject(s, x.type, x.id);
  const owners = await rows<{ person_id: string | null }>(
    tx,
    sql`select person_id from app.leads where workspace_id = ${workspaceId} and id = any(${uuidArray([...s.leads])})
        union all
        select person_id from app.conversations
        where workspace_id = ${workspaceId} and id = any(${uuidArray([...s.conversations])})`,
  );
  for (const o of owners) if (o.person_id) s.persons.add(o.person_id);
  if (s.persons.size) {
    const theirs = await rows<{ type: string; id: string }>(
      tx,
      sql`select 'lead' as type, id from app.leads
          where workspace_id = ${workspaceId} and person_id = any(${uuidArray([...s.persons])})
          union all
          select 'conversation', id from app.conversations
          where workspace_id = ${workspaceId} and person_id = any(${uuidArray([...s.persons])})`,
    );
    for (const t of theirs) addSubject(s, t.type, t.id);
  }
  return s;
}

// ---------- loaders ----------

interface LeadInfo {
  readonly facts: LeadFacts;
  readonly title: string;
  readonly personName: string | null;
  readonly companyName: string | null;
  readonly source: string | null;
}

/** Leads by id, and in a sweep every open lead, with their stage among the pipeline's open stages. */
async function loadLeads(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
): Promise<Map<string, LeadInfo>> {
  const list = await rows<{
    id: string;
    person_id: string | null;
    title: string;
    status: 'open' | 'won' | 'lost';
    archived: boolean;
    value_cents: number;
    created_at: Date;
    created_by_person: boolean;
    imported: boolean;
    assignee_user_id: string | null;
    stage_id: string;
    stage_name: string;
    stage_index: number;
    open_stages: number;
    stage_entered_at: Date;
    next_action: string | null;
    next_action_at: Date | null;
    first_response_at: Date | null;
    last_contact_at: Date | null;
    qualification: string | null;
    source: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
  }>(
    tx,
    sql`select l.id, l.person_id, l.title, l.status::text as status, l.archived_at is not null as archived,
          l.value_cents::float8 as value_cents, l.created_at, l.created_by is not null as created_by_person,
          (p.import_id is not null or c.import_id is not null or lower(btrim(coalesce(l.source, ''))) = 'import')
            as imported,
          l.assignee_user_id, l.stage_id, s.name as stage_name,
          (select count(*)::int from app.pipeline_stages o
            where o.pipeline_id = l.pipeline_id and o.kind = 'open' and o.position < s.position) as stage_index,
          (select count(*)::int from app.pipeline_stages o
            where o.pipeline_id = l.pipeline_id and o.kind = 'open') as open_stages,
          l.stage_entered_at, l.next_action, l.next_action_at, l.first_response_at, l.last_contact_at,
          l.qualification ->> 'status' as qualification, l.source,
          p.first_name, p.last_name, c.name as company_name
        from app.leads l
        join app.pipeline_stages s on s.id = l.stage_id
        left join app.people p on p.id = l.person_id
        left join app.companies c on c.id = l.company_id
        where l.workspace_id = ${workspaceId}
          and (l.id = any(${uuidArray(ids)})
            ${all ? sql`or (l.status = 'open' and l.archived_at is null)` : sql``})`,
  );
  const out = new Map<string, LeadInfo>();
  for (const r of list) {
    const q = r.qualification;
    out.set(r.id, {
      facts: {
        id: r.id,
        personId: r.person_id,
        status: r.status,
        archived: r.archived,
        valueCents: Number(r.value_cents),
        createdAt: iso(r.created_at)!,
        createdByPerson: r.created_by_person,
        imported: r.imported,
        assigneeUserId: r.assignee_user_id,
        stage: {
          id: r.stage_id,
          name: r.stage_name,
          index: r.stage_index,
          openStages: r.open_stages,
        },
        stageEnteredAt: iso(r.stage_entered_at)!,
        nextAction: r.next_action,
        nextActionAt: iso(r.next_action_at),
        firstResponseAt: iso(r.first_response_at),
        lastContactAt: iso(r.last_contact_at),
        qualification: q === 'qualified' || q === 'not_a_fit' || q === 'incomplete' ? q : null,
      },
      title: r.title,
      personName: nameOf(r.first_name, r.last_name),
      companyName: r.company_name,
      source: r.source,
    });
  }
  return out;
}

interface HotExtras {
  readonly personContactAt: string | null;
  readonly otherWonLeads: number;
  readonly pastVisits: number;
}

/**
 * For open leads: when someone on the team first reached out once the lead existed (their own text, email or
 * chat, a call they made or picked up, a visit), and whether the customer has bought or been seen before. The
 * AI teammate's, workflows' and HandsFreeOS's own messages aren't a person's contact.
 */
async function loadHotExtras(
  tx: Tx,
  workspaceId: string,
  leadIds: readonly string[],
  now: Date,
): Promise<Map<string, HotExtras>> {
  if (!leadIds.length) return new Map();
  const list = await rows<{
    id: string;
    person_contact_at: Date | null;
    other_won: number;
    past_visits: number;
  }>(
    tx,
    sql`select l.id,
          (select min(a.occurred_at) from app.activities a
            where a.workspace_id = l.workspace_id
              and (a.lead_id = l.id
                or (a.lead_id is null and a.person_id = l.person_id and a.created_at >= l.created_at))
              and private.activity_contact(a.kind, a.subtype) = 'outreach'
              and (a.actor_type = 'human' or a.author_user_id is not null
                or (a.kind = 'call' and a.meta ->> 'answeredByUserId' is not null))) as person_contact_at,
          (select count(*)::int from app.leads o
            where o.workspace_id = l.workspace_id and o.person_id = l.person_id and o.id <> l.id
              and o.status = 'won') as other_won,
          (select count(*)::int from app.appointment_attendees t join app.appointments p on p.id = t.appointment_id
            where t.workspace_id = l.workspace_id and t.person_id = l.person_id and p.starts_at < ${tsParam(now)}
              and (t.status = 'attended' or p.status = 'completed')) as past_visits
        from app.leads l
        where l.workspace_id = ${workspaceId} and l.id = any(${uuidArray(leadIds)})`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        personContactAt: iso(r.person_contact_at),
        otherWonLeads: r.other_won,
        pastVisits: r.past_visits,
      },
    ]),
  );
}

interface ConversationInfo {
  readonly id: string;
  readonly personId: string | null;
  readonly channel: 'sms' | 'email' | 'chat';
  readonly status: 'open' | 'snoozed' | 'closed';
  readonly assigneeUserId: string | null;
  readonly awaitingReplySince: string | null;
  readonly handledBy: 'none' | 'ai' | 'person';
  readonly needsPersonSince: string | null;
  readonly takenOverBy: string | null;
  readonly lastPreview: string | null;
  readonly lastMessageAt: string | null;
  readonly counterpart: string;
  readonly personName: string | null;
}

/** Conversations by id or customer, and in a sweep every one waiting on the business. */
async function loadConversations(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  personIds: readonly string[],
  all: boolean,
): Promise<Map<string, ConversationInfo>> {
  const list = await rows<{
    id: string;
    person_id: string | null;
    channel: 'sms' | 'email' | 'chat';
    status: 'open' | 'snoozed' | 'closed';
    assignee_user_id: string | null;
    awaiting_reply_since: Date | null;
    handled_by: 'none' | 'ai' | 'person';
    needs_person_since: Date | null;
    taken_over_by: string | null;
    last_preview: string | null;
    last_message_at: Date | null;
    counterpart: string;
    first_name: string | null;
    last_name: string | null;
  }>(
    tx,
    sql`select c.id, c.person_id, c.channel::text as channel, c.status::text as status, c.assignee_user_id,
          c.awaiting_reply_since, c.handled_by::text as handled_by, c.needs_person_since, c.taken_over_by,
          c.last_preview, c.last_message_at, c.counterpart, p.first_name, p.last_name
        from app.conversations c left join app.people p on p.id = c.person_id
        where c.workspace_id = ${workspaceId}
          and (c.id = any(${uuidArray(ids)}) or c.person_id = any(${uuidArray(personIds)})
            ${
              all
                ? sql`or (c.status = 'open' and (c.awaiting_reply_since is not null
                    or (c.handled_by = 'person' and c.needs_person_since is not null and c.taken_over_by is null)))`
                : sql``
            })`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        id: r.id,
        personId: r.person_id,
        channel: r.channel,
        status: r.status,
        assigneeUserId: r.assignee_user_id,
        awaitingReplySince: iso(r.awaiting_reply_since),
        handledBy: r.handled_by,
        needsPersonSince: iso(r.needs_person_since),
        takenOverBy: r.taken_over_by,
        lastPreview: r.last_preview,
        lastMessageAt: iso(r.last_message_at),
        counterpart: r.counterpart,
        personName: nameOf(r.first_name, r.last_name),
      },
    ]),
  );
}

/** The customers' own recent messages, newest first: the hot-lead signals read their words. */
async function loadCustomerWords(
  tx: Tx,
  workspaceId: string,
  personIds: readonly string[],
  now: Date,
): Promise<Map<string, { body: string; at: number }[]>> {
  const out = new Map<string, { body: string; at: number }[]>();
  if (!personIds.length) return out;
  const list = await rows<{ person_id: string; body_text: string; occurred_at: Date }>(
    tx,
    sql`select c.person_id, m.body_text, m.occurred_at
        from app.messages m join app.conversations c on c.id = m.conversation_id
        where c.workspace_id = ${workspaceId} and c.person_id = any(${uuidArray(personIds)})
          and m.direction = 'inbound' and m.body_text is not null and btrim(m.body_text) <> ''
          and m.occurred_at > ${tsParam(now)} - interval '30 days'
        order by m.occurred_at desc
        limit 2000`,
  );
  for (const r of list) {
    const words = out.get(r.person_id) ?? [];
    if (words.length < 20) words.push({ body: r.body_text, at: new Date(r.occurred_at).getTime() });
    out.set(r.person_id, words);
  }
  return out;
}

/** Each customer's most valuable open lead: the value behind a conversation, an approval or a task. */
async function loadTopLeads(
  tx: Tx,
  workspaceId: string,
  personIds: readonly string[],
): Promise<Map<string, LinkedLeadFacts>> {
  if (!personIds.length) return new Map();
  const list = await rows<{ person_id: string; id: string; value_cents: number }>(
    tx,
    sql`select distinct on (l.person_id) l.person_id, l.id, l.value_cents::float8 as value_cents
        from app.leads l
        where l.workspace_id = ${workspaceId} and l.person_id = any(${uuidArray(personIds)})
          and l.status = 'open' and l.archived_at is null
        order by l.person_id, l.value_cents desc, l.created_at, l.id`,
  );
  return new Map(
    list.map((r) => [
      r.person_id,
      { id: r.id, valueCents: Number(r.value_cents), status: 'open' as const },
    ]),
  );
}

interface AttendeeInfo {
  readonly appointment: AttentionFacts<'unconfirmed_appointment'>['appointment'];
  readonly attendee: AttentionFacts<'unconfirmed_appointment'>['attendee'];
  readonly lead: LinkedLeadFacts | null;
  readonly title: string;
  readonly personName: string | null;
}

/** Booked seats by id, and in a sweep every unconfirmed one-on-one booking starting within the window (and a day). */
async function loadAttendees(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
  now: Date,
  windowHours: number,
): Promise<Map<string, AttendeeInfo>> {
  const list = await rows<{
    id: string;
    person_id: string;
    status: 'booked' | 'cancelled' | 'no_show' | 'attended';
    confirmed_at: Date | null;
    confirm_asked_at: Date | null;
    appointment_id: string;
    kind: 'booking' | 'session';
    appointment_status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
    starts_at: Date;
    owner_user_id: string | null;
    title: string;
    lead_id: string | null;
    lead_value: number | null;
    lead_status: 'open' | 'won' | 'lost' | null;
    first_name: string | null;
    last_name: string | null;
  }>(
    tx,
    sql`select t.id, t.person_id, t.status::text as status, t.confirmed_at, t.confirm_asked_at,
          p.id as appointment_id, p.kind::text as kind, p.status::text as appointment_status, p.starts_at,
          coalesce(p.owner_user_id, (select s.user_id from app.appointment_staff s
            where s.appointment_id = p.id and s.role = 'host' order by s.user_id limit 1)) as owner_user_id,
          p.title, p.lead_id, l.value_cents::float8 as lead_value, l.status::text as lead_status,
          pp.first_name, pp.last_name
        from app.appointment_attendees t
        join app.appointments p on p.id = t.appointment_id
        join app.people pp on pp.id = t.person_id
        left join app.leads l on l.id = p.lead_id
        where t.workspace_id = ${workspaceId}
          and (t.id = any(${uuidArray(ids)})
            ${
              all
                ? sql`or (t.status = 'booked' and t.confirmed_at is null and p.status = 'scheduled'
                    and p.kind = 'booking' and p.starts_at > ${tsParam(now)}
                    and p.starts_at <= ${tsParam(now)} + ${`${windowHours + 24} hours`}::interval)`
                : sql``
            })`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        appointment: {
          id: r.appointment_id,
          kind: r.kind,
          status: r.appointment_status,
          startsAt: iso(r.starts_at)!,
          ownerUserId: r.owner_user_id,
        },
        attendee: {
          id: r.id,
          personId: r.person_id,
          status: r.status,
          confirmedAt: iso(r.confirmed_at),
          confirmAskedAt: iso(r.confirm_asked_at),
        },
        lead:
          r.lead_id && r.lead_status
            ? { id: r.lead_id, valueCents: Number(r.lead_value ?? 0), status: r.lead_status }
            : null,
        title: r.title,
        personName: nameOf(r.first_name, r.last_name),
      },
    ]),
  );
}

interface ApprovalInfo {
  readonly approval: AttentionFacts<'ai_approval'>['approval'];
  readonly personId: string | null;
  readonly leadId: string | null;
  readonly conversationId: string | null;
  readonly conversationAssigneeUserId: string | null;
  readonly personName: string | null;
  /** The workflow's name, or the AI teammate's. */
  readonly label: string;
  readonly preview: string | null;
}

/** A preview's words, whatever shape it was saved in. */
function previewText(preview: unknown): string | null {
  if (typeof preview === 'string') return preview;
  if (!preview || typeof preview !== 'object') return null;
  const p = preview as Record<string, unknown>;
  for (const key of ['summary', 'body', 'text', 'message', 'reply']) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object') {
      const inner = previewText(v);
      if (inner) return inner;
    }
  }
  return null;
}

/** Workflow approvals and AI teammate drafts by id, and in a sweep every pending one (never a test run's). */
async function loadApprovals(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
): Promise<Map<string, ApprovalInfo>> {
  const list = await rows<{
    id: string;
    source: 'workflow' | 'teammate';
    draft_kind: 'reply' | 'approval' | null;
    status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
    created_at: Date;
    expires_at: Date | null;
    approvers: string[] | null;
    person_id: string | null;
    lead_id: string | null;
    conversation_id: string | null;
    conversation_assignee: string | null;
    label: string;
    preview: unknown;
    first_name: string | null;
    last_name: string | null;
  }>(
    tx,
    sql`select a.id, 'workflow' as source, null as draft_kind, a.status::text as status, a.created_at, a.expires_at,
          a.approvers, r.person_id, r.lead_id, null::uuid as conversation_id,
          null::uuid as conversation_assignee, w.name as label, a.preview, p.first_name, p.last_name
        from app.workflow_approvals a
        join app.workflow_runs r on r.id = a.run_id
        join app.workflows w on w.id = a.workflow_id
        left join app.people p on p.id = r.person_id
        where a.workspace_id = ${workspaceId} and not r.is_test
          and (a.id = any(${uuidArray(ids)}) ${all ? sql`or a.status = 'pending'` : sql``})
        union all
        select d.id, 'teammate', d.kind, d.status::text, d.created_at, d.expires_at,
          array[]::uuid[], d.person_id, d.lead_id, d.conversation_id, c.assignee_user_id, t.name, d.preview,
          p.first_name, p.last_name
        from app.ai_teammate_drafts d
        join app.ai_teammates t on t.id = d.teammate_id
        left join app.conversations c on c.id = d.conversation_id
        left join app.people p on p.id = d.person_id
        where d.workspace_id = ${workspaceId}
          and (d.id = any(${uuidArray(ids)}) ${all ? sql`or d.status = 'pending'` : sql``})`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        approval: {
          id: r.id,
          source: r.source,
          draftKind:
            r.source === 'teammate' ? (r.draft_kind === 'approval' ? 'approval' : 'reply') : null,
          status: r.status,
          createdAt: iso(r.created_at)!,
          expiresAt: iso(r.expires_at),
          approvers: r.approvers ?? [],
        },
        personId: r.person_id,
        leadId: r.lead_id,
        conversationId: r.conversation_id,
        conversationAssigneeUserId: r.conversation_assignee,
        personName: nameOf(r.first_name, r.last_name),
        label: r.label,
        preview: previewText(r.preview),
      },
    ]),
  );
}

interface TaskInfo {
  readonly task: AttentionFacts<'overdue_task'>['task'];
  readonly personId: string | null;
  readonly lead: LinkedLeadFacts | null;
  readonly personName: string | null;
}

/** Tasks by id, and in a sweep every open task due by the day after tomorrow. */
async function loadTasks(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
  now: Date,
): Promise<Map<string, TaskInfo>> {
  const list = await rows<{
    id: string;
    title: string;
    due_at: Date | null;
    all_day: boolean;
    done_at: Date | null;
    assignee_user_id: string | null;
    person_id: string | null;
    lead_id: string | null;
    lead_value: number | null;
    lead_status: 'open' | 'won' | 'lost' | null;
    first_name: string | null;
    last_name: string | null;
  }>(
    tx,
    sql`select t.id, t.title, t.due_at, t.all_day, t.done_at, t.assignee_user_id, t.person_id, t.lead_id,
          l.value_cents::float8 as lead_value, l.status::text as lead_status, p.first_name, p.last_name
        from app.tasks t
        left join app.leads l on l.id = t.lead_id
        left join app.people p on p.id = t.person_id
        where t.workspace_id = ${workspaceId}
          and (t.id = any(${uuidArray(ids)})
            ${
              all
                ? sql`or (t.done_at is null and t.due_at is not null
                    and t.due_at <= ${tsParam(now)} + interval '2 days')`
                : sql``
            })`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        task: {
          id: r.id,
          title: r.title,
          dueAt: iso(r.due_at),
          allDay: r.all_day,
          doneAt: iso(r.done_at),
          assigneeUserId: r.assignee_user_id,
        },
        personId: r.person_id,
        lead:
          r.lead_id && r.lead_status
            ? { id: r.lead_id, valueCents: Number(r.lead_value ?? 0), status: r.lead_status }
            : null,
        personName: nameOf(r.first_name, r.last_name),
      },
    ]),
  );
}

// ---------- detection ----------

/** What an item shows beyond its facts, and what it links to. */
interface Presentation {
  readonly subjectType: AttentionSubjectType;
  readonly title: string;
  readonly detail: string | null;
  readonly conversationId: string | null;
}

const keyOf = (kind: string, subjectId: string) => `${kind}|${subjectId}`;

const counterpartLabel = (c: ConversationInfo): string =>
  c.channel === 'sms'
    ? formatPhone(c.counterpart)
    : c.channel === 'chat'
      ? 'Website visitor'
      : c.counterpart;

const detailOf = (text: string | null | undefined): string | null =>
  text?.trim() ? clipLine(text, DETAIL_MAX) : null;

interface Loaded {
  readonly leads: Map<string, LeadInfo>;
  readonly conversations: Map<string, ConversationInfo>;
  readonly attendees: Map<string, AttendeeInfo>;
  readonly approvals: Map<string, ApprovalInfo>;
  readonly tasks: Map<string, TaskInfo>;
}

/** Why an item's facts stopped holding, for its resolution and the audit log. */
function resolutionOf(
  row: AttentionItemRow,
  loaded: Loaded,
  ctx: AttentionContext,
  now: number,
): string {
  const kind = row.kind as AttentionKind;
  if (!ctx.settings.kinds[kind]) return 'turned_off';
  switch (kind) {
    case 'hot_lead':
    case 'unanswered_lead':
    case 'stale_opportunity':
    case 'missing_next_action': {
      const lead = loaded.leads.get(row.subjectId)?.facts;
      if (!lead) return 'subject_gone';
      if (lead.archived) return 'archived';
      if (lead.status !== 'open') return 'closed';
      if (kind === 'missing_next_action') return 'next_action_set';
      if (kind === 'stale_opportunity') return 'contacted';
      return lead.firstResponseAt ? 'contacted' : 'cooled_off';
    }
    case 'unconfirmed_appointment': {
      const a = loaded.attendees.get(row.subjectId);
      if (!a) return 'subject_gone';
      if (a.attendee.confirmedAt) return 'confirmed';
      if (a.attendee.status === 'cancelled' || a.appointment.status === 'cancelled')
        return 'cancelled';
      if (Date.parse(a.appointment.startsAt) <= now || a.appointment.status !== 'scheduled')
        return 'started';
      return 'rescheduled';
    }
    case 'ai_approval': {
      const a = loaded.approvals.get(row.subjectId)?.approval;
      if (!a) return 'subject_gone';
      if (a.status === 'approved' || a.status === 'rejected') return 'decided';
      if (a.status === 'cancelled') return 'cancelled';
      return 'expired';
    }
    case 'customer_waiting': {
      const c = loaded.conversations.get(row.subjectId);
      if (!c) return 'subject_gone';
      return c.status === 'closed' ? 'closed' : 'replied';
    }
    case 'overdue_task': {
      const t = loaded.tasks.get(row.subjectId)?.task;
      if (!t) return 'subject_gone';
      return t.doneAt ? 'done' : 'rescheduled';
    }
  }
}

// ---------- writing ----------

interface NextFacts {
  readonly personId: string | null;
  readonly leadId: string | null;
  readonly conversationId: string | null;
  readonly sinceAt: Date | null;
  readonly urgentFrom: Date | null;
  readonly dueAt: Date | null;
  readonly valueCents: number;
  readonly valueIsEstimate: boolean;
  readonly moneyKey: string | null;
  readonly probability: number;
  readonly confidence: number;
  readonly reasons: AttentionChip[];
  readonly title: string;
  readonly detail: string | null;
  readonly fingerprint: string;
}

const toDate = (s: string | null) => (s ? new Date(s) : null);

function nextFacts(c: AttentionCandidate, p: Presentation): NextFacts {
  const d: Detection = c.detection;
  return {
    personId: c.personId,
    leadId: c.leadId,
    conversationId: p.conversationId,
    sinceAt: toDate(d.since),
    urgentFrom: toDate(d.urgentFrom),
    dueAt: toDate(d.dueAt),
    valueCents: Math.max(0, Math.round(d.value)),
    valueIsEstimate: d.valueIsEstimate,
    moneyKey: d.moneyKey,
    probability: d.probability,
    confidence: d.confidence,
    reasons: [...d.reasons],
    title: p.title,
    detail: p.detail,
    fingerprint: d.fingerprint,
  };
}

const sameTime = (a: Date | null, b: Date | null) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);
const near = (a: number, b: number) => Math.abs(a - b) < 5e-4;
/** Chips compared by what they say, not by ticking words ("waiting 11 min" becomes "waiting 12 min"). */
const chipKey = (list: readonly unknown[]) =>
  JSON.stringify(
    (list as AttentionChip[]).map((c) => [
      c.code,
      c.since ?? null,
      c.until ?? null,
      c.since || c.until ? null : c.label,
    ]),
  );

function sameFacts(row: AttentionItemRow, n: NextFacts): boolean {
  return (
    row.personId === n.personId &&
    row.leadId === n.leadId &&
    row.conversationId === n.conversationId &&
    sameTime(row.sinceAt, n.sinceAt) &&
    sameTime(row.urgentFrom, n.urgentFrom) &&
    sameTime(row.dueAt, n.dueAt) &&
    Number(row.valueCents ?? 0) === n.valueCents &&
    row.valueIsEstimate === n.valueIsEstimate &&
    row.moneyKey === n.moneyKey &&
    near(row.probability, n.probability) &&
    near(row.confidence, n.confidence) &&
    chipKey(row.reasons) === chipKey(n.reasons) &&
    row.title === n.title &&
    row.detail === n.detail &&
    row.fingerprint === n.fingerprint
  );
}

const CLEAR_SNOOZE = { snoozedUntil: null, snoozedAt: null, snoozedBy: null } as const;
const CLEAR_DISMISS = { dismissedAt: null, dismissedBy: null, dismissReason: null } as const;
const CLEAR_HANDLED = {
  handledAt: null,
  handledBy: null,
  handledVia: null,
  handledUntil: null,
} as const;
const CLEAR_AUTO = {
  autoState: null,
  autoScheduledFor: null,
  autoDoneAt: null,
  autoSkipReason: null,
  autoCancelledBy: null,
} as const;

type Patch = Partial<typeof attentionItems.$inferInsert>;

/**
 * Brings the business's attention items in line with what holds now, for some subjects (and everything folding
 * ties to them) or for the whole business ('all', the hourly sweep). Returns the real transitions (for events,
 * alerts and automatic actions), the quietly refreshed items, and when to look again. Holds a per-business lock,
 * so two reconciles never race; writes nothing when nothing changed.
 */
export async function reconcile(
  tx: Tx,
  workspaceId: string,
  subjects: readonly AttentionSubjectRef[] | 'all',
  now: Date = new Date(),
): Promise<ReconcileResult> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`attn:${workspaceId}`}, 0))`,
  );
  const ctx = await loadAttentionContext(tx, workspaceId, now);
  const { settings, business } = ctx;
  const at = now.getTime();
  const all = subjects === 'all';

  // Which subjects, and the items already there.
  const scope = all ? emptySets() : await expand(tx, workspaceId, subjects);
  const scopeIds = () => [
    ...scope.leads,
    ...scope.conversations,
    ...scope.attendees,
    ...scope.approvals,
    ...scope.tasks,
  ];
  const existing: AttentionItemRow[] = [];
  if (all) {
    existing.push(
      ...(await tx
        .select()
        .from(attentionItems)
        .where(
          and(eq(attentionItems.workspaceId, workspaceId), ne(attentionItems.state, 'resolved')),
        )
        .for('update')),
    );
    for (const r of existing) addSubject(scope, r.subjectType, r.subjectId);
  } else if (scopeIds().length) {
    existing.push(
      ...(await tx
        .select()
        .from(attentionItems)
        .where(
          and(
            eq(attentionItems.workspaceId, workspaceId),
            inArray(attentionItems.subjectId, scopeIds()),
          ),
        )
        .for('update')),
    );
  }

  // The facts.
  const leads = await loadLeads(tx, workspaceId, [...scope.leads], all);
  const leadPersons = new Set(
    [...leads.values()].map((l) => l.facts.personId).filter((p): p is string => !!p),
  );
  const conversations = await loadConversations(
    tx,
    workspaceId,
    [...scope.conversations],
    [...leadPersons, ...scope.persons],
    all,
  );
  const openLeadIds = [...leads.values()]
    .filter((l) => l.facts.status === 'open' && !l.facts.archived)
    .map((l) => l.facts.id);
  const hot = await loadHotExtras(tx, workspaceId, openLeadIds, now);
  const words = await loadCustomerWords(tx, workspaceId, [...leadPersons], now);
  const attendees = await loadAttendees(
    tx,
    workspaceId,
    [...scope.attendees],
    all,
    now,
    settings.appointments.windowHours,
  );
  const approvals = await loadApprovals(tx, workspaceId, [...scope.approvals], all);
  const tasks = await loadTasks(tx, workspaceId, [...scope.tasks], all, now);
  const needTop = new Set<string>();
  for (const c of conversations.values()) if (c.personId) needTop.add(c.personId);
  for (const a of approvals.values()) if (a.personId && !a.leadId) needTop.add(a.personId);
  const topLeads = await loadTopLeads(tx, workspaceId, [...needTop]);
  const members = await workspaceUsers(tx, workspaceId, ctx.organizationId);
  const loaded: Loaded = { leads, conversations, attendees, approvals, tasks };

  // Detect.
  const candidates: AttentionCandidate[] = [];
  const present = new Map<string, Presentation>();
  const wakes = new Map<
    string,
    { subjectType: AttentionRecheck['subjectType']; subjectId: string; at: number }
  >();
  const wake = (
    subjectType: AttentionRecheck['subjectType'],
    subjectId: string,
    when: string | null,
  ) => {
    const t = when ? Date.parse(when) : NaN;
    if (!(t > at)) return;
    const k = `${subjectType}|${subjectId}`;
    const was = wakes.get(k);
    if (!was || t < was.at) wakes.set(k, { subjectType, subjectId, at: t });
  };
  const run = <K extends AttentionKind>(
    kind: K,
    facts: AttentionFacts<K>,
    subjectId: string,
    link: { leadId: string | null; personId: string | null },
    presentation: Presentation,
  ) => {
    const d = detectAttention(kind, facts, settings, now);
    if (d) {
      candidates.push({
        kind,
        subjectId,
        leadId: link.leadId,
        personId: link.personId,
        detection: d,
      });
      present.set(keyOf(kind, subjectId), presentation);
      wake(presentation.subjectType, subjectId, d.recheckAt);
    } else wake(presentation.subjectType, subjectId, attentionWakeAt(kind, facts, settings, now));
  };

  const byPerson = new Map<string, ConversationInfo[]>();
  for (const c of conversations.values())
    if (c.personId) byPerson.set(c.personId, [...(byPerson.get(c.personId) ?? []), c]);

  for (const l of leads.values()) {
    const lead = l.facts;
    const theirs = lead.personId ? (byPerson.get(lead.personId) ?? []) : [];
    const waiting = theirs
      .filter((c) => c.status === 'open' && c.awaitingReplySince)
      .sort((a, b) => Date.parse(a.awaitingReplySince!) - Date.parse(b.awaitingReplySince!))[0];
    const latest = [...theirs].sort(
      (a, b) => (timeOf(b.lastMessageAt) ?? 0) - (timeOf(a.lastMessageAt) ?? 0),
    )[0];
    const awaitingReplySince = waiting?.awaitingReplySince ?? null;
    // Their words since they began waiting, or since the lead came in (a message can arrive just before it).
    const from = awaitingReplySince
      ? Date.parse(awaitingReplySince)
      : Date.parse(lead.createdAt) - DAY;
    const said = (lead.personId ? (words.get(lead.personId) ?? []) : [])
      .filter((w) => w.at >= from)
      .slice(0, 10);
    const extras = hot.get(lead.id);
    const name = l.personName ?? l.companyName ?? 'Customer';
    const base = {
      subjectType: 'lead' as const,
      title: itemTitle(name, l.title),
      conversationId: waiting?.id ?? latest?.id ?? null,
    };
    const link = { leadId: lead.id, personId: lead.personId };
    run(
      'hot_lead',
      {
        business,
        lead,
        awaitingReplySince,
        customerWords: said.map((w) => w.body),
        repeat: {
          otherWonLeads: extras?.otherWonLeads ?? 0,
          pastVisits: extras?.pastVisits ?? 0,
        },
        personContactAt: extras?.personContactAt ?? null,
      },
      lead.id,
      link,
      { ...base, detail: detailOf(said[0]?.body) },
    );
    run('unanswered_lead', { business, lead }, lead.id, link, {
      ...base,
      detail: l.source ? detailOf(`From ${l.source}`) : null,
    });
    run('stale_opportunity', { business, lead }, lead.id, link, {
      ...base,
      detail: detailOf(lead.nextAction),
    });
    run('missing_next_action', { business, lead }, lead.id, link, {
      ...base,
      detail: detailOf(lead.nextAction),
    });
  }

  for (const c of conversations.values()) {
    const lead = c.personId ? (topLeads.get(c.personId) ?? null) : null;
    run(
      'customer_waiting',
      {
        business,
        conversation: {
          id: c.id,
          personId: c.personId,
          status: c.status,
          assigneeUserId: c.assigneeUserId,
          awaitingReplySince: c.awaitingReplySince,
          handledBy: c.handledBy,
          needsPersonSince: c.needsPersonSince,
          takenOverBy: c.takenOverBy,
        },
        replyThresholdMinutes: ctx.replyThresholdMinutes,
        lead,
      },
      c.id,
      { leadId: lead?.id ?? null, personId: c.personId },
      {
        subjectType: 'conversation',
        title: itemTitle(c.personName ?? counterpartLabel(c)),
        detail: detailOf(c.lastPreview),
        conversationId: c.id,
      },
    );
  }

  for (const a of attendees.values())
    run(
      'unconfirmed_appointment',
      { business, appointment: a.appointment, attendee: a.attendee, lead: a.lead },
      a.attendee.id,
      { leadId: a.lead?.id ?? null, personId: a.attendee.personId },
      {
        subjectType: 'attendee',
        title: itemTitle(a.personName ?? 'Customer', a.title),
        detail: whenLabel(Date.parse(a.appointment.startsAt), ctx.timeZone),
        conversationId: null,
      },
    );

  for (const a of approvals.values()) {
    const lead: LinkedLeadFacts | null = a.leadId
      ? (leads.get(a.leadId)?.facts ?? { id: a.leadId, valueCents: 0, status: 'open' })
      : a.personId
        ? (topLeads.get(a.personId) ?? null)
        : null;
    const label =
      a.approval.source === 'workflow'
        ? `Workflow: ${a.label}`
        : a.approval.draftKind === 'approval'
          ? `${a.label} asks to approve`
          : `${a.label}’s reply`;
    run(
      'ai_approval',
      {
        business,
        approval: a.approval,
        lead,
        conversationAssigneeUserId: a.conversationAssigneeUserId,
      },
      a.approval.id,
      { leadId: lead?.id ?? null, personId: a.personId },
      {
        subjectType: 'approval',
        title: itemTitle(a.personName, label),
        detail: detailOf(a.preview),
        conversationId: a.conversationId,
      },
    );
  }

  for (const t of tasks.values())
    run(
      'overdue_task',
      { business, task: t.task, lead: t.lead },
      t.task.id,
      { leadId: t.lead?.id ?? null, personId: t.personId },
      {
        subjectType: 'task',
        title: itemTitle(t.task.title),
        detail: detailOf(t.personName),
        conversationId: null,
      },
    );

  // One card per lead.
  const cards = foldCandidates(candidates);
  const foldedKeys = new Set(cards.flatMap((c) => c.folded.map((f) => keyOf(f.kind, f.subjectId))));

  // A sweep also needs the resolved rows it may bring back.
  if (all) {
    const known = new Set(existing.map((r) => r.id));
    const reopenable = [...new Set(cards.map((c) => c.subjectId))];
    if (reopenable.length)
      for (const r of await tx
        .select()
        .from(attentionItems)
        .where(
          and(
            eq(attentionItems.workspaceId, workspaceId),
            eq(attentionItems.state, 'resolved'),
            inArray(attentionItems.subjectId, reopenable),
          ),
        )
        .for('update'))
        if (!known.has(r.id)) existing.push(r);
  }
  const rowByKey = new Map(existing.map((r) => [keyOf(r.kind, r.subjectId), r]));

  const transitions: AttentionTransition[] = [];
  const updated: string[] = [];
  const inserts: (typeof attentionItems.$inferInsert)[] = [];
  const member = (u: string | null) => (u && members.has(u) ? u : null);
  const nowDate = new Date(at);
  const record = (
    type: AttentionTransition['type'],
    row: AttentionItemRow,
    from: AttentionState | null,
  ) =>
    transitions.push({
      type,
      itemId: row.id,
      kind: row.kind as AttentionKind,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      personId: row.personId,
      leadId: row.leadId,
      conversationId: row.conversationId,
      from,
      state: row.state,
      fingerprint: row.fingerprint,
      title: row.title,
      urgentFrom: iso(row.urgentFrom),
      assigneeUserId: row.assigneeUserId,
      reasons: row.reasons as unknown as AttentionChip[],
      resolution: row.resolution,
    });
  const finalRows = new Map(existing.map((r) => [r.id, r]));
  const write = async (row: AttentionItemRow, patch: Patch): Promise<AttentionItemRow> => {
    const [out] = await tx
      .update(attentionItems)
      .set(patch)
      .where(eq(attentionItems.id, row.id))
      .returning();
    finalRows.set(out!.id, out!);
    return out!;
  };

  const seen = new Set<string>();
  for (const card of cards) {
    const key = keyOf(card.kind, card.subjectId);
    seen.add(key);
    const p = present.get(key)!;
    const n = nextFacts(card, p);
    const ownerFollows = !ITEM_OWNED.has(card.kind);
    const assignee = member(card.detection.assignee);
    const row = rowByKey.get(key);
    if (!row) {
      inserts.push({
        workspaceId,
        kind: card.kind,
        subjectType: p.subjectType,
        subjectId: card.subjectId,
        ...n,
        reasons: n.reasons as never,
        state: 'open',
        openedAt: nowDate,
        assigneeUserId: assignee,
      });
      continue;
    }
    const factsPatch: Patch = {
      ...n,
      reasons: n.reasons as never,
      ...(ownerFollows ? { assigneeUserId: assignee } : {}),
    };
    const changedFacts = !sameFacts(row, n) || (ownerFollows && row.assigneeUserId !== assignee);
    const newFacts = row.fingerprint !== n.fingerprint;
    const reopen = (extra: Patch) => ({
      ...factsPatch,
      state: 'open' as const,
      openedAt: nowDate,
      ...extra,
      // New facts are a new chance for the automatic action; the same facts keep "once per item".
      ...(newFacts ? CLEAR_AUTO : {}),
      ...(ITEM_OWNED.has(card.kind) && newFacts
        ? { assigneeUserId: row.assigneeUserId ?? assignee }
        : {}),
    });
    switch (row.state) {
      case 'resolved': {
        const out = await write(row, reopen({ resolvedAt: null, resolution: null }));
        record('reopened', out, 'resolved');
        break;
      }
      case 'snoozed': {
        if (newFacts) record('reopened', await write(row, reopen(CLEAR_SNOOZE)), 'snoozed');
        else if (row.snoozedUntil && row.snoozedUntil.getTime() <= at)
          record(
            'unsnoozed',
            await write(row, { ...factsPatch, state: 'open', ...CLEAR_SNOOZE }),
            'snoozed',
          );
        else if (changedFacts) {
          await write(row, factsPatch);
          updated.push(row.id);
        }
        break;
      }
      case 'dismissed': {
        if (newFacts) record('reopened', await write(row, reopen(CLEAR_DISMISS)), 'dismissed');
        else if (changedFacts) {
          await write(row, factsPatch);
          updated.push(row.id);
        }
        break;
      }
      case 'handled': {
        if (newFacts || (row.handledUntil && row.handledUntil.getTime() <= at))
          record('reopened', await write(row, reopen(CLEAR_HANDLED)), 'handled');
        else if (changedFacts) {
          await write(row, factsPatch);
          updated.push(row.id);
        }
        break;
      }
      case 'open': {
        if (changedFacts) {
          await write(row, newFacts ? { ...factsPatch, ...CLEAR_AUTO } : factsPatch);
          updated.push(row.id);
        }
        break;
      }
    }
  }

  if (inserts.length)
    for (const row of await tx.insert(attentionItems).values(inserts).returning())
      record('opened', row, null);

  // What no longer holds.
  for (const row of existing) {
    const key = keyOf(row.kind, row.subjectId);
    if (seen.has(key) || row.state === 'resolved' || row.state === 'handled') continue;
    const folded = foldedKeys.has(key);
    // A dismissed or snoozed item that folded into another card keeps its state for when it comes back.
    if (folded && row.state !== 'open') continue;
    const resolution = folded ? 'folded' : resolutionOf(row, loaded, ctx, at);
    const out = await write(row, {
      state: 'resolved',
      resolvedAt: nowDate,
      resolution,
      ...CLEAR_SNOOZE,
      ...CLEAR_DISMISS,
      ...(row.autoState === 'scheduled'
        ? { autoState: 'skipped', autoSkipReason: 'resolved', autoDoneAt: nowDate }
        : {}),
    });
    record('resolved', out, row.state);
  }

  // When to look again: the detectors' moments, snoozes running out, handled items coming back.
  for (const r of finalRows.values()) {
    if (r.state === 'snoozed')
      wake(r.subjectType as AttentionSubjectType, r.subjectId, iso(r.snoozedUntil));
    if (r.state === 'handled')
      wake(r.subjectType as AttentionSubjectType, r.subjectId, iso(r.handledUntil));
  }
  const rechecks = [...wakes.values()]
    .sort((a, b) => a.at - b.at)
    .map((w) => ({
      subjectType: w.subjectType,
      subjectId: w.subjectId,
      at: new Date(w.at).toISOString(),
    }));

  return { transitions, updated, rechecks };
}

/** The subject type each kind's items are about (re-exported for the worker's rechecks). */
export const subjectTypeOf = (kind: AttentionKind): AttentionSubjectType =>
  ATTENTION_SUBJECT_OF[kind];
