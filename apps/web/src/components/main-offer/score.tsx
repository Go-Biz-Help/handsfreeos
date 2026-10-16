'use client';
import {
  MAIN_OFFER_WORDS as W,
  SCORED_PART_LABELS,
  underBar,
  type MainOfferScore,
} from '@hfos/core';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/** Use it anyway: going live under the bar takes a reason, kept with the version. */
export function UseAnywayDialog({
  open,
  onOpenChange,
  score,
  busy,
  onGo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  score: MainOfferScore;
  busy: boolean;
  onGo: (why: string) => void;
}) {
  const [why, setWhy] = useState('');
  const [lowest] = underBar(score);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={W.anywayTitle}
        description={
          lowest ? W.anywayScored(SCORED_PART_LABELS[lowest], score.parts[lowest].score) : undefined
        }
      >
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (why.trim()) onGo(why.trim());
          }}
        >
          <div className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3.5 py-3 text-[13px] text-warning-text">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
            <span>{W.anywayNote}</span>
          </div>
          <Field label={W.anywayWhy} htmlFor="offer-anyway" hint={W.anywayHint}>
            <Input
              id="offer-anyway"
              value={why}
              maxLength={300}
              placeholder={W.anywayPlaceholder}
              onChange={(e) => setWhy(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {W.cancel}
            </Button>
            <Button
              type="submit"
              variant="secondary"
              disabled={!why.trim()}
              loading={busy}
              data-testid="offer-anyway-go"
            >
              {W.anywayGo}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
