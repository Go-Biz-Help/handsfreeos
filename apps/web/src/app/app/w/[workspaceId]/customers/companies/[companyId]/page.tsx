import type { Metadata } from 'next';
import { RecordPage } from '@/components/crm/record-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Company' };

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ workspaceId: string; companyId: string }>;
}) {
  const { workspaceId, companyId } = await params;
  const { api, userId } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const [company, timeline, tasks, files, leads, tags, members, pipelines] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/company.get', { body: { workspaceId, companyId } })),
    unwrapPage(
      await api.POST('/v1/queries/timeline.list', {
        body: { workspaceId, recordType: 'company', recordId: companyId, limit: 30 },
      }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/task.list', {
        body: { workspaceId, scope: 'all', status: 'all', companyId, limit: 100 },
      }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/file.list', {
        body: { workspaceId, recordType: 'company', recordId: companyId },
      }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/lead.list', { body: { workspaceId, companyId, limit: 50 } }),
    ),
    unwrapPage(await api.POST('/v1/queries/tag.list', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/pipeline.list', { body: { workspaceId } })),
  ]);
  return (
    <RecordPage
      workspaceId={workspaceId}
      myUserId={userId}
      role={got.workspace.role}
      company={company.company}
      companyPeople={company.people}
      timeline={timeline}
      tasks={tasks.items}
      files={files.files}
      leads={leads.items}
      tags={tags.tags}
      members={members.members.map((m) => ({ id: m.userId, fullName: m.fullName || m.email }))}
      pipelines={pipelines.pipelines}
    />
  );
}
