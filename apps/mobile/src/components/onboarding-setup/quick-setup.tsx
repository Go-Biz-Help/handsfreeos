import {
  AI_SCREEN_OF,
  AI_SETUP_WORDS,
  aiSetupBusinessDraftOf,
  aiSetupFlowFactsOf,
  aiSetupTestQuestions,
  chosenAiSetupTemplate,
  cleanOnboardingSetupAnswers,
  holds,
  mergeOnboardingSetupAnswers,
  ONBOARDING_SETUP_HAND_OVER_WORDS as HW,
  ONBOARDING_SETUP_SCREENS,
  ONBOARDING_SETUP_WORDS as W,
  onboardingSetupBusinessDraftOf,
  onboardingSetupBusinessOf,
  onboardingSetupChecking,
  onboardingSetupDraftLine,
  onboardingSetupHint,
  onboardingSetupNextScreen,
  onboardingSetupOpenAt,
  onboardingSetupOwnerNext,
  onboardingSetupOwnerPart,
  onboardingSetupOwnerPrevious,
  onboardingSetupOwnerProgress,
  onboardingSetupOwnerScreens,
  onboardingSetupPreviousScreen,
  onboardingSetupProblemsOf,
  onboardingSetupProgress,
  onboardingSetupScreenProblemsOf,
  onboardingSetupStateOf,
  onboardingSetupStopName,
  onboardingSetupSummary,
  onboardingSetupTitle,
  planOnboardingBooking,
  planOnboardingSetup,
  setupKindOf,
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
import { ArrowLeft, Check, RotateCcw } from '@/components/icons';
import { businessHref } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
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
import { PageScreen } from './page';
import {
  AboutScreen,
  aiProblemsOf,
  BookingScreen,
  CheckScreen,
  CustomersScreen,
  GoalScreen,
  HandOverScreen,
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
 * - A business with no website is offered its simple page (page.tsx), drawn from the answers so far. Kept, it goes
 *   live, and the AI teammate's chat goes on it.
 * - The booking page is made as its screen opens: by then it's ready, not a question.
 * - "Stay in the loop" saves the rest (`onboarding_setup.finish`); a business that has a teammate sees what will
 *   change first. Then the test chat, and what already works.
 * - Someone from the business's agency (`state.forClient`, §9) hands it to the owner in place of "Stay in the
 *   loop", leaving them the booking page and payments. The owner then opens on what the agency set up, to check:
 *   "Change something" walks the whole setup, and "Finish my part" only their own screens (`?part=owner`).
 * - Every decision is core's (onboarding-setup/flow.ts, answers.ts, summary.ts, words.ts), as on the web.
 */
export function OnboardingQuickSetup({
  workspaceId,
  got: first,
  findings: firstFindings,
  at,
  part = null,
  calls,
}: {
  workspaceId: string;
  got: OnboardingSetupGot;
  findings: readonly AiSetupFinding[];
  /** `?at=`: the screen asked for, when it's one this business goes through and isn't past where it opens. */
  at: string | null;
  /** `?part=owner`: the owner finishing their part of what their agency set up. */
  part?: string | null;
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
  const asked = ONBOARDING_SETUP_SCREENS.some((s) => s === at);
  // Handed over by the agency and not finished, for the owner: what the agency did comes first, to check.
  const [checking, setChecking] = React.useState(() => !asked && onboardingSetupChecking(first));
  /** "Finish my part": the owner's own screens, as they stood when it started; null on the whole setup. */
  const [walk, setWalk] = React.useState<readonly OnboardingSetupScreen[] | null>(() =>
    asked && part === 'owner' && onboardingSetupChecking(first)
      ? onboardingSetupOwnerScreens(first.answers, onboardingSetupStateOf(first.state), screen)
      : null,
  );
  // Opened part way through without a screen named (Home's Carry on): it says it carries on where they left off.
  const [carrying, setCarrying] = React.useState(
    () => !asked && !!first.reached && !first.finished && !first.handedOver,
  );
  /** "Start from", changed on the first screen since it was last saved: saved answers, or null for our picks. */
  const [startPick, setStartPick] = React.useState<string | null | undefined>(undefined);
  /** Handing it over: the owner's email, to invite them. */
  const [ownerEmail, setOwnerEmail] = React.useState('');
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
  const forClient = state.forClient;
  // While nobody picked, it follows the kind of business on the first screen.
  const startFrom =
    got.templates.length && !got.state.teammate
      ? {
          templates: got.templates,
          value:
            chosenAiSetupTemplate(
              got.templates,
              startPick !== undefined ? startPick : got.templatePicked ? got.templateId : undefined,
              setupKindOf(business.industry),
            )?.id ?? null,
          onChange: (templateId: string | null) => setStartPick(templateId),
        }
      : null;
  const can = React.useCallback((permission: Permission) => holds(grants, permission), [grants]);
  /** Where customers' pages open: the simple page's address, which the chat goes on when there's no website. */
  const [publicOrigin, setPublicOrigin] = React.useState<string | null>(null);
  const hasPage = !!state.page;
  React.useEffect(() => {
    if (!hasPage) return;
    let cancelled = false;
    void calls.publicOrigin().then((o) => {
      if (!cancelled) setPublicOrigin(o);
    });
    return () => {
      cancelled = true;
    };
  }, [hasPage, calls]);
  const pageUrl =
    state.page && !state.website && publicOrigin ? `${publicOrigin}/book/${state.page.slug}` : null;

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

  function go(next: OnboardingSetupScreen, ownerPart = !!walk) {
    setScreen(next);
    setChecking(false);
    setConfirming(false);
    setProblems({});
    setError(null);
    // So the screen opens there again if it's drawn afresh.
    router.setParams({ at: next, part: ownerPart ? 'owner' : undefined });
    toTop();
  }

  /** "Finish my part": the owner's own screens only, from the first. */
  function finishMyPart() {
    const screens = onboardingSetupOwnerScreens(answers, state);
    setWalk(screens);
    go(screens[0] ?? 'loop', true);
  }

  /** "Change something": the whole setup, from its first screen. */
  function changeSomething() {
    setWalk(null);
    go('business', false);
  }

  /** Back from the first of the owner's screens: checking what the agency set up again. */
  function backToChecking() {
    setWalk(null);
    setChecking(true);
    setConfirming(false);
    setProblems({});
    setError(null);
    router.setParams({ at: undefined, part: undefined });
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
    // Someone setting it up for the owner leaves it to them: it books the owner's time.
    if (now.forClient) return;
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
          ...(startPick !== undefined ? { templateId: startPick } : {}),
        });
        reached.current = saved.reached;
        const [fresh, read] = await Promise.all([calls.get(), calls.ai.findings()]);
        touched.current.clear();
        businessTouched.current = false;
        setStartPick(undefined);
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
        // The page is live (or down) now, and the AI teammate's chat goes on it: the screens ahead follow.
        if (screen === 'page') await refresh();
        const after = walk
          ? onboardingSetupOwnerNext(walk, screen)
          : onboardingSetupNextScreen(screen, clean, facts);
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
        // The chat goes on the simple page when there's no website: the page's address is the chat's site.
        ...(state.page ? { pageOrigin: publicOrigin ?? (await calls.publicOrigin()) } : {}),
        // Handed to the owner, inviting them now or later from Members.
        ...(state.forClient ? { owner: { email: ownerEmail.trim() || null } } : {}),
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
    if (walk) {
      const before = onboardingSetupOwnerPrevious(walk, screen);
      if (before) go(before);
      else backToChecking();
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

  const progress = walk
    ? onboardingSetupOwnerProgress(walk, screen)
    : onboardingSetupProgress(screen, answers, facts);
  // The first of the owner's own screens goes back to checking what the agency set up.
  const canGoBack = walk
    ? walk.includes(screen)
    : !!onboardingSetupPreviousScreen(screen, answers, facts);
  const handedOver = got.handedOver;
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
    if (checking)
      return (
        <CheckScreen
          lines={summary.current}
          part={onboardingSetupOwnerPart(onboardingSetupOwnerScreens(answers, state), answers)}
        />
      );
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
    // Someone from the agency hands it to the owner in place of staying in the loop.
    if (screen === 'loop' && forClient)
      return (
        <HandOverScreen
          email={ownerEmail}
          onChange={(email) => {
            setOwnerEmail(email);
            clearProblems('owner');
          }}
          role={got.handOverAs ?? 'admin'}
          error={problems['owner.email'] ?? problems['owner']}
        />
      );
    switch (screen) {
      case 'business':
        return (
          <BusinessScreen
            business={business}
            onChange={setBusiness}
            problems={problems}
            name={name}
            startFrom={startFrom}
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
      case 'page':
        return <PageScreen {...own} />;
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
            pageUrl={pageUrl}
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

  const footer = checking ? (
    <View className="flex-row items-center gap-3">
      <Button variant="secondary" onPress={changeSomething} testID="onboarding-setup-change">
        {HW.change}
      </Button>
      <Button className="flex-1" onPress={finishMyPart} testID="onboarding-setup-finish-part">
        {HW.finishPart}
      </Button>
    </View>
  ) : screen === 'done' ? (
    <Button onPress={home} testID="onboarding-setup-home">
      {W.goHome}
    </Button>
  ) : screen === 'try' && teammate ? null : (
    <>
      {error ? <FieldError testID="onboarding-setup-error">{error}</FieldError> : null}
      <View className="flex-row items-center gap-3">
        {canGoBack || confirming ? (
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
            ? forClient
              ? HW.handOver
              : confirming
                ? AI_SETUP_WORDS.saveChanges
                : AI_SETUP_WORDS.save
            : W.next}
        </Button>
      </View>
    </>
  );

  return (
    <SetupFrame
      screen={checking ? 'check' : confirming ? 'confirm' : screen}
      progress={checking ? null : progress}
      label={HW.checkCounter}
      stopName={onboardingSetupStopName(progress.stop, forClient)}
      title={
        checking && handedOver
          ? HW.checkTitle(handedOver.agency)
          : confirming
            ? AI_SETUP_WORDS.willChange
            : onboardingSetupTitle(screen, name, facts, forClient)
      }
      hint={
        checking && handedOver
          ? HW.checkHint(handedOver.name, state.businessName)
          : confirming
            ? ''
            : onboardingSetupHint(screen, name, facts, forClient)
      }
      banner={
        forClient && handedOver && (screen === 'try' || screen === 'done') ? (
          <View
            className="flex-row items-start gap-2.5 rounded-menu bg-success-soft px-3.5 py-2.5"
            testID="onboarding-setup-handed-over"
          >
            <Icon as={Check} className="mt-0.5 size-4 text-success-text" strokeWidth={2} />
            <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-success-text">
              {handedOver.email ? HW.sent(handedOver.email) : HW.notSent}
            </Text>
          </View>
        ) : carrying ? (
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
      summary={checking || screen === 'done' || screen === 'try' ? null : summary.current}
      footer={footer}
      scroller={scroller}
    >
      {body}
    </SetupFrame>
  );
}
