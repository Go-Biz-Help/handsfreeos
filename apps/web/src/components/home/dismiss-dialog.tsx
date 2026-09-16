'use client';
import { moneyLabel } from '@hfos/core';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { AttentionItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { customerOf, firstNameOf, LEAD_KINDS } from './attention-words';

const LEAD_REASONS = [
  'Already taken care of',
  'Not a real lead',
  'They’re not interested',
  'Something else',
] as const;
const OTHER_REASONS = ['Already taken care of', 'Not needed', 'Something else'] as const;
const MAX = 500;

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
  const lead = LEAD_KINDS.has(item.kind);
  const reasons = lead ? LEAD_REASONS : OTHER_REASONS;
  const first = firstNameOf(customerOf(item), 'them');
  const about = [
    item.title,
    item.valueCents > 0 && !item.valueIsEstimate ? moneyLabel(item.valueCents) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const said = [reason, note.trim()].filter(Boolean).join(': ').slice(0, MAX);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Dismiss this?" description={about}>
        <div data-testid="dismiss-dialog">
          <div className="mb-1.5 mt-4 text-[13px] font-medium">
            Why? <span className="font-normal text-text-3">Optional</span>
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
            placeholder="Add a note for your team (optional)"
            value={note}
            maxLength={MAX - 40}
            onChange={(e) => setNote(e.target.value)}
            className="mt-2.5 min-h-16"
          />
          <div className="mt-3 flex items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[12.5px] leading-[1.45] text-text-2">
            <Info className="mt-px h-4 w-4 flex-none" strokeWidth={1.5} />
            <span>
              It stays off the list until something changes, like a new message from {first}.
              {lead ? ' The lead itself doesn’t change.' : ''}
            </span>
          </div>
          <div className="mt-[18px] flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Keep it
            </Button>
            <Button data-testid="dismiss-confirm" onClick={() => onDismiss(said || null)}>
              Dismiss
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
