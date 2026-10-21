import { can, managesAnAgency } from '@hfos/core';
import type { ReactNode } from 'react';
import { ViewAsBanner } from '@/components/admin/view-as-banner';
import { ForgetStaleView, TeammateViewBanner } from '@/components/view-as/teammate-view-banner';
import { ExtensionSignInPrompt } from '@/components/account/extension-sign-in-prompt';
import { AssistantPanel } from '@/components/assistant/assistant-panel';
import { AssistantProvider } from '@/components/assistant/assistant-provider';
import { CallOverlays } from '@/components/calls/call-overlays';
import { Tour } from '@/components/onboarding/tour';
import { SearchProvider } from '@/components/search/search-provider';
import { MenuEditor } from '@/components/shell/menu-editor';
import { MenuProvider } from '@/components/shell/menu-provider';
import { MobileShell } from '@/components/shell/mobile-shell';
import { Sidebar } from '@/components/shell/sidebar';
import { ThemeSync } from '@/components/shell/theme-sync';
import { WorkspaceMain } from '@/components/shell/workspace-main';
import { WorkspaceShellProvider } from '@/components/shell/workspace-shell';
import { apiServer, getMe, getWorkspaceShell, unwrap } from '@/lib/api/server';
import { guideOf } from '@/lib/guide';
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
  // Recent searches are the signed-in person's own, even while they view the app as a teammate.
  const { api, signedInAs } = await apiServer();
  const [me, { current, viewingAs, teammateView, staleView }, platform, workspace] =
    await Promise.all([
      getMe(),
      // The business as this person sees it, or a support person looking at it (M13) with the banner that says so,
      // or the founder working in it as its owner, or anyone viewing it as a teammate (20261018000100).
      getWorkspaceShell(workspaceId),
      // Whether they answer HandsFreeOS support: only then does the workspace switcher link to the admin area. Only a
      // hint, so a failure just leaves the link out; /admin asks again on every page.
      api
        .POST('/v1/queries/platform.me', { body: {} })
        .then(unwrap)
        .catch(() => null),
      // The business's settings, for the values Search everything's Settings group shows (quiet hours, opening
      // hours). Only a hint too: without them a setting is still found, just without its value.
      api
        .POST('/v1/queries/workspace.get', { body: { workspaceId } })
        .then(unwrap)
        .catch(() => null),
    ]);
  const staff = platform?.staff?.role ?? null;
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
                // A view is for seeing, and the Assistant is for doing; the teammate's chats are theirs.
                enabled={can(current.permissions, 'assistant.use') && !teammateView}
                consentNeeded={me.assistantConsent.needed}
              >
                {/* Search everything: the sidebar's box and ⌘K, the Search page, and recent searches. */}
                <SearchProvider
                  business={{
                    workspaceId,
                    userId: signedInAs,
                    name: current.name,
                    timeZone: current.timezone,
                    settings: workspace?.workspace.settings ?? null,
                    staff: !!platform?.staff,
                    agency: managesAnAgency({
                      organizations: me.organizations,
                      businesses: me.workspaces,
                    }),
                  }}
                >
                  {/* The person's own side menu (settings.menu), so the sidebar and the drawer read the same one. */}
                  <MenuProvider settings={me.user.settings}>
                    <div className="flex min-h-screen flex-col bg-bg">
                      <ThemeSync
                        theme={parseTheme((me.user.settings as { theme?: unknown }).theme)}
                      />
                      {viewingAs ? (
                        <ViewAsBanner
                          workspaceId={workspaceId}
                          businessName={viewingAs.businessName}
                          expiresAt={viewingAs.expiresAt}
                          acting={viewingAs.acting}
                        />
                      ) : null}
                      {teammateView ? (
                        <TeammateViewBanner workspaceId={workspaceId} view={teammateView} />
                      ) : null}
                      {staleView ? <ForgetStaleView workspaceId={workspaceId} /> : null}
                      <div className="flex min-h-0 flex-1">
                        <Sidebar me={me} current={current} staff={staff} />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <MobileShell me={me} current={current} staff={staff} />
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
                  {/* Signing in to the browser extension with this person's email: pick the number it shows. */}
                  <ExtensionSignInPrompt />
                  {/* The tour of the menu: after the setup wizard, and from the card or Get help. */}
                  <Tour workspaceId={workspaceId} taken={guideOf(me, workspaceId).tourTaken} />
                </SearchProvider>
              </AssistantProvider>
            </CallProvider>
          </AttentionSummaryProvider>
        </UnreadProvider>
      </WorkspaceShellProvider>
    </LiveProvider>
  );
}
