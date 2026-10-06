/**
 * The website chat's reads for the worker: the widget a public key names, the visitor a token names, the chat
 * as the visitor sees it, whether anyone is answering, and the hashes. The worker reads chat tables directly and
 * changes them only through core's chat commands. Nothing here returns a matched customer's details: a visitor
 * sees their own chat, the teammate's name and people's first names.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { eq, type SQL } from 'drizzle-orm';
import {
  CHAT_TOKEN_ROTATE_MS,
  CHAT_VISITOR_NAME,
  formatPhone,
  isSocialChannel,
  loadTeammate,
  localDateOf,
  localMinutes,
  parseClock,
  socialContactName,
  teammateConfigOf,
  userNames,
  weekdayOf,
  type TeammateConfig,
  type WeeklyHours,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import { chatWidgets } from '@hfos/db/schema';

// ---- Tokens, hashes and cursors ----

/** A visitor's token: 32 random bytes as base64url (43 characters), shown to their chat window once. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const newVisitorToken = (): string => randomBytes(32).toString('base64url');
/** What the database keeps of a token: its SHA-256 (tokens are random, so no key or stretching is needed). */
export const tokenHashOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
/** A keyed one-way hash of an IP address (CHAT_IP_KEY); the address itself is never kept. */
export const ipHmacOf = (key: string, ip: string): string =>
  createHmac('sha256', key).update(ip).digest('hex');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a chat window got to: a message's time (microseconds since 1970) and its id. */
export interface Cursor {
  readonly micros: number;
  readonly id: string;
}
export const cursorOf = (at: Date | string, id: string): string =>
  `${new Date(at).getTime() * 1000}.${id}`;
export function parseCursor(raw: string | null | undefined): Cursor | null {
  const m = /^(\d{1,17})\.(.{36})$/.exec((raw ?? '').trim());
  if (!m || !UUID_RE.test(m[2]!)) return null;
  return { micros: Number(m[1]), id: m[2]!.toLowerCase() };
}
/**
 * A message committed a moment after a later one can sort just behind a cursor, so this much before it is sent
 * again. Chat windows keep one copy per message id.
 */
export const CURSOR_OVERLAP_MS = 10_000;

// ---- The widget a key names ----

export const KEY_RE = /^wk_[A-Za-z0-9]{20}$/;

export interface WidgetRoute {
  readonly widgetId: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly paused: boolean;
}

/** The business and widget a public key names (private.chat_widget_lookup), or null. */
export async function widgetRoute(db: Db, key: string): Promise<WidgetRoute | null> {
  if (!KEY_RE.test(key)) return null;
  const [r] = await asWorker(db, {}, (tx) =>
    rows<{ widget_id: string; workspace_id: string; organization_id: string; paused: boolean }>(
      tx,
      sql`select widget_id, workspace_id, organization_id, paused from private.chat_widget_lookup(${key})`,
    ),
  );
  return r
    ? {
        widgetId: r.widget_id,
        workspaceId: r.workspace_id,
        organizationId: r.organization_id,
        paused: r.paused,
      }
    : null;
}

export type WidgetRow = typeof chatWidgets.$inferSelect;

export async function loadWidget(tx: Tx, widgetId: string): Promise<WidgetRow | null> {
  const [w] = await tx.select().from(chatWidgets).where(eq(chatWidgets.id, widgetId));
  return w ?? null;
}

/** The embedding page's origin as the widget's list keeps them: lower case, no trailing slash. */
export const originOf = (raw: string): string => raw.trim().toLowerCase().replace(/\/+$/, '');
export const originAllowed = (widget: WidgetRow, raw: string): boolean =>
  widget.allowedOrigins.includes(originOf(raw));

// ---- Who's answering ----

/** Whether `now` falls inside these weekly hours, in the time zone (day 0 is Sunday; an end of 24:00 is midnight). */
export function withinHours(hours: WeeklyHours, timeZone: string, now: number): boolean {
  const day = weekdayOf(localDateOf(now, timeZone));
  const minute = localMinutes(new Date(now), timeZone);
  return hours.some(
    (h) => h.day === day && parseClock(h.start) <= minute && minute < parseClock(h.end),
  );
}

