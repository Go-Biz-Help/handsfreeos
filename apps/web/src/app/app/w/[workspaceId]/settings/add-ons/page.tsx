import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AddonsSettings } from '@/components/settings/add-ons/add-ons-page';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Add-ons' };

/**
 * Settings → Add-ons (0108), for owners and admins (`addons.manage`): what this business has added and where each
 * add-on stands, what it could add, what's coming soon, and a vote on what comes next. Everyone else gets the
 * not-found page, and never sees the tab. `?addon=<id>` brings one add-on into view (Home's suggestion card links here).
 */
export default async function AddonsSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ addon?: string | string[] }>;
}) {
  const { workspaceId } = await params;
  const { addon } = await searchParams;
  const { api } = await apiServer();
  const body = { body: { workspaceId } };
  const [got, list] = await Promise.all([
    api.POST('/v1/queries/workspace.get', body).then(unwrapPage),
    api.POST('/v1/queries/addon.list', body).then(unwrapPage),
  ]);
  const permissions = got.workspace.permissions;
  if (!can(permissions, 'addons.manage')) notFound();
  // Coming soon and the vote are for those who manage add-ons, like the page.
  const roadmap = await api.POST('/v1/queries/addon.roadmap', body).then(unwrapPage);
  return (
    <>
      <PageHeader title="Settings" description="Your account, and how this workspace is set up." />
      <SettingsNav workspaceId={workspaceId} permissions={permissions} />
      <AddonsSettings
        workspaceId={workspaceId}
        list={list}
        roadmap={roadmap}
        canPurge={can(permissions, 'addons.purge')}
        focus={typeof addon === 'string' ? addon : null}
      />
    </>
  );
}
