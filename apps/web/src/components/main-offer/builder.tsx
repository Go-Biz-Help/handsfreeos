'use client';
import {
  clearsBar,
  firstMessagePreview,
  lowestScore,
  MAIN_OFFER_BAR,
  MAIN_OFFER_LIMITS,
  MAIN_OFFER_TRY_WORDS as TW,
  MAIN_OFFER_WORDS as W,
  MainOfferParts,
  missingParts,
  offerExamples,
  offerLineFrom,
  OFFER_STEP_WORDS,
  OFFER_STEPS,
  offerStepOf,
  partWords,
  sameOffer,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  timeOfDay,
  underBar,
  withPart,
  withPartsFrom,
  type ExamplePath,
  type MainOfferScore,
  type OfferNicheOption,
  type OfferStep,
  type ScoredPart,
} from '@hfos/core';
import { ArrowLeft, ArrowUp, Check, Plus, Sparkles, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { SetupPage } from '@/components/onboarding-setup/frame';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { MainOfferGet, MainOfferTry } from '@/lib/api/types';
import {
  applyOfferTry,
  assistOffer,
  findNiche,
  makeOfferTry,
  offerAiError,
  publishOffer,
  saveOfferDirection,
  saveOfferDraft,
  scoreOffer,
} from '@/lib/main-offer/actions';
import { cn } from '@/lib/utils';
import { AiButton, AiChoice, AiChoices, OfferBoxField } from './box';
import { DirectionBox, PartCard, ScoreGlance, Versions, type VersionItem } from './review';
import { UseAnywayDialog } from './score';
import {
  allPicks,
  AppliedPanel,
  CompareTry,
  takenFrom,
  type LineChoice,
  type LineKey,
  type NewLines,
  type Picks,
} from './tries';

type Parts = MainOfferParts;
/** The last step's three views: the review, a try beside the draft, and the draft once picks are taken in. */
type View = 'review' | 'compare' | 'applied';
const NO_LINE_CHOICE: LineChoice = { line: null, outcome: null, guarantee: null };

const filled = (v: string | undefined | null) => !!v?.trim();

/** Lists go to the server without their empty lines; the screen keeps them while they're being typed. */
function cleaned(p: Parts): Parts {
  return {
    ...p,
    method: { ...p.method, steps: (p.method.steps ?? []).filter(filled) },
    proof: p.proof.filter(filled),
  };
}

/** Whether a step has what it asks for, for its tick in the list. */
function stepDone(step: OfferStep, p: Parts, score: MainOfferScore | null): boolean {
  switch (step) {
    case 'niche':
      return filled(p.niche.bestCustomer) || filled(p.niche.theirWork) || filled(p.who.work);
    case 'who':
      return filled(p.who.work) && filled(p.who.problem);
    case 'outcome':
      return filled(p.outcome.result);
    case 'timeframe':
      return filled(p.timeframe.typical);
    case 'method':
      return (p.method.steps ?? []).filter(filled).length >= 3;
    case 'guarantee':
      return filled(p.guarantee.promise);
    case 'price':
      return filled(p.price.amount);
    case 'proof':
      return p.proof.some(filled);
    case 'line':
      return filled(p.line) && filled(p.inAFewWords.outcome) && filled(p.inAFewWords.guarantee);
    case 'score':
      return !!score && clearsBar(score);
  }
}

/** What the step list says under a step once it's answered: the answer, short. */
function stepAnswer(step: OfferStep, p: Parts): string | null {
  const steps = (p.method.steps ?? []).filter(filled).length;
  const results = p.proof.filter(filled).length;
  const answer: Record<OfferStep, string | undefined> = {
    niche: [p.who.work, p.who.slice].filter(filled).join(' ') || p.niche.theirWork,
    who: p.who.problem,
    outcome: p.outcome.result,
    timeframe: p.timeframe.typical,
    method: steps ? `${steps} step${steps === 1 ? '' : 's'}` : undefined,
    guarantee: p.guarantee.promise,
    price: p.price.amount,
    proof: results ? `${results} real result${results === 1 ? '' : 's'}` : undefined,
    line: undefined,
    score: undefined,
  };
  return filled(answer[step]) ? answer[step]!.trim() : null;
}

/**
 * The main offer's builder (docs/main-offer.md), over the app in the onboarding frame: a step at a time, the steps
 * listed beside it with what's been answered, examples to model for the business's line of work, and the AI's help
 * on every box. Every move saves the draft; the live version keeps running until the last step publishes it.
 *
 * The last step reviews each part with the owner's notes and direction, and the AI's tries sit beside the draft to
 * compare and take parts from (HANDSFREEOS_MAIN_OFFER_TRIES_IMPLEMENTATION_PLAN.md); `&try=` opens one. Opened from
 * elsewhere (Social Outreach's setup), leaving and putting it live go back there (`doneHref`).
 */
export function OfferBuilder({
  workspaceId,
  businessName,
  email,
  industry,
  offer,
  tries,
  startAt,
  openTry,
  doneHref,
}: {
  workspaceId: string;
  businessName: string;
  email: string;
  industry: string | null;
  offer: MainOfferGet;
  tries: MainOfferTry[];
  startAt: OfferStep;
  openTry: string | null;
  /** Where leaving and putting it live go, when not its Settings page: the page it was opened from. */
  doneHref?: string;
}) {
  const router = useRouter();
  const settingsHref = doneHref ?? `/app/w/${workspaceId}/settings/main-offer`;
  const examples = offerExamples(industry).examples;
  const start = offer.draft?.parts ?? offer.live?.parts ?? MainOfferParts.parse({});
  const [parts, setParts] = useState<Parts>(start);
  const [step, setStep] = useState<OfferStep>(startAt);
  const [savedAt, setSavedAt] = useState<string | null>(offer.draft?.at ?? null);
  const [score, setScore] = useState<MainOfferScore | null>(offer.draft?.score ?? null);
  const [scoredAt, setScoredAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const [anyway, setAnyway] = useState(false);
  // What the saves read: the latest parts, revision and whether anything changed, whatever render is current.
  const partsRef = useRef(start);
  const revisionRef = useRef(offer.revision);
  const dirtyRef = useRef(false);
  const top = useRef<HTMLDivElement>(null);
  // The owner's direction as typed, and as kept; the notes and kept parts start from the latest try's.
  const [direction, setDirection] = useState(offer.direction ?? '');
  const keptDirectionRef = useRef(offer.direction ?? '');
  const [notes, setNotes] = useState<Partial<Record<ScoredPart, string>>>(tries[0]?.notes ?? {});
  const [keep, setKeep] = useState<ScoredPart[]>(tries[0]?.keep ?? []);
  const [allTries, setTries] = useState(tries);
  const opened = startAt === 'score' && tries.some((t) => t.id === openTry) ? openTry : null;
  const [view, setView] = useState<View>(opened ? 'compare' : 'review');
  const [tryId, setTryId] = useState<string | null>(opened);
  const [picks, setPicks] = useState<Picks>(allPicks('mine'));
  const [applied, setApplied] = useState<{
    tryId: string;
    number: number;
    take: ScoredPart[];
    before: Parts;
  } | null>(null);
  const [lines, setLines] = useState<NewLines | null>(null);
  const [lineChoice, setLineChoice] = useState<LineChoice>(NO_LINE_CHOICE);
  const current = allTries.find((t) => t.id === tryId) ?? null;
  const nextTry = TW.tryName((allTries[0]?.number ?? 0) + 1);

  function update(change: (p: Parts) => Parts) {
    const next = change(partsRef.current);
    partsRef.current = next;
    dirtyRef.current = true;
    setParts(next);
    // A score is for the draft it read; any change makes it the old one's.
    setScore(null);
  }

  /** Saves the draft when it changed; the revision it's at now, or null when it couldn't. */
  async function save(): Promise<number | null> {
    if (!dirtyRef.current) return revisionRef.current;
    setBusy((b) => b ?? 'save');
    try {
      const out = await saveOfferDraft(workspaceId, revisionRef.current, cleaned(partsRef.current));
      revisionRef.current = out.revision;
      dirtyRef.current = false;
      setSavedAt(new Date().toISOString());
      return out.revision;
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'main_offer_draft_moved') setMoved(true);
      toast.error(errorMessage(e));
      return null;
    } finally {
      setBusy((b) => (b === 'save' ? null : b));
    }
  }

  /** Saves the draft, then the direction when it changed; the revision it's at now, or null when it couldn't. */
  async function persist(): Promise<number | null> {
    const revision = await save();
    if (revision === null) return null;
    const want = direction.trim();
    if (want === keptDirectionRef.current.trim()) return revision;
    try {
      const out = await saveOfferDirection(workspaceId, revision, want);
      revisionRef.current = out.revision;
      keptDirectionRef.current = want;
      // A score is for the direction it read too.
      if (out.revision !== revision) setScore(null);
      return out.revision;
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'main_offer_draft_moved') setMoved(true);
      toast.error(errorMessage(e));
      return null;
    }
  }

  /** Keeps the address in step with the try being compared, so a reload opens the same one. */
  function remember(id: string | null) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('step', 'score');
    if (id) url.searchParams.set('try', id);
    else url.searchParams.delete('try');
    window.history.replaceState(null, '', url.toString());
  }

  function openCompare(id: string) {
    setTryId(id);
    setPicks(allPicks('mine'));
    setView('compare');
    remember(id);
    top.current?.scrollIntoView({ block: 'start' });
  }

  function backToReview() {
    setView('review');
    remember(null);
    top.current?.scrollIntoView({ block: 'start' });
  }

  async function goTo(next: OfferStep) {
    if ((await persist()) === null) return;
    if (next !== 'score' && view !== 'review') {
      setView('review');
      remember(null);
    }
    // Put it together starts from the answers when there's no line yet.
    if (next === 'line' && !filled(partsRef.current.line))
      update((p) => withPart(p, 'line', offerLineFrom(p)));
    setStep(next);
    top.current?.scrollIntoView({ block: 'start' });
  }

  async function finishLater() {
    setBusy('later');
    if ((await persist()) !== null) router.push(settingsHref);
    setBusy(null);
  }

  async function scoreNow() {
    const revision = await persist();
    if (revision === null) return;
    setBusy('score');
    try {
      const out = await scoreOffer(workspaceId, revision);
      setScore(out.score);
      setScoredAt(timeOfDay(new Date()));
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setBusy(null);
    }
  }

  /** A try of the whole offer, from the draft, the direction, the notes and the parts to keep. */
  async function makeTry() {
    const revision = await persist();
    if (revision === null) return;
    setBusy('try');
    try {
      const said = Object.fromEntries(
        SCORED_PARTS.filter((p) => notes[p]?.trim()).map((p) => [p, notes[p]!.trim()]),
      );
      const out = await makeOfferTry(workspaceId, revision, said, keep);
      if (!out.saved || !out.try) {
        toast.error(TW.tryMoved);
        return;
      }
      const made = out.try;
      setTries((ts) => [made, ...ts]);
      openCompare(made.id);
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'main_offer_draft_moved') setMoved(true);
      toast.error(offerAiError(e));
    } finally {
      setBusy(null);
    }
  }

  /** Takes the picked parts into the draft, then scores it, or first offers a line for a mix. */
  async function applyPicks() {
    if (!current) return;
    const take = takenFrom(current, picks);
    if (!take.length) return backToReview();
    const revision = await persist();
    if (revision === null) return;
    setBusy('apply');
    try {
      const before = cleaned(partsRef.current);
      const out = await applyOfferTry(workspaceId, revision, current.id, take);
      let next = withPartsFrom(before, current.parts, take);
      if (out.lineFromTry)
        next = { ...next, line: current.parts.line, inAFewWords: current.parts.inAFewWords };
      partsRef.current = next;
      dirtyRef.current = false;
      revisionRef.current = out.revision;
      setParts(next);
      setSavedAt(new Date().toISOString());
      if (out.revision !== revision) setScore(null);
      setApplied({ tryId: current.id, number: current.number, take, before });
      setLines(null);
      setLineChoice(NO_LINE_CHOICE);
      setView('applied');
      remember(null);
      top.current?.scrollIntoView({ block: 'start' });
      setBusy(null);
      if (out.lineFromTry) await scoreNow();
      else await offerLines(next);
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'main_offer_draft_moved') setMoved(true);
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }

  /** Three new lines, and few words for each, written for a mix of parts. */
  async function offerLines(p: Parts) {
    setBusy('lines');
    try {
      const [line, outcome, guarantee] = await Promise.all([
        assistOffer(workspaceId, 'line', 'write', p),
        assistOffer(workspaceId, 'inAFewWords.outcome', 'write', p),
        assistOffer(workspaceId, 'inAFewWords.guarantee', 'write', p),
      ]);
      setLines({ line: line.options, outcome: outcome.options, guarantee: guarantee.options });
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setBusy(null);
    }
  }

  /** Puts in the lines picked for the mix, then scores the draft as it now is. */
  async function scoreWithLines() {
    if (lines) {
      const pick = (k: LineKey, mine: string | undefined) => {
        const i = lineChoice[k];
        return i === null ? mine : lines[k][i];
      };
      if (Object.values(lineChoice).some((i) => i !== null))
        update((p) => ({
          ...p,
          line: pick('line', p.line),
          inAFewWords: {
            ...p.inAFewWords,
            outcome: pick('outcome', p.inAFewWords.outcome),
            guarantee: pick('guarantee', p.inAFewWords.guarantee),
          },
        }));
    }
    setLines(null);
    await scoreNow();
  }

  /** Puts the draft back as it was before the picks; the try stays listed. */
  async function restore() {
    if (!applied) return;
    const before = applied.before;
    update(() => before);
    setBusy('restore');
    const revision = await save();
    setBusy(null);
    if (revision === null) return;
    setApplied(null);
    setLines(null);
    backToReview();
  }

  async function goLive(why?: string) {
    setBusy('live');
    try {
      const out = await publishOffer(workspaceId, revisionRef.current, why);
      toast.success(W.live(out.version));
      router.push(settingsHref);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }

  const index = OFFER_STEPS.indexOf(step);
  const prev = index > 0 ? OFFER_STEPS[index - 1]! : null;
  const next = index < OFFER_STEPS.length - 1 ? OFFER_STEPS[index + 1]! : null;
  const words = OFFER_STEP_WORDS[step];
  const comparing = step === 'score' && view === 'compare' && current;
  const title = comparing ? TW.compareTitle(TW.tryName(current.number)) : words.title;
  const hint = comparing ? TW.compareHint : words.hint;
  const draftSub = score ? TW.lowest(lowestScore(score)) : TW.notScored;
  const tryItems: VersionItem[] = allTries.map((t) => ({
    key: `try-${t.number}`,
    name: TW.tryName(t.number),
    sub: TW.lowest(t.lowest),
    current: view === 'compare' && t.id === tryId,
    ai: true,
    onOpen: () => openCompare(t.id),
  }));
  const versions: VersionItem[] =
    view === 'applied' && applied
      ? [
          {
            key: 'draft',
            name: TW.yourDraft,
            sub: `${draftSub} · ${TW.updated}`,
            current: true,
            ai: false,
          },
          { key: 'before', name: TW.beforeTry(applied.number), sub: '', current: false, ai: false },
          ...tryItems,
        ]
      : [
          {
            key: 'draft',
            name: TW.yourDraft,
            sub: draftSub,
            current: view === 'review',
            ai: false,
            onOpen: view === 'review' ? undefined : backToReview,
          },
          ...tryItems,
        ];
  const taking = current ? takenFrom(current, picks).length : 0;
  const box = (path: string) => words.boxes.find((b) => b.path === path)!;
  const field = (path: string) => (
    <OfferBoxField
      key={path}
      workspaceId={workspaceId}
      box={box(path)}
      parts={parts}
      examples={examples[path as ExamplePath]}
      onChange={(w) => update((p) => withPart(p, path, w))}
    />
  );

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-bg" data-testid="offer-builder">
      <SetupPage
        business={{ name: businessName, home: settingsHref }}
        email={email}
        settingUp={W.building}
        finishLater={
          <Button
            variant="ghost"
            loading={busy === 'later'}
            onClick={() => void finishLater()}
            data-testid="offer-finish-later"
          >
            {W.finishLater}
          </Button>
        }
      >
        <div ref={top} className="w-full scroll-mt-20" />
        <Card className="grid w-full grid-cols-1 overflow-hidden rounded-dialog md:grid-cols-[272px_minmax(0,1fr)]">
          <nav
            aria-label="Steps"
            className="flex flex-col gap-0.5 border-b border-border bg-card-2 p-3 md:border-b-0 md:border-r md:py-6"
          >
            {OFFER_STEPS.map((s, i) => {
              const done = stepDone(s, parts, score);
              const answer = stepAnswer(s, parts);
              const current = s === step;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => void goTo(s)}
                  aria-current={current ? 'step' : undefined}
                  data-testid={`offer-step-${s}`}
                  className={cn(
                    'flex items-start gap-3 rounded-menu px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                    current ? 'bg-accent-soft' : 'hover:bg-card-3',
                  )}
                >
                  <span
                    className={cn(
                      'mt-px flex h-6 w-6 flex-none items-center justify-center rounded-full border-[1.5px] text-xs font-semibold',
                      current
                        ? 'border-accent bg-accent text-white'
                        : done
                          ? 'border-success bg-success text-white'
                          : 'border-border-strong bg-card text-text-2',
                    )}
                  >
                    {done && !current ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : i + 1}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className={cn('text-[14px] font-medium', current && 'text-accent-text')}>
                      {OFFER_STEP_WORDS[s].name}
                    </span>
                    <span className="truncate text-[12.5px] text-text-3">
                      {answer ?? OFFER_STEP_WORDS[s].about}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="flex min-w-0 flex-col" data-testid="offer-builder-step" data-step={step}>
            <div className="flex flex-col gap-6 p-5 sm:p-8">
              {moved ? (
                <div className="flex flex-wrap items-center gap-3 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13.5px] text-warning-text">
                  <span className="min-w-0 flex-1">
                    Someone changed this draft in the meantime. Reload to see their changes, then
                    make yours again.
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
                    Reload
                  </Button>
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
                  {W.counter(index + 1)}
                </div>
                <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.015em]">
                  {title}
                </h1>
                <p className="max-w-[660px] text-text-2">{hint}</p>
              </div>

              {step === 'niche' ? (
                <NicheStep
                  workspaceId={workspaceId}
                  parts={parts}
                  field={field}
                  onUse={(o) => {
                    update((p) => ({
                      ...p,
                      who: { ...p.who, work: o.work, slice: o.slice, problem: o.problem },
                    }));
                    void goTo('who');
                  }}
                />
              ) : step === 'method' ? (
                <MethodStep
                  workspaceId={workspaceId}
                  parts={parts}
                  example={examples['method.steps']?.[0]}
                  update={update}
                  field={field}
                />
              ) : step === 'proof' ? (
                <ProofStep
                  workspaceId={workspaceId}
                  parts={parts}
                  examples={examples.proof}
                  update={update}
                />
              ) : step === 'line' ? (
                <LineStep parts={parts} update={update} field={field} />
              ) : step === 'score' ? (
                <>
                  <Versions items={versions} empty={!allTries.length} />
                  {comparing ? (
                    <CompareTry
                      t={current}
                      draft={parts}
                      score={score}
                      picks={picks}
                      moved={!sameOffer(cleaned(parts), current.base)}
                      onPick={setPicks}
                    />
                  ) : (
                    <>
                      {view === 'applied' && applied ? (
                        <AppliedPanel
                          tryNumber={applied.number}
                          take={applied.take}
                          draft={parts}
                          lines={lines}
                          choice={lineChoice}
                          onChoose={setLineChoice}
                          scoring={busy === 'score' || busy === 'lines'}
                          restoring={busy === 'restore'}
                          onRestore={() => void restore()}
                          onScore={() => void scoreWithLines()}
                        />
                      ) : null}
                      <ScoreStep parts={parts} onGo={(s) => void goTo(s)} />
                      {score ? (
                        <>
                          <ScoreGlance score={score} scoredAt={scoredAt} />
                          <div className="flex flex-col gap-1 pt-1">
                            <h2 className="text-[18px] font-semibold tracking-[-0.01em]">
                              {TW.eachPart}
                            </h2>
                            {view === 'review' ? (
                              <p className="text-[13px] text-text-2">{TW.eachPartHint}</p>
                            ) : null}
                          </div>
                          <div className="flex flex-col gap-2.5" data-testid="offer-parts">
                            {SCORED_PARTS.map((p) => (
                              <PartCard
                                key={`${view}-${p}`}
                                part={p}
                                parts={parts}
                                score={score}
                                defaultOpen={
                                  view === 'review' && score.parts[p].score < MAIN_OFFER_BAR
                                }
                                edits={
                                  view === 'review'
                                    ? {
                                        note: notes[p] ?? '',
                                        onNote: (n) => setNotes((ns) => ({ ...ns, [p]: n })),
                                        kept: keep.includes(p),
                                        onKeep: (k) =>
                                          setKeep((ks) =>
                                            k
                                              ? [...ks.filter((x) => x !== p), p]
                                              : ks.filter((x) => x !== p),
                                          ),
                                        onEdit: () => void goTo(p),
                                      }
                                    : undefined
                                }
                              />
                            ))}
                          </div>
                        </>
                      ) : null}
                      {view === 'review' ? (
                        <DirectionBox
                          direction={direction}
                          onDirection={setDirection}
                          notes={notes}
                          keep={keep}
                          nextTry={nextTry}
                          busy={busy === 'try'}
                          disabled={!!busy && busy !== 'try'}
                          onMake={() => void makeTry()}
                        />
                      ) : null}
                    </>
                  )}
                </>
              ) : (
                <div className="grid grid-cols-1 gap-5">
                  {words.boxes.map((b) => field(b.path))}
                </div>
              )}
            </div>

            <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-border bg-card px-5 py-3 sm:px-8">
              {step === 'score' && view !== 'review' ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    view === 'applied' && applied ? openCompare(applied.tryId) : backToReview()
                  }
                  data-testid="offer-back-to-review"
                >
                  <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
                  {view === 'applied' ? TW.changePicks : TW.backToReview}
                </Button>
              ) : prev ? (
                <Button variant="ghost" onClick={() => void goTo(prev)}>
                  <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
                  {W.back}
                </Button>
              ) : null}
              {step === 'score' && view === 'review' && score ? (
                <Button
                  variant="ghost"
                  loading={busy === 'score'}
                  onClick={() => void scoreNow()}
                  data-testid="offer-score-again"
                >
                  {W.scoreAgain}
                </Button>
              ) : null}
              <div className="flex-1" />
              {savedAt ? (
                <span className="text-xs text-text-3" suppressHydrationWarning>
                  {W.saved(timeOfDay(savedAt))}
                </span>
              ) : null}
              {comparing ? (
                <>
                  <span className="text-[13px] tabular-nums text-text-2">
                    {TW.picked(TW.tryName(current.number), taking, SCORED_PARTS.length - taking)}
                  </span>
                  <Button
                    size="lg"
                    loading={busy === 'apply' || busy === 'save'}
                    onClick={() => void applyPicks()}
                    data-testid="offer-apply"
                  >
                    {TW.apply(taking)}
                  </Button>
                </>
              ) : step !== 'score' ? (
                <Button
                  size="lg"
                  loading={busy === 'save'}
                  onClick={() => {
                    if (next) void goTo(next);
                  }}
                  data-testid="offer-continue"
                >
                  {next === 'score' ? W.scoreIt : W.continue}
                </Button>
              ) : !score ? (
                view === 'applied' && (lines || busy === 'lines') ? null : (
                  <Button
                    size="lg"
                    loading={busy === 'score'}
                    onClick={() => void scoreNow()}
                    data-testid="offer-score-it"
                  >
                    <Sparkles className="h-4 w-4" strokeWidth={1.5} />
                    {W.scoreIt}
                  </Button>
                )
              ) : clearsBar(score) && !missingParts(parts).length ? (
                <Button
                  size="lg"
                  loading={busy === 'live'}
                  onClick={() => void goLive()}
                  data-testid="offer-go-live"
                >
                  {W.goLive}
                </Button>
              ) : (
                <>
                  {missingParts(parts).length ? (
                    <WeakestButton score={score} parts={parts} onGo={(s) => void goTo(s)} />
                  ) : (
                    <>
                      <Button
                        size="lg"
                        variant="secondary"
                        onClick={() => setAnyway(true)}
                        data-testid="offer-use-anyway"
                      >
                        {W.useAnyway}
                      </Button>
                      {view === 'review' ? (
                        <Button
                          size="lg"
                          loading={busy === 'try'}
                          disabled={!!busy && busy !== 'try'}
                          onClick={() => void makeTry()}
                          data-testid="offer-make-try-foot"
                        >
                          {TW.makeTry(nextTry)}
                        </Button>
                      ) : (
                        <Button size="lg" onClick={backToReview} data-testid="offer-to-review">
                          {TW.backToReview}
                        </Button>
                      )}
                    </>
                  )}
                </>
              )}
            </footer>
          </div>
        </Card>
        {score ? (
          <UseAnywayDialog
            open={anyway}
            onOpenChange={setAnyway}
            score={score}
            busy={busy === 'live'}
            onGo={(why) => void goLive(why)}
          />
        ) : null}
      </SetupPage>
    </div>
  );
}

