import { PROFIT_GROUPS, PROFIT_PERIODS } from '@hfos/core/addons/contractor/job-costing';
import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { ProfitPage } from '@/addons/contractor/profit-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Profit' };

const pick = <T extends string>(list: readonly T[], asked: unknown): T | undefined =>
  list.find((x) => x === asked);

/**
 * Profit: what the jobs made, for the jobs done in a stretch of time or the open jobs at what they're heading for,
 * split by job, customer, crew or service. Which and how are in the address (`?period=quarter&by=crew`); done this
 * month by job to start. For people who may see job costs.
 */
export default async function ContractorProfitRoute({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const asked = await searchParams;
  const period = pick(PROFIT_PERIODS, asked.period);
  const by = pick(PROFIT_GROUPS, asked.by);
  return addonPage(workspaceId, 'contractor', 'contractor.costs', async () => {
    const { api } = await apiServer();
    const profit = await api
      .POST('/v1/queries/contractor.profit', {
        body: { workspaceId, ...(period ? { period } : {}), ...(by ? { by } : {}) },
      })
      .then(unwrapPage);
    return <ProfitPage workspaceId={workspaceId} profit={profit} />;
  });
}
