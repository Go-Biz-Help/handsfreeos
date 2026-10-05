import { ADDON_CATALOG } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { ADDON_UI } from '@/addons/registry';
import { AddonConnections } from '@/components/addons/connections';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Connections' };

/** What a sign-in brings back, passed on to wherever the add-on shows its connections. */
const BACK = ['connected', 'signin'] as const;

/**
 * An add-on's connections (round five): where a sign-in at another service comes back to. An add-on that shows its
 * connections among its own pages (the registry's `connections`, Real Estate's Deal settings) is sent on there with
 * what the sign-in said; any other gets them here. Who may see them is the add-on's to say (`addon_connection.list`).
 */
export default async function AddonConnectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; addonId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, addonId } = await params;
  const sp = await searchParams;
  const said = new URLSearchParams();
  for (const k of BACK) {
    const v = sp[k];
    if (typeof v === 'string') said.set(k, v);
  }
  const own = ADDON_UI[addonId]?.connections;
  if (own) {
    const [path, query] = own.split('?');
    const to = new URLSearchParams(query);
    said.forEach((v, k) => to.set(k, v));
    redirect(`/app/w/${workspaceId}/a/${addonId}/${path}${to.size ? `?${to}` : ''}`);
  }
  const manifest = ADDON_CATALOG.find((m) => m.id === addonId);
  if (!manifest) notFound();
  const { api } = await apiServer();
  const list = await api
    .POST('/v1/queries/addon_connection.list', { body: { workspaceId, addonId } })
    .then(unwrapPage);
  return (
    <>
      <PageHeader title="Connections" description={`What ${manifest.name} connects to`} />
      <AddonConnections
        workspaceId={workspaceId}
        addonId={addonId}
        list={list}
        back={{ connected: said.get('connected'), signin: said.get('signin') }}
      />
    </>
  );
}
