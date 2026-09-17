'use client';
import {
  ATTENTION_WORDS,
  DISMISS_REASON_MAX,
  dismissAboutOf,
  dismissNoteOf,
  dismissReasonsOf,
  dismissSaid,
} from '@hfos/core';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { AttentionItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';

const MAX = DISMISS_REASON_MAX;

/**
 * "Dismiss this?": it asks why, but the reason is optional. The item stays off the list until something changes,
 * like a new message; the record itself doesn't change.
 */
export function DismissDialog({
  item,
  open,
  onOpenChange,
  onDismiss,
}: {
  item: AttentionItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: (reason: string | null) => void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const reasons = dismissReasonsOf(item);
  const about = dismissAboutOf(item);
  const said = dismissSaid(reason, note);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={ATTENTION_WORDS.dismissTitle} description={about}>
        <div data-testid="dismiss-dialog">
          <div className="mb-1.5 mt-4 text-[13px] font-medium">
            {ATTENTION_WORDS.why}{' '}
            <span className="font-normal text-text-3">{ATTENTION_WORDS.optional}</span>
          </div>
          <div role="radiogroup" aria-label="Why" className="flex flex-col gap-1.5">
            {reasons.map((r) => {
              const on = reason === r;
              return (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setReason(on ? null : r)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-[9px] border px-3 py-[9px] text-left text-[13px] leading-[1.4]',
                    on
                      ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
                      : 'border-border-strong bg-card hover:bg-card-2',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-px inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px]',
                      on ? 'border-accent' : 'border-border-strong',
                    )}
                  >
                    {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
                  </span>
                  {r}
                </button>
              );
            })}
          </div>
          <Textarea
            aria-label="A note for your team"
            placeholder={ATTENTION_WORDS.dismissNotePlaceholder}
            value={note}
            maxLength={MAX - 40}
            onChange={(e) => setNote(e.target.value)}
            className="mt-2.5 min-h-16"
          />
          <div className="mt-3 flex items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[12.5px] leading-[1.45] text-text-2">
            <Info className="mt-px h-4 w-4 flex-none" strokeWidth={1.5} />
            <span>{dismissNoteOf(item)}</span>
          </div>
          <div className="mt-[18px] flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {ATTENTION_WORDS.keepIt}
            </Button>
            <Button data-testid="dismiss-confirm" onClick={() => onDismiss(said)}>
              {ATTENTION_WORDS.dismissConfirm}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
