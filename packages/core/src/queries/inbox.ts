import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { metaAccounts, people } from '@hfos/db/schema';
import { uuidArray } from '../calendar/load';
import { CHAT_ON_SITE_MS, CHAT_VISITOR_NAME } from '../chat/limits';
import { META_ACCOUNT_COLUMNS } from '../commands/social';
import { chatWidgetName } from '../chat/origins';
import { formatPhone } from '../crm/phone';
import { addressOut, fullName, tagsOf } from '../crm/records';
import { HfosError } from '../errors';
import { lineDisplayOf } from '../inbox/rows';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { decodeCursor, decodeTimeCursor, page } from '../kernel/pagination';
import type { QueryContext } from '../kernel/types';
import { CANCELLED_TEXT, quietHoursState, SCHEDULED_TEXT } from '../messaging/quiet-hours';
import {
  isSocialChannel,
  metaAccountLabel,
  SOCIAL_TEXT_LIMITS,
  socialContactName,
  socialReplyWindow,
} from '../messaging/social';
import {
  isOptedOut,
  conversationNumber,
  currentRcsSender,
  loadRegistrations,
  rcsSending,
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
  type ConversationChannel,
  type ConversationChat,
  type ConversationLane,
  type ConversationSummary,
} from '../schemas/conversation';
import type { ConversationHandoffReason } from '../schemas/ai-team';
import type { ButtonReplyOut, RichTextOut } from '../schemas/rcs';
import {
  ConversationThreadInput,
  ConversationThreadOutput,
  MessageGetInput,
  MessageGetOutput,
  type MediaRefOut,
  type ThreadItem,
} from '../schemas/message';
import type { z } from 'zod';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const SORT_KEY = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type ConversationRow = {
  id: string;
  /** M19: the Inbox, Other mail or Spam, and whether it is the viewer's own mail. */
  folder: 'inbox' | 'other' | 'spam';
  private: boolean;
  channel: ConversationChannel;
  /** A portal thread's record, and its name (Real Estate round two). */
  record_id: string | null;
  record_name: string | null;
  /** A website chat's visitor's name, as they typed it. */
  visitor_name: string | null;
  /** A Messenger or Instagram thread's customer, as Meta named them (20261025000200). */
  social_name: string | null;
  social_username: string | null;
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
  /** The customer this row stands for: their id, or their address when nobody has linked them (0089). */
  group_key?: string;
  /** Every lane of theirs the viewer may see. Absent on the queries that are about one thread. */
  lanes?: readonly LaneRow[] | null;
  same_as?: { id: string; fullName: string } | null;
};

/** A lane as the database hands it over: raw, because how a line reads is the mapper's business. */
type LaneRow = {
  id: string;
  channel: ConversationChannel;
  /** A portal thread's record's name. */
  record_name: string | null;
  line_id: string | null;
  line_e164: string | null;
  line_label: string | null;
  line_address: string | null;
  /** A Messenger or Instagram thread's Page or account, as the screens call it. */
  line_account: string | null;
  unread_count: number | string;
  status: 'open' | 'snoozed' | 'closed';
  archived: boolean;
  last_message_at: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
};

/**
 * Which customer a thread belongs to, for an inbox that shows each of them once (0089).
 *
 * Their id when somebody has linked the thread to a customer, so every lane of theirs — texts on two of the
 * business's numbers, mail on two of its addresses, a website chat — collapses into one row. Otherwise the
 * address itself, which still merges an unknown number that has written to two of the business's lines, and
 * still keeps an unknown number apart from an unknown mail address: nothing here knows they are the same
 * person, and guessing that is how a shared family phone becomes one customer.
 */
const GROUP_KEY = sql`coalesce(c.person_id::text, c.channel::text || ':' || c.counterpart)`;

/** A lane's line: the number, the address, or the Page or Instagram account it's on. */
const LINE_ID = (z: string) => {
  const t = sql.raw(z);
  return sql`case when ${t}.channel = 'email' then ${t}.email_address_id
    when ${t}.channel in ('messenger', 'instagram') then ${t}.meta_account_id
    else ${t}.phone_number_id end`;
};
/** A Page by its name, an Instagram account by its @handle (`metaAccountLabel`). */
const ACCOUNT_LABEL = (a: string) => {
  const t = sql.raw(a);
  return sql`case when ${t}.platform = 'instagram' and ${t}.username is not null
    then '@' || ${t}.username else ${t}.name end`;
};

