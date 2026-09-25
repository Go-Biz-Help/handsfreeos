'use client';
import { ApprovalsBoard } from '@/components/workflows/approvals/approvals-board';
import type { TeammateDraft } from '@/lib/ai-team/inbox-types';
import type { TeammateGet } from '@/lib/ai-team/types';
import { TeammateTabShell } from './tab-shell';

/** The Approvals tab: the teammate's header and History, then its drafts waiting for a yes. */
export function TeammateApprovalsTab({
  workspaceId,
  data,
  drafts,
  decidedDrafts,
  serverNow,
}: {
  workspaceId: string;
  data: TeammateGet;
  /** Its drafts waiting for someone, newest first. */
  drafts: TeammateDraft[];
  /** Its drafts decided, expired or dropped lately. */
  decidedDrafts: TeammateDraft[];
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
      ) : null}
    </TeammateTabShell>
  );
}
