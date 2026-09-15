import { ApprovalsWaiting } from '@/components/workflows/approvals/approvals-waiting';
import type { Approval } from '@/components/workflows/approvals/types';
import type { TeammateDraft } from '@/lib/ai-team/inbox-types';
import type { ConversationSummary } from '@/lib/api/types';
import { apiServer } from '@/lib/api/server';
import { cn } from '@/lib/utils';
import { NeedsPersonCard } from './needs-person';

/**
 * The top of Home: "Needs a person" (conversations the AI teammate handed over) beside "Waiting on you"
 * (workflow approvals and the teammate's drafts). A server component loading its own lists; Home still loads
 * when one can't be read, and the card is left out.
 */
export async function HomeWaiting({
  workspaceId,
  myUserId,
  timeZone,
}: {
  workspaceId: string;
  myUserId: string;
  timeZone: string;
}) {
  const { api } = await apiServer();
  const [flows, drafts, teammate, needs, summary] = await Promise.all([
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
    api
      .POST('/v1/queries/inbox.list', {
        body: { workspaceId, box: 'needs_person', status: 'open', limit: 5 },
      })
      .then((r) => r.data?.items ?? [])
      .catch((): ConversationSummary[] => []),
    api
      .POST('/v1/queries/inbox.summary', { body: { workspaceId } })
      .then((r) => r.data ?? null)
      .catch(() => null),
  ]);
  const name = teammate?.teammate?.name ?? null;
  const both = needs.length > 0 && flows.length + drafts.length > 0;
  return (
    <div className={cn(both && 'mb-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-2')}>
      <NeedsPersonCard
        workspaceId={workspaceId}
        items={needs}
        count={summary?.needsPerson ?? needs.length}
        myUserId={myUserId}
        timeZone={timeZone}
        teammateName={name}
        className={both ? 'mb-0' : undefined}
      />
      <ApprovalsWaiting
        workspaceId={workspaceId}
        items={flows}
        drafts={drafts}
        progress={teammate?.teammate ? teammate.progress : null}
        teammateName={name}
        now={Date.now()}
        className={both ? 'mb-0' : undefined}
      />
    </div>
  );
}
