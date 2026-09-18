'use client';
import { Plus } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { TASK_GROUPS, TASK_WORDS, tasksSummary } from '@hfos/core';
import type { Task } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { TaskDialog } from './task-dialog';
import { TaskList } from './task-list';

/** The groups and their order are core's (M10 step 15); the tones are the web's classes. */
const TONE: Record<string, string | undefined> = {
  danger: 'text-danger-text',
  accent: 'text-accent-text',
  muted: undefined,
};
const GROUPS = TASK_GROUPS.map((g) => ({ key: g.key, label: g.label, tone: TONE[g.tone] }));

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
            {TASK_WORDS.title}
          </h1>
          <p className="mt-1 text-text-2">{tasksSummary(tasks.length, timezone)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            value={scope}
            onChange={(v) => router.replace(v === 'all' ? `${pathname}?scope=all` : pathname)}
            options={[
              { value: 'mine', label: TASK_WORDS.mine },
              { value: 'all', label: TASK_WORDS.everyone },
            ]}
          />
          <Button onClick={() => setCreating(true)} data-testid="tasks-new">
            <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
            {TASK_WORDS.newTask}
          </Button>
        </div>
      </div>
      {groups.length === 0 ? (
        <Card>
          <EmptyState
            title={scope === 'mine' ? TASK_WORDS.nothingOnYourList : TASK_WORDS.noOpenTasks}
            actions={
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                New task
              </Button>
            }
          >
            {TASK_WORDS.emptyPageBody}
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
            {TASK_WORDS.recentlyDone} · {done.length}
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
