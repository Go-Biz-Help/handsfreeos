import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { people } from '@hfos/db/schema';
import { CHAT_ON_SITE_MS, CHAT_VISITOR_NAME } from '../chat/limits';
import { chatWidgetName } from '../chat/origins';
import { formatPhone } from '../crm/phone';
import { addressOut, fullName, tagsOf } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
import type { QueryContext } from '../kernel/types';
import { CANCELLED_TEXT, quietHoursState, SCHEDULED_TEXT } from '../messaging/quiet-hours';
import {
  isOptedOut,
  conversationNumber,
  loadRegistrations,
  readiness,
  workspaceMessaging,
} from '../messaging/store';
import {
  CallLogInput,
  CallLogOutput,
  ConversationGetInput,
  ConversationGetOutput,
  InboxListInput,
  InboxListOutput,
  InboxSummaryInput,
  InboxSummaryOutput,
  type ConversationChat,
  type ConversationSummary,
} from '../schemas/conversation';
import type { ConversationHandoffReason } from '../schemas/ai-team';
import {
  ConversationThreadInput,
  ConversationThreadOutput,
  MessageGetInput,
  MessageGetOutput,
  type MediaRefOut,
  type ThreadItem,
} from '../schemas/message';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const SORT_KEY = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type ConversationRow = {
  id: string;
  channel: 'sms' | 'email' | 'chat';
  /** A website chat's visitor's name, as they typed it. */
  visitor_name: string | null;
  counterpart: string;
  status: 'open' | 'snoozed' | 'closed';
  person_id: string | null;
  /** The number this thread is on, so a reply goes out from where the customer wrote to (M17). */
  phone_number_id: string | null;
  first_name: string | null;
  last_name: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  unread_count: number;
  last_message_at: Date | null;
  last_preview: string | null;
  last_direction: 'inbound' | 'outbound' | null;
  last_sender: { id: string; fullName: string } | null;
  awaiting_reply_since: Date | null;
  snoozed_until: Date | null;
  archived_at: Date | null;
  created_at: Date;
  handled_by: 'none' | 'ai' | 'person';
  ai_teammate_id: string | null;
  teammate_name: string | null;
  needs_person_since: Date | null;
  handoff_reason: ConversationHandoffReason | null;
  handoff_note: string | null;
  taken_over_by: string | null;
  taken_over_name: string | null;
  on_site_now: boolean;
  open_lead: {
    id: string;
    title: string;
    stageId: string;
    pipelineId: string;
    stageName: string;
    valueCents: number | string;
    nextAction: string | null;
    nextActionAt: string | null;
  } | null;
  sort_key: string;
};

/** `sortBy` needs_person: the "Needs a person" box, by how long it has waited. */
const conversationSelect = (
  workspaceId: string,
  sortBy: 'recent' | 'needs_person' = 'recent',
) => sql`
  select c.id, c.channel::text as channel, c.counterpart, c.status::text as status, c.person_id, c.phone_number_id,
    p.first_name, p.last_name,
    c.assignee_user_id, coalesce(nullif(u.full_name, ''), u.email::text) as assignee_name, c.unread_count, c.last_message_at,
    c.last_preview, c.last_direction::text as last_direction, c.awaiting_reply_since, c.snoozed_until, c.archived_at, c.created_at,
    cv.name as visitor_name,
    coalesce(cv.last_seen_at > now() - ${CHAT_ON_SITE_MS}::float8 * interval '1 millisecond', false) as on_site_now,
    c.handled_by::text as handled_by, c.ai_teammate_id, tm.name as teammate_name, c.needs_person_since,
    c.handoff_reason, c.handoff_note, c.taken_over_by,
    coalesce(nullif(tu.full_name, ''), tu.email::text) as taken_over_name,
    (select json_build_object('id', l.id, 'title', l.title, 'stageId', l.stage_id, 'pipelineId', s.pipeline_id,
              'stageName', s.name, 'valueCents', l.value_cents,
              'nextAction', l.next_action, 'nextActionAt', l.next_action_at)
       from app.leads l join app.pipeline_stages s on s.id = l.stage_id
       where c.person_id is not null and l.person_id = c.person_id and l.status = 'open' and l.archived_at is null
       order by l.updated_at desc limit 1) as open_lead,
    (select json_build_object('id', su.id, 'fullName', coalesce(nullif(su.full_name, ''), su.email::text))
       from app.messages lm join app.users su on su.id = lm.sent_by
       where lm.conversation_id = c.id and lm.direction = 'outbound'
       order by lm.occurred_at desc limit 1) as last_sender,
    ${SORT_KEY(sortBy === 'needs_person' ? sql`c.needs_person_since` : sql`coalesce(c.last_message_at, c.created_at)`)} as sort_key
  from app.conversations c
  left join app.people p on p.id = c.person_id
  left join app.users u on u.id = c.assignee_user_id
  left join app.chat_visitors cv on cv.conversation_id = c.id
  left join app.ai_teammates tm on tm.id = c.ai_teammate_id
  left join app.users tu on tu.id = c.taken_over_by
  where c.workspace_id = ${workspaceId}`;

