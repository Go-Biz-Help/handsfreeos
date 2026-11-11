import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { JobPage } from '@/addons/contractor/job-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Job' };

/**
 * One job: its status, details, phases and % done, team, visits, its materials, the time tracked on it, the crew's
 * notes from the field, its daily reports, its estimates, and (for people who may see job costs) its price and
 * budget, what it's costing, and the estimates the AI drafted that wait to be checked. A job that isn't here, or was
 * archived, is the business's not-found page.
 */
export default async function ContractorJobPage({
  params,
}: {
  params: Promise<{ workspaceId: string; jobId: string }>;
}) {
  const { workspaceId, jobId } = await params;
  return addonPage(workspaceId, 'contractor', 'contractor.use', async () => {
    const { api, userId } = await apiServer();
    const [got, overview, job, members, estimates, materials, time, notes, reports] =
      await Promise.all([
        api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
        api.POST('/v1/queries/contractor.overview', { body: { workspaceId } }).then(unwrapPage),
        api
          .POST('/v1/queries/contractor.job.get', { body: { workspaceId, jobId } })
          .then(unwrapPage),
        api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
        api
          .POST('/v1/queries/contractor.estimate.list', { body: { workspaceId, jobId } })
          .then(unwrapPage),
        api
          .POST('/v1/queries/contractor.material.list', { body: { workspaceId, jobId } })
          .then(unwrapPage),
        api
          .POST('/v1/queries/contractor.time.list', { body: { workspaceId, jobId } })
          .then(unwrapPage),
        api
          .POST('/v1/queries/contractor.note.list', { body: { workspaceId, jobId } })
          .then(unwrapPage),
        api
          .POST('/v1/queries/contractor.report.list', { body: { workspaceId, jobId } })
          .then(unwrapPage),
      ]);
    // What the job is costing, and the AI's estimate drafts (they hold costs), are for people who may see job
    // costs: nobody else is even asked.
    const [costing, drafts] = overview.may.costs
      ? await Promise.all([
          api
            .POST('/v1/queries/contractor.job.costing', { body: { workspaceId, jobId } })
            .then(unwrapPage),
          api
            .POST('/v1/queries/contractor.estimate_draft.list', { body: { workspaceId, jobId } })
            .then(unwrapPage)
            .then((d) => d.drafts),
        ])
      : [null, []];
    // The price list is core's, read by people who see the business's money: everyone else types a material's name.
    const products = got.workspace.permissions.includes('money.read')
      ? (await api.POST('/v1/queries/product.list', { body: { workspaceId } }).then(unwrapPage))
          .products
      : [];
    return (
      <JobPage
        workspaceId={workspaceId}
        job={job}
        overview={overview}
        estimates={estimates.estimates}
        materials={materials}
        time={time}
        notes={notes}
        reports={reports}
        costing={costing}
        drafts={drafts}
        products={products.map((p) => ({ id: p.id, name: p.name, unitLabel: p.unitLabel }))}
        myUserId={userId}
        timeZone={got.workspace.timezone}
        staff={members.members.map((m) => ({ userId: m.userId, fullName: m.fullName || m.email }))}
      />
    );
  });
}
