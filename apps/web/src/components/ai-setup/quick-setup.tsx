'use client';
/**
 * Quick setup for the AI teammate (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, §7): one question per
 * screen, the summary of what the teammate will do beside them, and Save, then a test chat and "Turn on with
 * training wheels". It replaces the preset picker on the AI teammate page and in Getting started's AI step; "Set it
 * up myself" leads to that picker.
 *
 * - Each Next keeps the answers (`ai_setup.save`), so someone can stop and carry on later, here or on the phone. The
 *   first screen saves the business's name, kind and website straight away, and Ava starts reading the website.
 * - What Ava reads fills in the screens not finished yet, as it arrives (live, or by asking again while it reads),
 *   unless the person already changed that answer.
 * - Save runs `ai_setup.finish`. A business that has a teammate sees what will change first. After Save the address
 *   gets `?at=try`, so the test chat stays on screen when the page is loaded again.
 * - What a screen shows and what it still needs come from core (summary.ts, words.ts), as on the phone.
 */
import {
  AI_SETUP_STEP_FIELDS,
  AI_SETUP_STEPS,
  AI_SETUP_WORDS,
  aiSetupNextStep,
  aiSetupPreviousStep,
  AiSetupAnswers,
  aiSetupStateOf,
  aiSetupStepHint,
  aiSetupStepProblems,
  aiSetupSteps,
  aiSetupStepTitle,
  aiSetupSummary,
  aiSetupTestQuestions,
  planAiSetup,
  withAiName,
  type AiSetupStep,
} from '@hfos/core';
import { ArrowLeft, ArrowRight, RotateCcw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FieldError } from '@/components/ui/field';
import { aiSetupActions } from '@/lib/ai-setup/actions';
import type { AiSetupData, AiSetupFinished, AiSetupGot } from '@/lib/ai-setup/data';
import { ApiError, errorMessage } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { bareSite, type Problems } from './fields';
import { AiSetupScreen, type BusinessDraft } from './screens';
import { TryAva } from './try-ava';

type Answers = AiSetupAnswers;
type Field = keyof Answers;

/** What Ava reads on the website fills these in, on screens not finished yet. */
const READ_FIELDS: readonly Field[] = [
  'description',
  'services',
  'area',
  'openHours',
  'facts',
  'questions',
];

/** The screen each answer is on. */
const STEP_OF = new Map<Field, AiSetupStep>(
  AI_SETUP_STEPS.flatMap((s) => AI_SETUP_STEP_FIELDS[s].map((f) => [f, s] as const)),
);
const at = (s: AiSetupStep | null | undefined) => (s ? AI_SETUP_STEPS.indexOf(s) : -1);

/** What changes the screens: the website's reading, the scan and what it found. */
const LIVE = ['knowledge_source', 'knowledge_scan', 'knowledge_suggestion'];
/** While Ava reads or the scan runs, the screens also ask again this often, in case live updates are down. */
const POLL_MS = 4_000;

/**
 * Fresh answers over the ones on screen: every answer not changed here since the last save, or with `only`, just
 * those, on screens not finished yet.
 */
function merged(
  local: Answers,
  fresh: Answers,
  touched: ReadonlySet<Field>,
  reached: AiSetupStep | null,
  only?: readonly Field[],
): Answers {
  const out: Record<string, unknown> = { ...local };
  for (const key of Object.keys(fresh) as Field[]) {
    if (touched.has(key)) continue;
    if (only && (!only.includes(key) || at(STEP_OF.get(key)) <= at(reached))) continue;
    out[key] = fresh[key];
  }
  return out as Answers;
}

/** Where to open: the test chat after Save, else the screen after the furthest one finished. */
function firstStep(got: AiSetupGot, startAt: 'try' | null): AiSetupStep {
  if (startAt === 'try' && got.state.teammate) return 'try';
  if (!got.reached) return 'business';
  const facts = { website: !!got.state.website, chat: !!got.state.chat };
  const next = aiSetupNextStep(got.reached, got.answers, facts);
  return next && next !== 'try' ? next : got.reached;
}

