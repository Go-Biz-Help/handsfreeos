import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  FacebookInstagramPage,
  type MetaResult,
} from '@/components/settings/facebook-instagram-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Facebook & Instagram' };

const count = (v: string | string[] | undefined) =>
  typeof v === 'string' && /^[0-9]{1,4}$/.test(v) ? Number(v) : 0;

/**
 * Settings → Facebook & Instagram (channels.manage: owners and admins): the Pages and Instagram accounts whose
 * messages come to the inbox, and their Facebook sign-in. Coming back from Facebook carries `?meta=`.
 */
export default async function FacebookInstagramSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'channels.manage')) notFound();
  const data = unwrapPage(
    await api.POST('/v1/queries/meta_account.list', { body: { workspaceId } }),
  );
  const result: MetaResult | null =
    typeof q.meta === 'string'
      ? {
          meta: q.meta,
          facebook: count(q.facebook),
          instagram: count(q.instagram),
          skipped: count(q.skipped),
        }
      : null;
  return <FacebookInstagramPage workspaceId={workspaceId} data={data} result={result} />;
}
