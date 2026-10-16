'use client';
import {
  MAIN_OFFER_TRY_WORDS as TW,
  MAIN_OFFER_WORDS as W,
  partSays,
  samePart,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  type MainOfferParts,
  type MainOfferScore,
  type ScoredPart,
} from '@hfos/core';
import { Check, Lock, RotateCcw, Sparkles, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { AI_SOFT, AI_TEXT } from '@/components/workflows/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { MainOfferTry } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { WithDirection } from './review';

export type Side = 'mine' | 'try';
export type Picks = Record<ScoredPart, Side>;

export const allPicks = (side: Side): Picks =>
  Object.fromEntries(SCORED_PARTS.map((p) => [p, side])) as Picks;

/** Whether a try left a part as the draft had it: kept on purpose, or written back the same. */
export function leftAlone(t: MainOfferTry, part: ScoredPart): boolean {
  return t.keep.includes(part) || samePart(t.parts, t.base, part);
}

/** The parts picked from a try that it actually changed. */
export function takenFrom(t: MainOfferTry, picks: Picks): ScoredPart[] {
  return SCORED_PARTS.filter((p) => picks[p] === 'try' && !leftAlone(t, p));
}

const hasBlank = (s: string) => /\[[^\]]+\]/.test(s);

/** One side of a part: its score, what it says, and for the try why it changed. */
function PickSide({
  pressed,
  onPick,
  name,
  score,
  higher,
  says,
  why,
  withDirection,
  testId,
}: {
  pressed: boolean;
  onPick: () => void;
  name: string;
  score: number | null;
  higher?: boolean;
  says: string;
  why?: string | null;
  withDirection?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onPick}
      className={cn(
        'flex h-full flex-col gap-2 rounded-menu border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        pressed
          ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
          : 'border-border-strong bg-card hover:bg-card-2',
      )}
      data-testid={testId}
    >
      <span className="flex w-full items-center gap-2 text-[13px] font-semibold">
        <span
          aria-hidden
          className={cn(
            'inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border-[1.5px]',
            pressed ? 'border-accent' : 'border-border-strong',
          )}
        >
          {pressed ? <span className="h-2.5 w-2.5 rounded-full bg-accent" /> : null}
        </span>
        <span className="flex-1">{name}</span>
        {higher ? <Badge variant="ok">{TW.higher}</Badge> : null}
        {score !== null ? (
          <Badge variant={score >= 7 ? 'ok' : 'pending'} className="tabular-nums">
            {score}
          </Badge>
        ) : null}
      </span>
      <span className="text-[14px] leading-normal">{says}</span>
      {why ? (
        <span className={cn('flex items-start gap-2 text-[13px]', AI_TEXT)}>
          <Sparkles className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
          <span>{why}</span>
        </span>
      ) : null}
      {withDirection ? (
        <span>
          <WithDirection />
        </span>
      ) : null}
    </button>
  );
}

/**
 * A try beside your draft, part by part: tap the side you want for each. Every part starts on yours, and a part the
 * try left as it was shows once. Below, how the offer reads with the picks.
 */