/**
 * Every lane of one row's customer, newest first.
 *
 * Read straight from `app.conversations` rather than from the filtered list above, because the switcher is
 * asking "where else does this customer talk to us", which the box and status the viewer happens to be
 * looking at have no bearing on. **RLS is the only thing narrowing it**, which is deliberate: under a
 * narrowed inbox (0083) a member gets the lanes they are on and never learns that the others exist, and
 * that is "merge only what you can see" with nothing in this query to keep in step with it.
 */
const LANES = (workspaceId: string, archived: boolean) => sql`
  (select coalesce(json_agg(json_build_object(
            'id', z.id,
            'channel', z.channel::text,
            'line_id', ${LINE_ID('z')},
            'line_e164', pn.e164,
            'line_label', pn.label,
            'line_address', ea.address,
            'line_account', ${ACCOUNT_LABEL('za')},
            'record_name', zr.name,
            'unread_count', z.unread_count,
            'status', z.status::text,
            'archived', z.archived_at is not null,
            'last_message_at', z.last_message_at,
            'assignee_user_id', z.assignee_user_id,
            'assignee_name', coalesce(nullif(zu.full_name, ''), zu.email::text))
          order by z.last_message_at desc nulls last, z.id desc), '[]'::json)
     from app.conversations z
     left join app.phone_numbers pn on pn.id = z.phone_number_id
     left join app.email_addresses ea on ea.id = z.email_address_id
     left join app.users zu on zu.id = z.assignee_user_id
     left join app.custom_records zr on zr.id = z.custom_record_id
     left join app.meta_accounts za on za.id = z.meta_account_id
    where z.workspace_id = ${workspaceId}
      -- The thread being looked at is always in its own switcher, archived or not: a menu that cannot name
      -- where you are standing is a menu that reads as though you are nowhere.
      and (z.id = x.id
        or ${archived ? sql`z.archived_at is not null` : sql`z.archived_at is null`})
      -- An OR rather than a CASE, and the cast on the outer side, so each half can use its own index: a CASE
      -- read every thread in the business once per row on the page.
      and (z.person_id = x.person_id
        or (x.person_id is null and z.person_id is null and z.channel = x.channel::app.channel
          and z.counterpart = x.counterpart)))`;

/**
 * The customer an unlinked thread looks like, so the row can offer "Same as Kim Alvarez?" (0089).
 *
 * Offered, never taken: linking is a person's decision. A number on a shared family phone or a shared office
 * address matches a customer without being them, and a merge made on that guess is far harder to undo than
 * one that never happened.
 */
const SAME_AS = (workspaceId: string) => {
  // One lookup per way of matching rather than one OR over them all, so each can use its own index (the phone and
  // email ones, the GIN ones on the other numbers and addresses); the OR, and lower() on the email, read every
  // customer in the business for every unlinked row on the page. Their order is the old ORDER BY: a customer whose
  // main number or address it is first, the most recently touched among equals.
  const match = (on: ReturnType<typeof sql>) => sql`
    (select json_build_object('id', sp.id,
              'fullName', btrim(coalesce(sp.first_name, '') || ' ' || coalesce(sp.last_name, '')))
       from app.people sp
      where x.person_id is null
        and sp.workspace_id = ${workspaceId}
        and sp.archived_at is null
        and ${on}
      order by sp.updated_at desc
      limit 1)`;
  return sql`coalesce(
    ${match(sql`x.channel = 'sms' and sp.phone_e164 = x.counterpart`)},
    ${match(sql`x.channel = 'email' and sp.email = x.counterpart::extensions.citext`)},
    ${match(sql`x.channel = 'sms' and sp.other_phones @> jsonb_build_array(jsonb_build_object('phone', x.counterpart))`)},
    ${match(sql`x.channel = 'email' and sp.other_emails @> jsonb_build_array(jsonb_build_object('email', x.counterpart))`)})`;
};

