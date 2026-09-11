import { rows, sql } from '@hfos/db/client';
import { hashInvitationToken } from '../commands/invitation.accept';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { InvitationPreviewInput, InvitationPreviewOutput } from '../schemas/invitation';

export const invitationPreview = defineQuery({
  name: 'invitation.preview',
  description:
    'What an invitation link is for, before accepting it. Never reveals the full invitee address.',
  input: InvitationPreviewInput,
  output: InvitationPreviewOutput,
  permission: null,
  scope: () => ({ kind: 'none' }),
  async handler(ctx, input) {
    const [row] = await rows<{
      status: 'pending' | 'used' | 'revoked' | 'expired';
      workspace_name: string;
      organization_name: string;
      inv_role: 'owner' | 'admin' | 'member';
      inviter_name: string | null;
      invitee_email_masked: string;
      expires_at: Date;
      email_matches: boolean;
    }>(ctx.tx, sql`select * from private.invitation_preview(${hashInvitationToken(input.token)})`);
    if (!row) throw HfosError.notFound('Invitation not found.');
    return {
      status: row.status,
      workspaceName: row.workspace_name,
      organizationName: row.organization_name,
      role: row.inv_role,
      inviterName: row.inviter_name,
      inviteeEmailMasked: row.invitee_email_masked,
      expiresAt: new Date(row.expires_at).toISOString(),
      emailMatches: row.email_matches,
    };
  },
});
