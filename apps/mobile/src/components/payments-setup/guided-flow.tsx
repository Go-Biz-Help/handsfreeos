import {
  GUIDED_SETUP_WORDS as G,
  guidedSetupSavedWhen,
  numberPreview,
  PAYMENT_PROVIDER_NAMES,
  paymentsDoneChips,
  paymentsReminderChips,
  paymentsRemindersOf,
  paymentsRemindersSummary,
  paymentsSettingsAtCounters,
  paymentsSetupAccountOf,
  paymentsSetupAnswersOf,
  paymentsSetupFirstProblem,
  paymentsSetupLines,
  paymentsSetupProblems,
  paymentsSetupProvider,
  paymentsSetupQuestions,
  paymentsSetupScreen,
  paymentsSetupSettings,
  paymentsSetupStart,
  paymentsSetupUsualFor,
  PAYMENTS_SETUP_WORDS as W,
  type ConnectableProvider,
  type MoneySettings,
  type PaymentsSetupAccount,
  type PaymentsSetupAnswers,
  type PaymentsSetupContext,
  type PaymentsSetupScreen,
  type PaymentTerms,
} from '@hfos/core';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
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
import { Check, CircleAlert, Clock } from '@/components/icons';
import { EmailMeALink } from '@/components/onboarding-setup/screens';
import { businessHref } from '@/components/shell/business-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import {
  NotInThisBuild,
  type PaymentsGuidedDraft,
  type PaymentsSetupCalls,
} from '@/payments-setup/calls';

const TERMS: readonly PaymentTerms[] = ['due_on_receipt', 'net_7', 'net_14', 'net_30'];
const DEPOSITS = ['none', 'percent', 'amount'] as const;

/**
 * The guided payments setup on the phone (the owner, 23 Nov 2026, P4 a: in the same build as the web), as the web's
 * components/payments-setup/payments-setup-flow.tsx at phone size: the same seven questions one a screen, Check it
 * over, Save (money.save_settings), and for a business with no account yet the Stripe or Square sign-in last, in the
 * phone's browser over the app, then Done. The answers are saved as they are given, so the web and the phone pick up
 * each other's. Which questions a path asks, what is wrong with an answer and what Save writes are core's.
 */
