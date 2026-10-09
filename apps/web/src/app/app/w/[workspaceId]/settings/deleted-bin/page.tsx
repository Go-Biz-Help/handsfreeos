import { BIN_WORDS, can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DeletedBin } from '@/components/bin/deleted-bin';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: BIN_WORDS.title };

/**
 * Settings → Deleted bin (20261027000400): customers, conversations and bookings deleted for good, each waiting its
 * 30 days. Bring one back, delete it now, or empty the bin. Whoever may delete for good (`records.delete`): owners,
 * unless one gives it out.
 */
export default async function DeletedBinPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'records.delete')) notFound();
  const list = unwrapPage(
    await api.POST('/v1/queries/bin.list', { body: { workspaceId, limit: 50 } }),
  );
  return <DeletedBin workspaceId={workspaceId} timeZone={got.workspace.timezone} initial={list} />;
}
