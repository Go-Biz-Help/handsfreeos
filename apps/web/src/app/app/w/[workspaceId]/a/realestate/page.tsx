import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { DealsHome, type DealFilters, type DealsView } from '@/addons/realestate/deals-home';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Deals' };

const VIEWS: readonly DealsView[] = ['mine', 'all', 'attention', 'closed', 'archived'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSING_DAYS = [14, 30, 60, 90];

/** The filters in the address (round four, board 59), so a saved link opens the same list. */
function filtersOf(sp: Record<string, string | string[] | undefined>): DealFilters {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const agent = one('agent');
  const side = one('side');
  const stage = one('stage');
  const closing = Number(one('closing'));
  const waiting = one('waiting');
  const health = one('health');
  return {
    agent: agent && UUID.test(agent) ? agent : null,
    side: side === 'buyer' || side === 'listing' ? side : null,
    stage: stage && /^[a-z_]{1,40}$/.test(stage) ? stage : null,
    closing: CLOSING_DAYS.includes(closing) ? closing : null,
    waiting:
      waiting === 'outside' || waiting === 'blocked' || waiting === 'either' ? waiting : null,
    health: health === 'green' || health === 'yellow' || health === 'red' ? health : null,
  };
}

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
  const filters = filtersOf(sp);
  // Health is worked out in the browser; the rest asks the server.
  const filtered = !!(
    filters.agent ||
    filters.side ||
    filters.stage ||
    filters.closing ||
    filters.waiting
  );
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api, userId } = await apiServer();
    const list = (status: 'open' | 'closed' | 'ended' | 'archived', narrow = false) =>
      api
        .POST('/v1/queries/realestate.deal.list', {
          body: {
            workspaceId,
            status,
            mine: false,
            limit: 200,
            ...(narrow
              ? {
                  ...(filters.agent ? { agentUserId: filters.agent } : {}),
                  ...(filters.side ? { side: filters.side } : {}),
                  ...(filters.stage ? { stage: filters.stage } : {}),
                  ...(filters.closing ? { closingWithinDays: filters.closing } : {}),
                  ...(filters.waiting ? { waitingOn: filters.waiting } : {}),
                }
              : {}),
          },
        })
        .then(unwrapPage);
    const [got, open, matching, closed, ended, archived, members] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      list('open'),
      filtered ? list('open', true) : null,
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
        matchingDeals={matching?.deals ?? null}
        filters={filters}
        otherDeals={others}
        members={assigneeOptions(members)}
        myUserId={userId}
        canChooseAgent={got.workspace.permissions.includes('records.assign')}
      />
    );
  });
}