/**
 * The customer's open lead and who sent the last text, over a row `x` of `conversationSelect`.
 *
 * Each is a lookup of its own, so they sit in the outer select, beside the lanes: Postgres works them out for the
 * page it hands back rather than for every thread in the box. Inside `conversationSelect` they ran for all of a
 * business's threads before the page was cut, and a 950-thread inbox took three seconds to open.
 */
const ROW_EXTRAS = sql`
    (select json_build_object('id', l.id, 'title', l.title, 'stageId', l.stage_id, 'pipelineId', s.pipeline_id,
              'stageName', s.name, 'valueCents', l.value_cents,
              'nextAction', l.next_action, 'nextActionAt', l.next_action_at)
       from app.leads l join app.pipeline_stages s on s.id = l.stage_id
       where x.person_id is not null and l.person_id = x.person_id and l.status = 'open' and l.archived_at is null
       order by l.updated_at desc limit 1) as open_lead,
    -- Only read when the last message went out: summary() shows a sender for nothing else.
    (select json_build_object('id', su.id, 'fullName', coalesce(nullif(su.full_name, ''), su.email::text))
       from app.messages lm join app.users su on su.id = lm.sent_by
       where x.last_direction = 'outbound' and lm.conversation_id = x.id and lm.direction = 'outbound'
       order by lm.occurred_at desc limit 1) as last_sender`;

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
    c.folder::text as folder, c.private_to is not null as private,
    c.custom_record_id as record_id, cr.name as record_name,
    mx.name as social_name, mx.username as social_username,
    ${SORT_KEY(sortBy === 'needs_person' ? sql`c.needs_person_since` : sql`coalesce(c.last_message_at, c.created_at)`)} as sort_key,
    ${GROUP_KEY} as group_key
  from app.conversations c
  left join app.people p on p.id = c.person_id
  left join app.users u on u.id = c.assignee_user_id
  left join app.chat_visitors cv on cv.conversation_id = c.id
  left join app.ai_teammates tm on tm.id = c.ai_teammate_id
  left join app.users tu on tu.id = c.taken_over_by
  left join app.custom_records cr on cr.id = c.custom_record_id
  left join app.meta_contacts mx on mx.conversation_id = c.id
  where c.workspace_id = ${workspaceId}`;

function summary(r: ConversationRow): ConversationSummary {
  const lanes = (r.lanes ?? []).map(lane);
  return {
    id: r.id,
    channel: r.channel,
    counterpart: r.counterpart,
    counterpartDisplay:
      r.channel === 'sms'
        ? formatPhone(r.counterpart)
        : r.channel === 'chat'
          ? (r.visitor_name ?? CHAT_VISITOR_NAME)
          : r.channel === 'portal'
            ? // Never the portal's key: the client, as the business has them.
              fullName(r.first_name ?? '', r.last_name ?? '') || 'Client portal'
            : isSocialChannel(r.channel)
              ? // Never the page-scoped id: who they are on Facebook or Instagram, as Meta named them.
                socialContactName(r.channel, { name: r.social_name, username: r.social_username })
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
    lanes,
    unreadTotal: lanes.length
      ? lanes.reduce((n, l) => n + l.unreadCount, 0)
      : Number(r.unread_count),
    sameAs: r.same_as?.id ? { id: r.same_as.id, fullName: r.same_as.fullName || 'Unnamed' } : null,
    folder: r.folder,
    private: !!r.private,
    record: r.record_id ? { id: r.record_id, name: r.record_name ?? 'A record' } : null,
  };
}

/**
 * How a lane reads in the switcher: the business's own end of the thread, never the customer's.
 *
 * A named number says its name, because "Front desk" is what somebody picking a line is actually choosing
 * between — the digits are there for the second front-desk number nobody has named yet. A lane with no line
 * is a website chat, or a business whose only number was released; it still has to say something, because a
 * blank item in a menu is not choosable.
 */
function lane(l: LaneRow): ConversationLane {
  return {
    id: l.id,
    channel: l.channel,
    lineId: l.line_id,
    // The phone's copy says it the same way (`lineDisplayOf`), so a line reads the same on both.
    lineDisplay: lineDisplayOf({
      channel: l.channel,
      e164: l.line_e164,
      label: l.line_label,
      address: l.line_address,
      record: l.record_name,
      account: l.line_account,
    }),
    unreadCount: Number(l.unread_count),
    status: l.status,
    archived: !!l.archived,
    lastMessageAt: iso(l.last_message_at),
    assignee: l.assignee_user_id
      ? { id: l.assignee_user_id, fullName: l.assignee_name ?? 'Former member' }
      : null,
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
    'Conversations newest first: mine, unassigned or everyone’s, those waiting for a person (oldest first) or the AI teammate’s, or email in Other mail or Spam; open, snoozed or closed; texts or email; with search.',
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
    // The filters over a thread `t`: the list's own (`c`), and, with the same meaning, the newer lane of the same
    // customer the grouped list looks for (`c2`).
    const filters = (t: 'c' | 'c2') => {
      const c = sql.raw(t);
      const box =
        input.box === 'mine'
          ? sql`and ${c}.assignee_user_id = ${me}`
          : input.box === 'unassigned'
            ? sql`and ${c}.assignee_user_id is null`
            : input.box === 'needs_person'
              ? sql`and ${c}.needs_person_since is not null`
              : input.box === 'ai'
                ? sql`and ${c}.handled_by = 'ai'`
                : sql``;
      // The email folders (M19): Other mail and Spam are boxes of their own, and every other box is the Inbox's.
      // A customer's record lists all of their threads, wherever they are, and so does Archived: a thread put away
      // from Other mail or Spam has nowhere else to be found.
      const folder =
        input.personId || input.box === 'archived'
          ? sql``
          : input.box === 'other' || input.box === 'spam'
            ? sql`and ${c}.folder = ${input.box}::app.conversation_folder`
            : sql`and ${c}.folder = 'inbox'`;
      // The team's threads, or the person's own mailbox (M19). The policies already keep anyone else's out.
      const mailbox =
        input.mailbox === 'mine'
          ? sql`and ${c}.private_to = ${me}`
          : sql`and ${c}.private_to is null`;
      // Archived threads are out of the inbox: only their own box shows them, and only it hides the live ones.
      const archived =
        input.box === 'archived'
          ? sql`and ${c}.archived_at is not null`
          : sql`and ${c}.archived_at is null`;
      // A chat visitor's name is joined for `c`; for `c2` it is looked up. The customer's name needs neither:
      // a lane of the same customer has the same person, so `p` is theirs too.
      const visitorName =
        t === 'c'
          ? sql`cv.name`
          : sql`(select cv2.name from app.chat_visitors cv2 where cv2.conversation_id = c2.id)`;
      // A Messenger or Instagram customer's name and @handle, as Meta gave them (20261025000200).
      const socialName =
        t === 'c'
          ? sql`coalesce(mx.name, '') || ' ' || coalesce(mx.username, '')`
          : sql`(select coalesce(m2.name, '') || ' ' || coalesce(m2.username, '')
                 from app.meta_contacts m2 where m2.conversation_id = c2.id)`;
      return sql`
            ${
              input.personId
                ? sql`and ${c}.person_id = ${input.personId}`
                : // Archived threads keep whatever status they had, so their own box lists them all rather than
                  // hiding every closed one behind a status nobody chose.
                  input.box === 'archived'
                  ? sql`and ${c}.last_message_at is not null`
                  : sql`and ${c}.status = ${input.status}::app.conversation_status and ${c}.last_message_at is not null`
            }
            ${box}
            ${folder}
            ${mailbox}
            ${archived}
            ${input.channel ? sql`and ${c}.channel = ${input.channel}::app.channel` : sql``}
            ${input.unread ? sql`and ${c}.unread_count > 0` : sql``}
            ${
              q
                ? sql`and (lower(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) like ${q}
                      or lower(${c}.counterpart) like ${q} or lower(coalesce(${c}.last_preview, '')) like ${q}
                      or lower(coalesce(${visitorName}, '')) like ${q}
                      or lower(coalesce(${socialName}, '')) like ${q}
                      ${digits.length >= 3 ? sql`or ${c}.counterpart like ${`%${digits}%`}` : sql``})`
                : sql``
            }`;
    };
    /**
     * One row per customer, not per thread (0089).
     *
     * The filters run first, on threads, so a box still means what it says: "Mine" is the customer with a
     * thread assigned to me, and the row that comes back stands for that thread rather than for some other
     * lane of theirs the filter never matched. A thread is kept when no other lane of theirs that the filters
     * keep is newer, and the rest fold into its `lanes`.
     *
     * That is a lookup per thread rather than a window over the box, so the page can be read off the inbox's
     * (workspace, status, recency) index and stop once it is full: a window numbered every matching thread in
     * the business, on every page and every live refresh, before the cursor and the limit cut it. Every grouped
     * thread has a last message (and every one in "Needs a person" a moment it started waiting), so the raw
     * column sorts as `sort_key` does.
     *
     * **The customer record page is the one screen that does not group.** It asks for one person's threads on
     * purpose — grouping them would answer with a single row, which is the opposite of what it is for.
     */
    const grouped = !input.personId;
    const col = sql.raw(oldestFirst ? 'needs_person_since' : 'last_message_at');
    const one = sql`${conversationSelect(input.workspaceId, oldestFirst ? 'needs_person' : 'recent')}
            ${filters('c')}
            ${
              grouped
                ? sql`and not exists (select 1 from app.conversations c2
                    where c2.workspace_id = c.workspace_id
                      -- An OR, as in the lanes, so each half can use its own index.
                      and (c2.person_id = c.person_id
                        or (c.person_id is null and c2.person_id is null and c2.channel = c.channel
                          and c2.counterpart = c.counterpart))
                      ${filters('c2')}
                      and (c2.${col}, c2.id) > (c.${col}, c.id))`
                : sql``
            }`;
    const after = !cursor
      ? sql``
      : grouped
        ? oldestFirst
          ? sql`and (x.${col}, x.id) > (${cursor.sort}::timestamptz, ${cursor.id}::uuid)`
          : sql`and (x.${col}, x.id) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)`
        : oldestFirst
          ? sql`and (x.sort_key, x.id) > (${cursor.sort}, ${cursor.id}::uuid)`
          : sql`and (x.sort_key, x.id) < (${cursor.sort}, ${cursor.id}::uuid)`;
    const order = grouped
      ? oldestFirst
        ? sql`x.${col} asc, x.id asc`
        : sql`x.${col} desc nulls last, x.id desc`
      : oldestFirst
        ? sql`x.sort_key asc, x.id asc`
        : sql`x.sort_key desc, x.id desc`;
    const list = await rows<ConversationRow>(
      ctx.tx,
      sql`select x.*, ${ROW_EXTRAS},
            ${LANES(input.workspaceId, input.box === 'archived')} as lanes,
            ${SAME_AS(input.workspaceId)} as same_as
          from (${one}) x
          where true
          ${after}
          order by ${order}
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
      // Customers, not threads (0089): the list beside these badges shows each customer once, and a badge
      // that counts their lanes says "3" over a list with one row in it.
      sql`select
            count(distinct ${GROUP_KEY}) filter (where c.status = 'open')::int as open_all,
            count(distinct ${GROUP_KEY}) filter (where c.status = 'open' and c.assignee_user_id = ${me})::int as open_mine,
            count(distinct ${GROUP_KEY}) filter (where c.status = 'open' and c.assignee_user_id is null)::int as open_unassigned,
            count(distinct ${GROUP_KEY}) filter (where c.status = 'open' and c.unread_count > 0)::int as unread_all,
            count(distinct ${GROUP_KEY}) filter (where c.status = 'open' and c.unread_count > 0 and c.assignee_user_id = ${me})::int as unread_mine,
            count(distinct ${GROUP_KEY}) filter (where c.status = 'open' and c.unread_count > 0 and c.assignee_user_id is null)::int as unread_unassigned,
            count(distinct ${GROUP_KEY}) filter (where c.status = 'open' and c.awaiting_reply_since is not null
              and c.awaiting_reply_since <= now() - make_interval(mins => ${threshold}))::int as waiting,
            count(distinct ${GROUP_KEY}) filter (where c.status = 'open' and c.needs_person_since is not null)::int as needs_person,
            count(distinct ${GROUP_KEY}) filter (where c.status = 'open' and c.handled_by = 'ai')::int as ai
          from app.conversations c
          where c.workspace_id = ${input.workspaceId} and c.last_message_at is not null
            and c.archived_at is null and c.folder = 'inbox' and c.private_to is null`,
    );
    const n = (k: string) => Number(s?.[k] ?? 0);
    // Beside the team's Inbox (M19): the viewer's own mailbox, and the team's Other mail and Spam.
    const [mail] = await rows<{ mine: number; other: number; spam: number; own: boolean }>(
      ctx.tx,
      sql`select
            count(*) filter (where c.private_to = ${me} and c.folder = 'inbox' and c.unread_count > 0)::int as mine,
            count(*) filter (where c.private_to is null and c.folder = 'other' and c.unread_count > 0)::int as other,
            count(*) filter (where c.private_to is null and c.folder = 'spam')::int as spam,
            (exists (select 1 from app.email_addresses a
                      where a.workspace_id = ${input.workspaceId} and a.owner_user_id = ${me})
              or exists (select 1 from app.conversations o
                      where o.workspace_id = ${input.workspaceId} and o.private_to = ${me})) as own
          from app.conversations c
          where c.workspace_id = ${input.workspaceId} and c.channel = 'email' and c.status = 'open'
            and c.archived_at is null and c.last_message_at is not null
            and (c.folder <> 'inbox' or c.private_to is not null)`,
    );
    return {
      mail: {
        mine: mail?.mine ?? 0,
        other: mail?.other ?? 0,
        spam: mail?.spam ?? 0,
        own: mail?.own ?? false,
      },
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
      // The lanes ride along because the thread view is where somebody switches between them (0089). Live
      // ones only: a closed or archived lane is not somewhere to start typing, and the switcher is a place to
      // start typing.
      sql`select x.*, ${ROW_EXTRAS}, ${LANES(input.workspaceId, false)} as lanes,
            ${SAME_AS(input.workspaceId)} as same_as
          from (${conversationSelect(input.workspaceId)} and c.id = ${input.conversationId}) x`,
    );
    if (!row)
      throw HfosError.notFound(
        'That conversation isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
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
          : row.channel === 'portal'
            ? { ok: false, reason: 'portal_channel' as const }
            : isSocialChannel(row.channel)
              ? { ok: false, reason: 'social_channel' as const }
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
      social: isSocialChannel(row.channel) ? await socialOf(ctx, row, row.channel) : null,
      fromNumber: number ? formatPhone(number.e164) : null,
      rcs: row.channel === 'sms' && rcsSending(await currentRcsSender(ctx.tx, input.workspaceId)),
      quiet: quietHoursState(m.settings.quietHours, m.timezone),
      timezone: m.timezone,
    };
  },
});

