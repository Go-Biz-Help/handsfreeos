import type { Metadata } from 'next';
import Link from 'next/link';
import { LeadDetail } from '@/components/pipeline/lead-detail';
import { leadQualificationOf } from '@/lib/ai-team/inbox-types';
import { teammateConfigOf } from '@/lib/ai-team/inbox-words';
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
  const [got, lead, timeline, tasks, files, tags, members] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/lead.get', { body: { workspaceId, leadId } }).then(unwrapPage),
    api
      .POST('/v1/queries/timeline.list', {
        body: { workspaceId, recordType: 'lead', recordId: leadId, limit: 30 },
      })
      .then(unwrapPage),
    api
      .POST('/v1/queries/task.list', {
        body: { workspaceId, scope: 'all', status: 'all', leadId, limit: 100 },
      })
      .then(unwrapPage),
    api
      .POST('/v1/queries/file.list', {
        body: { workspaceId, recordType: 'lead', recordId: leadId },
      })
      .then(unwrapPage),
    api.POST('/v1/queries/tag.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
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
  // Qualifying answers name the teammate that asked them, and its questions name what's still missing.
  const teammate = leadQualificationOf(lead.lead)
    ? await api
        .POST('/v1/queries/ai_teammate.get', { body: { workspaceId } })
        .then((r) => {
          const t = r.data?.teammate;
          if (!t) return null;
          const config = teammateConfigOf(t.config);
          return {
            name: t.name,
            questions: (config?.qualify.questions ?? []).map((q) => ({
              id: q.id,
              question: q.question,
            })),
          };
        })
        .catch(() => null)
    : null;
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
          permissions={got.workspace.permissions}
          tags={tags.tags}
          timeZone={got.workspace.timezone}
          upcoming={upcoming}
          teammate={teammate}
        />
      </div>
    </>
  );
}
