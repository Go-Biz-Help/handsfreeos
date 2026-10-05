import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { CoordinatePage, type CoordinateTab } from '@/addons/realestate/coordinate-page';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Coordinate' };

const TABS: readonly CoordinateTab[] = ['today', 'exceptions', 'waiting', 'workload'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coordinate (round four, boards 55–58): Today, Exceptions, the Waiting room and Team workload, across the deals the
 * person sees. Workload is about people rather than deals, so it needs See every deal. A duty opens in the drawer
 * (`?duty=`), as on its deal.
 */
export default async function RealestateCoordinatePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const wanted = one('tab');
  const agent = one('agent');
  const agentUserId = agent && UUID.test(agent) ? agent : undefined;
  const mine = one('mine') === '1';
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const got = await api
      .POST('/v1/queries/workspace.get', { body: { workspaceId } })
      .then(unwrapPage);
    const canSeeAll = got.workspace.permissions.includes('realestate.all_deals');
    const tab: CoordinateTab =
      TABS.includes(wanted as CoordinateTab) && (wanted !== 'workload' || canSeeAll)
        ? (wanted as CoordinateTab)
        : 'today';
    const body = { workspaceId, mine, ...(agentUserId ? { agentUserId } : {}) };
    const [today, exceptions, waiting, workload, members] = await Promise.all([
      api.POST('/v1/queries/realestate.today', { body }).then(unwrapPage),
      api.POST('/v1/queries/realestate.exceptions', { body }).then(unwrapPage),
      api.POST('/v1/queries/realestate.waiting_room', { body }).then(unwrapPage),
      tab === 'workload'
        ? api.POST('/v1/queries/realestate.workload', { body }).then(unwrapPage)
        : null,
      api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
    ]);
    return (
      <CoordinatePage
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        timeZone={got.workspace.timezone}
        tab={tab}
        mine={mine}
        agentUserId={agentUserId ?? null}
        canSeeAll={canSeeAll}
        today={today}
        exceptions={exceptions}
        waiting={waiting}
        workload={workload}
        members={assigneeOptions(members)}
      />
    );
  });
}
