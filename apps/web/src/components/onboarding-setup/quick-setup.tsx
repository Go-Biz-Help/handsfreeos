'use client';
/**
 * The onboarding setup on the web (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §6–§7): one question per
 * screen, in stops, with the summary of the setup so far beside them. It replaces Create business, the quick
 * questions and the setup wizard's steps; Getting started's Home card points here until it's finished.
 *
 * - Each Next keeps the answers (`onboarding_setup.save`) and saves what can't wait, so someone can stop and carry on
 *   later, here or on the phone. The address follows the screen (`?at=`), so a page loaded again opens where they
 *   were, and the stops that bring their own part (the number, the customers) get it from the server.
 * - What Ava reads fills in the screens not finished yet, as it arrives (live, or by asking again while it reads),
 *   unless the person already changed that answer (`mergeOnboardingSetupAnswers`).
 * - The logo and colour are kept as they change, by their own commands (look-editor.tsx); the logo was looked for on
 *   the website when the first screen saved it.
 * - The booking page is made as its screen opens: by then it's ready, not a question.
 * - "Stay in the loop" saves the rest (`onboarding_setup.finish`); a business that has a teammate sees what will
 *   change first. Then the test chat, and what already works.
 * - What a screen shows and what it still needs come from core, as on the phone.
 */
import {
  AI_SCREEN_OF,
  AI_SETUP_WORDS,
  aiSetupBusinessDraftOf,
  aiSetupFlowFactsOf,
  aiSetupTestQuestions,
  cleanOnboardingSetupAnswers,
  mergeOnboardingSetupAnswers,
  ONBOARDING_SETUP_STOP_NAMES,
  ONBOARDING_SETUP_WORDS as W,
  onboardingSetupBusinessDraftOf,
  onboardingSetupBusinessOf,
  onboardingSetupDraftLine,
  onboardingSetupHint,
  onboardingSetupNextScreen,
  onboardingSetupPreviousScreen,
  onboardingSetupProblemsOf,
  onboardingSetupProgress,
  onboardingSetupScreenProblemsOf,
  onboardingSetupStateOf,
  onboardingSetupSummary,
  onboardingSetupTitle,
  planOnboardingBooking,
  planOnboardingSetup,
  withAiName,
  type AiSetupAnswers,
  type AiSetupProblems,
  type OnboardingSetupAnswers,
  type OnboardingSetupBusinessDraft,
  type OnboardingSetupScreen,
} from '@hfos/core';
import { ArrowLeft, ArrowRight, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AiSetupScreen } from '@/components/ai-setup/screens';
import { TryAva } from '@/components/ai-setup/try-ava';
import { LookEditor } from '@/components/look/look-editor';
import { StepLive } from '@/components/onboarding/step-live';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { aiSetupActions } from '@/lib/ai-setup/actions';
import { ApiError, errorMessage } from '@/lib/api/client';
import { onboardingSetupActions } from '@/lib/onboarding-setup/actions';
import {
  onboardingSetupHref,
  type OnboardingSetupData,
  type OnboardingSetupFinished,
  type OnboardingSetupGot,
} from '@/lib/onboarding-setup/data';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { usePublicOrigin } from '@/lib/use-origin';
import { BusinessScreen } from './business';
import { SetupCard } from './frame';
import {
  AboutScreen,
  aiProblemsOf,
  BookingScreen,
  PageScreen,
  CustomersScreen,
  DoneScreen,
  GoalScreen,
  HoursScreen,
  Loading,
  NumberScreen,
  PaidScreen,
  type BookingMade,
  type OwnScreenProps,
} from './screens';

type Answers = OnboardingSetupAnswers;
type OwnField = Exclude<keyof Answers, 'ai'>;
type AiField = keyof AiSetupAnswers;

