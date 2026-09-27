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
  allQuestions,
  calendarMostCharged,
  loadTerritories,
  needsAddress,
  chatOpenedAt,
  chatVerified,
  LeadQualification,
  parseStoredForm,
  loadCalendar,
  localDateOf,
  openHoursOf,
  uuidArray,
  JOB_STATUS_WORDS,
  quoteData,
  type JobStatus,
  type KnowledgeMatch,
  type TeammateChannel,
  type TeammateConfig,
  type TeammateRow,
  type WeeklyHours,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { conversations, type ButtonReply, type RichText } from '@hfos/db/schema';
import { atLabel } from '../assistant/calendar-format';
import { anyOfWords, findKnowledge } from '../knowledge/find';
import { loadGrounding, type Grounding } from '../knowledge/grounding';
import type { TenantScope } from '../services';
import {
  BATCH_MAX,
  CALL_WORDS_MAX,
  CATALOGUE_MAX,
  HISTORY_DAYS,
  HISTORY_MAX,
  KNOWLEDGE_MATCHES,
  OFFERS_MAX,
  PLANS_MAX,
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
  /** The pictures it came with (M18), as stored; the run decides which it can show the model. */
  readonly photos: readonly PhotoRef[];
}

/** A picture a customer sent, where it is kept. */
export interface PhotoRef {
  readonly bucket: string;
  readonly objectPath: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

const photosIn = (media: unknown): PhotoRef[] =>
  (Array.isArray(media) ? media : []).flatMap((m: unknown) => {
    const r = m as Partial<PhotoRef> | null;
    return r &&
      typeof r.bucket === 'string' &&
      typeof r.objectPath === 'string' &&
      typeof r.contentType === 'string' &&
      r.contentType.startsWith('image/')
      ? [
          {
            bucket: r.bucket,
            objectPath: r.objectPath,
            contentType: r.contentType,
            sizeBytes: Number(r.sizeBytes) || 0,
          },
        ]
      : [];
  });

type MessageRow = {
  id: string;
  channel: string;
  body_text: string | null;
  subject: string | null;
  media: unknown;
  occurred_at: Date | string;
  /** RCS (0103): the buttons, card or carousel a text offered, and the button a reply came from. */
  rich?: RichText | null;
  button_reply?: ButtonReply | null;
};

/**
 * What a text offered besides its words (0103), so the model knows what a customer's "Reschedule" was an answer
 * to: "(with buttons: Confirm, Reschedule)", "(as a card titled “…” …)", "(with 3 cards: Basic, Plus, Premium)".
 */
function offeredLine(rich: RichText): string {
  const names = (list: readonly { title: string }[]) => list.map((b) => b.title).join(', ');
  if (rich.kind === 'carousel')
    return `(with ${rich.cards.length} cards to choose from: ${rich.cards.map((c) => c.title ?? c.body).join(', ')})`;
  const buttons = rich.buttons.length ? ` with buttons: ${names(rich.buttons)}` : '';
  return rich.kind === 'card'
    ? `(as a card titled “${rich.title ?? ''}”${buttons})`
    : `(${buttons.trim()})`;
}

function textOf(
  r: Pick<MessageRow, 'channel' | 'body_text' | 'media' | 'rich' | 'button_reply'>,
): string {
  const body = r.channel === 'email' ? stripQuoted(r.body_text ?? '') : (r.body_text ?? '').trim();
  const photos = Array.isArray(r.media) ? r.media.length : 0;
  const sent = photos === 1 ? 'a photo' : `${photos} photos`;
  // M18: a photo with words says so too, so the model knows there is one to look at.
  let text = !photos ? body : body ? `${body}\n(with ${sent})` : `(sent ${sent})`;
  // A tap is the customer's answer, in the button's own words (0103); saying so tells the model it answers the
  // message that offered it rather than being something they typed out of the blue.
  if (r.button_reply)
    text += `\n(chose “${r.button_reply.title}” from the buttons on an earlier message)`;
  if (r.rich) text += `\n${offeredLine(r.rich)}`;
  return text.slice(0, 2000);
}

const batchOf = (r: MessageRow): BatchMessage => ({
  id: r.id,
  channel: r.channel,
  text: textOf(r),
  subject: r.subject,
  at: ms(r.occurred_at),
  photos: photosIn(r.media),
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
    sql`select m.id, m.channel::text as channel, m.body_text, m.subject, m.media, m.occurred_at,
          m.button_reply
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
    sql`select m.id, m.channel::text as channel, m.body_text, m.subject, m.media, m.occurred_at,
          m.button_reply
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
  /**
   * What they sent when they came in: their form's answers ("Question: answer" lines), or what a website or
   * another system sent. Their own words, so always quoted as data. Null when there's nothing.
   */
  readonly cameInWith: string | null;
}

export interface RunCalendar {
  readonly id: string;
  readonly name: string;
  /** What the business says it's for (the calendar's description), so the teammate picks the right one. */
  readonly description: string | null;
  readonly timeZone: string;
  readonly services: readonly { id: string; name: string; durations: number[] }[];
  /**
   * What this calendar asks for before it will hold a time. A calendar with one is **not the teammate's to
   * book**: the deposit is paid on the customer's own page, so it sends them there instead.
   */
  readonly deposit: { readonly amountCents: number; readonly mode: 'deposit' | 'full' } | null;
  /** The page a customer books it on, when the booking site is on. */
  readonly bookingPath: string | null;
  /** It offers times by the customer's ZIP code, so find_times needs theirs (M18). */
  readonly byZip: boolean;
  /** M18: some of its service areas go by distance or a drawn shape, so find_times needs their address. */
  readonly byAddress: boolean;
  /** The service areas (territories) it serves when it goes by ZIP; empty means all of them. */
  readonly areaIds: readonly string[];
  /** It keeps a waitlist the teammate may add customers to (M18). */
  readonly waitlist: boolean;
  /** Customers may book repeat visits on it, at most this many; null when they can't (M18). */
  readonly maxRepeats: number | null;
}

/** A maintenance plan the teammate may offer (M18, when its settings let it). */
export interface RunPlan {
  readonly id: string;
  readonly name: string;
  readonly priceCents: number;
  readonly interval: 'month' | 'quarter' | 'year';
  readonly intervalCount: number;
  readonly includes: readonly string[];
}

/** An offer the business is running today (M18). */
export interface RunOffer {
  readonly name: string;
  readonly details: string;
  /** The last day it runs, when it has one. */
  readonly endsOn: string | null;
}

/** Something on the price list the teammate may put on a bill or a quote (M18). */
export interface RunProduct {
  readonly id: string;
  readonly name: string;
  readonly priceCents: number;
  readonly unitLabel: string;
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

export interface RunReferral {
  readonly id: string;
  /** "Jan", "your neighbour", or "someone". */
  readonly who: string;
  readonly need: string | null;
}

/** The latest referral in this conversation nobody has thanked them for, from the last week. */
async function referralOf(tx: Tx, conversationId: string): Promise<RunReferral | null> {
  const [r] = await rows<{
    id: string;
    referred_name: string | null;
    relation: string | null;
    need: string | null;
  }>(
    tx,
    sql`select id, referred_name, relation, need from app.referrals
        where conversation_id = ${conversationId} and thanked_at is null
          and created_at > now() - interval '7 days'
        order by created_at desc limit 1`,
  );
  if (!r) return null;
  const who = r.referred_name ?? (r.relation ? `their ${r.relation}` : 'someone');
  return { id: r.id, who, need: r.need };
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
  /** A website chat whose visitor hasn't proved, with a code, that they're the customer it matched. */
  readonly unverifiedChat: boolean;
  /** The language the teammate last said the customer writes in (M18), or null. */
  readonly conversationLanguage: string | null;
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
  /** The plans it may offer; empty unless its settings let it (M18). */
  readonly plans: readonly RunPlan[];
  /** The price list it builds bills and quotes from; empty unless its settings let it (M18). */
  readonly catalogue: readonly RunProduct[];
  /** The offers running today, in the business's time zone (M18). */
  readonly offers: readonly RunOffer[];
  /** Upcoming visits; none for a chat visitor. */
  readonly appointments: readonly RunAppointment[];
  /** Their most recent visit that has happened (M18); none for a chat visitor. */
  readonly lastVisit: PastVisit | null;
  readonly batch: readonly BatchMessage[];
  readonly history: readonly HistoryLine[];
  readonly matches: readonly KnowledgeMatch[];
  /**
   * Somebody this customer said needs the business, found in this conversation and not thanked for yet
   * (Automations' "Referral mentioned"): the reply thanks them.
   */
  readonly referral?: RunReferral | null;
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
  // M18: a chat whose visitor typed back the code sent to the customer on file counts as theirs, like a text.
  const unverifiedChat = channel === 'chat' && !(conv && (await chatVerified(tx, conv)));
  const grounding = await loadGrounding(tx, ws);
  const customer = personId ? await customerOf(tx, personId) : null;
  // An unverified chat works only on a lead the chat itself opened: the customer's own, from before, is theirs to
  // read and change once the visitor proves who they are.
  const lead = customer
    ? await openLeadOf(
        tx,
        ws,
        customer.id,
        unverifiedChat && conv ? await chatOpenedAt(tx, conv) : null,
      )
    : null;
  const stages = lead ? await stagesOf(tx, lead.pipelineId) : [];
  const calendars = input.config.book.enabled
    ? await calendarsOf(tx, ws, input.config.book.calendarIds)
    : [];
  const appointments =
    customer && !unverifiedChat ? await upcomingAppointments(tx, ws, customer.id, timeZone) : [];
  const [lastVisit] =
    customer && !unverifiedChat ? await pastAppointments(tx, ws, customer.id, timeZone, 1) : [];
  const offers = input.config.answer.enabled ? await liveOffers(tx, ws, timeZone) : [];
  const money = input.config.money;
  const plans = money.plans && !unverifiedChat ? await plansOf(tx, ws) : [];
  const catalogue =
    (money.newBills || money.quotes === 'build') && !unverifiedChat
      ? await catalogueOf(tx, ws)
      : [];
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
  const referral = conv && customer && !unverifiedChat ? await referralOf(tx, conv.id) : null;
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
    conversationLanguage: conv?.language ?? null,
    visitorName: visitor?.name ?? null,
    firstAiMessage,
    discloseNow: firstAiMessage && input.config.identity.disclosure === 'first_message',
    customer,
    lead,
    stages,
    calendars,
    plans,
    catalogue,
    offers,
    appointments,
    lastVisit: lastVisit ?? null,
    batch: input.batch,
    history,
    matches,
    referral,
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

async function openLeadOf(
  tx: Tx,
  workspaceId: string,
  personId: string,
  /** Only a lead opened at or after this. */
  openedSince: Date | null,
): Promise<RunLead | null> {
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
          ${openedSince ? sql`and l.created_at >= ${openedSince.toISOString()}::timestamptz` : sql``}
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
    cameInWith: await cameInWithOf(tx, l.id),
  };
}

/** The most of what they sent that the teammate reads. */
const CAME_IN_WITH_MAX = 1200;
/** What a website or another system sends that says who they are, not what they need: left out. */
const CONTACT_KEY =
  /^(first_?name|last_?name|full_?name|name|e-?mail|phone|mobile|tel|consent|sms_?consent|utm_.*|source|page|url|referr?er|ip|user_?agent|token|id|created_?at|timestamp)$/i;

/** Plain words for one answer: a choice's label, a list joined, anything else as text. */
function answerText(value: unknown, choices: readonly { id: string; label: string }[]): string {
  const one = (v: unknown): string => {
    if (typeof v === 'string') return choices.find((c) => c.id === v)?.label ?? v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v && typeof v === 'object') return JSON.stringify(v).slice(0, 200);
    return '';
  };
  return (Array.isArray(value) ? value.map(one) : [one(value)]).filter(Boolean).join(', ');
}

/** What this lead sent when they came in: the latest form they submitted for it, else a website's submission. */
async function cameInWithOf(tx: Tx, leadId: string): Promise<string | null> {
  const [form] = await rows<{ answers: Record<string, unknown>; definition: unknown }>(
    tx,
    sql`select r.answers, v.definition from app.form_responses r
        join app.form_versions v on v.id = r.version_id
        where r.lead_id = ${leadId} and r.status = 'completed'
        order by r.completed_at desc limit 1`,
  );
  const lines: string[] = [];
  if (form) {
    try {
      for (const question of allQuestions(parseStoredForm(form.definition))) {
        const choices =
          (question.config as { choices?: { id: string; label: string }[] }).choices ?? [];
        const text = answerText(form.answers?.[question.id], choices).trim();
        // Their contact details are already on the record: only what they asked for helps.
        if (
          text &&
          !['email', 'phone', 'signature', 'file', 'payment', 'content'].includes(question.type)
        )
          lines.push(`${question.title}: ${text}`);
      }
    } catch {
      // A form this version of the app can't read: fall back to the website's submission, if any.
    }
  }
  if (!lines.length) {
    const [sub] = await rows<{ payload: Record<string, unknown> }>(
      tx,
      sql`select payload from app.intake_submissions
          where lead_id = ${leadId} order by received_at desc limit 1`,
    );
    for (const [key, value] of Object.entries(sub?.payload ?? {})) {
      if (CONTACT_KEY.test(key)) continue;
      const text = answerText(value, []).trim();
      if (text) lines.push(`${key.replace(/[_-]+/g, ' ')}: ${text}`);
    }
  }
  const all = lines.join('\n');
  return all ? all.slice(0, CAME_IN_WITH_MAX) : null;
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
  const areas = await loadTerritories(tx, workspaceId);
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
      description: cal.description?.trim() || null,
      timeZone: cal.timeZone,
      services,
      deposit: most ? { amountCents: most.amountCents, mode: most.mode } : null,
      bookingPath: site ? `/book/${site}/${cal.slug}` : null,
      byZip: cal.config.territory.routing === 'zip',
      byAddress:
        cal.config.territory.routing === 'zip' &&
        areas.some(
          (a) =>
            needsAddress(a) &&
            (!cal.config.territory.territoryIds.length ||
              cal.config.territory.territoryIds.includes(a.id)),
        ),
      areaIds: cal.config.territory.territoryIds,
      waitlist: cal.config.waitlist.enabled,
      maxRepeats:
        cal.config.recurring.customerSeries && cal.config.schedule.mode !== 'sessions'
          ? cal.config.recurring.maxOccurrences
          : null,
    });
  }
  return out;
}

