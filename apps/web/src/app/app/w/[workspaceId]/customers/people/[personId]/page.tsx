import type { Metadata } from 'next';
import { RecordPage } from '@/components/crm/record-page';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Customer' };

const DAY = 86_400_000;
const range = (from: number, to: number) => ({
  from: new Date(from).toISOString(),
  to: new Date(to).toISOString(),
});

export default async function PersonPage({
  params,
}: {
  params: Promise<{ workspaceId: string; personId: string }>;
}) {
  const { workspaceId, personId } = await params;
  const { api, userId } = await apiServer();
  const now = Date.now();
  const [
    got,
    person,
    timeline,
    tasks,
    files,
    leads,
    tags,
    members,
    pipelines,
    soon,
    before,
    relationships,
    relationshipTypes,
    fields,
  ] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/person.get', { body: { workspaceId, personId } }).then(unwrapPage),
    api
      .POST('/v1/queries/timeline.list', {
        body: { workspaceId, recordType: 'person', recordId: personId, limit: 30 },
      })
      .then(unwrapPage),
    api
      .POST('/v1/queries/task.list', {
        body: { workspaceId, scope: 'all', status: 'all', personId, limit: 100 },
      })
      .then(unwrapPage),
    api
      .POST('/v1/queries/file.list', {
        body: { workspaceId, recordType: 'person', recordId: personId },
      })
      .then(unwrapPage),
    api
      .POST('/v1/queries/lead.list', { body: { workspaceId, personId, limit: 50 } })
      .then(unwrapPage),
    api.POST('/v1/queries/tag.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/pipeline.list', { body: { workspaceId } }).then(unwrapPage),
    // The appointment list reads at most 62 days at a time: the next and the last 62.
    api
      .POST('/v1/queries/appointment.list', {
        body: { workspaceId, personId, ...range(now, now + 62 * DAY) },
      })
      .then(unwrapPage),
    api
      .POST('/v1/queries/appointment.list', {
        body: { workspaceId, personId, ...range(now - 62 * DAY, now) },
      })
      .then(unwrapPage),
    api
      .POST('/v1/queries/relationship.list', {
        body: { workspaceId, recordType: 'person', recordId: personId },
      })
      .then(unwrapPage),
    api.POST('/v1/queries/relationship_type.list', { body: { workspaceId } }).then(unwrapPage),
    api
      .POST('/v1/queries/custom_field.list', { body: { workspaceId, entity: 'person' } })
      .then(unwrapPage),
  ]);
  return (
    <RecordPage
      workspaceId={workspaceId}
      myUserId={userId}
      permissions={got.workspace.permissions}
      person={person.person}
      timeline={timeline}
      tasks={tasks.items}
      files={files.files}
      leads={leads.items}
      tags={tags.tags}
      members={assigneeOptions(members)}
      pipelines={pipelines.pipelines}
      timeZone={got.workspace.timezone}
      upcoming={soon.items.filter((a) => Date.parse(a.endsAt) > now)}
      recent={before.items.filter((a) => Date.parse(a.endsAt) <= now).reverse()}
      relationships={relationships.items}
      relationshipTypes={relationshipTypes.types}
      fields={fields.fields}
    />
  );
}
