import { can, effectivePermissions } from '@hfos/core';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ViewAsBanner } from '@/components/admin/view-as-banner';
import { AssistantPanel } from '@/components/assistant/assistant-panel';
import { AssistantProvider } from '@/components/assistant/assistant-provider';
import { CallOverlays } from '@/components/calls/call-overlays';
import { MenuEditor } from '@/components/shell/menu-editor';
import { MenuProvider } from '@/components/shell/menu-provider';
import { MobileShell } from '@/components/shell/mobile-shell';
import { Sidebar } from '@/components/shell/sidebar';
import { ThemeSync } from '@/components/shell/theme-sync';
import { WorkspaceMain } from '@/components/shell/workspace-main';
import { ApiError, apiServer, getMe, unwrap } from '@/lib/api/server';
import { CallProvider } from '@/lib/calls/call-provider';
import { AttentionSummaryProvider } from '@/lib/realtime/attention-summary';
import { LiveProvider } from '@/lib/realtime/live-provider';
import { UnreadProvider } from '@/lib/realtime/unread-provider';
import type { WorkspaceGet } from '@/lib/api/types';
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
  const me = await getMe();
  let current = me.workspaces.find((w) => w.id === workspaceId);
  /**
   * A HandsFreeOS support person looking at this business (M13). They are not a member and never become
   * one: the API serves their look-ups read-only under an open session, and refuses every command. The
   * banner says so, and the business has the same fact in its own audit log.
   */
  let viewingAs: { businessName: string; expiresAt: string } | null = null;
  if (!current) {
    // Not one of ours (including users with no workspaces at all, e.g. after being removed):
    // behave like the API (404), never confirm it exists. /app sends workspace-less users to onboarding.
    let workspace: WorkspaceGet | null = null;
    try {
      workspace = unwrap(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }
    const looking = unwrap(
      await api.POST('/v1/queries/platform.view_as.current', { body: {} }),
    ).session;
    if (!looking || looking.workspaceId !== workspaceId) notFound();
    const w = workspace!.workspace;
    // They see every place the business has, as before (0106): the API decides what each look-up may read, and
    // refuses every change, so nothing here widens what they can do.
    current = { ...w, role: 'member', permissions: effectivePermissions('owner') };
    viewingAs = { businessName: looking.businessName || w.name, expiresAt: looking.expiresAt };
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
              enabled={can(current.permissions, 'assistant.use')}
              consentNeeded={me.assistantConsent.needed}
            >
              {/* The person's own side menu (settings.menu), so the sidebar and the drawer read the same one. */}
              <MenuProvider settings={me.user.settings}>
                <div className="flex min-h-screen flex-col bg-bg">
                  <ThemeSync theme={parseTheme((me.user.settings as { theme?: unknown }).theme)} />
                  {viewingAs ? (
                    <ViewAsBanner
                      businessName={viewingAs.businessName}
                      expiresAt={viewingAs.expiresAt}
                    />
                  ) : null}
                  <div className="flex min-h-0 flex-1">
                    <Sidebar me={me} current={current} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <MobileShell me={me} current={current} />
                      <WorkspaceMain workspaceId={workspaceId}>{children}</WorkspaceMain>
                    </div>
                    <AssistantPanel />
                  </div>
                </div>
                <MenuEditor workspaceId={workspaceId} />
              </MenuProvider>
              <CallOverlays />
            </AssistantProvider>
          </CallProvider>
        </AttentionSummaryProvider>
      </UnreadProvider>
    </LiveProvider>
  );
}
