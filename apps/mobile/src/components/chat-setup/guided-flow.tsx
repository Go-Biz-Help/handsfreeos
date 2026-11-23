import {
  CHAT_SETUP_LIFTS,
  CHAT_SETUP_QUESTIONS,
  CHAT_SETUP_WORDS as W,
  chatSetupAnswersOf,
  chatSetupFirstProblem,
  chatSetupLines,
  chatSetupProblems,
  chatSetupScreen,
  chatSetupStart,
  chatSetupSwatches,
  chatSetupTeammateChange,
  chatSiteShown,
  GUIDED_SETUP_WORDS as G,
  guidedSetupSavedWhen,
  logoBox,
  MAX_CHAT_ORIGINS,
  normalizeChatOrigin,
  normalizeChatOrigins,
  readableTextOn,
  type ChatSetupAnswers,
  type ChatSetupContext,
  type ChatSetupQuestion,
  type ChatSetupScreen,
} from '@hfos/core';
import * as React from 'react';
import { Image, Pressable, View, type ScrollView } from 'react-native';

import {
  ChoiceTile,
  Choices,
  GuidedFooter,
  GuidedNote,
  GuidedPage,
  useGuidedDraft,
  WelcomeBack,
} from '@/components/guided-setup/frame';
import { Check, Globe, MessageCircle, Plus, X } from '@/components/icons';
import { EmailMeALink } from '@/components/onboarding-setup/screens';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import type { ChatGuidedDraft, ChatSetupCalls } from '@/chat-setup/calls';
import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

type Problems = Partial<Record<keyof ChatSetupAnswers, string>>;
type Logo = { readonly url: string; readonly width: number; readonly height: number } | null;

const problemsOf = (q: ChatSetupScreen, a: ChatSetupAnswers, ctx: ChatSetupContext): Problems =>
  Object.fromEntries(chatSetupProblems(q, a, ctx).map((p) => [p.path, p.message]));

/**
 * The guided website chat setup on the phone (the owner, 23 Nov 2026, W4 b: the six questions here too, only the code
 * step opens the web), as the web's components/chat-setup/chat-setup-flow.tsx at phone size: the same six questions
 * one a screen, Check it over, and Turn on website chat (chat_setup.save), which turns on the AI teammate's Website
 * chat too (W1). Then Put it on your site, which opens the web, since pasting code is a computer's job. The answers
 * are saved as they are given, so the web and the phone pick up each other's. What is wrong with an answer and what
 * Turn on website chat sends are core's.
 */
