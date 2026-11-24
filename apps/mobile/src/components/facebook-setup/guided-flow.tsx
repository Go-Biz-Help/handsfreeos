import {
  FACEBOOK_SETUP_WORDS as W,
  FACEBOOK_TEST_HINT_AFTER_MS,
  facebookSettingsLines,
  facebookSetupAnswersOf,
  facebookSetupFirstProblem,
  facebookSetupLines,
  facebookSetupOpenStages,
  facebookSetupPipeline,
  facebookSetupProblems,
  facebookSetupQuestions,
  facebookSetupScreen,
  facebookSetupStart,
  facebookSignInSteps,
  GUIDED_SETUP_WORDS as G,
  guidedSetupSavedWhen,
  metaAccountLabel,
  type FacebookSetupAccount,
  type FacebookSetupAnswers,
  type FacebookSetupContext,
  type FacebookSetupScreen,
  type MetaAccountTestMessages,
} from '@hfos/core';
import * as WebBrowser from 'expo-web-browser';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { AppState, Pressable, View, type ScrollView } from 'react-native';

import {
  ChoiceTile,
  Choices,
  GuidedFooter,
  GuidedNote,
  GuidedPage,
  useGuidedDraft,
  WelcomeBack,
} from '@/components/guided-setup/frame';
import {
  Check,
  CircleAlert,
  CircleCheck,
  Clock,
  FileText,
  Megaphone,
  Send,
  Square,
  SquareCheck,
  X,
} from '@/components/icons';
import { Instagram, Messenger } from '@/components/inbox/social-icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { FieldError, Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import {
  NotInThisBuild,
  type FacebookGuidedDraft,
  type FacebookSetupCalls,
} from '@/facebook-setup/calls';

/**
 * Facebook's sign-in in the phone's browser over the app: closing it comes straight back here, and coming back some
 * other way (the app switcher) looks again too. Without a worker in this build, the web finishes it.
 */
