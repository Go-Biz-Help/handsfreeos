'use client';
import {
  pageProblems,
  pageToResume,
  type AnswerProblem,
  type AnswerSheet,
  type FillContext,
  type FormDefinition,
  type FormState,
  type VisiblePage,
} from '@hfos/core';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export interface FormSteps {
  /** One page per screen (the form's `onePageAtATime`, and more than one page showing). */
  readonly stepped: boolean;
  /** The pages on screen now: the current one when stepped, else all of them. */
  readonly shown: readonly VisiblePage[];
  readonly index: number;
  readonly count: number;
  /** The last page, where the send button is. */
  readonly isLast: boolean;
  /** The page on screen when stepped; null when every page shows at once. */
  readonly page: VisiblePage | null;
  /** Move on when this page will do; otherwise hand back what's wrong with it. */
  next(): AnswerProblem[];
  /** What's wrong with the page on screen, without moving. */
  problemsHere(): AnswerProblem[];
  /** On to the next page, without checking (the caller already has). */
  forward(): void;
  back(): void;
  /** Show the page a question is on, for a problem found at the end. */
  showQuestion(questionId: string): void;
  /** Back to the first page, for trying the preview again. */
  restart(): void;
}

/**
 * Where somebody is on a form shown one page at a time. The page they're on is kept by its id, so a page
 * appearing or hiding behind them (its own rule) doesn't move them. A sheet picked up again starts where they
 * left off (core's `pageToResume`).
 */
export function useFormSteps(
  definition: FormDefinition,
  state: FormState,
  resumed: AnswerSheet | null = null,
  fill: FillContext = {},
): FormSteps {
  const stepped = definition.settings.onePageAtATime && state.pages.length > 1;
  const [current, setCurrent] = useState<string | null>(() =>
    resumed ? pageToResume(definition, resumed, fill) : null,
  );
  const found = state.pages.findIndex((p) => p.page.id === current);
  const index = found < 0 ? 0 : found;
  const count = state.pages.length;

  const go = (pageId: string | undefined) => {
    if (!pageId) return;
    setCurrent(pageId);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const problemsHere = () => {
    const page = state.pages[index];
    return page ? pageProblems(definition, state.answers, page.page.id, fill) : [];
  };
  const forward = () => go(state.pages[index + 1]?.page.id);

  return {
    stepped,
    shown: stepped ? state.pages.slice(index, index + 1) : state.pages,
    index,
    count,
    isLast: !stepped || index >= count - 1,
    page: stepped ? (state.pages[index] ?? null) : null,
    next() {
      const problems = problemsHere();
      if (!problems.length) forward();
      return problems;
    },
    problemsHere,
    forward,
    back() {
      go(state.pages[index - 1]?.page.id);
    },
    showQuestion(questionId) {
      go(state.pages.find((p) => p.questions.some((q) => q.id === questionId))?.page.id);
    },
    restart() {
      setCurrent(null);
    },
  };
}

/** "Step 2 of 5" over a bar, for a form shown one page at a time. */
export function StepProgress({ steps }: { steps: FormSteps }) {
  return (
    <div className="mt-5" data-testid="form-steps">
      <p className="text-[12px] text-text-3">
        Step {steps.index + 1} of {steps.count}
      </p>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-card-2">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${Math.round(((steps.index + 1) / steps.count) * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** Back and Next, under a page that isn't the last. */
export function StepButtons({
  steps,
  onNext,
  disabled = false,
}: {
  steps: FormSteps;
  onNext: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-6 flex items-center gap-2">
      {steps.index > 0 ? (
        <Button variant="secondary" onClick={steps.back} data-testid="form-back">
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Back
        </Button>
      ) : null}
      <Button className="flex-1" onClick={onNext} disabled={disabled} data-testid="form-next">
        Next
      </Button>
    </div>
  );
}
