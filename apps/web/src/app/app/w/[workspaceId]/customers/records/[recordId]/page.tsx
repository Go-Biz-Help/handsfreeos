import type { Metadata } from 'next';
import { CustomRecordPage } from '@/components/relationships/custom-record-page';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Record' };

const DAY = 86_400_000;
const range = (from: number, to: number) => ({
  from: new Date(from).toISOString(),
  to: new Date(to).toISOString(),
});

/** One pet, vehicle or property (0101): its own page, like a customer's. */
export default async function RecordPage({
  params,
}: {
  params: Promise<{ workspaceId: string; recordId: string }>;
}) {
  const { workspaceId, recordId } = await params;
  const { api, userId } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const now = Date.now();
  const [record, timeline, tasks, files, members, relationships, relationshipTypes, soon, before] =
    await Promise.all([
      unwrapPage(
        await api.POST('/v1/queries/custom_record.get', {
          body: { workspaceId, customRecordId: recordId },
        }),
      ),
      unwrapPage(
        await api.POST('/v1/queries/timeline.list', {
          body: { workspaceId, recordType: 'custom_record', recordId, limit: 30 },
        }),
      ),
      unwrapPage(
        await api.POST('/v1/queries/task.list', {
          body: { workspaceId, scope: 'all', status: 'all', customRecordId: recordId, limit: 100 },
        }),
      ),
      unwrapPage(
        await api.POST('/v1/queries/file.list', {
          body: { workspaceId, recordType: 'custom_record', recordId },
        }),
      ),
      unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
      unwrapPage(
        await api.POST('/v1/queries/relationship.list', {
          body: { workspaceId, recordType: 'custom_record', recordId },
        }),
      ),
      unwrapPage(await api.POST('/v1/queries/relationship_type.list', { body: { workspaceId } })),
      // The appointment list reads at most 62 days at a time: the next and the last 62.
      unwrapPage(
        await api.POST('/v1/queries/appointment.list', {
          body: { workspaceId, customRecordId: recordId, ...range(now, now + 62 * DAY) },
        }),
      ),
      unwrapPage(
        await api.POST('/v1/queries/appointment.list', {
          body: { workspaceId, customRecordId: recordId, ...range(now - 62 * DAY, now) },
        }),
      ),
    ]);
  const { fields } = unwrapPage(
    await api.POST('/v1/queries/custom_field.list', {
      body: { workspaceId, recordTypeId: record.record.type.id },
    }),
  );
  return (
    <CustomRecordPage
      workspaceId={workspaceId}
      myUserId={userId}
      role={got.workspace.role}
      record={record.record}
      fields={fields}
      timeline={timeline}
      tasks={tasks.items}
      files={files.files}
      relationships={relationships.items}
      relationshipTypes={relationshipTypes.types}
      members={assigneeOptions(members)}
      timeZone={got.workspace.timezone}
      upcoming={soon.items.filter((a) => Date.parse(a.endsAt) > now)}
      recent={before.items.filter((a) => Date.parse(a.endsAt) <= now).reverse()}
    />
  );
}
