/**
 * Server-side website chat helpers: a visitor as people may read it (never the token hashes or the hashed
 * IP), whether a visitor or their network is blocked, and a visitor's one conversation. Reads the database,
 * so commands and queries import it directly; chat/index.ts stays browser-safe.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { chatVisitors, conversations } from '@hfos/db/schema';
import { HfosError } from '../errors';
import type { CommandContext } from '../kernel/types';
import { loadConversation } from '../messaging/store';

/**
 * Every visitor column people may read (0034's column grant). Select these, never the whole row: the token
 * hashes and ip_hmac are out of reach for people, and a query naming them fails.
 */
export const VISITOR_COLUMNS = {
  id: chatVisitors.id,
  workspaceId: chatVisitors.workspaceId,
  widgetId: chatVisitors.widgetId,
  conversationId: chatVisitors.conversationId,
  name: chatVisitors.name,
  phoneE164: chatVisitors.phoneE164,
  email: chatVisitors.email,
  personId: chatVisitors.personId,
  lastPagePath: chatVisitors.lastPagePath,
  lastSeenAt: chatVisitors.lastSeenAt,
  blockedAt: chatVisitors.blockedAt,
  networkBlockedUntil: chatVisitors.networkBlockedUntil,
  createdAt: chatVisitors.createdAt,
  updatedAt: chatVisitors.updatedAt,
} as const;

export type ChatVisitor = Awaited<ReturnType<typeof loadVisitor>>;

export async function loadVisitor(tx: Tx, workspaceId: string, visitorId: string) {
  const [v] = await tx
    .select(VISITOR_COLUMNS)
    .from(chatVisitors)
    .where(and(eq(chatVisitors.id, visitorId), eq(chatVisitors.workspaceId, workspaceId)));
  if (!v)
    throw HfosError.notFound('That website visitor isn’t there anymore. Refresh and try again.');
  return v;
}

/**
 * Why a visitor can't chat: 'visitor' when they're blocked, 'network' when any visitor here with their hashed
 * IP has an active network block. The worker's view only (people can't read ip_hmac).
 */
export async function blockOf(
  tx: Tx,
  workspaceId: string,
  visitorId: string,
): Promise<'visitor' | 'network' | null> {
  const [r] = await rows<{ blocked: boolean; network: boolean }>(
    tx,
    sql`select v.blocked_at is not null as blocked,
          exists (select 1 from app.chat_visitors o
                  where o.workspace_id = v.workspace_id and o.ip_hmac = v.ip_hmac
                    and o.network_blocked_until > now()) as network
        from app.chat_visitors v where v.id = ${visitorId} and v.workspace_id = ${workspaceId}`,
  );
  if (!r)
    throw HfosError.notFound('That website visitor isn’t there anymore. Refresh and try again.');
  return r.blocked ? 'visitor' : r.network ? 'network' : null;
}

/** Whether a network (a hashed IP, in hex) has an active block in this workspace. */
export async function networkBlocked(
  tx: Tx,
  workspaceId: string,
  ipHmacHex: string | null | undefined,
): Promise<boolean> {
  if (!ipHmacHex) return false;
  const [r] = await rows<{ blocked: boolean }>(
    tx,
    sql`select exists (select 1 from app.chat_visitors
          where workspace_id = ${workspaceId} and ip_hmac = decode(${ipHmacHex}, 'hex')
            and network_blocked_until > now()) as blocked`,
  );
  return r?.blocked ?? false;
}

/** The refusal for a blocked visitor (or network), in words the chat window can show. */
export function blockedError(why: 'visitor' | 'network'): HfosError {
  return HfosError.forbidden(
    'This chat isn’t available right now. Contact the business by phone or email instead.',
    why === 'visitor' ? 'visitor_blocked' : 'network_blocked',
  );
}

type Conversation = typeof conversations.$inferSelect;

/**
 * The visitor's one conversation (counterpart chat:<visitor id>): the one it has, or a new one linked to the
 * customer it said it is. A new one is remembered on the visitor.
 */
export async function openVisitorConversation(
  ctx: CommandContext,
  visitor: {
    readonly id: string;
    readonly conversationId: string | null;
    readonly personId: string | null;
  },
): Promise<{ conversation: Conversation; created: boolean }> {
  if (visitor.conversationId)
    return { conversation: await loadConversation(ctx, visitor.conversationId), created: false };
  const workspaceId = ctx.scope.workspaceId!;
  const counterpart = `chat:${visitor.id}`;
  const find = () =>
    ctx.tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.channel, 'chat'),
          eq(conversations.counterpart, counterpart),
        ),
      );
  let [conversation] = await find();
  let created = false;
  if (!conversation) {
    const inserted = await ctx.tx
      .insert(conversations)
      .values({ workspaceId, channel: 'chat', counterpart, personId: visitor.personId })
      .onConflictDoNothing()
      .returning();
    created = !!inserted[0];
    [conversation] = inserted[0] ? inserted : await find();
  }
  if (!conversation) throw HfosError.forbidden();
  await ctx.tx
    .update(chatVisitors)
    .set({ conversationId: conversation.id })
    .where(eq(chatVisitors.id, visitor.id));
  return { conversation, created };
}
