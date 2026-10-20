import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { TasksPage } from '@/components/tasks/tasks-page';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Tasks' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function WorkspaceTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const scope = sp.scope === 'all' ? 'all' : 'mine';
  // One task a search result opens (`?task=<id>`): the page lists only 100 open and 10 done, so it's asked for on its
  // own, whoever it's for and done or not.
  const taskId = typeof sp.task === 'string' && UUID.test(sp.task) ? sp.task : null;
  const { api, userId } = await apiServer();
  const [got, open, done, members, opened] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api
      .POST('/v1/queries/task.list', {
        body: { workspaceId, scope, status: 'open', limit: 100 },
      })
      .then(unwrapPage),
    api
      .POST('/v1/queries/task.list', {
        body: { workspaceId, scope, status: 'done', limit: 10 },
      })
      .then(unwrapPage),
    api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
    taskId
      ? api
          .POST('/v1/queries/task.list', {
            body: { workspaceId, scope: 'all', status: 'all', taskId, limit: 1 },
          })
          .then((r) => r.data?.items[0] ?? null)
      : undefined,
  ]);
  return (
    <TasksPage
      workspaceId={workspaceId}
      scope={scope}
      tasks={open.items}
      done={done.items}
      timezone={open.timezone}
      members={assigneeOptions(members)}
      myUserId={userId}
      canModerate={can(got.workspace.permissions, 'records.archive')}
      openedId={taskId}
      opened={opened}
    />
  );
}
