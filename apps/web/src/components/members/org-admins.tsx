'use client';
import { UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Members } from '@/lib/api/types';

/**
 * Who reaches this business through the organization rather than by being on it.
 *
 * Somebody here who set the business up for a client, and has since taken it on, has no other way onto
 * it: an invitation has to come from a member, and a business set up that way has none. So their own row
 * offers it. Leaving again is the Members table's own "Leave workspace".
 */
export function OrgAdmins({
  workspaceId,
  people,
  organizationName,
  myUserId,
  canJoin,
}: {
  workspaceId: string;
  people: Members['organizationAdmins'];
  organizationName: string;
  myUserId: string;
  /** False once they are on it, so the row stops offering what has already happened. */
  canJoin: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function join() {
    setBusy(true);
    try {
      unwrap(await apiBrowser().POST('/v1/commands/workspace.join', { body: { workspaceId } }));
      toast.success('You’re on this business now.');
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-3 mt-8 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">
          Also has access via {organizationName}
        </h2>
        <span className="text-[13px] text-text-3">Managed in the organization, not here</span>
      </div>
      <Card className="divide-y divide-border p-0">
        {people.map((p) => (
          <div key={p.userId} className="flex items-center gap-3 px-4 py-3">
            <Avatar name={p.fullName || p.email} seed={p.userId} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{p.fullName || p.email}</span>
              <span className="text-[13px] text-text-3">{p.email}</span>
            </span>
            {p.userId === myUserId && canJoin ? (
              <Button variant="secondary" size="sm" onClick={join} loading={busy}>
                <UserPlus className="h-4 w-4" strokeWidth={1.5} />
                Put me on this business
              </Button>
            ) : null}
            <Badge variant={p.orgRole === 'owner' ? 'owner' : 'admin'}>
              Organization {p.orgRole === 'owner' ? 'Owner' : 'Admin'}
            </Badge>
          </div>
        ))}
      </Card>
    </>
  );
}
