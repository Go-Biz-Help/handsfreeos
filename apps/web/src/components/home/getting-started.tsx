'use client';
import {
  canActOnStep,
  GUIDE_WORDS,
  isWizardStep,
  ONBOARDING_WORDS,
  progressWords,
  stepTitle,
  stepWords,
  TOUR_WORDS,
} from '@hfos/core';
import { AlertCircle, Check, ChevronDown, ChevronUp, Clock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { OnboardingStatus, OnboardingStep } from '@/lib/api/types';
import { publicEnv } from '@/lib/env';
import { setupHref } from '@/lib/setup';
import { cn } from '@/lib/utils';
import { useAssistant } from '@/components/assistant/assistant-provider';
import { startTour } from '@/components/onboarding/tour';
import { PhoneAppDialog } from './phone-app-dialog';

/**
 * Getting started on Home (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, board 6 in design/onboarding).
 *
 * Owners and admins see the business's steps in two groups, The basics and When you're ready; a teammate sees
 * their own short list. Each row says where it stands and has one button, and a step still to do can be skipped.
 * It shows until the person hides it (Get help brings it back) or finishes it: the moment the last step is done or
 * skipped, it says "You're set up" once, and then it's gone for good.
 *
 * `compact` is for a business already running (Home is its Action Center): the next step only, with the rest a
 * press away, so the list of what needs attention isn't pushed down the page.
 */
export function GettingStarted({
  workspaceId,
  status,
  permissions,
  compact = false,
}: {
  workspaceId: string;
  status: OnboardingStatus;
  permissions: readonly string[];
  compact?: boolean;
}) {
  if (status.complete && !status.view.finishedAt)
    return <SetUp workspaceId={workspaceId} status={status} />;
  if (!status.view.show) return null;
  return (
    <Steps workspaceId={workspaceId} status={status} permissions={permissions} compact={compact} />
  );
}

function Steps({
  workspaceId,
  status,
  permissions,
  compact,
}: {
  workspaceId: string;
  status: OnboardingStatus;
  permissions: readonly string[];
  compact: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!compact);
  const [phone, setPhone] = useState<null | 'app' | 'notifications'>(null);
  const business = status.audience === 'business';
  const shortcut = useAssistant().shortcut?.label ?? null;

  const act = async (key: string, fn: () => Promise<void>, after?: () => void) => {
    setBusy(key);
    try {
      await fn();
      router.refresh();
      after?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const skip = (step: OnboardingStep, skipped: boolean) =>
    act(step.key, async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/onboarding.skip', {
          body: { workspaceId, step: step.key, skipped },
        }),
      );
    });
  const setHidden = (hidden: boolean): Promise<void> =>
    act(
      'hide',
      async () => {
        unwrap(
          await apiBrowser().POST('/v1/commands/onboarding.set_view', {
            body: { workspaceId, hidden },
          }),
        );
      },
      hidden
        ? () =>
            toast(ONBOARDING_WORDS.hidden, {
              action: { label: GUIDE_WORDS.undo, onClick: () => void setHidden(false) },
            })
        : undefined,
    );

  const next = status.steps.find((s) => s.key === status.next) ?? null;
  const row = (step: OnboardingStep) => (
    <StepRow
      key={step.key}
      workspaceId={workspaceId}
      step={step}
      status={status}
      isNext={step.key === status.next}
      primary={step.key === status.next && !compact}
      canAct={canActOnStep(step.key, permissions)}
      busy={busy === step.key}
      onSkip={(skipped) => void skip(step, skipped)}
      onPhone={() => setPhone(step.key === 'notifications' ? 'notifications' : 'app')}
    />
  );
  const group = (key: 'basics' | 'later', label: string) => {
    const steps = status.steps.filter((s) => s.group === key);
    if (!steps.length) return null;
    const counted = steps.filter((s) => s.state !== 'skipped');
    const done = counted.filter((s) => s.state === 'done' || s.state === 'waiting').length;
    return (
      <div className="mt-2 first:mt-0">
        <div className="flex items-center justify-between px-2.5 pb-1.5 pt-2">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {label}
          </span>
          <span className="text-xs tabular-nums text-text-3">
            {done} of {counted.length}
          </span>
        </div>
        <ul className="flex flex-col">{steps.map(row)}</ul>
      </div>
    );
  };

  return (
    <Card className="p-5 pb-3" id="getting-started" data-testid="getting-started">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">
            {business ? GUIDE_WORDS.title : GUIDE_WORDS.teammateTitle}
          </h2>
          <Badge variant="gray" className="tabular-nums" data-testid="getting-started-count">
            {progressWords(status)}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          loading={busy === 'hide'}
          onClick={() => void setHidden(true)}
          data-testid="getting-started-hide"
        >
          {GUIDE_WORDS.hide}
        </Button>
      </div>
      {business ? null : (
        <p className="mt-1 px-1 text-[13px] text-text-2">{GUIDE_WORDS.teammateIntro}</p>
      )}
      {business && !status.answers ? (
        <Link
          href={`/onboarding/${workspaceId}/questions?from=guide`}
          className="mt-1 inline-block px-1 text-[13px] font-medium text-accent-text hover:underline"
          data-testid="getting-started-questions"
        >
          {GUIDE_WORDS.answerQuestions}
        </Link>
      ) : null}
      <div
        className="mx-1 mb-3 mt-3 h-1.5 overflow-hidden rounded-full bg-card-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={status.total}
        aria-valuenow={status.done}
        aria-label={progressWords(status)}
      >
        <div
          className="h-full origin-left rounded-full bg-accent transition-transform"
          style={{ transform: `scaleX(${status.total ? status.done / status.total : 1})` }}
        />
      </div>
      {!expanded ? (
        next ? (
          <ul className="flex flex-col">{row(next)}</ul>
        ) : null
      ) : business ? (
        <>
          {group('basics', GUIDE_WORDS.basics)}
          {group('later', GUIDE_WORDS.later)}
        </>
      ) : (
        <ul className="flex flex-col">{status.steps.map(row)}</ul>
      )}
      {status.view.tourDoneAt ? null : (
        <p className="mt-2 px-1 text-xs text-text-3" data-testid="getting-started-tour">
          {TOUR_WORDS.offer}{' '}
          <button
            type="button"
            onClick={startTour}
            className="font-medium text-accent-text hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          >
            {TOUR_WORDS.take}
          </button>
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1">
        {business ? (
          <p className="text-xs text-text-3">{GUIDE_WORDS.assistantHint(shortcut)}</p>
        ) : (
          <span />
        )}
        {compact ? (
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? (
              <ChevronUp className="h-4 w-4" strokeWidth={1.75} />
            ) : (
              <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
            )}
            {expanded ? GUIDE_WORDS.showFewer : GUIDE_WORDS.showAll(status.steps.length)}
          </Button>
        ) : null}
      </div>
      <PhoneAppDialog
        open={phone !== null}
        onOpenChange={(open) => setPhone(open ? phone : null)}
        notifications={phone === 'notifications'}
      />
    </Card>
  );
}