/**
 * A Messenger or Instagram thread's own facts (20261025000200): the Page or account it's on and whether it still
 * answers here, who the customer is there, and Meta's reply window, which runs from their last message.
 */
async function socialOf(
  ctx: QueryContext,
  row: ConversationRow,
  channel: 'messenger' | 'instagram',
): Promise<ConversationGetOutputShape['social']> {
  const [c] = await rows<{ last_inbound_at: Date | null; meta_account_id: string | null }>(
    ctx.tx,
    sql`select last_inbound_at, meta_account_id from app.conversations where id = ${row.id}`,
  );
  const [a] = c?.meta_account_id
    ? await ctx.tx
        .select(META_ACCOUNT_COLUMNS)
        .from(metaAccounts)
        .where(eq(metaAccounts.id, c.meta_account_id))
    : [];
  const window = socialReplyWindow(c?.last_inbound_at ?? null, a?.humanAgent ?? false);
  return {
    account: a
      ? {
          id: a.id,
          platform: a.platform,
          name: a.name,
          username: a.username,
          label: metaAccountLabel(a),
          status: a.status,
          problem: a.problem,
        }
      : null,
    contact: {
      name: socialContactName(channel, { name: row.social_name, username: row.social_username }),
      username: row.social_username,
    },
    everWrote: !!c?.last_inbound_at,
    window,
    textLimit: SOCIAL_TEXT_LIMITS[channel],
  };
}

