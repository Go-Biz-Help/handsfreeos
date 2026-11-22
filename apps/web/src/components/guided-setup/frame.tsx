'use client';
/**
 * The guided setups' frame (the owner, 22 Nov 2026: every setting set up one question at a time, the way the email
 * setup is): a page of its own outside the sidebar (the onboarding setup's SetupPage), with "Saved" beside Finish
 * later, one card holding the question beside the list of answers so far, the picks as tiles with the best one
 * marked, and the answers saved as they are given (guided_setup.save_draft), so someone who leaves comes back to
 * them. The phone number's setup is the first to use it; each setup brings its own questions.
 */
import { GUIDED_SETUP_WORDS as W, type GuidedSetupKey } from '@hfos/core';
import { ArrowLeft, ArrowRight, Check, CircleAlert, PartyPopper } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { SetupPage } from '@/components/onboarding-setup/frame';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FieldError } from '@/components/ui/field';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';

export type SavedState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Keeps a setup's answers as they change: a moment after the last change, and at once when asked (`flush`, before
 * leaving a screen). `answers` null saves nothing (the setup is finished, or not started). A save that fails says so
 * beside Finish later and is tried again with the next change.
 */
export function useGuidedDraft(
  workspaceId: string,
  setup: GuidedSetupKey,
  answers: Record<string, unknown> | null,
  opts: { readonly hadDraft: boolean },
) {
  const [state, setState] = useState<SavedState>(opts.hadDraft ? 'saved' : 'idle');
  const text = answers ? JSON.stringify(answers) : null;
  const saved = useRef<string | null>(opts.hadDraft ? text : null);
  const latest = useRef<string | null>(text);
  latest.current = text;
  const running = useRef<Promise<void>>(Promise.resolve());
  const stopped = useRef(false);
  /** Counts the saves that went through, so what is waiting is looked at again after each. */
  const [kept, setKept] = useState(0);

  const save = useCallback(async () => {
    // One at a time, each sending the newest answers: a slow save never lands on top of a newer one.
    const job = running.current.then(async () => {
      const body = latest.current;
      if (stopped.current || body === null || body === saved.current) return;
      setState('saving');
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/guided_setup.save_draft', {
            body: { workspaceId, setup, answers: JSON.parse(body) as Record<string, unknown> },
            // Still sent when the page is on its way out (a reload, the tab closing).
            keepalive: true,
          }),
        );
        saved.current = body;
        setState('saved');
        setKept((n) => n + 1);
      } catch {
        setState('error');
      }
    });
    running.current = job;
    return job;
  }, [workspaceId, setup]);

  useEffect(() => {
    if (text === null) return;
    if (text === saved.current) {
      // Just kept, or changed back to what is kept: nothing to send.
      setState((s) => (s === 'saving' ? 'saved' : s));
      return;
    }
    // "Saved" only once it is: the tick dims the moment an answer changes, until that answer is kept.
    if (!stopped.current) setState('saving');
    const timer = setTimeout(() => void save(), 700);
    return () => clearTimeout(timer);
  }, [text, save, kept]);
  // Reloading, closing the tab or going back presses no button: what was just answered is sent at once.
  useEffect(() => {
    const now = () => void save();
    const hidden = () => {
      if (document.visibilityState === 'hidden') now();
    };
    window.addEventListener('pagehide', now);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', now);
      document.removeEventListener('visibilitychange', hidden);
      now();
    };
  }, [save]);

  /** Forget the saved answers (finished, or Start over). Nothing more is saved until `resume`. */
  const clear = useCallback(async () => {
    stopped.current = true;
    await running.current;
    saved.current = null;
    setState('idle');
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/guided_setup.clear_draft', {
          body: { workspaceId, setup },
        }),
      );
    } catch {
      // Left behind, it is only an old draft: the setup ignores one that no longer fits.
    }
  }, [workspaceId, setup]);
  const resume = useCallback(() => {
    stopped.current = false;
  }, []);

  return { state, flush: save, clear, resume };
}

