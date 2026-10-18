import { ADDON_CATALOG, can, coreFeatureRunning, PARTNERS_WORDS } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PartnersSettings } from '@/components/partners/settings-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: PARTNERS_WORDS.menu };

/**
 * Settings → Partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2d): how partners are paid, the terms they
 * accept, and the partners with what each has earned. There only while an add-on that uses partners is on (Social
 * Outreach), for whoever holds Manage partners.
 */
export default async function PartnersSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const { workspace } = unwrapPage(
    await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
  );
  if (
    !coreFeatureRunning(ADDON_CATALOG, workspace.addons, 'partners') ||
    !can(workspace.permissions, 'partners.manage')
  )
    notFound();
  const body = { body: { workspaceId } };
  const [settings, list, calendars] = await Promise.all([
    api.POST('/v1/queries/partners.settings', body).then(unwrapPage),
    api.POST('/v1/queries/partner.list', body).then(unwrapPage),
    api.POST('/v1/queries/calendar.list', body).then(unwrapPage),
  ]);
  return (
    <PartnersSettings
      workspaceId={workspaceId}
      initial={settings}
      partners={list.partners}
      calendars={calendars.items
        .filter((c) => c.public && c.status === 'active')
        .map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
