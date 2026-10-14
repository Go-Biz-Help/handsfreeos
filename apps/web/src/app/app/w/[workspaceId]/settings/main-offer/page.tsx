import { ADDON_CATALOG, can, coreFeatureRunning } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MainOfferPage } from '@/components/main-offer/page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Main offer' };

/**
 * Settings → Main offer (docs/main-offer.md): the business's main offer, its draft and its versions. There only while
 * an add-on that uses it is on (Social Outreach); everyone in the business reads it, and main_offer.manage builds it.
 */
export default async function MainOfferSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const { workspace } = unwrapPage(
    await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
  );
  if (!coreFeatureRunning(ADDON_CATALOG, workspace.addons, 'main_offer')) notFound();
  const [offer, { versions }] = await Promise.all([
    api.POST('/v1/queries/main_offer.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/main_offer.versions', { body: { workspaceId } }).then(unwrapPage),
  ]);
  return (
    <MainOfferPage
      workspaceId={workspaceId}
      offer={offer}
      versions={versions}
      canManage={can(workspace.permissions, 'main_offer.manage')}
    />
  );
}