function summary(r: ConversationRow): ConversationSummary {
  return {
    id: r.id,
    channel: r.channel,
    counterpart: r.counterpart,
    counterpartDisplay:
      r.channel === 'sms'
        ? formatPhone(r.counterpart)
        : r.channel === 'chat'
          ? (r.visitor_name ?? CHAT_VISITOR_NAME)
          : r.counterpart,
    status: r.status,
    person: r.person_id
      ? { id: r.person_id, fullName: fullName(r.first_name ?? '', r.last_name ?? '') }
      : null,
    assignee: r.assignee_user_id
      ? { id: r.assignee_user_id, fullName: r.assignee_name ?? 'Former member' }
      : null,
    unreadCount: Number(r.unread_count),
    lastMessageAt: iso(r.last_message_at),
    lastPreview: r.last_preview,
    lastDirection: r.last_direction,
    lastSentBy: r.last_direction === 'outbound' ? r.last_sender : null,
    awaitingReplySince: iso(r.awaiting_reply_since),
    snoozedUntil: iso(r.snoozed_until),
    archived: r.archived_at !== null,
    openLead: r.open_lead
      ? {
          id: r.open_lead.id,
          title: r.open_lead.title,
          stageId: r.open_lead.stageId,
          pipelineId: r.open_lead.pipelineId,
          stageName: r.open_lead.stageName,
          valueCents: Number(r.open_lead.valueCents),
          nextAction: r.open_lead.nextAction,
          nextActionAt: iso(r.open_lead.nextActionAt),
        }
      : null,
    createdAt: iso(r.created_at)!,
    handledBy: r.handled_by,
    teammate:
      r.ai_teammate_id && r.teammate_name ? { id: r.ai_teammate_id, name: r.teammate_name } : null,
    needsPersonSince: iso(r.needs_person_since),
    handoffReason: r.handoff_reason,
    handoffNote: r.handoff_note,
    takenOverBy: r.taken_over_by
      ? { id: r.taken_over_by, fullName: r.taken_over_name ?? 'Former member' }
      : null,
    onSiteNow: r.channel === 'chat' && !!r.on_site_now,
  };
}

/**
 * A website chat's visitor for the inbox: what they typed, where they are, and whether they're blocked. Only
 * the columns people may read (never the token hashes or the hashed IP).
 */
