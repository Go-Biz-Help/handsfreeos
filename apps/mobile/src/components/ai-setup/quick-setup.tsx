import {
  AI_SETUP_READ_FIELDS,
  AI_SETUP_WORDS,
  aiSetupBusinessDraftOf,
  aiSetupBusinessOf,
  aiSetupFirstStep,
  aiSetupFlowFactsOf,
  aiSetupNextStep,
  aiSetupPreviousStep,
  aiSetupProblemsOf,
  aiSetupScreenProblems,
  aiSetupStateOf,
  aiSetupStepHint,
  aiSetupSteps,
  aiSetupStepTitle,
  aiSetupSummary,
  aiSetupTestQuestions,
  chosenAiSetupTemplate,
  cleanAiSetupAnswers,
  mergeAiSetupAnswers,
  planAiSetup,
  setupKindOf,
  withAiName,
  type AiSetupAnswers,
  type AiSetupBusinessDraft,
  type AiSetupFinding,
  type AiSetupProblems,
  type AiSetupStep,
} from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { AppState, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AiSetupCalls, AiSetupFinished, AiSetupGot } from '@/ai-setup/calls';
import { AI_SETUP_PHONE_WORDS as P } from '@/ai-setup/words';
import { ArrowLeft, ExternalLink, RotateCcw, Sparkles } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { businessHref } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { FieldError } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { openWeb } from '@/lib/open-web';

import { AiSetupScreen } from './screens';
import { TryAva } from './try-ava';

type Answers = AiSetupAnswers;
type Field = keyof Answers;

/** While Ava reads or the scan runs, the screens ask again this often: the phone has no live updates for them. */
const POLL_MS = 4_000;

/** A refusal's messages by path into the answers. */
const apiProblems = (e: unknown): AiSetupProblems =>
  e instanceof ApiError ? aiSetupProblemsOf(e.details) : {};

/**
 * Quick setup for the AI teammate on the phone (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8): the web's
 * frame (components/ai-setup/quick-setup.tsx) at phone size, one question per screen, Back and Next at the bottom,
 * and what the teammate will do under the answers, as the web shows it at phone width.
 *
 * - Each Next keeps the answers (`ai_setup.save`), so someone can start on the computer and finish here, or the other
 *   way round. The first screen saves the business's name, kind and website, and Ava starts reading the website.
 * - What Ava reads fills in the screens not finished yet, by asking again while it reads, unless the person already
 *   changed that answer. Coming back to the app, or back online, asks again too.
 * - Save runs `ai_setup.finish`; a business that has a teammate sees what will change first. Then the test chat,
 *   and "Turn on with training wheels".
 * - Every decision is core's (ai-setup/flow.ts, summary.ts, words.ts), the same as on the web; this only draws them.
 */
