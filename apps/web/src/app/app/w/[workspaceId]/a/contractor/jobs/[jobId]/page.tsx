import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { JobPage } from '@/addons/contractor/job-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Job' };

/**
 * One job: its status, details, phases and % done, team, visits, its estimates, and (for people who may see job costs)
 * its price and budget. A job that isn't here, or was archived, is the business's not-found page.
 */
export default async function ContractorJobPage({
  params,
}: {
  params: Promise<{ workspaceId: string; jobId: string }>;
}) {
  const { workspaceId, jobId } = await params;
  return addonPage(workspaceId, 'contractor', 'contractor.use', async () => {
    const { api, userId } = await apiServer();
    const [got, overview, job, members, estimates] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/contractor.overview', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/contractor.job.get', { body: { workspaceId, jobId } }).then(unwrapPage),
      api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/contractor.estimate.list', { body: { workspaceId, jobId } })
        .then(unwrapPage),
    ]);
    return (
      <JobPage
        workspaceId={workspaceId}
        job={job}
        overview={overview}
        estimates={estimates.estimates}
        myUserId={userId}
        timeZone={got.workspace.timezone}
        staff={members.members.map((m) => ({ userId: m.userId, fullName: m.fullName || m.email }))}
      />
    );
  });
}
