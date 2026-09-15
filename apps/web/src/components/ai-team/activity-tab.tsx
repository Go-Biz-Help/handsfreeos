'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { teammateActions } from '@/lib/ai-team/actions';
import { progressView, savedLine } from '@/lib/ai-team/describe';
import type { TeammateActivity, TeammateGet } from '@/lib/ai-team/types';
import { errorMessage } from '@/lib/api/client';
import { TeammateActivityView } from './activity';
import { TeammateHeader, TeammateSubnav } from './header';
import { TeammateHistory } from './history';
import { TestConsole } from './test-console';
import { AiTeamIntro } from './teammate-tab';

const NO_ACTIVITY: TeammateActivity = {
  counters: {
    runsToday: 0,
    repliedToday: 0,
    draftedToday: 0,
    handedOffToday: 0,
    failedToday: 0,
    pendingDrafts: 0,
    needsPerson: 0,
    handledByAi: 0,
  },
  runs: [],
  nextCursor: null,
};

/** The Activity tab: the teammate's header and History, then its runs. */
export function TeammateActivityTab({
  workspaceId,
  data,
  activity,
}: {
  workspaceId: string;
  data: TeammateGet;
  activity: TeammateActivity | null;
}) {
  const router = useRouter();
  const actions = useMemo(() => teammateActions(workspaceId), [workspaceId]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const t = data.teammate;
  if (!t)
    return (
      <>
        <AiTeamIntro />
        <Card>
          <EmptyState
            title="Set up your AI teammate first"
            actions={
              <ButtonLink variant="primary" href={`/app/w/${workspaceId}/ai-team`}>
                {data.canManage ? 'Set it up' : 'See the AI teammate'}
              </ButtonLink>
            }
          >
            Its replies, hand-offs and bookings show here once it’s working.
          </EmptyState>
        </Card>
      </>
    );

  const tz = data.catalogs.timeZone;
  const progress = data.progress
    ? progressView(data.progress, data.progress.approvalsNeeded)
    : null;

  async function restore(revision: number) {
    if (!t) return;
    setRestoring(revision);
    try {
      const out = await actions.restore({ teammateId: t.id, revision, baseRevision: t.revision });
      setHistoryOpen(false);
      toast.success(
        `Restored revision ${revision} as revision ${out.revision}. Training progress stays the same.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div data-testid="teammate-activity-tab" className="pb-6">
      <TeammateHeader
        name={t.name}
        status={t.status}
        saved={savedLine(t.revision, data.revisions[0], tz)}
        onTest={data.canManage ? () => setTestOpen(true) : undefined}
        onHistory={() => setHistoryOpen(true)}
      />
      <TeammateSubnav workspaceId={workspaceId} />
      <TeammateActivityView
        workspaceId={workspaceId}
        name={t.name}
        timeZone={tz}
        initial={activity ?? NO_ACTIVITY}
      />
      <TeammateHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        name={t.name}
        revisions={data.revisions}
        currentRevision={t.revision}
        timeZone={tz}
        restoring={restoring}
        onRestore={(r) => void restore(r)}
        canRestore={data.canManage}
        progress={progress}
        status={t.status}
        trainingStartedAt={t.trainingStartedAt}
      />
      {data.canManage ? (
        <TestConsole
          open={testOpen}
          onOpenChange={setTestOpen}
          workspaceId={workspaceId}
          name={t.name}
          timeZone={tz}
          config={null}
          unsaved={false}
        />
      ) : null}
    </div>
  );
}
