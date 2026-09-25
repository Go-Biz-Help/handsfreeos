/**
 * The inbox from a phone's own copy (M10): its synced conversations, messages, calls and drafts turned into the shapes
 * the inbox's words take (the API's ConversationSummary and ThreadItem), the list's boxes and counts worked out as
 * `inbox.list` and `inbox.summary` do, and what phones hide, as `conversation.thread` does. Rows are as the copy holds
 * them: snake_case, times as ISO text, booleans as 1 or 0, JSON as text. Browser-safe.
 */
import { CHAT_VISITOR_NAME } from '../chat/limits';
import { formatPhone } from '../crm/phone';
import { CANCELLED_TEXT, scheduledForOf } from '../messaging/quiet-hours';
import type { ButtonReply, RichText } from '@hfos/db/schema';
import type { ConversationHandoffReason } from '../schemas/ai-team';
import {
  DEFAULT_TELEPHONY_SETTINGS,
  TelephonySettings,
  type TelephonySettings as TelephonySettingsType,
} from '../schemas/telephony';
import type { InboxBoxKey, ConversationStatus, RowFacts } from './list';
import {
  MONEY_ACTION_KINDS,
  type DraftActionFacts,
  type DraftFacts,
  type MoneyDraftActionKind,
} from './teammate';
import type { ThreadItemFacts } from './thread';

type Text = string | null;
type UserRef = { readonly id: string; readonly fullName: string };

const iso = (v: Text | undefined): string | null => (v ? new Date(v).toISOString() : null);
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';
const nameOf = (first: Text | undefined, last: Text | undefined) =>
  `${first ?? ''} ${last ?? ''}`.trim();
const userRef = (id: Text | undefined, name: Text | undefined): UserRef | null =>
  id ? { id, fullName: name || 'Former member' } : null;

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// --------------------------------------------------------------------------------------------- conversations

/** A synced conversation with what the phone's list query joins in: names, the open lead, the last sender. */
export interface ConversationListRow {
  readonly id: string;
  readonly channel: string;
  readonly counterpart: string;
  readonly status: string;
  readonly person_id: Text;
  readonly first_name?: Text;
  readonly last_name?: Text;
  readonly assignee_user_id: Text;
  readonly assignee_name?: Text;
  readonly unread_count: number | null;
  readonly last_message_at: Text;
  readonly last_preview: Text;
  readonly last_direction: Text;
  readonly last_sender_id?: Text;
  readonly last_sender_name?: Text;
  readonly awaiting_reply_since: Text;
  readonly snoozed_until: Text;
  readonly created_at: Text;
  readonly handled_by: Text;
  readonly ai_teammate_id: Text;
  readonly teammate_name?: Text;
  readonly needs_person_since: Text;
  readonly handoff_reason: Text;
  readonly handoff_note: Text;
  readonly taken_over_by: Text;
  readonly taken_over_name?: Text;
  readonly lead_id?: Text;
  readonly lead_title?: Text;
  readonly lead_stage_id?: Text;
  readonly lead_pipeline_id?: Text;
  readonly lead_stage_name?: Text;
  readonly lead_value_cents?: number | string | null;
  readonly lead_next_action?: Text;
  readonly lead_next_action_at?: Text;
  /** The business's end of the thread (0089): the number it is on, or the address mail goes out from. */
  readonly line_e164?: Text;
  readonly line_label?: Text;
  readonly line_address?: Text;
}

/** One of a customer's conversations, as the list's row and the thread's line switcher take it (0089). */
export interface InboxLane {
  readonly id: string;
  readonly channel: 'sms' | 'email' | 'chat';
  /** "Front desk · (713) 555-0100", "info@lonestarhvac.com", "Website chat". */
  readonly lineDisplay: string;
  readonly unreadCount: number;
}

/**
 * How a lane reads: the business's own end of the thread, never the customer's. A named number says its name
 * as well as its digits; a lane with no line still says something, because a blank item is not choosable.
 */
export function lineDisplayOf(l: {
  readonly channel: 'sms' | 'email' | 'chat';
  readonly e164: Text | undefined;
  readonly label: Text | undefined;
  readonly address: Text | undefined;
}): string {
  if (l.channel === 'chat') return 'Website chat';
  if (l.channel === 'email') return l.address || 'Email';
  const number = l.e164 ? formatPhone(l.e164) : null;
  if (!number) return 'Text';
  return l.label ? `${l.label} · ${number}` : number;
}