/** What changes the screens: Ava reading the website, the teammate, payments, the booking page, customers coming in. */
const LIVE = [
  'knowledge_source',
  'knowledge_scan',
  'knowledge_suggestion',
  'ai_teammate',
  'payment_connection',
  'booking_site',
  'calendar',
  'import',
  'migration',
  'workspace',
];
/** While Ava reads or the scan runs, the screens also ask again this often, in case live updates are down. */
const POLL_MS = 4_000;
const NOTHING_MADE: BookingMade = { making: false, changes: [], notes: [], error: null };

/** A refusal's messages by path into the answers. */
const apiProblems = (e: unknown): AiSetupProblems =>
  e instanceof ApiError ? onboardingSetupProblemsOf(e.details) : {};

export function OnboardingQuickSetup({
  data,
  payments,
}: {
  data: OnboardingSetupData;
  /** `?payments=` from Stripe's or Square's sign-in, coming back to "Get paid". */
  payments: string | null;
}) {
  const router = useRouter();
  const ws = data.workspaceId;
  const home = `/app/w/${ws}`;
  const actions = useMemo(() => onboardingSetupActions(ws), [ws]);
  /** The AI quick setup's own calls: what the scan found, and the test chat's. */
  const ai = useMemo(() => aiSetupActions(ws), [ws]);
  const [got, setGot] = useState<OnboardingSetupGot>(data.got);
  const [findings, setFindings] = useState(data.findings);
  const state = useMemo(() => onboardingSetupStateOf(got.state), [got.state]);
  const [answers, setAnswers] = useState<Answers>(data.got.answers);
  const [screen, setScreen] = useState<OnboardingSetupScreen>(data.at);
  const [business, setBusinessDraft] = useState<OnboardingSetupBusinessDraft>(() =>
    onboardingSetupBusinessDraftOf(data.got.state),
  );
  const [invites, setInvites] = useState<string[]>(['']);
  const [problems, setProblems] = useState<AiSetupProblems>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [finished, setFinished] = useState<OnboardingSetupFinished | null>(null);
  const [booking, setBooking] = useState<BookingMade>(NOTHING_MADE);
  const [carrying, setCarrying] = useState(data.resumed);
  /** Answers changed on screen since the last save, as `goal` and `ai.services`: what arrives never overwrites them. */
  const touched = useRef(new Set<string>());
  /** The first screen changed since it was last saved. */
  const businessTouched = useRef(false);
  /** The furthest screen finished, as this person's saves left it. */
  const reached = useRef<OnboardingSetupScreen | null>(data.got.reached);
  const latest = useRef({ answers, state });
  latest.current = { answers, state };

  const facts = aiSetupFlowFactsOf(state);
  const pageOrigin = usePublicOrigin(data.brandedOrigin);
  /** The business's simple page, which the chat goes on when there's no website to paste it into. */
  const pageUrl =
    state.page && !state.website && pageOrigin ? `${pageOrigin}/book/${state.page.slug}` : null;
  const name = answers.ai.name.trim() || 'Ava';

  /** Takes in what the server says now: all of it after the first screen, else what isn't answered on screen. */
  const adopt = useCallback((fresh: OnboardingSetupGot, all: boolean) => {
    setGot(fresh);
    setAnswers((local) =>
      all
        ? fresh.answers
        : mergeOnboardingSetupAnswers(local, fresh.answers, touched.current, reached.current),
    );
    if (!businessTouched.current) setBusinessDraft(onboardingSetupBusinessDraftOf(fresh.state));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [fresh, found] = await Promise.all([actions.get(), ai.findings()]);
      adopt(fresh, false);
      setFindings(found);
    } catch {
      // The next change or the next look tries again.
    }
  }, [actions, ai, adopt]);

  // The page drawn again (each screen asks for its own, and a live change elsewhere) brings new data.
  const seen = useRef(data);
  useEffect(() => {
    if (seen.current === data) return;
    seen.current = data;
    adopt(data.got, false);
    setFindings(data.findings);
  }, [data, adopt]);

  // What Ava read, and everything else the summary says, as it arrives.
  const version = useLiveVersion(LIVE, 1_000);
  useEffect(() => {
    if (version) void refresh();
  }, [version, refresh]);
  const waiting = got.state.reading || got.state.scan.state === 'running';
  useEffect(() => {
    if (!waiting || screen === 'try' || screen === 'done') return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, screen, refresh]);

  const summary = useRef<string[]>([]);
  summary.current = useMemo(() => {
    try {
      const lines = onboardingSetupSummary(state, { ...answers, ai: { ...answers.ai, name } });
      // The first screen's line follows what's typed there, before it's saved.
      return screen === 'business'
        ? [onboardingSetupDraftLine(business), ...lines.slice(1)]
        : lines;
    } catch {
      // Part way through typing something the plan can't read yet: keep the last summary.
      return summary.current;
    }
  }, [state, answers, name, screen, business]);

  const clearProblems = (path: string) =>
    setProblems((p) => {
      const left = Object.fromEntries(
        Object.entries(p).filter(([at]) => at !== path && !at.startsWith(`${path}.`)),
      );
      return Object.keys(left).length === Object.keys(p).length ? p : left;
    });

  function set<K extends OwnField>(key: K, value: Answers[K]) {
    touched.current.add(key);
    setAnswers((a) => ({ ...a, [key]: value }));
    clearProblems(key);
  }

  function setAi<K extends AiField>(key: K, value: AiSetupAnswers[K]) {
    touched.current.add(`ai.${key}`);
    setAnswers((a) => ({ ...a, ai: { ...a.ai, [key]: value } }));
    clearProblems(`ai.${key}`);
  }

  function setBusiness(next: OnboardingSetupBusinessDraft) {
    businessTouched.current = true;
    setBusinessDraft(next);
    setProblems((p) => (Object.keys(p).some((k) => k.startsWith('business.')) ? {} : p));
  }

  function go(next: OnboardingSetupScreen) {
    setScreen(next);
    setConfirming(false);
    setProblems({});
    setError(null);
    // Drawn again for the screen it's now on, which brings what the number and the customers need.
    router.replace(onboardingSetupHref(ws, next), { scroll: false });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** "Your booking page is ready": made from the answers so far as the screen opens, then shown. */
  const makeBooking = useCallback(async () => {
    setBooking({ ...NOTHING_MADE, making: true });
    try {
      const saved = await actions.save({ screen: 'booking', answers: latest.current.answers });
      reached.current = saved.reached;
      touched.current.clear();
      setBooking({ ...NOTHING_MADE, changes: saved.changes, notes: saved.notes });
      await refresh();
    } catch (e) {
      setBooking({ ...NOTHING_MADE, error: errorMessage(e) });
    }
  }, [actions, refresh]);
  const bookingTried = useRef(false);
  useEffect(() => {
    if (screen !== 'booking') {
      bookingTried.current = false;
      return;
    }
    if (bookingTried.current) return;
    bookingTried.current = true;
    const { state: now, answers: given } = latest.current;
    if (!now.booking.on || planOnboardingBooking(now, given).changes.length) void makeBooking();
  }, [screen, makeBooking]);

  async function next() {
    if (screen === 'try' || screen === 'done') return;
    const found = onboardingSetupScreenProblemsOf(screen, answers, state, business);
    if (Object.keys(found).length) {
      setProblems(found);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const clean = cleanOnboardingSetupAnswers(screen, answers, findings);
      if (screen === 'business') {
        const saved = await actions.save({
          screen,
          answers: clean,
          business: onboardingSetupBusinessOf(business),
        });
        reached.current = saved.reached;
        const [fresh, read] = await Promise.all([actions.get(), ai.findings()]);
        touched.current.clear();
        businessTouched.current = false;
        // Kept as they were, and picked again for the kind of business when that changed.
        adopt(fresh, true);
        setFindings(read);
        setCarrying(false);
        go(
          onboardingSetupNextScreen('business', fresh.answers, aiSetupFlowFactsOf(fresh.state)) ??
            'goal',
        );
      } else if (screen === 'loop') {
        setAnswers(clean);
        if (state.teammate && !confirming) {
          setConfirming(true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else await finish(clean);
      } else {
        const emails = invites.map((e) => e.trim()).filter(Boolean);
        const inviting = screen === 'goal' && clean.teamSize !== 'solo' && emails.length > 0;
        // Only what's sent, so a refused address's place in the list is the one on screen.
        if (inviting) setInvites(emails);
        const saved = await actions.save({
          screen,
          answers: clean,
          ...(inviting ? { invite: emails } : {}),
        });
        reached.current = saved.reached;
        touched.current.clear();
        setAnswers(clean);
        setCarrying(false);
        if (saved.notes.length) toast(saved.notes.join(' '));
        if (inviting) {
          setInvites(['']);
          void refresh();
        }
        // The page on or off decides whether Ava's chat can go on it, a few screens on.
        if (screen === 'page') await refresh();
        const after = onboardingSetupNextScreen(screen, clean, facts);
        if (after) go(after);
      }
    } catch (e) {
      setProblems(apiProblems(e));
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function finish(clean: Answers) {
    let result: OnboardingSetupFinished;
    try {
      result = await actions.finish({
        answers: clean,
        baseRevision: state.teammate?.revision ?? null,
        // A chat on the simple page goes on the address the page is shown at.
        ...(state.page && pageOrigin ? { pageOrigin } : {}),
      });
    } catch (e) {
      // Someone saved the teammate meanwhile: what will change is worked out again from what they saved.
      if (e instanceof ApiError && e.rule === 'revision_conflict') void refresh();
      throw e;
    }
    touched.current.clear();
    reached.current = 'loop';
    setFinished(result);
    try {
      setGot(await actions.get());
    } catch {
      // Saved all the same: the page drawn again for the test chat brings the teammate.
    }
    go('try');
  }

  /** After the test chat: turned on, or "Not yet". Either way, on to what already works. */
  async function tried(turnedOn: boolean) {
    if (turnedOn) toast.success(withAiName(AI_SETUP_WORDS.turnedOnNote, name));
    try {
      reached.current = (await actions.save({ screen: 'try', answers })).reached;
    } catch {
      // The setup is saved already; only where it opens next time waits.
    }
    void refresh();
    go('done');
  }

  function back() {
    if (confirming) {
      setConfirming(false);
      return;
    }
    const prev = onboardingSetupPreviousScreen(screen, answers, facts);
    if (prev) go(prev);
  }

  function startOver() {
    touched.current.clear();
    reached.current = null;
    setAnswers(got.starting);
    setCarrying(false);
    go('business');
  }

  const progress = onboardingSetupProgress(screen, answers, facts);
  const prev = onboardingSetupPreviousScreen(screen, answers, facts);
  const teammate = got.state.teammate;
  const aiBusiness = useMemo(() => aiSetupBusinessDraftOf(state), [state]);
  const aiStep = AI_SCREEN_OF[screen];
  const changes = (() => {
    if (!confirming) return null;
    try {
      return planOnboardingSetup(state, answers).changes;
    } catch {
      return [];
    }
  })();
  const own: OwnScreenProps = { state, answers, set, setAi, problems, data, name };

  const body = (() => {
    if (changes)
      return (
        <ul className="flex flex-col gap-2" data-testid="onboarding-setup-changes">
          {changes.length ? (
            changes.map((line) => (
              <li key={line} className="rounded-menu bg-card-2 px-3.5 py-2.5 text-[14px]">
                {line}
              </li>
            ))
          ) : (
            <li className="text-text-2">{AI_SETUP_WORDS.nothingChanges}</li>
          )}
        </ul>
      );
    switch (screen) {
      case 'business':
        return (
          <BusinessScreen
            business={business}
            onChange={setBusiness}
            problems={problems}
            name={name}
          />
        );
      case 'goal':
        return <GoalScreen {...own} invites={invites} setInvites={setInvites} />;
      case 'about':
        return <AboutScreen {...own} />;
      case 'hours':
        return <HoursScreen {...own} />;
      case 'look':
        return (
          <LookEditor
            workspaceId={ws}
            look={state.look}
            businessName={state.businessName}
            website={state.website}
            canChange
            onChanged={() => void refresh()}
          />
        );
      case 'page':
        return <PageScreen {...own} />;
      case 'customers':
        return (
          <>
            <StepLive kinds={['migration']} />
            <CustomersScreen {...own} />
          </>
        );
      case 'booking':
        return <BookingScreen {...own} booking={booking} onRetry={() => void makeBooking()} />;
      case 'number':
        return <NumberScreen {...own} />;
      case 'paid':
        return <PaidScreen {...own} result={payments} />;
      case 'try':
        return teammate ? (
          <TryAva
            workspaceId={ws}
            name={teammate.name}
            questions={aiSetupTestQuestions(state, answers.ai)}
            teammate={{
              id: teammate.id,
              status: teammate.status,
              approvals: state.teammate?.config.autonomy.approvalsNeeded ?? 20,
            }}
            notes={finished?.notes ?? []}
            chat={finished?.chat ?? null}
            brandedOrigin={data.brandedOrigin}
            pageUrl={pageUrl}
            settingsHref={`${home}/ai-team`}
            actions={ai}
            onDone={(on) => void tried(on)}
          />
        ) : (
          <Loading />
        );
      case 'done':
        return <DoneScreen lines={summary.current} />;
      default:
        return aiStep && aiStep !== 'try' && aiStep !== 'business' ? (
          <AiSetupScreen
            step={aiStep}
            state={state}
            answers={answers.ai}
            set={setAi}
            problems={aiProblemsOf(problems)}
            business={aiBusiness}
            setBusiness={() => undefined}
            findings={findings}
            data={data}
          />
        ) : null;
    }
  })();

  const footer =
    screen === 'done' ? (
      <div className="mt-auto flex justify-end border-t border-border pt-4">
        <Button
          size="lg"
          onClick={() => {
            router.push(`${home}?tour=1`);
            router.refresh();
          }}
          data-testid="onboarding-setup-home"
        >
          {W.goHome}
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </div>
    ) : screen === 'try' && teammate ? null : (
      <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
        {error ? <FieldError>{error}</FieldError> : null}
        <div className="flex flex-wrap-reverse items-center justify-between gap-3">
          {prev || confirming ? (
            <Button
              variant="ghost"
              onClick={back}
              disabled={busy}
              data-testid="onboarding-setup-back"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
              {W.back}
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="lg"
            onClick={() => (screen === 'try' ? void tried(false) : void next())}
            loading={busy}
            disabled={booking.making}
            data-testid="onboarding-setup-next"
          >
            {screen === 'loop'
              ? confirming
                ? AI_SETUP_WORDS.saveChanges
                : AI_SETUP_WORDS.save
              : W.next}
            <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </div>
      </div>
    );

  return (
    <SetupCard
      screen={confirming ? 'confirm' : screen}
      counter={`${W.position(progress.at, progress.of)} · ${ONBOARDING_SETUP_STOP_NAMES[progress.stop]}`}
      title={confirming ? AI_SETUP_WORDS.willChange : onboardingSetupTitle(screen, name, facts)}
      hint={confirming ? '' : onboardingSetupHint(screen, name, facts)}
      banner={
        carrying ? (
          <div
            className="flex flex-wrap items-center gap-3 rounded-menu bg-accent-soft px-3.5 py-2.5 text-[13.5px] text-accent-text"
            data-testid="onboarding-setup-carry-on"
          >
            <span className="min-w-0 flex-1">{W.carryOn}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={startOver}
              data-testid="onboarding-setup-start-over"
            >
              <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
              {W.startOver}
            </Button>
          </div>
        ) : null
      }
      summary={screen === 'done' ? null : summary.current}
      footer={footer}
    >
      {body}
    </SetupCard>
  );
}
