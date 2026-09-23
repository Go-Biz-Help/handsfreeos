import type { ReactNode } from 'react';
import { ShareIdea } from '@/components/ideas/share-idea';
import { IdeasSubnav } from '@/components/ideas/subnav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

/**
 * Ideas, the roadmap and What's new (0100): one header, "Share an idea", and the three tabs over every page.
 * The board is the same for every business on HandsFreeOS; which business somebody is in is only ever told to
 * the team.
 */
export default async function IdeasLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const { areas } = unwrapPage(await api.POST('/v1/queries/idea.areas', { body: {} }));
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Ideas"
        description="Tell us what would make HandsFreeOS better, vote for what matters to you, and follow it from idea to done."
        actions={<ShareIdea workspaceId={workspaceId} areas={areas} />}
      />
      <IdeasSubnav workspaceId={workspaceId} />
      {children}
    </div>
  );
}
