import { can } from '@hfos/core';
import { RealestateSettingsSchema } from '@hfos/core/addons/realestate/settings';
import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { DealSettings, type SettingsTab } from '@/addons/realestate/deal-settings';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Deal settings' };

const TABS: readonly SettingsTab[] = ['duties', 'alerts', 'versions', 'support'];

/** Deal settings (`?tab=`): the duty list, alerts and dates, versions, and support access. Owners and admins. */
export default async function RealestateSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const wanted = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: SettingsTab = TABS.includes(wanted as SettingsTab)
    ? (wanted as SettingsTab)
    : 'duties';
  return addonPage(workspaceId, 'realestate', 'realestate.manage', async () => {
    const { api, userId } = await apiServer();
    const [got, list, versions, settings, members, support, calendars] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      tab === 'duties'
        ? api
            .POST('/v1/queries/realestate.template.list', { body: { workspaceId } })
            .then(unwrapPage)
        : null,
      tab === 'versions'
        ? api
            .POST('/v1/queries/realestate.template.versions', { body: { workspaceId } })
            .then(unwrapPage)
        : null,
      tab === 'alerts'
        ? api
            .POST('/v1/queries/addon.settings', { body: { workspaceId, addonId: 'realestate' } })
            .then(unwrapPage)
        : null,
      tab === 'alerts'
        ? api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage)
        : null,
      tab === 'support'
        ? api.POST('/v1/queries/support_access.list', { body: { workspaceId } }).then(unwrapPage)
        : null,
      tab === 'alerts'
        ? api.POST('/v1/queries/calendar.list', { body: { workspaceId } }).then(unwrapPage)
        : null,
    ]);
    // Who may hear about critical alerts: owners, and people who see every deal.
    const candidates = (members?.members ?? [])
      .filter((m) => m.role === 'owner' || m.permissions.includes('realestate.all_deals'))
      .map((m) => ({ id: m.userId, fullName: m.fullName || m.email, role: m.role }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    return (
      <DealSettings
        workspaceId={workspaceId}
        tab={tab}
        timeZone={got.workspace.timezone}
        list={list}
        versions={versions}
        settings={settings ? RealestateSettingsSchema.parse(settings.settings ?? {}) : null}
        members={candidates}
        calendars={(calendars?.items ?? [])
          .filter((c) => c.status === 'active')
          .map((c) => ({ id: c.id, name: c.name }))}
        support={
          support
            ? {
                workspaceId,
                canLetIn: support.canLetIn,
                items: support.items,
                myUserId: userId,
                canEndAny: can(got.workspace.permissions, 'records.assign'),
              }
            : null
        }
      />
    );
  });
}
