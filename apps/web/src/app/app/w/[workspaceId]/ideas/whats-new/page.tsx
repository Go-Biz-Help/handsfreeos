import type { Metadata } from 'next';
import { WhatsNewList } from '@/components/ideas/whats-new-list';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'What’s new' };

export default async function WhatsNewPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [list, areas] = await Promise.all([
    api.POST('/v1/queries/whats_new.list', { body: {} }).then(unwrapPage),
    api.POST('/v1/queries/idea.areas', { body: {} }).then(unwrapPage),
  ]);
  return (
    <WhatsNewList
      workspaceId={workspaceId}
      entries={list.entries}
      nextCursor={list.nextCursor}
      areas={areas.areas}
    />
  );
}
