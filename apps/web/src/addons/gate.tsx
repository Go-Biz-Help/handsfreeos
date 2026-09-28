/**
 * The door every add-on page opens through (0108). An add-on's page is decided before its loader runs, from the
 * same answer the shell was drawn with (`getWorkspaceShell`, fetched once per request):
 *
 * - no such add-on, or one that is only planned → the business's not-found page;
 * - not running in this business (never installed, off, uninstalled, or switched off by HandsFreeOS) → "not
 *   available here" in the shell. The owner's decision: its screens and records stay hidden until it's back on;
 *   people who can turn it back on are told where;
 * - running, but the person doesn't hold `permission` → the not-found page, never a hint of what's behind it;
 * - otherwise the page itself. If the add-on is turned off while its look-ups are under way, the kernel refuses
 *   them (`addon_inactive`) and the page is "not available here" all the same, never a crash.
 *
 * Use it as a page's whole body:
 *
 *   export default async function LeasesPage({ params }: { params: Promise<{ workspaceId: string }> }) {
 *     const { workspaceId } = await params;
 *     return addonPage(workspaceId, 'pm', 'pm.read', async () => {
 *       const { api } = await apiServer();
 *       const leases = unwrapPage(await api.POST('/v1/queries/pm.lease.list', { body: { workspaceId } }));
 *       return <LeaseList leases={leases} />;
 *     });
 *   }
 */
import { ADDON_CATALOG, findAddon } from '@hfos/core';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AddonUnavailable } from '@/components/addons/unavailable';
import { ApiError, getWorkspaceShell } from '@/lib/api/server';
import { ADDON_INACTIVE } from '@/lib/api/page-refusals';

/**
 * An add-on page, or what to show instead. `permission` is what the page needs beyond the add-on running (`pm.read`);
 * null for a page anyone in the business may open (the add-on's queries still check their own).
 */
export async function addonPage(
  workspaceId: string,
  addonId: string,
  permission: string | null,
  render: () => ReactNode | Promise<ReactNode>,
): Promise<ReactNode> {
  const addon = findAddon(ADDON_CATALOG, addonId);
  if (!addon || addon.catalog.status === 'planned') notFound();
  const { current } = await getWorkspaceShell(workspaceId);
  const unavailable = (
    <AddonUnavailable
      workspaceId={workspaceId}
      name={addon.name}
      addonId={addon.id}
      canManage={current.permissions.includes('addons.manage')}
    />
  );
  if (!current.addons.includes(addon.id)) return unavailable;
  if (permission && !current.permissions.includes(permission)) notFound();
  try {
    return await render();
  } catch (e) {
    if (e instanceof ApiError && e.rule === ADDON_INACTIVE) return unavailable;
    throw e;
  }
}
