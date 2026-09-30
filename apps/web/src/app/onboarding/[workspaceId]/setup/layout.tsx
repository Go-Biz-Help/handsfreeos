import type { ReactNode } from 'react';
import { ThemeSync } from '@/components/shell/theme-sync';
import { WorkspaceShellProvider } from '@/components/shell/workspace-shell';
import { getMe, getWorkspaceShell } from '@/lib/api/server';
import { LiveProvider } from '@/lib/realtime/live-provider';
import { parseTheme } from '@/lib/theme';

/**
 * The setup wizard's providers: the business's live changes, so a step moves on when a number is bought or a scan
 * finishes, and what this person may do in it. None of the sidebar's (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md
 * §6): the wizard is a frame of its own.
 */
export default async function SetupLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const me = await getMe();
  const { current } = await getWorkspaceShell(workspaceId);
  return (
    <LiveProvider workspaceId={workspaceId}>
      <WorkspaceShellProvider
        workspaceId={workspaceId}
        addons={current.addons}
        permissions={current.permissions}
      >
        <ThemeSync theme={parseTheme((me.user.settings as { theme?: unknown }).theme)} />
        {children}
      </WorkspaceShellProvider>
    </LiveProvider>
  );
}