/** Whether the teammate works now: always, only while the business is closed, or its own hours. */
export function teammateWorkingNow(
  config: TeammateConfig,
  openHours: WeeklyHours,
  timeZone: string,
  now: number,
): boolean {
  switch (config.hours.mode) {
    case 'always':
      return true;
    case 'after_hours':
      return !withinHours(openHours, timeZone, now);
    case 'custom':
      return withinHours(config.hours.custom, timeZone, now);
  }
}

/**
 * The AI teammate that answers this widget: the widget names it, it isn't off, and it answers website chat (on
 * this widget, when its settings name one). Null when only people answer.
 */
export async function answeringTeammate(
  tx: Tx,
  widget: WidgetRow,
): Promise<{ readonly name: string; readonly config: TeammateConfig } | null> {
  if (!widget.teammateId) return null;
  const t = await loadTeammate(tx, widget.workspaceId, { teammateId: widget.teammateId });
  if (!t || t.status === 'off') return null;
  const config = teammateConfigOf(t);
  if (!config.channels.chat) return null;
  if (config.channels.widgetId && config.channels.widgetId !== widget.id) return null;
  return { name: t.name, config };
}

// ---- The visitor a token names ----

export interface VisitorAuth {
  readonly id: string;
  readonly conversationId: string | null;
  /** Which details they've given; never the details themselves. */
  readonly gave: { readonly name: boolean; readonly phone: boolean; readonly email: boolean };
  readonly tokenIssuedAt: Date;
  readonly turnstilePassedAt: Date | null;
  /** The token was the previous one, inside its 10 minutes of grace. */
  readonly viaPrevious: boolean;
  /** The token is a week old. */
  readonly rotateDue: boolean;
  /** Blocked themselves, or their network (as recorded, or the one they're on now) is. */
  readonly blocked: 'visitor' | 'network' | null;
}

const at = (v: Date | string): Date => new Date(v);

/** The visitor on this widget whose token (or previous token, still in its grace) hashes to this. */
export async function visitorByToken(
  tx: Tx,
  input: {
    readonly workspaceId: string;
    readonly widgetId: string;
    readonly tokenHash: string;
    readonly ipHmac: string;
  },
): Promise<VisitorAuth | null> {
  const hash = sql`decode(${input.tokenHash}, 'hex')`;
  const [v] = await rows<{
    id: string;
    conversation_id: string | null;
    gave_name: boolean;
    gave_phone: boolean;
    gave_email: boolean;
    token_issued_at: Date | string;
    turnstile_passed_at: Date | string | null;
    via_previous: boolean;
    rotate_due: boolean;
    blocked: boolean;
    network_blocked: boolean;
  }>(
    tx,
    sql`select v.id, v.conversation_id, v.name is not null as gave_name, v.phone_e164 is not null as gave_phone,
          v.email is not null as gave_email, v.token_issued_at, v.turnstile_passed_at,
          v.token_hash <> ${hash} as via_previous,
          v.token_issued_at < now() - ${CHAT_TOKEN_ROTATE_MS}::float8 * interval '1 millisecond' as rotate_due,
          v.blocked_at is not null as blocked,
          exists (select 1 from app.chat_visitors o
                  where o.workspace_id = v.workspace_id and o.network_blocked_until > now()
                    and (o.ip_hmac = v.ip_hmac or o.ip_hmac = decode(${input.ipHmac}, 'hex'))) as network_blocked
        from app.chat_visitors v
        where v.workspace_id = ${input.workspaceId} and v.widget_id = ${input.widgetId}
          and (v.token_hash = ${hash} or (v.prev_token_hash = ${hash} and v.prev_token_expires_at > now()))`,
  );
  if (!v) return null;
  return {
    id: v.id,
    conversationId: v.conversation_id,
    gave: { name: v.gave_name, phone: v.gave_phone, email: v.gave_email },
    tokenIssuedAt: at(v.token_issued_at),
    turnstilePassedAt: v.turnstile_passed_at ? at(v.turnstile_passed_at) : null,
    viaPrevious: v.via_previous,
    rotateDue: v.rotate_due,
    blocked: v.blocked ? 'visitor' : v.network_blocked ? 'network' : null,
  };
}

