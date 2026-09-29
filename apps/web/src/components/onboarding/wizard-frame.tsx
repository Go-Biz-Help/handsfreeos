import {
  isWizardStep,
  railLine,
  stepTitle,
  WIZARD_WORDS,
  type OnboardingStepKey,
  type WizardStepKey,
} from '@hfos/core';
import {
  AlertCircle,
  Bell,
  CalendarDays,
  Check,
  Clock,
  CreditCard,
  KeyRound,
  Mail,
  Smartphone,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Brand } from '@/components/ui/brand';
import { ButtonLink } from '@/components/ui/button';
import type { OnboardingStatus, OnboardingStep } from '@/lib/api/types';
import { setupHref } from '@/lib/setup';
import { cn } from '@/lib/utils';
import { WizardFooter } from './wizard-footer';

/** The steps under "Later, from your checklist", as the design draws them. */
const LATER_ICONS: Partial<Record<OnboardingStepKey, LucideIcon>> = {
  team: UserPlus,
  payments: CreditCard,
  email_chat: Mail,
  app: Smartphone,
  sign_in: KeyRound,
  notifications: Bell,
  my_calendar: CalendarDays,
};

/**
 * The setup wizard (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, boards 2 to 5b in design/onboarding): the
 * must-dos in their order down the side, with what comes later listed under them, and one step at a time beside
 * them. Each step mounts the screen that already does it in Settings. Finish later goes to Home, where the same
 * steps wait on the Getting started card.
 */
