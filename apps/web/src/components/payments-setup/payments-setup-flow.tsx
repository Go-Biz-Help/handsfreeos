'use client';
/**
 * The guided payments setup on the web (the owner, 23 Nov 2026, "a" on picks P1 to P4): Getting started's Connect
 * payments and Settings → Payments open it. Seven questions on a page of their own (where payments go, ways to pay,
 * sales tax, when invoices are due, estimates and deposits, reminders, what goes on every invoice), then Check it
 * over, where Save writes the money settings (money.save_settings) and, for a business with no account yet, sends
 * them to sign in to Stripe or Square last (P1). The answers start from what the kind of business usually picks (P2).
 * Every answer is saved as it's given (guided_setup.save_draft), so leaving and coming back opens on the same
 * question with the same answers.
 *
 * Which questions a path asks, what is wrong with an answer, the lines beside the questions and the settings Save
 * writes are core's (guided-setup/payments.ts), shared with the phone.
 */
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
  paymentsSetupAnswersFromSettings,
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
  type PaymentsSetupQuestion,
  type PaymentsSetupScreen,
  type PaymentTerms,
} from '@hfos/core';
import {
  CalendarDays,
  Check,
  CircleAlert,
  Clock,
  FileText,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import {
  ChoiceTile,
  Choices,
  GuidedCard,
  GuidedFooter,
  GuidedNote,
  GuidedPage,
  useGuidedDraft,
  WelcomeBack,
  type GuidedStep,
} from '@/components/guided-setup/frame';
import {
  connectPaymentAccount,
  PAYMENT_RESULT,
} from '@/components/settings/payment-connection-card';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldError, Hint, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { keepSetupReturn } from '@/lib/setup-return';
import { cn } from '@/lib/utils';

const TERMS: readonly PaymentTerms[] = ['due_on_receipt', 'net_7', 'net_14', 'net_30'];
const DEPOSITS = ['none', 'percent', 'amount'] as const;

/** Where the setup was opened from, and so where Finish later and Done go back to. */
export type PaymentsSetupFrom = 'setup' | 'settings';

export const paymentsSetupHome = (workspaceId: string, from: PaymentsSetupFrom): string =>
  from === 'setup'
    ? `/onboarding/${workspaceId}/setup/payments`
    : `/app/w/${workspaceId}/settings/payments`;

/** The Done screen's address: after Save, and where the Stripe or Square sign-in comes back to. */
const doneHref = (
  workspaceId: string,
  from: PaymentsSetupFrom,
  provider: ConnectableProvider | null,
) =>
  `/onboarding/${workspaceId}/payments?done=1${from === 'setup' ? '&from=setup' : ''}${provider ? `&provider=${provider}` : ''}`;

export function PaymentsSetupFlow({
  workspaceId,
  businessName,
  email,
  firstName,
  industry,
  ctx,
  draft,
  at,
  from,
}: {
  workspaceId: string;
  businessName: string;
  /** Who's signed in, under the card. */
  email: string;
  firstName: string | null;
  /** The kind of business (workspace `industry`): the answers start from what it usually picks. */
  industry: string | null;
  ctx: PaymentsSetupContext;
  /** The answers as they were left (guided_setup.get_draft). */
  draft: { readonly answers: Record<string, unknown> | null; readonly savedAt: string | null };
  /** `?at=`: Settings → Payments' Change opens that question, and Next goes to Check it over. */
  at: PaymentsSetupScreen | null;
  from: PaymentsSetupFrom;
}) {
  const router = useRouter();
  const home = paymentsSetupHome(workspaceId, from);
  const [first] = useState(() => {
    // A Change from Settings edits what is saved, as Settings shows it: with no account, Not now (connecting is
    // Set up payments, beside it).
    const start = at
      ? paymentsSetupAnswersFromSettings(
          ctx.settings,
          ctx.setupAddress,
          ctx.mode === 'new' ? 'later' : 'stripe',
        )
      : paymentsSetupStart(ctx, industry);
    // A Change from Settings starts from what is saved; a draft from the other path (no account then, one now) is
    // for questions this one doesn't ask.
    const usable = !at && draft.answers && draft.answers['mode'] === ctx.mode;
    const kept = usable ? paymentsSetupAnswersOf(draft.answers, start) : null;
    return { answers: kept ?? start, kept: !!kept };
  });
  const [answers, setAnswers] = useState<PaymentsSetupAnswers>(first.answers);
  const questions = paymentsSetupQuestions(answers, ctx);
  const [screen, setScreen] = useState<PaymentsSetupScreen>(() => {
    const asked = paymentsSetupQuestions(first.answers, ctx);
    const saved = paymentsSetupScreen.safeParse(first.kept ? draft.answers?.['at'] : at);
    const to = saved.success ? saved.data : null;
    return to === 'review' || (to && asked.includes(to)) ? to : asked[0]!;
  });
  const [problems, setProblems] = useState<Partial<Record<keyof PaymentsSetupAnswers, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [done, setDone] = useState(false);
  /** Check it over's Change (and Settings'): Next goes straight back there, not through every question again. */
  const [returnTo, setReturnTo] = useState<PaymentsSetupScreen | null>(at ? 'review' : null);
  const [welcome, setWelcome] = useState(
    () => first.kept && !!draft.savedAt && Date.now() - Date.parse(draft.savedAt) > 10 * 60_000,
  );
  const [startingOver, setStartingOver] = useState(false);
  const top = useRef<HTMLDivElement>(null);

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
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const i = screen === 'review' ? questions.length : Math.max(0, questions.indexOf(screen));
  const provider = paymentsSetupProvider(answers, ctx);
  const providerName = provider ? PAYMENT_PROVIDER_NAMES[provider] : null;

  const show = (q: PaymentsSetupScreen) => {
    const found = paymentsSetupProblems(q, answers, ctx);
    setProblems(Object.fromEntries(found.map((p) => [p.path, p.message])));
    return found.length > 0;
  };

  function next() {
    if (screen === 'review') return;
    if (show(screen)) return;
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
    setBusy(true);
    setError(null);
    const connectTo = ctx.mode === 'new' ? provider : null;
    try {
      await saving.flush();
      // The settings as they are this moment: anything changed in another tab since this page opened is kept.
      const now = unwrap(
        await apiBrowser().POST('/v1/queries/money.settings', { body: { workspaceId } }),
      );
      unwrap(
        await apiBrowser().POST('/v1/commands/money.save_settings', {
          body: {
            workspaceId,
            settings: paymentsSetupSettings(paymentsSettingsAtCounters(now), answers),
          },
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    setDone(true);
    await saving.clear();
    if (ctx.mode === 'again') {
      toast.success(W.review.saved);
      router.push(home);
      router.refresh();
      return;
    }
    const to = doneHref(workspaceId, from, connectTo);
    if (!connectTo) return void router.push(to);
    // P1: the sign-in comes last, and comes back to Done with `?payments=` saying how it went.
    keepSetupReturn(workspaceId, 'payments', to);
    connectPaymentAccount(workspaceId, connectTo).catch(() => router.push(to));
  }

  async function leave() {
    setLeaving(true);
    await saving.flush();
    router.push(home);
    router.refresh();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    const start = paymentsSetupStart(ctx, industry);
    setAnswers(start);
    setStartingOver(false);
    setReturnTo(null);
    go(paymentsSetupQuestions(start, ctx)[0]!);
  }

  const page = (children: ReactNode) => (
    <GuidedPage
      business={{ name: businessName, home: `/app/w/${workspaceId}` }}
      email={email}
      settingUp={W.settingUp(businessName)}
      saved={saving.state}
      onLeave={() => void leave()}
      leaving={leaving}
    >
      <div ref={top} className="w-full scroll-mt-20">
        {children}
      </div>
    </GuidedPage>
  );

  const lines = paymentsSetupLines(answers, ctx);
  const steps: GuidedStep[] = lines
    .filter((l) => questions.includes(l.key))
    .map((l, n) => ({
      key: l.key,
      label: l.label,
      value: l.value,
      state: n < i ? 'done' : n === i ? 'now' : 'todo',
    }));
  const usual = paymentsSetupUsualFor(ctx, industry);
  const when = draft.savedAt ? guidedSetupSavedWhen(draft.savedAt, new Date()) : null;
  const banner =
    welcome && when ? (
      startingOver ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-menu bg-card-2 px-3.5 py-3 text-[13.5px]"
          role="alertdialog"
          aria-label={G.startOver}
        >
          <span>{G.startOverConfirm}</span>
          <span className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setStartingOver(false)}>
              Keep my answers
            </Button>
            <Button size="sm" onClick={() => void startOver()} data-testid="guided-start-over-yes">
              {G.startOver}
            </Button>
          </span>
        </div>
      ) : (
        <WelcomeBack
          line={`${G.welcomeBack(firstName, when)}${i > 0 && screen !== 'review' ? ` ${G.stoppedAt(i + 1)}` : ''}`}
          onStartOver={() => setStartingOver(true)}
        />
      )
    ) : null;

  const footer = (q: PaymentsSetupQuestion) => (
    <GuidedFooter
      onBack={i > 0 ? back : undefined}
      onNext={next}
      busy={busy}
      error={error ?? (q === 'where' ? (problems.where ?? null) : null)}
      testId="payments-setup"
      nextLabel={
        returnTo === 'review' || (!returnTo && i === questions.length - 1) ? G.checkItOver : G.next
      }
    />
  );
  const card = (q: PaymentsSetupQuestion, title: string, hint: string, children: ReactNode) =>
    page(
      <GuidedCard
        screen={q}
        testId="payments-setup"
        kicker={G.question(i + 1, questions.length)}
        title={title}
        hint={hint}
        banner={banner}
        steps={steps}
        stepsTitle={W.soFar}
        stepsNote={
          usual ? (
            <p className="px-2.5 text-[12.5px] text-text-3" data-testid="payments-setup-usual">
              {W.usualFor(usual)}
            </p>
          ) : null
        }
        footer={footer(q)}
      >
        {children}
      </GuidedCard>,
    );

  if (screen === 'review') {
    const estimateFirst = numberPreview(ctx.settings.numbering.estimate);
    return page(
      <GuidedCard
        screen="review"
        testId="payments-setup"
        kicker={G.checkKicker}
        title={W.review.title}
        hint={`${W.review.hint} ${G.answersKept}`}
        banner={banner}
        aside={
          <>
            <StepsTitle>{W.review.next}</StepsTitle>
            <ol className="flex flex-col gap-3">
              {(ctx.mode === 'again'
                ? [W.review.nextSave, W.review.accountHere(providerName ?? '')]
                : providerName
                  ? [
                      W.review.nextSave,
                      W.review.nextSignIn(providerName),
                      W.review.nextBack(providerName),
                    ]
                  : [W.review.nextSave, W.review.nextLater]
              ).map((line, n) => (
                <li key={line} className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className="mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border border-border-strong text-[11px] font-semibold text-text-2"
                  >
                    {n + 1}
                  </span>
                  <span className="text-[13px] text-text-2">{line}</span>
                </li>
              ))}
            </ol>
          </>
        }
        footer={
          <GuidedFooter
            onBack={back}
            onNext={() => void finish()}
            busy={busy}
            error={error}
            nextIcon={false}
            nextLabel={
              ctx.mode === 'new' && providerName ? W.review.connect(providerName) : W.review.save
            }
            testId="payments-setup"
          />
        }
      >
        <div className="overflow-hidden rounded-menu border border-border">
          {lines.map((l) => (
            <div
              key={l.key}
              className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
              data-testid={`payments-review-${l.key}`}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
                  {l.label}
                </div>
                <div className="break-words font-semibold">{l.value ?? '—'}</div>
              </div>
              {questions.includes(l.key) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setReturnTo('review');
                    go(l.key);
                  }}
                  data-testid={`payments-review-change-${l.key}`}
                >
                  {G.change}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1.5 rounded-menu bg-card-2 px-4 py-3.5 text-[13.5px] text-text-2">
          <div className="font-semibold text-text">{W.review.already}</div>
          {provider ? <div>{W.review.alreadyAccess}</div> : null}
          {answers.estimates ? (
            <>
              <div>{W.review.alreadyEstimateNote(ctx.settings.notes.estimate)}</div>
              <div>{W.review.alreadyEstimateNumbers(estimateFirst)}</div>
            </>
          ) : null}
          <div className="text-text-3">{W.review.alreadyLater}</div>
        </div>
      </GuidedCard>,
    );
  }

  switch (screen) {
    case 'where':
      return card(
        'where',
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
              testId="payments-setup-where-stripe"
            />
            <ChoiceTile
              selected={answers.where === 'square'}
              onSelect={() => set({ where: 'square' })}
              title={W.where.square.title}
              hint={W.where.square.hint}
              testId="payments-setup-where-square"
            />
            <ChoiceTile
              selected={answers.where === 'paypal'}
              onSelect={() => set({ where: 'paypal' })}
              title={W.where.paypal.title}
              disabled={!ctx.payPalOpen}
              hint={
                ctx.payPalOpen ? (
                  W.where.paypal.hint
                ) : (
                  <>
                    <Badge variant="pending" className="mr-1.5">
                      {W.where.paypal.soon}
                    </Badge>
                    {W.where.paypal.soonHint}
                  </>
                )
              }
              testId="payments-setup-where-paypal"
            />
            <ChoiceTile
              selected={answers.where === 'later'}
              onSelect={() => set({ where: 'later' })}
              title={W.where.later.title}
              hint={W.where.later.hint}
              testId="payments-setup-where-later"
            />
          </Choices>
          <GuidedNote>{providerName ? W.where.note(providerName) : W.where.noteLater}</GuidedNote>
          <Link
            href={`/app/w/${workspaceId}/settings/payments?all=1`}
            className="self-start text-[13.5px] font-medium text-accent-text hover:underline"
            data-testid="payments-setup-skip"
          >
            {W.where.skip}
          </Link>
        </>,
      );

    case 'ways':
      return card(
        'ways',
        W.ways.title,
        W.ways.hint,
        <>
          <div className="overflow-hidden rounded-menu border border-border">
            {provider === 'paypal' ? (
              <>
                <WayRow
                  title={W.ways.payPal.title}
                  hint={W.ways.payPal.hint}
                  end={<Badge variant="gray">{W.ways.card.on}</Badge>}
                />
                <WayRow
                  title={W.ways.venmo.title}
                  hint={W.ways.venmo.hint}
                  end={
                    <Switch
                      checked={answers.venmo}
                      onChange={(venmo) => set({ venmo })}
                      label={W.ways.venmo.title}
                      testId="payments-setup-venmo"
                    />
                  }
                />
                <WayRow
                  title={W.ways.payLater.title}
                  hint={W.ways.payLater.hint}
                  end={
                    <Switch
                      checked={answers.payLater}
                      onChange={(payLater) => set({ payLater })}
                      label={W.ways.payLater.title}
                      testId="payments-setup-pay-later"
                    />
                  }
                />
              </>
            ) : (
              <>
                <WayRow
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      {W.ways.bankTransfer.title}
                      <Badge variant="ok">{W.ways.bankTransfer.badge}</Badge>
                    </span>
                  }
                  hint={W.ways.bankTransfer.hint}
                  end={
                    <Switch
                      checked={answers.bankTransfer}
                      onChange={(bankTransfer) => set({ bankTransfer })}
                      label={W.ways.bankTransfer.title}
                      testId="payments-setup-bank-transfer"
                    />
                  }
                />
                <WayRow
                  title={W.ways.card.title}
                  hint={W.ways.card.hint}
                  end={<Badge variant="gray">{W.ways.card.on}</Badge>}
                />
              </>
            )}
            <WayRow
              title={W.ways.cash.title}
              hint={W.ways.cash.hint}
              end={<Badge variant="gray">{W.ways.cash.on}</Badge>}
            />
          </div>
          <GuidedNote>{W.ways.note}</GuidedNote>
        </>,
      );

    case 'tax':
      return card(
        'tax',
        W.tax.title,
        W.tax.hint,
        <>
          <Choices label={W.lines.tax}>
            <ChoiceTile
              selected={answers.tax === 'no'}
              onSelect={() => set({ tax: 'no' })}
              title={W.tax.no.title}
              hint={W.tax.no.hint}
              testId="payments-setup-tax-no"
            />
            <ChoiceTile
              selected={answers.tax === 'yes'}
              onSelect={() => set({ tax: 'yes' })}
              title={W.tax.yes.title}
              hint={W.tax.yes.hint}
              testId="payments-setup-tax-yes"
            >
              <div className="flex flex-wrap gap-4">
                <div className="w-32">
                  <Label htmlFor="pay-setup-tax-rate">{W.tax.rate}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="pay-setup-tax-rate"
                      inputMode="decimal"
                      value={answers.taxRate}
                      onChange={(e) => set({ taxRate: e.target.value.slice(0, 10) })}
                      invalid={!!problems.taxRate}
                      placeholder="8.25"
                      data-testid="payments-setup-tax-rate"
                    />
                    <span className="text-text-2">%</span>
                  </div>
                </div>
                <div className="min-w-0 flex-1 basis-[200px]">
                  <Label htmlFor="pay-setup-tax-name">{W.tax.name}</Label>
                  <Input
                    id="pay-setup-tax-name"
                    value={answers.taxName}
                    maxLength={40}
                    onChange={(e) => set({ taxName: e.target.value })}
                    invalid={!!problems.taxName}
                    data-testid="payments-setup-tax-name"
                  />
                </div>
              </div>
              <FieldError>{problems.taxRate ?? problems.taxName}</FieldError>
              <div>
                <Checkbox
                  label={W.tax.newTaxable}
                  checked={answers.newTaxable}
                  onChange={(e) => set({ newTaxable: e.target.checked })}
                  data-testid="payments-setup-new-taxable"
                />
                <Hint className="pl-7">{W.tax.newTaxableHint}</Hint>
              </div>
            </ChoiceTile>
          </Choices>
          <FieldError>{problems.tax}</FieldError>
          <GuidedNote>{W.tax.note}</GuidedNote>
        </>,
      );

    case 'due':
      return card(
        'due',
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
                testId={`payments-setup-due-${t}`}
              />
            ))}
          </Choices>
          <GuidedNote>{W.due.note}</GuidedNote>
        </>,
      );

    case 'estimates':
      return card(
        'estimates',
        W.estimates.title,
        W.estimates.hint,
        <>
          <Choices label={W.lines.estimates}>
            <ChoiceTile
              selected={answers.estimates}
              onSelect={() => set({ estimates: true })}
              title={W.estimates.yes.title}
              hint={W.estimates.yes.hint}
              testId="payments-setup-estimates-yes"
            >
              <div className="flex flex-wrap items-center gap-2 text-[14px]">
                <label htmlFor="pay-setup-estimate-days">{W.estimates.goodFor}</label>
                <Input
                  id="pay-setup-estimate-days"
                  inputMode="numeric"
                  className="w-20"
                  value={answers.estimateDays}
                  onChange={(e) => set({ estimateDays: e.target.value.slice(0, 4) })}
                  invalid={!!problems.estimateDays}
                  data-testid="payments-setup-estimate-days"
                />
                <span>{W.estimates.days}</span>
              </div>
              <FieldError>{problems.estimateDays}</FieldError>
              <div className="flex flex-col gap-2">
                <div className="text-[13.5px] font-medium">{W.estimates.upFront}</div>
                <div
                  role="radiogroup"
                  aria-label={W.estimates.upFront}
                  className="flex flex-wrap gap-2"
                >
                  {DEPOSITS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      role="radio"
                      aria-checked={answers.deposit === d}
                      onClick={() => set({ deposit: d })}
                      className={cn(
                        'h-9 rounded-control border px-3 text-[13.5px] font-medium',
                        answers.deposit === d
                          ? 'border-accent bg-card text-accent-text shadow-[0_0_0_1px_var(--color-accent)]'
                          : 'border-border-strong bg-card text-text hover:bg-card-2',
                      )}
                      data-testid={`payments-setup-deposit-${d}`}
                    >
                      {W.estimates.deposit[d]}
                    </button>
                  ))}
                </div>
                {answers.deposit === 'percent' ? (
                  <div className="flex flex-wrap items-center gap-2 text-[14px]">
                    <Input
                      aria-label={W.estimates.deposit.percent}
                      inputMode="decimal"
                      className="w-20"
                      value={answers.depositPercent}
                      onChange={(e) => set({ depositPercent: e.target.value.slice(0, 6) })}
                      invalid={!!problems.depositPercent}
                      data-testid="payments-setup-deposit-percent-value"
                    />
                    <span className="text-text-2">{W.estimates.percentAfter}</span>
                  </div>
                ) : answers.deposit === 'amount' ? (
                  <div className="flex flex-wrap items-center gap-2 text-[14px]">
                    <Input
                      aria-label={W.estimates.deposit.amount}
                      inputMode="decimal"
                      className="w-32"
                      placeholder="$500"
                      value={answers.depositAmount}
                      onChange={(e) => set({ depositAmount: e.target.value.slice(0, 14) })}
                      invalid={!!problems.depositAmount}
                      data-testid="payments-setup-deposit-amount-value"
                    />
                    <span className="text-text-2">{W.estimates.amountAfter}</span>
                  </div>
                ) : null}
                <FieldError>{problems.depositPercent ?? problems.depositAmount}</FieldError>
              </div>
            </ChoiceTile>
            <ChoiceTile
              selected={!answers.estimates}
              onSelect={() => set({ estimates: false })}
              title={W.estimates.no.title}
              hint={W.estimates.no.hint}
              testId="payments-setup-estimates-no"
            />
          </Choices>
          <GuidedNote>{W.estimates.note}</GuidedNote>
        </>,
      );

    case 'reminders': {
      const own = paymentsRemindersOf(ctx.settings) === 'own';
      const usualChips = paymentsReminderChips('usual', answers.terms, ctx.settings.reminders);
      return card(
        'reminders',
        W.reminders.title,
        W.reminders.hint,
        <>
          <Choices label={W.lines.reminders}>
            <ChoiceTile
              selected={answers.reminders === 'usual'}
              onSelect={() => set({ reminders: 'usual' })}
              title={W.reminders.usual.title}
              best={W.reminders.usual.most(usualChips.length)}
              testId="payments-setup-reminders-usual"
            >
              <Chips items={usualChips} />
              <span className="text-[13.5px] text-text-2">{W.reminders.usual.hint}</span>
            </ChoiceTile>
            <ChoiceTile
              selected={answers.reminders === 'few'}
              onSelect={() => set({ reminders: 'few' })}
              title={W.reminders.few.title}
              hint={W.reminders.few.hint}
              testId="payments-setup-reminders-few"
            />
            {own ? (
              <ChoiceTile
                selected={answers.reminders === 'own'}
                onSelect={() => set({ reminders: 'own' })}
                title={W.reminders.own.title}
                hint={paymentsRemindersSummary(ctx.settings.reminders)}
                testId="payments-setup-reminders-own"
              />
            ) : null}
            <ChoiceTile
              selected={answers.reminders === 'none'}
              onSelect={() => set({ reminders: 'none' })}
              title={W.reminders.none.title}
              hint={W.reminders.none.hint}
              testId="payments-setup-reminders-none"
            />
          </Choices>
          {answers.estimates ? (
            <div className="rounded-menu border border-border px-3.5 py-3">
              <Checkbox
                label={W.reminders.nudge}
                checked={answers.estimateNudge}
                onChange={(e) => set({ estimateNudge: e.target.checked })}
                data-testid="payments-setup-estimate-nudge"
              />
              <Hint className="pl-7">
                {W.reminders.nudgeHint(ctx.settings.reminders.estimateAfterDays ?? 3)}
              </Hint>
            </div>
          ) : null}
          <GuidedNote>{W.reminders.note}</GuidedNote>
        </>,
      );
    }

    case 'documents': {
      const next = /^\d+$/.test(answers.invoiceNext.trim()) ? Number(answers.invoiceNext) : null;
      const fromSetup =
        !!ctx.setupAddress && !ctx.settings.businessAddress && answers.address === ctx.setupAddress;
      return card(
        'documents',
        W.documents.title,
        W.documents.hint,
        <>
          <div>
            <Label htmlFor="pay-setup-address">{W.documents.address}</Label>
            <Textarea
              id="pay-setup-address"
              rows={4}
              value={answers.address}
              onChange={(e) => set({ address: e.target.value.slice(0, 300) })}
              invalid={!!problems.address}
              data-testid="payments-setup-address"
            />
            <FieldError>{problems.address}</FieldError>
            <Hint>{fromSetup ? W.documents.addressFromSetup : W.documents.addressHint}</Hint>
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-medium">{W.documents.numbers}</div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-32">
                <Label htmlFor="pay-setup-prefix" className="font-normal text-text-2">
                  {W.documents.startWith}
                </Label>
                <Input
                  id="pay-setup-prefix"
                  value={answers.invoicePrefix}
                  onChange={(e) => set({ invoicePrefix: e.target.value.slice(0, 20) })}
                  invalid={!!problems.invoicePrefix}
                  data-testid="payments-setup-prefix"
                />
              </div>
              <div className="w-32">
                <Label htmlFor="pay-setup-next" className="font-normal text-text-2">
                  {W.documents.nextNumber}
                </Label>
                <Input
                  id="pay-setup-next"
                  inputMode="numeric"
                  value={answers.invoiceNext}
                  onChange={(e) => set({ invoiceNext: e.target.value.slice(0, 12) })}
                  invalid={!!problems.invoiceNext}
                  data-testid="payments-setup-next"
                />
              </div>
              {next && !problems.invoicePrefix ? (
                <div
                  className="pb-2 text-[13.5px] text-text-2"
                  data-testid="payments-setup-preview"
                >
                  {W.documents.preview}{' '}
                  <span className="font-mono font-medium text-text">
                    {numberPreview({
                      ...ctx.settings.numbering.invoice,
                      prefix: answers.invoicePrefix.trim(),
                      next,
                    })}
                  </span>
                </div>
              ) : null}
            </div>
            <FieldError>{problems.invoicePrefix ?? problems.invoiceNext}</FieldError>
            <Hint className="mt-0">
              {W.documents.numbersHint(
                answers.estimates ? numberPreview(ctx.settings.numbering.estimate) : null,
              )}
            </Hint>
          </div>
          <div>
            <Label htmlFor="pay-setup-note">{W.documents.note}</Label>
            <Textarea
              id="pay-setup-note"
              rows={3}
              value={answers.note}
              onChange={(e) => set({ note: e.target.value.slice(0, 2_000) })}
              invalid={!!problems.note}
              data-testid="payments-setup-note"
            />
            <FieldError>{problems.note}</FieldError>
            <Hint>{W.documents.noteHint}</Hint>
          </div>
        </>,
      );
    }
  }
}

