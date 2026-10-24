'use client';
import { FunnelSuggestions } from '@/components/funnels/suggestions';
import { ApprovalsBoard } from '@/components/workflows/approvals/approvals-board';
import type { TeammateDraft } from '@/lib/ai-team/inbox-types';
import type { TeammateGet } from '@/lib/ai-team/types';
import type { FunnelPersonOut } from '@/lib/funnels/actions';
import { TeammateTabShell } from './tab-shell';

/** The Approvals tab: the teammate's header and History, its funnel suggestions, then its drafts waiting for a yes. */
export function TeammateApprovalsTab({
  workspaceId,
  data,
  drafts,
  decidedDrafts,
  suggestions,
  serverNow,
}: {
  workspaceId: string;
  data: TeammateGet;
  /** Its drafts waiting for someone, newest first. */
  drafts: TeammateDraft[];
  /** Its drafts decided, expired or dropped lately. */
  decidedDrafts: TeammateDraft[];
  /** Its suggestions of a funnel for someone, waiting for a yes or no (teammate funnels). */
  suggestions: readonly FunnelPersonOut[];
  /** When the server rendered the page. */
  serverNow: number;
}) {
  return (
    <TeammateTabShell
      workspaceId={workspaceId}
      data={data}
      emptyBody="Its drafts wait here for a yes once it’s working."
      testId="teammate-approvals-tab"
    >
      {data.teammate ? (
        <>
          <FunnelSuggestions
            workspaceId={workspaceId}
            teammateName={data.teammate.name}
            suggestions={suggestions}
            timeZone={data.catalogs.timeZone}
          />
          <ApprovalsBoard
            workspaceId={workspaceId}
            waiting={[]}
            decided={[]}
            allowPrices={null}
            serverNow={serverNow}
            drafts={drafts}
            decidedDrafts={decidedDrafts}
            teammateName={data.teammate.name}
            progress={data.progress}
            timezone={data.catalogs.timeZone}
            teammateOnly
          />
        </>
      ) : null}
    </TeammateTabShell>
  );
}
