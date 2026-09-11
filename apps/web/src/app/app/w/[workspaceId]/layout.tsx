import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Sidebar } from '@/components/shell/sidebar';
import { ThemeSync } from '@/components/shell/theme-sync';
import { ApiError, apiServer, fetchMe, unwrap } from '@/lib/api/server';
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
    <div className="flex min-h-screen bg-bg">
      <ThemeSync theme={parseTheme((me.user.settings as { theme?: unknown }).theme)} />
      <Sidebar me={me} current={current} />
      <main className="min-w-0 flex-1 px-10 py-8">{children}</main>
    </div>
  );
}
