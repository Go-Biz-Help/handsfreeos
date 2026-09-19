/**
 * What one run of the AI teammate knows (plan M7, "Worker runtime" step 3), read in one transaction: the
 * business and its grounding, the teammate's settings, the conversation and its customer (their lead, answers
 * and upcoming visits), its calendars, the history — what was written and what was said on the phone — and the
 * new messages, and the knowledge that matches them.
 * A website chat visitor isn't a verified customer: they get none of the matched customer's record, visits or
 * answers, and only the contact details they typed count as theirs.
 */
import { eq } from 'drizzle-orm';
import {
  calendarMostCharged,
  LeadQualification,
  loadCalendar,
  openHoursOf,
  uuidArray,
  type KnowledgeMatch,
  type TeammateChannel,
  type TeammateConfig,
  type TeammateRow,
  type WeeklyHours,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { anyOfWords, findKnowledge } from '../knowledge/find';
import { loadGrounding, type Grounding } from '../knowledge/grounding';
import type { TenantScope } from '../services';
import {
  BATCH_MAX,
  CALL_WORDS_MAX,
  HISTORY_DAYS,
  HISTORY_MAX,
  KNOWLEDGE_MATCHES,
} from './constants';
import { stripQuoted } from './gates';

const ms = (v: Date | string): number => new Date(v).getTime();

// ---- The messages it answers ----

export interface BatchMessage {
  readonly id: string;
  readonly channel: string;
  /** What they wrote: an email without its quoted history, "(sent a photo)" for a photo alone. */
  readonly text: string;
  readonly subject: string | null;
  /** When they sent it, in epoch milliseconds. */
  readonly at: number;
}

type MessageRow = {
  id: string;
  channel: string;
  body_text: string | null;
  subject: string | null;
  media: unknown;
  occurred_at: Date | string;
};

function textOf(r: Pick<MessageRow, 'channel' | 'body_text' | 'media'>): string {
  const body = r.channel === 'email' ? stripQuoted(r.body_text ?? '') : (r.body_text ?? '').trim();
  const photos = Array.isArray(r.media) ? r.media.length : 0;
  const text =
    body || (photos === 1 ? '(sent a photo)' : photos > 1 ? `(sent ${photos} photos)` : '');
  return text.slice(0, 2000);
}

const batchOf = (r: MessageRow): BatchMessage => ({
  id: r.id,
  channel: r.channel,
  text: textOf(r),
  subject: r.subject,
  at: ms(r.occurred_at),
});

/**
 * What the customer wrote that nobody has answered, oldest first: their messages after the newest one the
 * teammate answered (`ai_answered_through`) and after a person's last reply, from the last 7 days, the newest 20.
 */
export async function unansweredMessages(
  tx: Tx,
  conversationId: string,
  answeredThrough: Date | null,
): Promise<BatchMessage[]> {
  const list = await rows<MessageRow>(
    tx,
    sql`select m.id, m.channel::text as channel, m.body_text, m.subject, m.media, m.occurred_at
        from app.messages m
        where m.conversation_id = ${conversationId} and m.direction = 'inbound'
          and m.occurred_at > greatest(
            coalesce(${answeredThrough ? answeredThrough.toISOString() : null}::timestamptz, '-infinity'::timestamptz),
            coalesce((select max(p.occurred_at) from app.messages p
              where p.conversation_id = ${conversationId} and p.direction = 'outbound' and p.sent_by is not null),
              '-infinity'::timestamptz),
            now() - make_interval(days => ${HISTORY_DAYS}))
        order by m.occurred_at desc, m.created_at desc
        limit ${BATCH_MAX}`,
  );
  return list.reverse().map(batchOf);
}

/** A resumed run's messages, oldest first. */
export async function messagesById(
  tx: Tx,
  conversationId: string,
  ids: readonly string[],
): Promise<BatchMessage[]> {
  if (!ids.length) return [];
  const list = await rows<MessageRow>(
    tx,
    sql`select m.id, m.channel::text as channel, m.body_text, m.subject, m.media, m.occurred_at
        from app.messages m
        where m.conversation_id = ${conversationId} and m.id = any(${uuidArray(ids)})
        order by m.occurred_at, m.created_at`,
  );
  return list.map(batchOf);
}

// ---- The run's context ----

export interface RunCustomer {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly ownerUserId: string | null;
}

export interface RunLead {
  readonly id: string;
  readonly title: string;
  readonly stageName: string;
  readonly pipelineId: string;
  readonly assigneeUserId: string | null;
  readonly qualification: LeadQualification;
}

export interface RunCalendar {
  readonly id: string;
  readonly name: string;
  readonly timeZone: string;
  readonly services: readonly { id: string; name: string; durations: number[] }[];
  /**
   * What this calendar asks for before it will hold a time. A calendar with one is **not the teammate's to
   * book**: the deposit is paid on the customer's own page, so it sends them there instead.
   */
  readonly deposit: { readonly amountCents: number; readonly mode: 'deposit' | 'full' } | null;
  /** The page a customer books it on, when the booking site is on. */
  readonly bookingPath: string | null;
}

export interface RunAppointment {
  readonly id: string;
  readonly title: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly calendarId: string;
  readonly calendarName: string;
  readonly timeZone: string;
}

/**
 * A call in the history rather than a message. Before this the teammate read only what was typed: a customer
 * who phoned, left a voicemail and then texted "as I said on the phone" was answering a question the model had
 * never seen asked.
 *
 * `words` says where the words are, because a call has four ways of having none: nobody picked up, the
 * recording never reached us, the transcriber is still working, or it heard nothing.
 */
export interface HistoryCall {
  readonly id: string;
  readonly kind: 'voicemail' | 'missed' | 'talked';
  /** How long they talked, or how long the voicemail runs; null when nobody picked up. */
  readonly seconds: number | null;
  /** here: the line's text holds them (`more` when it holds only the start); coming: being transcribed. */
  readonly words: 'here' | 'coming' | 'never';
  /** The line carries the start of a long transcript; `read_call_transcript` has all of it. */
  readonly more: boolean;
}

export interface HistoryLine {
  readonly at: number;
  /** customer: they wrote it; ai: the teammate; person: someone on the team; automatic: HandsFreeOS or a workflow. */
  readonly who: 'customer' | 'ai' | 'person' | 'automatic';
  readonly name: string | null;
  readonly text: string;
  /** Set when the line is a call: `text` is then what was said on it, not what anyone typed. */
  readonly call?: HistoryCall;
}

export interface RunContext {
  readonly now: number;
  readonly teammate: { readonly id: string; readonly name: string };
  readonly config: TeammateConfig;
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly timeZone: string;
    readonly openHours: WeeklyHours;
  };
  readonly grounding: Grounding;
  readonly conversation: {
    /** Null for a first message to someone with no conversation yet: sending it starts one. */
    readonly id: string | null;
    readonly channel: TeammateChannel;
    /** Their number or address (the customer's on file for a first message); a chat's `chat:<visitor>`. */
    readonly counterpart: string | null;
    readonly personId: string | null;
  };
  /** A website chat: whoever is typing hasn't proved they're the customer it matched. */
  readonly unverifiedChat: boolean;
  /** The name a chat visitor typed. */
  readonly visitorName: string | null;
  /** No message from the teammate has gone to this customer in this conversation yet. */
  readonly firstAiMessage: boolean;
  /** Its settings say it discloses in its first message, and this is it. */
  readonly discloseNow: boolean;
  /** Loaded even for a chat visitor (the tools need the ids), but only shown when verified. */
  readonly customer: RunCustomer | null;
  readonly lead: RunLead | null;
  readonly stages: readonly { id: string; name: string; kind: string }[];
  readonly calendars: readonly RunCalendar[];
  /** Upcoming visits; none for a chat visitor. */
  readonly appointments: readonly RunAppointment[];
  readonly batch: readonly BatchMessage[];
  readonly history: readonly HistoryLine[];
  readonly matches: readonly KnowledgeMatch[];
  /** For the safety check: the business's own links, numbers and addresses, and this customer's. */
  readonly allowed: {
    readonly domains: readonly string[];
    readonly urlPrefixes: readonly string[];
    readonly phones: readonly string[];
    readonly emails: readonly string[];
  };
}