/** A refusal's messages by path into the answers ("answers.services.0.name" → "services.0.name"). */
function apiProblems(e: unknown): Problems {
  if (!(e instanceof ApiError) || !Array.isArray(e.details)) return {};
  const out: Record<string, string> = {};
  for (const d of e.details as { path?: unknown; message?: unknown }[]) {
    const raw = Array.isArray(d.path) ? d.path.join('.') : String(d.path ?? '');
    const path = raw
      .replace(/^\//, '')
      .replaceAll('/', '.')
      .replace(/^answers\./, '');
    if (typeof d.message === 'string' && path && !out[path]) out[path] = d.message;
  }
  return out;
}

export function AiQuickSetup({
  data,
  myselfHref,
  settingsHref,
  doneHref,
  startAt,
}: {
  data: AiSetupData;
  /** "Set it up myself": today's preset picker, shown while the business has no teammate. */
  myselfHref: string;
  /** "More settings": the full settings page. */
  settingsHref: string;
  /** Where "Turn on" and "Not yet" go. */
  doneHref: string;
  /** `?at=try`: straight to the test chat, after Save. */
  startAt: 'try' | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const actions = useMemo(() => aiSetupActions(data.workspaceId), [data.workspaceId]);
  const [got, setGot] = useState<AiSetupGot>(data.got);
  const [findings, setFindings] = useState(data.findings);
  const state = useMemo(() => aiSetupStateOf(got.state), [got.state]);
  const [answers, setAnswers] = useState<Answers>(data.got.answers);
  const [step, setStep] = useState<AiSetupStep>(() => firstStep(data.got, startAt));
  const [confirming, setConfirming] = useState(false);
  const [business, setBusinessDraft] = useState<BusinessDraft>(() => ({
    name: data.got.state.businessName,
    industry: data.got.state.industry ?? '',
    site: bareSite(data.got.state.website),
    noSite: false,
  }));
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<AiSetupFinished | null>(null);
  const [carrying, setCarrying] = useState(!!data.got.reached && startAt !== 'try');
  /** Answers changed on screen since the last save: what arrives from the server never overwrites them. */
  const touched = useRef(new Set<Field>());
  /** The furthest screen finished, as the server keeps it. */
  const reached = useRef<AiSetupStep | null>(data.got.reached);
  const top = useRef<HTMLDivElement | null>(null);

  const facts = { website: !!state.website, chat: !!state.chat };
  const steps = aiSetupSteps(answers, facts);
  const name = answers.name.trim() || 'Ava';

  /** Takes in what the server says now; `all` after the first screen, else only what Ava read. */
  const adopt = useCallback((fresh: AiSetupGot, all: boolean) => {
    setGot(fresh);
    setAnswers((local) =>
      merged(local, fresh.answers, touched.current, reached.current, all ? undefined : READ_FIELDS),
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [fresh, found] = await Promise.all([actions.get(), actions.findings()]);
      adopt(fresh, false);
      setFindings(found);
    } catch {
      // The next change or the next look tries again.
    }
  }, [actions, adopt]);

  // A refresh of the page (someone else's change, or the worker's) brings new data.
  const seen = useRef(data);
  useEffect(() => {
    if (seen.current === data) return;
    seen.current = data;
    adopt(data.got, false);
    setFindings(data.findings);
  }, [data, adopt]);

  // What Ava read, and what the scan found, as it arrives.
  const version = useLiveVersion(LIVE);
  useEffect(() => {
    if (version) void refresh();
  }, [version, refresh]);
  const waiting = got.state.reading || got.state.scan.state === 'running';
  useEffect(() => {
    if (!waiting || step === 'try') return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, step, refresh]);

  const summary = useRef<string[]>([]);
  summary.current = useMemo(() => {
    try {
      return aiSetupSummary(state, { ...answers, name });
    } catch {
      // Part way through typing something the plan can't read yet: keep the last summary.
      return summary.current;
    }
  }, [state, answers, name]);

  function set<K extends Field>(key: K, value: Answers[K]) {
    touched.current.add(key);
    setAnswers((a) => ({ ...a, [key]: value }));
    setProblems((p) => {
      const left = Object.fromEntries(
        Object.entries(p).filter(([path]) => path !== key && !path.startsWith(`${key}.`)),
      );
      return Object.keys(left).length === Object.keys(p).length ? p : left;
    });
  }

  function setBusiness(patch: Partial<BusinessDraft>) {
    setBusinessDraft((b) => ({ ...b, ...patch }));
    setProblems((p) => (Object.keys(p).some((k) => k.startsWith('business.')) ? {} : p));
  }

  function go(next: AiSetupStep) {
    setStep(next);
    setConfirming(false);
    setProblems({});
    setError(null);
    top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /** What the screen still needs before Next, by path. */
  function check(s: AiSetupStep): Problems {
    const out: Record<string, string> = {};
    if (s === 'business') {
      if (!business.name.trim()) out['business.name'] = 'Name your business.';
      if (!business.industry)
        out['business.industry'] = 'Pick the kind of business from the list, or Other.';
      return out;
    }
    const fields = AI_SETUP_STEP_FIELDS[s];
    const parsed = AiSetupAnswers.safeParse(answers);
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join('.');
        if (fields.includes(String(issue.path[0]) as Field) && !out[path])
          out[path] = issue.message;
      }
    for (const p of aiSetupStepProblems(s, parsed.success ? parsed.data : answers, state))
      if (!out[p.path]) out[p.path] = p.message;
    return out;
  }

  /** The answers as they're kept: checked, and on "What Ava learned", what's ticked kept and the rest turned down. */
  function cleaned(s: AiSetupStep): Answers {
    const clean = AiSetupAnswers.parse(answers);
    if (s !== 'learned') return clean;
    const dropped = new Set(clean.dropFindings);
    return {
      ...clean,
      keepFindings: findings.filter((f) => !dropped.has(f.id)).map((f) => f.id),
      dropFindings: findings.filter((f) => dropped.has(f.id)).map((f) => f.id),
    };
  }

  async function next() {
    const found = check(step);
    if (Object.keys(found).length) {
      setProblems(found);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const clean = cleaned(step);
      const after = aiSetupNextStep(step, clean, facts);
      if (step === 'business') {
        const site = business.site.trim();
        const saved = await actions.save({
          step,
          answers: clean,
          business: {
            name: business.name.trim(),
            industry: business.industry,
            website: business.noSite || !site ? null : site,
          },
        });
        reached.current = saved.reached;
        const [fresh, found] = await Promise.all([actions.get(), actions.findings()]);
        adopt(fresh, true);
        touched.current.clear();
        setFindings(found);
        setCarrying(false);
        go('jobs');
      } else if (!after || after === 'try') {
        setAnswers(clean);
        if (state.teammate && !confirming) {
          setConfirming(true);
          top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        } else await finish(clean);
      } else {
        const saved = await actions.save({ step, answers: clean });
        reached.current = saved.reached;
        touched.current.clear();
        setAnswers(clean);
        setCarrying(false);
        go(after);
      }
    } catch (e) {
      setProblems(apiProblems(e));
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function finish(clean: Answers) {
    let result: AiSetupFinished;
    try {
      result = await actions.finish({
        answers: clean,
        baseRevision: state.teammate?.revision ?? null,
      });
    } catch (e) {
      // Someone saved the teammate meanwhile: what will change is worked out again from what they saved.
      if (e instanceof ApiError && e.rule === 'revision_conflict') void refresh();
      throw e;
    }
    touched.current.clear();
    setFinished(result);
    // First, so the page drawn again (loaded, or by a live update) opens on the test chat too.
    router.replace(`${pathname}?at=try`, { scroll: false });
    try {
      setGot(await actions.get());
    } catch {
      // Saved all the same: the page drawn again brings the teammate.
      router.refresh();
    }
    go('try');
  }

  function back() {
    if (confirming) {
      setConfirming(false);
      return;
    }
    const prev = aiSetupPreviousStep(step, answers, facts);
    if (prev) go(prev);
  }

  function startOver() {
    touched.current.clear();
    reached.current = null;
    setAnswers(got.starting);
    setCarrying(false);
    go('business');
  }

  function done(turnedOn: boolean) {
    if (turnedOn) toast.success(withAiName(AI_SETUP_WORDS.turnedOnNote, name));
    router.push(doneHref);
    router.refresh();
  }

  const position = steps.indexOf(step);
  const lastQuestion = (() => {
    const n = aiSetupNextStep(step, answers, facts);
    return !n || n === 'try';
  })();
  const plan = confirming ? planAiSetup(state, cleaned(step)) : null;
  const teammate = got.state.teammate;

  return (
    <Card
      className="grid w-full grid-cols-1 overflow-hidden rounded-dialog md:grid-cols-[minmax(0,1fr)_320px]"
      data-testid="ai-setup"
      data-step={confirming ? 'confirm' : step}
    >
      <div ref={top} className="flex min-w-0 scroll-mt-20 flex-col gap-[22px] p-5 sm:p-8">
        {carrying ? (
          <div
            className="flex flex-wrap items-center gap-3 rounded-menu bg-accent-soft px-3.5 py-2.5 text-[13.5px] text-accent-text"
            data-testid="ai-setup-carry-on"
          >
            <span className="min-w-0 flex-1">{AI_SETUP_WORDS.carryOn}</span>
            <Button variant="ghost" size="sm" onClick={startOver} data-testid="ai-setup-start-over">
              <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
              {AI_SETUP_WORDS.startOver}
            </Button>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
            {AI_SETUP_WORDS.position(position + 1, steps.length)}
          </div>
          <h2 className="text-[24px] font-semibold leading-tight tracking-[-0.015em]">
            {confirming ? AI_SETUP_WORDS.willChange : aiSetupStepTitle(step, name)}
          </h2>
          {confirming ? null : <p className="text-text-2">{aiSetupStepHint(step, name)}</p>}
        </div>

        {plan ? (
          <ul className="flex flex-col gap-2" data-testid="ai-setup-changes">
            {plan.changes.length ? (
              plan.changes.map((line) => (
                <li key={line} className="rounded-menu bg-card-2 px-3.5 py-2.5 text-[14px]">
                  {line}
                </li>
              ))
            ) : (
              <li className="text-text-2">{AI_SETUP_WORDS.nothingChanges}</li>
            )}
          </ul>
        ) : step === 'try' ? (
          teammate ? (
            <TryAva
              workspaceId={data.workspaceId}
              name={teammate.name}
              questions={aiSetupTestQuestions(state, answers)}
              teammate={{
                id: teammate.id,
                status: teammate.status,
                approvals: state.teammate?.config.autonomy.approvalsNeeded ?? 20,
              }}
              notes={finished?.notes ?? []}
              chat={finished?.chat ?? null}
              brandedOrigin={data.brandedOrigin}
              settingsHref={settingsHref}
              actions={actions}
              onDone={done}
            />
          ) : null
        ) : (
          <AiSetupScreen
            step={step}
            state={state}
            answers={answers}
            set={set}
            problems={problems}
            business={business}
            setBusiness={setBusiness}
            findings={findings}
            data={data}
          />
        )}

        {error ? <FieldError>{error}</FieldError> : null}
        {step !== 'try' ? (
          <div className="mt-auto flex flex-wrap-reverse items-center justify-between gap-3 border-t border-border pt-4">
            <div className="flex items-center gap-3">
              {position > 0 || confirming ? (
                <Button variant="ghost" onClick={back} disabled={busy} data-testid="ai-setup-back">
                  <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
                  {AI_SETUP_WORDS.back}
                </Button>
              ) : null}
              <Link
                href={teammate ? settingsHref : myselfHref}
                className="text-[13px] text-text-3 hover:text-text hover:underline"
                data-testid="ai-setup-myself"
              >
                {teammate ? AI_SETUP_WORDS.moreSettings : AI_SETUP_WORDS.setItUpMyself}
              </Link>
            </div>
            <Button
              size="lg"
              onClick={() => void next()}
              loading={busy}
              data-testid="ai-setup-next"
            >
              {confirming
                ? AI_SETUP_WORDS.saveChanges
                : lastQuestion
                  ? AI_SETUP_WORDS.save
                  : AI_SETUP_WORDS.next}
              <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </div>
        ) : null}
      </div>

      <aside
        className="flex flex-col gap-3 border-t border-border bg-card-2 p-5 md:border-l md:border-t-0 md:px-[26px] md:py-8"
        aria-label={withAiName(AI_SETUP_WORDS.summary, name)}
        data-testid="ai-setup-summary"
      >
        <div className="flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
          {withAiName(AI_SETUP_WORDS.summary, name)}
        </div>
        <ul className="flex flex-col gap-2.5">
          {summary.current.map((line) => (
            <li key={line} className={cn('text-[13.5px] leading-[1.45]')}>
              {line}
            </li>
          ))}
        </ul>
      </aside>
    </Card>
  );
}