/** "Change the guarantee": the lowest part under the bar, or the first box still missing. */
function WeakestButton({
  score,
  parts,
  onGo,
}: {
  score: MainOfferScore;
  parts: Parts;
  onGo: (step: OfferStep) => void;
}) {
  const missing = missingParts(parts)[0];
  const [lowest] = underBar(score);
  const target: OfferStep = missing ? offerStepOf(missing.path) : (lowest ?? score.weakest);
  return (
    <Button size="lg" onClick={() => onGo(target)} data-testid="offer-change-weakest">
      {missing
        ? W.goTo(OFFER_STEP_WORDS[target].name)
        : W.change(SCORED_PART_LABELS[lowest ?? score.weakest])}
    </Button>
  );
}

function NicheStep({
  workspaceId,
  parts,
  field,
  onUse,
}: {
  workspaceId: string;
  parts: Parts;
  field: (path: string) => ReactNode;
  onUse: (o: OfferNicheOption) => void;
}) {
  const [none, setNone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<OfferNicheOption[] | null>(null);

  async function find() {
    setBusy(true);
    try {
      // With no best customer, the AI is asked from the business alone.
      const asked = none ? { ...parts, niche: {} } : parts;
      const out = await findNiche(workspaceId, asked);
      if (!out.options.length) toast.error('The AI had no niches this time. Try again.');
      setOptions(out.options);
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setBusy(false);
    }
  }

  const ask = (label: string) => (
    <Button
      variant="secondary"
      loading={busy}
      onClick={() => void find()}
      data-testid="offer-find-niche"
    >
      <Sparkles className="h-4 w-4 text-accent-text" strokeWidth={1.5} />
      {label}
    </Button>
  );
  const long = OFFER_STEP_WORDS.niche.boxes.filter((b) => b.long).map((b) => b.path);
  return (
    <>
      {none ? (
        <Card className="flex flex-col gap-2.5 p-5">
          <span className="font-medium">{W.noneYetTitle}</span>
          <p className="text-[13px] text-text-2">{W.noneYet}</p>
          <div className="flex flex-wrap items-center gap-3">
            {ask(W.suggestNiches)}
            <button
              type="button"
              className="text-[13px] font-medium text-accent-text hover:underline"
              onClick={() => {
                setNone(false);
                setOptions(null);
              }}
            >
              {W.haveCustomers}
            </button>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
            {OFFER_STEP_WORDS.niche.boxes.map((b) => (
              <div key={b.path} className={cn(long.includes(b.path) && 'sm:col-span-2')}>
                {field(b.path)}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {ask(W.findNiche)}
            <button
              type="button"
              className="text-[13px] font-medium text-accent-text hover:underline"
              onClick={() => {
                setNone(true);
                setOptions(null);
              }}
              data-testid="offer-no-customers"
            >
              {W.noCustomers}
            </button>
          </div>
        </>
      )}
      {options?.length ? (
        <div className="flex flex-col gap-2.5" data-testid="offer-niches">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">{W.nichesTitle}</span>
            <span className="text-xs text-text-3">{W.fromAi}</span>
          </div>
          {options.map((o, i) => (
            <Card
              key={`${o.work}|${o.slice}`}
              className="flex flex-wrap items-center gap-3 px-4 py-3.5"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium">{[o.work, o.slice].filter(Boolean).join(' ')}</span>
                {o.problem ? <span className="text-[13px]">{o.problem}</span> : null}
                <span className="text-[13px] text-text-2">{o.why}</span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onUse(o)}
                data-testid={`offer-niche-use-${i}`}
              >
                {W.useNiche}
              </Button>
            </Card>
          ))}
        </div>
      ) : null}
    </>
  );
}

function MethodStep({
  workspaceId,
  parts,
  example,
  update,
  field,
}: {
  workspaceId: string;
  parts: Parts;
  example: string | undefined;
  update: (change: (p: Parts) => Parts) => void;
  field: (path: string) => ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [sets, setSets] = useState<string[][] | null>(null);
  const steps = parts.method.steps ?? [];
  // Three boxes to start, so nobody wonders how many.
  const shown = steps.length >= 3 ? steps : [...steps, ...Array<string>(3 - steps.length).fill('')];
  const setSteps = (list: string[]) =>
    update((p) => ({ ...p, method: { ...p.method, steps: list } }));
  const has = steps.some(filled);

  async function ask() {
    setBusy(true);
    try {
      const out = await assistOffer(workspaceId, 'method.steps', has ? 'improve' : 'write', parts);
      if (!out.steps.length) toast.error('The AI had nothing better this time. Try again.');
      else setSets(out.steps);
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <span className="text-[13px] font-medium">{W.steps}</span>
        {shown.map((s, i) => (
          <div key={i} className="grid grid-cols-[28px_minmax(0,1fr)_auto_auto] items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-card-2 text-[13px] font-semibold text-text-2">
              {i + 1}
            </span>
            <Input
              aria-label={W.stepLabel(i + 1)}
              value={s}
              maxLength={MAIN_OFFER_LIMITS.step}
              onChange={(e) => {
                const list = [...shown];
                list[i] = e.target.value;
                setSteps(list);
              }}
              data-testid={`offer-method-step-${i}`}
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label={W.moveUp(i + 1)}
              disabled={i === 0}
              onClick={() => {
                const list = [...shown];
                [list[i - 1], list[i]] = [list[i]!, list[i - 1]!];
                setSteps(list);
              }}
            >
              <ArrowUp className="h-4 w-4" strokeWidth={1.75} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={W.takeOut(i + 1)}
              disabled={shown.length <= 1}
              onClick={() => setSteps(shown.filter((_, j) => j !== i))}
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={shown.length >= MAIN_OFFER_LIMITS.steps}
            onClick={() => setSteps([...shown, ''])}
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            {W.addStep}
          </Button>
          <AiButton improve={has} busy={busy} onClick={() => void ask()} testId="offer-method-ai" />
          {example ? (
            <span className="text-xs text-text-3">
              {W.examples} {example}
            </span>
          ) : null}
        </div>
        {sets ? (
          <AiChoices testId="offer-method-options" onClose={() => setSets(null)}>
            {sets.map((set, i) => (
              <AiChoice
                key={set.join('|')}
                label={W.useSteps}
                testId={`offer-method-use-${i}`}
                onUse={() => {
                  setSteps(set);
                  setSets(null);
                }}
              >
                <ol className="list-decimal pl-5">
                  {set.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </AiChoice>
            ))}
          </AiChoices>
        ) : null}
      </div>
      {field('method.different')}
    </>
  );
}

function ProofStep({
  workspaceId,
  parts,
  examples,
  update,
}: {
  workspaceId: string;
  parts: Parts;
  examples: readonly string[] | undefined;
  update: (change: (p: Parts) => Parts) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [tidied, setTidied] = useState<string[] | null>(null);
  const shown = parts.proof.length ? parts.proof : [''];
  const setProof = (list: string[]) => update((p) => ({ ...p, proof: list }));
  const has = parts.proof.some(filled);

  async function tidy() {
    setBusy(true);
    try {
      const out = await assistOffer(workspaceId, 'proof', 'improve', parts);
      if (!out.options.length) toast.error('The AI had nothing better this time. Try again.');
      else setTidied(out.options);
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {shown.map((line, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <Input
            aria-label={W.proofLabel(i + 1)}
            value={line}
            maxLength={MAIN_OFFER_LIMITS.proofLine}
            placeholder={i === 0 ? W.proofPlaceholder : undefined}
            onChange={(e) => {
              const list = [...shown];
              list[i] = e.target.value;
              setProof(list);
            }}
            data-testid={`offer-proof-${i}`}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Take out result ${i + 1}`}
            disabled={shown.length <= 1}
            onClick={() => setProof(shown.filter((_, j) => j !== i))}
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={shown.length >= MAIN_OFFER_LIMITS.proof}
          onClick={() => setProof([...shown, ''])}
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {W.addProof}
        </Button>
        {has ? (
          <AiButton improve busy={busy} onClick={() => void tidy()} testId="offer-proof-ai" />
        ) : null}
      </div>
      {examples?.length ? (
        <p className="text-xs text-text-3">
          {W.examples} {examples.join(' · ')}
        </p>
      ) : null}
      {tidied ? (
        <AiChoices testId="offer-proof-options" onClose={() => setTidied(null)}>
          <AiChoice
            label={W.useLines}
            testId="offer-proof-use"
            onUse={() => {
              setProof(tidied);
              setTidied(null);
            }}
          >
            <ul className="list-disc pl-5">
              {tidied.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </AiChoice>
        </AiChoices>
      ) : null}
    </div>
  );
}

function LineStep({
  parts,
  update,
  field,
}: {
  parts: Parts;
  update: (change: (p: Parts) => Parts) => void;
  field: (path: string) => ReactNode;
}) {
  return (
    <>
      <div className="flex flex-col gap-2">
        {field('line')}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update((p) => withPart(p, 'line', offerLineFrom(p)))}
          >
            {W.startFromAnswers}
          </Button>
        </div>
        <p className="rounded-menu bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2">{W.formula}</p>
      </div>
      <div className="flex flex-col gap-1">
        <span className="font-semibold">{W.forMessages}</span>
        <p className="text-[13px] text-text-2">{W.forMessagesHint}</p>
      </div>
      <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
        {field('inAFewWords.outcome')}
        {field('inAFewWords.guarantee')}
      </div>
      <Card className="flex flex-col gap-3 p-5" data-testid="offer-preview">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="text-[13px] font-semibold">{W.previewTitle}</span>
          <span className="text-xs text-text-3">{W.previewNote}</span>
        </div>
        <p className="max-w-[460px] rounded-[16px_16px_16px_4px] bg-card-2 px-3.5 py-2.5 text-[14px]">
          {firstMessagePreview(
            partWords(parts, 'inAFewWords.outcome'),
            partWords(parts, 'inAFewWords.guarantee'),
          )}
        </p>
      </Card>
    </>
  );
}

function ScoreStep({ parts, onGo }: { parts: Parts; onGo: (step: OfferStep) => void }) {
  const missing = missingParts(parts);
  return (
    <>
      <Card className="flex flex-col gap-2 px-5 py-4">
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          Your offer
        </span>
        <p className="text-[16px] leading-normal" data-testid="offer-score-line">
          {parts.line?.trim() || offerLineFrom(parts)}
        </p>
      </Card>
      {missing.length ? (
        <div
          className="flex flex-col gap-2 rounded-menu bg-card-2 px-4 py-3.5"
          data-testid="offer-missing"
        >
          <span className="text-[13px] font-medium">{W.stillNeeds}</span>
          <ul className="flex flex-col gap-1">
            {missing.map((m) => (
              <li key={m.path}>
                <button
                  type="button"
                  className="text-[13px] text-accent-text hover:underline"
                  onClick={() => onGo(offerStepOf(m.path))}
                >
                  {m.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