/** The business's plans on sale, cheapest first. */
async function plansOf(tx: Tx, workspaceId: string): Promise<RunPlan[]> {
  const list = await rows<{
    id: string;
    name: string;
    price_cents: string;
    interval: RunPlan['interval'];
    interval_count: number;
    includes: unknown;
  }>(
    tx,
    sql`select id, name, price_cents::text as price_cents, interval::text as interval, interval_count, includes
        from app.plans where workspace_id = ${workspaceId} and archived_at is null
        order by price_cents, name limit ${PLANS_MAX}`,
  );
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    priceCents: Number(p.price_cents),
    interval: p.interval,
    intervalCount: p.interval_count,
    includes: Array.isArray(p.includes)
      ? p.includes.filter((x): x is string => typeof x === 'string').slice(0, 10)
      : [],
  }));
}

/** The offers running today where the business is, soonest to end first. */
async function liveOffers(tx: Tx, workspaceId: string, timeZone: string): Promise<RunOffer[]> {
  const today = localDateOf(Date.now(), timeZone);
  const list = await rows<{ name: string; details: string; ends_on: string | null }>(
    tx,
    sql`select name, details, ends_on::text as ends_on from app.offers
        where workspace_id = ${workspaceId} and archived_at is null
          and (starts_on is null or starts_on <= ${today}::date)
          and (ends_on is null or ends_on >= ${today}::date)
        order by ends_on nulls last, created_at limit ${OFFERS_MAX}`,
  );
  return list.map((o) => ({ name: o.name, details: o.details, endsOn: o.ends_on }));
}

