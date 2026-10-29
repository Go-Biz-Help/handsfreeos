/**
 * AI outbound calls (Automations, pieces 4a and 4b): the AI teammate rings a customer itself.
 *
 * Why it calls, the first three with their own switch on Settings → Automations (off to begin with):
 * - `confirm_visit`: the day-before reminder asked them to confirm and three hours on they haven't;
 * - `missed_call`: a customer's call nobody answered, five minutes on, when nobody has been in touch since;
 * - `quote`: two days after a quote's reminder text, still no yes or no and no word from them. A person always
 *   approves these first, whatever the teammate's mode (money never chases itself);
 * - `campaign`: a call campaign (automations/campaigns.ts) rings each person who agreed to calls in writing. The
 *   owner approved the whole list, so these don't wait again.
 * - `workflow`: a workflow's "AI teammate calls them" step (workflows/actions.ts), with the step's own call playbook
 *   (`ai_calls.playbook`: what to find out, what to offer, when to book). Only to someone who agreed in writing.
 *
 * The path, the same for every reason:
 * 1. `ai_calls.consider` checks the reason still holds and writes the call down (`app.ai_calls`, once per reason and
 *    subject). While the teammate is training, it waits for a person: a `call` draft on the approvals page.
 * 2. `ai_calls.place` checks again just before: still wanted, the switch still on, the teammate still answers the
 *    phone, money for the call, open hours and never quiet hours (it waits for the next good moment). Then it
 *    places the call from the business number, recorded, with the carrier telling a person from a voicemail box.
 * 3. The answer (http/ai-calls.ts): a person gets the voice agent, which says it's an AI, that the call is
 *    recorded and why it's calling; a voicemail box gets what the business chose (a text instead, a short message,
 *    or nothing).
 * 4. How it went lands on the call's row: talked (and the summary), voicemail, no answer, busy or failed.
 *
 * A campaign's call and a workflow's (calls to leads, AI calls part 3) also wait for the calling hours where the lead
 * is (core's call-hours.ts: the legal hours there, narrowed by the business's own), and ring again the next day when
 * nobody answers, the line's busy or a voicemail box picks up, up to the business's tries (3 to begin with). The
 * voicemail choice comes after the last try: before it, a voicemail box just gets hung up on.
 */