export interface LoadInput {
  readonly scope: TenantScope;
  readonly teammate: TeammateRow;
  readonly config: TeammateConfig;
  /** The conversation it answers; null for a first message to someone with no conversation yet (`target`). */
  readonly conversationId: string | null;
  /**
   * Whom a first message with no conversation goes to, and how (the test console's visitor may have no
   * customer record: personId null).
   */
  readonly target?: { readonly personId: string | null; readonly channel: TeammateChannel } | null;
  readonly batch: readonly BatchMessage[];
  /** The app's address (booking pages). */
  readonly webUrl: string;
  readonly now: number;
}

export async function loadRunContext(tx: Tx, input: LoadInput): Promise<RunContext> {
  const ws = input.scope.workspaceId;
  const [w] = await rows<{ name: string; timezone: string | null; settings: unknown }>(
    tx,
    sql`select name, timezone, settings from app.workspaces where id = ${ws}`,
  );
  const [conv] = input.conversationId
    ? await tx.select().from(conversations).where(eq(conversations.id, input.conversationId))
    : [];
  const target = conv ? null : (input.target ?? null);
  if (!w || (!conv && !target))
    throw new Error(`conversation ${input.conversationId ?? '(none)'} is not visible here`);
  const timeZone = w.timezone || 'UTC';
  const channel = (conv?.channel ?? target!.channel) as TeammateChannel;
  const personId = conv ? conv.personId : target!.personId;
  const unverifiedChat = channel === 'chat';
  const grounding = await loadGrounding(tx, ws);
  const customer = personId ? await customerOf(tx, personId) : null;
  const lead = customer ? await openLeadOf(tx, ws, customer.id) : null;
  const stages = lead ? await stagesOf(tx, lead.pipelineId) : [];
  const calendars = input.config.book.enabled
    ? await calendarsOf(tx, ws, input.config.book.calendarIds)
    : [];
  const appointments =
    customer && !unverifiedChat ? await upcomingAppointments(tx, ws, customer.id, timeZone) : [];
  const history = conv
    ? await historyOf(
        tx,
        conv.id,
        input.batch.map((b) => b.id),
      )
    : [];
  // Nothing new to answer (a first message, a nudge): what the lead is about finds the knowledge instead.
  const words = anyOfWords(
    input.batch.length
      ? input.batch.map((b) => `${b.subject ?? ''} ${b.text}`).join(' ')
      : (lead?.title ?? ''),
  );
  const matches = words.trim()
    ? await findKnowledge(tx, { workspaceId: ws, queries: [words], limit: KNOWLEDGE_MATCHES })
    : [];
  const [sent] = conv
    ? await rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from app.messages
            where conversation_id = ${conv.id} and sent_by_teammate_id is not null`,
      )
    : [{ n: 0 }];
  const firstAiMessage = (sent?.n ?? 0) === 0;
  const visitor = unverifiedChat && conv ? await visitorOf(tx, conv.counterpart) : null;
  const counterpart =
    conv?.counterpart ?? (channel === 'sms' ? customer?.phone : customer?.email) ?? null;
  const contacts = unverifiedChat
    ? { phones: [visitor?.phone], emails: [visitor?.email] }
    : {
        phones: [customer?.phone, channel === 'sms' ? counterpart : null],
        emails: [customer?.email, channel === 'email' ? counterpart : null],
      };
  return {
    now: input.now,
    teammate: { id: input.teammate.id, name: input.teammate.name },
    config: input.config,
    workspace: {
      id: ws,
      name: w.name,
      timeZone,
      openHours: openHoursOf(w.settings as Record<string, unknown> | null),
    },
    grounding,
    conversation: {
      id: conv?.id ?? null,
      channel,
      counterpart,
      personId,
    },
    unverifiedChat,
    visitorName: visitor?.name ?? null,
    firstAiMessage,
    discloseNow: firstAiMessage && input.config.identity.disclosure === 'first_message',
    customer,
    lead,
    stages,
    calendars,
    appointments,
    batch: input.batch,
    history,
    matches,
    allowed: await allowedFor(tx, ws, grounding.business.website, input.webUrl, contacts),
  };
}

async function customerOf(tx: Tx, personId: string): Promise<RunCustomer | null> {
  const [p] = await rows<{
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    phone_e164: string | null;
    owner_user_id: string | null;
  }>(
    tx,
    sql`select id, first_name, last_name, email, phone_e164, owner_user_id from app.people where id = ${personId}`,
  );
  return p
    ? {
        id: p.id,
        firstName: p.first_name ?? '',
        lastName: p.last_name ?? '',
        email: p.email,
        phone: p.phone_e164,
        ownerUserId: p.owner_user_id,
      }
    : null;
}

async function openLeadOf(tx: Tx, workspaceId: string, personId: string): Promise<RunLead | null> {
  const [l] = await rows<{
    id: string;
    title: string;
    pipeline_id: string;
    assignee_user_id: string | null;
    qualification: unknown;
    stage_name: string;
  }>(
    tx,
    sql`select l.id, l.title, l.pipeline_id, l.assignee_user_id, l.qualification, s.name as stage_name
        from app.leads l join app.pipeline_stages s on s.id = l.stage_id
        where l.workspace_id = ${workspaceId} and l.person_id = ${personId}
          and l.status = 'open' and l.archived_at is null
        order by l.updated_at desc limit 1`,
  );
  if (!l) return null;
  const q = LeadQualification.safeParse(l.qualification ?? {});
  return {
    id: l.id,
    title: l.title,
    stageName: l.stage_name,
    pipelineId: l.pipeline_id,
    assigneeUserId: l.assignee_user_id,
    qualification: q.success ? q.data : LeadQualification.parse({}),
  };
}

async function stagesOf(tx: Tx, pipelineId: string) {
  return rows<{ id: string; name: string; kind: string }>(
    tx,
    sql`select id, name, kind::text as kind from app.pipeline_stages
        where pipeline_id = ${pipelineId} order by position`,
  );
}

/** The calendars its settings list, with their services, in the order they're listed. */
async function calendarsOf(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
): Promise<RunCalendar[]> {
  const out: RunCalendar[] = [];
  const [row] = await rows<{ site: string | null }>(
    tx,
    sql`select (select b.slug::text from app.booking_sites b
                where b.workspace_id = ${workspaceId} and b.enabled) as site`,
  );
  const site = row?.site ?? null;
  for (const id of ids) {
    const cal = await loadCalendar(tx, workspaceId, id).catch(() => null);
    if (!cal || cal.status === 'archived') continue;
    const items =
      (cal.config as { services?: { items?: { serviceId?: unknown }[] } }).services?.items ?? [];
    const serviceIds = items
      .map((i) => i.serviceId)
      .filter((s): s is string => typeof s === 'string');
    const services = serviceIds.length
      ? await rows<{ id: string; name: string; durations: number[] }>(
          tx,
          sql`select id, name, durations from app.services
              where id = any(${uuidArray(serviceIds)}) and archived_at is null order by name`,
        )
      : [];
    const most = await calendarMostCharged(tx, workspaceId, cal.config);
    out.push({
      id: cal.id,
      name: cal.name,
      timeZone: cal.timeZone,
      services,
      deposit: most ? { amountCents: most.amountCents, mode: most.mode } : null,
      bookingPath: site ? `/book/${site}/${cal.slug}` : null,
    });
  }
  return out;
}

/** The customer's upcoming visits with the business, soonest first. */
export async function upcomingAppointments(
  tx: Tx,
  workspaceId: string,
  personId: string,
  timeZone: string,
): Promise<RunAppointment[]> {
  const list = await rows<{
    id: string;
    title: string;
    service_name: string | null;
    starts_at: Date | string;
    ends_at: Date | string;
    calendar_id: string;
    calendar_name: string;
    timezone: string | null;
  }>(
    tx,
    sql`select a.id, a.title, s.name as service_name, a.starts_at, a.ends_at, a.calendar_id,
          c.name as calendar_name, c.timezone
        from app.appointment_attendees t
        join app.appointments a on a.id = t.appointment_id
        join app.calendars c on c.id = a.calendar_id
        left join app.services s on s.id = a.service_id
        where t.workspace_id = ${workspaceId} and t.person_id = ${personId} and t.status = 'booked'
          and a.status = 'scheduled' and a.starts_at > now()
        order by a.starts_at, a.id limit 10`,
  );
  return list.map((r) => ({
    id: r.id,
    title: r.service_name ?? r.title,
    startsAt: ms(r.starts_at),
    endsAt: ms(r.ends_at),
    calendarId: r.calendar_id,
    calendarName: r.calendar_name,
    timeZone: r.timezone || timeZone,
  }));
}

/**
 * The conversation before the new messages: the last 20 messages **and calls** from the last 7 days, oldest
 * first. The two are read separately and merged here rather than unioned in SQL — a call and a message share
 * almost no columns, and padding one out to the other's shape is how the inbox thread query got hard to read.
 */
async function historyOf(
  tx: Tx,
  conversationId: string,
  batchIds: readonly string[],
): Promise<HistoryLine[]> {
  const [written, phoned] = await Promise.all([
    messageHistory(tx, conversationId, batchIds),
    callHistory(tx, conversationId),
  ]);
  return [...written, ...phoned].sort((a, b) => a.at - b.at).slice(-HISTORY_MAX);
}

/** Oldest first. */
async function messageHistory(
  tx: Tx,
  conversationId: string,
  batchIds: readonly string[],
): Promise<HistoryLine[]> {
  const list = await rows<
    MessageRow & {
      direction: string;
      sent_by: string | null;
      ai: boolean;
      full_name: string | null;
    }
  >(
    tx,
    sql`select m.id, m.channel::text as channel, m.direction::text as direction, m.body_text, m.subject,
          m.media, m.occurred_at, m.sent_by, m.sent_by_teammate_id is not null as ai, u.full_name
        from app.messages m left join app.users u on u.id = m.sent_by
        where m.conversation_id = ${conversationId}
          and m.occurred_at > now() - make_interval(days => ${HISTORY_DAYS})
          and not (m.id = any(${uuidArray(batchIds)}))
        order by m.occurred_at desc, m.created_at desc
        limit ${HISTORY_MAX}`,
  );
  return list.reverse().map((r) => ({
    at: ms(r.occurred_at),
    who: r.direction === 'inbound' ? 'customer' : r.ai ? 'ai' : r.sent_by ? 'person' : 'automatic',
    name: r.full_name,
    text: textOf(r) || '(no text)',
  }));
}

/**
 * The calls on this conversation that have finished, oldest first. A call placed through someone's own cell
 * joins the conversation only once it reached the customer, which is the rule the inbox thread follows too.
 */
async function callHistory(tx: Tx, conversationId: string): Promise<HistoryLine[]> {
  const list = await rows<{
    id: string;
    direction: string;
    started_at: Date | string;
    answered: boolean;
    is_voicemail: boolean;
    duration_seconds: number | null;
    recording_seconds: number | null;
    recorded: boolean;
    transcript: string | null;
    transcript_status: string | null;
    placed_by: string | null;
    full_name: string | null;
  }>(
    tx,
    sql`select k.id, k.direction::text as direction, k.started_at,
          k.answered_at is not null as answered, k.is_voicemail, k.duration_seconds,
          k.recording_seconds, k.recording_object_path is not null as recorded, k.transcript,
          k.transcript_status, k.placed_by, u.full_name
        from app.calls k
        left join app.users u on u.id = coalesce(k.placed_by, k.answered_by_user_id)
        where k.conversation_id = ${conversationId} and k.ended_at is not null
          and k.started_at > now() - make_interval(days => ${HISTORY_DAYS})
          and (k.answered_via is distinct from 'bridge' or k.answered_by_user_id is not null)
        order by k.started_at desc, k.id desc
        limit ${HISTORY_MAX}`,
  );
  return list.reverse().map((r) => {
    const kind = r.is_voicemail ? 'voicemail' : r.answered ? 'talked' : 'missed';
    const said = (r.transcript ?? '').trim();
    const words: HistoryCall['words'] = said
      ? 'here'
      : kind === 'missed' || !r.recorded || r.transcript_status === 'failed'
        ? 'never'
        : 'coming';
    return {
      at: ms(r.started_at),
      who: r.direction === 'inbound' ? 'customer' : r.placed_by ? 'person' : 'automatic',
      name: r.full_name,
      text: said.slice(0, CALL_WORDS_MAX),
      call: {
        id: r.id,
        kind,
        seconds:
          kind === 'voicemail' ? r.recording_seconds : r.answered ? r.duration_seconds : null,
        words,
        more: said.length > CALL_WORDS_MAX,
      },
    };
  });
}

/** What a website chat visitor typed about themselves. */
async function visitorOf(
  tx: Tx,
  counterpart: string,
): Promise<{ name: string | null; phone: string | null; email: string | null } | null> {
  const id = counterpart.startsWith('chat:') ? counterpart.slice(5) : '';
  if (!id) return null;
  const [v] = await rows<{ name: string | null; phone_e164: string | null; email: string | null }>(
    tx,
    sql`select name, phone_e164, email from app.chat_visitors where id::text = ${id}`,
  );
  return v ? { name: v.name, phone: v.phone_e164, email: v.email } : null;
}

const hostOf = (u: string): string => {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).host;
  } catch {
    return '';
  }
};

async function allowedFor(
  tx: Tx,
  workspaceId: string,
  website: string | null | undefined,
  webUrl: string,
  contacts: {
    readonly phones: readonly (string | null | undefined)[];
    readonly emails: readonly (string | null | undefined)[];
  },
): Promise<RunContext['allowed']> {
  const [r] = await rows<{
    phones: string[] | null;
    emails: string[] | null;
    origins: string[] | null;
    site: string | null;
  }>(
    tx,
    sql`select
          (select array_agg(n.e164) from app.phone_numbers n
            where n.workspace_id = ${workspaceId} and n.status in ('provisioning', 'active', 'releasing')) as phones,
          (select array_agg(e.address::text) from app.email_addresses e where e.workspace_id = ${workspaceId}) as emails,
          (select array_agg(o) from app.chat_widgets cw, unnest(cw.allowed_origins) o
            where cw.workspace_id = ${workspaceId}) as origins,
          (select b.slug::text from app.booking_sites b where b.workspace_id = ${workspaceId} and b.enabled) as site`,
  );
  const present = (list: readonly (string | null | undefined)[]) =>
    list.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  const domains = present([website, ...(r?.origins ?? [])])
    .map(hostOf)
    .filter(Boolean);
  return {
    domains: [...new Set(domains)],
    urlPrefixes: r?.site ? [`${webUrl}/book/${r.site}`] : [],
    phones: [...new Set([...(r?.phones ?? []), ...present(contacts.phones)])],
    emails: [...new Set([...(r?.emails ?? []), ...present(contacts.emails)])],
  };
}
