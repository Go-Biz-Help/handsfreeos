import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { DealsHome, type DealsView } from '@/addons/realestate/deals-home';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Deals' };

const VIEWS: readonly DealsView[] = ['mine', 'all', 'attention', 'closed', 'archived'];

/**
 * Real Estate Agent's first page (its manifest's `ui.nav` points here): Deals. It opens through the gate: "not
 * available here" while the add-on is off, and not found for someone without `realestate.use`. Its components are
 * in apps/web/src/addons/realestate/, which only this add-on's pages and the web's registry may import.
 */
export default async function RealestatePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const wanted = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const view: DealsView = VIEWS.includes(wanted as DealsView) ? (wanted as DealsView) : 'mine';
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api, userId } = await apiServer();
    const list = (status: 'open' | 'closed' | 'ended' | 'archived') =>
      api
        .POST('/v1/queries/realestate.deal.list', {
          body: { workspaceId, status, mine: false, limit: 200 },
        })
        .then(unwrapPage);
    const [got, open, closed, ended, archived, members] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      list('open'),
      view === 'closed' ? list('closed') : null,
      view === 'closed' ? list('ended') : null,
      view === 'archived' ? list('archived') : null,
      api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
    ]);
    const others =
      view === 'closed'
        ? [...(closed?.deals ?? []), ...(ended?.deals ?? [])].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          )
        : (archived?.deals ?? []);
    return (
      <DealsHome
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        timeZone={got.workspace.timezone}
        view={view}
        openDeals={open.deals}
        otherDeals={others}
        members={assigneeOptions(members)}
        myUserId={userId}
        canChooseAgent={got.workspace.permissions.includes('records.assign')}
      />
    );
  });
}
