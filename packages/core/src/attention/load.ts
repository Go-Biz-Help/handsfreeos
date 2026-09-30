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
import { localInstant } from '../calendar/engine/zoned';
import { uuidArray } from '../calendar/load';
import { callPreview } from '../commands/call';
import { formatPhone } from '../crm/phone';
import type { QuietHoursWindow } from '../messaging/quiet-hours';
import { workspaceMessaging } from '../messaging/store';
import { money } from '../money/format';
import { overdueFrom, type EstimateStatus, type InvoiceStatus } from '../money/status';
import { balanceCents } from '../money/totals';
import { expiryPhrase } from '../money/words';
import { openHoursOf } from '../schemas/workspace';
import type { BusinessFacts, LeadFacts, LinkedLeadFacts } from './facts';
import { foldCandidates } from './folding';
import {
  loadMaintenance,
  loadReferrals,
  loadThankYous,
  thankYouSwitchOn,
  type MaintenanceInfo,
  type ReferralInfo,
  type ThankYouInfo,
} from './load-after-job';
import {
  loadDealStates,
  loadJobs,
  loadPrices,
  type DealState,
  type JobInfo,
  type PriceState,
} from './load-pipeline-jobs';
import {
  loadChannels,
  loadConnections,
  loadGaps,
  loadLessons,
  loadOffers,
  loadTextingRegistrations,
  loadScans,
  loadTeammates,
  type ChannelInfo,
  type ConnectionInfo,
  type GapInfo,
  type LessonInfo,
  type OfferInfo,
  type TextingRegistrationInfo,
  type ScanInfo,
  type TeammateInfo,
} from './load-health';
import {
  loadPromises,
  loadRegulars,
  loadRevenue,
  type PromiseInfo,
  type RegularInfo,
} from './load-service';
import { automationSettingsOf } from '../automations/settings';
import { ATTENTION_SUBJECT_OF, type AttentionKind, type AttentionSubjectType } from './kinds';
import type { ChannelKind } from './detectors/channel-quiet';
import type { ConnectionSystem } from './detectors/connection';
import { textingRejectedWords } from './detectors/texting-rejected';
import { loadAddonAlerts, type AddonAlertInfo } from './load-addon-alerts';
import { attentionWakeAt, detectAttention, type AttentionFacts } from './registry';
import { attentionSettingsOf, type AttentionSettings } from './settings';
import type { AttentionCandidate, AttentionChip, Detection } from './types';
import {
  clipLine,
  customerMessageLine,
  dayLabel,
  DETAIL_MAX,
  itemTitle,
  whenLabel,
} from './wording';

export type AttentionItemRow = typeof attentionItems.$inferSelect;
export type AttentionState = AttentionItemRow['state'];

