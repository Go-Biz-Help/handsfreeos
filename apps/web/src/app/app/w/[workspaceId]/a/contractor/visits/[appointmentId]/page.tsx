import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { WorkOrderPage } from '@/addons/contractor/work-order-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Work order' };

/**
 * A visit's work order: when it is and where it stands, what to do and bring, its crew and subcontractors, and its
 * checklist. A visit that isn't here, or isn't on a job, is the business's not-found page.
 */
export default async function ContractorWorkOrderRoute({
  params,
}: {
  params: Promise<{ workspaceId: string; appointmentId: string }>;
}) {
  const { workspaceId, appointmentId } = await params;
  return addonPage(workspaceId, 'contractor', 'contractor.use', async () => {
    const { api } = await apiServer();
    const [got, order, crews] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/contractor.work_order.get', { body: { workspaceId, appointmentId } })
        .then(unwrapPage),
      api.POST('/v1/queries/contractor.crew.list', { body: { workspaceId } }).then(unwrapPage),
    ]);
    return (
      <WorkOrderPage
        workspaceId={workspaceId}
        order={order}
        crews={crews.crews}
        timeZone={got.workspace.timezone}
      />
    );
  });
}