/**
 * Where a step's button goes: the setup wizard's screen for a business step that has one, else the page that does
 * it. The phone app and its notifications open the app's links instead.
 */
function stepHref(workspaceId: string, step: OnboardingStep) {
  const key = step.key;
  if (isWizardStep(key)) return setupHref(workspaceId, key);
  const base = `/app/w/${workspaceId}`;
  switch (key) {
    case 'team':
      return `${base}/members?invite=1`;
    case 'email_chat':
      return step.note.phase === 'mailbox'
        ? `${base}/settings/website-chat`
        : `${base}/settings/email`;
    case 'sign_in':
      return `${base}/settings#${publicEnv.passkeysEnabled ? 'passkeys' : 'google'}`;
    case 'my_calendar':
      return `${base}/settings/my-calendar`;
    case 'app':
    case 'notifications':
      return null;
  }
}

/** On a phone every tap target is 44 px (the design system's size-control-lg). */
const PHONE_BUTTON = 'max-md:h-11 max-md:px-4 max-md:text-[15px]';

function StateMark({ state }: { state: OnboardingStep['state'] }) {
  const base =
    'flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full border-[1.5px]';
  switch (state) {
    case 'done':
      return (
        <span className={cn(base, 'border-success bg-success text-white')} aria-hidden>
          <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
        </span>
      );
    case 'waiting':
      return (
        <span className={cn(base, 'border-warning bg-warning-soft text-warning-text')} aria-hidden>
          <Clock className="h-3 w-3" strokeWidth={2.25} />
        </span>
      );
    case 'needs_fix':
      return (
        <span className={cn(base, 'border-danger bg-danger-soft text-danger-text')} aria-hidden>
          <AlertCircle className="h-3 w-3" strokeWidth={2.25} />
        </span>
      );
    case 'skipped':
      return <span className={cn(base, 'border-dashed border-border-strong')} aria-hidden />;
    case 'todo':
      return <span className={cn(base, 'border-border-strong')} aria-hidden />;
  }
}

