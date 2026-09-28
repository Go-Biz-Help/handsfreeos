import { can } from '@hfos/core';
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
import { WorkspaceShellProvider } from '@/components/shell/workspace-shell';
import { getMe, getWorkspaceShell } from '@/lib/api/server';
import { CallProvider } from '@/lib/calls/call-provider';
import { AttentionSummaryProvider } from '@/lib/realtime/attention-summary';
import { LiveProvider } from '@/lib/realtime/live-provider';
import { UnreadProvider } from '@/lib/realtime/unread-provider';
import { parseTheme } from '@/lib/theme';

/**
 * The shell of a business: the sidebar and the phone's bars around every page in it. A page that fails is caught
 * by this segment's error.tsx inside the shell, and one that isn't there by its not-found.tsx, so the menu always
 * stays (FE-1, FE-4); a business that isn't theirs to see is the app's own 404 (`getWorkspaceShell`).
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const me = await getMe();
  // The business as this person sees it, or a support person looking at it (M13) with the banner that says so.
  const { current, viewingAs } = await getWorkspaceShell(workspaceId);
  return (
    <LiveProvider workspaceId={workspaceId}>
      {/* Inside LiveProvider: the shell is drawn again when an add-on is turned on or off (0108). */}
      <WorkspaceShellProvider
        workspaceId={workspaceId}
        addons={current.addons}
        permissions={current.permissions}
      >
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
                    <ThemeSync
                      theme={parseTheme((me.user.settings as { theme?: unknown }).theme)}
                    />
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
                  <MenuEditor
                    workspaceId={workspaceId}
                    permissions={current.permissions}
                    addons={current.addons}
                  />
                </MenuProvider>
                <CallOverlays />
              </AssistantProvider>
            </CallProvider>
          </AttentionSummaryProvider>
        </UnreadProvider>
      </WorkspaceShellProvider>
    </LiveProvider>
  );
}
