/**
 * Replies in a client's portal (Real Estate round two, step 5), as website chat's follow-up does them
 * (chat/followup.ts):
 *
 * - `message.sent` on a portal thread: a person's reply is marked sent (the client reads it in their portal from
 *   then on), and the notice is armed, one pending per thread.
 * - `portal.unread_notice`: once the oldest reply the client hasn't read is 10 minutes old, they get one email with a
 *   link to their portal, and nothing of what was said (Chris, 2026-09-30). A reply counts as read when their portal
 *   showed it (portal.mark_read) or they wrote after it. Each batch goes once: a later reply starts a new one. Nothing
 *   goes to someone whose portal was turned off, or who has no email on file.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { executeCommandIn, portalMarkSent, scheduleJob, userNames } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { portalReplyEmail } from '../emails/templates';
import type { EventHandler } from '../handlers/types';
import { publicOrigin } from '../hosting/origin';
import type { JobHandler } from '../jobs';
import { systemActor, tenantOf, workerMeta } from '../services';
import { recordSystemEvent } from '../system-event';
import { portalUrl } from './links';

export const PORTAL_JOBS = { unreadNotice: 'portal.unread_notice' } as const;
/** A reply the client hasn't read for this long gets them an email with a link. */
export const PORTAL_UNREAD_AFTER_MS = 10 * 60_000;
export const unreadNoticeKey = (conversationId: string): string =>
  `portal-unread:${conversationId}`;
/** Recorded when a notice went out; its payload's throughMessageId is the newest reply it was about. */
export const NOTICED_EVENT = 'portal.unread_noticed';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** `message.sent`: a reply went into a client's portal. */
export const onPortalReplySent: EventHandler = async (ctx) => {
  const p = isRecord(ctx.event.payload) ? ctx.event.payload : {};
  const conversationId = str(p['conversationId']);
  if (p['channel'] !== 'portal' || !conversationId || !ctx.event.entityId) return;
  const scope = tenantOf(ctx.scope);
  if (p['status'] === 'queued')
    await executeCommandIn(
      ctx.tx,
      portalMarkSent,
      { workspaceId: scope.workspaceId, messageId: ctx.event.entityId },
      systemActor(scope),
      workerMeta(ctx.event.correlationId, ctx.event.id),
    );
  await scheduleJob(ctx.tx, {
    kind: PORTAL_JOBS.unreadNotice,
    dedupeKey: unreadNoticeKey(conversationId),
    runAt: new Date(Date.now() + PORTAL_UNREAD_AFTER_MS),
    payload: { conversationId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
};

type Reply = { id: string; created_at: Date | string; sent_by: string | null };

/** The replies the client hasn't read: not marked read, after their own latest message and after the last notice. */
function unreadReplies(tx: Tx, workspaceId: string, conversationId: string): Promise<Reply[]> {
  return rows<Reply>(
    tx,
    sql`select m.id, m.created_at, m.sent_by
        from app.messages m
        where m.conversation_id = ${conversationId} and m.channel = 'portal' and m.direction = 'outbound'
          and m.status in ('queued', 'sent')
          and not exists (select 1 from app.messages i
                          where i.conversation_id = m.conversation_id and i.direction = 'inbound'
                            and i.created_at > m.created_at)
          and not exists (select 1 from app.events e
                          join app.messages d on d.id = (e.payload ->> 'throughMessageId')::uuid
                          where e.workspace_id = ${workspaceId} and e.entity_type = 'conversation'
                            and e.entity_id = ${conversationId} and e.event_type = ${NOTICED_EVENT}
                            and (d.created_at, d.id) >= (m.created_at, m.id))
        order by m.created_at, m.id
        limit 20`,
  );
}

type Access = {
  access_id: string;
  public_ref: string;
  link_version: number;
  first_name: string;
  email: string | null;
  business: string;
};

/** `portal.unread_notice`: one link-only email for the replies a client hasn't read, once per batch. */
export const portalUnreadNotice: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const conversationId = String(ctx.job.payload['conversationId'] ?? '');
  return asWorker(ctx.db, scope, async (tx) => {
    const [c] = await tx
      .select({
        id: conversations.id,
        channel: conversations.channel,
        personId: conversations.personId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!c || c.channel !== 'portal' || !c.personId) return;
    const unread = await unreadReplies(tx, scope.workspaceId, c.id);
    if (!unread.length) return;
    const dueAt = new Date(new Date(unread[0]!.created_at).getTime() + PORTAL_UNREAD_AFTER_MS);
    if (dueAt.getTime() > ctx.now + 250) return { rescheduleAt: dueAt };
    const [a] = await rows<Access>(
      tx,
      sql`select a.id as access_id, a.public_ref, a.link_version, p.first_name, p.email::text as email,
            w.name as business
          from app.portal_access a
          join app.people p on p.id = a.person_id
          join app.workspaces w on w.id = a.workspace_id
          where a.workspace_id = ${scope.workspaceId} and a.person_id = ${c.personId} and a.revoked_at is null`,
    );
    // Their portal was turned off, or there's nowhere to write: nothing goes out and nothing is recorded.
    if (!a?.email) return;
    const newest = unread[unread.length - 1]!;
    const writers = [...new Set(unread.map((m) => m.sent_by).filter((x): x is string => !!x))];
    const names = await userNames(tx, writers);
    const from =
      writers.length === 1 ? ((names.get(writers[0]!) ?? '').trim().split(/\s+/)[0] ?? null) : null;
    const origin = await publicOrigin(tx, scope.workspaceId, ctx.portalLinks.webUrl);
    const link = portalUrl(
      ctx.portalLinks,
      { publicRef: a.public_ref, accessId: a.access_id, linkVersion: a.link_version },
      origin,
    );
    await ctx.mailer.send({
      to: a.email,
      ...portalReplyEmail({
        business: a.business,
        firstName: a.first_name,
        from: from || null,
        link,
        count: unread.length,
      }),
    });
    await recordSystemEvent(tx, {
      type: NOTICED_EVENT,
      action: PORTAL_JOBS.unreadNotice,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'conversation',
      entityId: c.id,
      payload: { throughMessageId: newest.id, replies: unread.length, _broadcast: false },
      after: { replies: unread.length },
      correlationId: randomUUID(),
      causationId: ctx.job.id,
    });
  });
};