function StepsTitle({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
      {children}
    </div>
  );
}

function WayRow({ title, hint, end }: { title: ReactNode; hint: string; end: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="font-semibold">{title}</div>
        <div className="text-[13.5px] leading-snug text-text-2">{hint}</div>
      </div>
      <div className="flex-none pt-0.5">{end}</div>
    </div>
  );
}

function Chips({ items }: { items: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((c) => (
        <span
          key={c}
          className="inline-flex h-7 items-center rounded-full border border-border bg-card px-2.5 text-[12.5px] text-text-2"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

/**
 * Done (`?done=1`): the answers are saved, and the account is connected, still being checked, or not connected
 * (the sign-in was cancelled or failed, or they picked Not now). `?payments=` is how the sign-in went.
 */
export function PaymentsSetupDone({
  workspaceId,
  businessName,
  email,
  settings,
  account,
  tried,
  result,
  from,
}: {
  workspaceId: string;
  businessName: string;
  email: string;
  settings: MoneySettings;
  account: PaymentsSetupAccount | null;
  /** The provider they went to sign in to, when they did. */
  tried: ConnectableProvider | null;
  /** `?payments=` from the sign-in. */
  result: string | null;
  from: PaymentsSetupFrom;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const home = paymentsSetupHome(workspaceId, from);
  const provider = account?.provider ?? tried;
  const name = provider ? PAYMENT_PROVIDER_NAMES[provider] : null;
  const chips = paymentsDoneChips(settings, account?.provider ?? null);
  const failed = !account && result && result !== 'connected' ? PAYMENT_RESULT[result] : null;
  const base = `/app/w/${workspaceId}`;

  const connect = () => {
    if (!tried) return;
    setBusy(true);
    keepSetupReturn(workspaceId, 'payments', doneHref(workspaceId, from, tried));
    connectPaymentAccount(workspaceId, tried).catch((e: unknown) => {
      toast.error(errorMessage(e));
      setBusy(false);
    });
  };

  return (
    <GuidedPage
      business={{ name: businessName, home: base }}
      email={email}
      settingUp={W.settingUp(businessName)}
      saved="idle"
      onLeave={() => router.push(home)}
      leaveLabel={G.close}
    >
      <Card
        className="mx-auto flex w-full max-w-[760px] flex-col gap-6 rounded-dialog p-6 sm:p-8"
        data-testid="payments-setup-done"
        data-account={account?.state ?? (tried ? 'not-connected' : 'none')}
      >
        <div className="flex flex-col gap-3">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-success-soft text-success-text">
            <Check className="h-5 w-5" strokeWidth={2.5} />
          </span>
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.015em]">
            {W.done.title}
          </h1>
          <p className="text-[15px] text-text-2">{W.done.hint}</p>
          <div className="flex flex-wrap gap-1.5" data-testid="payments-setup-done-chips">
            {chips.map((c) => (
              <Badge key={c} variant="ok">
                {c}
              </Badge>
            ))}
          </div>
        </div>

        {account?.state === 'checking' && name ? (
          <Callout tone="warning" icon={Clock} data-testid="payments-setup-checking">
            <div className="font-semibold">{W.done.checking(name)}</div>
            <div>{W.done.checkingHint(name)}</div>
          </Callout>
        ) : account?.state === 'ready' && name ? (
          <Callout tone="info" icon={Check} data-testid="payments-setup-ready">
            <div className="font-semibold">{W.done.ready(name)}</div>
            <div>{W.done.readyHint}</div>
          </Callout>
        ) : tried && name ? (
          <Callout
            tone="warning"
            icon={CircleAlert}
            data-testid="payments-setup-not-connected"
            action={
              <Button size="sm" loading={busy} onClick={connect}>
                {W.done.connect(name)}
              </Button>
            }
          >
            <div className="font-semibold">{W.done.notConnected(name)}</div>
            <div>
              {failed ? `${failed.text} ` : ''}
              {W.done.notConnectedHint}
            </div>
          </Callout>
        ) : (
          <GuidedNote>
            <span className="font-semibold text-text">{W.done.later}.</span> {W.done.laterHint}
          </GuidedNote>
        )}

        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
            {W.done.nextTitle}
          </div>
          <NextLink
            href={`${base}/settings/payments/products`}
            icon={Tag}
            title={W.done.prices.title}
            hint={W.done.prices.hint}
          />
          <NextLink
            href={`${base}/money/${settings.deposit.kind === 'none' && settings.reminders.estimateAfterDays === null ? 'invoices' : 'estimates'}/new`}
            icon={FileText}
            title={
              settings.deposit.kind === 'none' && settings.reminders.estimateAfterDays === null
                ? W.done.invoice.title
                : W.done.estimate.title
            }
            hint={W.done.estimate.hint}
          />
          <NextLink
            href={`${base}/settings/calendars`}
            icon={CalendarDays}
            title={W.done.bookingDeposit.title}
            hint={W.done.bookingDeposit.hint}
          />
        </div>

        <div className="flex justify-end border-t border-border pt-4">
          <ButtonLink
            href={home}
            variant="primary"
            size="lg"
            data-testid="payments-setup-done-close"
          >
            {from === 'setup' ? W.done.close : W.done.toSettings}
          </ButtonLink>
        </div>
      </Card>
    </GuidedPage>
  );
}

function NextLink({
  href,
  icon: Icon,
  title,
  hint,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3.5 rounded-menu border border-border bg-card px-4 py-3.5 hover:bg-card-2"
    >
      <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-[9px] bg-accent-soft text-accent-text">
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-semibold">{title}</span>
        <span className="text-[13px] text-text-2">{hint}</span>
      </span>
    </Link>
  );
}
