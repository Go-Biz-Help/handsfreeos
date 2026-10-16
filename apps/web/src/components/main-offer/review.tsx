'use client';
import {
  clearsBar,
  goingInto,
  MAIN_OFFER_BAR,
  MAIN_OFFER_LIMITS,
  MAIN_OFFER_TRY_WORDS as TW,
  MAIN_OFFER_WORDS as W,
  OFFER_DIRECTION_PICKS,
  OFFER_NOTE_PICKS,
  offerChecks,
  partSays,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  underBarTitle,
  type MainOfferParts,
  type MainOfferScore,
  type ScoredPart,
} from '@hfos/core';
import {
  ChevronDown,
  CircleAlert,
  Check,
  Compass,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  Sparkles,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { AI_SOFT, AI_TEXT } from '@/components/workflows/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** A line added to a note or the direction: after what's there, with a space. */
export const withLine = (was: string, line: string) => {
  const t = was.trim();
  return t ? `${t} ${line}` : line;
};

/** A part's score as a short bar, green at the bar and over, amber under it. */
export function ScoreBar({ label, score }: { label: string; score: number }) {
  return (
    <span
      className="block h-1.5 w-full max-w-[320px] overflow-hidden rounded-full bg-card-3"
      role="img"
      aria-label={`${label}: ${score} out of 10`}
    >
      <span
        className={cn(
          'block h-full rounded-full',
          score >= MAIN_OFFER_BAR ? 'bg-success' : 'bg-warning',
        )}
        style={{ width: `${score * 10}%` }}
      />
    </span>
  );
}

/** A part's number in a round badge, green at the bar and over, amber under it. */
export function ScoreDot({ score }: { score: number }) {
  return (
    <span
      className={cn(
        'inline-flex h-8 w-8 flex-none items-center justify-center rounded-full text-[14px] font-semibold tabular-nums',
        score >= MAIN_OFFER_BAR
          ? 'bg-success-soft text-success-text'
          : 'bg-warning-soft text-warning-text',
      )}
    >
      {score}
    </span>
  );
}

/** A small chip on a part: kept as is, your note, scored with your direction. */
function Tag({ tone, children }: { tone: 'plain' | 'accent' | 'ai'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-[6px] px-[7px] text-xs font-medium',
        tone === 'plain' && 'bg-card-2 text-text-2',
        tone === 'accent' && 'bg-accent-soft text-accent-text',
        tone === 'ai' && cn(AI_SOFT, AI_TEXT),
      )}
    >
      {children}
    </span>
  );
}

/** "Scored with your direction", beside a part the owner's direction changed the judging of. */
export function WithDirection() {
  return <Tag tone="ai">{TW.withDirection}</Tag>;
}

/** What a part needs from the owner on the review step: a note for the AI and whether to keep it. */
export interface PartEdits {
  readonly note: string;
  readonly onNote: (note: string) => void;
  readonly kept: boolean;
  readonly onKeep: (kept: boolean) => void;
  readonly onEdit: () => void;
}

/**
 * One part of the offer, scored: the number and its headline, and opened, what it says now, what's working, what's
 * holding it back and the AI's fix. On the review step it also takes a note for the AI and Keep this part as is.
 */