export function ChatGuidedFlow({
  workspaceId,
  businessName,
  firstName,
  ctx,
  logo,
  draft,
  calls,
  onSaved,
  onClose,
}: {
  workspaceId: string;
  businessName: string;
  firstName: string | null;
  ctx: ChatSetupContext;
  logo: Logo;
  draft: ChatGuidedDraft;
  calls: ChatSetupCalls;
  /** A new chat was made: Put it on your site comes next. */
  onSaved: (answers: ChatSetupAnswers) => void;
  onClose: () => void;
}) {
  const { online } = useNetwork();
  const widgetId = ctx.widget?.id ?? null;
  const [first] = React.useState(() => {
    const start = chatSetupStart(ctx);
    const usable =
      draft.answers &&
      draft.answers['mode'] === ctx.mode &&
      (draft.answers['widgetId'] ?? null) === widgetId;
    const kept = usable ? chatSetupAnswersOf(draft.answers, start) : null;
    return { answers: kept ?? start, kept: !!kept };
  });
  const [answers, setAnswers] = React.useState<ChatSetupAnswers>(first.answers);
  const questions = CHAT_SETUP_QUESTIONS;
  const [screen, setScreen] = React.useState<ChatSetupScreen>(() => {
    const saved = chatSetupScreen.safeParse(first.kept ? draft.answers?.['at'] : null);
    return saved.success ? saved.data : questions[0];
  });
  const [done, setDone] = React.useState(false);
  const [problems, setProblems] = React.useState<Problems>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const [returnTo, setReturnTo] = React.useState<ChatSetupScreen | null>(null);
  const [welcome, setWelcome] = React.useState(
    () => first.kept && !!draft.savedAt && Date.now() - Date.parse(draft.savedAt) > 10 * 60_000,
  );
  const scroller = React.useRef<ScrollView>(null);

  const saving = useGuidedDraft(
    workspaceId,
    'chat',
    done ? null : { ...answers, at: screen, mode: ctx.mode, widgetId },
    { hadDraft: first.kept },
  );

  const set = (patch: Partial<ChatSetupAnswers>) => {
    setAnswers((now) => ({ ...now, ...patch }));
    setProblems({});
    setError(null);
  };
  const go = (to: ChatSetupScreen) => {
    setScreen(to);
    setProblems({});
    setError(null);
    setWelcome(false);
    scroller.current?.scrollTo({ y: 0, animated: false });
  };

  const i = screen === 'review' ? questions.length : Math.max(0, questions.indexOf(screen));
  const teammate = ctx.teammate;
  const aiName = answers.who === 'ai' && teammate ? teammate.name : null;

  function next() {
    if (screen === 'review') return;
    const found = problemsOf(screen, answers, ctx);
    if (Object.keys(found).length) return setProblems(found);
    const after = questions[i + 1];
    if (returnTo || !after) {
      setReturnTo(null);
      go('review');
      return;
    }
    go(after);
  }
  const back = () => {
    setReturnTo(null);
    const before = screen === 'review' ? questions[questions.length - 1] : questions[i - 1];
    if (before) go(before);
  };

  async function finish() {
    const wrong = chatSetupFirstProblem(answers, ctx);
    if (wrong) {
      go(wrong);
      setProblems(problemsOf(wrong, answers, ctx));
      return;
    }
    if (!online) return setError(P.needsSignal);
    setBusy(true);
    setError(null);
    let out: Awaited<ReturnType<ChatSetupCalls['save']>>;
    try {
      await saving.flush();
      out = await calls.save(widgetId, answers);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    setDone(true);
    await saving.clear();
    if (out.teammateChat === 'not_allowed' && teammate)
      toast.show(W.review.notAllowedTeammate(teammate.name));
    if (!out.created) {
      toast.show(W.review.saved);
      onClose();
      return;
    }
    onSaved(answers);
  }

  async function leave() {
    setLeaving(true);
    await saving.flush();
    onClose();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    setAnswers(chatSetupStart(ctx));
    setReturnTo(null);
    go(questions[0]);
  }

  const when = draft.savedAt ? guidedSetupSavedWhen(draft.savedAt, new Date()) : null;
  const banner =
    welcome && when ? (
      <WelcomeBack
        line={`${G.welcomeBack(firstName, when)}${i > 0 && screen !== 'review' ? ` ${G.stoppedAt(i + 1)}` : ''}`}
        onStartOver={() => void startOver()}
      />
    ) : ctx.mode === 'new' && !first.kept && i === 0 ? (
      <Text className="text-[13px] leading-[18px] text-text-3" testID="chat-setup-started-from">
        {W.startedFrom}
      </Text>
    ) : null;

  const page = (
    title: string,
    hint: string | undefined,
    children: React.ReactNode,
    footer: React.ReactNode,
  ) => (
    <GuidedPage
      screen={screen}
      testID="chat-setup"
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
  const question = (q: ChatSetupQuestion, title: string, hint: string, children: React.ReactNode) =>
    page(
      title,
      hint,
      children,
      <GuidedFooter
        onBack={i > 0 ? back : undefined}
        onNext={next}
        busy={busy}
        error={error}
        testID="chat-setup"
        nextLabel={
          returnTo === 'review' || (!returnTo && q === questions[questions.length - 1])
            ? G.checkItOver
            : G.next
        }
      />,
    );

  if (screen === 'review') {
    const change = chatSetupTeammateChange(answers, { teammate, widget: ctx.widget });
    const happens =
      ctx.mode === 'again'
        ? [W.review.nextSave]
        : [
            W.review.nextOn,
            ...(aiName && (change === 'turn_on' || change === 'move')
              ? [W.review.nextAi(aiName)]
              : []),
            W.review.nextCode,
          ];
    return page(
      W.review.title,
      `${ctx.mode === 'new' ? W.review.hintNew : W.review.hintAgain} ${G.answersKept}`,
      <>
        <View className="overflow-hidden rounded-menu border border-border bg-card">
          {chatSetupLines(answers, ctx).map((l, at) => (
            <View
              key={l.key}
              className={cn('gap-1 px-4 py-3.5', at > 0 && 'border-t border-border')}
              testID={`chat-review-${l.key}`}
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
                  testID={`chat-review-change-${l.key}`}
                >
                  <Text className="text-[14px] font-medium text-accent-text">{G.change}</Text>
                </Pressable>
              </View>
              <Text className="text-[15px] font-semibold">{l.value}</Text>
            </View>
          ))}
        </View>
        <View className="gap-3" testID="chat-review-next">
          <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
            {W.review.next}
          </Text>
          {happens.map((line, at) => (
            <View key={line} className="flex-row items-start gap-2.5">
              <View className="mt-px size-5 items-center justify-center rounded-full border border-border-strong">
                <Text className="text-[11px] font-semibold text-text-2">{at + 1}</Text>
              </View>
              <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-text-2">
                {line}
              </Text>
            </View>
          ))}
        </View>
      </>,
      <GuidedFooter
        onBack={back}
        onNext={() => void finish()}
        busy={busy}
        error={error}
        nextLabel={ctx.mode === 'new' ? W.review.turnOn : W.review.save}
        testID="chat-setup"
      />,
    );
  }

  switch (screen) {
    case 'sites':
      return question(
        'sites',
        W.sites.title,
        W.sites.hint,
        <SitesQuestion
          sites={answers.sites}
          website={ctx.website}
          problem={problems.sites ?? null}
          onChange={(sites) => set({ sites })}
        />,
      );

    case 'who': {
      const change = chatSetupTeammateChange(answers, { teammate, widget: ctx.widget });
      return question(
        'who',
        W.who.title,
        W.who.hint,
        <>
          <Choices label={W.who.title}>
            {teammate ? (
              <ChoiceTile
                selected={answers.who === 'ai'}
                onSelect={() => set({ who: 'ai' })}
                title={W.who.ai(teammate.name)}
                best={W.who.aiBest}
                hint={W.who.aiHint(teammate.name)}
                testID="chat-setup-who-ai"
              >
                {teammate.status === 'off' ? <Hint text={W.who.off(teammate.name)} /> : null}
                {change === 'turn_on' || change === 'move' ? (
                  <Hint
                    text={
                      change === 'move' ? W.who.move(teammate.name) : W.who.turnOn(teammate.name)
                    }
                    testID="chat-setup-who-turn-on"
                  />
                ) : null}
              </ChoiceTile>
            ) : null}
            <ChoiceTile
              selected={answers.who === 'team'}
              onSelect={() => set({ who: 'team' })}
              title={W.who.team}
              best={teammate ? undefined : W.who.aiBest}
              hint={W.who.teamHint}
              testID="chat-setup-who-team"
            />
          </Choices>
          <FieldError>{problems.who}</FieldError>
          {!teammate ? (
            <GuidedNote>
              <Text className="text-[13.5px] font-medium">{W.who.noTeammate}</Text>
              <Text className="text-[13px] leading-[18px] text-text-2">{W.who.noTeammateHint}</Text>
            </GuidedNote>
          ) : null}
        </>,
      );
    }

    case 'away':
      return question(
        'away',
        W.away.title,
        aiName ? W.away.hintAi(aiName) : W.away.hintTeam,
        <>
          <Choices label={W.away.title}>
            <ChoiceTile
              selected={answers.whenAway === 'chat'}
              onSelect={() => set({ whenAway: 'chat' })}
              title={W.away.chat}
              hint={W.away.chatHint}
              testID="chat-setup-away-chat"
            />
            <ChoiceTile
              selected={answers.whenAway === 'away_form'}
              onSelect={() => set({ whenAway: 'away_form' })}
              title={W.away.form}
              hint={W.away.formHint}
              testID="chat-setup-away-form"
            />
          </Choices>
          <View className="gap-1.5">
            <Label nativeID="chat-away-message">{W.away.messageLabel}</Label>
            <Input
              aria-labelledby="chat-away-message"
              multiline
              numberOfLines={3}
              className="min-h-[80px] py-2.5"
              style={{ textAlignVertical: 'top' }}
              value={answers.awayMessage}
              onChangeText={(awayMessage) => set({ awayMessage: awayMessage.slice(0, 600) })}
              placeholder={
                answers.whenAway === 'chat' ? W.away.chatPlaceholder : W.away.formPlaceholder
              }
              invalid={!!problems.awayMessage}
              testID="chat-setup-away-message"
            />
            <FieldError>{problems.awayMessage}</FieldError>
            <Text className="text-[12.5px] leading-[17px] text-text-3">
              {answers.whenAway === 'chat' ? W.away.chatMessageHint : W.away.formMessageHint}
            </Text>
          </View>
        </>,
      );

    case 'ask':
      return question(
        'ask',
        W.ask.title,
        W.ask.hint,
        <>
          {W.ask.rows.map((row) => (
            <View key={row.key} className="gap-2">
              <Text className="text-[15px] font-semibold">{row.label}</Text>
              <View
                role="radiogroup"
                aria-label={W.ask.askLabel(row.label)}
                className="flex-row flex-wrap gap-2"
              >
                {W.ask.choices.map((c) => (
                  <Pill
                    key={c.value}
                    on={answers[row.key] === c.value}
                    label={c.label}
                    onPress={() => set({ [row.key]: c.value })}
                    testID={`chat-setup-${row.key}-${c.value}`}
                  />
                ))}
              </View>
            </View>
          ))}
          <GuidedNote>
            <Text className="text-[13px] leading-[18px] text-text-2">
              {aiName ? W.ask.explainAi(aiName) : W.ask.explainTeam}
            </Text>
          </GuidedNote>
          <SwitchRow
            title={W.ask.textsBox}
            hint={W.ask.textsHint}
            value={answers.smsConsent}
            onChange={(smsConsent) => set({ smsConsent })}
            testID="chat-setup-texts-box"
          />
        </>,
      );

    case 'look': {
      const swatches = chatSetupSwatches(ctx, answers.accentColor);
      const picked = answers.accentColor.toLowerCase();
      return question(
        'look',
        W.look.title,
        W.look.hint,
        <>
          <View className="gap-1.5">
            <Label nativeID="chat-greeting">{W.look.greeting}</Label>
            <Input
              aria-labelledby="chat-greeting"
              multiline
              numberOfLines={3}
              className="min-h-[80px] py-2.5"
              style={{ textAlignVertical: 'top' }}
              value={answers.greeting}
              onChangeText={(greeting) => set({ greeting: greeting.slice(0, 600) })}
              invalid={!!problems.greeting}
              testID="chat-setup-greeting"
            />
            <FieldError>{problems.greeting}</FieldError>
          </View>
          <View className="gap-1.5">
            <Label nativeID="chat-label">{W.look.label}</Label>
            <Input
              aria-labelledby="chat-label"
              value={answers.launcherLabel}
              maxLength={60}
              onChangeText={(launcherLabel) => set({ launcherLabel })}
              invalid={!!problems.launcherLabel}
              testID="chat-setup-label"
            />
            <FieldError>{problems.launcherLabel}</FieldError>
          </View>
          <View className="gap-2">
            <Text className="text-[14px] font-medium">{W.look.colour}</Text>
            <View role="radiogroup" aria-label={W.look.colour} className="flex-row flex-wrap gap-3">
              {swatches.map((c) => {
                const name =
                  c === ctx.brandColor ? W.look.yourColour : (W.look.colourNames[c] ?? c);
                return (
                  <Pressable
                    key={c}
                    role="radio"
                    aria-checked={picked === c}
                    accessibilityLabel={name}
                    onPress={() => set({ accentColor: c })}
                    className={cn(
                      'size-11 items-center justify-center rounded-full border-2',
                      picked === c ? 'border-text' : 'border-transparent',
                    )}
                    testID={`chat-setup-colour-${c.slice(1)}`}
                  >
                    <View className="size-9 rounded-full" style={{ backgroundColor: c }} />
                  </Pressable>
                );
              })}
            </View>
            <FieldError>{problems.accentColor}</FieldError>
            <Text className="text-[12.5px] leading-[17px] text-text-3">
              {ctx.brandColor && picked === ctx.brandColor
                ? W.look.colourHintBrand(W.look.yourColour)
                : W.look.colourHint}
            </Text>
          </View>
          <SwitchRow
            title={W.look.logo}
            hint={ctx.hasLogo ? W.look.logoHint : W.look.noLogoHint}
            value={answers.showLogo && ctx.hasLogo}
            onChange={(showLogo) => set({ showLogo })}
            disabled={!ctx.hasLogo}
            testID="chat-setup-logo"
          />
          <View className="gap-2">
            <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
              {W.look.preview}
            </Text>
            <LookPreview answers={answers} businessName={businessName} logo={logo} />
          </View>
        </>,
      );
    }

    case 'place': {
      const lifts: number[] = [...CHAT_SETUP_LIFTS];
      const own = !lifts.includes(answers.mobileLift) ? answers.mobileLift : null;
      return question(
        'place',
        W.place.title,
        W.place.hint,
        <>
          <View className="gap-3 rounded-menu border border-border bg-card p-4">
            <Text className="text-[15px] font-semibold">{W.place.computers}</Text>
            <Segmented
              label={`${W.place.computers}: ${W.place.corner}`}
              value={answers.position}
              onChange={(position) => set({ position })}
              options={[
                { value: 'left', label: W.place.left, testID: 'chat-setup-corner-left' },
                { value: 'right', label: W.place.right, testID: 'chat-setup-corner-right' },
              ]}
            />
            <Segmented
              label={`${W.place.computers}: ${W.place.button}`}
              value={answers.desktopButton}
              onChange={(desktopButton) => set({ desktopButton })}
              options={[
                { value: 'label', label: W.place.label, testID: 'chat-setup-desktop-label' },
                { value: 'icon', label: W.place.icon, testID: 'chat-setup-desktop-icon' },
              ]}
            />
          </View>
          <View className="gap-3">
            <Text className="text-[15px] font-semibold">{W.place.phones}</Text>
            <Text className="text-[14px] leading-[20px] text-text-2">{W.place.barQuestion}</Text>
            <Choices label={W.place.barQuestion}>
              <ChoiceTile
                selected={answers.phone === 'same'}
                onSelect={() => set({ phone: 'same' })}
                title={W.place.same}
                testID="chat-setup-phone-same"
              />
              <ChoiceTile
                selected={answers.phone === 'lift'}
                onSelect={() => set({ phone: 'lift' })}
                title={W.place.lift}
                testID="chat-setup-phone-lift"
              >
                <View
                  role="radiogroup"
                  aria-label={W.place.lift}
                  className="flex-row flex-wrap gap-2"
                >
                  {[...(own ? [own] : []), ...lifts].map((px) => (
                    <Pill
                      key={px}
                      on={answers.mobileLift === px}
                      label={px === own ? W.place.ownLift(px) : (W.place.lifts[px] ?? `${px} px`)}
                      onPress={() => set({ mobileLift: px })}
                      testID={`chat-setup-lift-${px}`}
                    />
                  ))}
                </View>
                <FieldError>{problems.mobileLift}</FieldError>
              </ChoiceTile>
              <ChoiceTile
                selected={answers.phone === 'hidden'}
                onSelect={() => set({ phone: 'hidden' })}
                title={W.place.hidden}
                hint={W.place.hiddenHint}
                testID="chat-setup-phone-hidden"
              />
            </Choices>
            {answers.phone !== 'hidden' ? (
              <Segmented
                label={`${W.place.phones}: ${W.place.button}`}
                value={answers.mobileButton}
                onChange={(mobileButton) => set({ mobileButton })}
                options={[
                  { value: 'label', label: W.place.label, testID: 'chat-setup-mobile-label' },
                  { value: 'icon', label: W.place.icon, testID: 'chat-setup-mobile-icon' },
                ]}
              />
            ) : null}
          </View>
          <GuidedNote>
            <Text className="text-[13px] leading-[18px] text-text-2">{W.place.note}</Text>
          </GuidedNote>
        </>,
      );
    }
  }
}

function SitesQuestion({
  sites,
  website,
  problem,
  onChange,
}: {
  sites: readonly string[];
  website: string | null;
  problem: string | null;
  onChange: (sites: string[]) => void;
}) {
  const [value, setValue] = React.useState('');
  const listed = normalizeChatOrigins(sites, { allowNone: true }).origins;
  const check = value.trim() ? normalizeChatOrigin(value) : null;
  const already = !!check?.ok && listed.includes(check.origin);
  const tooMany =
    !!check?.ok &&
    listed.length + 1 + (check.twin && !listed.includes(check.twin) ? 1 : 0) > MAX_CHAT_ORIGINS;
  const typedProblem = !check
    ? null
    : !check.ok
      ? check.message
      : already
        ? W.sites.already
        : tooMany
          ? W.sites.limit
          : null;
  const note =
    check?.ok && !typedProblem
      ? W.sites.adds(
          chatSiteShown(check.origin),
          check.twin && !listed.includes(check.twin) ? chatSiteShown(check.twin) : null,
        )
      : null;
  const fromSignUp = website ? normalizeChatOrigin(website) : null;
  const add = () => {
    if (!check?.ok || typedProblem) return;
    onChange([...sites, value.trim()]);
    setValue('');
  };
  return (
    <>
      {sites.length ? (
        <View className="overflow-hidden rounded-menu border border-border bg-card">
          {sites.map((s, n) => {
            const r = normalizeChatOrigin(s);
            const shown = r.ok ? chatSiteShown(r.origin) : s;
            const signUp = r.ok && fromSignUp?.ok && fromSignUp.origin === r.origin;
            return (
              <View
                key={`${s}-${n}`}
                className={cn(
                  'flex-row items-center gap-3 px-4 py-3',
                  n > 0 && 'border-t border-border',
                )}
                testID="chat-setup-site"
              >
                <Icon as={Globe} className="size-4 text-text-3" />
                <View className="min-w-0 flex-1 gap-0.5">
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Text className="text-[15px] font-semibold">{shown}</Text>
                    {signUp ? <Badge variant="gray">{W.sites.fromSignUp}</Badge> : null}
                  </View>
                  {r.ok && r.twin ? (
                    <Text className="text-[12.5px] text-text-3">
                      {W.sites.twin(chatSiteShown(r.twin))}
                    </Text>
                  ) : !r.ok ? (
                    <Text className="text-[12.5px] text-danger-text">{r.message}</Text>
                  ) : null}
                </View>
                <Pressable
                  role="button"
                  accessibilityLabel={W.sites.remove(shown)}
                  onPress={() => onChange(sites.filter((_, k) => k !== n))}
                  hitSlop={10}
                  className="size-9 items-center justify-center"
                  testID="chat-setup-site-remove"
                >
                  <Icon as={X} className="size-4 text-text-2" />
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}
      <View className="gap-1.5">
        <Label nativeID="chat-site-add">{sites.length ? W.sites.addLabel : W.sites.label}</Label>
        <View className="flex-row gap-2">
          <Input
            aria-labelledby="chat-site-add"
            className="min-w-0 flex-1"
            value={value}
            onChangeText={setValue}
            onSubmitEditing={add}
            placeholder={W.sites.addPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            invalid={!!typedProblem}
            testID="chat-setup-site-input"
          />
          <Button
            variant="secondary"
            onPress={add}
            disabled={!check?.ok || !!typedProblem}
            icon={Plus}
            testID="chat-setup-site-submit"
          >
            {W.sites.add}
          </Button>
        </View>
        <Text
          className={cn(
            'text-[12.5px] leading-[17px]',
            typedProblem ? 'text-danger-text' : 'text-text-3',
          )}
          testID="chat-setup-site-note"
        >
          {typedProblem ?? note ?? W.sites.limit}
        </Text>
      </View>
      <FieldError>{problem}</FieldError>
      {!sites.length ? (
        <GuidedNote>
          <Text className="text-[13px] leading-[18px] text-text-2">{W.sites.noWebsite}</Text>
        </GuidedNote>
      ) : null}
    </>
  );
}

function Hint({ text, testID }: { text: string; testID?: string }) {
  return (
    <Text className="text-[13px] leading-[18px] text-text-2" {...(testID ? { testID } : {})}>
      {text}
    </Text>
  );
}

/** One pick of a short list, as a pill: when to ask, how far up. */
function Pill({
  on,
  label,
  onPress,
  testID,
}: {
  on: boolean;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      role="radio"
      aria-checked={on}
      onPress={onPress}
      className={cn(
        'h-10 justify-center rounded-control border px-3',
        on ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
      )}
      testID={testID}
    >
      <Text className={cn('text-[14px] font-medium', on && 'text-accent-text')}>{label}</Text>
    </Pressable>
  );
}

function SwitchRow({
  title,
  hint,
  value,
  onChange,
  disabled,
  testID,
}: {
  title: string;
  hint: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  testID: string;
}) {
  return (
    <View className="flex-row items-start gap-3 rounded-menu border border-border bg-card px-4 py-3">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[15px] font-semibold">{title}</Text>
        <Text className="text-[12.5px] leading-[17px] text-text-2">{hint}</Text>
      </View>
      <Switch
        label={title}
        checked={value}
        onCheckedChange={onChange}
        disabled={!!disabled}
        testID={testID}
      />
    </View>
  );
}

/** What visitors see: the top of the chat with the logo or initials, the greeting, and the button. */
function LookPreview({
  answers,
  businessName,
  logo,
}: {
  answers: ChatSetupAnswers;
  businessName: string;
  logo: Logo;
}) {
  const accent = /^#[0-9a-fA-F]{6}$/.test(answers.accentColor) ? answers.accentColor : '#2d69d8';
  const text = readableTextOn(accent);
  const shown = answers.showLogo ? logo : null;
  const box = shown ? logoBox(shown, 26) : null;
  const initials =
    businessName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || 'HF';
  return (
    <View
      className={cn(
        'gap-3 rounded-xl bg-card-2 p-4',
        answers.position === 'left' ? 'items-start' : 'items-end',
      )}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="chat-setup-preview"
    >
      <View className="w-[240px] overflow-hidden rounded-[14px] border border-border bg-card">
        <View
          className="flex-row items-center gap-2 px-2.5 py-2"
          style={{ backgroundColor: accent }}
        >
          <View className="h-[26px] min-w-[26px] items-center justify-center rounded-[8px] bg-white px-[3px]">
            {shown && box ? (
              <Image source={{ uri: shown.url }} style={{ width: box.width, height: box.height }} />
            ) : (
              <Text className="text-[10px] font-bold text-[#191d25]">{initials}</Text>
            )}
          </View>
          <Text
            className="min-w-0 flex-1 text-[13px] font-semibold"
            style={{ color: text }}
            numberOfLines={1}
          >
            {businessName}
          </Text>
        </View>
        {answers.greeting.trim() ? (
          <Text className="px-3 py-2.5 text-[13px] leading-[18px]">{answers.greeting}</Text>
        ) : null}
      </View>
      <View
        className="h-[50px] flex-row items-center gap-2 rounded-full px-[18px]"
        style={{ backgroundColor: accent }}
      >
        <MessageCircle size={20} color={text} strokeWidth={1.75} />
        {answers.mobileButton === 'label' && answers.phone !== 'hidden' ? (
          <Text
            className="text-[15px] font-semibold"
            style={{ color: text }}
            testID="chat-setup-preview-button"
          >
            {answers.launcherLabel.trim() || W.look.labelDefault}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Put it on your site, on the phone: the chat is on, and pasting its code is a computer's job (W4 b), so it opens the
 * web's Put it on your site, or emails a link. Opened again for a chat that's made but not on the site yet, with Go
 * through the questions again to change it.
 */
export function ChatPhoneInstall({
  workspaceId,
  fresh,
  chips,
  onAgain,
  onClose,
}: {
  workspaceId: string;
  /** Just turned on. */
  fresh: boolean;
  /** The answers as chips (chatDoneChips). */
  chips: readonly string[];
  /** Go through the questions again; null right after Turn on website chat. */
  onAgain: (() => void) | null;
  onClose: () => void;
}) {
  return (
    <GuidedPage
      screen="install"
      testID="chat-setup"
      kicker={W.pageTitle}
      progress={null}
      title={W.install.titleAny}
      hint={W.install.onPhone}
      saved="idle"
      onLeave={onClose}
      leaveLabel={G.close}
      footer={
        <Button onPress={onClose} testID="chat-setup-install-done">
          {W.install.done}
        </Button>
      }
    >
      {fresh ? (
        <View
          className="flex-row items-center gap-2.5 rounded-menu bg-success-soft px-3.5 py-3"
          role="status"
          testID="chat-setup-on"
        >
          <Icon as={Check} className="size-4 text-success-text" strokeWidth={2.5} />
          <Text className="text-[14px] font-semibold text-success-text">{W.install.on}</Text>
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-1.5" testID="chat-setup-done-chips">
        {chips.map((c) => (
          <Badge key={c} variant="ok">
            {c}
          </Badge>
        ))}
      </View>
      <Button
        onPress={() =>
          void openWeb(`/onboarding/${workspaceId}/chat?step=install${fresh ? '&new=1' : ''}`)
        }
        testID="chat-setup-open-web"
      >
        {W.install.openOnWeb}
      </Button>
      <EmailMeALink workspaceId={workspaceId} step="email_chat" testID="chat-setup-link" />
      {onAgain ? (
        <Button variant="ghost" onPress={onAgain} testID="chat-setup-again">
          {W.summary.again}
        </Button>
      ) : null}
    </GuidedPage>
  );
}