/** What's on the price list, by name. */
async function catalogueOf(tx: Tx, workspaceId: string): Promise<RunProduct[]> {
  const list = await rows<{ id: string; name: string; price_cents: string; unit_label: string }>(
    tx,
    sql`select id, name, unit_price_cents::text as price_cents, unit_label
        from app.products where workspace_id = ${workspaceId} and archived_at is null
        order by lower(name) limit ${CATALOGUE_MAX}`,
  );
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    priceCents: Number(p.price_cents),
    unitLabel: p.unit_label,
  }));
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
    extras: string | null;
    starts_at: Date | string;
    ends_at: Date | string;
    calendar_id: string;
    calendar_name: string;
    timezone: string | null;
  }>(
    tx,
    sql`select a.id, a.title, s.name as service_name, a.starts_at, a.ends_at, a.calendar_id,
          (select string_agg(x.name, ' + ' order by x.created_at) from app.appointment_services x
            where x.appointment_id = a.id) as extras,
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
    title: withExtras(r.service_name ?? r.title, r.extras),
    startsAt: ms(r.starts_at),
    endsAt: ms(r.ends_at),
    calendarId: r.calendar_id,
    calendarName: r.calendar_name,
    timeZone: r.timezone || timeZone,
  }));
}

/** A visit the customer had (M18): what it was, when, and how it went. */
export interface PastVisit extends RunAppointment {
  /** completed, no_show, or scheduled when nobody marked it. */
  readonly outcome: 'completed' | 'no_show' | 'unmarked';
}

/** "AC tune-up + Filter change": a visit's own service, then those added to it (M18). */
const withExtras = (title: string, extras: string | null) =>
  extras ? `${title} + ${extras}` : title;

/** The customer's visits that have happened, most recent first. */
export async function pastAppointments(
  tx: Tx,
  workspaceId: string,
  personId: string,
  timeZone: string,
  limit = 10,
): Promise<PastVisit[]> {
  const list = await rows<{
    id: string;
    title: string;
    service_name: string | null;
    extras: string | null;
    starts_at: Date | string;
    ends_at: Date | string;
    calendar_id: string;
    calendar_name: string;
    timezone: string | null;
    status: string;
    attendee: string;
  }>(
    tx,
    sql`select a.id, a.title, s.name as service_name, a.starts_at, a.ends_at, a.calendar_id,
          (select string_agg(x.name, ' + ' order by x.created_at) from app.appointment_services x
            where x.appointment_id = a.id) as extras,
          c.name as calendar_name, c.timezone, a.status::text as status, t.status::text as attendee
        from app.appointment_attendees t
        join app.appointments a on a.id = t.appointment_id
        join app.calendars c on c.id = a.calendar_id
        left join app.services s on s.id = a.service_id
        where t.workspace_id = ${workspaceId} and t.person_id = ${personId}
          and t.status in ('booked', 'attended', 'no_show')
          and a.status <> 'cancelled' and a.starts_at <= now()
        order by a.starts_at desc, a.id limit ${limit}`,
  );
  return list.map((r) => ({
    id: r.id,
    title: withExtras(r.service_name ?? r.title, r.extras),
    startsAt: ms(r.starts_at),
    endsAt: ms(r.ends_at),
    calendarId: r.calendar_id,
    calendarName: r.calendar_name,
    timeZone: r.timezone || timeZone,
    outcome:
      r.status === 'no_show' || r.attendee === 'no_show'
        ? 'no_show'
        : r.status === 'completed' || r.attendee === 'attended'
          ? 'completed'
          : 'unmarked',
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
          m.media, m.occurred_at, m.sent_by, m.sent_by_teammate_id is not null as ai, u.full_name,
          m.rich, m.button_reply
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

/** A customer's job, for the teammate's job_status (M18 step 4). */
export interface RunJob {
  readonly title: string;
  readonly status: JobStatus;
  readonly note: string | null;
  /** On the way: when they should get there. */
  readonly etaAt: number | null;
  readonly visits: readonly { title: string; startsAt: number; status: string }[];
}

/** Their open jobs, and ones done in the last two weeks: the open first, then the latest change first. */
export async function jobsOf(tx: Tx, workspaceId: string, personId: string): Promise<RunJob[]> {
  const list = await rows<{
    title: string;
    status: JobStatus;
    customer_note: string | null;
    eta_at: Date | string | null;
    visits: { title: string; starts_at: string; status: string }[] | null;
  }>(
    tx,
    sql`select j.title, j.status, j.customer_note, j.eta_at,
          (select json_agg(json_build_object('title', a.title, 'starts_at', a.starts_at, 'status', a.status)
             order by a.starts_at)
           from app.appointments a where a.job_id = j.id) as visits
        from app.jobs j
        where j.workspace_id = ${workspaceId} and j.person_id = ${personId}
          and (j.open or (j.status = 'done' and j.status_changed_at > now() - interval '14 days'))
        order by j.open desc, coalesce(j.status_changed_at, j.created_at) desc
        limit 5`,
  );
  return list.map((j) => ({
    title: j.title,
    status: j.status,
    note: j.customer_note,
    etaAt: j.status === 'on_the_way' && j.eta_at ? ms(j.eta_at) : null,
    visits: (j.visits ?? []).map((v) => ({
      title: v.title,
      startsAt: ms(v.starts_at),
      status: v.status,
    })),
  }));
}

/** job_status's answer, for the model. */
export function jobStatusContent(
  list: readonly RunJob[],
  timeZone: string,
): Record<string, unknown> {
  if (!list.length)
    return { jobs: [], note: 'They have no open jobs, and none finished in the last two weeks.' };
  return {
    jobs: list.map((j) => ({
      job: quoteData(j.title),
      status: JOB_STATUS_WORDS[j.status],
      ...(j.etaAt ? { arrivingAround: atLabel(j.etaAt, timeZone) } : {}),
      ...(j.note ? { noteForThem: quoteData(j.note) } : {}),
      visits: j.visits.map((v) => ({
        what: quoteData(v.title),
        when: atLabel(v.startsAt, timeZone),
        ...(v.status !== 'scheduled' ? { visit: v.status } : {}),
      })),
    })),
  };
}
