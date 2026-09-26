'use client';
/**
 * The template button beside the paperclip: the business's saved wording (Settings → Templates) for the channel
 * being written in, found by name, folder or words, and put into the box where the cursor is. The library said
 * "anyone can reach for these when they write a message" long before anything here let them.
 *
 * The list is read when the button is pressed, not with the conversation: most replies never open it.
 */
import * as Popover from '@radix-ui/react-popover';
import { TEMPLATE_PICKER_WORDS as W } from '@hfos/core';
import { FileText, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { TemplateList } from '@/lib/api/types';

export type PickedTemplate = TemplateList['templates'][number];

export function TemplatePicker({
  workspaceId,
  email,
  disabled,
  onPick,
  size = 'icon',
}: {
  workspaceId: string;
  /** Email templates in an email; text templates in a text or a website chat. */
  email: boolean;
  disabled?: boolean;
  onPick: (template: PickedTemplate) => void;
  /** The phone's round buttons are larger. */
  size?: 'icon' | 'phone';
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<TemplateList | null>(null);
  const channel = email ? 'email' : 'sms';

  useEffect(() => {
    if (!open) return;
    let live = true;
    setFound(null);
    void apiBrowser()
      .POST('/v1/queries/template.list', { body: { workspaceId, channel } })
      .then((r) => {
        if (live) setFound(unwrap(r));
      })
      .catch(() => {
        if (live) setFound({ templates: [], folders: [] });
      });
    return () => {
      live = false;
    };
  }, [open, workspaceId, channel]);

  const needle = q.trim().toLowerCase();
  const shown = (found?.templates ?? []).filter(
    (t) =>
      !needle ||
      t.name.toLowerCase().includes(needle) ||
      (t.folder ?? '').toLowerCase().includes(needle) ||
      t.body.toLowerCase().includes(needle),
  );
  // Folders in the library's order, then the ones filed nowhere.
  const folders = [...(found?.folders ?? []), null].filter((f) =>
    shown.some((t) => (t.folder ?? null) === f),
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {size === 'phone' ? (
          <button
            type="button"
            title={W.button}
            aria-label={W.button}
            disabled={disabled}
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-2 disabled:opacity-45"
            data-testid="composer-template"
          >
            <FileText className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            title={W.button}
            aria-label={W.button}
            disabled={disabled}
            data-testid="composer-template"
          >
            <FileText className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </Button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={6}
          collisionPadding={12}
          className="z-[60] w-[320px] max-w-[calc(100vw-24px)] rounded-card border border-border bg-card p-0 shadow-2 focus:outline-none"
          data-testid="template-picker"
        >
          <div className="p-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-2 h-[18px] w-[18px] text-text-3"
                strokeWidth={1.5}
              />
              <Input
                inputSize="sm"
                className="pl-[34px]"
                placeholder={W.search}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoFocus
                aria-label={W.search}
              />
            </div>
          </div>
          <div className="h-px bg-border" />
          <div className="max-h-[320px] overflow-y-auto p-1.5">
            {!found ? (
              <p className="px-2.5 py-3 text-[13px] text-text-3">{W.loading}</p>
            ) : !found.templates.length ? (
              <div className="px-2.5 py-3 text-[13px]">
                <p className="font-medium">{W.none(email)}</p>
                <p className="mt-0.5 text-text-3">{W.noneHint}</p>
              </div>
            ) : !shown.length ? (
              <p className="px-2.5 py-3 text-[13px] text-text-3">{W.noMatch}</p>
            ) : (
              folders.map((f) => (
                <div key={f ?? ''} className="pb-1">
                  <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-text-3">
                    {f ?? W.noFolder}
                  </p>
                  {shown
                    .filter((t) => (t.folder ?? null) === f)
                    .map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          setQ('');
                          onPick(t);
                        }}
                        className="flex w-full flex-col rounded-control px-2.5 py-2 text-left hover:bg-card-2 focus-visible:bg-card-2 focus-visible:outline-none"
                        data-testid={`template-${t.name}`}
                      >
                        <span className="truncate text-[13px] font-medium">{t.name}</span>
                        <span className="line-clamp-2 text-xs text-text-2">
                          {t.subject ? `${t.subject} · ` : ''}
                          {t.body}
                        </span>
                      </button>
                    ))}
                </div>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