export function AiQuickSetup({
  workspaceId,
  got: first,
  findings: firstFindings,
  startAt,
  calls,
}: {
  workspaceId: string;
  got: AiSetupGot;
  findings: readonly AiSetupFinding[];
  /** `?at=try`: straight to the test chat, after Save. */
  startAt: 'try' | null;
  calls: AiSetupCalls;
}) {
  const { online } = useNetwork();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const [got, setGot] = React.useState<AiSetupGot>(first);
  const [findings, setFindings] = React.useState(firstFindings);
  const state = React.useMemo(() => aiSetupStateOf(got.state), [got.state]);
  const [answers, setAnswers] = React.useState<Answers>(first.answers);
  const [step, setStep] = React.useState<AiSetupStep>(() => aiSetupFirstStep(first, startAt));
  const [confirming, setConfirming] = React.useState(false);
  const [business, setBusinessDraft] = React.useState<AiSetupBusinessDraft>(() =>
    aiSetupBusinessDraftOf(first.state),
  );
  const [problems, setProblems] = React.useState<AiSetupProblems>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [finished, setFinished] = React.useState<AiSetupFinished | null>(null);
  const [carrying, setCarrying] = React.useState(!!first.reached && startAt !== 'try');
  /** "Start from" changed on the first screen since it was last saved: the saved answers' id, or null for our picks. */
  const [startPick, setStartPick] = React.useState<string | null | undefined>(undefined);
  /** Answers changed on screen since the last save: what arrives from the server never overwrites them. */
  const touched = React.useRef(new Set<Field>());
  /** The furthest screen finished, as the server keeps it. */
  const reached = React.useRef<AiSetupStep | null>(first.reached);
  const scroller = React.useRef<ScrollView>(null);

  const facts = aiSetupFlowFactsOf(state);
  const steps = aiSetupSteps(answers, facts);
  const name = answers.name.trim() || 'Ava';
  /** Where customers' pages open: the simple page's address, which the chat goes on when there's no website. */
  const [publicOrigin, setPublicOrigin] = React.useState<string | null>(null);
  const hasPage = !!state.page;
  React.useEffect(() => {
    if (!hasPage) return;
    let cancelled = false;
    void calls.chatOrigin().then((o) => {
      if (!cancelled) setPublicOrigin(o);
    });
    return () => {
      cancelled = true;
    };
  }, [hasPage, calls]);
  const pageUrl =
    state.page && !state.website && publicOrigin ? `${publicOrigin}/book/${state.page.slug}` : null;
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

  /** Takes in what the server says now; `all` after the first screen, else only what Ava read. */
  const adopt = React.useCallback((fresh: AiSetupGot, all: boolean) => {
    setGot(fresh);
    setAnswers((local) =>
      mergeAiSetupAnswers(
        local,
        fresh.answers,
        touched.current,
        reached.current,
        all ? undefined : AI_SETUP_READ_FIELDS,
      ),
    );
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      const [fresh, found] = await Promise.all([calls.get(), calls.findings()]);
      adopt(fresh, false);
      setFindings(found);
    } catch {
      // The next look tries again.
    }
  }, [calls, adopt]);

  // What Ava read, and what the scan found: asked again while they're on their way.
  const waiting = got.state.reading || got.state.scan.state === 'running';
  React.useEffect(() => {
    if (!waiting || step === 'try' || !online) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, step, online, refresh]);
  // Back in the app (from the web, say), or back online: what changed meanwhile.
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

  function setBusiness(patch: Partial<AiSetupBusinessDraft>) {
    setBusinessDraft((b) => ({ ...b, ...patch }));
    setProblems((p) => (Object.keys(p).some((k) => k.startsWith('business.')) ? {} : p));
  }

  const toTop = () => scroller.current?.scrollTo({ y: 0, animated: false });

  function go(next: AiSetupStep) {
    setStep(next);
    setConfirming(false);
    setProblems({});
    setError(null);
    toTop();
  }

  /** What the screen still needs before Next, by path. */
  const check = (s: AiSetupStep) => aiSetupScreenProblems(s, answers, state, business);

  /** The answers as they're kept: on "What Ava learned", what's ticked kept and the rest turned down. */
  const cleaned = (s: AiSetupStep) => cleanAiSetupAnswers(s, answers, findings);

  async function next() {
    const found = check(step);
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
      const clean = cleaned(step);
      const after = aiSetupNextStep(step, clean, facts);
      if (step === 'business') {
        const saved = await calls.save({
          step,
          answers: clean,
          business: aiSetupBusinessOf(business),
          ...(startPick !== undefined ? { templateId: startPick } : {}),
        });
        reached.current = saved.reached;
        // Picking where they start from picks those answers again (`ai_setup.save`), so they're taken as they are.
        if (startPick !== undefined) touched.current.clear();
        const [fresh, fresher] = await Promise.all([calls.get(), calls.findings()]);
        adopt(fresh, true);
        touched.current.clear();
        setStartPick(undefined);
        setFindings(fresher);
        setCarrying(false);
        go('jobs');
      } else if (!after || after === 'try') {
        setAnswers(clean);
        if (state.teammate && !confirming) {
          setConfirming(true);
          toTop();
        } else await finish(clean);
      } else {
        const saved = await calls.save({ step, answers: clean });
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
      result = await calls.finish({
        answers: clean,
        baseRevision: state.teammate?.revision ?? null,
        // The chat goes on the simple page when there's no website: the page's address is the chat's site.
        ...(state.page ? { pageOrigin: publicOrigin ?? (await calls.chatOrigin()) } : {}),
      });
    } catch (e) {
      // Someone saved the teammate meanwhile: what will change is worked out again from what they saved.
      if (e instanceof ApiError && e.rule === 'revision_conflict') void refresh();
      throw e;
    }
    touched.current.clear();
    setFinished(result);
    // So the screen opens on the test chat again if it's drawn afresh.
    router.setParams({ at: 'try' });
    try {
      setGot(await calls.get());
    } catch {
      // Saved all the same: the next look brings the teammate.
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
    setStartPick(undefined);
    setCarrying(false);
    go('business');
  }

  function done(turnedOn: boolean) {
    if (turnedOn) toast.show(withAiName(AI_SETUP_WORDS.turnedOnNote, name));
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(workspaceId));
  }

  const position = steps.indexOf(step);
  const lastQuestion = (() => {
    const n = aiSetupNextStep(step, answers, facts);
    return !n || n === 'try';
  })();
  const plan = confirming ? planAiSetup(state, cleaned(step)) : null;
  const teammate = got.state.teammate;
  const bottom = keyboard ? keyboard + (Platform.OS === 'android' ? insets.bottom : 0) : 0;

  return (
    <Screen
      title={AI_SETUP_WORDS.position(position + 1, steps.length)}
      leading="close"
      ask={false}
      scroll={false}
      testID="ai-setup"
    >
      <View
        className="h-1 bg-card-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={position + 1}
      >
        <View
          className="h-full bg-accent"
          style={{ width: `${((position + 1) / Math.max(steps.length, 1)) * 100}%` }}
        />
      </View>
      <View className="flex-1" style={{ paddingBottom: bottom }}>
        <ScrollView
          ref={scroller}
          className="flex-1"
          contentContainerClassName="gap-5 px-4 pb-8 pt-5"
          keyboardShouldPersistTaps="handled"
          testID="ai-setup-scroll"
        >
          {carrying ? (
            <View
              className="flex-row flex-wrap items-center gap-2 rounded-menu bg-accent-soft py-1.5 pl-3.5 pr-1.5"
              testID="ai-setup-carry-on"
            >
              <Text className="min-w-0 flex-1 text-[13.5px] text-accent-text">
                {AI_SETUP_WORDS.carryOn}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                icon={RotateCcw}
                onPress={startOver}
                testID="ai-setup-start-over"
              >
                {AI_SETUP_WORDS.startOver}
              </Button>
            </View>
          ) : null}
          <View className="gap-1.5" testID={`ai-setup-step-${confirming ? 'confirm' : step}`}>
            <Text variant="heading">
              {confirming ? AI_SETUP_WORDS.willChange : aiSetupStepTitle(step, name, facts)}
            </Text>
            {confirming ? null : <Text variant="lead">{aiSetupStepHint(step, name, facts)}</Text>}
          </View>

          {plan ? (
            <View className="gap-2" testID="ai-setup-changes">
              {plan.changes.length ? (
                plan.changes.map((line) => (
                  <View key={line} className="rounded-menu bg-card-2 px-3.5 py-2.5">
                    <Text className="text-[14px] leading-[20px]">{line}</Text>
                  </View>
                ))
              ) : (
                <Text className="text-text-2">{AI_SETUP_WORDS.nothingChanges}</Text>
              )}
            </View>
          ) : step === 'try' ? (
            teammate ? (
              <TryAva
                workspaceId={workspaceId}
                name={teammate.name}
                questions={aiSetupTestQuestions(state, answers)}
                teammate={{
                  id: teammate.id,
                  status: teammate.status,
                  approvals: state.teammate?.config.autonomy.approvalsNeeded ?? 20,
                }}
                notes={finished?.notes ?? []}
                chat={finished?.chat ?? null}
                pageUrl={pageUrl}
                calls={calls}
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
              startFrom={startFrom}
            />
          )}

          {error ? <FieldError testID="ai-setup-error">{error}</FieldError> : null}

          {step !== 'try' ? (
            <>
              <Card className="gap-2.5 bg-card-2 p-4" testID="ai-setup-summary">
                <View className="flex-row items-center gap-2">
                  <Icon as={Sparkles} className="size-3.5 text-text-3" />
                  <Text variant="group">{withAiName(AI_SETUP_WORDS.summary, name)}</Text>
                </View>
                {summary.current.map((line) => (
                  <Text key={line} className="text-[13.5px] leading-[19px]">
                    {line}
                  </Text>
                ))}
              </Card>
              <Pressable
                role="link"
                onPress={() =>
                  void openWeb(
                    teammate
                      ? `/app/w/${workspaceId}/ai-team`
                      : `/app/w/${workspaceId}/ai-team?myself=1`,
                  )
                }
                className="flex-row items-center gap-1.5 self-start py-1.5"
                testID="ai-setup-myself"
              >
                <Text className="text-[13.5px] font-medium text-text-2">
                  {teammate ? AI_SETUP_WORDS.moreSettings : AI_SETUP_WORDS.setItUpMyself}
                </Text>
                <Icon as={ExternalLink} className="size-3.5 text-text-3" />
                <Text className="text-[12.5px] text-text-3">{P.onTheWeb}</Text>
              </Pressable>
            </>
          ) : null}
        </ScrollView>

        {step !== 'try' ? (
          <View
            className="flex-row items-center gap-3 border-t border-border bg-card px-4 pt-3"
            style={{ paddingBottom: keyboard ? 12 : Math.max(insets.bottom, 12) }}
          >
            {position > 0 || confirming ? (
              <Button
                variant="ghost"
                icon={ArrowLeft}
                onPress={back}
                disabled={busy}
                testID="ai-setup-back"
              >
                {AI_SETUP_WORDS.back}
              </Button>
            ) : null}
            <Button
              className="flex-1"
              onPress={() => void next()}
              loading={busy}
              testID="ai-setup-next"
            >
              {confirming
                ? AI_SETUP_WORDS.saveChanges
                : lastQuestion
                  ? AI_SETUP_WORDS.save
                  : AI_SETUP_WORDS.next}
            </Button>
          </View>
        ) : (
          <View style={{ height: keyboard ? 0 : insets.bottom }} />
        )}
      </View>
    </Screen>
  );
}
