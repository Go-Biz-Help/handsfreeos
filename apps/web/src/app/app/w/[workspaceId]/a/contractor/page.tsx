import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { JobsHome, type JobsFilter, type JobsView } from '@/addons/contractor/jobs-home';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Jobs' };

const FILTERS: readonly JobsFilter[] = ['all', 'mine', 'late'];

/**
 * Contractor Operations' first page (its manifest's `ui.nav` points here): Jobs, as a board or a list. It opens
 * through the gate: "not available here" while the add-on is off, and not found for someone without
 * `contractor.use`. The filters are in the address (`?filter=mine&closed=1&q=…&view=list`), so a saved link opens
 * the same view.
 */
export default async function ContractorJobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const wanted = one('filter');
  const filter: JobsFilter = FILTERS.includes(wanted as JobsFilter)
    ? (wanted as JobsFilter)
    : 'all';
  const view: JobsView = one('view') === 'list' ? 'list' : 'board';
  const closed = one('closed') === '1';
  const q = (one('q') ?? '').trim().slice(0, 100);
  return addonPage(workspaceId, 'contractor', 'contractor.use', async () => {
    const { api, userId } = await apiServer();
    const [got, overview, list] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/contractor.overview', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/contractor.job.list', {
          body: { workspaceId, filter, includeClosed: closed, ...(q ? { search: q } : {}) },
        })
        .then(unwrapPage),
    ]);
    return (
      <JobsHome
        workspaceId={workspaceId}
        overview={overview}
        list={list}
        view={view}
        filter={filter}
        closed={closed}
        q={q}
        myUserId={userId}
        timeZone={got.workspace.timezone}
      />
    );
  });
}
