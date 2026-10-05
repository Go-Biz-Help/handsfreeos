import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { MyDuties } from '@/addons/realestate/my-duties';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'My duties' };

/** What the person answers for across their deals (`?scope=all`: everyone's, for those who see every deal). */
export default async function RealestateDutiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const got = await api
      .POST('/v1/queries/workspace.get', { body: { workspaceId } })
      .then(unwrapPage);
    const canSeeAll = got.workspace.permissions.includes('realestate.all_deals');
    const scope = sp.scope === 'all' && canSeeAll ? 'all' : 'mine';
    const mine = scope === 'mine';
    const [open, drafts, members] = await Promise.all([
      api
        .POST('/v1/queries/realestate.duty.list', {
          body: { workspaceId, mine, status: 'open', limit: 500 },
        })
        .then(unwrapPage),
      api
        .POST('/v1/queries/realestate.duty.list', {
          body: { workspaceId, mine, status: 'drafts', limit: 200 },
        })
        .then(unwrapPage),
      api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
    ]);
    return (
      <MyDuties
        workspaceId={workspaceId}
        timeZone={got.workspace.timezone}
        scope={scope}
        duties={open.duties}
        drafts={drafts.duties}
        members={assigneeOptions(members)}
        canSeeAll={canSeeAll}
      />
    );
  });
}
