import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { VendorsPage } from '@/addons/realestate/vendors-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Vendors' };

/** The vendors the business's deals use (round five): add, approve (owners and admins), archive. */
export default async function RealestateVendorsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const [got, list] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/realestate.vendor.list', { body: { workspaceId } }).then(unwrapPage),
    ]);
    return (
      <VendorsPage
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        list={list}
        canManage={got.workspace.permissions.includes('realestate.manage')}
      />
    );
  });
}
