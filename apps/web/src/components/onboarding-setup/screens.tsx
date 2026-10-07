'use client';
/**
 * The onboarding setup's own screens (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4): the goal, about
 * the business, the hours, the customers, the booking page, the number, payments and reviews, and the last screen.
 * The first screen is business.tsx, and the AI teammate's are the AI quick setup's own. Each only shows and changes
 * answers, or opens the screen that already does a stop's job (the number search and registration, the GoHighLevel
 * move, the spreadsheet import, the payments sign-in) in place; the frame (quick-setup.tsx) checks, keeps and saves.
 */
import {
  AI_SETUP_FIELD_WORDS as AW,
  aiSetupProblemAt,
  CUSTOMER_SOURCES,
  ONBOARDING_GOALS,
  ONBOARDING_KIND_INFO,
  ONBOARDING_SETUP_MAX,
  ONBOARDING_SETUP_WORDS as W,
  PAY_WITH,
  QUESTION_WORDS,
  setupFor,
  TEAM_SIZES,
  withAiName,
  WIZARD_WORDS,
  type AiSetupAnswers,
  type AiSetupProblems,
  type CustomerSource,
  type OnboardingSetupAnswers,
  type OnboardingSetupState,
} from '@hfos/core';
import {
  AlertTriangle,
  Check,
  Clock,
  ExternalLink,
  Loader2,
  Phone,
  Plus,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout, Note } from '@/components/ai-team/parts';
