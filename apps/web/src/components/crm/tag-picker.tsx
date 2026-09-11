'use client';
import * as Popover from '@radix-ui/react-popover';
import { Check, Plus, Tag as TagIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Tag } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { TagChip } from './chips';

export const TAG_COLORS = [
  '#2d69d8',
  '#7c3aed',
  '#008743',
  '#996300',
  '#c43335',
  '#0e7490',
  '#5b616a',
];

/**
 * Picks workspace tags for a record. Controlled: the parent owns the selected ids and decides whether a
 * change is saved immediately (record page) or with the form (create dialogs).
 */
export function TagPicker({
  workspaceId,
  tags,
  selected,
  onChange,
  onTagCreated,
  compact,
}: {
  workspaceId: string;
  tags: Tag[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onTagCreated?: (tag: Tag) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(TAG_COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [localTags, setLocalTags] = useState<Tag[]>([]);
  const all = [...tags, ...localTags.filter((t) => !tags.some((x) => x.id === t.id))];
  const chosen = all.filter((t) => selected.includes(t.id));

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/tag.create', {
          body: { workspaceId, name: trimmed, color },
        }),
      );
      const tag: Tag = { id: out.tagId, name: trimmed, color, usage: 0 };
      setLocalTags((l) => [...l, tag]);
      onTagCreated?.(tag);
      onChange([...selected, tag.id]);
      setName('');
      setCreating(false);
      // Close the picker: the new tag is applied and Escape/click-away can no longer reach the dialog around it.
      setOpen(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="tag-picker">
      {chosen.map((t) => (
        <TagChip key={t.id} name={t.name} color={t.color} />
      ))}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex h-[22px] items-center gap-1 rounded-full px-1.5 text-xs font-medium text-text-2 hover:bg-card-2 hover:text-text',
              !compact && chosen.length === 0 && 'border border-dashed border-border-strong px-2',
            )}
            aria-label={compact && chosen.length > 0 ? 'Edit tags' : undefined}
          >
            {chosen.length === 0 ? (
              <TagIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
            ) : (
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            {chosen.length === 0 ? 'Add tag' : compact ? '' : 'Tag'}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className="z-50 w-[260px] rounded-menu border border-border bg-card p-1.5 shadow-2 focus:outline-none"
          >
            <div className="max-h-[240px] overflow-y-auto">
              {all.length === 0 ? (
                <div className="px-2.5 py-2 text-[13px] text-text-3">No tags yet.</div>
              ) : null}
              {all.map((t) => {
                const on = selected.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    onClick={() => toggle(t.id)}
                    className="flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-sm hover:bg-card-2"
                  >
                    <i className="h-2 w-2 rounded-full" style={{ background: t.color }} />
                    <span className="flex-1 truncate">{t.name}</span>
                    {on ? <Check className="h-4 w-4 text-accent-text" strokeWidth={2} /> : null}
                  </button>
                );
              })}
            </div>
            <div className="mt-1 border-t border-border pt-1.5">
              {creating ? (
                <div className="flex flex-col gap-2 p-1">
                  <Input
                    inputSize="sm"
                    placeholder="Tag name"
                    value={name}
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void create();
                      }
                    }}
                    aria-label="Tag name"
                  />
                  <div className="flex items-center gap-1.5">
                    {TAG_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`Color ${c}`}
                        aria-pressed={c === color}
                        onClick={() => setColor(c)}
                        className={cn(
                          'h-5 w-5 rounded-full border-2',
                          c === color ? 'border-text' : 'border-transparent',
                        )}
                        style={{ background: c }}
                      />
                    ))}
                    <span className="flex-1" />
                    <Button size="sm" loading={busy} onClick={create} data-testid="tag-create">
                      Create
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-sm hover:bg-card-2"
                  data-testid="tag-new"
                >
                  <Plus className="h-4 w-4" strokeWidth={1.75} />
                  New tag
                </button>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