import {
  automationOn,
  automationSettingsOf,
  callPlacesOf,
  callRecord,
  defaultNumber,
  executeCommand,
  formatPhone,
  loadTeammate,
  money,
  nextCallMoment,
  openHoursOf,
  scheduleJob,
  walletRoom,
  workspaceMessaging,
  type AiCallBooking,
  type AiCallPurpose,
  type AutomationSwitch,
  type CallHours,
  type CallVoicemailChoice,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { runtimeConfigOf } from '../ai-team/config';
import { scheduleExpirySweep } from '../ai-team/expiry';
import { nextSendMoment } from '../automations/campaigns';
import { reachOf, sendText, wasSent } from '../booking/deliver';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import { loadAccount } from '../telephony/accounts';
import { isPermanentProviderError } from '../telephony/provider';
import { voiceUrls } from '../telephony/voice';

export const AI_CALL_JOBS = {
  consider: 'ai_calls.consider',
  place: 'ai_calls.place',
  voicemailText: 'ai_calls.voicemail_text',
} as const;
export const aiCallConsiderKey = (purpose: string, subjectId: string): string =>
  `ai-call-consider:${purpose}:${subjectId}`;
export const aiCallPlaceKey = (aiCallId: string): string => `ai-call-place:${aiCallId}`;

/** How long after the day-before ask a visit still unconfirmed gets a call. */
export const CONFIRM_CALL_AFTER_MS = 3 * 60 * 60_000;
/** How long after a missed call it rings back (someone on the team may call first). */
export const MISSED_CALL_AFTER_MS = 5 * 60_000;
/** It doesn't ring about a visit starting within this long: too late to help. */
const CONFIRM_CUTOFF_MS = 2 * 60 * 60_000;
/** How long after a quote's reminder text it asks to call about it. */
export const QUOTE_CALL_AFTER_MS = 2 * 24 * 60 * 60_000;
/** It doesn't ring back a missed call older than this. */
const MISSED_CALL_STALE_MS = 24 * 60 * 60_000;
/** How long the customer's phone rings. */
const RING_SECONDS = 25;
/** How long after a try nobody answered the next one goes (then at the next good moment). */
export const RETRY_AFTER_MS = 24 * 60 * 60_000;

/** The reasons that ring again when nobody answers, and keep to the lead's calling hours: calls to leads. */
const TO_LEADS: ReadonlySet<AiCallPurpose> = new Set(['campaign', 'workflow']);

const SWITCH_OF: Readonly<Record<AiCallPurpose, AutomationSwitch | null>> = {
  confirm_visit: 'callConfirmVisits',
  missed_call: 'callBackMissed',
  quote: 'callQuotes',
  campaign: null,
  workflow: null,
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

// ---------- the words ----------

/** "tomorrow at 9:00 AM", "Thursday at 2:30 PM": how a visit's time is said on the phone. */
export function spokenWhen(at: Date, timeZone: string, now: number): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
  const today = day(new Date(now));
  const tomorrow = day(new Date(now + 86_400_000));
  const d = day(at);
  const on =
    d === today
      ? 'today'
      : d === tomorrow
        ? 'tomorrow'
        : new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(at);
  return `${on} at ${time}`;
}

/** The text a voicemail box's call becomes when the business chose "send a text instead". */
export function voicemailText(
  purpose: AiCallPurpose,
  o: { readonly firstName: string | null; readonly business: string; readonly goal: string },
): string {
  const hi = o.firstName ? `Hi ${o.firstName}` : 'Hi';
  switch (purpose) {
    case 'confirm_visit':
      return `${hi}, it's ${o.business}. We tried to call you ${o.goal}. Reply C to confirm, or let us know if you need another time.`;
    case 'missed_call':
      return `${hi}, it's ${o.business}. Sorry we missed your call. How can we help?`;
    default:
      return `${hi}, it's ${o.business}. We tried to call you ${o.goal}. Just reply here when you have a moment.`;
  }
}

// ---------- writing a call down ----------

export interface CallToMake {
  readonly purpose: AiCallPurpose;
  readonly personId: string;
  readonly to: string;
  /** It finishes "I'm calling …": "about your AC tune-up tomorrow at 9:00 AM". */
  readonly goal: string;
  readonly attendeeId?: string | null;
  readonly missedCallId?: string | null;
  readonly estimateId?: string | null;
  readonly campaignRecipientId?: string | null;
  /** A workflow's call: the step's playbook. */
  readonly playbook?: CallPlaybook | null;
  readonly dedupeKey: string;
}

/** A workflow step's call playbook (core's CallWithAiConfig, less the opening, which is the goal). */
export interface CallPlaybook {
  readonly findOut: string;
  readonly offer: string;
  readonly book: AiCallBooking;
}

/** A campaign's calls were approved on its review screen, all at once: they don't wait for a person again. */
export interface QueueOptions {
  readonly approved?: boolean;
}

/**
 * Writes a call down, once per reason and subject: a `call` draft for a person to approve while the teammate is
 * training (and always for a quote), else straight to placing it. Null when it was written down before, or there
 * is no teammate to make it.
 */
export async function queueAiCall(
  tx: Tx,
  scope: TenantScope,
  call: CallToMake,
  causationId: string,
  opts: QueueOptions = {},
): Promise<{ readonly id: string; readonly status: 'awaiting_approval' | 'queued' } | null> {
  const teammate = await loadTeammate(tx, scope.workspaceId);
  if (!teammate || teammate.status === 'off') return null;
  const [made] = await rows<{ id: string }>(
    tx,
    sql`insert into app.ai_calls (workspace_id, person_id, purpose, attendee_id, missed_call_id, estimate_id,
          campaign_recipient_id, playbook, to_e164, goal, status, dedupe_key)
        values (${scope.workspaceId}, ${call.personId}, ${call.purpose}, ${call.attendeeId ?? null},
          ${call.missedCallId ?? null}, ${call.estimateId ?? null}, ${call.campaignRecipientId ?? null},
          ${call.playbook ? JSON.stringify(call.playbook) : null}::jsonb,
          ${call.to}, ${call.goal.slice(0, 500)}, 'queued', ${call.dedupeKey})
        on conflict (workspace_id, dedupe_key) do nothing
        returning id`,
  );
  if (!made) return null;
  // Money never chases itself: a quote call waits for a person whatever mode the teammate is in.
  const approve = call.purpose === 'quote' || (teammate.status === 'training' && !opts.approved);
  if (!approve) {
    await schedulePlace(tx, scope, made.id, new Date());
    return { id: made.id, status: 'queued' };
  }
  const config = runtimeConfigOf(teammate.config);
  const [conv] = await rows<{ id: string }>(
    tx,
    sql`select id from app.conversations
        where workspace_id = ${scope.workspaceId} and channel = 'sms' and counterpart = ${call.to}
        order by last_message_at desc nulls last limit 1`,
  );
  const expiresAt = new Date(Date.now() + config.autonomy.draftExpiresMinutes * 60_000);
  const preview = {
    message: null,
    actions: [],
    discount: null,
    call: {
      aiCallId: made.id,
      purpose: call.purpose,
      to: call.to,
      toDisplay: formatPhone(call.to),
      goal: call.goal,
    },
  };
  const [d] = await rows<{ id: string }>(
    tx,
    sql`insert into app.ai_teammate_drafts
          (workspace_id, teammate_id, conversation_id, person_id, kind, preview, expires_at, client_id)
        values (${scope.workspaceId}, ${teammate.id}, ${conv?.id ?? null}, ${call.personId}, 'call',
          ${JSON.stringify(preview)}::jsonb, ${expiresAt.toISOString()}::timestamptz, ${`aicall:${made.id}`})
        returning id`,
  );
  await tx.execute(
    sql`update app.ai_calls set status = 'awaiting_approval', draft_id = ${d!.id} where id = ${made.id}`,
  );
  await scheduleExpirySweep(tx, scope, expiresAt);
  await recordSystemEvent(tx, {
    type: 'ai_teammate.drafted',
    action: 'ai_teammate.call',
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    entityType: 'ai_teammate_draft',
    entityId: d!.id,
    payload: {
      draftId: d!.id,
      kind: 'call',
      teammateId: teammate.id,
      conversationId: conv?.id ?? null,
      personId: call.personId,
      aiCallId: made.id,
      purpose: call.purpose,
    },
    after: { teammate: teammate.name, call: call.goal.slice(0, 80) },
    correlationId: made.id,
    causationId,
  });
  return { id: made.id, status: 'awaiting_approval' };
}

const schedulePlace = (tx: Tx, scope: TenantScope, aiCallId: string, runAt: Date) =>
  scheduleJob(
    tx,
    {
      kind: AI_CALL_JOBS.place,
      dedupeKey: aiCallPlaceKey(aiCallId),
      runAt,
      payload: { aiCallId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );

const scheduleConsider = (
  tx: Tx,
  scope: TenantScope,
  purpose: AiCallPurpose,
  subjectId: string,
  runAt: Date,
) =>
  scheduleJob(tx, {
    kind: AI_CALL_JOBS.consider,
    dedupeKey: aiCallConsiderKey(purpose, subjectId),
    runAt,
    payload: { purpose, subjectId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });

// ---------- the reasons ----------

/** The day-before reminder asked them to confirm: a call three hours on, if the visit still isn't confirmed. */
export async function armConfirmCall(
  tx: Tx,
  scope: TenantScope,
  attendeeId: string,
  now: number,
): Promise<void> {
  await scheduleConsider(
    tx,
    scope,
    'confirm_visit',
    attendeeId,
    new Date(now + CONFIRM_CALL_AFTER_MS),
  );
}

/** `call.missed`: a customer's call nobody (and no AI) answered is rung back in five minutes. */
export const onMissedCallForAi: EventHandler = async (ctx) => {
  const e = ctx.event;
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (!e.entityId || e.entityType !== 'call' || p['direction'] !== 'inbound') return;
  if (p['answeredVia'] === 'ai' || !str(p['personId'])) return;
  const raw = await rows<{ settings: Record<string, unknown> | null }>(
    ctx.tx,
    sql`select settings from app.workspaces where id = ${e.workspaceId}`,
  );
  if (!automationOn(raw[0]?.settings ?? null, 'callBackMissed')) return;
  await scheduleConsider(
    ctx.tx,
    tenantOf(ctx.scope),
    'missed_call',
    e.entityId,
    new Date(Date.now() + MISSED_CALL_AFTER_MS),
  );
};

/** `estimate.nudged`: the quote's reminder went; two days on, still no answer, it asks to call. */
export const onQuoteNudgedForAi: EventHandler = async (ctx) => {
  const e = ctx.event;
  if (!e.entityId || e.entityType !== 'estimate') return;
  const raw = await rows<{ settings: Record<string, unknown> | null }>(
    ctx.tx,
    sql`select settings from app.workspaces where id = ${e.workspaceId}`,
  );
  if (!automationOn(raw[0]?.settings ?? null, 'callQuotes')) return;
  await scheduleConsider(
    ctx.tx,
    tenantOf(ctx.scope),
    'quote',
    e.entityId,
    new Date(Date.now() + QUOTE_CALL_AFTER_MS),
  );
};

type Considered = { readonly call: CallToMake } | { readonly skip: string };

/** Whether a visit still wants a confirming call, and what to say. */
async function considerVisit(tx: Tx, attendeeId: string, now: number): Promise<Considered> {
  const [a] = await rows<{
    person_id: string;
    status: string;
    confirmed_at: Date | null;
    phone: string | null;
    appt_status: string;
    starts_at: Date;
    title: string;
    time_zone: string | null;
    call_consent: string;
  }>(
    tx,
    sql`select aa.person_id, aa.status::text as status, aa.confirmed_at,
          coalesce(aa.contact_phone_e164, p.phone_e164) as phone, ap.status::text as appt_status, ap.starts_at,
          ap.title, w.timezone as time_zone, p.call_consent::text as call_consent
        from app.appointment_attendees aa
        join app.appointments ap on ap.id = aa.appointment_id
        join app.people p on p.id = aa.person_id
        join app.workspaces w on w.id = aa.workspace_id
        where aa.id = ${attendeeId}`,
  );
  if (!a) return { skip: 'gone' };
  if (a.confirmed_at) return { skip: 'already_confirmed' };
  if (a.status !== 'booked' || a.appt_status !== 'scheduled') return { skip: 'cancelled' };
  const start = new Date(a.starts_at).getTime();
  if (start - now < CONFIRM_CUTOFF_MS) return { skip: 'too_late' };
  if (!a.phone) return { skip: 'no_phone' };
  if (a.call_consent === 'opted_out') return { skip: 'no_calls' };
  return {
    call: {
      purpose: 'confirm_visit',
      personId: a.person_id,
      to: a.phone,
      goal: `about your ${a.title} ${spokenWhen(new Date(start), a.time_zone || 'UTC', now)}.`,
      attendeeId,
      dedupeKey: `confirm_visit:${attendeeId}`,
    },
  };
}

/** Whether a missed call still wants ringing back: nobody has been in touch with them since. */
async function considerMissed(tx: Tx, callId: string, now: number): Promise<Considered> {
  const [c] = await rows<{
    person_id: string | null;
    from_e164: string | null;
    direction: string;
    answered_via: string | null;
    started_at: Date;
    conversation_id: string | null;
    call_consent: string | null;
  }>(
    tx,
    sql`select c.person_id, c.from_e164, c.direction::text as direction, c.answered_via::text as answered_via,
          c.started_at, c.conversation_id, p.call_consent::text as call_consent
        from app.calls c left join app.people p on p.id = c.person_id
        where c.id = ${callId}`,
  );
  if (!c || c.direction !== 'inbound' || !c.person_id || !c.from_e164) return { skip: 'gone' };
  if (c.answered_via) return { skip: 'answered' };
  if (now - new Date(c.started_at).getTime() > MISSED_CALL_STALE_MS) return { skip: 'too_late' };
  if (c.call_consent === 'opted_out') return { skip: 'no_calls' };
  // Anyone in touch since, either way, by text, email or call: nothing to ring back about.
  const [since] = await rows(
    tx,
    sql`select 1 where exists (
          select 1 from app.messages m join app.conversations cv on cv.id = m.conversation_id
          where cv.person_id = ${c.person_id} and m.occurred_at > ${new Date(c.started_at).toISOString()}::timestamptz)
        or exists (
          select 1 from app.calls o
          where o.person_id = ${c.person_id} and o.id <> ${callId}
            and o.started_at > ${new Date(c.started_at).toISOString()}::timestamptz)`,
  );
  if (since) return { skip: 'in_touch_since' };
  return {
    call: {
      purpose: 'missed_call',
      personId: c.person_id,
      to: c.from_e164,
      goal: 'back, since we missed your call earlier.',
      missedCallId: callId,
      dedupeKey: `missed_call:${callId}`,
    },
  };
}

/** Whether a quote still wants a call: still open and good, and not a word from them since its reminder. */
async function considerQuote(tx: Tx, estimateId: string, now: number): Promise<Considered> {
  const [q] = await rows<{
    person_id: string | null;
    status: string;
    voided_at: Date | null;
    expires_on: string | null;
    title: string | null;
    phone: string | null;
    call_consent: string | null;
    today: string;
    nudged_at: Date | null;
    deleted: boolean | null;
  }>(
    tx,
    sql`select e.person_id, e.status::text as status, e.voided_at, e.expires_on::text as expires_on, e.title,
          p.phone_e164 as phone, p.call_consent::text as call_consent,
          p.bin_item_id is not null or p.erased_at is not null as deleted,
          (${new Date(now).toISOString()}::timestamptz at time zone coalesce(nullif(w.timezone, ''), 'UTC'))::date::text
            as today,
          (select max(ev.occurred_at) from app.events ev
           where ev.workspace_id = e.workspace_id and ev.entity_type = 'estimate' and ev.entity_id = e.id
             and ev.event_type = 'estimate.nudged') as nudged_at
        from app.estimates e
        join app.workspaces w on w.id = e.workspace_id
        left join app.people p on p.id = e.person_id
        where e.id = ${estimateId}`,
  );
  // A customer deleted (in the Deleted bin, or only a name on their bills) isn't chased.
  if (!q || !q.person_id || q.deleted) return { skip: 'gone' };
  // Answered, expired, voided or reissued: a quote is never chased once it has stopped being open.
  if (q.status !== 'sent' || q.voided_at) return { skip: 'answered' };
  if (q.expires_on && q.expires_on < q.today) return { skip: 'expired' };
  if (!q.phone) return { skip: 'no_phone' };
  if (q.call_consent === 'opted_out') return { skip: 'no_calls' };
  const since = q.nudged_at ? new Date(q.nudged_at).toISOString() : null;
  if (since) {
    // A word from them since the reminder, by text, email or call: the team takes it from there.
    const [heard] = await rows(
      tx,
      sql`select 1 where exists (
            select 1 from app.messages m join app.conversations cv on cv.id = m.conversation_id
            where cv.person_id = ${q.person_id} and m.direction = 'inbound'
              and m.occurred_at > ${since}::timestamptz)
          or exists (
            select 1 from app.calls c
            where c.person_id = ${q.person_id} and c.direction = 'inbound'
              and c.started_at > ${since}::timestamptz)`,
    );
    if (heard) return { skip: 'in_touch_since' };
  }
  const title = q.title?.trim();
  return {
    call: {
      purpose: 'quote',
      personId: q.person_id,
      to: q.phone,
      goal: `about the quote we sent you${title ? ` for ${title}` : ''}.`,
      estimateId,
      dedupeKey: `quote:${estimateId}`,
    },
  };
}

/** Ready to make AI calls at all: the teammate is on and answers the phone, and speech is set up. */
export function voiceReady(
  ctx: Parameters<JobHandler>[0],
  teammate: Awaited<ReturnType<typeof loadTeammate>>,
): boolean {
  if (!teammate || teammate.status === 'off') return false;
  if (!ctx.speech || !(ctx.voiceAi ?? ctx.ai.provider)) return false;
  return runtimeConfigOf(teammate.config).phone.enabled;
}

/** `ai_calls.consider`: the reason still holds, so the call is written down (and approved, or placed). */
export const aiCallConsiderJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const purpose = str(ctx.job.payload['purpose']) as AiCallPurpose | null;
  const subjectId = str(ctx.job.payload['subjectId']);
  if (!purpose || !subjectId) return;
  await asWorker(ctx.db, scope, async (tx) => {
    const [w] = await rows<{ settings: Record<string, unknown> | null }>(
      tx,
      sql`select settings from app.workspaces where id = ${scope.workspaceId}`,
    );
    const key = SWITCH_OF[purpose];
    if (key && !automationOn(w?.settings ?? null, key)) return;
    if (!voiceReady(ctx, await loadTeammate(tx, scope.workspaceId))) return;
    const r =
      purpose === 'confirm_visit'
        ? await considerVisit(tx, subjectId, ctx.now)
        : purpose === 'missed_call'
          ? await considerMissed(tx, subjectId, ctx.now)
          : purpose === 'quote'
            ? await considerQuote(tx, subjectId, ctx.now)
            : { skip: 'not_here' };
    if ('skip' in r) return;
    await queueAiCall(tx, scope, r.call, ctx.job.id);
  });
};

/**
 * Why a call to a lead that waited (an approval, the hours, tomorrow's try) isn't wanted any more: they booked, or
 * they texted, emailed or called the business, since it was written down. Null when neither.
 */
async function sinceCallQueued(
  tx: Tx,
  personId: string,
  since: Date,
): Promise<'booked_since' | 'in_touch_since' | null> {
  const at = since.toISOString();
  const [b] = await rows(
    tx,
    sql`select 1 from app.appointment_attendees
        where person_id = ${personId} and created_at > ${at}::timestamptz limit 1`,
  );
  if (b) return 'booked_since';
  const [t] = await rows(
    tx,
    sql`select 1 where exists (
          select 1 from app.messages m join app.conversations cv on cv.id = m.conversation_id
          where cv.person_id = ${personId} and m.direction = 'inbound' and m.occurred_at > ${at}::timestamptz)
        or exists (
          select 1 from app.calls o
          where o.person_id = ${personId} and o.direction = 'inbound' and o.started_at > ${at}::timestamptz)`,
  );
  return t ? 'in_touch_since' : null;
}

// ---------- what the AI knows on the call ----------

/**
 * The facts a quote, campaign or workflow call is about, for the AI on the call (data, not instructions): the
 * quote's name, total and last day; the campaign's goal and its offer; or the workflow step's playbook. Null for
 * the other reasons.
 */
export async function callBrief(tx: Tx, aiCallId: string): Promise<string | null> {
  const [c] = await rows<{
    purpose: AiCallPurpose;
    number: string | null;
    title: string | null;
    total_cents: string | number | null;
    expires_on: string | null;
    goal: string | null;
    offer_name: string | null;
    offer_details: string | null;
    offer_ends: string | null;
    playbook: unknown;
  }>(
    tx,
    sql`select a.purpose, a.playbook, e.number, e.title, e.total_cents, e.expires_on::text as expires_on,
          k.goal, o.name as offer_name, o.details as offer_details, o.ends_on::text as offer_ends
        from app.ai_calls a
        left join app.estimates e on e.id = a.estimate_id
        left join app.campaign_recipients r on r.id = a.campaign_recipient_id
        left join app.campaigns k on k.id = r.campaign_id
        left join app.offers o on o.id = k.offer_id
        where a.id = ${aiCallId}`,
  );
  if (!c) return null;
  if (c.purpose === 'quote' && c.total_cents !== null)
    return quoteFacts({ ...c, total_cents: c.total_cents });
  if (c.purpose === 'campaign' && c.goal) return campaignFacts({ ...c, goal: c.goal });
  if (c.purpose === 'workflow') return playbookFacts(playbookOf(c.playbook));
  return null;
}

const BOOKING_WORDS: Readonly<Record<AiCallBooking, string>> = {
  when_ready: 'When they want to book, offer times and book it.',
  always: 'Ask if they’d like to book a visit, and book it when they do.',
  never: 'Don’t book on this call: say the team will follow up to set a time.',
};

/** The playbook kept on a workflow's call, read forgivingly: anything missing is left out. */
export function playbookOf(raw: unknown): CallPlaybook {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const book = o['book'];
  return {
    findOut: text(o['findOut']),
    offer: text(o['offer']),
    book: book === 'always' || book === 'never' ? book : 'when_ready',
  };
}

/** A workflow step's playbook, as facts for the call: what to find out, what it may offer, and when to book. */
export function playbookFacts(p: CallPlaybook): string {
  const lines: string[] = [];
  if (p.findOut) lines.push(`What to find out: ${p.findOut}`);
  lines.push(p.offer ? `What you may offer, and nothing more: ${p.offer}` : 'No offer to make.');
  lines.push(`Booking: ${BOOKING_WORDS[p.book]}`);
  return lines.join('\n');
}

/** A quote's facts for a call about it: its number and title, total and last day. */
export function quoteFacts(q: {
  readonly number: string | null;
  readonly title: string | null;
  readonly total_cents: string | number;
  readonly expires_on: string | null;
}): string {
  const lines = [
    `Quote${q.number ? ` ${q.number}` : ''}${q.title?.trim() ? `: ${q.title.trim()}` : ''}`,
    `Total: ${money(Number(q.total_cents))}`,
  ];
  if (q.expires_on) lines.push(`Good until: ${q.expires_on}`);
  return lines.join('\n');
}

/** A call campaign's facts: the owner's goal and any offer. */
export function campaignFacts(c: {
  readonly goal: string;
  readonly offer_name?: string | null;
  readonly offer_details?: string | null;
  readonly offer_ends?: string | null;
}): string {
  const lines = [`What the owner wants from these calls: ${c.goal.trim()}`];
  if (c.offer_name) {
    lines.push(`Offer: ${c.offer_name.trim()}`);
    if (c.offer_details?.trim()) lines.push(`Offer details: ${c.offer_details.trim()}`);
    if (c.offer_ends) lines.push(`Offer ends: ${c.offer_ends}`);
  }
  return lines.join('\n');
}

// ---------- approving ----------

/** A person decided a call draft: approved, it's placed at the next good moment; rejected, it isn't made. */
export async function onCallDraftDecided(
  tx: Tx,
  scope: TenantScope,
  draftId: string,
  approved: boolean,
): Promise<void> {
  const [c] = await rows<{ id: string }>(
    tx,
    approved
      ? sql`update app.ai_calls set status = 'queued' where draft_id = ${draftId} and status = 'awaiting_approval'
            returning id`
      : sql`update app.ai_calls set status = 'cancelled', reason = 'not_approved'
            where draft_id = ${draftId} and status = 'awaiting_approval' returning id`,
  );
  if (c && approved) await schedulePlace(tx, scope, c.id, new Date());
}

// ---------- placing ----------

interface Placing {
  readonly id: string;
  readonly to: string;
  readonly from: string;
  readonly voicemail: CallVoicemailChoice;
}

/** A campaign's call that wasn't made, or failed: its person on the campaign shows why. */
const recipientFailed = (tx: Tx, aiCallId: string, reason: string) =>
  tx.execute(
    sql`update app.campaign_recipients set status = 'failed', error = ${reason.slice(0, 500)}
        where id = (select campaign_recipient_id from app.ai_calls where id = ${aiCallId})
          and status = 'sent'`,
  );

const skip = async (tx: Tx, id: string, reason: string) => {
  await tx.execute(
    sql`update app.ai_calls set status = 'skipped', reason = ${reason.slice(0, 200)}, finished_at = now()
        where id = ${id} and status = 'queued'`,
  );
  await recipientFailed(tx, id, reason);
};

/**
 * The next moment a call to a lead may go: the business open and not in quiet hours, and the calling hours where
 * the lead may be. Null when the lead's calling hours have no time in the next two weeks.
 */
function goodMomentForLead(
  m: Awaited<ReturnType<typeof workspaceMessaging>>,
  tz: string,
  places: Parameters<typeof nextCallMoment>[0],
  hours: CallHours,
  now: number,
): number | null {
  let t = now;
  // Each is a moment the other may move on from; a few rounds settle on one both allow (a later run checks again).
  for (let i = 0; i < 8; i++) {
    const open = nextSendMoment(openHoursOf(m.rawSettings), m.settings.quietHours, tz, t);
    const lead = nextCallMoment(places, hours, open);
    if (lead === null) return null;
    if (lead === open) return open;
    t = lead;
  }
  return t;
}

/** `ai_calls.place`: checked once more, then rung. */
export const aiCallPlaceJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const aiCallId = str(ctx.job.payload['aiCallId']);
  if (!aiCallId) return;
  const now = ctx.now;
  const step = await asWorker(
    ctx.db,
    scope,
    async (tx): Promise<{ wait: number } | { place: Placing } | null> => {
      const [c] = await rows<{
        id: string;
        purpose: AiCallPurpose;
        status: string;
        to_e164: string;
        attendee_id: string | null;
        missed_call_id: string | null;
        estimate_id: string | null;
        campaign_status: string | null;
        call_consent: string;
        deleted: boolean;
        person_id: string;
        created_at: Date;
        tries: number;
        state: string | null;
        postal_code: string | null;
        country: string | null;
      }>(
        tx,
        sql`select c.id, c.purpose, c.status, c.to_e164, c.attendee_id, c.missed_call_id, c.estimate_id,
              c.person_id, c.created_at, c.tries, p.state, p.postal_code, p.country,
              (select k.status from app.campaign_recipients r join app.campaigns k on k.id = r.campaign_id
               where r.id = c.campaign_recipient_id) as campaign_status,
              p.call_consent::text as call_consent,
              p.bin_item_id is not null or p.erased_at is not null as deleted
            from app.ai_calls c join app.people p on p.id = c.person_id
            where c.id = ${aiCallId} and c.workspace_id = ${scope.workspaceId}
            for update of c`,
      );
      if (!c || c.status !== 'queued') return null;
      // Deleting a customer cancels their calls waiting to go; one queued since isn't made either.
      if (c.deleted) return skip(tx, c.id, 'deleted').then(() => null);
      if (c.call_consent === 'opted_out') return skip(tx, c.id, 'no_calls').then(() => null);
      if (c.purpose === 'workflow') {
        // A workflow's call needs the written yes, still, as a campaign's does.
        if (c.call_consent !== 'opted_in')
          return skip(tx, c.id, 'no_call_consent').then(() => null);
        // A call that waited (an approval, open hours) isn't wanted once they've booked or been in touch.
        const since = await sinceCallQueued(tx, c.person_id, new Date(c.created_at));
        if (since) return skip(tx, c.id, since).then(() => null);
      }
      if (c.purpose === 'campaign') {
        // Marketing calls need the written yes, still, and a campaign that's still going.
        if (c.call_consent !== 'opted_in')
          return skip(tx, c.id, 'no_call_consent').then(() => null);
        if (c.campaign_status !== 'sending' && c.campaign_status !== 'done')
          return skip(tx, c.id, 'campaign_stopped').then(() => null);
        // Tomorrow's try isn't wanted once they've booked or been in touch since the first.
        if (c.tries > 0) {
          const since = await sinceCallQueued(tx, c.person_id, new Date(c.created_at));
          if (since) return skip(tx, c.id, since).then(() => null);
        }
      }
      // Still wanted? A reply, a confirmation or a call since the approval leaves it alone.
      const again =
        c.purpose === 'confirm_visit' && c.attendee_id
          ? await considerVisit(tx, c.attendee_id, now)
          : c.purpose === 'missed_call' && c.missed_call_id
            ? await considerMissed(tx, c.missed_call_id, now)
            : c.purpose === 'quote' && c.estimate_id
              ? await considerQuote(tx, c.estimate_id, now)
              : null;
      if (again && 'skip' in again) return skip(tx, c.id, again.skip).then(() => null);
      const m = await workspaceMessaging(tx, scope.workspaceId);
      const key = SWITCH_OF[c.purpose];
      if (key && !automationOn(m.rawSettings, key))
        return skip(tx, c.id, 'switched_off').then(() => null);
      if (!voiceReady(ctx, await loadTeammate(tx, scope.workspaceId)))
        return skip(tx, c.id, 'no_voice').then(() => null);
      for (const kind of ['call', 'ai'] as const) {
        const room = await walletRoom(tx, scope.workspaceId, kind, (msg, e) =>
          ctx.log.error({ err: e }, msg),
        );
        if (!room.allowed) return skip(tx, c.id, 'balance').then(() => null);
      }
      // Open hours only, never quiet hours: it waits for the next good moment. A call to a lead waits for the
      // calling hours where they are too.
      const tz = m.timezone || 'UTC';
      const calls = automationSettingsOf(m.rawSettings).calls;
      const at = TO_LEADS.has(c.purpose)
        ? goodMomentForLead(
            m,
            tz,
            callPlacesOf(
              c.to_e164,
              { state: c.state, postalCode: c.postal_code, country: c.country },
              tz,
            ),
            calls.hours,
            now,
          )
        : nextSendMoment(openHoursOf(m.rawSettings), m.settings.quietHours, tz, now);
      if (at === null) return skip(tx, c.id, 'no_calling_hours').then(() => null);
      if (at > now) return { wait: at };
      const number = await defaultNumber(tx, scope.workspaceId);
      if (!number || number.status !== 'active')
        return skip(tx, c.id, 'no_number').then(() => null);
      await tx.execute(
        // Another try starts clean: the last one's "tries again tomorrow" is over.
        sql`update app.ai_calls set status = 'calling', placed_at = now(), tries = tries + 1,
              outcome = null, summary = null
            where id = ${c.id}`,
      );
      return {
        place: {
          id: c.id,
          to: c.to_e164,
          from: number.e164,
          voicemail: automationSettingsOf(m.rawSettings).calls.voicemail,
        },
      };
    },
  );
  if (!step) return;
  if ('wait' in step) return { rescheduleAt: new Date(step.wait) };
  const p = step.place;
  const failed = (reason: string) =>
    asWorker(ctx.db, scope, async (tx) => {
      await tx.execute(
        sql`update app.ai_calls set status = 'failed', outcome = 'failed', reason = ${reason.slice(0, 200)},
              finished_at = now()
            where id = ${p.id} and status = 'calling'`,
      );
      await recipientFailed(tx, p.id, reason);
    });
  const account = await asWorker(ctx.db, scope, (tx) =>
    loadAccount(tx, scope.workspaceId, ctx.sealer),
  );
  if (!account) {
    await failed('no_telephony_account');
    return;
  }
  const urls = voiceUrls(ctx.publicUrl);
  let sid: string;
  try {
    ({ sid } = await ctx.telephony.placeCall(account, {
      from: p.from,
      to: p.to,
      answerUrl: aiCallAnswerUrl(ctx.publicUrl, p.id),
      statusCallbackUrl: urls.status,
      timeoutSeconds: RING_SECONDS,
      record: { statusCallbackUrl: urls.recording },
      machineDetection: p.voicemail === 'message' ? 'beep' : 'answer',
    }));
  } catch (e) {
    if (!isPermanentProviderError(e)) throw e;
    await failed(`carrier: ${e.code}`);
    return;
  }
  const { output } = await executeCommand(
    ctx.db,
    callRecord,
    {
      workspaceId: scope.workspaceId,
      providerSid: sid,
      direction: 'outbound',
      from: p.from,
      to: p.to,
      status: 'ringing',
    },
    systemActor(scope),
    workerMeta(null, ctx.job.id),
  );
  await asWorker(ctx.db, scope, (tx) =>
    tx.execute(sql`update app.ai_calls set call_id = ${output.callId} where id = ${p.id}`),
  );
};

/** Where the carrier asks what to do once the customer's phone answers. */
export const aiCallAnswerUrl = (publicUrl: string, aiCallId: string): string =>
  `${publicUrl}/webhooks/twilio/voice/ai-call?aiCall=${aiCallId}`;

// ---------- how it went ----------

const OUTCOME_OF: Readonly<Record<string, string>> = {
  no_answer: 'no_answer',
  busy: 'busy',
  failed: 'failed',
  canceled: 'no_answer',
  completed: 'talked',
};

/** What the call's row says while it waits for tomorrow's try. */
const RETRY_SUMMARY: Readonly<Record<string, string>> = {
  no_answer: 'Nobody answered; it tries again tomorrow.',
  busy: 'The line was busy; it tries again tomorrow.',
  voicemail: 'A voicemail box answered; it hung up and tries again tomorrow.',
};

/**
 * A call to a lead nobody answered (no answer, busy, a voicemail box): with tries left, it waits to ring again
 * tomorrow and says so. Whether it will; the last try is left to the caller to finish.
 */
export async function tryAgainTomorrow(
  tx: Tx,
  scope: TenantScope,
  aiCallId: string,
  outcome: 'no_answer' | 'busy' | 'voicemail',
): Promise<boolean> {
  const [c] = await rows<{ purpose: AiCallPurpose; tries: number; settings: unknown }>(
    tx,
    sql`select c.purpose, c.tries, w.settings from app.ai_calls c join app.workspaces w on w.id = c.workspace_id
        where c.id = ${aiCallId} and c.status = 'calling'`,
  );
  if (!c || !TO_LEADS.has(c.purpose)) return false;
  if (c.tries >= automationSettingsOf(c.settings as Record<string, unknown> | null).calls.tries)
    return false;
  await tx.execute(
    sql`update app.ai_calls set status = 'queued', outcome = ${outcome}, summary = ${RETRY_SUMMARY[outcome]!}
        where id = ${aiCallId} and status = 'calling'`,
  );
  await schedulePlace(tx, scope, aiCallId, new Date(Date.now() + RETRY_AFTER_MS));
  return true;
}

/** After a call to a lead's last try nobody answered, the usual text when the business chose texting instead. */
export async function textAfterLastTry(
  tx: Tx,
  scope: TenantScope,
  aiCallId: string,
): Promise<void> {
  await scheduleJob(tx, {
    kind: AI_CALL_JOBS.voicemailText,
    dedupeKey: `ai-call-vm:${aiCallId}`,
    runAt: new Date(),
    payload: { aiCallId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
}

/**
 * `call.completed` / `call.missed`: a call it placed ended. Whatever didn't say how it went, the carrier does. A call
 * to a lead nobody answered rings again tomorrow while it has tries left, and after the last, the usual text goes
 * when the business chose that for voicemail boxes.
 */
export const onAiCallEnded: EventHandler = async (ctx) => {
  const e = ctx.event;
  if (!e.entityId || e.entityType !== 'call') return;
  const [c] = await rows<{ status: string }>(
    ctx.tx,
    sql`select status::text as status from app.calls where id = ${e.entityId}`,
  );
  if (!c) return;
  const outcome = OUTCOME_OF[c.status] ?? 'failed';
  const [ai] = await rows<{ id: string; purpose: AiCallPurpose; tries: number; settings: unknown }>(
    ctx.tx,
    sql`select a.id, a.purpose, a.tries, w.settings from app.ai_calls a join app.workspaces w on w.id = a.workspace_id
        where a.call_id = ${e.entityId} and a.status = 'calling'`,
  );
  if (!ai) return;
  const scope = tenantOf(ctx.scope);
  const unanswered = outcome === 'no_answer' || outcome === 'busy';
  if (unanswered && (await tryAgainTomorrow(ctx.tx, scope, ai.id, outcome))) return;
  const summary =
    unanswered && ai.tries > 1 ? `Nobody picked up on any of its ${ai.tries} tries.` : null;
  await ctx.tx.execute(
    sql`update app.ai_calls set status = 'done', outcome = ${outcome}, finished_at = now(),
          summary = coalesce(${summary}, summary)
        where id = ${ai.id} and status = 'calling'`,
  );
  const voicemail = automationSettingsOf(ai.settings as Record<string, unknown> | null).calls
    .voicemail;
  if (unanswered && TO_LEADS.has(ai.purpose) && voicemail === 'text')
    await textAfterLastTry(ctx.tx, scope, ai.id);
};

/**
 * `ai_calls.voicemail_text`: a voicemail box answered, or a call to a lead went unanswered on its last try, and the
 * business chose a text instead.
 */
export const aiCallVoicemailTextJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const aiCallId = str(ctx.job.payload['aiCallId']);
  if (!aiCallId) return;
  const plan = await asWorker(ctx.db, scope, async (tx) => {
    const [c] = await rows<{
      purpose: AiCallPurpose;
      to_e164: string;
      goal: string;
      first_name: string | null;
      sms_consent: 'unknown' | 'opted_in' | 'opted_out';
      business: string;
    }>(
      tx,
      sql`select c.purpose, c.to_e164, c.goal, p.first_name, p.sms_consent::text as sms_consent, w.name as business
          from app.ai_calls c join app.people p on p.id = c.person_id join app.workspaces w on w.id = c.workspace_id
          where c.id = ${aiCallId}`,
    );
    if (!c) return null;
    const reach = await reachOf(
      tx,
      scope.workspaceId,
      {
        phone: c.to_e164,
        email: null,
        // Their own visit, their own call: a text back needs no marketing consent. A campaign's or a workflow's does.
        smsOk: c.purpose !== 'campaign' && c.purpose !== 'workflow',
        personConsent: c.sms_consent,
      },
      { text: true, email: false },
    );
    if (reach.text !== null) return null;
    return {
      to: c.to_e164,
      body: voicemailText(c.purpose, {
        firstName: c.first_name?.trim() || null,
        business: c.business,
        goal: c.goal.replace(/[.!?]+$/, ''),
      }),
    };
  });
  if (!plan) return;
  const sent = await sendText(
    ctx,
    scope,
    plan.to,
    plan.body,
    `aicall-vm:${aiCallId}`,
    workerMeta(null, ctx.job.id),
  );
  // Quiet hours began meanwhile: it goes when they end.
  if (!wasSent(sent) && sent.refused === 'quiet_hours')
    return { rescheduleAt: new Date(Date.now() + 15 * 60_000) };
};

export const aiCallJobs = {
  [AI_CALL_JOBS.consider]: aiCallConsiderJob,
  [AI_CALL_JOBS.place]: aiCallPlaceJob,
  [AI_CALL_JOBS.voicemailText]: aiCallVoicemailTextJob,
} as const;
