import Link from 'next/link';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { apiServer } from '@/lib/api/server';
import type { Approval } from './types';
import { approvalKind, customerOf, previewOf, waitedFor } from './words';

/**
 * Home's approvals card, loading its own list (a server component). Home still loads when the list can't
 * be read: the card is left out.
 */
export async function HomeApprovals({ workspaceId }: { workspaceId: string }) {
  const { api } = await apiServer();
  const result = await api
    .POST('/v1/queries/workflow.approval_list', { body: { workspaceId, limit: 100 } })
    .catch(() => null);
  const items = (result?.data?.items ?? []).filter((a) => a.canDecide);
  return <ApprovalsWaiting workspaceId={workspaceId} items={items} now={Date.now()} />;
}

/**
 * Home's "Waiting on you": the approvals the viewer can decide (owners and admins see every one, named
 * approvers theirs), the oldest waiting longest shown with how long, and a link to the Approvals page.
 * Renders nothing when none wait.
 */
export function ApprovalsWaiting({
  workspaceId,
  items,
  now,
}: {
  workspaceId: string;
  /** Pending approvals the viewer can decide. */
  items: Approval[];
  now: number;
}) {
  if (!items.length) return null;
  const href = `/app/w/${workspaceId}/workflows/approvals`;
  const shown = items.slice(0, 5);
  return (
    <Card className="mb-5 overflow-hidden" data-testid="home-approvals">
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5 pt-3.5 md:px-5">
        <h2 className="text-[15px] font-semibold">Waiting on you</h2>
        <Badge variant="pending" data-testid="home-approvals-count">
          {items.length === 1 ? '1 approval waiting' : `${items.length} approvals waiting`}
        </Badge>
      </div>
      <ul>
        {shown.map((a) => {
          const p = previewOf(a);
          const who = customerOf(a, p);
          return (
            <li key={a.id} className="border-t border-border">
              <Link
                href={href}
                className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-card-2 md:px-5"
              >
                <Avatar name={who} seed={a.person?.id ?? a.id} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-semibold">{who}</span>
                  <span className="truncate text-xs text-text-3">
                    {a.workflow.name} · {approvalKind(p)}
                  </span>
                </span>
                <span className="flex-none text-xs text-text-3">{waitedFor(a.createdAt, now)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-border px-4 py-3 md:px-5">
        <Link
          href={href}
          className="text-[13px] font-medium text-accent-text hover:underline"
          data-testid="home-approvals-open"
        >
          {items.length > shown.length ? `Open Approvals (${items.length})` : 'Open Approvals'}
        </Link>
      </div>
    </Card>
  );
}
