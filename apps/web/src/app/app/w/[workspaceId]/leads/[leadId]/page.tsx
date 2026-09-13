import type { Metadata } from 'next';
import Link from 'next/link';
import { LeadDetail } from '@/components/pipeline/lead-detail';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Lead' };

export default async function LeadPage({
  params,
}: {
  params: Promise<{ workspaceId: string; leadId: string }>;
}) {
  const { workspaceId, leadId } = await params;
  const { api, userId } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const [lead, timeline, tasks, files, tags, members] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/lead.get', { body: { workspaceId, leadId } })),
    unwrapPage(
      await api.POST('/v1/queries/timeline.list', {
        body: { workspaceId, recordType: 'lead', recordId: leadId, limit: 30 },
      }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/task.list', {
        body: { workspaceId, scope: 'all', status: 'all', leadId, limit: 100 },
      }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/file.list', {
        body: { workspaceId, recordType: 'lead', recordId: leadId },
      }),
    ),
    unwrapPage(await api.POST('/v1/queries/tag.list', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
  ]);
  // Upcoming appointments for the lead's customer (the list reads 62 days at a time).
  const personId = lead.lead.person?.id;
  const now = Date.now();
  const upcoming = personId
    ? unwrapPage(
        await api.POST('/v1/queries/appointment.list', {
          body: {
            workspaceId,
            personId,
            from: new Date(now).toISOString(),
            to: new Date(now + 62 * 86_400_000).toISOString(),
          },
        }),
      ).items.filter((a) => Date.parse(a.endsAt) > now)
    : [];
  return (
    <>
      <div className="mb-3.5 flex items-center gap-1.5 text-[13px]">
        <Link
          href={`/app/w/${workspaceId}/pipeline?pipeline=${lead.lead.pipelineId}`}
          className="text-accent-text hover:underline"
        >
          Pipeline
        </Link>
        <span className="text-text-3">/</span>
        <span className="truncate text-text-2">{lead.lead.title}</span>
      </div>
      <div className="max-w-[860px]">
        <LeadDetail
          workspaceId={workspaceId}
          leadId={leadId}
          initial={{
            lead: lead.lead,
            stages: lead.stages,
            timeline,
            tasks: tasks.items,
            files: files.files,
          }}
          members={assigneeOptions(members)}
          myUserId={userId}
          role={got.workspace.role}
          tags={tags.tags}
          timeZone={got.workspace.timezone}
          upcoming={upcoming}
        />
      </div>
    </>
  );
}
