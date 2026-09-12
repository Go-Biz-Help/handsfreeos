import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { people } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { addressOut, fullName, tagsOf } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
import { quietHoursState } from '../messaging/quiet-hours';
import {
  isOptedOut,
  liveNumber,
  loadRegistrations,
  readiness,
  workspaceMessaging,
} from '../messaging/store';
import {
  ConversationGetInput,
  ConversationGetOutput,
  InboxListInput,
  InboxListOutput,
  InboxSummaryInput,
  InboxSummaryOutput,
  type ConversationSummary,
} from '../schemas/conversation';
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
  channel: 'sms' | 'email';
  counterpart: string;
  status: 'open' | 'snoozed' | 'closed';
  person_id: string | null;
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
  created_at: Date;
  open_lead: {
    id: string;
    title: string;
    stageName: string;
    valueCents: number | string;
    nextAction: string | null;
    nextActionAt: string | null;
  } | null;
  sort_key: string;
};

const conversationSelect = (workspaceId: string) => sql`
  select c.id, c.channel::text as channel, c.counterpart, c.status::text as status, c.person_id, p.first_name, p.last_name,
    c.assignee_user_id, coalesce(nullif(u.full_name, ''), u.email::text) as assignee_name, c.unread_count, c.last_message_at,
    c.last_preview, c.last_direction::text as last_direction, c.awaiting_reply_since, c.snoozed_until, c.created_at,
    (select json_build_object('id', l.id, 'title', l.title, 'stageName', s.name, 'valueCents', l.value_cents,
              'nextAction', l.next_action, 'nextActionAt', l.next_action_at)
       from app.leads l join app.pipeline_stages s on s.id = l.stage_id
       where c.person_id is not null and l.person_id = c.person_id and l.status = 'open' and l.archived_at is null
       order by l.updated_at desc limit 1) as open_lead,
    (select json_build_object('id', su.id, 'fullName', coalesce(nullif(su.full_name, ''), su.email::text))
       from app.messages lm join app.users su on su.id = lm.sent_by
       where lm.conversation_id = c.id and lm.direction = 'outbound'
       order by lm.occurred_at desc limit 1) as last_sender,
    ${SORT_KEY(sql`coalesce(c.last_message_at, c.created_at)`)} as sort_key
  from app.conversations c
  left join app.people p on p.id = c.person_id
  left join app.users u on u.id = c.assignee_user_id
  where c.workspace_id = ${workspaceId}`;

function summary(r: ConversationRow): ConversationSummary {
  return {
    id: r.id,
    channel: r.channel,
    counterpart: r.counterpart,
    counterpartDisplay: r.channel === 'sms' ? formatPhone(r.counterpart) : r.counterpart,
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
    openLead: r.open_lead
      ? {
          id: r.open_lead.id,
          title: r.open_lead.title,
          stageName: r.open_lead.stageName,
          valueCents: Number(r.open_lead.valueCents),
          nextAction: r.open_lead.nextAction,
          nextActionAt: iso(r.open_lead.nextActionAt),
        }
      : null,
    createdAt: iso(r.created_at)!,
  };
}

export const inboxList = defineQuery({
  name: 'inbox.list',
  description:
    'Conversations newest first: mine, unassigned or everyone’s; open, snoozed or closed; texts or email; with search.',
  input: InboxListInput,
  output: InboxListOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const cursor = decodeCursor(input.cursor);
    const q = input.q ? `%${input.q.toLowerCase()}%` : null;
    const digits = input.q?.replace(/[^0-9]/g, '') ?? '';
    const list = await rows<ConversationRow>(
      ctx.tx,
      sql`select * from (${conversationSelect(input.workspaceId)}
            ${input.personId ? sql`and c.person_id = ${input.personId}` : sql`and c.status = ${input.status}::app.conversation_status and c.last_message_at is not null`}
            ${input.box === 'mine' ? sql`and c.assignee_user_id = ${me}` : input.box === 'unassigned' ? sql`and c.assignee_user_id is null` : sql``}
            ${input.channel ? sql`and c.channel = ${input.channel}::app.channel` : sql``}
            ${
              q
                ? sql`and (lower(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) like ${q}
                      or lower(c.counterpart) like ${q} or lower(coalesce(c.last_preview, '')) like ${q}
                      ${digits.length >= 3 ? sql`or c.counterpart like ${`%${digits}%`}` : sql``})`
                : sql``
            }
          ) x
          ${cursor ? sql`where (x.sort_key, x.id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
          order by x.sort_key desc, x.id desc
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
              and c.awaiting_reply_since <= now() - make_interval(mins => ${threshold}))::int as waiting
          from app.conversations c where c.workspace_id = ${input.workspaceId} and c.last_message_at is not null`,
    );
    const n = (k: string) => Number(s?.[k] ?? 0);
    return {
      unread: { mine: n('unread_mine'), unassigned: n('unread_unassigned'), all: n('unread_all') },
      open: { mine: n('open_mine'), unassigned: n('open_unassigned'), all: n('open_all') },
      waiting: n('waiting'),
      waitingThresholdMinutes: threshold,
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
    const number = await liveNumber(ctx.tx, input.workspaceId);
    const ready = readiness(number, await loadRegistrations(ctx.tx, input.workspaceId));
    const canText =
      row.channel === 'email'
        ? { ok: false, reason: 'email_channel' as const }
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
  channel: 'sms' | 'email' | null;
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
  answered_by: string | null;
  answered_name: string | null;
  recording_path: string | null;
  answered_via: 'browser' | 'forwarding' | null;
  sort_key: string;
};

const messageBranch = (workspaceId: string) => sql`
  select 'message'::text as type, m.id, m.conversation_id, m.occurred_at, m.direction::text as direction, m.status::text as status,
    m.channel::text as channel, m.body_text as body, m.subject, m.from_address, m.media, m.sent_by as user_id,
    coalesce(nullif(su.full_name, ''), su.email::text) as user_name, m.error_code, m.error_message, m.delivered_at,
    null::int as duration_seconds, false as is_voicemail, false as has_recording, null::text as transcript,
    null::uuid as answered_by, null::text as answered_name, null::text as recording_path, null::text as answered_via,
    ${SORT_KEY(sql`m.occurred_at`)} as sort_key
  from app.messages m left join app.users su on su.id = m.sent_by
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
    answeredVia: r.answered_via,
    transcript: r.transcript,
    answeredBy: r.answered_by
      ? { id: r.answered_by, fullName: r.answered_name ?? 'Former member' }
      : null,
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
            union all
            select 'call'::text, c.id, c.conversation_id, c.started_at, c.direction::text, c.status::text, null::text, null::text, null::text,
              c.from_e164, '[]'::jsonb, c.placed_by, coalesce(nullif(pu.full_name, ''), pu.email::text), null::text, null::text, null::timestamptz,
              c.duration_seconds, c.is_voicemail, c.recording_object_path is not null, c.transcript, c.answered_by_user_id,
              coalesce(nullif(au.full_name, ''), au.email::text), c.recording_object_path, c.answered_via::text,
              ${SORT_KEY(sql`c.started_at`)}
            from app.calls c
            left join app.users pu on pu.id = c.placed_by
            left join app.users au on au.id = c.answered_by_user_id
            where c.workspace_id = ${input.workspaceId} and c.conversation_id = ${input.conversationId}
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
