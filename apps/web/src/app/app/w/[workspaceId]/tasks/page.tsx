import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { TasksPage } from '@/components/tasks/tasks-page';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Tasks' };

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
  const { api, userId } = await apiServer();
  const [got, open, done, members] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } })),
    unwrapPage(
      await api.POST('/v1/queries/task.list', {
        body: { workspaceId, scope, status: 'open', limit: 100 },
      }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/task.list', {
        body: { workspaceId, scope, status: 'done', limit: 10 },
      }),
    ),
    unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
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
    />
  );
}
