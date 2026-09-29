/**
 * The people who answer support, and the one power they have inside a business: looking at it.
 *
 * Adding staff works the way adding someone to a business works — an invitation with a single-use link,
 * minted and sent by the worker, accepted only by the person it was addressed to. Looking at a business is
 * deliberately noisy: it needs a reason, it ends by itself, and the business finds it in its own audit log.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  staff,
  staffInvitations,
  tickets,
  users,
  viewAsSessions,
  workspaces,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import type { StaffRole } from '../permissions';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  StaffAcceptInput,
  StaffAcceptOutput,
  StaffInvitationRefInput,
  StaffInvitationWriteOutput,
  StaffInviteInput,
  StaffInviteOutput,
  StaffProfileInput,
  StaffRemoveInput,
  StaffSetRoleInput,
  StaffWriteOutput,
  ViewAsEndInput,
  ViewAsEndOutput,
  ViewAsStartInput,
  ViewAsStartOutput,
} from '../schemas/support';

const onPlatform = () => ({ kind: 'platform' as const });
const STAFF_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const hashStaffToken = (token: string): Buffer =>
  createHash('sha256').update(token).digest();

// ---------- who answers ----------

export const supportStaffInvite = defineCommand({
  name: 'support.staff.invite',
  description: 'Invite someone to answer HandsFreeOS support. They get a single-use link.',
  risk: 4,
  input: StaffInviteInput,
  output: StaffInviteOutput,
  permission: 'platform.staff.manage',
  scope: onPlatform,
  emits: ['support_staff.invited'],
  async handler(ctx, input) {
    const [existing] = await ctx.tx
      .select({ userId: staff.userId })
      .from(staff)
      .innerJoin(users, eq(users.id, staff.userId))
      .where(and(eq(users.email, input.email), eq(staff.status, 'active')));
    if (existing)
      throw HfosError.conflict(
        `${input.email} already answers support. Change their role under Support people instead.`,
        'already_staff',
      );
    const [pending] = await ctx.tx
      .select({ id: staffInvitations.id })
      .from(staffInvitations)
      .where(
        and(
          eq(staffInvitations.email, input.email),
          isNull(staffInvitations.acceptedAt),
          isNull(staffInvitations.revokedAt),
        ),
      );
    if (pending)
      throw HfosError.conflict(
        `An invitation is already waiting for ${input.email}. Resend it from Waiting to accept under Support people instead.`,
        'invitation_pending',
      );
    const [inv] = await ctx.tx
      .insert(staffInvitations)
      .values({
        email: input.email,
        role: input.role,
        invitedBy: requireHuman(ctx).userId,
        expiresAt: new Date(Date.now() + STAFF_INVITATION_TTL_MS),
      })
      .returning({ id: staffInvitations.id });
    await ctx.emit({
      type: 'support_staff.invited',
      entityType: 'support_staff_invitation',
      entityId: inv!.id,
      payload: { email: input.email, role: input.role },
      after: { email: input.email, role: input.role },
    });
    return { invitationId: inv!.id };
  },
});

export const supportStaffInvitationResend = defineCommand({
  name: 'support.staff.resend_invitation',
  description: 'Send a support invitation again. The old link stops working.',
  risk: 2,
  input: StaffInvitationRefInput,
  output: StaffInvitationWriteOutput,
  permission: 'platform.staff.manage',
  scope: onPlatform,
  emits: ['support_staff.invitation_resent'],
  async handler(ctx, input) {
    const [inv] = await ctx.tx
      .update(staffInvitations)
      .set({ expiresAt: new Date(Date.now() + STAFF_INVITATION_TTL_MS), tokenHash: null })
      .where(
        and(
          eq(staffInvitations.id, input.invitationId),
          isNull(staffInvitations.acceptedAt),
          isNull(staffInvitations.revokedAt),
        ),
      )
      .returning({ id: staffInvitations.id, email: staffInvitations.email });
    if (!inv)
      throw HfosError.notFound(
        'That invitation isn’t waiting anymore. It may have been accepted or cancelled. Refresh Support people to see where it stands.',
      );
    await ctx.emit({
      type: 'support_staff.invitation_resent',
      entityType: 'support_staff_invitation',
      entityId: inv.id,
      payload: { email: inv.email },
    });
    return { invitationId: inv.id };
  },
});

export const supportStaffInvitationRevoke = defineCommand({
  name: 'support.staff.revoke_invitation',
  description: 'Cancel a support invitation so its link no longer works.',
  risk: 2,
  input: StaffInvitationRefInput,
  output: StaffInvitationWriteOutput,
  permission: 'platform.staff.manage',
  scope: onPlatform,
  emits: ['support_staff.invitation_revoked'],
  async handler(ctx, input) {
    const [inv] = await ctx.tx
      .update(staffInvitations)
      .set({ revokedAt: new Date(), revokedBy: requireHuman(ctx).userId })
      .where(
        and(
          eq(staffInvitations.id, input.invitationId),
          isNull(staffInvitations.acceptedAt),
          isNull(staffInvitations.revokedAt),
        ),
      )
      .returning({ id: staffInvitations.id, email: staffInvitations.email });
    if (!inv)
      throw HfosError.notFound(
        'That invitation isn’t waiting anymore. It may have been accepted or cancelled. Refresh Support people to see where it stands.',
      );
    await ctx.emit({
      type: 'support_staff.invitation_revoked',
      entityType: 'support_staff_invitation',
      entityId: inv.id,
      payload: { email: inv.email },
      before: { status: 'pending' },
      after: { status: 'revoked' },
    });
    return { invitationId: inv.id };
  },
});

export const supportStaffAccept = defineCommand({
  name: 'support.staff.accept',
  description: 'Accept a support invitation. Works once, for the address it was sent to.',
  risk: 1,
  input: StaffAcceptInput,
  output: StaffAcceptOutput,
  permission: null,
  // Nobody is staff yet when they run this, so it is checked by the invitation and not by a role.
  scope: () => ({ kind: 'none' }),
  emits: ['support_staff.joined'],
  async handler(ctx, input) {
    const [row] = await rows<{
      accepted: boolean;
      staff_role: StaffRole | null;
      reason: string | null;
    }>(ctx.tx, sql`select * from private.accept_staff_invitation(${hashStaffToken(input.token)})`);
    if (!row)
      throw HfosError.internal(
        'The invitation couldn’t be accepted just now. Try again in a minute, or ask a support admin for a new one.',
      );
    if (!row.accepted) return { accepted: false, role: null, reason: row.reason };
    await ctx.emit({
      type: 'support_staff.joined',
      entityType: 'support_staff',
      entityId: requireHuman(ctx).userId,
      payload: { role: row.staff_role },
      after: { role: row.staff_role },
    });
    return { accepted: true, role: row.staff_role, reason: null };
  },
});

export const supportStaffSetRole = defineCommand({
  name: 'support.staff.set_role',
  description: 'Change what someone may do in support, or suspend them.',
  risk: 4,
  input: StaffSetRoleInput,
  output: StaffWriteOutput,
  permission: 'platform.staff.manage',
  scope: onPlatform,
  emits: ['support_staff.role_changed'],
  async handler(ctx, input) {
    if (!input.role && !input.status)
      throw HfosError.validation([{ path: 'role', message: 'Say what to change.' }]);
    const [before] = await ctx.tx
      .select({ role: staff.role, status: staff.status })
      .from(staff)
      .where(eq(staff.userId, input.userId));
    if (!before)
      throw HfosError.notFound(
        'That person doesn’t answer support anymore. They may have been removed. Refresh Support people and try again.',
      );
    const [updated] = await ctx.tx
      .update(staff)
      .set({
        ...(input.role ? { role: input.role } : {}),
        ...(input.status ? { status: input.status } : {}),
      })
      .where(eq(staff.userId, input.userId))
      .returning({ userId: staff.userId, role: staff.role, status: staff.status });
    if (!updated)
      throw HfosError.notFound(
        'That person doesn’t answer support anymore. They may have been removed. Refresh Support people and try again.',
      );
    await ctx.emit({
      type: 'support_staff.role_changed',
      entityType: 'support_staff',
      entityId: updated.userId,
      payload: { role: updated.role, status: updated.status },
      before,
      after: { role: updated.role, status: updated.status },
    });
    return { userId: updated.userId };
  },
});

export const supportStaffRemove = defineCommand({
  name: 'support.staff.remove',
  description: 'Take away someone’s support access. Their name stays on the tickets they answered.',
  risk: 4,
  input: StaffRemoveInput,
  output: StaffWriteOutput,
  permission: 'platform.staff.manage',
  scope: onPlatform,
  emits: ['support_staff.removed'],
  async handler(ctx, input) {
    const [gone] = await ctx.tx
      .delete(staff)
      .where(eq(staff.userId, input.userId))
      .returning({ userId: staff.userId, role: staff.role });
    if (!gone)
      throw HfosError.notFound(
        'That person doesn’t answer support anymore. They may have been removed. Refresh Support people and try again.',
      );
    // Their open tickets go back to the queue rather than sitting with someone who has left.
    await ctx.tx
      .update(tickets)
      .set({ assigneeUserId: null })
      .where(eq(tickets.assigneeUserId, input.userId));
    await ctx.emit({
      type: 'support_staff.removed',
      entityType: 'support_staff',
      entityId: gone.userId,
      payload: { role: gone.role },
      before: { role: gone.role },
    });
    return { userId: gone.userId };
  },
});

export const supportStaffSaveProfile = defineCommand({
  name: 'support.staff.save_profile',
  description: 'Set the name customers see on your replies, and your sign-off.',
  risk: 1,
  input: StaffProfileInput,
  output: StaffWriteOutput,
  permission: 'support.read',
  scope: onPlatform,
  emits: ['support_staff.profile_saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [updated] = await ctx.tx
      .update(staff)
      .set({ displayName: input.displayName, signature: input.signature })
      .where(eq(staff.userId, me))
      .returning({ userId: staff.userId });
    if (!updated)
      throw HfosError.notFound(
        'You don’t answer support anymore, so there’s no sign-off to save. Ask whoever runs support at HandsFreeOS if that’s wrong.',
      );
    await ctx.emit({
      type: 'support_staff.profile_saved',
      entityType: 'support_staff',
      entityId: me,
      payload: { displayName: input.displayName },
    });
    return { userId: me };
  },
});

// ---------- looking at a business ----------

export const platformViewAsStart = defineCommand({
  name: 'platform.view_as.start',
  description:
    'Open a business read-only to see what the customer sees. Time limited, and written into their own audit log.',
  risk: 3,
  input: ViewAsStartInput,
  output: ViewAsStartOutput,
  permission: 'platform.view_as',
  scope: onPlatform,
  emits: ['platform.view_as_started'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [ws] = await ctx.tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        organizationId: workspaces.organizationId,
      })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId));
    if (!ws)
      throw HfosError.notFound(
        'That business isn’t there anymore. It may have been deleted. Refresh Businesses and pick it again.',
      );
    // One at a time: a look that was left open is closed by opening the next one.
    await ctx.tx
      .update(viewAsSessions)
      .set({ endedAt: new Date() })
      .where(and(eq(viewAsSessions.staffUserId, me), isNull(viewAsSessions.endedAt)));
    const expiresAt = new Date(Date.now() + input.minutes * 60_000);
    const [session] = await ctx.tx
      .insert(viewAsSessions)
      .values({
        staffUserId: me,
        workspaceId: ws.id,
        organizationId: ws.organizationId,
        ticketId: input.ticketId ?? null,
        reason: input.reason,
        expiresAt,
      })
      .returning({ id: viewAsSessions.id, startedAt: viewAsSessions.startedAt });
    await ctx.emit({
      type: 'platform.view_as_started',
      entityType: 'view_as_session',
      entityId: session!.id,
      payload: {
        workspaceId: ws.id,
        organizationId: ws.organizationId,
        reason: input.reason,
        expiresAt: expiresAt.toISOString(),
        ticketId: input.ticketId ?? null,
      },
    });
    return {
      session: {
        id: session!.id,
        workspaceId: ws.id,
        businessName: ws.name,
        reason: input.reason,
        startedAt: session!.startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    };
  },
});

export const platformViewAsEnd = defineCommand({
  name: 'platform.view_as.end',
  description: 'Stop looking at a business.',
  risk: 1,
  input: ViewAsEndInput,
  output: ViewAsEndOutput,
  permission: 'platform.view_as',
  scope: onPlatform,
  emits: ['platform.view_as_ended'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [open] = await ctx.tx
      .select({ id: viewAsSessions.id, workspaceId: viewAsSessions.workspaceId })
      .from(viewAsSessions)
      .where(
        and(
          eq(viewAsSessions.staffUserId, me),
          isNull(viewAsSessions.endedAt),
          ...(input.sessionId ? [eq(viewAsSessions.id, input.sessionId)] : []),
        ),
      )
      .orderBy(desc(viewAsSessions.startedAt))
      .limit(1);
    if (!open) return { ended: false };
    await ctx.tx
      .update(viewAsSessions)
      .set({ endedAt: new Date() })
      .where(eq(viewAsSessions.id, open.id));
    await ctx.emit({
      type: 'platform.view_as_ended',
      entityType: 'view_as_session',
      entityId: open.id,
      payload: { workspaceId: open.workspaceId },
    });
    return { ended: true };
  },
});

export const supportStaffCommands = [
  supportStaffInvite,
  supportStaffInvitationResend,
  supportStaffInvitationRevoke,
  supportStaffAccept,
  supportStaffSetRole,
  supportStaffRemove,
  supportStaffSaveProfile,
  platformViewAsStart,
  platformViewAsEnd,
];