export function PaymentsGuidedFlow({
  workspaceId,
  businessName,
  firstName,
  industry,
  ctx,
  draft,
  calls,
}: {
  workspaceId: string;
  businessName: string;
  firstName: string | null;
  industry: string | null;
  ctx: PaymentsSetupContext;
  draft: PaymentsGuidedDraft;
  calls: PaymentsSetupCalls;
}) {
  const { online } = useNetwork();
  const [first] = React.useState(() => {
    const start = paymentsSetupStart(ctx, industry);
    const kept =
      draft.answers && draft.answers['mode'] === ctx.mode
        ? paymentsSetupAnswersOf(draft.answers, start)
        : null;
    return { answers: kept ?? start, kept: !!kept };
  });
  const [answers, setAnswers] = React.useState<PaymentsSetupAnswers>(first.answers);
  const questions = paymentsSetupQuestions(answers, ctx);
  const [screen, setScreen] = React.useState<PaymentsSetupScreen>(() => {
    const asked = paymentsSetupQuestions(first.answers, ctx);
    const saved = paymentsSetupScreen.safeParse(first.kept ? draft.answers?.['at'] : null);
    const to = saved.success ? saved.data : null;
    return to === 'review' || (to && asked.includes(to)) ? to : asked[0]!;
  });
  /** After Save: the settings as saved, and the provider they went to sign in to. */
  const [done, setDone] = React.useState<{
    settings: MoneySettings;
    tried: ConnectableProvider | null;
  } | null>(null);
  const [problems, setProblems] = React.useState<
    Partial<Record<keyof PaymentsSetupAnswers, string>>
  >({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const [returnTo, setReturnTo] = React.useState<PaymentsSetupScreen | null>(null);
  const [welcome, setWelcome] = React.useState(
    () => first.kept && !!draft.savedAt && Date.now() - Date.parse(draft.savedAt) > 10 * 60_000,
  );
  const scroller = React.useRef<ScrollView>(null);

  const saving = useGuidedDraft(
    workspaceId,
    'payments',
    done ? null : { ...answers, at: screen, mode: ctx.mode },
    { hadDraft: first.kept },
  );

  const set = (patch: Partial<PaymentsSetupAnswers>) => {
    setAnswers((now) => ({ ...now, ...patch }));
    setProblems({});
    setError(null);
  };
  const go = (to: PaymentsSetupScreen) => {
    setScreen(to);
    setProblems({});
    setError(null);
    setWelcome(false);
    scroller.current?.scrollTo({ y: 0, animated: false });
  };
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(workspaceId));
  };

  const i = screen === 'review' ? questions.length : Math.max(0, questions.indexOf(screen));
  const provider = paymentsSetupProvider(answers, ctx);
  const providerName = provider ? PAYMENT_PROVIDER_NAMES[provider] : null;

  function next() {
    if (screen === 'review') return;
    const found = paymentsSetupProblems(screen, answers, ctx);
    if (found.length) {
      setProblems(Object.fromEntries(found.map((p) => [p.path, p.message])));
      return;
    }
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
    const wrong = paymentsSetupFirstProblem(answers, ctx);
    if (wrong) {
      go(wrong);
      setProblems(
        Object.fromEntries(
          paymentsSetupProblems(wrong, answers, ctx).map((p) => [p.path, p.message]),
        ),
      );
      return;
    }
    if (!online) return setError(P.needsSignal);
    setBusy(true);
    setError(null);
    let saved: MoneySettings;
    try {
      await saving.flush();
      // The settings as they are this moment: anything changed on the web since this opened is kept.
      const now = await calls.money();
      saved = (await calls.save(paymentsSetupSettings(paymentsSettingsAtCounters(now), answers)))
        .settings;
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    await saving.clear();
    if (ctx.mode === 'again') {
      toast.show(W.review.saved);
      close();
      return;
    }
    setDone({ settings: saved, tried: provider });
    setBusy(false);
  }

  async function leave() {
    setLeaving(true);
    await saving.flush();
    close();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    const start = paymentsSetupStart(ctx, industry);
    setAnswers(start);
    setReturnTo(null);
    go(paymentsSetupQuestions(start, ctx)[0]!);
  }

  if (done)
    return (
      <PaymentsGuidedDone
        workspaceId={workspaceId}
        settings={done.settings}
        tried={done.tried}
        account={ctx.account}
        calls={calls}
        onClose={close}
      />
    );

  const lines = paymentsSetupLines(answers, ctx);
  const usual = paymentsSetupUsualFor(ctx, industry);
  const when = draft.savedAt ? guidedSetupSavedWhen(draft.savedAt, new Date()) : null;
  const banner =
    welcome && when ? (
      <WelcomeBack
        line={`${G.welcomeBack(firstName, when)}${i > 0 && screen !== 'review' ? ` ${G.stoppedAt(i + 1)}` : ''}`}
        onStartOver={() => void startOver()}
      />
    ) : usual && i === 0 && screen !== 'review' ? (
      <Text className="text-[13px] leading-[18px] text-text-3" testID="payments-setup-usual">
        {W.usualFor(usual)}
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
      testID="payments-setup"
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
        onBack={i > 0 ? back : undefined}
        onNext={next}
        busy={busy}
        error={error ?? (screen === 'where' ? problems.where : null)}
        testID="payments-setup"
        nextLabel={
          returnTo === 'review' || (!returnTo && i === questions.length - 1)
            ? G.checkItOver
            : G.next
        }
      />,
    );

  if (screen === 'review') {
    const happens =
      ctx.mode === 'again'
        ? [W.review.nextSave, W.review.accountHere(providerName ?? '')]
        : providerName
          ? [W.review.nextSave, W.review.nextSignIn(providerName), W.review.nextBack(providerName)]
          : [W.review.nextSave, W.review.nextLater];
    return page(
      W.review.title,
      `${W.review.hint} ${G.answersKept}`,
      <>
        <View className="overflow-hidden rounded-menu border border-border bg-card">
          {lines.map((l, at) => (
            <View
              key={l.key}
              className={cn('gap-1 px-4 py-3.5', at > 0 && 'border-t border-border')}
              testID={`payments-review-${l.key}`}
            >
              <View className="flex-row items-center justify-between gap-3">
                <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
                  {l.label}
                </Text>
                {questions.includes(l.key) ? (
                  <Pressable
                    role="button"
                    accessibilityLabel={`${G.change}: ${l.label}`}
                    onPress={() => {
                      setReturnTo('review');
                      go(l.key);
                    }}
                    hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                    testID={`payments-review-change-${l.key}`}
                  >
                    <Text className="text-[14px] font-medium text-accent-text">{G.change}</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text className="text-[15px] font-semibold">{l.value ?? '—'}</Text>
            </View>
          ))}
        </View>
        <GuidedNote>
          <Text className="text-[13.5px] font-medium">{W.review.already}</Text>
          {provider ? <Line text={W.review.alreadyAccess} /> : null}
          {answers.estimates ? (
            <>
              <Line text={W.review.alreadyEstimateNote(ctx.settings.notes.estimate)} />
              <Line
                text={W.review.alreadyEstimateNumbers(
                  numberPreview(ctx.settings.numbering.estimate),
                )}
              />
            </>
          ) : null}
          <Text className="text-[13px] leading-[18px] text-text-3">{W.review.alreadyLater}</Text>
        </GuidedNote>
        <View className="gap-3" testID="payments-review-next">
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
        nextLabel={
          ctx.mode === 'new' && providerName ? W.review.connect(providerName) : W.review.save
        }
        testID="payments-setup"
      />,
    );
  }

  switch (screen) {
    case 'where':
      return question(
        W.where.title,
        W.where.hint,
        <>
          <Choices label={W.where.title}>
            <ChoiceTile
              selected={answers.where === 'stripe'}
              onSelect={() => set({ where: 'stripe' })}
              title={W.where.stripe.title}
              best={W.where.stripe.badge}
              hint={W.where.stripe.hint}
              testID="payments-setup-where-stripe"
            />
            <ChoiceTile
              selected={answers.where === 'square'}
              onSelect={() => set({ where: 'square' })}
              title={W.where.square.title}
              hint={W.where.square.hint}
              testID="payments-setup-where-square"
            />
            <ChoiceTile
              selected={answers.where === 'paypal'}
              onSelect={() => set({ where: 'paypal' })}
              title={
                ctx.payPalOpen
                  ? W.where.paypal.title
                  : `${W.where.paypal.title}, ${W.where.paypal.soon.toLowerCase()}`
              }
              hint={ctx.payPalOpen ? W.where.paypal.hint : W.where.paypal.soonHint}
              disabled={!ctx.payPalOpen}
              testID="payments-setup-where-paypal"
            />
            <ChoiceTile
              selected={answers.where === 'later'}
              onSelect={() => set({ where: 'later' })}
              title={W.where.later.title}
              hint={W.where.later.hint}
              testID="payments-setup-where-later"
            />
          </Choices>
          <GuidedNote>
            <Text className="text-[13px] leading-[18px] text-text-2">
              {providerName ? W.where.note(providerName) : W.where.noteLater}
            </Text>
          </GuidedNote>
        </>,
      );

    case 'ways':
      return question(
        W.ways.title,
        W.ways.hint,
        <>
          <View className="overflow-hidden rounded-menu border border-border bg-card">
            {provider === 'paypal' ? (
              <>
                <WayRow
                  first
                  title={W.ways.payPal.title}
                  hint={W.ways.payPal.hint}
                  on={W.ways.card.on}
                />
                <WayRow
                  title={W.ways.venmo.title}
                  hint={W.ways.venmo.hint}
                  value={answers.venmo}
                  onChange={(venmo) => set({ venmo })}
                  testID="payments-setup-venmo"
                />
                <WayRow
                  title={W.ways.payLater.title}
                  hint={W.ways.payLater.hint}
                  value={answers.payLater}
                  onChange={(payLater) => set({ payLater })}
                  testID="payments-setup-pay-later"
                />
              </>
            ) : (
              <>
                <WayRow
                  first
                  title={W.ways.bankTransfer.title}
                  badge={W.ways.bankTransfer.badge}
                  hint={W.ways.bankTransfer.hint}
                  value={answers.bankTransfer}
                  onChange={(bankTransfer) => set({ bankTransfer })}
                  testID="payments-setup-bank-transfer"
                />
                <WayRow title={W.ways.card.title} hint={W.ways.card.hint} on={W.ways.card.on} />
              </>
            )}
            <WayRow title={W.ways.cash.title} hint={W.ways.cash.hint} on={W.ways.cash.on} />
          </View>
          <GuidedNote>
            <Text className="text-[13px] leading-[18px] text-text-2">{W.ways.note}</Text>
          </GuidedNote>
        </>,
      );

    case 'tax':
      return question(
        W.tax.title,
        W.tax.hint,
        <>
          <Choices label={W.lines.tax}>
            <ChoiceTile
              selected={answers.tax === 'no'}
              onSelect={() => set({ tax: 'no' })}
              title={W.tax.no.title}
              hint={W.tax.no.hint}
              testID="payments-setup-tax-no"
            />
            <ChoiceTile
              selected={answers.tax === 'yes'}
              onSelect={() => set({ tax: 'yes' })}
              title={W.tax.yes.title}
              hint={W.tax.yes.hint}
              testID="payments-setup-tax-yes"
            >
              <View className="gap-1.5">
                <Label nativeID="pay-tax-rate">{W.tax.rate}</Label>
                <View className="flex-row items-center gap-2">
                  <Input
                    aria-labelledby="pay-tax-rate"
                    className="w-24"
                    keyboardType="decimal-pad"
                    value={answers.taxRate}
                    onChangeText={(taxRate) => set({ taxRate: taxRate.slice(0, 10) })}
                    invalid={!!problems.taxRate}
                    placeholder="8.25"
                    testID="payments-setup-tax-rate"
                  />
                  <Text className="text-text-2">%</Text>
                </View>
                <FieldError>{problems.taxRate}</FieldError>
              </View>
              <View className="gap-1.5">
                <Label nativeID="pay-tax-name">{W.tax.name}</Label>
                <Input
                  aria-labelledby="pay-tax-name"
                  value={answers.taxName}
                  maxLength={40}
                  onChangeText={(taxName) => set({ taxName })}
                  invalid={!!problems.taxName}
                  testID="payments-setup-tax-name"
                />
                <FieldError>{problems.taxName}</FieldError>
              </View>
              <SwitchRow
                title={W.tax.newTaxable}
                hint={W.tax.newTaxableHint}
                value={answers.newTaxable}
                onChange={(newTaxable) => set({ newTaxable })}
                testID="payments-setup-new-taxable"
              />
            </ChoiceTile>
          </Choices>
          <FieldError>{problems.tax}</FieldError>
          <GuidedNote>
            <Text className="text-[13px] leading-[18px] text-text-2">{W.tax.note}</Text>
          </GuidedNote>
        </>,
      );

    case 'due':
      return question(
        W.due.title,
        W.due.hint,
        <>
          <Choices label={W.lines.due}>
            {TERMS.map((t) => (
              <ChoiceTile
                key={t}
                selected={answers.terms === t}
                onSelect={() => set({ terms: t })}
                title={W.due.options[t].title}
                hint={W.due.options[t].hint}
                testID={`payments-setup-due-${t}`}
              />
            ))}
          </Choices>
          <GuidedNote>
            <Text className="text-[13px] leading-[18px] text-text-2">{W.due.note}</Text>
          </GuidedNote>
        </>,
      );

    case 'estimates':
      return question(
        W.estimates.title,
        W.estimates.hint,
        <>
          <Choices label={W.lines.estimates}>
            <ChoiceTile
              selected={answers.estimates}
              onSelect={() => set({ estimates: true })}
              title={W.estimates.yes.title}
              hint={W.estimates.yes.hint}
              testID="payments-setup-estimates-yes"
            >
              <View className="flex-row flex-wrap items-center gap-2">
                <Text className="text-[14px]">{W.estimates.goodFor}</Text>
                <Input
                  accessibilityLabel={W.estimates.goodFor}
                  className="w-20"
                  keyboardType="number-pad"
                  value={answers.estimateDays}
                  onChangeText={(estimateDays) => set({ estimateDays: estimateDays.slice(0, 4) })}
                  invalid={!!problems.estimateDays}
                  testID="payments-setup-estimate-days"
                />
                <Text className="text-[14px]">{W.estimates.days}</Text>
              </View>
              <FieldError>{problems.estimateDays}</FieldError>
              <Text className="text-[13.5px] font-medium">{W.estimates.upFront}</Text>
              <View role="radiogroup" className="flex-row flex-wrap gap-2">
                {DEPOSITS.map((d) => (
                  <Pressable
                    key={d}
                    role="radio"
                    aria-checked={answers.deposit === d}
                    onPress={() => set({ deposit: d })}
                    className={cn(
                      'h-10 justify-center rounded-control border bg-card px-3',
                      answers.deposit === d ? 'border-accent' : 'border-border-strong',
                    )}
                    testID={`payments-setup-deposit-${d}`}
                  >
                    <Text
                      className={cn(
                        'text-[14px] font-medium',
                        answers.deposit === d && 'text-accent-text',
                      )}
                    >
                      {W.estimates.deposit[d]}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {answers.deposit === 'percent' ? (
                <View className="gap-1.5">
                  <View className="flex-row items-center gap-2">
                    <Input
                      accessibilityLabel={W.estimates.deposit.percent}
                      className="w-20"
                      keyboardType="decimal-pad"
                      value={answers.depositPercent}
                      onChangeText={(depositPercent) =>
                        set({ depositPercent: depositPercent.slice(0, 6) })
                      }
                      invalid={!!problems.depositPercent}
                      testID="payments-setup-deposit-percent-value"
                    />
                    <Text className="min-w-0 flex-1 text-[13px] text-text-2">
                      {W.estimates.percentAfter}
                    </Text>
                  </View>
                  <FieldError>{problems.depositPercent}</FieldError>
                </View>
              ) : answers.deposit === 'amount' ? (
                <View className="gap-1.5">
                  <View className="flex-row items-center gap-2">
                    <Input
                      accessibilityLabel={W.estimates.deposit.amount}
                      className="w-28"
                      keyboardType="decimal-pad"
                      placeholder="$500"
                      value={answers.depositAmount}
                      onChangeText={(depositAmount) =>
                        set({ depositAmount: depositAmount.slice(0, 14) })
                      }
                      invalid={!!problems.depositAmount}
                      testID="payments-setup-deposit-amount-value"
                    />
                    <Text className="min-w-0 flex-1 text-[13px] text-text-2">
                      {W.estimates.amountAfter}
                    </Text>
                  </View>
                  <FieldError>{problems.depositAmount}</FieldError>
                </View>
              ) : null}
            </ChoiceTile>
            <ChoiceTile
              selected={!answers.estimates}
              onSelect={() => set({ estimates: false })}
              title={W.estimates.no.title}
              hint={W.estimates.no.hint}
              testID="payments-setup-estimates-no"
            />
          </Choices>
          <GuidedNote>
            <Text className="text-[13px] leading-[18px] text-text-2">{W.estimates.note}</Text>
          </GuidedNote>
        </>,
      );

    case 'reminders': {
      const own = paymentsRemindersOf(ctx.settings) === 'own';
      const usualChips = paymentsReminderChips('usual', answers.terms, ctx.settings.reminders);
      return question(
        W.reminders.title,
        W.reminders.hint,
        <>
          <Choices label={W.lines.reminders}>
            <ChoiceTile
              selected={answers.reminders === 'usual'}
              onSelect={() => set({ reminders: 'usual' })}
              title={W.reminders.usual.title}
              best={W.reminders.usual.most(usualChips.length)}
              hint={usualChips.join(' · ')}
              testID="payments-setup-reminders-usual"
            >
              <Text className="text-[13px] leading-[18px] text-text-2">
                {W.reminders.usual.hint}
              </Text>
            </ChoiceTile>
            <ChoiceTile
              selected={answers.reminders === 'few'}
              onSelect={() => set({ reminders: 'few' })}
              title={W.reminders.few.title}
              hint={W.reminders.few.hint}
              testID="payments-setup-reminders-few"
            />
            {own ? (
              <ChoiceTile
                selected={answers.reminders === 'own'}
                onSelect={() => set({ reminders: 'own' })}
                title={W.reminders.own.title}
                hint={paymentsRemindersSummary(ctx.settings.reminders)}
                testID="payments-setup-reminders-own"
              />
            ) : null}
            <ChoiceTile
              selected={answers.reminders === 'none'}
              onSelect={() => set({ reminders: 'none' })}
              title={W.reminders.none.title}
              hint={W.reminders.none.hint}
              testID="payments-setup-reminders-none"
            />
          </Choices>
          {answers.estimates ? (
            <View className="rounded-menu border border-border bg-card px-4 py-3">
              <SwitchRow
                title={W.reminders.nudge}
                hint={W.reminders.nudgeHint(ctx.settings.reminders.estimateAfterDays ?? 3)}
                value={answers.estimateNudge}
                onChange={(estimateNudge) => set({ estimateNudge })}
                testID="payments-setup-estimate-nudge"
              />
            </View>
          ) : null}
          <GuidedNote>
            <Text className="text-[13px] leading-[18px] text-text-2">{W.reminders.note}</Text>
          </GuidedNote>
        </>,
      );
    }

    case 'documents': {
      const nextNumber = /^\d+$/.test(answers.invoiceNext.trim())
        ? Number(answers.invoiceNext)
        : null;
      const fromSetup =
        !!ctx.setupAddress && !ctx.settings.businessAddress && answers.address === ctx.setupAddress;
      return question(
        W.documents.title,
        W.documents.hint,
        <>
          <View className="gap-1.5">
            <Label nativeID="pay-address">{W.documents.address}</Label>
            <Input
              aria-labelledby="pay-address"
              multiline
              numberOfLines={4}
              className="min-h-[96px] py-2.5"
              style={{ textAlignVertical: 'top' }}
              value={answers.address}
              onChangeText={(address) => set({ address: address.slice(0, 300) })}
              invalid={!!problems.address}
              testID="payments-setup-address"
            />
            <FieldError>{problems.address}</FieldError>
            <Text className="text-[12.5px] leading-[17px] text-text-3">
              {fromSetup ? W.documents.addressFromSetup : W.documents.addressHint}
            </Text>
          </View>
          <View className="gap-1.5">
            <Text className="text-[13px] font-medium">{W.documents.numbers}</Text>
            <View className="flex-row gap-3">
              <View className="flex-1 gap-1">
                <Text className="text-[12.5px] text-text-2">{W.documents.startWith}</Text>
                <Input
                  accessibilityLabel={W.documents.startWith}
                  autoCapitalize="characters"
                  value={answers.invoicePrefix}
                  onChangeText={(invoicePrefix) =>
                    set({ invoicePrefix: invoicePrefix.slice(0, 20) })
                  }
                  invalid={!!problems.invoicePrefix}
                  testID="payments-setup-prefix"
                />
              </View>
              <View className="flex-1 gap-1">
                <Text className="text-[12.5px] text-text-2">{W.documents.nextNumber}</Text>
                <Input
                  accessibilityLabel={W.documents.nextNumber}
                  keyboardType="number-pad"
                  value={answers.invoiceNext}
                  onChangeText={(invoiceNext) => set({ invoiceNext: invoiceNext.slice(0, 12) })}
                  invalid={!!problems.invoiceNext}
                  testID="payments-setup-next-number"
                />
              </View>
            </View>
            <FieldError>{problems.invoicePrefix ?? problems.invoiceNext}</FieldError>
            {nextNumber && !problems.invoicePrefix ? (
              <Text className="text-[13px] text-text-2" testID="payments-setup-preview">
                {W.documents.preview}{' '}
                <Text className="font-mono text-[13px] font-medium">
                  {numberPreview({
                    ...ctx.settings.numbering.invoice,
                    prefix: answers.invoicePrefix.trim(),
                    next: nextNumber,
                  })}
                </Text>
              </Text>
            ) : null}
            <Text className="text-[12.5px] leading-[17px] text-text-3">
              {W.documents.numbersHint(
                answers.estimates ? numberPreview(ctx.settings.numbering.estimate) : null,
              )}
            </Text>
          </View>
          <View className="gap-1.5">
            <Label nativeID="pay-note">{W.documents.note}</Label>
            <Input
              aria-labelledby="pay-note"
              multiline
              numberOfLines={3}
              className="min-h-[80px] py-2.5"
              style={{ textAlignVertical: 'top' }}
              value={answers.note}
              onChangeText={(note) => set({ note: note.slice(0, 2_000) })}
              invalid={!!problems.note}
              testID="payments-setup-note"
            />
            <FieldError>{problems.note}</FieldError>
            <Text className="text-[12.5px] leading-[17px] text-text-3">{W.documents.noteHint}</Text>
          </View>
        </>,
      );
    }
  }
}

function Line({ text }: { text: string }) {
  return (
    <View className="flex-row items-start gap-2">
      <Icon as={Check} className="mt-0.5 size-3.5 text-success" strokeWidth={2.5} />
      <Text className="min-w-0 flex-1 text-[13px] leading-[18px] text-text-2">{text}</Text>
    </View>
  );
}

/** One way to pay: a switch, or what is always so ("Always on", "By hand"). */
function WayRow({
  first = false,
  title,
  badge,
  hint,
  on,
  value,
  onChange,
  testID,
}: {
  /** The top row, with no line above it. */
  first?: boolean;
  title: string;
  badge?: string;
  hint: string;
  on?: string;
  value?: boolean;
  onChange?: (next: boolean) => void;
  testID?: string;
}) {
  return (
    <View
      className={cn('flex-row items-start gap-3 px-4 py-3.5', !first && 'border-t border-border')}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-[15px] font-semibold">{title}</Text>
          {badge ? <Badge variant="ok">{badge}</Badge> : null}
        </View>
        <Text className="text-[13px] leading-[18px] text-text-2">{hint}</Text>
      </View>
      {onChange ? (
        <Switch
          label={title}
          checked={!!value}
          onCheckedChange={onChange}
          {...(testID ? { testID } : {})}
        />
      ) : (
        <Badge variant="gray">{on ?? ''}</Badge>
      )}
    </View>
  );
}

function SwitchRow({
  title,
  hint,
  value,
  onChange,
  testID,
}: {
  title: string;
  hint: string;
  value: boolean;
  onChange: (next: boolean) => void;
  testID: string;
}) {
  return (
    <View className="flex-row items-start gap-3">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[14px] font-medium">{title}</Text>
        <Text className="text-[12.5px] leading-[17px] text-text-2">{hint}</Text>
      </View>
      <Switch label={title} checked={value} onCheckedChange={onChange} testID={testID} />
    </View>
  );
}

/**
 * Done: the answers are saved. For a business that picked Stripe or Square, its sign-in opens in the phone's browser
 * over the app the moment this shows (P1: last), and what comes back says whether the account is connected, still
 * being checked, or not connected yet, with Connect to try again.
 */
function PaymentsGuidedDone({
  workspaceId,
  settings,
  tried,
  account: before,
  calls,
  onClose,
}: {
  workspaceId: string;
  settings: MoneySettings;
  tried: ConnectableProvider | null;
  account: PaymentsSetupAccount | null;
  calls: PaymentsSetupCalls;
  onClose: () => void;
}) {
  const { online } = useNetwork();
  const [account, setAccount] = React.useState<PaymentsSetupAccount | null>(before);
  const [busy, setBusy] = React.useState(false);
  const [noBuild, setNoBuild] = React.useState(false);
  const away = React.useRef(false);

  const refresh = React.useCallback(async () => {
    try {
      setAccount(paymentsSetupAccountOf(await calls.connections()));
    } catch {
      // No signal for a moment: Connect is still there.
    }
  }, [calls]);
  // Back from the browser some other way than closing it (the app switcher): look again.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && away.current) {
        away.current = false;
        void refresh();
      }
    });
    return () => sub.remove();
  }, [refresh]);

  const connect = React.useCallback(async () => {
    if (!tried) return;
    if (!online) return toast.error(P.needsSignal);
    setBusy(true);
    try {
      const url = await calls.signIn(tried);
      away.current = true;
      // The provider's own page, in the phone's browser over the app. Closing it comes straight back here.
      await WebBrowser.openBrowserAsync(url);
      await refresh();
    } catch (e) {
      if (e instanceof NotInThisBuild) setNoBuild(true);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [tried, online, calls, refresh]);
  // P1: the sign-in comes last, straight after Save.
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current || !tried) return;
    started.current = true;
    void connect();
  }, [tried, connect]);

  const name = account
    ? PAYMENT_PROVIDER_NAMES[account.provider]
    : tried
      ? PAYMENT_PROVIDER_NAMES[tried]
      : null;
  const chips = paymentsDoneChips(settings, account?.provider ?? null);
  return (
    <GuidedPage
      screen="done"
      testID="payments-setup"
      kicker={W.pageTitle}
      progress={null}
      title={W.done.title}
      hint={W.done.hint}
      saved="idle"
      onLeave={onClose}
      leaveLabel={G.close}
      footer={
        <Button onPress={onClose} testID="payments-setup-done-close">
          {W.done.close}
        </Button>
      }
    >
      <View className="flex-row flex-wrap gap-1.5" testID="payments-setup-done-chips">
        {chips.map((c) => (
          <Badge key={c} variant="ok">
            {c}
          </Badge>
        ))}
      </View>
      {account?.state === 'checking' && name ? (
        <Notice icon={Clock} title={W.done.checking(name)} text={W.done.checkingHint(name)} />
      ) : account?.state === 'ready' && name ? (
        <Notice icon={Check} title={W.done.ready(name)} text={W.done.readyHint} tone="ok" />
      ) : tried && name ? (
        <View className="gap-3" testID="payments-setup-not-connected">
          <Notice
            icon={CircleAlert}
            title={W.done.notConnected(name)}
            text={noBuild ? P.payOnComputer : W.done.notConnectedHint}
          />
          {noBuild ? (
            <EmailMeALink workspaceId={workspaceId} step="payments" testID="payments-setup-link" />
          ) : (
            <Button variant="secondary" loading={busy} onPress={() => void connect()}>
              {W.done.connect(name)}
            </Button>
          )}
        </View>
      ) : (
        <GuidedNote>
          <Text className="text-[13.5px] font-medium">{W.done.later}</Text>
          <Text className="text-[13px] leading-[18px] text-text-2">{W.done.laterHint}</Text>
        </GuidedNote>
      )}
    </GuidedPage>
  );
}

function Notice({
  icon,
  title,
  text,
  tone = 'warning',
}: {
  icon: typeof Check;
  title: string;
  text: string;
  tone?: 'warning' | 'ok';
}) {
  const color = tone === 'ok' ? 'text-success-text' : 'text-warning-text';
  return (
    <View
      className={cn(
        'flex-row items-start gap-2.5 rounded-menu px-3.5 py-3',
        tone === 'ok' ? 'bg-success-soft' : 'bg-warning-soft',
      )}
      role="status"
    >
      <Icon as={icon} className={cn('mt-0.5 size-4', color)} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className={cn('text-[14px] font-semibold', color)}>{title}</Text>
        <Text className={cn('text-[13.5px] leading-[19px]', color)}>{text}</Text>
      </View>
    </View>
  );
}
