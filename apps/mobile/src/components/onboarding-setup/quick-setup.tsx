import {
  AI_SCREEN_OF,
  AI_SETUP_WORDS,
  aiSetupBusinessDraftOf,
  aiSetupFlowFactsOf,
  aiSetupTestQuestions,
  cleanOnboardingSetupAnswers,
  holds,
  mergeOnboardingSetupAnswers,
  ONBOARDING_SETUP_SCREENS,
  ONBOARDING_SETUP_WORDS as W,
  onboardingSetupBusinessDraftOf,
  onboardingSetupBusinessOf,
  onboardingSetupDraftLine,
  onboardingSetupHint,
  onboardingSetupNextScreen,
  onboardingSetupOpenAt,
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
  type AiSetupFinding,
  type AiSetupProblems,
  type OnboardingSetupAnswers,
  type OnboardingSetupBusinessDraft,
  type OnboardingSetupScreen,
  type Permission,
} from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { AppState, View, type ScrollView } from 'react-native';

import { AiSetupScreen } from '@/components/ai-setup/screens';
import { TryAva } from '@/components/ai-setup/try-ava';
import { ArrowLeft, RotateCcw } from '@/components/icons';
import { businessHref } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import type {
  OnboardingSetupCalls,
  OnboardingSetupFinished,
  OnboardingSetupGot,
} from '@/onboarding-setup/calls';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

import { BusinessScreen } from './business';
import { DoneLines, SetupFrame } from './frame';
import { LookScreen } from './look';
import { NumberScreen } from './number';
import {
  AboutScreen,
  aiProblemsOf,
  BookingScreen,
  CustomersScreen,
  GoalScreen,
  HoursScreen,
  Loading,
  PaidScreen,
  type BookingMade,
  type OwnScreenProps,
} from './screens';

type Answers = OnboardingSetupAnswers;
type OwnField = Exclude<keyof Answers, 'ai'>;
type AiField = keyof AiSetupAnswers;

/** While Ava reads, the scan runs or the number is set up, the screens ask again this often: no live updates here. */
const POLL_MS = 4_000;
const NOTHING_MADE: BookingMade = { making: false, changes: [], notes: [], error: null };

/** A refusal's messages by path into the answers. */
const apiProblems = (e: unknown): AiSetupProblems =>
  e instanceof ApiError ? onboardingSetupProblemsOf(e.details) : {};

/**
 * The onboarding setup on the phone (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8): the web's frame
 * (components/onboarding-setup/quick-setup.tsx) at phone size, one question per screen, Back and Next at the bottom,
 * and the summary of the setup so far on a sheet.
 *
 * - Each Next keeps the answers (`onboarding_setup.save`) and saves what can't wait, so someone can stop and carry on
 *   later, here or on the computer. `?at=` names the screen, and a screen it asks for opens there.
 * - What Ava reads fills in the screens not finished yet, by asking again while it reads, unless the person already
 *   changed that answer (`mergeOnboardingSetupAnswers`). Coming back to the app, or back online, asks again too.
 * - The logo and colour are kept as they change, by their own commands (look.tsx); the logo was looked for on the
 *   website when the first screen saved it.
 * - The booking page is made as its screen opens: by then it's ready, not a question.
 * - "Stay in the loop" saves the rest (`onboarding_setup.finish`); a business that has a teammate sees what will
 *   change first. Then the test chat, and what already works.
 * - Every decision is core's (onboarding-setup/flow.ts, answers.ts, summary.ts, words.ts), as on the web.
 */
