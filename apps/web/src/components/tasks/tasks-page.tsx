'use client';
import { Plus } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import type { Task } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { TaskDialog } from './task-dialog';
import { TaskList } from './task-list';

const GROUPS: { key: Task['dueBucket']; label: string; tone?: string }[] = [
  { key: 'overdue', label: 'Overdue', tone: 'text-danger-text' },
  { key: 'today', label: 'Today', tone: 'text-accent-text' },
  { key: 'week', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: 'none', label: 'No due date' },
];

/** All of a workspace's tasks, grouped by when they are due in the workspace's time zone. */
export function TasksPage({
  workspaceId,
  scope,
  tasks,
  done,
  timezone,
  members,
  myUserId,
  canModerate,
}: {
  workspaceId: string;
  scope: 'mine' | 'all';
  tasks: Task[];
  done: Task[];
  timezone: string;
  members: { id: string; fullName: string }[];
  myUserId: string;
  canModerate: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [creating, setCreating] = useState(false);
  useLiveRefresh(['task', 'lead', 'person', 'company']);
  const groups = GROUPS.map((g) => ({
    ...g,
    items: tasks.filter((t) => t.dueBucket === g.key),
  })).filter((g) => g.items.length > 0);

  return (
    <div data-testid="tasks-page">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 md:mb-5">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
            Tasks
          </h1>
          <p className="mt-1 text-text-2">
            {tasks.length} open · due dates in {timezone.replace(/_/g, ' ')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            value={scope}
            onChange={(v) => router.replace(v === 'all' ? `${pathname}?scope=all` : pathname)}
            options={[
              { value: 'mine', label: 'Mine' },
              { value: 'all', label: 'Everyone' },
            ]}
          />
          <Button onClick={() => setCreating(true)} data-testid="tasks-new">
            <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
            New task
          </Button>
        </div>
      </div>
      {groups.length === 0 ? (
        <Card>
          <EmptyState
            title={scope === 'mine' ? 'Nothing on your list' : 'No open tasks'}
            actions={
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                New task
              </Button>
            }
          >
            Tasks you create from a customer or lead show up here, sorted by when they are due.
          </EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <section key={g.key} data-testid={`tasks-group-${g.key}`}>
              <h2
                className={`mb-1.5 text-xs font-semibold uppercase tracking-wide ${g.tone ?? 'text-text-3'}`}
              >
                {g.label} · {g.items.length}
              </h2>
              <Card>
                <TaskList
                  workspaceId={workspaceId}
                  tasks={g.items}
                  members={members}
                  myUserId={myUserId}
                  canModerate={canModerate}
                  showRelated
                />
              </Card>
            </section>
          ))}
        </div>
      )}
      {done.length > 0 ? (
        <section className="mt-6" data-testid="tasks-group-done">
          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-3">
            Recently done · {done.length}
          </h2>
          <Card>
            <TaskList
              workspaceId={workspaceId}
              tasks={done}
              members={members}
              myUserId={myUserId}
              canModerate={canModerate}
              showRelated
            />
          </Card>
        </section>
      ) : null}
      <TaskDialog
        workspaceId={workspaceId}
        open={creating}
        onOpenChange={setCreating}
        members={members}
        myUserId={myUserId}
        relation={{}}
      />
    </div>
  );
}
