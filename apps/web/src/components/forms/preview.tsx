'use client';
import {
  answerProblem,
  formState,
  money,
  pickResult,
  type AnswerSheet,
  type AnswerValue,
  type FormDefinition,
  type Question,
} from '@hfos/core';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * The form as the customer sees it, running core's own engine in the browser — the same code the public
 * page and the server run. So a question that hides itself here hides itself there, and an answer this
 * refuses is an answer the server refuses.
 *
 * Nothing here is sent anywhere: it is a rehearsal, and Submit shows the result they would land on.
 */
export function FormPreview({
  definition,
  className,
}: {
  definition: FormDefinition;
  className?: string;
}) {
  const [answers, setAnswers] = useState<AnswerSheet>({});
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState(false);
  const state = formState(definition, answers);
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
      {definition.settings.showProgress && state.questions.length > 1 ? (
        <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-card-2">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${Math.round(state.progress * 100)}%` }}
          />
        </div>
      ) : null}

      <div className="mt-5 space-y-5">
        {state.pages.map((page) => (
          <section key={page.page.id} className="space-y-5">
            {page.page.title ? (
              <h3 className="text-[14px] font-medium text-text-2">{page.page.title}</h3>
            ) : null}
            {page.questions.map((question) => {
              const value = state.answers[question.id] ?? null;
              const problem = tried ? answerProblem(question, value) : null;
              return (
                <div key={question.id}>
                  {question.type === 'content' ? (
                    <p className="whitespace-pre-wrap text-[13.5px] text-text-2">
                      {String((question.config as { body: string }).body)}
                    </p>
                  ) : (
                    <>
                      <label
                        className="mb-1.5 block text-[13.5px] font-medium text-text"
                        htmlFor={`preview-${question.id}`}
                      >
                        {question.title}
                        {question.required ? <span className="ml-1 text-danger-text">*</span> : null}
                      </label>
                      {question.help ? (
                        <p className="mb-1.5 text-[12.5px] text-text-3">{question.help}</p>
                      ) : null}
                      <QuestionInputField
                        question={question}
                        value={value}
                        onChange={(v) => set(question.id, v)}
                      />
                      {problem ? (
                        <p role="alert" className="mt-1.5 text-[12.5px] text-danger-text">
                          {problem}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>

      {definition.calculations.length ? (
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

      <Button
        className="mt-6 w-full"
        onClick={() => {
          setTried(true);
          const problems = state.questions.filter(
            (q) => answerProblem(q, state.answers[q.id] ?? null) !== null,
          );
          if (!problems.length) setSent(true);
        }}
        data-testid="preview-submit"
      >
        {definition.settings.submitLabel}
      </Button>
    </Card>
  );
}

function QuestionInputField({
  question,
  value,
  onChange,
}: {
  question: Question;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
}) {
  const config = question.config as Record<string, unknown>;
  const id = `preview-${question.id}`;
  switch (question.type) {
    case 'long_text':
      return (
        <Textarea
          id={id}
          rows={3}
          value={typeof value === 'string' ? value : ''}
          placeholder={String(config.placeholder ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'choice': {
      const choices = (config.choices ?? []) as { id: string; label: string }[];
      return (
        <div className="space-y-1.5">
          {choices.map((choice) => (
            <label
              key={choice.id}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-control border px-3 py-2 text-[13.5px]',
                value === choice.id ? 'border-accent bg-accent/5 text-text' : 'border-border text-text-2',
              )}
            >
              <input
                type="radio"
                name={id}
                className="accent-accent"
                checked={value === choice.id}
                onChange={() => onChange(choice.id)}
              />
              {choice.label}
            </label>
          ))}
        </div>
      );
    }
    case 'checkboxes': {
      const choices = (config.choices ?? []) as { id: string; label: string }[];
      const picked = Array.isArray(value) ? value.map(String) : [];
      return (
        <div className="space-y-1.5">
          {choices.map((choice) => (
            <Checkbox
              key={choice.id}
              className="rounded-control border border-border px-3 py-2 text-[13.5px] text-text-2"
              label={choice.label}
              checked={picked.includes(choice.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...picked, choice.id] : picked.filter((p) => p !== choice.id),
                )
              }
            />
          ))}
        </div>
      );
    }
    case 'yes_no':
      return (
        <div className="flex gap-2">
          {(['yes', 'no'] as const).map((answer) => (
            <Button
              key={answer}
              type="button"
              variant={value === answer ? 'primary' : 'secondary'}
              onClick={() => onChange(answer)}
            >
              {String(config[answer === 'yes' ? 'yesLabel' : 'noLabel'] ?? (answer === 'yes' ? 'Yes' : 'No'))}
            </Button>
          ))}
        </div>
      );
    case 'rating':
    case 'scale': {
      const min = question.type === 'rating' ? 1 : Number(config.min ?? 1);
      const max = Number(config.max ?? 5);
      const numbers = Array.from({ length: max - min + 1 }, (_, i) => min + i);
      return (
        <div className="flex flex-wrap gap-1.5">
          {numbers.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              className={cn(
                'h-9 w-9 rounded-control border text-[13px]',
                value === n ? 'border-accent bg-accent text-white' : 'border-border text-text-2',
              )}
            >
              {n}
            </button>
          ))}
        </div>
      );
    }
    case 'number':
    case 'money':
      return (
        <Input
          id={id}
          type="number"
          value={typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'date':
      return (
        <Input
          id={id}
          type="date"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'time':
      return (
        <Input
          id={id}
          type="time"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'address': {
      const address = (value ?? {}) as Record<string, string>;
      const part = (key: string, label: string) => (
        <Input
          key={key}
          aria-label={label}
          placeholder={label}
          value={address[key] ?? ''}
          onChange={(e) => onChange({ ...address, [key]: e.target.value } as never)}
        />
      );
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {config.detail === 'full' ? part('line1', 'Street') : null}
          {part('city', 'Town')}
          {part('state', 'State')}
          {part('postalCode', 'Postcode')}
        </div>
      );
    }
    case 'signature':
      return (
        <div>
          <p className="mb-2 whitespace-pre-wrap rounded-card bg-card-2 p-3 text-[12.5px] text-text-2">
            {String(config.statement ?? '')}
          </p>
          <Input
            id={id}
            placeholder="Type your name"
            value={
              value && typeof value === 'object' && 'name' in value
                ? String((value as { name: string }).name)
                : ''
            }
            onChange={(e) =>
              onChange({ name: e.target.value, signedAt: new Date().toISOString() } as never)
            }
          />
        </div>
      );
    case 'file':
      return (
        <p className="rounded-card border border-dashed border-border px-3 py-4 text-center text-[12.5px] text-text-3">
          They can attach up to {String(config.maxFiles ?? 3)} files here.
        </p>
      );
    case 'payment':
      return (
        <p className="rounded-card border border-dashed border-border px-3 py-4 text-center text-[12.5px] text-text-3">
          Card details, for {String(config.description ?? 'the payment')}.
        </p>
      );
    default:
      return (
        <Input
          id={id}
          type={question.type === 'email' ? 'email' : question.type === 'phone' ? 'tel' : 'text'}
          value={typeof value === 'string' ? value : ''}
          placeholder={String(config.placeholder ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
