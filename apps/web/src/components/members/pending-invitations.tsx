'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, RoleBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PendingInvitation } from '@/lib/api/types';
import { relativeTime } from '@/lib/utils';

export function PendingInvitations({
  workspaceId,
  invitations,
  canResend = true,
  canRevoke = true,
}: {
  workspaceId: string;
  invitations: PendingInvitation[];
  /** Sending a fresh link is inviting (members.invite); cancelling is its own permission (0105). */
  canResend?: boolean;
  canRevoke?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(inv: PendingInvitation, kind: 'resend' | 'revoke') {
    setBusy(inv.id);
    try {
      if (kind === 'resend') {
        unwrap(
          await apiBrowser().POST('/v1/commands/invitation.resend', {
            body: { workspaceId, invitationId: inv.id },
          }),
        );
        toast.success(`Invitation re-sent to ${inv.email}. The old link no longer works.`);
      } else {
        unwrap(
          await apiBrowser().POST('/v1/commands/invitation.revoke', {
            body: { workspaceId, invitationId: inv.id },
          }),
        );
        toast.success(`Invitation for ${inv.email} revoked.`);
      }
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="mb-3 mt-8 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Pending invitations</h2>
        <span className="text-[13px] text-text-3">Links expire 7 days after they are sent</span>
      </div>
      <Card className="overflow-x-auto p-0" data-testid="pending-invitations">
        {invitations.length === 0 ? (
          <div className="px-7 py-7 text-center text-[13px] text-text-2">
            No pending invitations.
          </div>
        ) : (
          <table className="w-full min-w-[720px] border-separate border-spacing-0">
            <thead>
              <tr className="whitespace-nowrap text-left text-xs font-medium tracking-wide text-text-3">
                <th className="rounded-tl-card border-b border-border bg-card-2 px-4 py-2.5">
                  Email
                </th>
                <th className="border-b border-border bg-card-2 px-4 py-2.5">Role</th>
                <th className="border-b border-border bg-card-2 px-4 py-2.5">Invited by</th>
                <th className="border-b border-border bg-card-2 px-4 py-2.5">Sent</th>
                <th className="w-[200px] rounded-tr-card border-b border-border bg-card-2 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id} data-testid={`invite-row-${inv.email}`}>
                  <td className="border-b border-border px-4 py-3">
                    <span className="flex items-center gap-2.5">
                      <Badge variant="pending">Pending</Badge>
                      <span className="font-medium">{inv.email}</span>
                    </span>
                  </td>
                  <td className="border-b border-border px-4 py-3">
                    <RoleBadge role={inv.role} />
                  </td>
                  <td className="border-b border-border px-4 py-3 text-[13px] text-text-2">
                    {inv.invitedBy?.fullName || '—'}
                  </td>
                  <td className="border-b border-border px-4 py-3 text-[13px] text-text-2">
                    {inv.sentAt
                      ? `${relativeTime(inv.sentAt)} · expires ${new Date(inv.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                      : 'Sending…'}
                  </td>
                  <td className="border-b border-border px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      {canResend ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy === inv.id}
                          onClick={() => void act(inv, 'resend')}
                        >
                          Resend
                        </Button>
                      ) : null}
                      {canRevoke ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger-text"
                          disabled={busy === inv.id}
                          onClick={() => void act(inv, 'revoke')}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
