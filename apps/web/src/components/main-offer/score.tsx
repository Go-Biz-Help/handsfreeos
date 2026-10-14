'use client';
import {
  MAIN_OFFER_BAR,
  MAIN_OFFER_WORDS as W,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  underBar,
  type MainOfferScore,
} from '@hfos/core';
import { AlertTriangle, Check } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** A part's score as a bar, its why, and the number, green at the bar and over, amber under it. */
function PartScore({ label, score, why }: { label: string; score: number; why: string }) {
  const clears = score >= MAIN_OFFER_BAR;
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-4 py-3">
      <span className="text-[13px] font-medium">{label}</span>
      <span className="flex min-w-0 flex-col gap-1">
        <span
          className="block h-2 overflow-hidden rounded-full bg-card-2"
          role="img"
          aria-label={`${label}: ${score} out of 10`}
        >
          <span
            className={cn('block h-full rounded-full', clears ? 'bg-success' : 'bg-warning')}
            style={{ width: `${score * 10}%` }}
          />
        </span>
        <span className="text-xs text-text-2">{why}</span>
      </span>
      <Badge variant={clears ? 'ok' : 'pending'} className="tabular-nums">
        {score}
      </Badge>
    </div>
  );
}

/** The AI's score of the offer: each part, what to fix first, and the quick checks. */
export function OfferScoreView({
  score,
  scoredAt,
}: {
  score: MainOfferScore;
  scoredAt: string | null;
}) {
  const [lowest] = underBar(score);
  const checks = [
    [W.checks.threeSeconds, score.threeSeconds],
    [W.checks.vague, !score.flags.vague],
    [W.checks.generic, !score.flags.generic],
    [W.checks.hardToBelieve, !score.flags.hardToBelieve],
  ] as const;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <Card data-testid="offer-score">
        <div className="flex items-center justify-between px-4 py-3.5">
          <span className="font-semibold">{W.scoredTitle}</span>
          {scoredAt ? (
            <span className="text-xs tabular-nums text-text-3">{W.scoredAt(scoredAt)}</span>
          ) : null}
        </div>
        {SCORED_PARTS.map((p) => (
          <PartScore
            key={p}
            label={SCORED_PART_LABELS[p]}
            score={score.parts[p].score}
            why={score.parts[p].why}
          />
        ))}
      </Card>
      <div className="flex flex-col gap-4">
        {lowest ? (
          <div
            className="flex items-start gap-3 rounded-menu bg-warning-soft px-4 py-3.5 text-warning-text"
            data-testid="offer-score-fix"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
            <div className="flex flex-col gap-1">
              <span className="font-semibold">{W.fixFirst(SCORED_PART_LABELS[lowest])}</span>
              <span className="text-[13px]">{score.fix}</span>
            </div>
          </div>
        ) : (
          <div
            className="flex items-start gap-3 rounded-menu bg-success-soft px-4 py-3.5 text-success-text"
            data-testid="offer-score-clear"
          >
            <Check className="mt-0.5 h-4 w-4 flex-none" strokeWidth={2} />
            <div className="flex flex-col gap-1">
              <span className="font-semibold">{W.allClear}</span>
              <span className="text-[13px]">{score.fix}</span>
            </div>
          </div>
        )}
        <Card className="flex flex-col gap-2.5 p-4">
          <span className="font-semibold">{W.checksTitle}</span>
          {checks.map(([text, ok]) => (
            <div key={text} className="flex items-center gap-2 text-[13px]">
              <Badge variant={ok ? 'ok' : 'pending'}>{ok ? W.yes : W.notYet}</Badge>
              <span>{text}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

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