/** The green tick and "Saved" beside Finish later. */
export function SavedMark({ state }: { state: SavedState }) {
  if (state === 'idle') return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[13px]',
        state === 'error' ? 'text-warning-text' : 'text-text-2',
      )}
      role="status"
      title={state === 'error' ? W.notSavedHint : undefined}
      data-testid="guided-saved"
      data-state={state}
    >
      {state === 'error' ? (
        <CircleAlert className="h-3.5 w-3.5" strokeWidth={2} />
      ) : (
        <Check
          className={cn('h-3.5 w-3.5 text-success', state === 'saving' && 'opacity-40')}
          strokeWidth={2.5}
        />
      )}
      {state === 'error' ? W.notSaved : W.saved}
    </span>
  );
}

/** The page: the onboarding setup's own, with this setup's line at the top and Saved beside Finish later. */
export function GuidedPage({
  business,
  email,
  settingUp,
  saved,
  onLeave,
  leaveLabel = W.finishLater,
  leaving = false,
  children,
}: {
  business: { readonly name: string; readonly home: string };
  email: string;
  /** "Setting up the number for Bella’s Salon". */
  settingUp: string;
  saved: SavedState;
  onLeave: () => void;
  /** "Close" once there is nothing left to finish. */
  leaveLabel?: string;
  leaving?: boolean;
  children: ReactNode;
}) {
  return (
    <SetupPage
      business={business}
      email={email}
      settingUp={settingUp}
      finishLater={
        <span className="flex items-center gap-2">
          <SavedMark state={saved} />
          <Button variant="ghost" onClick={onLeave} loading={leaving} data-testid="guided-leave">
            {leaveLabel}
          </Button>
        </span>
      }
    >
      {children}
    </SetupPage>
  );
}

/** One line of the list beside the question: a question with what was answered. */
export interface GuidedStep {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
  readonly state: 'done' | 'now' | 'todo';
  /** The part of the setup it belongs to ("Your business"), for a long setup: named above its first question. */
  readonly group?: string;
}