export function WizardFrame({
  workspaceId,
  businessName,
  status,
  step,
  children,
}: {
  workspaceId: string;
  businessName: string;
  status: OnboardingStatus;
  step: WizardStepKey;
  children: ReactNode;
}) {
  const home = `/app/w/${workspaceId}`;
  const basics = status.steps.filter((s) => s.group === 'basics' && isWizardStep(s.key));
  const later = status.steps.filter((s) => s.group !== 'basics');
  const at = basics.findIndex((s) => s.key === step);
  const current = status.steps.find((s) => s.key === step);
  const nextStep = at >= 0 ? basics[at + 1] : undefined;
  const prevStep = at > 0 ? basics[at - 1] : undefined;
  // The first step goes back to the questions that put the steps in this order, when they were answered.
  const back = prevStep
    ? setupHref(workspaceId, prevStep.key as WizardStepKey)
    : at === 0 && status.answers
      ? `/onboarding/${workspaceId}/questions`
      : home;
  const next = nextStep ? setupHref(workspaceId, nextStep.key as WizardStepKey) : home;
  const state = current?.state ?? 'todo';

  return (
    <div className="flex min-h-dvh flex-col bg-bg" data-testid="setup-wizard" data-step={step}>
      <header className="sticky top-0 z-20 flex h-16 flex-none items-center justify-between gap-3 border-b border-border bg-card px-4 md:px-6">
        <Link href={home} aria-label="Home">
          <Brand size={28} />
        </Link>
        <span className="hidden truncate text-[13px] text-text-2 sm:block">
          {WIZARD_WORDS.settingUp(businessName)}
        </span>
        <ButtonLink href={home} variant="ghost" data-testid="setup-finish-later">
          {WIZARD_WORDS.finishLater}
        </ButtonLink>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-[300px] flex-none flex-col gap-1 overflow-y-auto border-r border-border bg-card px-[18px] pb-5 pt-7 md:flex"
          aria-label={WIZARD_WORDS.railTitle}
          data-testid="setup-rail"
        >
          <div className="px-2.5 pb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {WIZARD_WORDS.railTitle}
          </div>
          <p className="px-2.5 pb-3 text-[13px] text-text-3">{WIZARD_WORDS.railIntro}</p>
          <ol className="flex flex-col gap-1">
            {basics.map((s, i) => (
              <li key={s.key}>
                <RailStep
                  workspaceId={workspaceId}
                  step={s}
                  n={i + 1}
                  current={s.key === step}
                  status={status}
                />
              </li>
            ))}
          </ol>
          {later.length ? (
            <>
              <div className="mx-2.5 my-3.5 h-px bg-border" />
              <div className="px-2.5 pb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                {WIZARD_WORDS.railLater}
              </div>
              <ul className="flex flex-col">
                {later.map((s) => {
                  const Icon = LATER_ICONS[s.key] ?? Check;
                  const here = s.key === step;
                  return (
                    <li
                      key={s.key}
                      aria-current={here ? 'step' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-menu px-2.5 py-1.5 text-[13px] text-text-2',
                        here && 'bg-accent-soft font-medium text-accent-text',
                        (s.state === 'done' || s.state === 'waiting') && 'text-text-3 line-through',
                      )}
                    >
                      <Icon className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
                      {stepTitle(s.key)}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex w-full max-w-[860px] flex-1 flex-col gap-[22px] px-4 pb-6 pt-6 md:px-14 md:pt-9">
            <div className="flex flex-col gap-1.5">
              <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                {at >= 0
                  ? `${WIZARD_WORDS.position(at + 1, basics.length)} · ${WIZARD_WORDS.railTitle}`
                  : WIZARD_WORDS.railLater}
              </div>
              <h1 className="text-2xl font-semibold tracking-[-0.01em]">
                {WIZARD_WORDS.titles[step]}
              </h1>
              <p className="max-w-[640px] text-text-2">{WIZARD_WORDS.intros[step]}</p>
            </div>
            {state === 'done' ? (
              <div
                className="flex items-center gap-2.5 rounded-menu bg-success-soft px-4 py-3 text-[13.5px] text-success-text"
                data-testid="setup-done"
              >
                <Check className="h-4 w-4 flex-none" strokeWidth={2} />
                {WIZARD_WORDS.alreadyDone}
              </div>
            ) : null}
            {children}
          </div>
          <WizardFooter
            workspaceId={workspaceId}
            step={step}
            open={state === 'todo' || state === 'needs_fix'}
            back={back}
            next={next}
            last={!nextStep}
          />
        </main>
      </div>
    </div>
  );
}

function RailStep({
  workspaceId,
  step,
  n,
  current,
  status,
}: {
  workspaceId: string;
  step: OnboardingStep;
  n: number;
  current: boolean;
  status: OnboardingStatus;
}) {
  const finished = step.state === 'done' || step.state === 'waiting';
  return (
    <Link
      href={setupHref(workspaceId, step.key as WizardStepKey)}
      aria-current={current ? 'step' : undefined}
      data-testid={`setup-rail-${step.key}`}
      data-state={step.state}
      className={cn(
        'flex items-start gap-3 rounded-[10px] p-2.5 text-text hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        current && 'bg-accent-soft hover:bg-accent-soft',
      )}
    >
      <span
        className={cn(
          'mt-px flex h-6 w-6 flex-none items-center justify-center rounded-full border-[1.5px] bg-card text-xs font-semibold tabular-nums text-text-2',
          current
            ? 'border-accent bg-accent text-white'
            : step.state === 'done'
              ? 'border-success bg-success text-white'
              : step.state === 'waiting'
                ? 'border-warning bg-warning-soft text-warning-text'
                : step.state === 'needs_fix'
                  ? 'border-danger bg-danger-soft text-danger-text'
                  : 'border-border-strong',
          step.state === 'skipped' && !current && 'border-dashed text-text-3',
        )}
      >
        {current ? (
          n
        ) : step.state === 'done' ? (
          <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
        ) : step.state === 'waiting' ? (
          <Clock className="h-3.5 w-3.5" strokeWidth={2} />
        ) : step.state === 'needs_fix' ? (
          <AlertCircle className="h-3.5 w-3.5" strokeWidth={2} />
        ) : (
          n
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            'font-medium',
            current && 'text-accent-text',
            finished && !current && 'text-text-2',
          )}
        >
          {stepTitle(step.key)}
        </span>
        <span className="text-[12.5px] text-text-3">{railLine(step, status.answers)}</span>
      </span>
    </Link>
  );
}
