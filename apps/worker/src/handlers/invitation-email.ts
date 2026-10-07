import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { handOverFor, onboardingSetupOf } from '@hfos/core';
import { invitations, organizations, users, workspaces } from '@hfos/db/schema';
import { recordSystemEvent } from '../system-event';
import type { EventHandler, HandlerContext } from './types';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROLE_LABEL: Record<string, string> = {
  owner: 'an Owner',
  admin: 'an Admin',
  member: 'a Member',
};

export function mintToken(): { token: string; hash: Buffer } {
  const token = `inv_${randomBytes(32).toString('base64url')}`;
  return { token, hash: createHash('sha256').update(token).digest() };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function invitationEmail(input: {
  workspaceName: string;
  organizationName: string;
  inviterName: string;
  role: string;
  link: string;
  expiresAt: Date;
  /**
   * The business's agency set it up and is handing it to them to check and finish (the owner's 53A): the email
   * says so, and its button opens the setup once they've joined.
   */
  handOver?: boolean;
}) {
  const role = ROLE_LABEL[input.role] ?? input.role;
  const agency =
    input.organizationName && input.organizationName !== input.workspaceName
      ? input.organizationName
      : '';
  const where = agency ? `${input.workspaceName} (${agency})` : input.workspaceName;
  const expires = input.expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const footer = `This link works once and expires on ${expires}. If you were not expecting it, you can ignore this email.`;
  const who = agency ? `${input.inviterName} at ${agency}` : input.inviterName;
  const subject = input.handOver
    ? `${input.inviterName} set up ${input.workspaceName} on HandsFreeOS for you`
    : `${input.inviterName} invited you to ${input.workspaceName} on HandsFreeOS`;
  const intro = input.handOver
    ? `${who} set up ${input.workspaceName} on HandsFreeOS for you, and invited you to join as ${role}.`
    : `${input.inviterName} invited you to join ${where} as ${role}.`;
  const next = input.handOver
    ? 'Check what they set up, change anything you like, and finish your part: your booking page, payments and alerts on your phone.'
    : '';
  const button = input.handOver ? 'Check it and finish' : 'Accept invitation';
  const text = `${intro}${next ? `\n\n${next}` : ''}\n\n${input.handOver ? 'Check it and finish' : 'Accept the invitation'}: ${input.link}\n\n${footer}`;
  const introHtml = input.handOver
    ? `<strong>${escapeHtml(who)}</strong> set up <strong>${escapeHtml(input.workspaceName)}</strong> on HandsFreeOS for you, and invited you to join as ${escapeHtml(role)}.`
    : `<strong>${escapeHtml(input.inviterName)}</strong> invited you to join <strong>${escapeHtml(where)}</strong> as ${escapeHtml(role)}.`;
  const html = `<div style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #191d25; max-width: 520px;">
  <p style="font-size: 15px; line-height: 1.5;">${introHtml}</p>${next ? `\n  <p style="font-size: 15px; line-height: 1.5;">${escapeHtml(next)}</p>` : ''}
  <p style="margin: 24px 0;"><a href="${input.link}" style="display: inline-block; background: #2d69d8; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 8px; font-weight: 600;">${button}</a></p>
  <p style="font-size: 13px; color: #5b616a; line-height: 1.5;">${escapeHtml(footer)}</p>
</div>`;
  return { subject, text, html };
}

async function sendInvitation(ctx: HandlerContext, opts: { resend: boolean }): Promise<void> {
  const invitationId = ctx.event.entityId;
  if (!invitationId) throw new Error('invitation event without entity id');
  // Named columns on purpose: the worker role may write token_hash but never read it.
  const [inv] = await ctx.tx
    .select({
      id: invitations.id,
      organizationId: invitations.organizationId,
      workspaceId: invitations.workspaceId,
      email: invitations.email,
      role: invitations.role,
      invitedBy: invitations.invitedBy,
      sentAt: invitations.sentAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
    })
    .from(invitations)
    .where(eq(invitations.id, invitationId));
  if (!inv) throw new Error(`invitation ${invitationId} not visible in scope`);
  if (inv.acceptedAt || inv.revokedAt) {
    ctx.log.info({ invitationId }, 'invitation no longer pending; nothing to send');
    return;
  }
  if (!opts.resend && inv.sentAt) {
    ctx.log.info({ invitationId }, 'invitation already sent; skipping duplicate delivery');
    return;
  }
  const [ws] = await ctx.tx
    .select({
      name: workspaces.name,
      organizationId: workspaces.organizationId,
      settings: workspaces.settings,
    })
    .from(workspaces)
    .where(eq(workspaces.id, inv.workspaceId));
  const [org] = ws
    ? await ctx.tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, ws.organizationId))
    : [];
  const [inviter] = inv.invitedBy
    ? await ctx.tx
        .select({ fullName: users.fullName, email: users.email })
        .from(users)
        .where(eq(users.id, inv.invitedBy))
    : [];

  const { token, hash } = mintToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  // Mint before sending: a failed send retries with a fresh token and the old link is dead either way.
  await ctx.tx
    .update(invitations)
    .set({ tokenHash: hash, sentAt: new Date(), expiresAt })
    .where(eq(invitations.id, inv.id));

  const link = `${ctx.webUrl}/invite/${token}`;
  const mail = invitationEmail({
    workspaceName: ws?.name ?? 'a HandsFreeOS workspace',
    organizationName: org?.name ?? '',
    inviterName: inviter?.fullName || inviter?.email || 'A teammate',
    role: inv.role,
    link,
    expiresAt,
    handOver: !!handOverFor(onboardingSetupOf(ws?.settings as Record<string, unknown> | null), inv),
  });
  const { messageId } = await ctx.mailer.send({ to: inv.email, ...mail });

  await recordSystemEvent(ctx.tx, {
    type: 'invitation.sent',
    action: 'invitation.send',
    organizationId: inv.organizationId,
    workspaceId: inv.workspaceId,
    entityType: 'invitation',
    entityId: inv.id,
    payload: { email: inv.email, resend: opts.resend, messageId },
    before: { email: inv.email, sentAt: inv.sentAt ? inv.sentAt.toISOString() : null },
    after: {
      email: inv.email,
      sentAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
  });
  ctx.log.info(
    { invitationId: inv.id, to: inv.email, resend: opts.resend },
    'invitation email sent',
  );
}

export const onInvitationCreated: EventHandler = (ctx) => sendInvitation(ctx, { resend: false });
export const onInvitationResendRequested: EventHandler = (ctx) =>
  sendInvitation(ctx, { resend: true });
