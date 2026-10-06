import type { Metadata } from 'next';
import { readOutreachAddress } from '@/addons/outreach/address';
import { addonPage } from '@/addons/gate';
import { OutreachHome } from '@/addons/outreach/home';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Social Outreach' };

/**
 * Social Outreach's page (its manifest's `ui.nav` points here): the activity the browser extension noted, and the
 * business's playbooks (`?view=playbooks`). It opens through the gate: "not available here" while the add-on is off,
 * and not found for someone without `outreach.use`. Owners and admins (`outreach.manage`) write the playbooks and see
 * everyone's activity (`?who=everyone`); anyone else asking for that sees their own.
 */
export default async function OutreachPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const shown = readOutreachAddress(await searchParams);
  return addonPage(workspaceId, 'outreach', 'outreach.use', async () => {
    const { api } = await apiServer();
    const workspace = api
      .POST('/v1/queries/workspace.get', { body: { workspaceId } })
      .then(unwrapPage);
    const activityOf = (everyone: boolean) =>
      api
        .POST('/v1/queries/outreach.activity', {
          body: { workspaceId, period: shown.period, everyone },
        })
        .then(unwrapPage);
    if (shown.view === 'playbooks') {
      const [got, list] = await Promise.all([
        workspace,
        api.POST('/v1/queries/outreach.playbook.list', { body: { workspaceId } }).then(unwrapPage),
      ]);
      const canManage = got.workspace.permissions.includes('outreach.manage');
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={canManage}
          shown={{ view: 'playbooks', list }}
        />
      );
    }
    // Everyone's steps only once it's known they may see them.
    const [got, own] = await Promise.all([workspace, shown.everyone ? null : activityOf(false)]);
    const canManage = got.workspace.permissions.includes('outreach.manage');
    const activity = own ?? (await activityOf(canManage));
    return (
      <OutreachHome
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        canManage={canManage}
        shown={{ view: 'activity', activity, period: shown.period }}
      />
    );
  });
}