async function chatOf(
  ctx: QueryContext,
  workspaceId: string,
  conversationId: string,
  person: { readonly phoneE164: string | null; readonly email: string | null } | null,
): Promise<ConversationChat | null> {
  const [v] = await rows<{
    id: string;
    widget_id: string;
    name: string | null;
    phone_e164: string | null;
    email: string | null;
    last_page_path: string | null;
    last_seen_at: Date | null;
    on_site_now: boolean;
    blocked: boolean;
    network_blocked_until: Date | null;
    allowed_origins: string[];
  }>(
    ctx.tx,
    sql`select v.id, v.widget_id, v.name, v.phone_e164, v.email, v.last_page_path, v.last_seen_at,
          coalesce(v.last_seen_at > now() - ${CHAT_ON_SITE_MS}::float8 * interval '1 millisecond', false) as on_site_now,
          v.blocked_at is not null as blocked,
          case when v.network_blocked_until > now() then v.network_blocked_until end as network_blocked_until,
          w.allowed_origins
        from app.chat_visitors v join app.chat_widgets w on w.id = v.widget_id
        where v.workspace_id = ${workspaceId} and v.conversation_id = ${conversationId}`,
  );
  if (!v) return null;
  const matchedOn =
    person && v.phone_e164 && person.phoneE164 === v.phone_e164
      ? ('phone' as const)
      : person && v.email && person.email?.toLowerCase() === v.email
        ? ('email' as const)
        : null;
  return {
    visitorId: v.id,
    widgetId: v.widget_id,
    site: chatWidgetName(v.allowed_origins ?? []),
    name: v.name,
    phone: v.phone_e164 ? formatPhone(v.phone_e164) : null,
    phoneE164: v.phone_e164,
    email: v.email,
    matchedOn,
    pagePath: v.last_page_path,
    lastSeenAt: iso(v.last_seen_at),
    onSiteNow: v.on_site_now,
    blocked: v.blocked,
    networkBlockedUntil: iso(v.network_blocked_until),
  };
}