type ConversationGetOutputShape = z.infer<typeof ConversationGetOutput>;

type ThreadRow = {
  type: 'message' | 'call';
  id: string;
  /** The lane it is on. Selected by every branch already; named here so "All" can label it (0089). */
  conversation_id?: string | null;
  occurred_at: Date;
  direction: 'inbound' | 'outbound';
  status: string;
  channel: ConversationChannel | null;
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
  answered_via: 'browser' | 'forwarding' | 'bridge' | 'ai' | null;
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
  /** Texts (0103): how it went, when it was read, what it carried and which button a reply came from. */
  transport: 'sms' | 'mms' | 'rcs' | null;
  read_at: Date | null;
  rich: RichTextOut | null;
  button_reply: ButtonReplyOut | null;
  /** Messenger and Instagram (20261025000200): what it shared and answers, and whether it was edited or taken back. */
  social: ThreadItem['social'];
  edited_at: Date | null;
  unsent_at: Date | null;
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
    m.transport::text as transport, m.read_at, m.rich, m.button_reply,
    case when m.channel in ('messenger', 'instagram') then m.social end as social, m.edited_at, m.unsent_at,
    ${SORT_KEY(sql`m.occurred_at`)} as sort_key
  from app.messages m left join app.users su on su.id = m.sent_by
  left join app.mailbox_connections mc on mc.id = m.mailbox_connection_id
  left join app.ai_teammates tt on tt.id = m.sent_by_teammate_id
  left join app.users ab on ab.id = m.approved_by
  where m.workspace_id = ${workspaceId}`;

function threadItem(r: ThreadRow, lines?: ReadonlyMap<string, string>): ThreadItem {
  return {
    type: r.type,
    id: r.id,
    conversationId: r.conversation_id ?? null,
    // Only "All" passes the map: one lane's own thread says its line once, above the box, rather than on
    // every message in it.
    lineDisplay: (r.conversation_id && lines?.get(r.conversation_id)) || null,
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
    transport: r.transport ?? null,
    readAt: iso(r.read_at),
    rich: r.rich ?? null,
    buttonReply: r.button_reply ?? null,
    social: r.social ?? null,
    editedAt: iso(r.edited_at),
    unsentAt: iso(r.unsent_at),
  };
}

/**
 * Every lane of the customer behind one conversation, newest first (0089).
 *
 * Grouped the way the inbox groups them — their record when they have one, their address when nobody has
 * linked them — and narrowed by nothing but RLS, so a member on a narrowed inbox weaves together the lanes
 * they are on and never learns of the others.
 */
async function lanesOf(
  ctx: QueryContext,
  workspaceId: string,
  conversationId: string,
): Promise<ConversationLane[]> {
  const [c] = await rows<{ person_id: string | null; channel: string; counterpart: string }>(
    ctx.tx,
    sql`select person_id, channel::text as channel, counterpart from app.conversations
        where id = ${conversationId} and workspace_id = ${workspaceId}`,
  );
  if (!c) return [];
  const found = await rows<LaneRow>(
    ctx.tx,
    sql`select z.id, z.channel::text as channel,
          ${LINE_ID('z')} as line_id,
          pn.e164 as line_e164, pn.label as line_label, ea.address as line_address,
          ${ACCOUNT_LABEL('za')} as line_account,
          z.unread_count, z.status::text as status, z.archived_at is not null as archived,
          z.last_message_at, z.assignee_user_id,
          coalesce(nullif(zu.full_name, ''), zu.email::text) as assignee_name
        from app.conversations z
        left join app.phone_numbers pn on pn.id = z.phone_number_id
        left join app.email_addresses ea on ea.id = z.email_address_id
        left join app.users zu on zu.id = z.assignee_user_id
        left join app.meta_accounts za on za.id = z.meta_account_id
        where z.workspace_id = ${workspaceId}
          and ${
            c.person_id
              ? sql`z.person_id = ${c.person_id}`
              : sql`z.person_id is null and z.channel::text = ${c.channel} and z.counterpart = ${c.counterpart}`
          }
        order by z.last_message_at desc nulls last, z.id desc`,
  );
  return found.map(lane);
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
    if (!exists)
      throw HfosError.notFound(
        'That conversation isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    const cursor = decodeTimeCursor(input.cursor);
    // "All": every lane of this customer woven together, each item saying which line it was on (0089).
    const lanes = input.allLanes
      ? await lanesOf(ctx, input.workspaceId, input.conversationId)
      : null;
    const lines = lanes ? new Map(lanes.map((l) => [l.id, l.lineDisplay])) : undefined;
    // `uuidArray`, not a bare array: Drizzle's sql tag spreads a JS array into a parameter list.
    const ids = uuidArray(lanes?.length ? lanes.map((l) => l.id) : [input.conversationId]);
    // Each branch pages on its own column (the thread indexes serve it) and stops at a page, then the two merge.
    const branchPage = (at: ReturnType<typeof sql>, id: ReturnType<typeof sql>) =>
      sql`${input.since ? sql`and ${at} > ${input.since}::timestamptz` : sql``}
        ${cursor ? sql`and (${at}, ${id}) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)` : sql``}
        order by ${at} desc, ${id} desc
        limit ${input.limit + 1}`;
    const list = await rows<ThreadRow>(
      ctx.tx,
      sql`select * from (
            (${messageBranch(input.workspaceId)} and m.conversation_id = any(${ids})
              and m.error_code is distinct from ${CANCELLED_TEXT}
              ${branchPage(sql`m.occurred_at`, sql`m.id`)})
            union all
            (select 'call'::text, c.id, c.conversation_id, c.started_at, c.direction::text, c.status::text, null::text, null::text, null::text,
              c.from_e164, '[]'::jsonb, c.placed_by, coalesce(nullif(pu.full_name, ''), pu.email::text), null::text, null::text, null::timestamptz,
              c.duration_seconds, c.is_voicemail, c.recording_object_path is not null, c.transcript,
              c.transcript_status::text, c.answered_by_user_id,
              coalesce(nullif(au.full_name, ''), au.email::text), c.recording_object_path, c.recording_seconds, c.answered_via::text,
              null::text, '{}'::text[], '{}'::text[], null::text,
              null::uuid, null::text, null::uuid, null::text, null::uuid, false, null::timestamptz,
              null::text, null::timestamptz, null::jsonb, null::jsonb,
              null::jsonb, null::timestamptz, null::timestamptz,
              ${SORT_KEY(sql`c.started_at`)}
            from app.calls c
            left join app.users pu on pu.id = c.placed_by
            left join app.users au on au.id = c.answered_by_user_id
            where c.workspace_id = ${input.workspaceId} and c.conversation_id = any(${ids})
              -- A call through someone's own cell joins the conversation once the customer's phone was dialed.
              and (c.answered_via is distinct from 'bridge' or c.answered_by_user_id is not null)
              ${branchPage(sql`c.started_at`, sql`c.id`)})
          ) t
          order by t.occurred_at desc, t.id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return {
      items: result.items.map((r) => threadItem(r, lines)),
      nextCursor: result.nextCursor,
    };
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
    const [row] = await rows<ThreadRow & { conversation_id: string; tried_again: boolean }>(
      ctx.tx,
      sql`select t.*, x.failed_attempt is not null as tried_again
          from (${messageBranch(input.workspaceId)} and m.id = ${input.messageId}) t
          join app.messages x on x.id = t.id`,
    );
    if (!row)
      throw HfosError.notFound(
        'That message isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    return {
      message: threadItem(row),
      conversationId: row.conversation_id,
      triedAgain: row.tried_again && row.scheduled_for !== null,
    };
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
    const cursor = decodeTimeCursor(input.cursor);
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
      answered_via: 'browser' | 'forwarding' | 'bridge' | 'ai' | null;
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
          ${cursor ? sql`and (c.started_at, c.id) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)` : sql``}
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