/** What changed, and whose facts to look at again: a record, or a customer (their leads and conversations). */
export interface AttentionSubjectRef {
  readonly type:
    | 'lead'
    | 'person'
    | 'conversation'
    | 'attendee'
    | 'approval'
    | 'task'
    | 'estimate'
    | 'invoice'
    | 'thank_you'
    | 'referral'
    | 'maintenance'
    | 'appointment'
    | 'promise'
    | 'payment_connection'
    | 'calendar_connection'
    | 'mailbox'
    | 'review_connection'
    | 'phone_number'
    | 'teammate'
    | 'lesson'
    | 'scan'
    | 'suggestion'
    | 'offer'
    | 'registration'
    | 'addon_alert';
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

/** Resolutions that mean someone (or HandsFreeOS) dealt with it (browser-safe, in `view.ts`). */
export { DONE_RESOLUTIONS } from './view';

/**
 * Kinds whose assignee is the item's own (for the rest it follows the lead, conversation or task). A money
 * card is one of them: `attention.assign` says plainly that it moves who follows the estimate or the invoice
 * up and leaves the document as it is, so the next sweep must not hand it back to whoever wrote it. A card
 * still starts out with the document's assignee.
 */
const ITEM_OWNED: ReadonlySet<AttentionKind> = new Set([
  'unconfirmed_appointment',
  'ai_approval',
  'estimate_waiting',
  'invoice_overdue',
  'job_not_thanked',
  'referral_mentioned',
  'maintenance_due',
  'pipeline_mismatch',
  'job_unconfirmed',
  'job_never_completed',
  'job_no_address',
  'promise_due',
]);

const DAY = 86_400_000;
const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();
const timeOf = (d: Date | string | null | undefined): number | null =>
  d === null || d === undefined ? null : new Date(d).getTime();
const tsParam = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const nameOf = (first: string | null, last: string | null): string | null =>
  `${first ?? ''} ${last ?? ''}`.trim() || null;

// ---------- the business ----------

/** The median value of the leads won in the 365 days before `now`, in cents; null when none was won. */
export async function medianWonCents(
  tx: Tx,
  workspaceId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const [won] = await rows<{ cents: number | null }>(
    tx,
    sql`select percentile_cont(0.5) within group (order by value_cents)::float8 as cents
        from app.leads
        where workspace_id = ${workspaceId} and status = 'won' and value_cents > 0
          and won_at > ${tsParam(now)} - interval '365 days'`,
  );
  return won?.cents === null || won?.cents === undefined ? null : Number(won.cents);
}

export async function loadAttentionContext(
  tx: Tx,
  workspaceId: string,
  now: Date = new Date(),
): Promise<AttentionContext> {
  const m = await workspaceMessaging(tx, workspaceId);
  const median = await medianWonCents(tx, workspaceId, now);
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
      medianWonCents: median,
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
  readonly estimates: Set<string>;
  readonly invoices: Set<string>;
  readonly thankYous: Set<string>;
  readonly referrals: Set<string>;
  readonly maintenance: Set<string>;
  readonly appointments: Set<string>;
  readonly promises: Set<string>;
  // Health and quality (4b): the business's own set-up.
  readonly connections: Set<string>;
  readonly teammates: Set<string>;
  readonly lessons: Set<string>;
  readonly scans: Set<string>;
  readonly suggestions: Set<string>;
  // Promotions: the business's offers.
  readonly offers: Set<string>;
  // Getting started: the business's texting registrations.
  readonly registrations: Set<string>;
  // Add-ons: what they raised (app.addon_alerts).
  readonly addonAlerts: Set<string>;
}

const emptySets = (): SubjectSets => ({
  leads: new Set(),
  conversations: new Set(),
  attendees: new Set(),
  approvals: new Set(),
  tasks: new Set(),
  persons: new Set(),
  estimates: new Set(),
  invoices: new Set(),
  thankYous: new Set(),
  referrals: new Set(),
  maintenance: new Set(),
  appointments: new Set(),
  promises: new Set(),
  connections: new Set(),
  teammates: new Set(),
  lessons: new Set(),
  scans: new Set(),
  suggestions: new Set(),
  offers: new Set(),
  registrations: new Set(),
  addonAlerts: new Set(),
});

/** A connection's card is stored under its own table's type. */
const CONNECTION_TYPES: ReadonlySet<string> = new Set([
  'payment_connection',
  'calendar_connection',
  'mailbox',
  'review_connection',
  'phone_number',
]);

function addSubject(s: SubjectSets, type: string, id: string): void {
  if (type === 'lead') s.leads.add(id);
  else if (type === 'conversation') s.conversations.add(id);
  else if (type === 'attendee') s.attendees.add(id);
  else if (type === 'approval') s.approvals.add(id);
  else if (type === 'task') s.tasks.add(id);
  else if (type === 'person') s.persons.add(id);
  else if (type === 'estimate') s.estimates.add(id);
  else if (type === 'invoice') s.invoices.add(id);
  else if (type === 'thank_you') s.thankYous.add(id);
  else if (type === 'referral') s.referrals.add(id);
  else if (type === 'maintenance') s.maintenance.add(id);
  else if (type === 'appointment') s.appointments.add(id);
  else if (type === 'promise') s.promises.add(id);
  else if (CONNECTION_TYPES.has(type)) s.connections.add(id);
  else if (type === 'teammate') s.teammates.add(id);
  else if (type === 'lesson') s.lessons.add(id);
  else if (type === 'scan') s.scans.add(id);
  else if (type === 'suggestion') s.suggestions.add(id);
  else if (type === 'offer') s.offers.add(id);
  else if (type === 'registration') s.registrations.add(id);
  else if (type === 'addon_alert') s.addonAlerts.add(id);
}

/**
 * The subjects to look at, widened to what folding needs: a lead or a conversation brings in its customer, and a
 * customer brings in all their leads and conversations (one card per lead, and a waiting conversation joins it).
 *
 * A money document brings in its lead as well, because the two speak for each other: while an estimate is out
 * the lead stands down ("chase Tom about the quote" is one card, not two), so an estimate that is answered,
 * expires or is withdrawn has to let the lead's own card come back in the same breath.
 */
async function expand(
  tx: Tx,
  workspaceId: string,
  subjects: readonly AttentionSubjectRef[],
): Promise<SubjectSets> {
  const s = emptySets();
  for (const x of subjects) addSubject(s, x.type, x.id);
  // A thank-you or a referral brings in its customer, so writing to them settles both.
  if (s.thankYous.size || s.referrals.size || s.maintenance.size || s.promises.size) {
    const whose = await rows<{ person_id: string }>(
      tx,
      sql`select person_id from app.thank_yous
          where workspace_id = ${workspaceId} and id = any(${uuidArray([...s.thankYous])})
          union all
          select referrer_person_id from app.referrals
          where workspace_id = ${workspaceId} and id = any(${uuidArray([...s.referrals])})
          union all
          select person_id from app.maintenance_reminders
          where workspace_id = ${workspaceId} and id = any(${uuidArray([...s.maintenance])})
          union all
          select person_id from app.promises
          where workspace_id = ${workspaceId} and id = any(${uuidArray([...s.promises])})`,
    );
    for (const w of whose) s.persons.add(w.person_id);
  }
  if (s.estimates.size || s.invoices.size) {
    const documents = await rows<{ lead_id: string | null; person_id: string | null }>(
      tx,
      sql`select lead_id, person_id from app.estimates
          where workspace_id = ${workspaceId} and id = any(${uuidArray([...s.estimates])})
          union all
          select lead_id, person_id from app.invoices
          where workspace_id = ${workspaceId} and id = any(${uuidArray([...s.invoices])})`,
    );
    for (const d of documents) {
      if (d.lead_id) s.leads.add(d.lead_id);
      if (d.person_id) s.persons.add(d.person_id);
    }
  }
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
          where workspace_id = ${workspaceId} and person_id = any(${uuidArray([...s.persons])})
          union all
          select 'thank_you', id from app.thank_yous
          where workspace_id = ${workspaceId} and person_id = any(${uuidArray([...s.persons])})
            and outcome = 'card'
          union all
          select 'referral', id from app.referrals
          where workspace_id = ${workspaceId}
            and referrer_person_id = any(${uuidArray([...s.persons])}) and status = 'mentioned'
          union all
          select 'maintenance', id from app.maintenance_reminders
          where workspace_id = ${workspaceId} and person_id = any(${uuidArray([...s.persons])})
            and status = 'card'
          union all
          select distinct 'appointment', a.id from app.appointments a
          join app.appointment_attendees aa on aa.appointment_id = a.id
          where a.workspace_id = ${workspaceId} and aa.person_id = any(${uuidArray([...s.persons])})
            and a.status = 'scheduled' and a.starts_at > now() - interval '31 days'
            and a.starts_at < now() + interval '4 days'
          union all
          select 'promise', id from app.promises
          where workspace_id = ${workspaceId} and person_id = any(${uuidArray([...s.persons])})
            and status = 'open'`,
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
    estimate_out_at: Date | null;
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
          l.qualification ->> 'status' as qualification,
          -- M9: an estimate of theirs that is out, unanswered and still good. While one is, the estimate's
          -- own card speaks for this lead and the stale and next-action detectors stand down.
          (select max(e.sent_at) from app.estimates e
            where e.lead_id = l.id and e.status = 'sent'
              and (e.expires_on is null or e.expires_on >= current_date)) as estimate_out_at,
          l.source,
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
        estimateOutAt: iso(r.estimate_out_at),
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
  /** Automations told the owners a hand-off still waits (`conversation.handoff_escalated`). */
  readonly escalated: boolean;
  readonly lastMessageAt: string | null;
  readonly counterpart: string;
  readonly personName: string | null;
  /** What the customer said last in it; null when they haven't written or called. */
  readonly said: CustomerSaid | null;
}

/** What a customer said last in a conversation, for a card, the urgent email and a push. */
export interface CustomerSaid {
  /** Their message in one line (customerMessageLine), or a call of theirs nobody answered ("Missed call"). */
  readonly words: string;
  /** Photos in that message. */
  readonly photos: number;
  readonly at: string;
}

/**
 * What each conversation's customer said last: their newest message, or a call of theirs nobody answered when it
 * came after it. Never the business's own words, however recent (an automatic receipt, the AI teammate's reply),
 * which is what the conversation's `last_preview` holds. A conversation they never wrote or called in is left out.
 */
export async function loadCustomerSaid(
  tx: Tx,
  conversationIds: readonly string[],
): Promise<Map<string, CustomerSaid>> {
  const out = new Map<string, CustomerSaid>();
  if (!conversationIds.length) return out;
  const list = await rows<{
    id: string;
    channel: string | null;
    subject: string | null;
    body: string | null;
    photos: number | null;
    message_at: Date | null;
    voicemail: boolean | null;
    recording_seconds: number | null;
    transcript: string | null;
    call_at: Date | null;
  }>(
    tx,
    sql`select c.id, m.channel, m.subject, m.body, m.photos, m.occurred_at as message_at,
          k.is_voicemail as voicemail, k.recording_seconds, k.transcript, k.started_at as call_at
        from unnest(${uuidArray(conversationIds)}) as c(id)
        left join lateral (
          select m.channel::text as channel, m.subject, m.body_text as body,
            coalesce(jsonb_array_length(m.media), 0)::int as photos, m.occurred_at
          from app.messages m
          where m.conversation_id = c.id and m.direction = 'inbound'
          order by m.occurred_at desc, m.id desc
          limit 1
        ) m on true
        left join lateral (
          select k.is_voicemail, k.recording_seconds, k.transcript, k.started_at
          from app.calls k
          where k.conversation_id = c.id and k.direction = 'inbound' and k.answered_at is null
            and k.ended_at is not null
            -- As the thread shows calls: one through someone's own cell only once it reached the customer.
            and (k.answered_via is distinct from 'bridge' or k.answered_by_user_id is not null)
          order by k.started_at desc, k.id desc
          limit 1
        ) k on true`,
  );
  for (const r of list) {
    const messageAt = timeOf(r.message_at);
    const callAt = timeOf(r.call_at);
    if (callAt !== null && (messageAt === null || callAt > messageAt)) {
      const words = callPreview({
        direction: 'inbound',
        answeredAt: null,
        durationSeconds: null,
        isVoicemail: !!r.voicemail,
        recordingSeconds: r.recording_seconds,
        transcript: r.transcript,
      });
      out.set(r.id, { words, photos: 0, at: iso(r.call_at)! });
    } else if (messageAt !== null) {
      const photos = r.photos ?? 0;
      const words = customerMessageLine({
        channel: r.channel ?? 'sms',
        subject: r.subject,
        body: r.body,
        photos,
      });
      if (words) out.set(r.id, { words, photos, at: iso(r.message_at)! });
    }
  }
  return out;
}

/**
 * From when a lead's card quotes its customer: since they began waiting for a reply, or else since a day before the
 * lead came in (a message can arrive just before its lead). Older words aren't about this lead.
 */
export function leadWordsSince(
  lead: { readonly createdAt: Date | string },
  awaitingReplySince: Date | string | null,
): number {
  return awaitingReplySince !== null
    ? new Date(awaitingReplySince).getTime()
    : new Date(lead.createdAt).getTime() - DAY;
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
    escalated: boolean;
    last_message_at: Date | null;
    counterpart: string;
    first_name: string | null;
    last_name: string | null;
  }>(
    tx,
    sql`select c.id, c.person_id, c.channel::text as channel, c.status::text as status, c.assignee_user_id,
          c.awaiting_reply_since, c.handled_by::text as handled_by, c.needs_person_since, c.taken_over_by,
          c.needs_person_since is not null and exists (select 1 from app.events e
            where e.entity_type = 'conversation' and e.entity_id = c.id
              and e.event_type = 'conversation.handoff_escalated'
              and e.created_at >= c.needs_person_since) as escalated,
          c.last_message_at, c.counterpart, p.first_name, p.last_name
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
  const said = await loadCustomerSaid(
    tx,
    list.map((r) => r.id),
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
        escalated: r.escalated,
        lastMessageAt: iso(r.last_message_at),
        counterpart: r.counterpart,
        personName: nameOf(r.first_name, r.last_name),
        said: said.get(r.id) ?? null,
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
    capacity: number;
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
          p.id as appointment_id, p.kind::text as kind, p.capacity, p.status::text as appointment_status,
          p.starts_at,
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
                    and p.kind = 'booking' and p.capacity = 1 and p.starts_at > ${tsParam(now)}
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
          capacity: r.capacity,
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
    draft_kind: 'reply' | 'approval' | 'call' | null;
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
            r.source === 'teammate'
              ? r.draft_kind === 'approval' || r.draft_kind === 'call'
                ? r.draft_kind
                : 'reply'
              : null,
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

// ---------- the money documents ----------

/** The customer a document is for: their own name, else the company they belong to. */
const customerOf = (r: {
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
}): string => nameOf(r.first_name, r.last_name) ?? r.company_name ?? 'Customer';

interface EstimateInfo {
  readonly estimate: AttentionFacts<'estimate_waiting'>['estimate'];
  readonly personId: string;
  readonly leadId: string | null;
  readonly customer: string;
  readonly title: string | null;
  readonly number: string | null;
  /** When they first opened it, for the detail line. */
  readonly viewedAt: string | null;
  readonly expiresOn: string | null;
  readonly sentAt: string | null;
}

/**
 * Estimates by id, and in a sweep every one that is out: sent and unanswered. The detector decides what to do
 * with an expired one (nothing: the business reissues it), so they all come in and it judges.
 */
async function loadEstimates(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
  timeZone: string,
): Promise<Map<string, EstimateInfo>> {
  const list = await rows<{
    id: string;
    status: EstimateStatus;
    total_cents: number;
    sent_at: Date | null;
    first_viewed_at: Date | null;
    expires_on: string | null;
    assignee_user_id: string | null;
    person_id: string;
    lead_id: string | null;
    number: string | null;
    title: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
  }>(
    tx,
    sql`select e.id, e.status::text as status, e.total_cents::float8 as total_cents, e.sent_at,
          e.first_viewed_at, e.expires_on::text as expires_on, e.assignee_user_id, e.person_id, e.lead_id,
          e.number, e.title, p.first_name, p.last_name, c.name as company_name
        from app.estimates e
        join app.people p on p.id = e.person_id
        left join app.companies c on c.id = p.company_id
        where e.workspace_id = ${workspaceId}
          and (e.id = any(${uuidArray(ids)}) ${all ? sql`or e.status = 'sent'` : sql``})`,
  );
  const out = new Map<string, EstimateInfo>();
  for (const r of list)
    out.set(r.id, {
      estimate: {
        id: r.id,
        status: r.status,
        totalCents: Number(r.total_cents),
        sentAt: iso(r.sent_at),
        viewedAt: iso(r.first_viewed_at),
        // It is good until its last day is over where the business is, not at UTC midnight.
        expiresAt: r.expires_on
          ? new Date(overdueFrom(r.expires_on, timeZone)).toISOString()
          : null,
        assigneeUserId: r.assignee_user_id,
      },
      personId: r.person_id,
      leadId: r.lead_id,
      customer: customerOf(r),
      title: r.title,
      number: r.number,
      viewedAt: iso(r.first_viewed_at),
      expiresOn: r.expires_on,
      sentAt: iso(r.sent_at),
    });
  return out;
}

interface InvoiceInfo {
  readonly invoice: AttentionFacts<'invoice_overdue'>['invoice'];
  readonly settling: boolean;
  readonly personId: string;
  readonly leadId: string | null;
  readonly customer: string;
  readonly title: string | null;
  readonly number: string | null;
  readonly dueOn: string | null;
  readonly sentAt: string | null;
  readonly paidCents: number;
}

/**
 * Invoices by id, and in a sweep every open one with a due day. `settling` is a payment on its way — a bank
 * transfer takes days, and an invoice being paid is never late.
 */
async function loadInvoices(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
): Promise<Map<string, InvoiceInfo>> {
  const list = await rows<{
    id: string;
    status: InvoiceStatus;
    due_on: string | null;
    total_cents: number;
    amount_paid_cents: number;
    amount_refunded_cents: number;
    first_viewed_at: Date | null;
    assignee_user_id: string | null;
    settling: boolean;
    person_id: string;
    lead_id: string | null;
    number: string | null;
    title: string | null;
    sent_at: Date | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
  }>(
    tx,
    sql`select i.id, i.status::text as status, i.due_on::text as due_on,
          i.total_cents::float8 as total_cents, i.amount_paid_cents::float8 as amount_paid_cents,
          i.amount_refunded_cents::float8 as amount_refunded_cents, i.first_viewed_at,
          i.assignee_user_id,
          exists (select 1 from app.payments y where y.invoice_id = i.id and y.status = 'processing')
            as settling,
          i.person_id, i.lead_id, i.number, i.title, i.sent_at,
          p.first_name, p.last_name, c.name as company_name
        from app.invoices i
        join app.people p on p.id = i.person_id
        left join app.companies c on c.id = p.company_id
        where i.workspace_id = ${workspaceId}
          and (i.id = any(${uuidArray(ids)})
            ${
              all
                ? sql`or (i.status in ('sent', 'partly_paid', 'overdue') and i.due_on is not null)`
                : sql``
            })`,
  );
  const out = new Map<string, InvoiceInfo>();
  for (const r of list)
    out.set(r.id, {
      invoice: {
        id: r.id,
        status: r.status,
        dueDate: r.due_on,
        totalCents: Number(r.total_cents),
        paidCents: Number(r.amount_paid_cents),
        refundedCents: Number(r.amount_refunded_cents),
        viewedAt: iso(r.first_viewed_at),
        assigneeUserId: r.assignee_user_id,
      },
      settling: r.settling,
      personId: r.person_id,
      leadId: r.lead_id,
      customer: customerOf(r),
      title: r.title,
      number: r.number,
      dueOn: r.due_on,
      sentAt: iso(r.sent_at),
      paidCents: Number(r.amount_paid_cents),
    });
  return out;
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

/** "Ava was corrected", "Ava keeps being corrected", or, when it clashes, what the card asks. */
function lessonTitle(
  name: string,
  lesson: Pick<LessonInfo['lesson'], 'corrections' | 'conflict'>,
): string {
  if (lesson.conflict) return `${name} was corrected · which is right?`;
  return lesson.corrections > 1 ? `${name} keeps being corrected` : `${name} was corrected`;
}

interface Loaded {
  readonly leads: Map<string, LeadInfo>;
  readonly conversations: Map<string, ConversationInfo>;
  readonly attendees: Map<string, AttendeeInfo>;
  readonly approvals: Map<string, ApprovalInfo>;
  readonly tasks: Map<string, TaskInfo>;
  readonly estimates: Map<string, EstimateInfo>;
  readonly invoices: Map<string, InvoiceInfo>;
  readonly thankYous: Map<string, ThankYouInfo>;
  readonly referrals: Map<string, ReferralInfo>;
  readonly maintenance: Map<string, MaintenanceInfo>;
  readonly deals: Map<string, DealState>;
  readonly prices: Map<string, PriceState>;
  readonly jobs: Map<string, JobInfo>;
  readonly regulars: Map<string, RegularInfo>;
  readonly promises: Map<string, PromiseInfo>;
  readonly connections: Map<string, ConnectionInfo>;
  readonly teammates: Map<string, TeammateInfo>;
  readonly lessons: Map<string, LessonInfo>;
  readonly scans: Map<string, ScanInfo>;
  readonly gaps: Map<string, GapInfo>;
  readonly offers: Map<string, OfferInfo>;
  readonly registrations: Map<string, TextingRegistrationInfo>;
  readonly addonAlerts: Map<string, AddonAlertInfo>;
}

/** The usage wallet, for M16's three cards. One per business, so there is nothing to key it by. */
interface WalletInfo {
  readonly workspaceId: string;
  /** How far along the wallet this business is. `off` means none of the three cards appears at all. */
  readonly stage: 'off' | 'warn' | 'enforce';
  readonly balanceCents: number;
  readonly floorCents: number;
  readonly autoTopup: boolean;
  readonly hasCard: boolean;
  readonly lowSince: string | null;
  readonly suspendedAt: string | null;
  readonly suspendedReason: string | null;
  readonly declinesInRow: number;
  readonly lastFailureMessage: string | null;
}

/**
 * A business's wallet, or null when it has never spent anything. Null is "nothing to say", not "empty": a
 * business that has not used its phone yet is not one whose balance ran out.
 */
async function loadWallet(tx: Tx, workspaceId: string): Promise<WalletInfo | null> {
  const [w] = await rows<{
    stage: string;
    balance_cents: number | string;
    floor_cents: number | string;
    auto_topup: boolean;
    has_card: boolean;
    low_warned_at: Date | null;
    suspended_at: Date | null;
    suspended_reason: string | null;
    declines_in_row: number;
    last_failure_message: string | null;
  }>(
    tx,
    sql`select w.stage::text as stage,
          w.balance_cents, w.floor_cents, w.auto_topup, w.method_token is not null as has_card,
          w.low_warned_at, w.suspended_at, w.suspended_reason, w.declines_in_row,
          (select r.failure_message from app.wallet_recharges r
            where r.workspace_id = w.workspace_id and r.status = 'failed'
            order by r.created_at desc limit 1) as last_failure_message
        from app.usage_wallets w where w.workspace_id = ${workspaceId}`,
  );
  if (!w) return null;
  return {
    workspaceId,
    // `agency` reads as `off`: a business its agency pays for has nothing to hear about its balance.
    stage: w.stage === 'warn' || w.stage === 'enforce' ? w.stage : 'off',
    balanceCents: Number(w.balance_cents),
    floorCents: Number(w.floor_cents),
    autoTopup: w.auto_topup,
    hasCard: w.has_card,
    lowSince: iso(w.low_warned_at),
    suspendedAt: iso(w.suspended_at),
    suspendedReason: w.suspended_reason,
    declinesInRow: w.declines_in_row,
    lastFailureMessage: w.last_failure_message,
  };
}

/**
 * What the wallet's card says under its title: the balance, and what would put it right.
 *
 * At `warn` it also says that nothing has stopped. A business seeing "Balance empty" for the first time will
 * assume the worst, and for them the worst is not true yet — the whole point of that stretch is that they find
 * out before it costs them a customer.
 */
function walletWords(w: WalletInfo): string {
  const balance =
    w.balanceCents < 0
      ? `${money(Math.abs(w.balanceCents))} over`
      : `${money(w.balanceCents)} left`;
  const soon =
    w.stage === 'warn' && w.balanceCents <= 0 ? ' · texts and calls still work for now' : '';
  if (w.suspendedAt) return `${balance} · the card on file was declined${soon}`;
  if (!w.hasCard) return `${balance} · no card on file${soon}`;
  if (!w.autoTopup) return `${balance} · automatic top-up is off${soon}`;
  return `${balance}${soon}`;
}

/** A quiet channel's card title. */
const CHANNEL_TITLES: Readonly<Record<ChannelKind, string>> = {
  text: 'Texts have gone quiet',
  call: 'Calls have gone quiet',
  email: 'Email has gone quiet',
  chat: 'Website chat has gone quiet',
};

/** What a connection is for, under its name. */
const CONNECTION_DETAILS: Readonly<Record<ConnectionSystem, string>> = {
  payments: 'Takes your customers’ payments',
  calendar: 'Keeps bookings off busy times',
  mailbox: 'Brings in and sends your email',
  reviews: 'Brings in your reviews',
  phone: 'Your business phone number',
};

/** "Thu, Sep 17" for a stored day (`2026-09-17`), read where the business is. */
const dayOf = (date: string, timeZone: string): string =>
  dayLabel(localInstant(date, '12:00', timeZone), timeZone);

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
      // Only a one-on-one booking is ever asked to confirm.
      if (a.appointment.kind !== 'booking' || (a.appointment.capacity ?? 1) !== 1)
        return 'group_booking';
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
    /**
     * An estimate stops waiting for several different reasons, and a person reading "3 handled today" should
     * only see the one where somebody got an answer: accepted or declined is answered, the rest is
     * housekeeping. A sent estimate whose day has passed is expired here before the job that stamps it gets
     * there, so the card never chases a price that is no longer good.
     */
    case 'estimate_waiting': {
      const e = loaded.estimates.get(row.subjectId);
      if (!e) return 'subject_gone';
      switch (e.estimate.status) {
        case 'accepted':
        case 'declined':
          return 'answered';
        case 'expired':
          return 'expired';
        case 'void':
        case 'draft':
          return 'withdrawn';
        default:
          if (e.estimate.expiresAt && Date.parse(e.estimate.expiresAt) <= now) return 'expired';
          // Still out and still good: the business gave its estimates longer, so this one isn't due to ask
          // about yet. Not an answer, and not a win for "handled today".
          return 'not_due';
      }
    }
    /**
     * An invoice stops being overdue when the money arrives, when it is on its way (a bank transfer settles for
     * days), when what is left is under the business's floor, or when the invoice is withdrawn.
     */
    case 'invoice_overdue': {
      const i = loaded.invoices.get(row.subjectId);
      if (!i) return 'subject_gone';
      if (i.invoice.status === 'void') return 'voided';
      if (i.invoice.status === 'draft' || !i.invoice.dueDate) return 'withdrawn';
      const owed = balanceCents(i.invoice.totalCents, i.invoice.paidCents, i.invoice.refundedCents);
      if (i.invoice.status === 'paid' || owed <= 0) return 'paid';
      if (i.settling) return 'settling';
      // Something is still owed: either a part payment took it under the business's floor, or the grace days
      // moved. Either way nobody paid it off, so it isn't "handled today".
      return i.invoice.paidCents > 0 ? 'part_paid' : 'not_due';
    }
    /**
     * The wallet's three stop holding when the balance comes back up, or the card is replaced. There is no
     * subject row of their own to look at — the wallet is the business — so the detector's own answer is the
     * only thing that could have changed, and it has, or this would not be resolving.
     */
    case 'wallet_low':
    case 'wallet_empty':
      return 'topped_up';
    case 'wallet_card_declined':
      return 'card_fixed';
    case 'job_not_thanked': {
      const t = loaded.thankYous.get(row.subjectId);
      if (!t) return 'subject_gone';
      if (!thankYouSwitchOn(ctx.rawSettings)) return 'turned_off';
      if (t.thankYou.contactedAt) return 'contacted';
      return 'expired';
    }
    case 'referral_mentioned': {
      const r = loaded.referrals.get(row.subjectId);
      if (!r) return 'subject_gone';
      if (r.referral.status === 'lead_created') return 'lead_created';
      if (r.referral.status === 'dismissed') return 'dismissed';
      return 'expired';
    }
    case 'client_quiet': {
      const r = loaded.regulars.get(row.subjectId);
      if (!r) return 'subject_gone';
      if (r.regular.bookedAhead) return 'booked';
      if (r.regular.lastContactAt) return 'contacted';
      return 'expired';
    }
    case 'promise_due': {
      const p = loaded.promises.get(row.subjectId);
      if (!p) return 'subject_gone';
      if (p.promise.status === 'dismissed') return 'dismissed';
      if (p.keptAt) return 'done';
      return 'expired';
    }
    // The week passed, or it came back into line: nothing was done about it either way.
    case 'revenue_moved':
      return 'expired';
    // Something came in again.
    case 'channel_quiet':
      return 'recovered';
    case 'connection_error':
    case 'connection_silent': {
      const c = loaded.connections.get(row.subjectId);
      if (!c) return 'subject_gone';
      return 'recovered';
    }
    case 'ai_unreviewed':
      return loaded.teammates.get(row.subjectId)?.teammate.status === 'off' ? 'turned_off' : 'done';
    case 'ai_corrections': {
      const l = loaded.lessons.get(row.subjectId);
      if (!l) return 'subject_gone';
      return l.lesson.status === 'applied' ? 'done' : 'dismissed';
    }
    case 'website_changed':
      return loaded.scans.has(row.subjectId) ? 'done' : 'expired';
    case 'offer_lapsing': {
      const o = loaded.offers.get(row.subjectId);
      if (!o) return 'subject_gone';
      if (o.archived) return 'archived';
      // Still running past its old end date: it was extended.
      return o.endsOn && localInstant(o.endsOn, '23:59', ctx.timeZone) > now ? 'done' : 'expired';
    }
    case 'addon_alert': {
      const a = loaded.addonAlerts.get(row.subjectId);
      if (!a) return 'subject_gone';
      if (!a.facts.addonRunning) return 'addon_off';
      // In the add-on's own word: `done` counts as handled today.
      return a.clearReason ?? 'cleared';
    }
    case 'texting_rejected': {
      const r = loaded.registrations.get(row.subjectId)?.registration;
      if (!r) return 'subject_gone';
      if (r.status === 'approved') return 'approved';
      if (r.status === 'submitted' || r.status === 'in_review') return 'sent_again';
      // Still turned down, but no longer the business's: its number changed, or a newer one was made.
      return 'superseded';
    }
    case 'faq_suggestions': {
      const g = loaded.gaps.get(row.subjectId);
      if (!g) return 'subject_gone';
      return g.suggestion.status === 'accepted' ? 'done' : 'dismissed';
    }
    case 'pipeline_mismatch': {
      const lead = loaded.leads.get(row.subjectId)?.facts;
      if (!lead) return 'subject_gone';
      if (lead.archived) return 'archived';
      if (lead.status !== 'open') return 'closed';
      return 'moved';
    }
    case 'quiet_after_price': {
      const lead = loaded.leads.get(row.subjectId)?.facts;
      if (!lead) return 'subject_gone';
      if (lead.archived) return 'archived';
      if (lead.status !== 'open') return 'closed';
      const p = loaded.prices.get(row.subjectId);
      if (p?.heardFromAt && p.price && p.heardFromAt > p.price.at) return 'replied';
      return 'expired';
    }
    case 'job_unconfirmed':
    case 'job_never_completed':
    case 'job_no_address': {
      const j = loaded.jobs.get(row.subjectId);
      if (!j) return 'subject_gone';
      const status = j.appointment.status;
      if (status === 'cancelled') return 'cancelled';
      if (status !== 'scheduled') return 'done';
      if (kind === 'job_no_address') {
        if (j.hasAddress) return 'address_added';
        if (Date.parse(j.appointment.startsAt) <= now) return 'started';
        return 'rescheduled';
      }
      return 'expired';
    }
    case 'maintenance_due': {
      const m = loaded.maintenance.get(row.subjectId);
      if (!m) return 'subject_gone';
      if (m.reminder.booked || m.reminder.status === 'booked') return 'booked';
      if (m.reminder.contactedAt) return 'contacted';
      if (m.reminder.status === 'stopped') return 'turned_off';
      return 'expired';
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
    ...scope.estimates,
    ...scope.invoices,
    ...scope.thankYous,
    ...scope.referrals,
    ...scope.maintenance,
    ...scope.appointments,
    ...scope.promises,
    // A regular gone quiet is about the person themselves.
    ...scope.persons,
    ...scope.connections,
    ...scope.teammates,
    ...scope.lessons,
    ...scope.scans,
    ...scope.suggestions,
    ...scope.offers,
    ...scope.registrations,
    ...scope.addonAlerts,
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
  const estimates = await loadEstimates(tx, workspaceId, [...scope.estimates], all, ctx.timeZone);
  const invoices = await loadInvoices(tx, workspaceId, [...scope.invoices], all);
  const thankYous = await loadThankYous(tx, workspaceId, [...scope.thankYous], all, now);
  const referrals = await loadReferrals(tx, workspaceId, [...scope.referrals], all, now);
  const maintenance = await loadMaintenance(tx, workspaceId, [...scope.maintenance], all, now);
  const deals = await loadDealStates(tx, workspaceId, openLeadIds, all, ctx.rawSettings);
  const prices = await loadPrices(
    tx,
    workspaceId,
    [...leads.values()]
      .filter((l) => l.facts.status === 'open' && !l.facts.archived)
      .map((l) => ({ id: l.facts.id, personId: l.facts.personId, createdAt: l.facts.createdAt })),
    now,
  );
  const jobs = await loadJobs(tx, workspaceId, [...scope.appointments], all, now, ctx.timeZone);
  const regulars = await loadRegulars(
    tx,
    workspaceId,
    [...scope.persons],
    all,
    now,
    ctx.timeZone,
    ctx.rawSettings,
  );
  const promises = await loadPromises(tx, workspaceId, [...scope.promises], all, now, ctx.timeZone);
  // Only on a full sweep, like the wallet: the business's week has no subject row to be woken by.
  const revenue = all ? await loadRevenue(tx, workspaceId, now, ctx.timeZone) : null;
  const automations = automationSettingsOf(ctx.rawSettings);
  const jobCheckOn = automations.switches.jobCheck;
  // Only on a full sweep: a wallet has no subject row to be woken by, so it is looked at when everything is.
  const walletInfo = all ? await loadWallet(tx, workspaceId) : null;
  // Health and quality. A channel has no row to be woken by either: full sweep only.
  const channels = all
    ? await loadChannels(tx, workspaceId, now, ctx.timeZone, business.openHours)
    : new Map<string, ChannelInfo>();
  const connections = await loadConnections(tx, workspaceId, [...scope.connections], all);
  const teammates = await loadTeammates(tx, workspaceId, [...scope.teammates], all, now);
  const lessons = await loadLessons(tx, workspaceId, [...scope.lessons], all);
  const scans = await loadScans(tx, workspaceId, [...scope.scans], all, now);
  const gaps = await loadGaps(tx, workspaceId, [...scope.suggestions], all);
  const offers = await loadOffers(tx, workspaceId, [...scope.offers], all);
  const registrations = await loadTextingRegistrations(
    tx,
    workspaceId,
    [...scope.registrations],
    all,
  );
  const addonAlerts = await loadAddonAlerts(tx, workspaceId, [...scope.addonAlerts], all);
  const members = await workspaceUsers(tx, workspaceId, ctx.organizationId);
  const loaded: Loaded = {
    leads,
    conversations,
    attendees,
    approvals,
    tasks,
    estimates,
    invoices,
    thankYous,
    referrals,
    maintenance,
    deals,
    prices,
    jobs,
    regulars,
    promises,
    connections,
    teammates,
    lessons,
    scans,
    gaps,
    offers,
    registrations,
    addonAlerts,
  };

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
    const from = leadWordsSince(lead, awaitingReplySince);
    const said = (lead.personId ? (words.get(lead.personId) ?? []) : [])
      .filter((w) => w.at >= from)
      .slice(0, 10);
    const extras = hot.get(lead.id);
    const name = l.personName ?? l.companyName ?? 'Customer';
    const card = waiting ?? latest;
    // What they said last in the card's conversation, when it's about this lead.
    const heard = card?.said && Date.parse(card.said.at) >= from ? card.said : null;
    const base = {
      subjectType: 'lead' as const,
      title: itemTitle(name, l.title),
      conversationId: card?.id ?? null,
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
      { ...base, detail: detailOf(heard?.words) },
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
    const priced = prices.get(lead.id);
    run(
      'quiet_after_price',
      {
        business,
        lead,
        price: priced?.price ?? null,
        heardFromAt: priced?.heardFromAt ?? null,
        estimateWaitingDays: settings.money.estimateWaitingDays,
      },
      lead.id,
      link,
      { ...base, detail: detailOf(lead.nextAction) },
    );
    const deal = deals.get(lead.id);
    if (deal)
      run(
        'pipeline_mismatch',
        { business, lead, deal, assigneeUserId: lead.assigneeUserId },
        lead.id,
        link,
        {
          ...base,
          detail: deal.target ? detailOf(`Belongs in ${deal.target.stageName}`) : null,
        },
      );
  }

  for (const r of regulars.values())
    run(
      'client_quiet',
      { business, regular: r.regular, lead: r.lead, assigneeUserId: r.assigneeUserId },
      r.regular.personId,
      { leadId: null, personId: r.regular.personId },
      {
        subjectType: 'person',
        title: itemTitle(r.personName ?? 'Customer', `${r.regular.visits} visits`),
        detail: `Last visit ${dayLabel(Date.parse(r.regular.lastVisitAt), ctx.timeZone)}`,
        conversationId: null,
      },
    );

  for (const p of promises.values())
    run(
      'promise_due',
      {
        business,
        promise: p.promise,
        keptAt: p.keptAt,
        lead: p.lead,
        assigneeUserId: p.assigneeUserId,
      },
      p.promise.id,
      { leadId: null, personId: p.personId },
      {
        subjectType: 'promise',
        title: itemTitle(p.personName ?? 'Customer', p.promise.what),
        detail: `Due ${p.promise.dueLabel}`,
        conversationId: p.conversationId,
      },
    );

  for (const c of channels.values())
    run(
      'channel_quiet',
      { business, channel: c.channel },
      c.channel.id,
      { leadId: null, personId: null },
      {
        subjectType: c.subjectType as AttentionSubjectType,
        title: CHANNEL_TITLES[c.channel.kind],
        detail: null,
        conversationId: null,
      },
    );

  for (const c of connections.values()) {
    const presentation = {
      subjectType: c.subjectType as AttentionSubjectType,
      title: c.connection.name,
      detail: CONNECTION_DETAILS[c.connection.system],
      conversationId: null,
    };
    const link = { leadId: null, personId: null };
    run(
      'connection_error',
      { business, connection: c.connection },
      c.connection.id,
      link,
      presentation,
    );
    run(
      'connection_silent',
      { business, connection: c.connection },
      c.connection.id,
      link,
      presentation,
    );
  }

  for (const t of teammates.values())
    run(
      'ai_unreviewed',
      { business, teammate: t.teammate },
      t.teammate.id,
      { leadId: null, personId: null },
      {
        subjectType: 'teammate',
        title: `${t.teammate.name}’s work`,
        detail:
          t.teammate.status === 'training'
            ? 'Its replies wait for someone to approve them'
            : 'It replies on its own',
        conversationId: null,
      },
    );

  for (const l of lessons.values())
    run(
      'ai_corrections',
      { business, lesson: l.lesson },
      l.lesson.id,
      { leadId: null, personId: null },
      {
        subjectType: 'lesson',
        title: lessonTitle(l.teammateName, l.lesson),
        detail: detailOf(l.explain ?? l.lesson.why),
        conversationId: null,
      },
    );

  for (const g of scans.values())
    run(
      'website_changed',
      { business, scan: g.scan },
      g.scan.id,
      { leadId: null, personId: null },
      {
        subjectType: 'scan',
        title: 'Your website changed',
        detail: detailOf(g.url),
        conversationId: null,
      },
    );

  for (const o of offers.values())
    run(
      'offer_lapsing',
      { business, offer: o },
      o.id,
      { leadId: null, personId: null },
      {
        subjectType: 'offer',
        title: `${o.name} is ending`,
        detail: null,
        conversationId: null,
      },
    );

  for (const r of registrations.values()) {
    const words = textingRejectedWords(r.registration.rejectionReason, r.number);
    run(
      'texting_rejected',
      { business, registration: r.registration },
      r.registration.id,
      { leadId: null, personId: null },
      {
        subjectType: 'registration',
        title: words.title,
        detail: words.detail,
        conversationId: null,
      },
    );
  }

  // An add-on's alert, in its own words. Its record (when it has one) comes from the alert itself, in the database.
  for (const a of addonAlerts.values())
    run(
      'addon_alert',
      a.facts,
      a.facts.alert.id,
      { leadId: null, personId: a.personId },
      {
        subjectType: 'addon_alert',
        title: clipLine(a.title, 200),
        detail: detailOf(a.detail),
        conversationId: null,
      },
    );

  for (const g of gaps.values())
    run(
      'faq_suggestions',
      { business, suggestion: g.suggestion },
      g.suggestion.id,
      { leadId: null, personId: null },
      {
        subjectType: 'suggestion',
        title: 'Customers keep asking',
        detail: detailOf(g.suggestion.question),
        conversationId: null,
      },
    );

  if (revenue)
    run(
      'revenue_moved',
      { business, ...revenue },
      workspaceId,
      { leadId: null, personId: null },
      {
        subjectType: 'revenue',
        title: 'Last week’s money in',
        detail: revenue.reason ? detailOf(revenue.reason) : null,
        conversationId: null,
      },
    );

  for (const j of jobs.values()) {
    const facts = {
      business,
      appointment: j.appointment,
      lead: j.lead,
      assigneeUserId: j.assigneeUserId,
    };
    const link = { leadId: j.lead?.id ?? null, personId: j.personId };
    const presentation = {
      subjectType: 'appointment' as const,
      title: itemTitle(j.personName ?? 'Customer', j.title),
      detail: whenLabel(Date.parse(j.appointment.startsAt), ctx.timeZone),
      conversationId: null,
    };
    run('job_unconfirmed', { ...facts, jobCheckOn }, j.appointment.id, link, presentation);
    run('job_never_completed', facts, j.appointment.id, link, presentation);
    run(
      'job_no_address',
      { ...facts, locationKind: j.locationKind, hasAddress: j.hasAddress },
      j.appointment.id,
      link,
      presentation,
    );
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
          escalated: c.escalated,
        },
        replyThresholdMinutes: ctx.replyThresholdMinutes,
        lead,
      },
      c.id,
      { leadId: lead?.id ?? null, personId: c.personId },
      {
        subjectType: 'conversation',
        title: itemTitle(c.personName ?? counterpartLabel(c)),
        detail: detailOf(c.said?.words),
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
          : a.approval.draftKind === 'call'
            ? `${a.label} asks to make a call`
            : `${a.label}’s reply`;
    run(
      'ai_approval',
      {
        business,
        approval: a.approval,
        lead,
        conversationAssigneeUserId: a.conversationAssigneeUserId,
        expiryWarn: automations.switches.approvalExpiry,
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

  // The money kinds. Their cards carry the document's own words — what it says and when it went out — so a
  // person can see what they are about to open without opening it.
  for (const e of estimates.values())
    run(
      'estimate_waiting',
      { estimate: e.estimate },
      e.estimate.id,
      { leadId: e.leadId, personId: e.personId },
      {
        subjectType: 'estimate',
        title: itemTitle(e.customer, e.title, e.number),
        detail: detailOf(
          [
            e.sentAt ? `Sent ${dayLabel(Date.parse(e.sentAt), ctx.timeZone)}` : null,
            e.viewedAt ? 'opened' : null,
            e.expiresOn ? expiryPhrase(e.expiresOn, now, ctx.timeZone) : null,
          ]
            .filter((p): p is string => p !== null)
            .join(' · '),
        ),
        conversationId: null,
      },
    );

  for (const i of invoices.values())
    run(
      'invoice_overdue',
      { business, invoice: i.invoice, hasProcessingPayment: i.settling },
      i.invoice.id,
      { leadId: i.leadId, personId: i.personId },
      {
        subjectType: 'invoice',
        title: itemTitle(i.customer, i.title, i.number),
        detail: detailOf(
          [
            i.sentAt ? `Sent ${dayLabel(Date.parse(i.sentAt), ctx.timeZone)}` : null,
            i.dueOn ? `due ${dayOf(i.dueOn, ctx.timeZone)}` : null,
            i.paidCents > 0 ? `${money(i.paidCents)} paid so far` : null,
          ]
            .filter((p): p is string => p !== null)
            .join(' · '),
        ),
        conversationId: null,
      },
    );

  /**
   * The wallet's three. The subject is the business itself, so they carry no person, lead or conversation, and
   * only one of them ever holds at a time — the detectors stand each other down rather than the fold doing it.
   */
  if (walletInfo)
    for (const kind of ['wallet_card_declined', 'wallet_empty', 'wallet_low'] as const)
      run(
        kind,
        { wallet: walletInfo },
        workspaceId,
        { leadId: null, personId: null },
        {
          subjectType: 'wallet',
          // The card is about the business's own balance, so the title says what it is rather than who.
          title: 'Your HandsFreeOS balance',
          detail: walletWords(walletInfo),
          conversationId: null,
        },
      );

  // After the job: a customer nobody could thank, and somebody a customer said needs the business.
  const thanking = thankYouSwitchOn(ctx.rawSettings);
  for (const t of thankYous.values())
    run(
      'job_not_thanked',
      {
        business,
        thankYou: t.thankYou,
        switchOn: thanking,
        lead: t.lead,
        assigneeUserId: t.assigneeUserId,
      },
      t.thankYou.id,
      { leadId: t.lead?.id ?? null, personId: t.personId },
      {
        subjectType: 'thank_you',
        title: itemTitle(t.personName ?? 'Customer', t.title),
        detail: detailOf(t.reason),
        conversationId: t.conversationId,
      },
    );

  for (const r of referrals.values())
    run(
      'referral_mentioned',
      { business, referral: r.referral, assigneeUserId: r.assigneeUserId },
      r.referral.id,
      { leadId: null, personId: r.referrerPersonId },
      {
        subjectType: 'referral',
        title: itemTitle(
          r.referrerName ?? 'A customer',
          r.referredName ? `Mentioned ${r.referredName}` : 'Mentioned somebody',
        ),
        detail: detailOf(r.quote),
        conversationId: r.conversationId,
      },
    );

  for (const m of maintenance.values())
    run(
      'maintenance_due',
      {
        business,
        reminder: m.reminder,
        lead: m.lead,
        assigneeUserId: m.assigneeUserId,
      },
      m.reminder.id,
      { leadId: null, personId: m.personId },
      {
        subjectType: 'maintenance',
        title: itemTitle(m.personName ?? 'Customer', m.serviceName),
        detail: null,
        conversationId: m.conversationId,
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
