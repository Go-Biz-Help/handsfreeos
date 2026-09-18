'use client';
import { Check, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { dueLabel, TASK_WORDS, taskRelatedLine } from '@hfos/core';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Task } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { TaskDialog, type TaskRelation } from './task-dialog';

/** The due words live in core (M10 step 15), so the phone's task list reads the same. */
export { dueLabel };

/** Tasks on a record (or the tasks page): complete inline, edit or delete from the row menu. */
export function TaskList({
  workspaceId,
  tasks,
  members,
  myUserId,
  canModerate,
  relation,
  leads,
  showRelated,
  emptyTitle = TASK_WORDS.emptyTitle,
  emptyHint = TASK_WORDS.emptyBody,
}: {
  workspaceId: string;
  tasks: Task[];
  members: { id: string; fullName: string }[];
  myUserId: string;
  canModerate: boolean;
  relation?: TaskRelation;
  leads?: { id: string; title: string }[];
  showRelated?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggle(t: Task) {
    setBusyId(t.id);
    try {
      if (t.doneAt)
        unwrap(
          await apiBrowser().POST('/v1/commands/task.reopen', {
            body: { workspaceId, taskId: t.id },
          }),
        );
      else {
        unwrap(
          await apiBrowser().POST('/v1/commands/task.complete', {
            body: { workspaceId, taskId: t.id },
          }),
        );
        toast.success(TASK_WORDS.completed);
      }
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }
  async function remove(t: Task) {
    if (!confirm(`Delete the task "${t.title}"?`)) return;
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/task.delete', {
          body: { workspaceId, taskId: t.id },
        }),
      );
      toast.success(TASK_WORDS.deleted);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const open = tasks.filter((t) => !t.doneAt);
  const done = tasks.filter((t) => t.doneAt);

  return (
    <div>
      {tasks.length === 0 ? (
        <EmptyState
          title={emptyTitle}
          actions={
            relation ? (
              <Button size="sm" onClick={() => setCreating(true)} data-testid="task-new">
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                New task
              </Button>
            ) : undefined
          }
        >
          {emptyHint}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border px-5 md:px-6" data-testid="task-list">
          {[...open, ...done].map((t) => {
            const due = dueLabel(t);
            const mine = t.createdBy?.id === myUserId;
            const related = taskRelatedLine(t);
            return (
              <li
                key={t.id}
                className="flex items-start gap-3.5 py-3"
                data-testid={`task-row-${t.id}`}
              >
                <button
                  type="button"
                  aria-label={t.doneAt ? TASK_WORDS.reopen : TASK_WORDS.complete}
                  aria-pressed={!!t.doneAt}
                  disabled={busyId === t.id}
                  onClick={() => void toggle(t)}
                  className={cn(
                    'mt-0.5 flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full border-[1.5px] text-white transition-colors',
                    t.doneAt
                      ? 'border-success bg-success'
                      : 'border-border-strong hover:border-accent',
                  )}
                  data-testid="task-toggle"
                >
                  {t.doneAt ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
                </button>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn('font-medium', t.doneAt && 'text-text-2 line-through')}>
                    {t.title}
                  </span>
                  <span className="truncate text-xs text-text-3">
                    {t.assignee?.fullName ?? TASK_WORDS.unassigned}
                    {showRelated && related ? ` · ${related}` : ''}
                    {t.notes ? ` · ${t.notes}` : ''}
                  </span>
                </span>
                {due.tone === 'danger' ? (
                  <Badge variant="revoked">{due.text}</Badge>
                ) : (
                  <span
                    className={cn(
                      'whitespace-nowrap text-[13px]',
                      due.tone === 'accent' ? 'font-medium text-accent-text' : 'text-text-3',
                    )}
                  >
                    {due.text}
                  </span>
                )}
                {mine || canModerate ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="Task actions"
                        className="-my-1 rounded-control p-1 text-text-3 hover:bg-card-2 hover:text-text"
                      >
                        <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => setEditing(t)}>
                        <Pencil className="h-4 w-4" strokeWidth={1.5} />
                        Edit
                      </DropdownMenuItem>
                      {t.lead ? (
                        <DropdownMenuItem asChild>
                          <Link href={`/app/w/${workspaceId}/leads/${t.lead.id}`}>
                            {TASK_WORDS.openLead}
                          </Link>
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem danger onSelect={() => void remove(t)}>
                        <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {relation && tasks.length > 0 ? (
        <div className="px-5 py-3 md:px-6">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCreating(true)}
            data-testid="task-new"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New task
          </Button>
        </div>
      ) : null}
      {relation ? (
        <TaskDialog
          workspaceId={workspaceId}
          open={creating}
          onOpenChange={setCreating}
          members={members}
          myUserId={myUserId}
          relation={relation}
          leads={leads}
        />
      ) : null}
      <TaskDialog
        workspaceId={workspaceId}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        members={members}
        myUserId={myUserId}
        initial={editing ?? undefined}
        leads={leads}
      />
    </div>
  );
}
