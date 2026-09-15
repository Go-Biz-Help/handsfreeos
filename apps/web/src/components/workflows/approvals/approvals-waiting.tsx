import { Sparkles, Workflow } from 'lucide-react';
import Link from 'next/link';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { AI_SOFT, AI_TEXT } from '@/components/workflows/chips';
import type { TeammateDraft, TeammateGetOut } from '@/lib/ai-team/inbox-types';
import { draftShort, progressShort } from '@/lib/ai-team/inbox-words';
import { apiServer } from '@/lib/api/server';
import { minutesSince, waitingFor } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Approval } from './types';
import { approvalKind, customerOf, previewOf } from './words';

/**
 * Home's approvals card, loading its own lists (a server component): workflow approvals and the AI teammate's
 * drafts the viewer can decide. Home still loads when they can't be read: the card is left out.
 */
export async function HomeApprovals({ workspaceId }: { workspaceId: string }) {
  const { api } = await apiServer();
  const [flows, drafts, teammate] = await Promise.all([
    api
      .POST('/v1/queries/workflow.approval_list', { body: { workspaceId, limit: 100 } })
      .then((r) => (r.data?.items ?? []).filter((a) => a.canDecide))
      .catch((): Approval[] => []),
    api
      .POST('/v1/queries/ai_teammate.draft_list', {
        body: { workspaceId, status: 'pending', limit: 100 },
      })
      .then((r) => (r.data?.items ?? []).filter((d) => d.canDecide))
      .catch((): TeammateDraft[] => []),
    api
      .POST('/v1/queries/ai_teammate.get', { body: { workspaceId } })
      .then((r) => r.data ?? null)
      .catch(() => null),
  ]);
  return (
    <ApprovalsWaiting
      workspaceId={workspaceId}
      items={flows}
      drafts={drafts}
      progress={teammate?.teammate ? teammate.progress : null}
      teammateName={teammate?.teammate?.name ?? null}
      now={Date.now()}
    />
  );
}

const TAG =
  'inline-flex h-5 flex-none items-center gap-1 whitespace-nowrap rounded-[6px] px-[7px] text-[11.5px]';

/**
 * Home's "Waiting on you": the workflow approvals and AI teammate drafts the viewer can decide (owners and
 * admins see every workflow approval, named approvers theirs), newest first with how long each has waited,
 * and a link to the Approvals page. Renders nothing when none wait.
 */
export function ApprovalsWaiting({
  workspaceId,
  items,
  drafts = [],
  progress = null,
  teammateName = null,
  now,
  className,
}: {
  workspaceId: string;
  /** Pending workflow approvals the viewer can decide. */
  items: Approval[];
  /** The AI teammate's drafts the viewer can decide. */
  drafts?: TeammateDraft[];
  progress?: TeammateGetOut['progress'];
  teammateName?: string | null;
  now: number;
  className?: string;
}) {
  const total = items.length + drafts.length;
  if (!total) return null;
  const href = `/app/w/${workspaceId}/workflows/approvals`;
  const rows = [
    ...items.map((a) => ({ kind: 'workflow' as const, at: a.createdAt, a })),
    ...drafts.map((d) => ({ kind: 'ai' as const, at: d.createdAt, d })),
  ]
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
    .slice(0, 5);
  const name = teammateName ?? drafts[0]?.teammate.name ?? null;
  const count = drafts.length
    ? `${total} waiting`
    : total === 1
      ? '1 approval waiting'
      : `${total} approvals waiting`;
  const training = progress?.status === 'training' ? progressShort(progress) : null;
  return (
    <Card className={cn('mb-5 overflow-hidden', className)} data-testid="home-approvals">
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5 pt-3.5 md:px-5">
        <h2 className="text-[15px] font-semibold">Waiting on you</h2>
        <Badge variant="pending" data-testid="home-approvals-count">
          {count}
        </Badge>
        {drafts.length && items.length ? (
          <span className="ml-auto text-xs text-text-3">
            {drafts.length} of {name}’s {drafts.length === 1 ? 'draft' : 'drafts'} ·{' '}
            {items.length === 1 ? '1 workflow approval' : `${items.length} workflow approvals`}
          </span>
        ) : null}
      </div>
      <ul>
        {rows.map((row) => {
          if (row.kind === 'ai') {
            const d = row.d;
            const who = d.person?.fullName ?? 'A customer';
            return (
              <li key={d.id} className="border-t border-border">
                <Link
                  href={`${href}?filter=ai`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-card-2 md:px-5"
                  data-testid="home-draft-row"
                >
                  <Avatar name={who} seed={d.person?.id ?? d.id} size="sm" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-semibold">{who}</span>
                    <span className="truncate text-xs text-text-3">{draftShort(d)}</span>
                  </span>
                  <span className={cn(TAG, 'font-semibold', AI_SOFT, AI_TEXT)}>
                    <Sparkles className="h-3 w-3" strokeWidth={1.75} />
                    {d.teammate.name}
                  </span>
                  <span className="flex-none text-xs text-text-3">
                    {waitingFor(minutesSince(d.createdAt, now), { short: true })}
                  </span>
                </Link>
              </li>
            );
          }
          const a = row.a;
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
                {drafts.length ? (
                  <span className={cn(TAG, 'bg-card-2 font-medium text-text-2')}>
                    <Workflow className="h-3 w-3" strokeWidth={1.75} />
                    Workflow
                  </span>
                ) : null}
                <span className="flex-none text-xs text-text-3">
                  {waitingFor(minutesSince(a.createdAt, now), { short: true })}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 md:px-5">
        <Link
          href={href}
          className="text-[13px] font-medium text-accent-text hover:underline"
          data-testid="home-approvals-open"
        >
          {total > rows.length ? `Open Approvals (${total})` : 'Open Approvals'}
        </Link>
        {name && training ? (
          <span className="text-xs text-text-3" data-testid="home-approvals-progress">
            {name}: {training}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
