import { ADDON_CATALOG, can, coreFeatureRunning, PARTNERS_WORDS } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PartnerDetail } from '@/components/partners/partner-detail';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';

export const metadata: Metadata = { title: PARTNERS_WORDS.menu };

/**
 * A partner, under Settings → Partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2d): their share, pausing
 * or ending them, their link, sending them their page, the clients they sent and what they've earned.
 */
export default async function PartnerSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; partnerId: string }>;
}) {
  const { workspaceId, partnerId } = await params;
  const { api } = await apiServer();
  const { workspace } = unwrapPage(
    await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
  );
  if (
    !coreFeatureRunning(ADDON_CATALOG, workspace.addons, 'partners') ||
    !can(workspace.permissions, 'partners.manage')
  )
    notFound();
  const [got, settings, brandedOrigin] = await Promise.all([
    api.POST('/v1/queries/partner.get', { body: { workspaceId, partnerId } }).then(unwrapPage),
    api.POST('/v1/queries/partners.settings', { body: { workspaceId } }).then(unwrapPage),
    brandedOriginFor(api, workspaceId),
  ]);
  // Whether they've had their page yet: the button says Send it again once they have.
  const access = await api
    .POST('/v1/queries/portal_access.get', {
      body: { workspaceId, personId: got.partner.personId },
    })
    .then((r) => r.data?.access ?? null)
    .catch(() => null);
  return (
    <PartnerDetail
      workspaceId={workspaceId}
      got={got}
      businessRateBp={settings.settings.rateBp}
      hasTerms={settings.settings.termsVersion > 0}
      pageSent={!!access?.on}
      canSendPage={can(workspace.permissions, 'records.write')}
      brandedOrigin={brandedOrigin}
    />
  );
}