export const inboxList = defineQuery({
  name: 'inbox.list',
  description:
    'Conversations newest first: mine, unassigned or everyone’s, those waiting for a person (oldest first) or the AI teammate’s; open, snoozed or closed; texts or email; with search.',
  input: InboxListInput,
  output: InboxListOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const cursor = decodeCursor(input.cursor);
    const q = input.q ? `%${input.q.toLowerCase()}%` : null;
    const digits = input.q?.replace(/[^0-9]/g, '') ?? '';
    // "Needs a person" lists whoever has waited longest first.
    const oldestFirst = input.box === 'needs_person';
    const box =
      input.box === 'mine'
        ? sql`and c.assignee_user_id = ${me}`
        : input.box === 'unassigned'
          ? sql`and c.assignee_user_id is null`
          : input.box === 'needs_person'
            ? sql`and c.needs_person_since is not null`
            : input.box === 'ai'
              ? sql`and c.handled_by = 'ai'`
              : sql``;
    // Archived threads are out of the inbox: only their own box shows them, and only it hides the live ones.
    const archived =
      input.box === 'archived'
        ? sql`and c.archived_at is not null`
        : sql`and c.archived_at is null`;
    const list = await rows<ConversationRow>(
      ctx.tx,
      sql`select * from (${conversationSelect(input.workspaceId, oldestFirst ? 'needs_person' : 'recent')}
            ${
              input.personId
                ? sql`and c.person_id = ${input.personId}`
                : // Archived threads keep whatever status they had, so their own box lists them all rather than
                  // hiding every closed one behind a status nobody chose.
                  input.box === 'archived'
                  ? sql`and c.last_message_at is not null`
                  : sql`and c.status = ${input.status}::app.conversation_status and c.last_message_at is not null`
            }
            ${box}
            ${archived}
            ${input.channel ? sql`and c.channel = ${input.channel}::app.channel` : sql``}
            ${
              q
                ? sql`and (lower(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) like ${q}
                      or lower(c.counterpart) like ${q} or lower(coalesce(c.last_preview, '')) like ${q}
                      or lower(coalesce(cv.name, '')) like ${q}
                      ${digits.length >= 3 ? sql`or c.counterpart like ${`%${digits}%`}` : sql``})`
                : sql``
            }
          ) x
          ${cursor ? (oldestFirst ? sql`where (x.sort_key, x.id) > (${cursor.sort}, ${cursor.id}::uuid)` : sql`where (x.sort_key, x.id) < (${cursor.sort}, ${cursor.id}::uuid)`) : sql``}
          order by ${oldestFirst ? sql`x.sort_key asc, x.id asc` : sql`x.sort_key desc, x.id desc`}
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return { items: result.items.map(summary), nextCursor: result.nextCursor };
  },
});

export const inboxSummary = defineQuery({
  name: 'inbox.summary',
  description:
    'Unread and open counts for the badges, and how many customers are waiting too long.',
  input: InboxSummaryInput,
  output: InboxSummaryOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const m = await workspaceMessaging(ctx.tx, input.workspaceId);
    const threshold = m.settings.unansweredReminderMinutes || 10;
    const [s] = await rows<Record<string, number>>(
      ctx.tx,
      sql`select
            count(*) filter (where c.status = 'open')::int as open_all,
            count(*) filter (where c.status = 'open' and c.assignee_user_id = ${me})::int as open_mine,
            count(*) filter (where c.status = 'open' and c.assignee_user_id is null)::int as open_unassigned,
            count(*) filter (where c.status = 'open' and c.unread_count > 0)::int as unread_all,
            count(*) filter (where c.status = 'open' and c.unread_count > 0 and c.assignee_user_id = ${me})::int as unread_mine,
            count(*) filter (where c.status = 'open' and c.unread_count > 0 and c.assignee_user_id is null)::int as unread_unassigned,
            count(*) filter (where c.status = 'open' and c.awaiting_reply_since is not null
              and c.awaiting_reply_since <= now() - make_interval(mins => ${threshold}))::int as waiting,
            count(*) filter (where c.status = 'open' and c.needs_person_since is not null)::int as needs_person,
            count(*) filter (where c.status = 'open' and c.handled_by = 'ai')::int as ai
          from app.conversations c
          where c.workspace_id = ${input.workspaceId} and c.last_message_at is not null
            and c.archived_at is null`,
    );
    const n = (k: string) => Number(s?.[k] ?? 0);
    return {
      unread: { mine: n('unread_mine'), unassigned: n('unread_unassigned'), all: n('unread_all') },
      open: { mine: n('open_mine'), unassigned: n('open_unassigned'), all: n('open_all') },
      waiting: n('waiting'),
      waitingThresholdMinutes: threshold,
      needsPerson: n('needs_person'),
      ai: n('ai'),
    };
  },
});

export const conversationGet = defineQuery({
  name: 'conversation.get',
  description:
    'One conversation with the customer beside it: contact details, open lead, open tasks, and whether a text can go out now.',
  input: ConversationGetInput,
  output: ConversationGetOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [row] = await rows<ConversationRow>(
      ctx.tx,
      sql`${conversationSelect(input.workspaceId)} and c.id = ${input.conversationId}`,
    );
    if (!row) throw HfosError.notFound('Conversation not found.');
    const m = await workspaceMessaging(ctx.tx, input.workspaceId);
    let person: {
      id: string;
      fullName: string;
      firstName: string;
      lastName: string;
      phone: string | null;
      phoneE164: string | null;
      email: string | null;
      address: ReturnType<typeof addressOut>;
      tags: { id: string; name: string; color: string }[];
      customerSince: string;
      smsConsent: 'unknown' | 'opted_in' | 'opted_out';
      archived: boolean;
    } | null = null;
    let openTasks: {
      id: string;
      title: string;
      dueAt: string | null;
      allDay: boolean;
      overdue: boolean;
    }[] = [];
    if (row.person_id) {
      const [p] = await ctx.tx.select().from(people).where(eq(people.id, row.person_id));
      if (p) {
        person = {
          id: p.id,
          fullName: fullName(p.firstName, p.lastName),
          firstName: p.firstName,
          lastName: p.lastName,
          phone: p.phoneE164 ? formatPhone(p.phoneE164) : null,
          phoneE164: p.phoneE164,
          email: p.email,
          address: addressOut(p),
          tags: await tagsOf(ctx.tx, input.workspaceId, 'person', p.id),
          customerSince: p.createdAt.toISOString(),
          smsConsent: p.smsConsent,
          archived: !!p.archivedAt,
        };
        const tasks = await rows<{
          id: string;
          title: string;
          due_at: Date | null;
          all_day: boolean;
          overdue: boolean;
        }>(
          ctx.tx,
          sql`select t.id, t.title, t.due_at, t.all_day,
                coalesce(t.due_at is not null and ((t.all_day and (t.due_at at time zone ${m.timezone})::date < (now() at time zone ${m.timezone})::date)
                  or (not t.all_day and t.due_at < now())), false) as overdue
              from app.tasks t
              where t.workspace_id = ${input.workspaceId} and t.person_id = ${p.id} and t.done_at is null
              order by t.due_at asc nulls last, t.created_at
              limit 5`,
        );
        openTasks = tasks.map((t) => ({
          id: t.id,
          title: t.title,
          dueAt: iso(t.due_at),
          allDay: t.all_day,
          overdue: t.overdue,
        }));
      }
    }
    // This thread's own number, because that is what a reply will go out from and what `fromNumber` shows
    // (M17). A thread whose number was released falls back to the default, exactly as sending does.
    const number = await conversationNumber(ctx.tx, input.workspaceId, row.phone_number_id);
    const ready = readiness(number, await loadRegistrations(ctx.tx, input.workspaceId));
    const canText =
      row.channel === 'email'
        ? { ok: false, reason: 'email_channel' as const }
        : row.channel === 'chat'
          ? { ok: false, reason: 'chat_channel' as const }
          : !number || number.status !== 'active'
            ? { ok: false, reason: 'no_number' as const }
            : !ready.messagingReady
              ? { ok: false, reason: 'not_ready' as const }
              : (await isOptedOut(ctx.tx, input.workspaceId, row.counterpart)) ||
                  person?.smsConsent === 'opted_out'
                ? { ok: false, reason: 'opted_out' as const }
                : { ok: true, reason: null };
    return {
      conversation: summary(row),
      chat: row.channel === 'chat' ? await chatOf(ctx, input.workspaceId, row.id, person) : null,
      person,
      openTasks,
      canText,
      fromNumber: number ? formatPhone(number.e164) : null,
      quiet: quietHoursState(m.settings.quietHours, m.timezone),
      timezone: m.timezone,
    };
  },
});

type ThreadRow = {
  type: 'message' | 'call';
  id: string;
  occurred_at: Date;
  direction: 'inbound' | 'outbound';
  status: string;
  channel: 'sms' | 'email' | 'chat' | null;
  body: string | null;
  subject: string | null;
  from_address: string | null;
  media: MediaRefOut[] | null;
  user_id: string | null;
  user_name: string | null;
  error_code: string | null;
  error_message: string | null;
  delivered_at: Date | null;
  duration_seconds: number | null;
  is_voicemail: boolean;
  has_recording: boolean;
  transcript: string | null;
  transcript_status: 'pending' | 'completed' | 'failed' | null;
  answered_by: string | null;
  answered_name: string | null;
  recording_path: string | null;
  recording_seconds: number | null;
  answered_via: 'browser' | 'forwarding' | 'bridge' | null;
  scheduled_for: Date | null;
  body_html: string | null;
  to_addresses: string[] | null;
  cc_addresses: string[] | null;
  via: 'microsoft' | 'google' | null;
  teammate_id: string | null;
  teammate_name: string | null;
  approved_by: string | null;
  approved_name: string | null;
  ai_draft_id: string | null;
  handoff_line: boolean;
  sort_key: string;
};

const messageBranch = (workspaceId: string) => sql`
  select 'message'::text as type, m.id, m.conversation_id, m.occurred_at, m.direction::text as direction, m.status::text as status,
    m.channel::text as channel, m.body_text as body, m.subject, m.from_address, m.media, m.sent_by as user_id,
    coalesce(nullif(su.full_name, ''), su.email::text) as user_name, m.error_code, m.error_message, m.delivered_at,
    null::int as duration_seconds, false as is_voicemail, false as has_recording, null::text as transcript,
    null::text as transcript_status,
    null::uuid as answered_by, null::text as answered_name, null::text as recording_path, null::int as recording_seconds, null::text as answered_via,
    m.body_html, m.to_addresses, m.cc_addresses, mc.provider::text as via,
    m.sent_by_teammate_id as teammate_id, tt.name as teammate_name, m.approved_by,
    coalesce(nullif(ab.full_name, ''), ab.email::text) as approved_name, m.ai_draft_id,
    coalesce(m.client_id, '') like 'handoff:%' as handoff_line,
    case when m.status = 'queued' and m.error_code = ${SCHEDULED_TEXT} then m.occurred_at end as scheduled_for,
    ${SORT_KEY(sql`m.occurred_at`)} as sort_key
  from app.messages m left join app.users su on su.id = m.sent_by
  left join app.mailbox_connections mc on mc.id = m.mailbox_connection_id
  left join app.ai_teammates tt on tt.id = m.sent_by_teammate_id
  left join app.users ab on ab.id = m.approved_by
  where m.workspace_id = ${workspaceId}`;

function threadItem(r: ThreadRow): ThreadItem {
  return {
    type: r.type,
    id: r.id,
    occurredAt: iso(r.occurred_at)!,
    direction: r.direction,
    status: r.status,
    channel: r.channel,
    body: r.body,
    subject: r.subject,
    fromAddress: r.from_address,
    media: r.media ?? [],
    sentBy: r.user_id ? { id: r.user_id, fullName: r.user_name ?? 'Former member' } : null,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    deliveredAt: iso(r.delivered_at),
    durationSeconds: r.duration_seconds,
    isVoicemail: !!r.is_voicemail,
    hasRecording: !!r.has_recording,
    recordingPath: r.recording_path,
    recordingSeconds: r.recording_seconds,
    answeredVia: r.answered_via,
    transcript: r.transcript,
    transcriptStatus: r.transcript_status,
    answeredBy: r.answered_by
      ? { id: r.answered_by, fullName: r.answered_name ?? 'Former member' }
      : null,
    bodyHtml: r.body_html,
    toAddresses: r.to_addresses ?? [],
    ccAddresses: r.cc_addresses ?? [],
    via: r.via,
    teammate:
      r.teammate_id && r.teammate_name ? { id: r.teammate_id, name: r.teammate_name } : null,
    approvedBy: r.approved_by
      ? { id: r.approved_by, fullName: r.approved_name ?? 'Former member' }
      : null,
    aiDraftId: r.ai_draft_id,
    handoffLine: !!r.handoff_line,
    scheduledFor: iso(r.scheduled_for),
  };
}

export const conversationThread = defineQuery({
  name: 'conversation.thread',
  description: 'The messages and calls in one conversation, newest first.',
  input: ConversationThreadInput,
  output: ConversationThreadOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [exists] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.conversations where id = ${input.conversationId} and workspace_id = ${input.workspaceId}`,
    );
    if (!exists) throw HfosError.notFound('Conversation not found.');
    const cursor = decodeCursor(input.cursor);
    const list = await rows<ThreadRow>(
      ctx.tx,
      sql`select * from (
            ${messageBranch(input.workspaceId)} and m.conversation_id = ${input.conversationId}
              and m.error_code is distinct from ${CANCELLED_TEXT}
            union all
            select 'call'::text, c.id, c.conversation_id, c.started_at, c.direction::text, c.status::text, null::text, null::text, null::text,
              c.from_e164, '[]'::jsonb, c.placed_by, coalesce(nullif(pu.full_name, ''), pu.email::text), null::text, null::text, null::timestamptz,
              c.duration_seconds, c.is_voicemail, c.recording_object_path is not null, c.transcript,
              c.transcript_status::text, c.answered_by_user_id,
              coalesce(nullif(au.full_name, ''), au.email::text), c.recording_object_path, c.recording_seconds, c.answered_via::text,
              null::text, '{}'::text[], '{}'::text[], null::text,
              null::uuid, null::text, null::uuid, null::text, null::uuid, false, null::timestamptz,
              ${SORT_KEY(sql`c.started_at`)}
            from app.calls c
            left join app.users pu on pu.id = c.placed_by
            left join app.users au on au.id = c.answered_by_user_id
            where c.workspace_id = ${input.workspaceId} and c.conversation_id = ${input.conversationId}
              -- A call through someone's own cell joins the conversation once the customer's phone was dialed.
              and (c.answered_via is distinct from 'bridge' or c.answered_by_user_id is not null)
          ) t
          where true
          ${input.since ? sql`and t.occurred_at > ${input.since}::timestamptz` : sql``}
          ${cursor ? sql`and (t.sort_key, t.id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
          order by t.sort_key desc, t.id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return { items: result.items.map(threadItem), nextCursor: result.nextCursor };
  },
});

export const messageGet = defineQuery({
  name: 'message.get',
  description: 'One message, as it appears in the thread.',
  input: MessageGetInput,
  output: MessageGetOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [row] = await rows<ThreadRow & { conversation_id: string }>(
      ctx.tx,
      sql`${messageBranch(input.workspaceId)} and m.id = ${input.messageId}`,
    );
    if (!row) throw HfosError.notFound('Message not found.');
    return { message: threadItem(row), conversationId: row.conversation_id };
  },
});