/** A conversation as the inbox's words take it (the API's ConversationSummary, as far as a phone's copy knows it). */
export interface ConversationShape extends RowFacts {
  readonly id: string;
  readonly counterpart: string;
  readonly assignee: UserRef | null;
  readonly createdAt: string;
  readonly teammate: { readonly id: string; readonly name: string } | null;
  readonly handoffReason: ConversationHandoffReason | null;
  readonly handoffNote: string | null;
  readonly takenOverBy: UserRef | null;
  readonly openLead: {
    readonly id: string;
    readonly title: string;
    /** Its stage and pipeline, so the conversation can move the lead along without opening the board. */
    readonly stageId: string;
    readonly pipelineId: string;
    readonly stageName: string;
    readonly valueCents: number;
    readonly nextAction: string | null;
    readonly nextActionAt: string | null;
  } | null;
  /** Which of the business's lines this thread is on. */
  readonly lineDisplay: string;
  /** Every live lane of this customer, newest first: set once the list groups them (`groupByCustomer`). */
  readonly lanes?: readonly InboxLane[];
  /** Unread across all of those lanes, which is what the row's badge says. */
  readonly unreadTotal?: number;
}

const CHANNELS = new Set(['sms', 'email', 'chat']);
const STATUSES = new Set(['open', 'snoozed', 'closed']);

export function conversationOf(r: ConversationListRow): ConversationShape {
  const channel = (CHANNELS.has(r.channel) ? r.channel : 'sms') as 'sms' | 'email' | 'chat';
  const lastDirection =
    r.last_direction === 'inbound' || r.last_direction === 'outbound' ? r.last_direction : null;
  return {
    id: r.id,
    channel,
    counterpart: r.counterpart,
    // A website chat's visitor's name isn't on the phone: the chat shows as a visitor until they're a customer.
    counterpartDisplay:
      channel === 'sms'
        ? formatPhone(r.counterpart)
        : channel === 'chat'
          ? CHAT_VISITOR_NAME
          : r.counterpart,
    status: (STATUSES.has(r.status) ? r.status : 'open') as ConversationStatus,
    person: r.person_id ? { id: r.person_id, fullName: nameOf(r.first_name, r.last_name) } : null,
    assignee: userRef(r.assignee_user_id, r.assignee_name),
    unreadCount: Number(r.unread_count ?? 0),
    lastMessageAt: iso(r.last_message_at),
    lastPreview: r.last_preview,
    lastDirection,
    lastSentBy: lastDirection === 'outbound' ? userRef(r.last_sender_id, r.last_sender_name) : null,
    awaitingReplySince: iso(r.awaiting_reply_since),
    snoozedUntil: iso(r.snoozed_until),
    openLead:
      r.lead_id && r.lead_title
        ? {
            id: r.lead_id,
            title: r.lead_title,
            stageId: r.lead_stage_id ?? '',
            pipelineId: r.lead_pipeline_id ?? '',
            stageName: r.lead_stage_name ?? '',
            valueCents: Number(r.lead_value_cents ?? 0),
            nextAction: r.lead_next_action ?? null,
            nextActionAt: iso(r.lead_next_action_at),
          }
        : null,
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    handledBy: r.handled_by === 'ai' || r.handled_by === 'person' ? r.handled_by : 'none',
    teammate:
      r.ai_teammate_id && r.teammate_name ? { id: r.ai_teammate_id, name: r.teammate_name } : null,
    needsPersonSince: iso(r.needs_person_since),
    handoffReason: (r.handoff_reason as ConversationHandoffReason | null) ?? null,
    handoffNote: r.handoff_note,
    takenOverBy: userRef(r.taken_over_by, r.taken_over_name),
    // Whether a chat visitor still has the page open isn't on the phone.
    onSiteNow: false,
    lineDisplay: lineDisplayOf({
      channel,
      e164: r.line_e164,
      label: r.line_label,
      address: r.line_address,
    }),
  };
}

/**
 * Which customer a thread belongs to, as `inbox.list` and `inbox.summary` group them (0089): their id when the
 * thread is linked to someone, so their texts and email are one row; otherwise the address itself, so an unknown
 * number and an unknown mail address stay apart, since nothing knows they are the same person.
 */
