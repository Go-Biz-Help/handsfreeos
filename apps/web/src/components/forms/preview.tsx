'use client';
import {
  answerProblem,
  fillFormWords,
  firstNameFor,
  formState,
  money,
  pickResult,
  type AnswerSheet,
  type AnswerValue,
  type FormDefinition,
} from '@hfos/core';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { QuestionField } from './question-field';
import { StepButtons, StepProgress, useFormSteps } from './steps';

/**
 * The form as the customer sees it, running core's own engine in the browser — the same code the public
 * page and the server run. So a question that hides itself here hides itself there, and an answer this
 * refuses is an answer the server refuses.
 *
 * Nothing here is sent anywhere: it is a rehearsal, and Submit shows the result they would land on.
 */
export function FormPreview({
  definition: raw,
  className,
}: {
  definition: FormDefinition;
  className?: string;
}) {
  const [answers, setAnswers] = useState<AnswerSheet>({});
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState(false);
  // Their name in the words, as they'd see it once they've typed it.
  const definition = fillFormWords(raw, { firstName: firstNameFor(raw, answers, null) });
  const state = formState(definition, answers);
  const steps = useFormSteps(definition, state);
  const set = (questionId: string, value: AnswerValue) =>
    setAnswers((a) => ({ ...a, [questionId]: value }));

  if (sent) {
    const result = pickResult(definition, state.answers);
    return (
      <Card className={cn('p-6 text-center', className)} data-testid="preview-result">
        <h2 className="text-[17px] font-medium text-text">{result.headline}</h2>
        {result.body ? <p className="mt-2 text-[13.5px] text-text-2">{result.body}</p> : null}
        {definition.scoring.enabled && definition.scoring.showScore ? (
          <p className="mt-3 text-[13px] text-text-3">
            {state.score.correct} of {state.score.graded} right · {state.score.percent}%
            {state.score.passed === null ? '' : state.score.passed ? ' · passed' : ' · not passed'}
          </p>
        ) : null}
        <Button
          variant="secondary"
          className="mt-5"
          onClick={() => {
            setAnswers({});
            setTried(false);
            setSent(false);
            steps.restart();
          }}
        >
          Try it again
        </Button>
      </Card>
    );
  }

  return (
    <Card className={cn('p-5 sm:p-6', className)} data-testid="form-preview">
      <h2 className="text-[17px] font-medium text-text">{definition.title}</h2>
      {definition.intro ? (
        <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] text-text-2">{definition.intro}</p>
      ) : null}
      {steps.stepped && definition.settings.showProgress ? (
        <StepProgress steps={steps} />
      ) : !steps.stepped && definition.settings.showProgress && state.questions.length > 1 ? (
        <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-card-2">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${Math.round(state.progress * 100)}%` }}
          />
        </div>
      ) : null}

      <div className="mt-5 space-y-5">
        {steps.shown.map((page) => (
          <section key={page.page.id} className="space-y-5">
            {page.page.title ? (
              <h3 className="text-[14px] font-medium text-text-2">{page.page.title}</h3>
            ) : null}
            {page.questions.map((question) => {
              const value = state.answers[question.id] ?? null;
              return (
                <QuestionField
                  key={question.id}
                  question={question}
                  value={value}
                  problem={tried ? answerProblem(question, value) : null}
                  onChange={(v) => set(question.id, v)}
                />
              );
            })}
          </section>
        ))}
      </div>

      {!steps.isLast ? (
        <StepButtons steps={steps} onNext={() => setTried(steps.next().length > 0)} />
      ) : null}

      {steps.isLast && definition.calculations.length ? (
        <div className="mt-5 space-y-1 rounded-card bg-card-2 p-3">
          {definition.calculations.map((calculation) => (
            <p key={calculation.id} className="flex justify-between text-[13px] text-text-2">
              <span>{calculation.name}</span>
              <span className="font-medium text-text">
                {calculation.format === 'money'
                  ? money(Math.round((state.calculations[calculation.id] ?? 0) * 100))
                  : calculation.format === 'percent'
                    ? `${state.calculations[calculation.id] ?? 0}%`
                    : (state.calculations[calculation.id] ?? 0)}
              </span>
            </p>
          ))}
        </div>
      ) : null}

      {steps.isLast ? (
        <div className="mt-6 flex items-center gap-2">
          {steps.stepped && steps.index > 0 ? (
            <Button variant="secondary" onClick={steps.back}>
              Back
            </Button>
          ) : null}
          <Button
            className="flex-1"
            onClick={() => {
              setTried(true);
              const problems = state.questions.filter(
                (q) => answerProblem(q, state.answers[q.id] ?? null) !== null,
              );
              if (problems.length) steps.showQuestion(problems[0]!.id);
              else setSent(true);
            }}
            data-testid="preview-submit"
          >
            {definition.settings.submitLabel}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