export function PartCard({
  part,
  parts,
  score,
  edits,
  defaultOpen = false,
}: {
  part: ScoredPart;
  parts: MainOfferParts;
  score: MainOfferScore;
  edits?: PartEdits;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const s = score.parts[part];
  const label = SCORED_PART_LABELS[part];
  const low = s.score < MAIN_OFFER_BAR;
  const says = partSays(parts, part);
  const bodyId = `offer-part-${part}-body`;
  return (
    <section
      className={cn(
        'rounded-card border bg-card shadow-1',
        low ? 'border-[color-mix(in_oklab,var(--warning)_45%,var(--border))]' : 'border-border',
      )}
      data-testid={`offer-part-${part}`}
      data-score={s.score}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
        className="grid w-full grid-cols-[minmax(0,1fr)_32px_18px] items-center gap-3.5 rounded-card px-4 py-3.5 text-left transition-colors hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring md:grid-cols-[100px_minmax(0,1fr)_auto_32px_18px]"
        data-testid={`offer-part-${part}-toggle`}
      >
        <span className="text-[15px] font-semibold">{label}</span>
        <span className="hidden min-w-0 flex-col gap-1.5 md:flex">
          <ScoreBar label={label} score={s.score} />
          <span className="truncate text-[13px] text-text-2">{s.why}</span>
        </span>
        <span className="hidden flex-wrap justify-end gap-1.5 md:flex">
          {edits?.kept ? (
            <Tag tone="plain">
              <Lock className="h-3 w-3" strokeWidth={1.75} />
              {TW.keptAsIs}
            </Tag>
          ) : null}
          {edits?.note.trim() ? (
            <Tag tone="accent">
              <MessageSquare className="h-3 w-3" strokeWidth={1.75} />
              {TW.hasNote}
            </Tag>
          ) : null}
          {s.followedDirection ? <WithDirection /> : null}
        </span>
        <ScoreDot score={s.score} />
        <ChevronDown
          className={cn('h-[18px] w-[18px] text-text-3 transition-transform', open && 'rotate-180')}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>
      {open ? (
        <div id={bodyId} className="flex flex-col gap-4 border-t border-border p-4">
          <div className="flex flex-col gap-1.5 rounded-menu bg-card-2 px-3.5 py-3">
            <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              {TW.saysNow}
            </span>
            <p className="text-[15px] leading-[1.55]">{says || W.notYet}</p>
          </div>
          <p className="text-[13.5px] text-text-2 md:hidden">{s.why}</p>
          {s.good?.length || s.holding?.length ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Lines title={TW.working} tone="ok" lines={s.good ?? []} />
              <Lines title={TW.holding} tone="low" lines={s.holding ?? []} />
            </div>
          ) : null}
          {s.fix ? (
            <div className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3.5 py-3 text-[13.5px] text-warning-text">
              <Sparkles className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
              <span>
                <b>{TW.aiFix}</b> {s.fix}
              </span>
            </div>
          ) : null}
          {edits ? <PartNote part={part} edits={edits} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function Lines({ title, tone, lines }: { title: string; tone: 'ok' | 'low'; lines: string[] }) {
  if (!lines.length) return <div />;
  return (
    <div className="flex flex-col gap-2">
      <span
        className={cn(
          'text-[11.5px] font-semibold uppercase tracking-[0.04em]',
          tone === 'ok' ? 'text-success-text' : 'text-warning-text',
        )}
      >
        {title}
      </span>
      <ul className="flex flex-col gap-2">
        {lines.map((l) => (
          <li key={l} className="flex items-start gap-2 text-[13.5px]">
            {tone === 'ok' ? (
              <Check className="mt-0.5 h-4 w-4 flex-none text-success" strokeWidth={2} />
            ) : (
              <CircleAlert className="mt-0.5 h-4 w-4 flex-none text-warning" strokeWidth={1.75} />
            )}
            <span>{l}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Quick picks that add a line to a note or the direction. */
function Picks({
  picks,
  onPick,
  testId,
}: {
  picks: readonly (readonly [string, string])[];
  onPick: (line: string) => void;
  testId: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {picks.map(([label, line], i) => (
        <button
          key={label}
          type="button"
          onClick={() => onPick(line)}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border-strong bg-card px-3 text-[13px] text-text-2 transition-colors hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          data-testid={`${testId}-${i}`}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          {label}
        </button>
      ))}
    </div>
  );
}

function PartNote({ part, edits }: { part: ScoredPart; edits: PartEdits }) {
  const id = `offer-note-${part}`;
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id} className="mb-0">
          {TW.yourNote}
        </Label>
        <Textarea
          id={id}
          rows={3}
          value={edits.note}
          maxLength={MAIN_OFFER_LIMITS.note}
          placeholder={TW.notePlaceholder}
          onChange={(e) => edits.onNote(e.target.value)}
          data-testid={`offer-part-${part}-note`}
        />
        <Picks
          picks={OFFER_NOTE_PICKS}
          onPick={(line) => edits.onNote(withLine(edits.note, line))}
          testId={`offer-part-${part}-pick`}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Checkbox
          label={TW.keepAsIs}
          checked={edits.kept}
          onChange={(e) => edits.onKeep(e.target.checked)}
          data-testid={`offer-part-${part}-keep`}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={edits.onEdit}
          data-testid={`offer-part-${part}-edit`}
        >
          <Pencil className="h-4 w-4" strokeWidth={1.75} />
          {TW.editMyself}
        </Button>
      </div>
    </>
  );
}

/** The score at a glance: which parts are under the bar, every part's number, and the quick checks. */
export function ScoreGlance({
  score,
  scoredAt,
}: {
  score: MainOfferScore;
  scoredAt?: string | null;
}) {
  return (
    <Card
      className="flex flex-col gap-3.5 px-5 py-4"
      data-testid="offer-score"
      data-clears={clearsBar(score) ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[15px] font-semibold" data-testid="offer-score-title">
            {underBarTitle(score)}
          </span>
          <span className="max-w-[560px] text-[13px] text-text-2">{score.fix}</span>
          {scoredAt ? (
            <span className="text-xs tabular-nums text-text-3">{W.scoredAt(scoredAt)}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SCORED_PARTS.map((p) => {
            const n = score.parts[p].score;
            const ok = n >= MAIN_OFFER_BAR;
            return (
              <span
                key={p}
                className={cn(
                  'inline-flex h-8 items-center gap-2 rounded-full border bg-card pl-3 pr-[5px] text-[13px] font-medium',
                  ok
                    ? 'border-border'
                    : 'border-[color-mix(in_oklab,var(--warning)_50%,var(--border))]',
                )}
              >
                {SCORED_PART_LABELS[p]}
                <b
                  className={cn(
                    'inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full text-xs font-semibold tabular-nums',
                    ok ? 'bg-success-soft text-success-text' : 'bg-warning-soft text-warning-text',
                  )}
                >
                  {n}
                </b>
              </span>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border pt-3">
        {offerChecks(score).map(({ text, ok }) => (
          <span key={text} className="inline-flex items-center gap-2 text-[13px]">
            <Badge variant={ok ? 'ok' : 'pending'}>{ok ? W.yes : W.notYet}</Badge>
            {text}
          </span>
        ))}
      </div>
    </Card>
  );
}

/** The owner's direction for the whole offer, what goes into the next try, and Make a try. */
export function DirectionBox({
  direction,
  onDirection,
  notes,
  keep,
  nextTry,
  busy,
  disabled,
  onMake,
}: {
  direction: string;
  onDirection: (direction: string) => void;
  notes: Partial<Record<ScoredPart, string>>;
  keep: readonly ScoredPart[];
  nextTry: string;
  busy: boolean;
  disabled: boolean;
  onMake: () => void;
}) {
  const going = goingInto(direction, notes, keep);
  return (
    <section
      aria-labelledby="offer-direction-title"
      className="flex flex-col gap-3.5 rounded-card border border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] bg-card p-5 shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_12%,transparent),var(--shadow-1)]"
      data-testid="offer-direction-box"
    >
      <div className="flex items-start gap-3.5">
        <span className="inline-flex h-[38px] w-[38px] flex-none items-center justify-center rounded-menu bg-accent-soft text-accent-text">
          <Compass className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </span>
        <div className="flex flex-col gap-1">
          <h2 id="offer-direction-title" className="text-[18px] font-semibold tracking-[-0.01em]">
            {TW.directionTitle}
          </h2>
          <p className="max-w-[640px] text-text-2">{TW.directionHint}</p>
        </div>
      </div>
      <Label htmlFor="offer-direction" className="mb-0">
        {TW.directionLabel}
      </Label>
      <Textarea
        id="offer-direction"
        rows={5}
        value={direction}
        maxLength={MAIN_OFFER_LIMITS.direction}
        placeholder={TW.directionPlaceholder}
        onChange={(e) => onDirection(e.target.value)}
        data-testid="offer-direction"
      />
      <Picks
        picks={OFFER_DIRECTION_PICKS}
        onPick={(line) => onDirection(withLine(direction, line))}
        testId="offer-direction-pick"
      />
      <div className="flex flex-col gap-2 rounded-menu bg-card-2 px-3.5 py-3">
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {TW.goingInto(nextTry)}
        </span>
        <div className="flex flex-wrap gap-1.5" data-testid="offer-going-into">
          {going.map((g) => (
            <Tag key={g.key} tone={g.kept ? 'plain' : 'accent'}>
              {g.text}
            </Tag>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3.5 pt-1">
        <Button
          size="lg"
          loading={busy}
          disabled={disabled}
          onClick={onMake}
          data-testid="offer-make-try"
        >
          {busy ? TW.making(nextTry) : TW.makeTry(nextTry)}
        </Button>
        <span className="text-[13px] text-text-3">{TW.draftStays}</span>
      </div>
    </section>
  );
}

/** One version in the Versions strip: your draft, one before a try was taken in, or one of the AI's tries. */
export interface VersionItem {
  readonly key: string;
  readonly name: string;
  readonly sub: string;
  readonly current: boolean;
  readonly ai: boolean;
  readonly onOpen?: () => void;
}

/** Your draft and the AI's tries, side by side, each with its lowest score. */
export function Versions({ items, empty }: { items: readonly VersionItem[]; empty: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {TW.versions}
      </span>
      <div className="flex flex-wrap gap-2" data-testid="offer-versions">
        {items.map((v) => {
          const inner = (
            <>
              <span className="flex items-center gap-1.5 font-semibold">
                {v.ai ? (
                  <Sparkles className={cn('h-3.5 w-3.5', AI_TEXT)} strokeWidth={1.75} />
                ) : null}
                {v.name}
              </span>
              {v.sub ? (
                <span className="text-[12.5px] tabular-nums text-text-2">{v.sub}</span>
              ) : null}
            </>
          );
          const cls = cn(
            'flex min-h-14 min-w-[180px] flex-col items-start gap-0.5 rounded-menu border px-3.5 py-2 text-left',
            v.current
              ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
              : 'border-border bg-card',
          );
          return v.onOpen ? (
            <button
              key={v.key}
              type="button"
              aria-current={v.current ? 'true' : undefined}
              onClick={v.onOpen}
              className={cn(
                cls,
                'transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                !v.current && 'hover:bg-card-2',
              )}
              data-testid={`offer-version-${v.key}`}
            >
              {inner}
            </button>
          ) : (
            <div key={v.key} className={cls} data-testid={`offer-version-${v.key}`}>
              {inner}
            </div>
          );
        })}
        {empty ? (
          <div className="flex min-h-14 min-w-[240px] flex-1 items-center gap-2 rounded-menu border border-dashed border-border-strong px-3.5 py-2 text-[13px] text-text-2">
            <Plus className="h-4 w-4 flex-none" strokeWidth={1.75} />
            {TW.noTries}
          </div>
        ) : null}
      </div>
    </div>
  );
}