export function OnboardingQuickSetup({
  workspaceId,
  got: first,
  findings: firstFindings,
  at,
  calls,
}: {
  workspaceId: string;
  got: OnboardingSetupGot;
  findings: readonly AiSetupFinding[];
  /** `?at=`: the screen asked for, when it's one this business goes through and isn't past where it opens. */
  at: string | null;
  calls: OnboardingSetupCalls;
}) {
  const { online } = useNetwork();
  const grants = useGrants();
  const [got, setGot] = React.useState<OnboardingSetupGot>(first);
  const [findings, setFindings] = React.useState(firstFindings);
  const state = React.useMemo(() => onboardingSetupStateOf(got.state), [got.state]);
  const [answers, setAnswers] = React.useState<Answers>(first.answers);
  const [screen, setScreen] = React.useState<OnboardingSetupScreen>(() =>
    onboardingSetupOpenAt({ ...first, state: onboardingSetupStateOf(first.state) }, at),
  );
  const [business, setBusinessDraft] = React.useState<OnboardingSetupBusinessDraft>(() =>
    onboardingSetupBusinessDraftOf(first.state),
  );
  const [invites, setInvites] = React.useState<string[]>(['']);
  const [problems, setProblems] = React.useState<AiSetupProblems>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [finished, setFinished] = React.useState<OnboardingSetupFinished | null>(null);
  const [booking, setBooking] = React.useState<BookingMade>(NOTHING_MADE);
  // Opened part way through without a screen named (Home's Carry on): it says it carries on where they left off.
  const [carrying, setCarrying] = React.useState(
    () => !ONBOARDING_SETUP_SCREENS.some((s) => s === at) && !!first.reached && !first.finished,
  );
  /** Answers changed on screen since the last save, as `goal` and `ai.services`: what arrives never overwrites them. */
  const touched = React.useRef(new Set<string>());
  /** The first screen changed since it was last saved. */
  const businessTouched = React.useRef(false);
  /** The furthest screen finished, as this person's saves left it. */
  const reached = React.useRef<OnboardingSetupScreen | null>(first.reached);
  const latest = React.useRef({ answers, state });
  latest.current = { answers, state };
  const scroller = React.useRef<ScrollView>(null);

  const facts = aiSetupFlowFactsOf(state);
  const name = answers.ai.name.trim() || 'Ava';
  const can = React.useCallback((permission: Permission) => holds(grants, permission), [grants]);

  /** Takes in what the server says now: all of it after the first screen, else what isn't answered on screen. */
  const adopt = React.useCallback((fresh: OnboardingSetupGot, all: boolean) => {
    setGot(fresh);
    setAnswers((local) =>
      all
        ? fresh.answers
        : mergeOnboardingSetupAnswers(local, fresh.answers, touched.current, reached.current),
    );
    if (!businessTouched.current) setBusinessDraft(onboardingSetupBusinessDraftOf(fresh.state));
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      const [fresh, found] = await Promise.all([calls.get(), calls.ai.findings()]);
      adopt(fresh, false);
      setFindings(found);
    } catch {
      // The next look tries again.
    }
  }, [calls, adopt]);

  // What Ava read, what the scan found, and the number being set up: asked again while they're on their way.
  const waiting =
    got.state.reading ||
    got.state.scan.state === 'running' ||
    (screen === 'number' && got.state.numberSetup.next === 'provisioning');
  React.useEffect(() => {
    if (!waiting || screen === 'try' || screen === 'done' || !online) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, screen, online, refresh]);
  // Back in the app (from the browser, say), or back online: what changed meanwhile.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);
  const wasOnline = React.useRef(online);
  React.useEffect(() => {
    if (online && !wasOnline.current) void refresh();
    wasOnline.current = online;
  }, [online, refresh]);

  const summary = React.useRef<string[]>([]);
  summary.current = React.useMemo(() => {
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
        Object.entries(p).filter(([key]) => key !== path && !key.startsWith(`${path}.`)),
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

  const toTop = () => scroller.current?.scrollTo({ y: 0, animated: false });

  function go(next: OnboardingSetupScreen) {
    setScreen(next);
    setConfirming(false);
    setProblems({});
    setError(null);
    // So the screen opens there again if it's drawn afresh.
    router.setParams({ at: next });
    toTop();
  }

  /** "Your booking page is ready": made from the answers so far as the screen opens, then shown. */
  const makeBooking = React.useCallback(async () => {
    setBooking({ ...NOTHING_MADE, making: true });
    try {
      const saved = await calls.save({ screen: 'booking', answers: latest.current.answers });
      reached.current = saved.reached;
      touched.current.clear();
      setBooking({ ...NOTHING_MADE, changes: saved.changes, notes: saved.notes });
      await refresh();
    } catch (e) {
      setBooking({ ...NOTHING_MADE, error: errorMessage(e) });
    }
  }, [calls, refresh]);
  const bookingTried = React.useRef(false);
  React.useEffect(() => {
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
    if (!online) {
      setError(P.needsSignal);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const clean = cleanOnboardingSetupAnswers(screen, answers, findings);
      if (screen === 'business') {
        const saved = await calls.save({
          screen,
          answers: clean,
          business: onboardingSetupBusinessOf(business),
        });
        reached.current = saved.reached;
        const [fresh, read] = await Promise.all([calls.get(), calls.ai.findings()]);
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
          toTop();
        } else await finish(clean);
      } else {
        const emails = invites.map((e) => e.trim()).filter(Boolean);
        const inviting = screen === 'goal' && clean.teamSize !== 'solo' && emails.length > 0;
        // Only what's sent, so a refused address's place in the list is the one on screen.
        if (inviting) setInvites(emails);
        const saved = await calls.save({
          screen,
          answers: clean,
          ...(inviting ? { invite: emails } : {}),
        });
        reached.current = saved.reached;
        touched.current.clear();
        setAnswers(clean);
        setCarrying(false);
        if (saved.notes.length) toast.show(saved.notes.join(' '));
        if (inviting) {
          setInvites(['']);
          void refresh();
        }
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
      result = await calls.finish({
        answers: clean,
        baseRevision: state.teammate?.revision ?? null,
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
      setGot(await calls.get());
    } catch {
      // Saved all the same: the next look brings the teammate.
    }
    go('try');
  }

  /** After the test chat: turned on, or "Not yet". Either way, on to what already works. */
  async function tried(turnedOn: boolean) {
    if (turnedOn) toast.show(withAiName(AI_SETUP_WORDS.turnedOnNote, name));
    try {
      reached.current = (await calls.save({ screen: 'try', answers })).reached;
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

  /** "Go to Home", or closing the setup: the answers so far are kept. */
  function home() {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(workspaceId));
  }

  const progress = onboardingSetupProgress(screen, answers, facts);
  const prev = onboardingSetupPreviousScreen(screen, answers, facts);
  const teammate = got.state.teammate;
  const aiBusiness = React.useMemo(() => aiSetupBusinessDraftOf(state), [state]);
  const aiStep = AI_SCREEN_OF[screen];
  const changes = (() => {
    if (!confirming) return null;
    try {
      return planOnboardingSetup(state, answers).changes;
    } catch {
      return [];
    }
  })();
  const own: OwnScreenProps = {
    workspaceId,
    state,
    answers,
    set,
    setAi,
    problems,
    calls,
    name,
    can,
    refresh,
  };

  const body = (() => {
    if (changes)
      return (
        <View className="gap-2" testID="onboarding-setup-changes">
          {changes.length ? (
            changes.map((line) => (
              <View key={line} className="rounded-menu bg-card-2 px-3.5 py-2.5">
                <Text className="text-[14px] leading-[20px]">{line}</Text>
              </View>
            ))
          ) : (
            <Text className="text-text-2">{AI_SETUP_WORDS.nothingChanges}</Text>
          )}
        </View>
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
        return <LookScreen {...own} />;
      case 'customers':
        return <CustomersScreen {...own} />;
      case 'booking':
        return <BookingScreen {...own} booking={booking} onRetry={() => void makeBooking()} />;
      case 'number':
        return <NumberScreen {...own} />;
      case 'paid':
        return <PaidScreen {...own} />;
      case 'try':
        return teammate ? (
          <TryAva
            workspaceId={workspaceId}
            name={teammate.name}
            questions={aiSetupTestQuestions(state, answers.ai)}
            teammate={{
              id: teammate.id,
              status: teammate.status,
              approvals: state.teammate?.config.autonomy.approvalsNeeded ?? 20,
            }}
            notes={finished?.notes ?? []}
            chat={finished?.chat ?? null}
            calls={calls.ai}
            onDone={(on) => void tried(on)}
          />
        ) : (
          <Loading />
        );
      case 'done':
        return <DoneLines lines={summary.current} />;
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
          />
        ) : null;
    }
  })();

  const footer =
    screen === 'done' ? (
      <Button onPress={home} testID="onboarding-setup-home">
        {W.goHome}
      </Button>
    ) : screen === 'try' && teammate ? null : (
      <>
        {error ? <FieldError testID="onboarding-setup-error">{error}</FieldError> : null}
        <View className="flex-row items-center gap-3">
          {prev || confirming ? (
            <Button
              variant="ghost"
              icon={ArrowLeft}
              onPress={back}
              disabled={busy}
              testID="onboarding-setup-back"
            >
              {W.back}
            </Button>
          ) : null}
          <Button
            className="flex-1"
            onPress={() => (screen === 'try' ? void tried(false) : void next())}
            loading={busy}
            disabled={booking.making}
            testID="onboarding-setup-next"
          >
            {screen === 'loop'
              ? confirming
                ? AI_SETUP_WORDS.saveChanges
                : AI_SETUP_WORDS.save
              : W.next}
          </Button>
        </View>
      </>
    );

  return (
    <SetupFrame
      screen={confirming ? 'confirm' : screen}
      progress={progress}
      title={confirming ? AI_SETUP_WORDS.willChange : onboardingSetupTitle(screen, name)}
      hint={confirming ? '' : onboardingSetupHint(screen, name)}
      banner={
        carrying ? (
          <View
            className="flex-row flex-wrap items-center gap-2 rounded-menu bg-accent-soft py-1.5 pl-3.5 pr-1.5"
            testID="onboarding-setup-carry-on"
          >
            <Text className="min-w-0 flex-1 text-[13.5px] text-accent-text">{W.carryOn}</Text>
            <Button
              variant="ghost"
              size="sm"
              icon={RotateCcw}
              onPress={startOver}
              testID="onboarding-setup-start-over"
            >
              {W.startOver}
            </Button>
          </View>
        ) : null
      }
      summary={screen === 'done' || screen === 'try' ? null : summary.current}
      footer={footer}
      scroller={scroller}
    >
      {body}
    </SetupFrame>
  );
}
