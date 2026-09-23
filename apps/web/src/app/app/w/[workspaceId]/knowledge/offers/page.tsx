import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { OfferList } from '@/components/knowledge/offers';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Offers' };

/** What the business is running right now; the AI teammate shares the ones live today (M18). */
export default async function KnowledgeOffersPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [ws, list] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/offer.list', { body: { workspaceId } }),
  ]);
  const { workspace } = unwrapPage(ws);
  return (
    <OfferList
      workspaceId={workspaceId}
      canManage={can(workspace.permissions, 'knowledge.manage')}
      offers={unwrapPage(list).offers}
    />
  );
}
