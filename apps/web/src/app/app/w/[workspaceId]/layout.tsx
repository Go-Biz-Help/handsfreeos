import { hasWorkspacePermission } from '@hfos/core';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AssistantPanel } from '@/components/assistant/assistant-panel';
import { AssistantProvider } from '@/components/assistant/assistant-provider';
import { CallOverlays } from '@/components/calls/call-overlays';
import { MobileShell } from '@/components/shell/mobile-shell';
import { Sidebar } from '@/components/shell/sidebar';
import { ThemeSync } from '@/components/shell/theme-sync';
import { WorkspaceMain } from '@/components/shell/workspace-main';
import { ApiError, apiServer, fetchMe, unwrap } from '@/lib/api/server';
import { CallProvider } from '@/lib/calls/call-provider';
import { AttentionSummaryProvider } from '@/lib/realtime/attention-summary';
import { LiveProvider } from '@/lib/realtime/live-provider';
import { UnreadProvider } from '@/lib/realtime/unread-provider';
import { parseTheme } from '@/lib/theme';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const me = await fetchMe(api);
  const current = me.workspaces.find((w) => w.id === workspaceId);
  if (!current) {
    // Not one of ours (including users with no workspaces at all, e.g. after being removed):
    // behave like the API (404), never confirm it exists. /app sends workspace-less users to onboarding.
    try {
      unwrap(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }
    notFound();
  }
  return (
    <LiveProvider workspaceId={workspaceId}>
      <UnreadProvider workspaceId={workspaceId}>
        {/* The urgent count on Home, in the sidebar and the phone's bottom bar. */}
        <AttentionSummaryProvider workspaceId={workspaceId}>
          <CallProvider workspaceId={workspaceId} workspaceName={current.name}>
            {/* Inside LiveProvider: pages refresh when the Assistant changes something. */}
            <AssistantProvider
              key={workspaceId}
              workspaceId={workspaceId}
              workspaceName={current.name}
              enabled={hasWorkspacePermission(current.role, 'assistant.use')}
            >
              <div className="flex min-h-screen bg-bg">
                <ThemeSync theme={parseTheme((me.user.settings as { theme?: unknown }).theme)} />
                <Sidebar me={me} current={current} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <MobileShell me={me} current={current} />
                  <WorkspaceMain workspaceId={workspaceId}>{children}</WorkspaceMain>
                </div>
                <AssistantPanel />
              </div>
              <CallOverlays />
            </AssistantProvider>
          </CallProvider>
        </AttentionSummaryProvider>
      </UnreadProvider>
    </LiveProvider>
  );
}