/** Whether this network (a hashed address) is blocked in this business. */
export async function networkBlocked(
  tx: Tx,
  workspaceId: string,
  ipHmac: string,
): Promise<boolean> {
  const [r] = await rows<{ blocked: boolean }>(
    tx,
    sql`select exists (select 1 from app.chat_visitors
          where workspace_id = ${workspaceId} and ip_hmac = decode(${ipHmac}, 'hex')
            and network_blocked_until > now()) as blocked`,
  );
  return r?.blocked ?? false;
}

/** New visitors from this network in this business lately. */
export async function newVisitorsFrom(
  tx: Tx,
  workspaceId: string,
  ipHmac: string,
  windowMs: number,
): Promise<number> {
  const [r] = await rows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from app.chat_visitors
        where workspace_id = ${workspaceId} and ip_hmac = decode(${ipHmac}, 'hex')
          and created_at > now() - ${windowMs}::float8 * interval '1 millisecond'`,
  );
  return r?.n ?? 0;
}

/** How many messages the visitor has sent in their chat. */
export async function inboundCount(tx: Tx, conversationId: string): Promise<number> {
  const [r] = await rows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from app.messages
        where conversation_id = ${conversationId} and direction = 'inbound'`,
  );
  return r?.n ?? 0;
}

/** What the visitor sent before, for the human check's count, resends and repeats. */
export async function visitorHistory(
  tx: Tx,
  conversationId: string,
  input: { readonly clientId: string; readonly body: string; readonly repeatWindowMs: number },
): Promise<{ readonly sent: number; readonly resend: boolean; readonly same: number }> {
  const [r] = await rows<{ sent: number; resend: boolean; same: number }>(
    tx,
    sql`select count(*)::int as sent,
          coalesce(bool_or(client_id = ${input.clientId}), false) as resend,
          (count(*) filter (where created_at > now() - ${input.repeatWindowMs}::float8 * interval '1 millisecond'
            and lower(regexp_replace(btrim(body_text), '\\s+', ' ', 'g')) = ${sameText(input.body)}))::int as same
        from app.messages
        where conversation_id = ${conversationId} and direction = 'inbound'`,
  );
  return { sent: r?.sent ?? 0, resend: r?.resend ?? false, same: r?.same ?? 0 };
}

/** A message as repeats are compared: spaces squeezed, case ignored. */
export const sameText = (body: string): string => body.trim().replace(/\s+/g, ' ').toLowerCase();

// ---- The chat as the visitor sees it ----

export type ChatSender = 'visitor' | 'teammate' | 'person' | 'business';

export interface ChatMessageOut {
  readonly id: string;
  /** The visitor; the AI teammate; a person on the team; or the business itself (its automatic messages). */
  readonly from: ChatSender;
  /** The teammate's name or the person's first name; null for the visitor and the business. */
  readonly name: string | null;
  readonly body: string;
  readonly at: string;
  /** A person's first message in this chat ("Dale joined"). */
  readonly joined: boolean;
}

export interface Listed {
  readonly message: ChatMessageOut;
  /** Where a chat window that has this message got to (the stream's event id, and `after` for polling). */
  readonly cursor: string;
}

type MessageRow = {
  id: string;
  direction: string;
  body_text: string | null;
  sent_by: string | null;
  sent_by_teammate_id: string | null;
  teammate_name: string | null;
  created_at: Date | string;
  joined: boolean;
};

const messagesWhere = (where: SQL) =>
  sql`select m.id, m.direction::text as direction, m.body_text, m.sent_by, m.sent_by_teammate_id,
        t.name as teammate_name, m.created_at,
        (m.sent_by is not null and not exists (
          select 1 from app.messages o
          where o.conversation_id = m.conversation_id and o.channel = 'chat' and o.direction = 'outbound'
            and o.sent_by = m.sent_by and o.status not in ('failed', 'undelivered')
            and (o.created_at, o.id) < (m.created_at, m.id))) as joined
      from app.messages m
      left join app.ai_teammates t on t.id = m.sent_by_teammate_id
      where m.channel = 'chat' and m.status not in ('failed', 'undelivered') and ${where}`;

/** A person's first name for the visitor; never an email address (userNames falls back to one). */
export function firstNameOf(full: string | null | undefined): string | null {
  const name = (full ?? '').trim();
  if (!name || name.includes('@') || name === 'Someone') return null;
  return name.split(/\s+/)[0]!;
}