import { Option, Pills, ServicesField } from '@/components/ai-setup/fields';
import { WeeklyHoursEditor } from '@/components/calendars/weekly-hours';
import { PhoneAppDialog } from '@/components/home/phone-app-dialog';
import { ImportWizard } from '@/components/import/import-wizard';
import { ConnectSourceButton, StartMigrationButton } from '@/components/migrations/connect';
import {
  connectPaymentAccount,
  PAYMENT_RESULT,
  PROVIDER_NAME,
} from '@/components/settings/payment-connection-card';
import { TextingPage } from '@/components/settings/texting-page';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { CopyField } from '@/components/ui/copy-field';
import { Field, FieldError, Hint, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/client';
import { onboardingSetupHref, type OnboardingSetupData } from '@/lib/onboarding-setup/data';
import { keepSetupReturn } from '@/lib/setup-return';
import { usePublicOrigin } from '@/lib/use-origin';

type OwnField = Exclude<keyof OnboardingSetupAnswers, 'ai'>;

export interface OwnScreenProps {
  readonly state: OnboardingSetupState;
  readonly answers: OnboardingSetupAnswers;
  readonly set: <K extends OwnField>(key: K, value: OnboardingSetupAnswers[K]) => void;
  readonly setAi: <K extends keyof AiSetupAnswers>(key: K, value: AiSetupAnswers[K]) => void;
  /** By path into the answers: `reviewLink`, `ai.services.0.name`, `invite.0`. */
  readonly problems: AiSetupProblems;
  readonly data: OnboardingSetupData;
  /** The AI teammate's name, for the words. */
  readonly name: string;
}

/** The AI part's problems at its own paths, as its fields read them: `ai.services.0.name` → `services.0.name`. */
export const aiProblemsOf = (problems: AiSetupProblems): AiSetupProblems =>
  Object.fromEntries(
    Object.entries(problems).flatMap(([path, message]) =>
      path.startsWith('ai.') ? [[path.slice(3), message]] : [],
    ),
  );

function Group({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={className ?? 'flex flex-col gap-2'}>
      {children}
    </div>
  );
}

/** A stop's own part while the page brings it. */
export function Loading() {
  return (
    <div
      className="flex items-center gap-2.5 py-2 text-[13.5px] text-text-2"
      data-testid="onboarding-setup-loading"
    >
      <Loader2 className="h-4 w-4 flex-none animate-spin" strokeWidth={2} />
      {W.loading}
    </div>
  );
}

/** While Ava reads the website for these screens. */
function Reading({ state, name }: { state: OnboardingSetupState; name: string }) {
  if (!state.reading) return null;
  return (
    <div
      className="flex items-center gap-2.5 rounded-menu bg-accent-soft px-3.5 py-3 text-[13.5px] text-accent-text"
      data-testid="ai-setup-reading"
    >
      <Loader2 className="h-4 w-4 flex-none animate-spin" strokeWidth={2} />
      {withAiName(AW.reading, name)}
    </div>
  );
}

// ---- What do you want help with first? ----

export function GoalScreen({
  state,
  answers,
  set,
  problems,
  invites,
  setInvites,
}: OwnScreenProps & {
  /** "Invite them now", as typed. */
  readonly invites: readonly string[];
  readonly setInvites: (next: string[]) => void;
}) {
  const room = ONBOARDING_SETUP_MAX.invites - invites.length;
  return (
    <>
      <Group label={QUESTION_WORDS.goal} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {ONBOARDING_GOALS.map((goal) => (
          <Option
            key={goal}
            on={answers.goal === goal}
            onSelect={() => set('goal', goal)}
            title={W.goals[goal]}
            testId={`setup-goal-${goal}`}
          />
        ))}
      </Group>
      <Pills
        name="team-size"
        legend={W.teamSize}
        options={TEAM_SIZES}
        labels={W.teams}
        value={answers.teamSize}
        onChange={(teamSize) => set('teamSize', teamSize)}
      />
      {answers.teamSize !== 'solo' ? (
        <fieldset className="flex flex-col gap-2" data-testid="setup-invites">
          <legend className="text-[13px] font-medium">{W.inviteNow}</legend>
          <Hint className="-mt-0.5 mb-1">{W.inviteHint}</Hint>
          {invites.map((email, i) => (
            <div key={i}>
              <div className="flex items-center gap-2">
                <Input
                  type="email"
                  aria-label={W.inviteEmail}
                  placeholder={W.inviteEmail}
                  autoComplete="off"
                  value={email}
                  maxLength={254}
                  invalid={!!problems[`invite.${i}`]}
                  onChange={(e) =>
                    setInvites(invites.map((x, j) => (j === i ? e.target.value : x)))
                  }
                  data-testid={`setup-invite-${i}`}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={W.inviteEmail}
                  onClick={() => setInvites(invites.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </div>
              <FieldError>{problems[`invite.${i}`]}</FieldError>
            </div>
          ))}
          {room > 0 ? (
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setInvites([...invites, ''])}
                data-testid="setup-invite-add"
              >
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                {W.addInvite}
              </Button>
            </div>
          ) : null}
          <FieldError>{problems['invite']}</FieldError>
          {state.team.invited.map((email) => (
            <p key={email} className="flex items-center gap-2 text-[13px] text-success-text">
              <Check className="h-4 w-4 flex-none" strokeWidth={2} />
              {W.invited(email)}
            </p>
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

// ---- About your business ----

export function AboutScreen({ state, answers, set, setAi, problems, name }: OwnScreenProps) {
  const ai = aiProblemsOf(problems);
  const { area } = setupFor(state.industry);
  return (
    <>
      <Reading state={state} name={name} />
      <Field label={AW.description} htmlFor="setup-description" error={ai['description']}>
        <Textarea
          id="setup-description"
          value={answers.ai.description}
          maxLength={2000}
          invalid={!!ai['description']}
          onChange={(e) => setAi('description', e.target.value)}
          data-testid="ai-setup-description"
        />
      </Field>
      <ServicesField
        services={answers.ai.services}
        onChange={(next) => setAi('services', next)}
        problems={ai}
        legend={ONBOARDING_KIND_INFO[state.kind].services}
        priced
      />
      <Field label={area.question} htmlFor="setup-area" error={ai['area']}>
        <Input
          id="setup-area"
          value={answers.ai.area}
          maxLength={500}
          placeholder={area.example}
          invalid={!!ai['area']}
          onChange={(e) => setAi('area', e.target.value)}
          data-testid="ai-setup-area"
        />
      </Field>
      <div>
        <Pills
          name="books-time"
          legend={W.booksTime}
          options={['yes', 'no'] as const}
          labels={{ yes: AW.yes, no: AW.no }}
          value={answers.booksTime ? 'yes' : 'no'}
          onChange={(v) => set('booksTime', v === 'yes')}
        />
        <Hint>{W.booksTimeHint}</Hint>
      </div>
    </>
  );
}

// ---- When are you open? ----

export function HoursScreen({ state, answers, setAi, problems, name }: OwnScreenProps) {
  return (
    <>
      <Reading state={state} name={name} />
      <div>
        <Label>{AW.openHours}</Label>
        <WeeklyHoursEditor
          value={answers.ai.openHours}
          onChange={(next) => setAi('openHours', next)}
          idPrefix="setup-open"
        />
        <FieldError>{aiSetupProblemAt(aiProblemsOf(problems), 'openHours')}</FieldError>
      </div>
    </>
  );
}

// ---- Where are your customers now? ----

const SOURCE_HINTS: Readonly<Record<CustomerSource, string>> = {
  ghl: W.ghlHint,
  sheet: W.sheetHint,
  crm: W.crmHint,
  phone: W.phoneHint,
  none: W.noneHint,
};

export function CustomersScreen({ answers, set, data }: OwnScreenProps) {
  const [app, setApp] = useState(false);
  return (
    <>
      <Group label={QUESTION_WORDS.customersIn}>
        {CUSTOMER_SOURCES.map((source) => (
          <Option
            key={source}
            on={answers.customersIn === source}
            onSelect={() => set('customersIn', source)}
            title={W.sources[source]}
            description={SOURCE_HINTS[source]}
            testId={`setup-customers-${source}`}
          />
        ))}
      </Group>
      {answers.customersIn === 'ghl' ? (
        <MoveFromGoHighLevel data={data} />
      ) : answers.customersIn === 'sheet' || answers.customersIn === 'crm' ? (
        data.customers === undefined ? (
          <Loading />
        ) : data.customers.canImport ? (
          <ImportWizard workspaceId={data.workspaceId} />
        ) : (
          <Note>{W.cantDo}</Note>
        )
      ) : answers.customersIn === 'phone' ? (
        <div>
          <Button
            variant="secondary"
            onClick={() => setApp(true)}
            data-testid="setup-customers-app"
          >
            <Smartphone className="h-4 w-4" strokeWidth={1.75} />
            {AW.appTitle}
          </Button>
          <PhoneAppDialog open={app} onOpenChange={setApp} />
        </div>
      ) : null}
    </>
  );
}

/** GoHighLevel: paste a token, start the count, and carry on while it runs; the move has its own page. */
function MoveFromGoHighLevel({ data }: { data: OnboardingSetupData }) {
  const router = useRouter();
  const c = data.customers;
  if (c === undefined) return <Loading />;
  if (!c.canMigrate) return <Note>{W.cantDo}</Note>;
  const { workspaceId, organizationId } = data;
  if (c.move)
    return (
      <div
        className="flex flex-wrap items-start gap-3 rounded-menu bg-accent-soft px-4 py-3.5"
        data-testid="setup-customers-move"
      >
        <Clock className="mt-0.5 h-4 w-4 flex-none text-accent-text" strokeWidth={1.75} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium">
            {c.move.running ? WIZARD_WORDS.migrationCounting.title : c.move.words}
          </span>
          <span className="text-[13px] text-text-2">
            {c.move.running ? WIZARD_WORDS.migrationCounting.detail : WIZARD_WORDS.migrationReady}
          </span>
        </div>
        <ButtonLink
          href={`/app/w/${workspaceId}/settings/migrations/${c.move.id}`}
          target="_blank"
          variant="secondary"
          size="sm"
        >
          {WIZARD_WORDS.migrationOpen}
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
        </ButtonLink>
      </div>
    );
  return (
    <div>
      {c.connection ? (
        <StartMigrationButton
          organizationId={organizationId}
          workspaceId={workspaceId}
          connectionId={c.connection.id}
          sourceLabel={c.connection.sourceLabel}
          onStarted={() => router.refresh()}
        />
      ) : (
        <ConnectSourceButton
          organizationId={organizationId}
          workspaceId={workspaceId}
          beforeLeave={() =>
            keepSetupReturn(workspaceId, 'customers', onboardingSetupHref(workspaceId, 'customers'))
          }
        />
      )}
    </div>
  );
}

// ---- Your booking page is ready ----

/** What making the booking page did, from the frame, which makes it as the screen opens. */
export interface BookingMade {
  readonly making: boolean;
  readonly changes: readonly string[];
  readonly notes: readonly string[];
  readonly error: string | null;
}

export function BookingScreen({
  state,
  data,
  booking,
  onRetry,
}: OwnScreenProps & { readonly booking: BookingMade; readonly onRetry: () => void }) {
  const origin = usePublicOrigin(data.brandedOrigin);
  const site = state.booking.site;
  const link = site && origin ? `${origin}/book/${site.slug}` : null;
  return (
    <>
      {booking.making ? (
        <div
          className="flex items-center gap-2.5 rounded-menu bg-accent-soft px-3.5 py-3 text-[13.5px] text-accent-text"
          data-testid="setup-booking-making"
        >
          <Loader2 className="h-4 w-4 flex-none animate-spin" strokeWidth={2} />
          {W.makingBooking}
        </div>
      ) : null}
      {booking.error ? (
        <Callout tone="danger" icon={AlertTriangle}>
          <span className="flex flex-col items-start gap-2">
            {booking.error}
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {WIZARD_WORDS.calendarMake}
            </Button>
          </span>
        </Callout>
      ) : null}
      {booking.changes.length ? (
        <ul className="flex flex-col gap-1.5" data-testid="setup-booking-changes">
          {booking.changes.map((line) => (
            <li key={line} className="flex items-start gap-2 text-[14px]">
              <Check className="mt-0.5 h-4 w-4 flex-none text-success-text" strokeWidth={2} />
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {booking.notes.map((note) => (
        <Callout key={note} tone="warning" icon={AlertTriangle}>
          {note}
        </Callout>
      ))}
      {link && state.booking.on ? (
        <div className="flex flex-col gap-2" data-testid="setup-booking-link">
          <Label>{W.bookingAt}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <CopyField
              value={link}
              label="Copy the link"
              copied="Copied your booking page’s link"
              className="min-w-0 flex-1"
            />
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-accent-text hover:underline"
            >
              {W.openBooking}
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
            </a>
          </div>
        </div>
      ) : null}
      <section className="flex flex-wrap items-center gap-3 rounded-menu border border-border p-4">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{W.connectCalendar}</div>
          <p className="text-[13px] text-text-2">{W.connectCalendarHint}</p>
        </div>
        <ButtonLink
          href={`/app/w/${data.workspaceId}/settings/my-calendar`}
          target="_blank"
          variant="secondary"
        >
          {W.connectCalendarLink}
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
        </ButtonLink>
      </section>
    </>
  );
}

// ---- Your business number ----

export function NumberScreen({ answers, set, data }: OwnScreenProps) {
  const texting = data.texting;
  if (texting === undefined) return <Loading />;
  if (texting === null) return <Note>{W.cantDo}</Note>;
  const { status } = texting;
  if (status.nextStep === 'ready' && status.number)
    return (
      <div
        className="flex items-center gap-3.5 rounded-menu border border-border p-4"
        data-testid="setup-number-ready"
      >
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-success-soft text-success-text">
          <Phone className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </span>
        <span className="font-medium">{WIZARD_WORDS.numberReady(status.number.display)}</span>
      </div>
    );
  const buying = status.nextStep === 'buy_number';
  const numberType = answers.hasEin === false ? 'toll_free' : 'local';
  return (
    <>
      {buying ? (
        <div>
          <Label id="setup-ein">{W.ein}</Label>
          <Hint className="mb-2 mt-0">{W.einHint}</Hint>
          <div
            role="radiogroup"
            aria-labelledby="setup-ein"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <Option
              on={answers.hasEin === true}
              onSelect={() => set('hasEin', true)}
              title={WIZARD_WORDS.ein.yes}
              description={WIZARD_WORDS.ein.yesDetail}
              testId="setup-ein-yes"
            />
            <Option
              on={answers.hasEin === false}
              onSelect={() => set('hasEin', false)}
              title={WIZARD_WORDS.ein.no}
              description={WIZARD_WORDS.ein.noDetail}
              testId="setup-ein-no"
            />
          </div>
        </div>
      ) : null}
      {!buying || answers.hasEin !== null ? (
        // Keyed on the answer, so the search starts again on the kind of number it now points to.
        <TextingPage
          key={numberType}
          {...texting}
          setup={{
            numberType,
            returnTo: onboardingSetupHref(data.workspaceId, 'number'),
            nearAddress: true,
          }}
        />
      ) : null}
    </>
  );
}

// ---- Get paid, and get reviews ----

export function PaidScreen({
  state,
  answers,
  set,
  problems,
  data,
  result,
}: OwnScreenProps & {
  /** `?payments=` from Stripe's or Square's sign-in, coming back. */
  readonly result: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const back = onboardingSetupHref(data.workspaceId, 'paid');

  const told = useRef(false);
  useEffect(() => {
    if (!result || told.current) return;
    told.current = true;
    const r = PAYMENT_RESULT[result] ?? PAYMENT_RESULT.failed!;
    if (r.tone === 'success') toast.success(r.text);
    else if (r.tone === 'error') toast.error(r.text);
    else toast(r.text);
    router.replace(back, { scroll: false });
  }, [result, router, back]);

  const connect = (provider: 'stripe' | 'square') => {
    setBusy(true);
    keepSetupReturn(data.workspaceId, 'payments', back);
    connectPaymentAccount(data.workspaceId, provider).catch((e: unknown) => {
      toast.error(errorMessage(e));
      setBusy(false);
    });
  };

  const p = state.payments;
  const provider = p.provider ? (PROVIDER_NAME[p.provider] ?? p.provider) : null;
  const picked = answers.payWith === 'later' ? null : answers.payWith;
  return (
    <>
      <div>
        <Label id="setup-pay-with">{W.payWith}</Label>
        <Group label={W.payWith}>
          {PAY_WITH.map((pay) => (
            <Option
              key={pay}
              on={answers.payWith === pay}
              onSelect={() => set('payWith', pay)}
              title={W.payWithLabels[pay]}
              badge={
                pay === 'stripe' ? (
                  <Badge variant="gray" className="h-5 text-[11.5px]">
                    {WIZARD_WORDS.providers.stripe.badge}
                  </Badge>
                ) : null
              }
              description={pay === 'later' ? W.payLater : WIZARD_WORDS.providers[pay].detail}
              testId={`setup-pay-${pay}`}
            />
          ))}
        </Group>
      </div>
      {p.active && provider ? (
        p.checking ? (
          <Callout tone="warning" icon={Clock} testId="setup-pay-checking">
            {WIZARD_WORDS.paymentsWaiting(provider)}
          </Callout>
        ) : (
          <Callout icon={Check} testId="setup-pay-connected">
            {W.payConnected(provider)}
          </Callout>
        )
      ) : p.broken && p.provider && provider ? (
        <Callout tone="danger" icon={AlertTriangle}>
          <span className="flex flex-col items-start gap-2">
            {W.paySignInAgain(provider)}
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={() => connect(p.provider!)}
            >
              {WIZARD_WORDS.connect(provider)}
            </Button>
          </span>
        </Callout>
      ) : null}
      {picked && !(p.provider === picked && (p.active || p.broken)) ? (
        <div>
          <Button loading={busy} onClick={() => connect(picked)} data-testid="setup-pay-connect">
            {WIZARD_WORDS.connect(W.payWithLabels[picked])}
          </Button>
        </div>
      ) : null}
      <div>
        <Field
          label={W.reviewLink}
          htmlFor="setup-review-link"
          error={problems['reviewLink']}
          hint={W.reviewLinkHint}
        >
          <Input
            id="setup-review-link"
            inputMode="url"
            autoComplete="off"
            placeholder="g.page/r/…"
            value={answers.reviewLink}
            maxLength={ONBOARDING_SETUP_MAX.reviewLink}
            invalid={!!problems['reviewLink']}
            onChange={(e) => set('reviewLink', e.target.value)}
            data-testid="setup-review-link"
          />
        </Field>
        <button
          type="button"
          aria-expanded={help}
          onClick={() => setHelp((v) => !v)}
          className="mt-1.5 text-[13px] font-medium text-accent-text hover:underline"
        >
          {W.findReviewLink}
        </button>
        {help ? <Note className="mt-2">{W.reviewLinkHelp}</Note> : null}
      </div>
    </>
  );
}

// ---- It's already working for you ----

export function DoneScreen({ lines }: { readonly lines: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-2.5" data-testid="onboarding-setup-done">
      {lines.map((line) => (
        <li
          key={line}
          className="flex items-start gap-2.5 rounded-menu bg-card-2 px-3.5 py-3 text-[14px]"
        >
          <Check className="mt-0.5 h-4 w-4 flex-none text-success-text" strokeWidth={2} />
          {line}
        </li>
      ))}
    </ul>
  );
}