function useSignIn(workspaceId: string, calls: FacebookSetupCalls, onBack: () => Promise<void>) {
  const { online } = useNetwork();
  const [busy, setBusy] = React.useState(false);
  const away = React.useRef(false);
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && away.current) {
        away.current = false;
        void onBack();
      }
    });
    return () => sub.remove();
  }, [onBack]);
  const signIn = React.useCallback(async () => {
    if (!online) return toast.error(P.needsSignal);
    setBusy(true);
    try {
      const url = await calls.signIn();
      away.current = true;
      await WebBrowser.openBrowserAsync(url);
      away.current = false;
      await onBack();
    } catch (e) {
      if (e instanceof NotInThisBuild) void openWeb(`/onboarding/${workspaceId}/facebook`);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [online, calls, onBack, workspaceId]);
  return { signIn, busy };
}

/**
 * The guided Facebook & Instagram setup on the phone (the owner, 24 Nov 2026, F4 a: in the same build as the web), as
 * the web's components/facebook-setup/facebook-setup-flow.tsx at phone size: the same four questions one a screen,
 * Check it over, then Connect with Facebook saves them (facebook_setup.save) and opens Facebook's sign-in in the
 * phone's browser over the app; back here, Send yourself a test message. With a Page already connected, Save my
 * answers keeps the sign-in. The answers are saved as they are given, so the web and the phone pick up each other's.
 */
export function FacebookGuidedFlow({
  workspaceId,
  businessName,
  firstName,
  ctx,
  draft,
  calls,
  onConnected,
  onClose,
}: {
  workspaceId: string;
  businessName: string;
  firstName: string | null;
  ctx: FacebookSetupContext;
  draft: FacebookGuidedDraft;
  calls: FacebookSetupCalls;
  /** Back from Facebook's sign-in: on to the test, with what's connected now. */
  onConnected: (instagram: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { online } = useNetwork();
  const [first] = React.useState(() => {
    const start = facebookSetupStart(ctx);
    const kept =
      draft.answers && draft.answers['mode'] === ctx.mode
        ? facebookSetupAnswersOf(draft.answers, start)
        : null;
    return { answers: kept ?? start, kept: !!kept };
  });
  const [answers, setAnswers] = React.useState<FacebookSetupAnswers>(first.answers);
  const questions = facebookSetupQuestions(answers);
  const [screen, setScreen] = React.useState<FacebookSetupScreen>(() => {
    const saved = facebookSetupScreen.safeParse(first.kept ? draft.answers?.['at'] : null);
    const to = saved.success ? saved.data : null;
    return to === 'review' || (to && facebookSetupQuestions(first.answers).includes(to))
      ? to
      : 'inbox';
  });
  const [problems, setProblems] = React.useState<
    Partial<Record<keyof FacebookSetupAnswers, string>>
  >({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const [returnTo, setReturnTo] = React.useState<FacebookSetupScreen | null>(null);
  const [welcome, setWelcome] = React.useState(
    () => first.kept && !!draft.savedAt && Date.now() - Date.parse(draft.savedAt) > 10 * 60_000,
  );
  const scroller = React.useRef<ScrollView>(null);
  const instagram = React.useRef(answers.instagram);
  instagram.current = answers.instagram;
  const back = React.useCallback(() => onConnected(instagram.current), [onConnected]);
  const { signIn, busy: signingIn } = useSignIn(workspaceId, calls, back);

  const saving = useGuidedDraft(
    workspaceId,
    'facebook',
    done ? null : { ...answers, at: screen, mode: ctx.mode },
    { hadDraft: first.kept },
  );

  const set = (patch: Partial<FacebookSetupAnswers>) => {
    setAnswers((now) => ({ ...now, ...patch }));
    setProblems({});
    setError(null);
  };
  const go = (to: FacebookSetupScreen) => {
    setScreen(to);
    setProblems({});
    setError(null);
    setWelcome(false);
    scroller.current?.scrollTo({ y: 0, animated: false });
  };

  const i = screen === 'review' ? questions.length : Math.max(0, questions.indexOf(screen));
  // Picking Instagram from Check it over still asks Instagram's steps on the way back.
  const throughInstagram =
    screen === 'inbox' && answers.instagram && questions[i + 1] === 'instagram';

  function next() {
    if (screen === 'review') return;
    const found = facebookSetupProblems(screen, answers, ctx);
    if (found.length) {
      setProblems(Object.fromEntries(found.map((p) => [p.path, p.message])));
      return;
    }
    if (returnTo && !throughInstagram) {
      setReturnTo(null);
      go('review');
      return;
    }
    go(questions[i + 1] ?? 'review');
  }
  const goBack = () => {
    setReturnTo(null);
    const before = screen === 'review' ? questions[questions.length - 1] : questions[i - 1];
    if (before) go(before);
  };

  async function finish(how: 'connect' | 'save') {
    const wrong = facebookSetupFirstProblem(answers, ctx);
    if (wrong) {
      go(wrong);
      setProblems(
        Object.fromEntries(
          facebookSetupProblems(wrong, answers, ctx).map((p) => [p.path, p.message]),
        ),
      );
      return;
    }
    if (!online) return setError(P.needsSignal);
    setBusy(true);
    setError(null);
    try {
      await saving.flush();
      await calls.save(answers);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    setDone(true);
    await saving.clear();
    setBusy(false);
    if (how === 'save') {
      toast.show(W.review.saved);
      onClose();
      return;
    }
    await signIn();
  }

  async function leave() {
    setLeaving(true);
    await saving.flush();
    onClose();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    setAnswers(facebookSetupStart(ctx));
    setReturnTo(null);
    go('inbox');
  }

  const lines = facebookSetupLines(answers, ctx);
  const when = draft.savedAt ? guidedSetupSavedWhen(draft.savedAt, new Date()) : null;
  const banner =
    welcome && when ? (
      <WelcomeBack
        line={`${G.welcomeBack(firstName, when)}${i > 0 && screen !== 'review' ? ` ${G.stoppedAt(i + 1)}` : ''}`}
        onStartOver={() => void startOver()}
      />
    ) : null;

  const page = (
    title: string,
    hint: string | undefined,
    children: React.ReactNode,
    footer: React.ReactNode,
  ) => (
    <GuidedPage
      screen={screen}
      testID="facebook-setup"
      kicker={screen === 'review' ? G.checkKicker : G.question(i + 1, questions.length)}
      settingUp={W.settingUp(businessName)}
      progress={{ at: i + 1, of: questions.length + 1 }}
      title={title}
      hint={hint}
      banner={banner}
      footer={footer}
      saved={saving.state}
      onLeave={() => void leave()}
      leaving={leaving}
      scroller={scroller}
    >
      {children}
    </GuidedPage>
  );
  const question = (title: string, hint: string, children: React.ReactNode) =>
    page(
      title,
      hint,
      children,
      <GuidedFooter
        onBack={i > 0 ? goBack : undefined}
        onNext={next}
        error={error}
        testID="facebook-setup"
        nextLabel={
          (returnTo === 'review' && !throughInstagram) || (!returnTo && i === questions.length - 1)
            ? G.checkItOver
            : G.next
        }
      />,
    );

  if (screen === 'review')
    return page(
      W.review.title,
      `${ctx.mode === 'new' ? W.review.hintNew : W.review.hintAgain} ${G.answersKept}`,
      <>
        <View className="overflow-hidden rounded-menu border border-border bg-card">
          {lines.map((l, at) => (
            <View
              key={l.key}
              className={cn('gap-1 px-4 py-3.5', at > 0 && 'border-t border-border')}
              testID={`facebook-review-${l.key}`}
            >
              <View className="flex-row items-center justify-between gap-3">
                <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
                  {l.label}
                </Text>
                <Pressable
                  role="button"
                  accessibilityLabel={`${G.change}: ${l.label}`}
                  onPress={() => {
                    setReturnTo('review');
                    go(l.key);
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                  testID={`facebook-review-change-${l.key}`}
                >
                  <Text className="text-[14px] font-medium text-accent-text">{G.change}</Text>
                </Pressable>
              </View>
              <Text className="text-[15px] font-semibold">{l.value}</Text>
            </View>
          ))}
        </View>
        <GuidedNote>
          <Text className="text-[13.5px] font-medium">{W.review.onFacebook}</Text>
          {facebookSignInSteps(answers).map((line, n) => (
            <Text key={line} className="text-[13px] leading-[18px] text-text-2">
              {n + 1}. {line}
            </Text>
          ))}
          <Text className="text-[12.5px] leading-[17px] text-text-3">{W.phone.signInHint}</Text>
        </GuidedNote>
        {ctx.mode === 'again' ? (
          <View className="gap-2">
            <Text className="text-[13px] leading-[18px] text-text-2">
              {W.review.saveConnectHint}
            </Text>
            <Button
              variant="secondary"
              loading={signingIn || (busy && done)}
              disabled={busy}
              onPress={() => void finish('connect')}
              testID="facebook-setup-save-connect"
            >
              {W.review.saveConnect}
            </Button>
          </View>
        ) : null}
      </>,
      <GuidedFooter
        onBack={goBack}
        onNext={() => void finish(ctx.mode === 'new' ? 'connect' : 'save')}
        busy={busy || signingIn}
        error={error}
        nextLabel={ctx.mode === 'new' ? W.review.connect : W.review.save}
        testID="facebook-setup"
      />,
    );

  switch (screen) {
    case 'inbox':
      return question(
        W.inbox.title,
        W.inbox.hint,
        <>
          <View className="gap-2">
            <CheckTile
              icon={Messenger}
              title={W.inbox.messenger}
              hint={W.inbox.messengerHint}
              checked
              disabled
              testID="facebook-setup-messenger"
            />
            <CheckTile
              icon={Instagram}
              title={W.inbox.instagram}
              hint={W.inbox.instagramHint}
              checked={answers.instagram}
              onChange={(v) => set({ instagram: v })}
              testID="facebook-setup-instagram"
            />
          </View>
          {!answers.instagram ? (
            <Text
              className="text-[13px] leading-[18px] text-text-2"
              testID="facebook-setup-instagram-off"
            >
              {W.inbox.instagramOff}
            </Text>
          ) : null}
          <GuidedNote>
            <Text className="text-[13.5px] font-medium">{W.inbox.need}</Text>
            {[W.inbox.needLogin, ...(answers.instagram ? [W.inbox.needInstagram] : [])].map((t) => (
              <Text key={t} className="text-[13px] leading-[18px] text-text-2">
                • {t}
              </Text>
            ))}
          </GuidedNote>
          <Text className="text-[12.5px] leading-[17px] text-text-3">{W.inbox.note}</Text>
        </>,
      );

    case 'instagram':
      return question(
        W.instagram.title,
        W.instagram.hint,
        <>
          <View className="overflow-hidden rounded-menu border border-border bg-card">
            {W.instagram.steps.map((s, n) => (
              <Pressable
                key={s.key}
                role="checkbox"
                aria-checked={answers[s.key]}
                accessibilityLabel={s.title}
                onPress={() => set({ [s.key]: !answers[s.key] })}
                className={cn(
                  'flex-row items-start gap-3 px-4 py-3.5 active:bg-card-2',
                  n > 0 && 'border-t border-border',
                )}
                testID={`facebook-setup-${s.key}`}
              >
                <Icon
                  as={answers[s.key] ? SquareCheck : Square}
                  className={cn(
                    'mt-0.5 size-5',
                    answers[s.key] ? 'text-accent' : 'text-border-strong',
                  )}
                />
                <View className="min-w-0 flex-1 gap-1">
                  <Text className="text-[15px] font-semibold">
                    {n + 1}. {s.title}
                  </Text>
                  <Text className="text-[13px] leading-[18px] text-text-2">{s.how}</Text>
                </View>
              </Pressable>
            ))}
          </View>
          <GuidedNote>
            <Text className="text-[13px] leading-[18px] text-text-2">{W.instagram.note}</Text>
          </GuidedNote>
        </>,
      );

    case 'leads': {
      const pipeline = facebookSetupPipeline(answers, ctx);
      const stages = facebookSetupOpenStages(pipeline);
      return question(
        W.leads.title,
        W.leads.hint,
        <>
          <Choices label={W.leads.title}>
            <ChoiceTile
              selected={answers.createLead}
              onSelect={() => set({ createLead: true })}
              title={W.leads.lead}
              best={W.leads.best}
              hint={W.leads.leadHint}
              testID="facebook-setup-lead"
            >
              {ctx.pipelines.length > 1 ? (
                <View className="gap-1.5">
                  <Label>{W.leads.pipeline}</Label>
                  <View className="flex-row flex-wrap gap-2">
                    {ctx.pipelines.map((p, n) => (
                      <FilterChip
                        key={p.id}
                        label={p.name}
                        on={answers.pipelineId ? answers.pipelineId === p.id : n === 0}
                        onPress={() => set({ pipelineId: n === 0 ? null : p.id, stageId: null })}
                        testID={`facebook-setup-pipeline-${n}`}
                      />
                    ))}
                  </View>
                </View>
              ) : null}
              {stages.length > 1 ? (
                <View className="gap-1.5">
                  <Label>{W.leads.stage}</Label>
                  <View className="flex-row flex-wrap gap-2">
                    {stages.map((st, n) => (
                      <FilterChip
                        key={st.id}
                        label={st.name}
                        on={answers.stageId ? answers.stageId === st.id : n === 0}
                        onPress={() => set({ stageId: n === 0 ? null : st.id })}
                        testID={`facebook-setup-stage-${n}`}
                      />
                    ))}
                  </View>
                </View>
              ) : null}
              {problems.pipelineId ? <FieldError>{problems.pipelineId}</FieldError> : null}
              {problems.stageId ? <FieldError>{problems.stageId}</FieldError> : null}
            </ChoiceTile>
            <ChoiceTile
              selected={!answers.createLead}
              onSelect={() => set({ createLead: false })}
              title={W.leads.customer}
              hint={W.leads.customerHint}
              testID="facebook-setup-customer"
            />
          </Choices>
          <GuidedNote>
            <Text className="text-[13px] leading-[18px] text-text-2">{W.leads.note}</Text>
          </GuidedNote>
        </>,
      );
    }

    case 'ads':
      return question(
        W.ads.title,
        W.ads.hint,
        <>
          <View className="gap-2">
            <CheckTile
              icon={Megaphone}
              title={W.ads.chat}
              hint={W.ads.chatHint}
              checked={answers.adsChat}
              onChange={(v) => set({ adsChat: v })}
              testID="facebook-setup-ads-chat"
            />
            <CheckTile
              icon={FileText}
              title={W.ads.leadAds}
              hint={W.ads.leadAdsHint}
              badge={ctx.readsLeads ? undefined : W.ads.leadAdsWait}
              checked={answers.leadAds}
              disabled={!ctx.readsLeads}
              onChange={(v) => set({ leadAds: v })}
              testID="facebook-setup-lead-ads"
            />
            <CheckTile
              icon={X}
              title={W.ads.none}
              hint={W.ads.noneHint}
              checked={!answers.adsChat && !answers.leadAds}
              onChange={(v) => set(v ? { adsChat: false, leadAds: false } : { adsChat: true })}
              testID="facebook-setup-ads-none"
            />
          </View>
          {problems.leadAds ? <FieldError>{problems.leadAds}</FieldError> : null}
          <Text className="text-[12.5px] leading-[17px] text-text-3">{W.ads.note}</Text>
        </>,
      );
  }
}

/** A tick box as a tile: its icon, what it is, and why, with a note when it can't be ticked yet. */
function CheckTile({
  icon,
  title,
  hint,
  badge,
  checked,
  disabled,
  onChange,
  testID,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  badge?: string | undefined;
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  testID: string;
}) {
  return (
    <Pressable
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled}
      accessibilityLabel={title}
      disabled={disabled}
      onPress={() => onChange?.(!checked)}
      testID={testID}
      className={cn(
        'flex-row items-start gap-3 rounded-menu border px-4 py-3.5',
        checked ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
        !disabled && !checked && 'active:bg-card-2',
        disabled && !checked && 'opacity-60',
      )}
    >
      <Icon
        as={checked ? SquareCheck : Square}
        className={cn('mt-0.5 size-5', checked ? 'text-accent' : 'text-border-strong')}
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-2">
          <Icon as={icon} className="size-4 text-text-2" />
          <Text className="shrink text-[15px] font-semibold">{title}</Text>
          {badge ? <Badge variant="pending">{badge}</Badge> : null}
        </View>
        <Text className="text-[13px] leading-[18px] text-text-2">{hint}</Text>
      </View>
    </Pressable>
  );
}

/**
 * Facebook & Instagram on the phone once something is connected (F3 a at phone size): what's connected, Send a test
 * message, Connect more, and the answers with Go through the questions again. Everything else stays on the web, under
 * All settings.
 */
export function FacebookPhoneOverview({
  workspaceId,
  ctx,
  calls,
  onTest,
  onAgain,
  onConnected,
  onClose,
}: {
  workspaceId: string;
  ctx: FacebookSetupContext;
  calls: FacebookSetupCalls;
  onTest: () => void;
  onAgain: () => void;
  onConnected: () => Promise<void>;
  onClose: () => void;
}) {
  const { signIn, busy } = useSignIn(workspaceId, calls, onConnected);
  return (
    <GuidedPage
      screen="overview"
      testID="facebook-setup"
      kicker={W.phone.row}
      progress={null}
      title={W.summary.connected}
      hint={W.summary.lead}
      saved="idle"
      onLeave={onClose}
      leaveLabel={G.close}
      footer={
        <Button icon={Send} onPress={onTest} testID="facebook-setup-send-test">
          {W.summary.sendTest}
        </Button>
      }
    >
      <View className="overflow-hidden rounded-menu border border-border bg-card">
        {ctx.accounts.map((a, n) => (
          <AccountRow key={a.id} account={a} first={n === 0}>
            {a.status === 'needs_attention' ? (
              <Badge variant="pending">{W.summary.needsAttention}</Badge>
            ) : (
              <Badge variant="ok">{W.summary.answering}</Badge>
            )}
          </AccountRow>
        ))}
      </View>
      <Button
        variant="secondary"
        loading={busy}
        onPress={() => void signIn()}
        testID="facebook-setup-connect-more"
      >
        {W.summary.connectMore}
      </Button>
      <View className="overflow-hidden rounded-menu border border-border bg-card">
        {facebookSettingsLines(ctx).map((l, at) => (
          <View
            key={l.key}
            className={cn('gap-1 px-4 py-3.5', at > 0 && 'border-t border-border')}
            testID={`facebook-answer-${l.key}`}
          >
            <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
              {l.label}
            </Text>
            <Text className="text-[15px]">{l.value}</Text>
          </View>
        ))}
      </View>
      <Button variant="ghost" onPress={onAgain} testID="facebook-setup-again">
        {W.summary.again}
      </Button>
    </GuidedPage>
  );
}

function AccountRow({
  account: a,
  first,
  children,
}: {
  account: FacebookSetupAccount;
  first: boolean;
  children: React.ReactNode;
}) {
  const ig = a.platform === 'instagram';
  return (
    <View
      className={cn('gap-2 px-4 py-3.5', !first && 'border-t border-border')}
      testID={`facebook-account-${a.id}`}
    >
      <View className="flex-row items-center gap-2.5">
        <Icon as={ig ? Instagram : Messenger} className="size-5 text-text-2" />
        <View className="min-w-0 flex-1">
          <Text className="text-[15px] font-semibold">{metaAccountLabel(a)}</Text>
          <Text className="text-[12.5px] text-text-3">
            {ig ? W.test.kindInstagram : W.test.kindPage}
          </Text>
        </View>
      </View>
      <View className="flex-row">{children}</View>
    </View>
  );
}

/**
 * Send yourself a test message on the phone (F2 a): each Page and Instagram account connected now, turning green
 * when a message lands; asked again every few seconds until each has one.
 */
export function FacebookPhoneTest({
  workspaceId,
  accounts,
  instagramAsked,
  calls,
  onConnected,
  onClose,
}: {
  workspaceId: string;
  accounts: readonly FacebookSetupAccount[];
  instagramAsked: boolean;
  calls: FacebookSetupCalls;
  onConnected: () => Promise<void>;
  onClose: () => void;
}) {
  const [since] = React.useState(() => new Date(Date.now() - 2 * 60_000).toISOString());
  const [opened] = React.useState(() => Date.now());
  const [got, setGot] = React.useState<MetaAccountTestMessages['accounts']>([]);
  const [now, setNow] = React.useState(() => Date.now());
  const { signIn, busy } = useSignIn(workspaceId, calls, onConnected);
  const gotFor = (id: string) => got.find((g) => g.accountId === id)?.gotAt ?? null;
  const allIn = accounts.length > 0 && accounts.every((a) => gotFor(a.id));

  React.useEffect(() => {
    if (accounts.length === 0 || allIn) return;
    let stop = false;
    const ask = async () => {
      try {
        const out = await calls.testMessages(since);
        if (!stop) setGot(out);
      } catch {
        // Asked again in a moment.
      }
      if (!stop) setNow(Date.now());
    };
    void ask();
    const timer = setInterval(() => {
      if (Date.now() - opened > 15 * 60_000) return clearInterval(timer);
      void ask();
    }, 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [accounts.length, allIn, calls, since, opened]);

  const waited = now - opened > FACEBOOK_TEST_HINT_AFTER_MS;
  const waiting = (platform: 'facebook' | 'instagram') =>
    accounts.some((a) => a.platform === platform && !gotFor(a.id));
  const noInstagram = instagramAsked && !accounts.some((a) => a.platform === 'instagram');
  const names = accounts.map((a) => metaAccountLabel(a)).join(' and ');

  return (
    <GuidedPage
      screen="test"
      testID="facebook-setup"
      kicker={W.phone.row}
      progress={accounts.length ? { at: 1, of: 1 } : null}
      title={W.test.title}
      hint={accounts.length ? W.test.hintPhone : undefined}
      banner={
        accounts.length ? (
          <View
            className="flex-row items-center gap-2.5 rounded-menu bg-success-soft px-3.5 py-3"
            role="status"
            testID="facebook-test-connected"
          >
            <Icon as={CircleCheck} className="size-4 text-success-text" />
            <Text className="min-w-0 flex-1 text-[13.5px] font-semibold text-success-text">
              {W.test.connected(names)}
            </Text>
          </View>
        ) : null
      }
      saved="idle"
      onLeave={onClose}
      leaveLabel={G.close}
      footer={
        <Button onPress={onClose} testID="facebook-test-done">
          {W.test.done}
        </Button>
      }
    >
      {accounts.length === 0 ? (
        <View className="gap-3" testID="facebook-test-nothing">
          <Text className="text-[15px] font-semibold">{W.test.nothing}</Text>
          <Text className="text-[14px] leading-[20px] text-text-2">{W.test.nothingHint}</Text>
          <Button variant="secondary" loading={busy} onPress={() => void signIn()}>
            {W.test.tryAgain}
          </Button>
        </View>
      ) : (
        <>
          <View className="gap-2">
            {accounts.map((a) => {
              const at = gotFor(a.id);
              const preview = got.find((g) => g.accountId === a.id)?.preview ?? null;
              return (
                <View
                  key={a.id}
                  className="gap-2.5 rounded-menu border border-border bg-card px-4 py-3.5"
                  testID={`facebook-test-${a.id}`}
                >
                  <View className="flex-row items-center gap-2.5">
                    <Icon
                      as={a.platform === 'instagram' ? Instagram : Messenger}
                      className="size-5 text-text-2"
                    />
                    <Text className="min-w-0 flex-1 text-[15px] font-semibold">
                      {metaAccountLabel(a)}
                    </Text>
                  </View>
                  <View
                    className={cn(
                      'flex-row items-center gap-2 self-start rounded-[8px] px-2.5 py-1.5',
                      at ? 'bg-success-soft' : 'bg-card-2',
                    )}
                  >
                    <Icon
                      as={at ? Check : Clock}
                      className={cn('size-4', at ? 'text-success-text' : 'text-text-2')}
                    />
                    <Text
                      className={cn(
                        'text-[13.5px] font-semibold',
                        at ? 'text-success-text' : 'text-text-2',
                      )}
                    >
                      {at ? W.test.got(preview) : W.test.waiting}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
          {waited && waiting('instagram') ? (
            <Hint testID="facebook-test-stuck-instagram">{W.test.stuckInstagram}</Hint>
          ) : null}
          {waited && waiting('facebook') ? (
            <Hint testID="facebook-test-stuck-page">{W.test.stuckPage}</Hint>
          ) : null}
          {noInstagram ? (
            <View className="gap-2">
              <Hint testID="facebook-test-no-instagram">{W.test.noInstagram}</Hint>
              <Button variant="secondary" loading={busy} onPress={() => void signIn()}>
                {W.test.tryAgain}
              </Button>
            </View>
          ) : null}
        </>
      )}
    </GuidedPage>
  );
}

function Hint({ children, testID }: { children: string; testID: string }) {
  return (
    <View
      className="flex-row items-start gap-2.5 rounded-menu bg-warning-soft px-3.5 py-3"
      role="status"
      testID={testID}
    >
      <Icon as={CircleAlert} className="mt-0.5 size-4 text-warning-text" />
      <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-warning-text">
        {children}
      </Text>
    </View>
  );
}