export const customerKeyOf = (c: Pick<ConversationShape, 'person' | 'channel' | 'counterpart'>) =>
  c.person?.id ?? `${c.channel}:${c.counterpart}`;

/** A lane, as a row's switcher lists it. */
const laneOf = (c: ConversationShape): InboxLane => ({
  id: c.id,
  channel: c.channel,
  lineDisplay: c.lineDisplay,
  unreadCount: c.unreadCount,
});

/** Newest first by the latest message, ties by id: how a customer's lanes are listed. */
const byNewest = (a: ConversationShape, b: ConversationShape): number => {
  const x = a.lastMessageAt ?? '';
  const y = b.lastMessageAt ?? '';
  return x === y ? b.id.localeCompare(a.id) : x > y ? -1 : 1;
};

/** A customer's lanes, newest first. */
export const lanesOf = (conversations: readonly ConversationShape[]): InboxLane[] =>
  [...conversations].sort(byNewest).map(laneOf);

/** Every live lane of each customer, newest first, keyed by `customerKeyOf`. */
function lanesByCustomer(
  conversations: readonly ConversationShape[],
): ReadonlyMap<string, readonly InboxLane[]> {
  const groups = new Map<string, ConversationShape[]>();
  for (const c of conversations) {
    const key = customerKeyOf(c);
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  return new Map([...groups].map(([key, list]) => [key, lanesOf(list)]));
}

/**
 * One row per customer, not per thread, as `inbox.list` gives them (0089).
 *
 * The filter runs first, on threads, so a box still means what it says: "Mine" is the customer with a thread
 * assigned to me, and the row stands for that thread rather than some other lane the filter never matched.
 * Then each customer keeps their newest matching lane, which carries every one of their lanes (whatever the
 * filter) and the unread across all of them. `items` is everything the list could show, before the filter.
 */
export function groupByCustomer<T extends { readonly conversation: ConversationShape }>(
  items: readonly T[],
  filter: InboxFilter,
  myUserId: string,
): T[] {
  const lanes = lanesByCustomer(items.map((i) => i.conversation));
  const order = inboxOrder(filter.box);
  // Which lane stands for the customer: the newest by the box's own key, as `row_number()` picks it.
  const newer = (a: ConversationShape, b: ConversationShape) =>
    filter.box === 'needs_person' ? order(b, a) : order(a, b);
  const kept = new Map<string, T>();
  for (const item of items) {
    if (!inInbox(item.conversation, filter, myUserId)) continue;
    const key = customerKeyOf(item.conversation);
    const held = kept.get(key);
    if (!held || newer(item.conversation, held.conversation) < 0) kept.set(key, item);
  }
  return [...kept].map(([key, item]) => {
    const all = lanes.get(key) ?? [laneOf(item.conversation)];
    return {
      ...item,
      conversation: {
        ...item.conversation,
        lanes: all,
        unreadTotal: all.reduce((n, l) => n + l.unreadCount, 0),
      },
    };
  });
}

export interface InboxFilter {
  readonly box: InboxBoxKey;
  readonly status: ConversationStatus;
  readonly channel?: 'sms' | 'email' | 'chat';
  /** Search: a name, the number or address, words from the latest message. */
  readonly q?: string;
}

/**
 * Whether a conversation is in the list, as `inbox.list` decides: its box and status, one that has had a message, and
 * the search (a name, the number or address, the latest message; three digits or more match inside the number).
 */
export function inInbox(c: ConversationShape, filter: InboxFilter, myUserId: string): boolean {
  if (!c.lastMessageAt || c.status !== filter.status) return false;
  if (filter.channel && c.channel !== filter.channel) return false;
  switch (filter.box) {
    case 'mine':
      if (c.assignee?.id !== myUserId) return false;
      break;
    case 'unassigned':
      if (c.assignee) return false;
      break;
    case 'needs_person':
      if (!c.needsPersonSince) return false;
      break;
    case 'ai':
      if (c.handledBy !== 'ai') return false;
      break;
    default:
      break;
  }
  const q = filter.q?.trim().toLowerCase() ?? '';
  if (!q) return true;
  const digits = q.replace(/[^0-9]/g, '');
  const name = c.person ? c.person.fullName.toLowerCase() : '';
  return (
    name.includes(q) ||
    c.counterpart.toLowerCase().includes(q) ||
    (c.lastPreview ?? '').toLowerCase().includes(q) ||
    (digits.length >= 3 && c.counterpart.includes(digits))
  );
}

/**
 * The list's order: newest first by the latest message (or when it was made), ties by id, as `inbox.list` sorts; the
 * "Needs a person" box by who has waited longest.
 */
export function inboxOrder(box: InboxBoxKey) {
  return (a: ConversationShape, b: ConversationShape): number => {
    if (box === 'needs_person') {
      const x = a.needsPersonSince ?? '';
      const y = b.needsPersonSince ?? '';
      return x === y ? a.id.localeCompare(b.id) : x < y ? -1 : 1;
    }
    const x = a.lastMessageAt ?? a.createdAt;
    const y = b.lastMessageAt ?? b.createdAt;
    return x === y ? b.id.localeCompare(a.id) : x > y ? -1 : 1;
  };
}

/**
 * The badges' counts, as `inbox.summary` counts them: open conversations that have had a message, each customer once
 * (0089). The list beside the badges shows a customer's texts and email as one row, and a badge that counted their
 * lanes would say "3" over a list with one row in it.
 */
export interface InboxCounts {
  readonly open: { readonly mine: number; readonly unassigned: number; readonly all: number };
  readonly unread: { readonly mine: number; readonly unassigned: number; readonly all: number };
  /** Open conversations whose customer has waited past the reminder threshold. */
  readonly waiting: number;
  readonly waitingThresholdMinutes: number;
  readonly needsPerson: number;
  readonly ai: number;
}

export function inboxCounts(
  conversations: readonly ConversationShape[],
  myUserId: string,
  waitingThresholdMinutes: number,
  now = Date.now(),
): InboxCounts {
  const open = { mine: new Set<string>(), unassigned: new Set<string>(), all: new Set<string>() };
  const unread = { mine: new Set<string>(), unassigned: new Set<string>(), all: new Set<string>() };
  const waiting = new Set<string>();
  const needsPerson = new Set<string>();
  const ai = new Set<string>();
  const threshold = waitingThresholdMinutes || 10;
  for (const c of conversations) {
    if (c.status !== 'open' || !c.lastMessageAt) continue;
    const who = customerKeyOf(c);
    const mine = c.assignee?.id === myUserId;
    const unassigned = !c.assignee;
    open.all.add(who);
    if (mine) open.mine.add(who);
    if (unassigned) open.unassigned.add(who);
    if (c.unreadCount > 0) {
      unread.all.add(who);
      if (mine) unread.mine.add(who);
      if (unassigned) unread.unassigned.add(who);
    }
    if (c.awaitingReplySince && Date.parse(c.awaitingReplySince) <= now - threshold * 60_000)
      waiting.add(who);
    if (c.needsPersonSince) needsPerson.add(who);
    if (c.handledBy === 'ai') ai.add(who);
  }
  const sizes = (b: typeof open) => ({
    mine: b.mine.size,
    unassigned: b.unassigned.size,
    all: b.all.size,
  });
  return {
    open: sizes(open),
    unread: sizes(unread),
    waiting: waiting.size,
    waitingThresholdMinutes: threshold,
    needsPerson: needsPerson.size,
    ai: ai.size,
  };
}

/** The business's texting settings from its synced `settings`, as the server reads them. */
export function telephonySettingsOf(settings: unknown): TelephonySettingsType {
  const raw = json<Record<string, unknown> | null>(settings, null) ?? {};
  const parsed = TelephonySettings.partial().safeParse(raw['telephony'] ?? {});
  const stored = parsed.success ? parsed.data : {};
  return {
    quietHours: stored.quietHours ?? DEFAULT_TELEPHONY_SETTINGS.quietHours,
    unansweredReminderMinutes:
      stored.unansweredReminderMinutes ?? DEFAULT_TELEPHONY_SETTINGS.unansweredReminderMinutes,
  };
}

// ------------------------------------------------------------------------------------------------ the thread

/** A synced message, with its sender's, teammate's and approver's names joined in. */
export interface MessageThreadRow {
  readonly id: string;
  readonly conversation_id: Text;
  readonly channel: Text;
  readonly direction: string;
  readonly status: string;
  readonly from_address: Text;
  readonly to_addresses: Text;
  readonly cc_addresses: Text;
  readonly subject: Text;
  readonly body_text: Text;
  readonly media: Text;
  readonly error_code: Text;
  readonly error_message: Text;
  readonly sent_by: Text;
  readonly sent_by_name?: Text;
  readonly sent_by_teammate_id: Text;
  readonly teammate_name?: Text;
  readonly approved_by: Text;
  readonly approved_name?: Text;
  readonly client_id: Text;
  readonly occurred_at: string;
  readonly delivered_at: Text;
  /** Texts (0103): which way it went, when an RCS message was read, what it carried and which button a reply came from. */
  readonly transport?: Text;
  readonly read_at?: Text;
  readonly rich?: Text;
  readonly button_reply?: Text;
}

/** A synced call, with who placed it and who answered it. */
export interface CallThreadRow {
  readonly id: string;
  readonly conversation_id: Text;
  readonly direction: string;
  readonly from_e164: Text;
  readonly to_e164: Text;
  readonly status: string;
  readonly answered_via: Text;
  readonly answered_by_user_id: Text;
  readonly answered_name?: Text;
  readonly placed_by: Text;
  readonly placed_name?: Text;
  readonly started_at: string;
  readonly answered_at: Text;
  readonly ended_at: Text;
  readonly duration_seconds: number | null;
  readonly is_voicemail: number | boolean | null;
  readonly recording_seconds: number | null;
  readonly transcript: Text;
  readonly transcript_status?: Text;
}

/** A stored photo or file on a message. */
export interface MediaShape {
  readonly bucket: string;
  readonly objectPath: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly name: string;
  readonly fileId?: string;
}

/** A thread item from a phone's copy: the API's ThreadItem, less what the copy doesn't hold (an email's HTML). */
export interface ThreadItemShape extends ThreadItemFacts {
  readonly media: readonly MediaShape[];
  readonly deliveredAt: string | null;
  /**
   * Whether the carrier recorded anything, which is all the phone's copy can say: where our copy of the audio
   * is kept is deliberately not synced (packages/db/test/sync-secrets.test.ts — the phone derives the folder
   * and lists it instead). So a recording that never reached our storage reads as present here and turns out
   * to be missing when somebody presses play, which the player says plainly. The web, which has the path,
   * knows the difference up front.
   */
  readonly hasRecording: boolean;
  readonly recordingSeconds: number | null;
  readonly transcript: string | null;
  readonly transcriptStatus: 'pending' | 'completed' | 'failed' | null;
  readonly toAddresses: readonly string[];
  readonly ccAddresses: readonly string[];
  /** The phone's copy doesn't hold received emails' HTML; the plain text shows instead. */
  readonly bodyHtml: null;
  readonly via: null;
  /** The message's own client id: what a reply made on the phone is matched by once the server's copy arrives. */
  readonly clientId: string | null;
  /** When a call through someone's cell was picked up by the customer, and ended. */
  readonly answeredAt: string | null;
  readonly endedAt: string | null;
  readonly fromE164: string | null;
  readonly toE164: string | null;
}

/**
 * What phones don't show, as the web's thread doesn't: a held text someone cancelled (it never goes), and a call
 * through someone's own cell that never dialed the customer (nobody pressed 1).
 */
export function hiddenMessage(r: Pick<MessageThreadRow, 'error_code'>): boolean {
  return r.error_code === CANCELLED_TEXT;
}
export function hiddenCall(
  r: Pick<CallThreadRow, 'answered_via' | 'answered_by_user_id'>,
): boolean {
  return r.answered_via === 'bridge' && !r.answered_by_user_id;
}

const HANDOFF_PREFIX = 'handoff:';

/** How a text went (0103), from the copy: sms, mms or rcs, or null before the carrier said. */
function transportOf(value: Text | undefined): ThreadItemFacts['transport'] {
  return value === 'sms' || value === 'mms' || value === 'rcs' ? value : null;
}

/** What a rich text carried (0103), from the JSON the copy holds; null for an ordinary text. */
function richOf(value: Text | undefined): ThreadItemFacts['rich'] {
  const r = json<Partial<RichText> | null>(value, null);
  if (!r || (r.kind !== 'buttons' && r.kind !== 'card' && r.kind !== 'carousel')) return null;
  return {
    kind: r.kind,
    title: r.title ?? null,
    buttons: Array.isArray(r.buttons) ? r.buttons : [],
    cards: Array.isArray(r.cards) ? r.cards : [],
    smsText: r.smsText ?? '',
  };
}

/** Which button a customer's reply came from (0103), from the JSON the copy holds. */
function replyOf(value: Text | undefined): ThreadItemFacts['buttonReply'] {
  const b = json<Partial<ButtonReply> | null>(value, null);
  if (!b || !b.title || (b.type !== 'reply' && b.type !== 'link' && b.type !== 'call')) return null;
  return { type: b.type, title: b.title, via: b.via === 'text' ? 'text' : 'tap' };
}

export function messageItemOf(r: MessageThreadRow): ThreadItemShape {
  const channel =
    r.channel === 'sms' || r.channel === 'email' || r.channel === 'chat' ? r.channel : null;
  const media = json<MediaShape[]>(r.media, []);
  return {
    type: 'message',
    id: r.id,
    occurredAt: new Date(r.occurred_at).toISOString(),
    direction: r.direction === 'outbound' ? 'outbound' : 'inbound',
    status: r.status,
    channel,
    body: r.body_text,
    subject: r.subject,
    fromAddress: r.from_address,
    media: Array.isArray(media) ? media : [],
    sentBy: userRef(r.sent_by, r.sent_by_name),
    errorCode: r.error_code,
    errorMessage: r.error_message,
    deliveredAt: iso(r.delivered_at),
    transport: transportOf(r.transport),
    readAt: iso(r.read_at),
    rich: richOf(r.rich),
    buttonReply: replyOf(r.button_reply),
    durationSeconds: null,
    isVoicemail: false,
    hasRecording: false,
    recordingSeconds: null,
    answeredVia: null,
    transcript: null,
    transcriptStatus: null,
    answeredBy: null,
    bodyHtml: null,
    toAddresses: json<string[]>(r.to_addresses, []),
    ccAddresses: json<string[]>(r.cc_addresses, []),
    via: null,
    teammate:
      r.sent_by_teammate_id && r.teammate_name
        ? { id: r.sent_by_teammate_id, name: r.teammate_name }
        : null,
    approvedBy: userRef(r.approved_by, r.approved_name),
    // The draft a message came from isn't on the phone.
    aiDraftId: null,
    handoffLine: (r.client_id ?? '').startsWith(HANDOFF_PREFIX),
    scheduledFor: scheduledForOf({
      status: r.status,
      errorCode: r.error_code,
      occurredAt: r.occurred_at,
    }),
    clientId: r.client_id,
    answeredAt: null,
    endedAt: null,
    fromE164: null,
    toE164: null,
  };
}

export function callItemOf(r: CallThreadRow): ThreadItemShape {
  const via = r.answered_via;
  return {
    type: 'call',
    id: r.id,
    occurredAt: new Date(r.started_at).toISOString(),
    direction: r.direction === 'outbound' ? 'outbound' : 'inbound',
    status: r.status,
    channel: null,
    body: null,
    subject: null,
    fromAddress: r.from_e164,
    media: [],
    sentBy: userRef(r.placed_by, r.placed_name),
    errorCode: null,
    errorMessage: null,
    deliveredAt: null,
    durationSeconds: r.duration_seconds,
    isVoicemail: bool(r.is_voicemail),
    hasRecording: (r.recording_seconds ?? 0) > 0,
    recordingSeconds: r.recording_seconds,
    answeredVia:
      via === 'browser' || via === 'forwarding' || via === 'bridge' || via === 'ai' ? via : null,
    transcript: r.transcript,
    transcriptStatus:
      r.transcript_status === 'pending' ||
      r.transcript_status === 'completed' ||
      r.transcript_status === 'failed'
        ? r.transcript_status
        : null,
    answeredBy: userRef(r.answered_by_user_id, r.answered_name),
    bodyHtml: null,
    toAddresses: [],
    ccAddresses: [],
    via: null,
    teammate: null,
    approvedBy: null,
    aiDraftId: null,
    handoffLine: false,
    scheduledFor: null,
    clientId: null,
    answeredAt: iso(r.answered_at),
    endedAt: iso(r.ended_at),
    fromE164: r.from_e164,
    toE164: r.to_e164,
  };
}

/** A conversation's thread from the copy, oldest first, without what phones hide. */
export function threadItemsOf(
  messages: readonly MessageThreadRow[],
  calls: readonly CallThreadRow[],
): ThreadItemShape[] {
  const items = [
    ...messages.filter((m) => !hiddenMessage(m)).map(messageItemOf),
    ...calls.filter((c) => !hiddenCall(c)).map(callItemOf),
  ];
  return items.sort((a, b) =>
    a.occurredAt === b.occurredAt ? a.id.localeCompare(b.id) : a.occurredAt < b.occurredAt ? -1 : 1,
  );
}

// ----------------------------------------------------------------------------------------------------- drafts

/** A synced draft (only waiting ones reach phones), with its teammate's and customer's names joined in. */
export interface TeammateDraftRow {
  readonly id: string;
  readonly teammate_id: string;
  readonly teammate_name?: Text;
  readonly conversation_id: Text;
  readonly channel?: Text;
  readonly person_id: Text;
  readonly first_name?: Text;
  readonly last_name?: Text;
  readonly lead_id: Text;
  readonly kind: string;
  readonly status: string;
  readonly preview: Text;
  readonly edits: Text;
  readonly expires_at: Text;
  readonly created_at: Text;
}

/** A draft as its card and words take it. */
export interface TeammateDraftShape extends DraftFacts {
  readonly id: string;
  readonly status: string;
  readonly conversationId: string | null;
  readonly personId: string | null;
  readonly leadId: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly edits: { readonly body?: string; readonly subject?: string } | null;
  /** Reply drafts: anyone who works the inbox. Approval drafts: owners and admins. */
  readonly canDecide: boolean;
  readonly preview: DraftFacts['preview'] & {
    readonly message: { readonly body: string; readonly subject: string | null } | null;
  };
}

interface PreviewJson {
  message?: { body?: unknown; subject?: unknown; channel?: unknown } | null;
  actions?: unknown[];
  discount?: { percent?: unknown; reason?: unknown } | null;
  call?: { toDisplay?: unknown; goal?: unknown } | null;
}

export function teammateDraftOf(
  r: TeammateDraftRow,
  opts: { readonly canManage: boolean },
): TeammateDraftShape {
  const preview = json<PreviewJson>(r.preview, {});
  const message =
    preview.message && typeof preview.message.body === 'string'
      ? {
          body: preview.message.body,
          subject: typeof preview.message.subject === 'string' ? preview.message.subject : null,
        }
      : null;
  const actions: DraftActionFacts[] = [];
  for (const a of Array.isArray(preview.actions) ? preview.actions : []) {
    const action = a as { kind?: unknown; startsAt?: unknown; summary?: unknown };
    const summary = typeof action.summary === 'string' ? action.summary : '';
    if (action.kind === 'cancel' || action.kind === 'waitlist' || action.kind === 'add_to_visit')
      actions.push({ kind: action.kind, summary });
    else if (
      typeof action.kind === 'string' &&
      (MONEY_ACTION_KINDS as readonly string[]).includes(action.kind)
    )
      actions.push({ kind: action.kind as MoneyDraftActionKind, summary });
    else if (
      (action.kind === 'book' || action.kind === 'reschedule' || action.kind === 'book_series') &&
      typeof action.startsAt === 'string'
    )
      actions.push({ kind: action.kind, startsAt: action.startsAt, summary });
  }
  const discount =
    preview.discount && typeof preview.discount.percent === 'number'
      ? {
          percent: preview.discount.percent,
          reason: typeof preview.discount.reason === 'string' ? preview.discount.reason : '',
        }
      : null;
  const edits = json<{ body?: string; subject?: string } | null>(r.edits, null);
  const messageChannel =
    typeof preview.message?.channel === 'string' ? preview.message.channel : null;
  const call =
    preview.call &&
    typeof preview.call.toDisplay === 'string' &&
    typeof preview.call.goal === 'string'
      ? { toDisplay: preview.call.toDisplay, goal: preview.call.goal }
      : null;
  const kind = r.kind === 'approval' ? 'approval' : r.kind === 'call' ? 'call' : 'reply';
  return {
    id: r.id,
    kind,
    status: r.status,
    channel: r.channel ?? messageChannel,
    teammate: { id: r.teammate_id, name: r.teammate_name || 'The AI teammate' },
    person: r.person_id ? { fullName: nameOf(r.first_name, r.last_name) || 'Customer' } : null,
    preview: { message, actions, discount, call },
    conversationId: r.conversation_id,
    personId: r.person_id,
    leadId: r.lead_id,
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    edits,
    canDecide: r.status === 'pending' && (kind !== 'approval' || opts.canManage),
  };
}