/**
 * The call log: every call the business made or took, newest first, apart from the conversation it belongs to.
 *
 * The thread shows a call where it happened, which is right when you are reading one conversation and no use at
 * all when the question is "who rang this morning". `missed` is the one that gets looked at: an inbound call
 * nobody answered, whether or not they left anything.
 */
export const callLog = defineQuery({
  name: 'call.log',
  description:
    'Calls newest first: all of them, the ones nobody answered, or the ones that left a voicemail.',
  input: CallLogInput,
  output: CallLogOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const cursor = decodeCursor(input.cursor);
    const filter =
      input.filter === 'missed'
        ? sql`and c.direction = 'inbound' and c.answered_at is null`
        : input.filter === 'voicemail'
          ? sql`and c.is_voicemail`
          : sql``;
    const list = await rows<{
      id: string;
      conversation_id: string | null;
      person_id: string | null;
      first_name: string | null;
      last_name: string | null;
      counterpart: string;
      direction: 'inbound' | 'outbound';
      status: string;
      started_at: Date;
      duration_seconds: number | null;
      is_voicemail: boolean;
      answered_via: 'browser' | 'forwarding' | 'bridge' | null;
      answered_by: string | null;
      answered_name: string | null;
      recording_path: string | null;
      recording_seconds: number | null;
      transcript: string | null;
      transcript_status: 'pending' | 'completed' | 'failed' | null;
      sort_key: string;
    }>(
      ctx.tx,
      sql`select c.id, c.conversation_id, c.person_id, p.first_name, p.last_name,
            case when c.direction = 'inbound' then c.from_e164 else c.to_e164 end as counterpart,
            c.direction::text as direction, c.status::text as status, c.started_at,
            c.duration_seconds, c.is_voicemail, c.answered_via::text as answered_via,
            c.answered_by_user_id as answered_by,
            coalesce(nullif(au.full_name, ''), au.email::text) as answered_name,
            c.recording_object_path as recording_path, c.recording_seconds,
            c.transcript, c.transcript_status::text as transcript_status,
            ${SORT_KEY(sql`c.started_at`)} as sort_key
          from app.calls c
          left join app.people p on p.id = c.person_id
          left join app.users au on au.id = c.answered_by_user_id
          where c.workspace_id = ${input.workspaceId}
          ${filter}
          ${cursor ? sql`and (${SORT_KEY(sql`c.started_at`)}, c.id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
          order by c.started_at desc, c.id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return {
      items: result.items.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        personId: r.person_id,
        who:
          fullName(r.first_name ?? '', r.last_name ?? '') ||
          (r.counterpart.startsWith('+') ? formatPhone(r.counterpart) : r.counterpart),
        counterpart: r.counterpart,
        direction: r.direction,
        status: r.status,
        occurredAt: new Date(r.started_at).toISOString(),
        durationSeconds: r.duration_seconds,
        isVoicemail: !!r.is_voicemail,
        answeredVia: r.answered_via,
        answeredBy: r.answered_by
          ? { id: r.answered_by, fullName: r.answered_name ?? 'Former member' }
          : null,
        recordingPath: r.recording_path,
        recordingSeconds: r.recording_seconds,
        transcript: r.transcript,
        transcriptStatus: r.transcript_status,
      })),
      nextCursor: result.nextCursor,
    };
  },
});
