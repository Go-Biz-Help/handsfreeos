'use client';
import { ASSISTANT_WORDS } from '@hfos/core';
import { Archive, ChevronLeft, MoreHorizontal, Pencil } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AssistantThreadSummary } from '@/lib/api/types';
import { chatWhen } from '@/lib/assistant/format';
import { cn } from '@/lib/utils';
import { useAssistant } from './assistant-provider';

function RenameDialog({
  thread,
  onClose,
  onSaved,
}: {
  thread: AssistantThreadSummary;
  onClose: () => void;
  onSaved: (title: string) => void;
}) {
  const { workspaceId } = useAssistant();
  const [title, setTitle] = useState(thread.title);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const next = title.trim();
    if (!next) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/assistant_thread.rename', {
          body: { workspaceId, threadId: thread.id, title: next },
        }),
      );
      onSaved(next);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={ASSISTANT_WORDS.history.renameTitle}>
        <form onSubmit={(e) => void save(e)} className="mt-4">
          <Field label="Name" htmlFor="assistant-chat-title">
            <Input
              id="assistant-chat-title"
              autoFocus
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!title.trim()}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Your chats with the Assistant here, newest first: open one, rename it or archive it. */
export function ThreadList({ phone }: { phone: boolean }) {
  const a = useAssistant();
  const [items, setItems] = useState<AssistantThreadSummary[] | null>(null);
  const [renaming, setRenaming] = useState<AssistantThreadSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/assistant_thread.list', {
        body: { workspaceId: a.workspaceId, limit: 30 },
      })
      .then(unwrap)
      .then((r) => !cancelled && setItems(r.items))
      .catch((e: unknown) => {
        if (cancelled) return;
        setItems([]);
        toast.error(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [a.workspaceId]);

  async function archive(thread: AssistantThreadSummary) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/assistant_thread.archive', {
          body: { workspaceId: a.workspaceId, threadId: thread.id },
        }),
      );
      setItems((all) => all?.filter((t) => t.id !== thread.id) ?? null);
      a.forgetThread(thread.id);
      toast.success(ASSISTANT_WORDS.history.archived);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 py-3"
      data-testid="assistant-history"
    >
      <Button
        variant="ghost"
        size={phone ? 'lg' : 'sm'}
        className="mx-1 mb-1.5 self-start"
        onClick={() => a.setView('chat')}
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
        {ASSISTANT_WORDS.history.back}
      </Button>
      {items === null ? (
        <p role="status" className="px-3 py-2 text-[13px] text-text-3">
          {ASSISTANT_WORDS.history.loading}
        </p>
      ) : items.length === 0 ? (
        <p className="px-3 py-2 text-[13px] text-text-2">{ASSISTANT_WORDS.history.empty}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((t) => {
            const active = t.id === a.threadId;
            return (
              <li
                key={t.id}
                className={cn(
                  'group flex items-center rounded-control transition-colors',
                  active ? 'bg-accent-soft' : 'hover:bg-card-2',
                )}
              >
                <button
                  type="button"
                  onClick={() => void a.openThread(t.id)}
                  aria-current={active || undefined}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-control px-3 py-[9px] text-left max-md:min-h-[52px] max-md:justify-center"
                >
                  <span className="truncate text-[13px] font-medium max-md:text-sm">{t.title}</span>
                  <span className="text-xs text-text-3">{chatWhen(t.lastMessageAt)}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`More for ${t.title}`}
                      className="mr-1 flex h-8 w-8 flex-none items-center justify-center rounded-control text-text-3 opacity-0 transition-opacity hover:bg-card-3 hover:text-text focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 max-md:h-11 max-md:w-11 max-md:opacity-100"
                    >
                      <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.5} />
                    </button>
                  </DropdownMenuTrigger>
                  {/* Above the full-screen panel on phones. */}
                  <DropdownMenuContent className="z-[60]">
                    <DropdownMenuItem onSelect={() => setRenaming(t)}>
                      <Pencil className="h-4 w-4" strokeWidth={1.5} />
                      {ASSISTANT_WORDS.history.rename}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void archive(t)}>
                      <Archive className="h-4 w-4" strokeWidth={1.5} />
                      {ASSISTANT_WORDS.history.archive}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        </ul>
      )}
      <p className="px-3 pt-3.5 text-xs text-text-3">{ASSISTANT_WORDS.history.privacy}</p>
      {renaming ? (
        <RenameDialog
          thread={renaming}
          onClose={() => setRenaming(null)}
          onSaved={(title) => {
            setItems(
              (all) => all?.map((t) => (t.id === renaming.id ? { ...t, title } : t)) ?? null,
            );
            setRenaming(null);
          }}
        />
      ) : null}
    </div>
  );
}
