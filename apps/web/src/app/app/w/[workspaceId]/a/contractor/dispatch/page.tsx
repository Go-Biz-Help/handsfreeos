import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { DispatchPage } from '@/addons/contractor/dispatch-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Dispatch' };

/**
 * Dispatch: a day's visits on jobs by person, the ones nobody is on, where each stands, and the open jobs with
 * nothing booked. Today, or the day in the address (`?day=2026-11-12`).
 */
export default async function ContractorDispatchRoute({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const asked = (await searchParams).day;
  const day = typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : undefined;
  return addonPage(workspaceId, 'contractor', 'contractor.use', async () => {
    const { api, userId } = await apiServer();
    const dispatch = await api
      .POST('/v1/queries/contractor.dispatch', { body: { workspaceId, ...(day ? { day } : {}) } })
      .then(unwrapPage);
    return <DispatchPage workspaceId={workspaceId} dispatch={dispatch} myUserId={userId} />;
  });
}
