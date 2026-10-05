import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { OutreachHome } from '@/addons/outreach/playbooks-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Social Outreach' };

/**
 * Social Outreach's first page (its manifest's `ui.nav` points here): the browser extension, and the business's
 * playbooks. It opens through the gate: "not available here" while the add-on is off, and not found for someone
 * without `outreach.use`. Owners and admins (`outreach.manage`) write the playbooks.
 */
export default async function OutreachPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'outreach', 'outreach.use', async () => {
    const { api } = await apiServer();
    const [got, list] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/outreach.playbook.list', { body: { workspaceId } }).then(unwrapPage),
    ]);
    return (
      <OutreachHome
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        list={list}
        canManage={got.workspace.permissions.includes('outreach.manage')}
      />
    );
  });
}
