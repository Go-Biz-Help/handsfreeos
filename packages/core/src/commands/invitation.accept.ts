import { createHash } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { InvitationAcceptInput, InvitationAcceptOutput } from '../schemas/invitation';
import { requireHuman } from '../kernel/actor';
import { handOverFor, onboardingSetupOf } from '../onboarding-setup/answers';

export const hashInvitationToken = (token: string): Buffer =>
  createHash('sha256').update(token).digest();

export const invitationAccept = defineCommand({
  name: 'invitation.accept',
  description: 'Accept an invitation link. Works once, for the email it was sent to.',
  risk: 1,
  input: InvitationAcceptInput,
  output: InvitationAcceptOutput,
  permission: null,
  scope: () => ({ kind: 'none' }),
  emits: ['invitation.accepted', 'membership.created'],
  async handler(ctx, input) {
    const [row] = await rows<{
      inv_id: string;
      org_id: string;
      ws_id: string;
      inv_role: 'owner' | 'admin' | 'member';
      inv_email: string;
    }>(ctx.tx, sql`select * from private.accept_invitation(${hashInvitationToken(input.token)})`);
    if (!row)
      throw HfosError.internal(
        'We couldn’t accept this invitation just now. Open the link again in a minute.',
      );
    const ids = { organizationId: row.org_id, workspaceId: row.ws_id };
    await ctx.emit({
      type: 'invitation.accepted',
      entityType: 'invitation',
      entityId: row.inv_id,
      ...ids,
      payload: { email: row.inv_email, role: row.inv_role },
      before: { status: 'pending', email: row.inv_email },
      after: { status: 'accepted', email: row.inv_email, role: row.inv_role },
    });
    await ctx.emit({
      type: 'membership.created',
      entityType: 'workspace_membership',
      entityId: requireHuman(ctx).userId,
      ...ids,
      payload: { userId: requireHuman(ctx).userId, role: row.inv_role, via: 'invitation' },
      after: { role: row.inv_role },
    });
    // The business's agency set it up and handed it to this person to check and finish (the owner's 53A).
    const [ws] = await rows<{ settings: unknown }>(
      ctx.tx,
      sql`select settings from app.workspaces where id = ${row.ws_id}`,
    );
    const setup = !!handOverFor(onboardingSetupOf(ws?.settings as Record<string, unknown> | null), {
      email: row.inv_email,
      role: row.inv_role,
    });
    return {
      invitationId: row.inv_id,
      organizationId: row.org_id,
      workspaceId: row.ws_id,
      role: row.inv_role,
      setup,
    };
  },
});
