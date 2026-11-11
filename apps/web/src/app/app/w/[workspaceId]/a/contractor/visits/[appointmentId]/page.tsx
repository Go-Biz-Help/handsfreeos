import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { WorkOrderPage } from '@/addons/contractor/work-order-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Work order' };

/**
 * A visit's work order: when it is and where it stands, what to do and bring, the job's materials it needs, the time
 * tracked on it, its crew and subcontractors, its checklist, and the notes the crew left on it. A visit that isn't
 * here, or isn't on a job, is the business's not-found page.
 */
export default async function ContractorWorkOrderRoute({
  params,
}: {
  params: Promise<{ workspaceId: string; appointmentId: string }>;
}) {
  const { workspaceId, appointmentId } = await params;
  return addonPage(workspaceId, 'contractor', 'contractor.use', async () => {
    const { api, userId } = await apiServer();
    const [got, order, crews, overview] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/contractor.work_order.get', { body: { workspaceId, appointmentId } })
        .then(unwrapPage),
      api.POST('/v1/queries/contractor.crew.list', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/contractor.overview', { body: { workspaceId } }).then(unwrapPage),
    ]);
    const [time, notes] = await Promise.all([
      api
        .POST('/v1/queries/contractor.time.list', {
          body: { workspaceId, jobId: order.job.id, appointmentId },
        })
        .then(unwrapPage),
      api
        .POST('/v1/queries/contractor.note.list', {
          body: { workspaceId, jobId: order.job.id, appointmentId },
        })
        .then(unwrapPage),
    ]);
    // The price list is core's, read by people who see the business's money: everyone else types a material's name.
    const products = got.workspace.permissions.includes('money.read')
      ? (await api.POST('/v1/queries/product.list', { body: { workspaceId } }).then(unwrapPage))
          .products
      : [];
    return (
      <WorkOrderPage
        workspaceId={workspaceId}
        order={order}
        crews={crews.crews}
        time={time}
        notes={notes}
        people={overview.people}
        products={products.map((p) => ({ id: p.id, name: p.name, unitLabel: p.unitLabel }))}
        myUserId={userId}
        timeZone={got.workspace.timezone}
      />
    );
  });
}
