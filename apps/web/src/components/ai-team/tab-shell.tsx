'use client';
import {
  PHONE_VOICE_PICK_WORDS,
  phoneVoiceInfo,
  withPhoneVoice,
  type PhoneVoice,
  type TeammateConfig,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { teammateActions } from '@/lib/ai-team/actions';
import { progressView, savedLine } from '@/lib/ai-team/describe';
import type { TeammateGet } from '@/lib/ai-team/types';
import { errorMessage } from '@/lib/api/client';
import { TeammateHeader, TeammateSubnav } from './header';
import { TeammateHistory } from './history';
import { TestConsole } from './test-console';
import { AiTeamIntro } from './teammate-tab';

/**
 * A tab after Teammate (Activity, Approvals): the teammate's header, History and test console, the subnav,
 * then the tab's own content. Before there's a teammate it points to setting one up.
 */
export function TeammateTabShell({
  workspaceId,
  data,
  emptyBody,
  testId,
  children,
}: {
  workspaceId: string;
  data: TeammateGet;
  /** What the tab shows once the teammate is working. */
  emptyBody: string;
  testId: string;
  children: ReactNode;
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
            {emptyBody}
          </EmptyState>
        </Card>
      </>
    );

  const tz = data.catalogs.timeZone;
  const progress = data.progress
    ? progressView(data.progress, data.progress.approvalsNeeded)
    : null;

  /** Use this voice, from the test console: saved as a new revision straight away. */
  async function keepVoice(voice: PhoneVoice) {
    if (!t) return;
    try {
      await actions.saveConfig({
        teammateId: t.id,
        baseRevision: t.revision,
        config: withPhoneVoice(t.config, voice) as TeammateConfig,
      });
      toast.success(PHONE_VOICE_PICK_WORDS.saved(phoneVoiceInfo(voice).name));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

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
    <div data-testid={testId} className="pb-6">
      <TeammateHeader
        name={t.name}
        status={t.status}
        saved={savedLine(t.revision, data.revisions[0], tz)}
        onTest={data.canManage ? () => setTestOpen(true) : undefined}
        onHistory={() => setHistoryOpen(true)}
      />
      <TeammateSubnav workspaceId={workspaceId} />
      {children}
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
          savedConfig={t.config}
          unsaved={false}
          onUseVoice={keepVoice}
        />
      ) : null}
    </div>
  );
}
