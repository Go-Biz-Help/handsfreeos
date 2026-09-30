import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { SupportAccessCard } from '@/components/settings/support-access-card';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Support access' };

/**
 * HandsFreeOS support and the business's private records (Real Estate step 4): where a request from support is
 * answered (the email links here), and where access given is seen and ended. Everyone who can open the business sees
 * where it stands; owners and admins, and the main person on a private record, answer.
 */
export default async function SupportAccessPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api, userId } = await apiServer();
  const [got, list] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/support_access.list', { body: { workspaceId } }).then(unwrapPage),
  ]);
  return (
    <div className="mx-auto w-full max-w-3xl">
      <SupportAccessCard
        workspaceId={workspaceId}
        canLetIn={list.canLetIn}
        items={list.items}
        myUserId={userId}
        canEndAny={can(got.workspace.permissions, 'records.assign')}
      />
    </div>
  );
}