export function GuidedCard({
  screen,
  kicker,
  title,
  hint,
  banner,
  footer,
  steps,
  stepsTitle,
  aside,
  testId = 'guided-setup',
  children,
}: {
  screen: string;
  /** "Question 3 of 7 · Your business number". */
  kicker: string;
  title: string;
  hint?: string;
  /** Above the question: "Welcome back", or the number that was taken. */
  banner?: ReactNode;
  footer: ReactNode;
  /** The answers so far, beside the question. */
  steps?: readonly GuidedStep[];
  stepsTitle?: string;
  /** Something else beside the question in place of the answers so far (Check it over's "What happens next"). */
  aside?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const side = aside ?? (steps ? <StepList title={stepsTitle ?? ''} steps={steps} /> : null);
  return (
    <Card
      className={cn(
        'grid w-full grid-cols-1 overflow-hidden rounded-dialog',
        side && 'md:grid-cols-[minmax(0,1fr)_300px]',
      )}
      data-testid={testId}
      data-screen={screen}
    >
      <div className="flex min-w-0 scroll-mt-20 flex-col gap-5 p-5 sm:p-8">
        {banner}
        <div className="flex flex-col gap-1.5">
          <div
            className="text-xs font-medium uppercase tracking-[0.04em] text-text-3"
            data-testid={`${testId}-kicker`}
          >
            {kicker}
          </div>
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
          {hint ? <p className="text-[15px] leading-normal text-text-2">{hint}</p> : null}
        </div>
        {children}
        {footer}
      </div>
      {side ? (
        <aside
          className="flex flex-col gap-3 border-t border-border bg-card-2 p-5 md:border-l md:border-t-0 md:px-[22px] md:py-8"
          aria-label={stepsTitle}
          data-testid={`${testId}-so-far`}
        >
          {side}
        </aside>
      ) : null}
    </Card>
  );
}

function StepList({ title, steps }: { title: string; steps: readonly GuidedStep[] }) {
  return (
    <>
      <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {title}
      </div>
      <ol className="flex flex-col gap-1">
        {steps.flatMap((s, i) => [
          s.group && s.group !== steps[i - 1]?.group ? (
            <li
              key={`group-${s.group}`}
              className={cn('px-2.5 pb-0.5 text-xs font-semibold text-text-3', i > 0 && 'pt-2')}
              data-testid="guided-step-group"
            >
              {s.group}
            </li>
          ) : null,
          <li
            key={s.key}
            className={cn(
              'flex items-start gap-2.5 rounded-menu px-2.5 py-2',
              s.state === 'now' && 'bg-card shadow-1',
            )}
            aria-current={s.state === 'now' ? 'step' : undefined}
            data-testid={`guided-step-${s.key}`}
            data-state={s.state}
          >
            <span
              aria-hidden
              className={cn(
                'mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-semibold',
                s.state === 'done'
                  ? 'bg-success-soft text-success-text'
                  : s.state === 'now'
                    ? 'bg-accent text-white'
                    : 'border border-border-strong text-text-3',
              )}
            >
              {s.state === 'done' ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
            </span>
            <span className="flex min-w-0 flex-col">
              <span
                className={cn(
                  'text-[13px]',
                  s.state === 'todo' ? 'text-text-3' : 'font-medium text-text',
                )}
              >
                {s.label}
              </span>
              {s.value && s.state !== 'todo' ? (
                <span className="break-words text-[13px] text-text-2">{s.value}</span>
              ) : null}
            </span>
          </li>,
        ])}
      </ol>
    </>
  );
}

/** One pick: a radio tile, with Best on the one most businesses should take, and its own questions when picked. */
export function ChoiceTile({
  selected,
  onSelect,
  title,
  hint,
  best,
  disabled,
  testId,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  hint?: ReactNode;
  best?: string;
  disabled?: boolean;
  testId?: string;
  /** Shown inside the tile while it is picked. */
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-menu border transition-colors',
        selected ? 'border-accent bg-accent-soft' : 'border-border bg-card',
        !selected && !disabled && 'hover:bg-card-2',
        disabled && 'opacity-60',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={onSelect}
        data-testid={testId}
        className="flex w-full items-start gap-3 rounded-menu p-3.5 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed"
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border-[1.5px]',
            selected ? 'border-accent' : 'border-border-strong',
          )}
        >
          {selected ? <span className="h-2.5 w-2.5 rounded-full bg-accent" /> : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 font-semibold">
            {title}
            {best ? <Badge variant="ok">{best}</Badge> : null}
          </span>
          {hint ? <span className="text-[13.5px] leading-snug text-text-2">{hint}</span> : null}
        </span>
      </button>
      {selected && children ? (
        <div className="flex flex-col gap-3 px-3.5 pb-3.5 pl-[44px]">{children}</div>
      ) : null}
    </div>
  );
}

/** The picks of one question, read out as a group. */
export function Choices({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2.5">
      {children}
    </div>
  );
}

/** Back and Next under a question, with what stopped Next above them. */
export function GuidedFooter({
  onBack,
  onNext,
  nextLabel = W.next,
  busy = false,
  error,
  nextIcon = true,
  testId = 'guided',
}: {
  onBack?: (() => void) | undefined;
  onNext: () => void;
  nextLabel?: string;
  busy?: boolean;
  error?: string | null;
  nextIcon?: boolean;
  testId?: string;
}) {
  return (
    <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
      {error ? <FieldError>{error}</FieldError> : null}
      <div className="flex flex-wrap-reverse items-center justify-between gap-3">
        {onBack ? (
          <Button variant="ghost" onClick={onBack} disabled={busy} data-testid={`${testId}-back`}>
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
            {W.back}
          </Button>
        ) : (
          <span />
        )}
        <Button size="lg" onClick={onNext} loading={busy} data-testid={`${testId}-next`}>
          {nextLabel}
          {nextIcon ? <ArrowRight className="h-4 w-4" strokeWidth={1.75} /> : null}
        </Button>
      </div>
    </div>
  );
}

/** "Welcome back, Blake. Your answers from Friday are still here." with Start over. */
export function WelcomeBack({
  line,
  onStartOver,
}: {
  line: string;
  onStartOver: (() => void) | null;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-menu bg-accent-soft px-3.5 py-3 text-[13.5px] text-accent-text"
      role="status"
      data-testid="guided-welcome-back"
    >
      <span className="flex min-w-0 items-start gap-2.5">
        <PartyPopper className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
        <span>{line}</span>
      </span>
      {onStartOver ? (
        <button
          type="button"
          onClick={onStartOver}
          className="font-medium underline-offset-2 hover:underline"
          data-testid="guided-start-over"
        >
          {W.startOver}
        </button>
      ) : null}
    </div>
  );
}

/** A grey note under the picks: what happens either way, or how to find out. */
export function GuidedNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-menu bg-card-2 px-3.5 py-3 text-[13.5px] leading-snug text-text-2">
      {children}
    </div>
  );
}