function StepRow({
  workspaceId,
  step,
  status,
  isNext,
  primary,
  canAct,
  busy,
  onSkip,
  onPhone,
}: {
  workspaceId: string;
  step: OnboardingStep;
  status: OnboardingStatus;
  isNext: boolean;
  /** The page's one primary button: the next step's, unless the Action Center's own buttons are the page's. */
  primary: boolean;
  canAct: boolean;
  busy: boolean;
  onSkip: (skipped: boolean) => void;
  onPhone: () => void;
}) {
  const words = stepWords(step, status.answers);
  const open = step.state === 'todo' || step.state === 'needs_fix';
  const href = stepHref(workspaceId, step);
  const action =
    canAct && words.action && (open || step.state === 'skipped') ? (
      href ? (
        <ButtonLink
          href={href}
          size="sm"
          variant={primary ? 'primary' : 'secondary'}
          className={PHONE_BUTTON}
        >
          {words.action}
        </ButtonLink>
      ) : (
        <Button
          size="sm"
          variant={primary ? 'primary' : 'secondary'}
          onClick={onPhone}
          className={PHONE_BUTTON}
        >
          {words.action}
        </Button>
      )
    ) : null;
  return (
    <li
      data-testid={`getting-started-${step.key}`}
      data-state={step.state}
      className={cn(
        'flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-border px-2.5 py-3 first:border-t-0 sm:flex-nowrap',
        isNext && 'rounded-menu border-transparent bg-accent-soft [&+li]:border-transparent',
      )}
    >
      <StateMark state={step.state} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            'font-medium',
            step.state === 'done' && 'text-text-2 line-through',
            step.state === 'skipped' && 'text-text-3',
          )}
        >
          {words.title}
        </span>
        <span className="text-[13px] text-text-3">{words.detail}</span>
      </span>
      <span className="flex w-full flex-none items-center justify-end gap-2 pl-9 sm:w-auto sm:pl-0">
        {words.badge && step.state !== 'skipped' ? (
          <Badge variant={step.state === 'needs_fix' ? 'danger' : 'pending'}>{words.badge}</Badge>
        ) : null}
        {step.state === 'skipped' ? (
          <>
            <Badge variant="gray">{words.badge}</Badge>
            <Button
              variant="ghost"
              size="sm"
              loading={busy}
              onClick={() => onSkip(false)}
              className={PHONE_BUTTON}
            >
              {GUIDE_WORDS.undo}
            </Button>
          </>
        ) : open ? (
          <Button
            variant="ghost"
            size="sm"
            loading={busy}
            onClick={() => onSkip(true)}
            className={PHONE_BUTTON}
          >
            {GUIDE_WORDS.skip}
          </Button>
        ) : null}
        {action}
      </span>
    </li>
  );
}

/**
 * The last step done or skipped: "You're set up", once. A business that was set up before the guide existed (no
 * answers, nothing skipped) never needed it, so it finishes without a word. A teammate's list has no answers of
 * its own, so it always says it.
 */
function SetUp({ workspaceId, status }: { workspaceId: string; status: OnboardingStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const quiet = status.audience === 'business' && !status.answers && status.skipped === 0;
  const sent = useRef(false);
  const finish = () =>
    apiBrowser().POST('/v1/commands/onboarding.finish', { body: { workspaceId } }).then(unwrap);
  useEffect(() => {
    if (!quiet || sent.current) return;
    sent.current = true;
    void apiBrowser()
      .POST('/v1/commands/onboarding.finish', { body: { workspaceId } })
      .then(() => router.refresh())
      .catch(() => undefined);
  }, [quiet, workspaceId, router]);
  if (quiet) return null;
  const skipped = status.steps
    .filter((s) => s.state === 'skipped')
    .map((s) => stepTitle(s.key, s.note.name));
  return (
    <Card className="flex items-start gap-4 p-5" data-testid="getting-started-done">
      <span className="flex h-10 w-10 flex-none items-center justify-center rounded-menu bg-success-soft text-success-text">
        <Check className="h-5 w-5" strokeWidth={2} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{GUIDE_WORDS.finishedTitle}</h2>
        <p className="text-[13px] text-text-2">{GUIDE_WORDS.finishedDetail(skipped)}</p>
        <div className="mt-2">
          <Button
            size="sm"
            loading={busy}
            onClick={() => {
              setBusy(true);
              finish()
                .then(() => router.refresh())
                .catch((e: unknown) => toast.error(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            {GUIDE_WORDS.finishedDone}
          </Button>
        </div>
      </div>
    </Card>
  );
}