async function listed(tx: Tx, list: readonly MessageRow[]): Promise<Listed[]> {
  const names = await userNames(
    tx,
    list.flatMap((m) =>
      m.direction === 'outbound' && m.sent_by && !m.sent_by_teammate_id ? [m.sent_by] : [],
    ),
  );
  return list.map((m) => {
    const from: ChatSender =
      m.direction === 'inbound'
        ? 'visitor'
        : m.sent_by_teammate_id
          ? 'teammate'
          : m.sent_by
            ? 'person'
            : 'business';
    return {
      message: {
        id: m.id,
        from,
        name:
          from === 'teammate'
            ? m.teammate_name
            : from === 'person'
              ? firstNameOf(names.get(m.sent_by!))
              : null,
        body: m.body_text ?? '',
        at: at(m.created_at).toISOString(),
        joined: from === 'person' && m.joined,
      },
      cursor: cursorOf(m.created_at, m.id),
    };
  });
}

/** The chat's messages after a cursor (with the overlap), oldest first; or its latest ones. */
export async function listMessages(
  tx: Tx,
  conversationId: string,
  opts: { readonly after?: Cursor | null; readonly limit?: number } = {},
): Promise<Listed[]> {
  const limit = opts.limit ?? 100;
  if (opts.after) {
    const from = (opts.after.micros / 1000 - CURSOR_OVERLAP_MS) / 1000;
    const list = await rows<MessageRow>(
      tx,
      sql`${messagesWhere(sql`m.conversation_id = ${conversationId} and m.created_at > to_timestamp(${from}::float8)`)}
          order by m.created_at, m.id limit ${limit}`,
    );
    return listed(tx, list);
  }
  const list = await rows<MessageRow>(
    tx,
    sql`${messagesWhere(sql`m.conversation_id = ${conversationId}`)}
        order by m.created_at desc, m.id desc limit ${limit}`,
  );
  return listed(tx, list.reverse());
}

/** One chat message as the visitor sees it. */
export async function messageView(tx: Tx, messageId: string): Promise<Listed | null> {
  const list = await rows<MessageRow>(tx, messagesWhere(sql`m.id = ${messageId}`));
  const [one] = await listed(tx, list);
  return one ?? null;
}

/** The AI teammate is writing in this chat right now. */
export async function typingNow(tx: Tx, conversationId: string): Promise<boolean> {
  const [r] = await rows<{ typing: boolean }>(
    tx,
    sql`select exists (select 1 from app.chat_signals
          where conversation_id = ${conversationId} and kind = 'typing' and expires_at > now()) as typing`,
  );
  return r?.typing ?? false;
}

// ---- Naming a chat for people ----

/**
 * How emails to the team name a conversation's contact: a text's number, an email's address, for a website chat the
 * name the visitor typed, or "Website visitor" (never the chat:<id> behind it), and for a client's portal "A client
 * in their portal" (never its portal:<id> key; the client's own name comes first wherever there's one).
 */
export async function conversationContact(
  tx: Tx,
  conversation: { readonly id: string; readonly channel: string; readonly counterpart: string },
): Promise<string> {
  if (conversation.channel === 'sms') return formatPhone(conversation.counterpart);
  if (conversation.channel === 'portal') return 'A client in their portal';
  // Messenger and Instagram (20261025000200): what Meta calls them, never the thread's key.
  if (isSocialChannel(conversation.channel)) {
    const [c] = await rows<{ name: string | null; username: string | null }>(
      tx,
      sql`select name, username from app.meta_contacts where conversation_id = ${conversation.id}`,
    );
    return socialContactName(conversation.channel, c);
  }
  if (conversation.channel !== 'chat') return conversation.counterpart;
  const id = conversation.counterpart.startsWith('chat:') ? conversation.counterpart.slice(5) : '';
  if (!UUID_RE.test(id)) return CHAT_VISITOR_NAME;
  const [v] = await rows<{ name: string | null }>(
    tx,
    sql`select name from app.chat_visitors where id = ${id}`,
  );
  return v?.name ?? CHAT_VISITOR_NAME;
}