export function CompareTry({
  t,
  draft,
  score,
  picks,
  moved,
  onPick,
}: {
  t: MainOfferTry;
  draft: MainOfferParts;
  score: MainOfferScore | null;
  picks: Picks;
  moved: boolean;
  onPick: (picks: Picks) => void;
}) {
  const name = TW.tryName(t.number);
  const taken = takenFrom(t, picks);
  const changed = SCORED_PARTS.filter((p) => !leftAlone(t, p));
  const blank = taken.some((p) => hasBlank(partSays(t.parts, p)));
  return (
    <>
      <Card className="flex flex-wrap items-start gap-3.5 p-4" data-testid="offer-followed">
        <span
          className={cn(
            'inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-control',
            AI_SOFT,
            AI_TEXT,
          )}
        >
          <Sparkles className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {TW.followed(name)}
          </span>
          {t.direction ? <p className="max-w-[720px] text-[14px]">“{t.direction}”</p> : null}
          <div className="flex flex-wrap gap-1.5">
            {SCORED_PARTS.filter((p) => t.notes[p]?.trim() && !t.keep.includes(p)).map((p) => (
              <Badge key={p} variant="accent">
                {TW.goesNote(SCORED_PART_LABELS[p])}
              </Badge>
            ))}
            {t.keep.map((p) => (
              <Badge key={p}>{TW.goesKept(SCORED_PART_LABELS[p])}</Badge>
            ))}
          </div>
        </div>
      </Card>

      {moved ? (
        <div className="rounded-menu bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2">
          {TW.movedSince}
        </div>
      ) : null}

      <Card data-testid="offer-compare">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-semibold">{TW.partByPart}</span>
            <span className="text-[13px] text-text-2">{TW.partByPartHint}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onPick(allPicks('mine'))}
              data-testid="offer-compare-keep-all"
            >
              {TW.keepAllMine}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!changed.length}
              onClick={() => onPick(allPicks('try'))}
              data-testid="offer-compare-use-all"
            >
              {TW.useAll(name)}
            </Button>
          </div>
        </div>
        <div
          aria-hidden
          className="hidden grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-t border-border bg-card-2 px-4 py-2.5 md:grid"
        >
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Part
          </span>
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {TW.yourDraft}
          </span>
          <span className={cn('text-[11.5px] font-semibold uppercase tracking-[0.04em]', AI_TEXT)}>
            {name}
          </span>
        </div>
        {SCORED_PARTS.map((p) => {
          const mine = score?.parts[p].score ?? null;
          const theirs = t.score.parts[p].score;
          const alone = leftAlone(t, p);
          return (
            <div
              key={p}
              className="grid grid-cols-1 items-start gap-3 border-t border-border px-4 py-3.5 md:grid-cols-[120px_minmax(0,1fr)]"
              data-testid={`offer-compare-${p}`}
            >
              <div className="flex flex-row items-center gap-2 md:flex-col md:items-start md:gap-1 md:pt-3">
                <b className="text-[15px] font-semibold">{SCORED_PART_LABELS[p]}</b>
                <span className="text-[12.5px] tabular-nums text-text-2">
                  {alone ? TW.keptAsIs : mine !== null ? `${mine} → ${theirs}` : `→ ${theirs}`}
                </span>
              </div>
              {alone ? (
                <div className="flex flex-col gap-1.5 rounded-menu border border-dashed border-border-strong px-3.5 py-3 text-text-2">
                  <span className="flex items-center gap-1.5 text-[13px]">
                    <Lock className="h-3.5 w-3.5" strokeWidth={1.75} />
                    {TW.keptHere(name)}
                  </span>
                  <p className="text-[14px] text-text">{partSays(draft, p)}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <PickSide
                    pressed={picks[p] === 'mine'}
                    onPick={() => onPick({ ...picks, [p]: 'mine' })}
                    name={TW.yours}
                    score={mine}
                    says={partSays(draft, p)}
                    testId={`offer-compare-${p}-mine`}
                  />
                  <PickSide
                    pressed={picks[p] === 'try'}
                    onPick={() => onPick({ ...picks, [p]: 'try' })}
                    name={name}
                    score={theirs}
                    higher={mine !== null && theirs > mine}
                    says={partSays(t.parts, p)}
                    why={t.why[p]}
                    withDirection={!!t.score.parts[p].followedDirection}
                    testId={`offer-compare-${p}-try`}
                  />
                </div>
              )}
            </div>
          );
        })}
      </Card>

      <Card className="flex flex-col gap-3 px-5 py-4" data-testid="offer-compare-preview">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {TW.readsWithPicks}
          </span>
          <span className="text-[13px] tabular-nums text-text-2">
            {TW.picked(name, taken.length, SCORED_PARTS.length - taken.length)}
          </span>
        </div>
        <ul className="flex flex-col gap-2">
          {SCORED_PARTS.map((p) => {
            const fromTry = taken.includes(p);
            return (
              <li key={p} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 text-[14px]">
                <span className="font-medium text-text-2">{SCORED_PART_LABELS[p]}</span>
                <span>
                  <span
                    className={cn(
                      fromTry &&
                        'rounded-[4px] bg-[color-mix(in_oklab,var(--accent)_22%,transparent)] px-0.5 [box-decoration-break:clone]',
                    )}
                  >
                    {partSays(fromTry ? t.parts : draft, p)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        {blank ? (
          <div className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3.5 py-3 text-[13.5px] text-warning-text">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
            <span>{TW.bracketFirst}</span>
          </div>
        ) : null}
      </Card>
    </>
  );
}

/** What the AI offers for the one line and the few words, after a mix of parts was taken. */
export interface NewLines {
  readonly line: string[];
  readonly outcome: string[];
  readonly guarantee: string[];
}
export type LineKey = keyof NewLines;
/** What was picked for each: an option's index, or null for the draft's own. */
export type LineChoice = Record<LineKey, number | null>;

/** After picks are applied: what came from the try, Restore, and a new line to pick when the parts were mixed. */
export function AppliedPanel({
  tryNumber,
  take,
  draft,
  lines,
  choice,
  onChoose,
  scoring,
  restoring,
  onRestore,
  onScore,
}: {
  tryNumber: number;
  take: readonly ScoredPart[];
  draft: MainOfferParts;
  lines: NewLines | null;
  choice: LineChoice;
  onChoose: (choice: LineChoice) => void;
  scoring: boolean;
  restoring: boolean;
  onRestore: () => void;
  onScore: () => void;
}) {
  const name = TW.tryName(tryNumber);
  const used = take.map((p) => SCORED_PART_LABELS[p].toLowerCase());
  const usedWords =
    used.length <= 1 ? used.join('') : `${used.slice(0, -1).join(', ')} and ${used.at(-1)}`;
  const mine: Record<LineKey, string> = {
    line: draft.line ?? '',
    outcome: draft.inAFewWords.outcome ?? '',
    guarantee: draft.inAFewWords.guarantee ?? '',
  };
  return (
    <>
      <div
        className="flex flex-wrap items-start gap-3 rounded-menu bg-success-soft px-4 py-3.5 text-success-text"
        data-testid="offer-applied"
      >
        <Check className="mt-0.5 h-4 w-4 flex-none" strokeWidth={2} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-semibold">{TW.usedFromTry(name, usedWords)}</span>
          <span className="text-[13px]">{TW.keptBefore(name)}</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          loading={restoring}
          onClick={onRestore}
          data-testid="offer-restore"
        >
          <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
          {TW.restore}
        </Button>
      </div>
      {lines ? (
        <Card className="flex flex-col gap-4 p-5" data-testid="offer-new-line">
          <div className="flex flex-col gap-1">
            <span className="text-[15px] font-semibold">{TW.newLineTitle}</span>
            <span className="text-[13px] text-text-2">{TW.newLineHint}</span>
          </div>
          {(['line', 'outcome', 'guarantee'] as const).map((k) => (
            <fieldset key={k} className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-[13px] font-medium">{TW.lineGroups[k]}</legend>
              <LineOption
                name={`offer-line-${k}`}
                checked={choice[k] === null}
                onChoose={() => onChoose({ ...choice, [k]: null })}
                testId={`offer-line-${k}-mine`}
              >
                <span className="text-text-3">{TW.keepMine}: </span>
                {mine[k] || W.notYet}
              </LineOption>
              {lines[k].map((o, i) => (
                <LineOption
                  key={o}
                  name={`offer-line-${k}`}
                  checked={choice[k] === i}
                  onChoose={() => onChoose({ ...choice, [k]: i })}
                  testId={`offer-line-${k}-${i}`}
                >
                  {o}
                </LineOption>
              ))}
            </fieldset>
          ))}
          <div>
            <Button size="lg" loading={scoring} onClick={onScore} data-testid="offer-line-score">
              {TW.useAndScore}
            </Button>
          </div>
        </Card>
      ) : scoring ? (
        <p className="text-[13.5px] text-text-2" data-testid="offer-scoring">
          {TW.scoringNow}
        </p>
      ) : null}
    </>
  );
}

function LineOption({
  name,
  checked,
  onChoose,
  testId,
  children,
}: {
  name: string;
  checked: boolean;
  onChoose: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-menu border px-3.5 py-2.5 text-[14px] transition-colors',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-card hover:bg-card-2',
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChoose}
        className="mt-1 h-4 w-4 flex-none accent-accent"
        data-testid={testId}
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
}
