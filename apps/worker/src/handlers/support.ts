/**
 * What the worker does about the support desk (M13).
 *
 * These run on events with no business attached at all — the support desk belongs to HandsFreeOS, not to any
 * tenant — which is why the outbox lets `support.*` and `platform.*` events through with an empty scope.
 *
 * The one exception is the last handler: when a support person opens a business to look at it, the business
 * gets told, in its own audit log, in its own workspace. That is the whole point of writing it down there.
 */
import { createHash, randomBytes } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { staffInvitations } from '@hfos/db/schema';
import { queueSupportDraft as queueDraft } from '../support/inbound';
import { acknowledgeTicket, sendTicketReply, staffInvitationEmail } from '../support/mail';
import { recordSystemEvent } from '../system-event';
import type { EventHandler } from './types';

const STAFF_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function mintToken(): { token: string; hash: Buffer } {
  const token = `sup_${randomBytes(32).toString('base64url')}`;
  return { token, hash: createHash('sha256').update(token).digest() };
}

/** A ticket that just arrived: say we have it, and ask the AI for something to work from. */
export const onSupportTicketOpened: EventHandler = async (ctx) => {
  const ticketId = ctx.event.entityId;
  if (!ticketId) return;
  const channel = (ctx.event.payload as { channel?: string }).channel;
  // Someone who asked from inside the app watched it land; only mail needs an answer saying it arrived.
  if (channel !== 'in_app') await acknowledgeTicket(ctx, ticketId);
  await queueDraft(ctx, ticketId);
};

/** A person's answer, on its way out. Notes stay put; sendTicketReply knows the difference. */
export const onSupportTicketReplied: EventHandler = async (ctx) => {
  const ticketId = ctx.event.entityId;
  const { messageId, internal } = ctx.event.payload as { messageId?: string; internal?: boolean };
  if (!ticketId || !messageId || internal) return;
  await sendTicketReply(ctx, { ticketId, messageId });
};

/** Somebody pressed "Ask the AI". The work itself happens on a job, so the click comes back at once. */
export const onSupportDraftRequested: EventHandler = async (ctx) => {
  const ticketId = ctx.event.entityId;
  if (ticketId) await queueDraft(ctx, ticketId);
};

/** A new support person: mint the link, send it, and never write the token itself anywhere we can read. */
const sendStaffInvitation: EventHandler = async (ctx) => {
  const invitationId = ctx.event.entityId;
  if (!invitationId) return;
  const [inv] = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      id: string;
      email: string;
      role: string;
      accepted_at: string | null;
      revoked_at: string | null;
      inviter: string | null;
    }>(
      tx,
      sql`select i.id, i.email::text as email, i.role::text as role, i.accepted_at, i.revoked_at,
                 u.full_name as inviter
          from platform.staff_invitations i
          left join app.users u on u.id = i.invited_by
          where i.id = ${invitationId}`,
    ),
  );
  if (!inv || inv.accepted_at || inv.revoked_at) return;
  const { token, hash } = mintToken();
  const expiresAt = new Date(Date.now() + STAFF_INVITATION_TTL_MS);
  await asWorker(ctx.db, {}, (tx) =>
    tx
      .update(staffInvitations)
      .set({ tokenHash: hash, sentAt: new Date(), expiresAt })
      .where(eq(staffInvitations.id, invitationId)),
  );
  const email = staffInvitationEmail({
    inviterName: inv.inviter || 'HandsFreeOS',
    role: inv.role,
    link: `${ctx.webUrl}/support-invite/${token}`,
    expiresAt,
  });
  await ctx.mailer.send({ to: inv.email, ...email });
};

export const onSupportStaffInvited = sendStaffInvitation;
export const onSupportStaffInvitationResent = sendStaffInvitation;

/**
 * A support person opened a business to look at it. The business is told where it will look for such a
 * thing: its own audit log, in its own workspace, with the reason and how long the look lasts.
 *
 * Not when the founder opened it to work in (20261013002100): that is kept quiet, by the owner's decision. The
 * platform still has the session, and anything the founder changes is recorded like any owner's change.
 */
export const onViewAsStarted: EventHandler = async (ctx) => {
  const sessionId = ctx.event.entityId;
  const p = ctx.event.payload as {
    workspaceId?: string;
    organizationId?: string;
    reason?: string | null;
    expiresAt?: string | null;
    acting?: boolean;
  };
  if (!sessionId || !p.workspaceId || !p.organizationId || p.acting) return;
  const [who] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ name: string; email: string; acts: boolean }>(
      tx,
      sql`select coalesce(nullif(s.display_name, ''), u.full_name, '') as name, u.email::text as email,
                 v.acts
          from platform.view_as_sessions v
          join platform.staff s on s.user_id = v.staff_user_id
          join app.users u on u.id = v.staff_user_id
          where v.id = ${sessionId}`,
    ),
  );
  if (who?.acts) return;
  const scope = { workspaceId: p.workspaceId, organizationId: p.organizationId };
  await asWorker(ctx.db, scope, (tx) =>
    recordSystemEvent(tx, {
      type: 'platform.view_as_recorded',
      action: 'platform.view_as.started',
      organizationId: p.organizationId!,
      workspaceId: p.workspaceId!,
      entityType: 'view_as_session',
      entityId: sessionId,
      payload: { staff: who?.name ?? 'HandsFreeOS support', reason: p.reason ?? '' },
      after: {
        who: `${who?.name ?? 'HandsFreeOS support'} (HandsFreeOS support)`,
        reason: p.reason ?? '',
        readOnly: true,
        until: p.expiresAt ?? '',
      },
      correlationId: ctx.event.correlationId,
      causationId: ctx.event.id,
    }),
  );
};

export const supportHandlers = {
  'support_ticket.opened': [onSupportTicketOpened],
  'support_ticket.replied': [onSupportTicketReplied],
  'support_ticket.draft_requested': [onSupportDraftRequested],
  'support_staff.invited': [onSupportStaffInvited],
  'support_staff.invitation_resent': [onSupportStaffInvitationResent],
  'platform.view_as_started': [onViewAsStarted],
};
