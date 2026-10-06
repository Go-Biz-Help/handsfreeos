'use client';
/**
 * The pieces quick setup's screens are made of: big answers to tap, a website box, and the lists people edit
 * (services, top questions, qualifying questions). Every word comes from core's ai-setup/words.ts, which the phone
 * app reads too.
 */
import {
  AI_SETUP_FIELD_WORDS as W,
  AI_SETUP_WORDS,
  asksAboutWhoSomeoneIs,
  type AiSetupService,
  type AiSetupTopQuestion,
  type QualifyingQuestion,
} from '@hfos/core';
import { Check, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { FieldError, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** Errors by path into the answers ("services.0.name"), as the answers' own checks and the API give them. */
export type Problems = Readonly<Record<string, string>>;

/** The first problem at this path or under it. */
export function problemAt(problems: Problems, path: string): string | undefined {
  if (problems[path]) return problems[path];
  const under = Object.keys(problems).find((k) => k.startsWith(`${path}.`));
  return under ? problems[under] : undefined;
}

/** A pick-one row of big answers, as the onboarding questions draw them. */
export function Pills<T extends string>({
  name,
  legend,
  options,
  labels,
  value,
  onChange,
}: {
  name: string;
  legend?: string;
  options: readonly T[];
  labels: Readonly<Record<T, string>>;
  value: T | undefined;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      {legend ? <legend className="mb-2 text-[13px] font-medium">{legend}</legend> : null}
      <div className="flex flex-wrap gap-2" role="radiogroup" data-testid={`ai-setup-${name}`}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={value === o}
            onClick={() => onChange(o)}
            data-testid={`ai-setup-${name}-${o}`}
            className={cn(
              'inline-flex h-10 items-center rounded-full border px-4 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring max-md:h-11',
              value === o
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border-strong bg-card text-text-2 hover:bg-card-2 hover:text-text',
            )}
          >
            {labels[o]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** A big pick-one card with a line under its title. Put a few in a `role="radiogroup"`. */
export function Option({
  on,
  onSelect,
  title,
  description,
  badge,
  testId,
  children,
}: {
  on: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onSelect}
      data-testid={testId}
      className={cn(
        'flex w-full items-start gap-3 rounded-menu border px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        on
          ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
          : 'border-border-strong bg-card hover:bg-card-2',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border-[1.5px]',
          on ? 'border-accent' : 'border-border-strong',
        )}
      >
        {on ? <span className="h-2.5 w-2.5 rounded-full bg-accent" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
          {title}
          {badge}
        </span>
        {description ? <span className="text-[13px] text-text-2">{description}</span> : null}
        {children}
      </span>
    </button>
  );
}

/** A big tick-all-that-fit row. */
export function Tick({
  on,
  onToggle,
  title,
  description,
  testId,
}: {
  on: boolean;
  onToggle: () => void;
  title: ReactNode;
  description?: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onToggle}
      data-testid={testId}
      className={cn(
        'flex w-full items-start gap-3 rounded-menu border px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        on ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card hover:bg-card-2',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border-[1.5px]',
          on ? 'border-accent bg-accent text-white' : 'border-border-strong bg-card',
        )}
      >
        {on ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-medium">{title}</span>
        {description ? (
          <span className="line-clamp-2 text-[13px] text-text-2">{description}</span>
        ) : null}
      </span>
    </button>
  );
}

/** Yes, No, or skipped (no answer). */
export function YesNo({
  question,
  value,
  onChange,
  testId,
  note = null,
}: {
  question: string;
  value: 'yes' | 'no' | undefined;
  onChange: (value: 'yes' | 'no' | undefined) => void;
  testId: string;
  /** A small line under the question: where the answer came from. */
  note?: string | null;
}) {
  const pill = (v: 'yes' | 'no', label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === v}
      onClick={() => onChange(v)}
      data-testid={`${testId}-${v}`}
      className={cn(
        'inline-flex h-9 min-w-[64px] items-center justify-center rounded-full border px-3.5 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring max-md:h-11',
        value === v
          ? 'border-accent bg-accent-soft text-accent-text'
          : 'border-border-strong bg-card text-text-2 hover:bg-card-2 hover:text-text',
      )}
    >
      {label}
    </button>
  );
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border py-3 last:border-b-0"
      data-testid={testId}
      data-answer={value ?? 'skipped'}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px]">{question}</span>
        {note ? (
          <span className="text-[12.5px] text-text-3" data-testid={`${testId}-note`}>
            {note}
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-2" role="radiogroup" aria-label={question}>
        {pill('yes', W.yes)}
        {pill('no', W.no)}
        <button
          type="button"
          onClick={() => onChange(undefined)}
          aria-pressed={value === undefined}
          data-testid={`${testId}-skip`}
          className={cn(
            'h-9 rounded-full px-2.5 text-[13px] text-text-3 hover:text-text max-md:h-11',
            value === undefined && 'font-medium text-text-2 underline underline-offset-4',
          )}
        >
          {AI_SETUP_WORDS.skip}
        </button>
      </span>
    </div>
  );
}

/** The website as people type it, without the https:// the box already shows. */
export const bareSite = (url: string | null) =>
  (url ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

export function WebsiteField({
  value,
  noSite,
  onChange,
  onNoSite,
  hint,
  error,
}: {
  value: string;
  noSite: boolean;
  onChange: (value: string) => void;
  onNoSite: (noSite: boolean) => void;
  hint: string;
  error?: string;
}) {
  return (
    <div>
      <Label htmlFor="ai-setup-website">{W.website}</Label>
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <div
          className={cn(
            'flex h-11 min-w-0 flex-1 items-center overflow-hidden rounded-menu border bg-card focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring max-sm:basis-full',
            error ? 'border-danger' : 'border-border-strong',
            noSite && 'opacity-50',
          )}
        >
          <span className="flex h-full items-center border-r border-border bg-card-2 px-3 text-sm text-text-3">
            https://
          </span>
          <input
            id="ai-setup-website"
            inputMode="url"
            autoComplete="url"
            placeholder="yourbusiness.com"
            value={value}
            disabled={noSite}
            aria-invalid={!!error || undefined}
            aria-describedby="ai-setup-website-note"
            onChange={(e) => onChange(e.target.value)}
            data-testid="ai-setup-website-input"
            className="h-full min-w-0 flex-1 bg-transparent px-3 text-[15px] text-text placeholder:text-placeholder focus:outline-none max-md:text-base"
          />
        </div>
        <Button
          variant="ghost"
          aria-pressed={noSite}
          onClick={() => onNoSite(!noSite)}
          className={cn('h-11', noSite && 'bg-accent-soft text-accent-text')}
          data-testid="ai-setup-no-website"
        >
          {AI_SETUP_WORDS.noWebsite}
        </Button>
      </div>
      {error ? (
        <FieldError id="ai-setup-website-note">{error}</FieldError>
      ) : (
        <Hint>
          <span id="ai-setup-website-note">{hint}</span>
        </Hint>
      )}
    </div>
  );
}

const MAX_SERVICES = 50;

export function ServicesField({
  services,
  onChange,
  problems,
}: {
  services: readonly AiSetupService[];
  onChange: (next: AiSetupService[]) => void;
  problems: Problems;
}) {
  const set = (i: number, patch: Partial<AiSetupService>) =>
    onChange(services.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <fieldset data-testid="ai-setup-services">
      <legend className="mb-2 text-[13px] font-medium">{W.services}</legend>
      <ul className="flex flex-col gap-2">
        {services.map((s, i) => (
          <li key={i} className="flex items-start gap-2" data-testid={`ai-setup-service-${i}`}>
            <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div>
                <Input
                  aria-label={W.serviceName}
                  placeholder={W.serviceName}
                  value={s.name}
                  maxLength={120}
                  invalid={!!problems[`services.${i}.name`]}
                  onChange={(e) => set(i, { name: e.target.value })}
                  data-testid={`ai-setup-service-${i}-name`}
                />
                <FieldError>{problems[`services.${i}.name`]}</FieldError>
              </div>
              <Input
                aria-label={W.serviceDescription}
                placeholder={W.serviceDescription}
                value={s.description}
                maxLength={500}
                onChange={(e) => set(i, { description: e.target.value })}
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={W.removeService}
              onClick={() => onChange(services.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </li>
        ))}
      </ul>
      {services.length < MAX_SERVICES ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => onChange([...services, { name: '', description: '' }])}
          data-testid="ai-setup-add-service"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {W.addService}
        </Button>
      ) : null}
      <FieldError>{problems['services']}</FieldError>
    </fieldset>
  );
}

const MAX_TOP_QUESTIONS = 3;

export function TopQuestionsField({
  value,
  onChange,
  problems,
}: {
  value: readonly AiSetupTopQuestion[];
  onChange: (next: AiSetupTopQuestion[]) => void;
  problems: Problems;
}) {
  const set = (i: number, patch: Partial<AiSetupTopQuestion>) =>
    onChange(value.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  return (
    <fieldset data-testid="ai-setup-top-questions">
      <legend className="text-[13px] font-medium">{AI_SETUP_WORDS.topQuestions}</legend>
      <Hint className="mb-2 mt-0.5">{AI_SETUP_WORDS.topQuestionsHint}</Hint>
      <ul className="flex flex-col gap-3">
        {value.map((q, i) => (
          <li key={i} className="flex items-start gap-2 rounded-menu bg-card-2 p-3">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Input
                aria-label={W.question}
                placeholder={W.question}
                value={q.question}
                maxLength={300}
                invalid={!!problems[`topQuestions.${i}.question`]}
                onChange={(e) => set(i, { question: e.target.value })}
                data-testid={`ai-setup-top-${i}-question`}
              />
              <FieldError>{problems[`topQuestions.${i}.question`]}</FieldError>
              <Textarea
                aria-label={W.answer}
                placeholder={W.answer}
                value={q.answer}
                maxLength={5000}
                className="min-h-[64px]"
                invalid={!!problems[`topQuestions.${i}.answer`]}
                onChange={(e) => set(i, { answer: e.target.value })}
                data-testid={`ai-setup-top-${i}-answer`}
              />
              <FieldError>{problems[`topQuestions.${i}.answer`]}</FieldError>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={W.removeQuestion}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </li>
        ))}
      </ul>
      {value.length < MAX_TOP_QUESTIONS ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => onChange([...value, { question: '', answer: '' }])}
          data-testid="ai-setup-add-top-question"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {W.addQuestion}
        </Button>
      ) : null}
    </fieldset>
  );
}

const MAX_QUALIFY = 10;
/** The kinds quick setup offers; a number or file question from the full settings keeps its kind. */
const SIMPLE_KINDS = ['text', 'choice', 'yes_no'] as const;
type SimpleKind = (typeof SIMPLE_KINDS)[number];
const isSimple = (k: string): k is SimpleKind => (SIMPLE_KINDS as readonly string[]).includes(k);

function newQuestionId(taken: readonly string[]): string {
  let n = taken.length + 1;
  while (taken.includes(`q${n}`)) n++;
  return `q${n}`;
}

/** A question with another kind of answer: choices only for a choice, and a rule-out only where it fits. */
function withKind(q: QualifyingQuestion, kind: SimpleKind): QualifyingQuestion {
  return {
    ...q,
    kind,
    options: kind === 'choice' ? q.options : [],
    notAFitIf: { ...q.notAFitIf, answers: [], below: null, above: null },
  };
}

const choicesOf = (text: string) =>
  text
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

export function QualifyField({
  questions,
  industry,
  onChange,
  problems,
}: {
  questions: readonly QualifyingQuestion[];
  /** The business's industry: a school may ask about the child it teaches. */
  industry: string | null;
  onChange: (next: QualifyingQuestion[]) => void;
  problems: Problems;
}) {
  const set = (i: number, next: QualifyingQuestion) =>
    onChange(questions.map((q, j) => (j === i ? next : q)));
  return (
    <div data-testid="ai-setup-qualify">
      <ol className="flex flex-col gap-3">
        {questions.map((q, i) => {
          const problem = problemAt(problems, `questions.${i}`);
          return (
            <li
              key={q.id}
              className="flex items-start gap-2 rounded-menu border border-border p-3"
              data-testid={`ai-setup-qualify-${i}`}
            >
              <span className="mt-2.5 w-5 flex-none text-center text-[13px] font-semibold tabular-nums text-text-3">
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Input
                  aria-label={`${W.question} ${i + 1}`}
                  value={q.question}
                  maxLength={200}
                  invalid={!!problem}
                  onChange={(e) => set(i, { ...q, question: e.target.value })}
                  data-testid={`ai-setup-qualify-${i}-question`}
                />
                {asksAboutWhoSomeoneIs([q.question, ...q.options].join(' '), industry) ? (
                  <FieldError>{W.qualifyProtected}</FieldError>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] text-text-2">{W.qualifyAnswer}</span>
                  {isSimple(q.kind) ? (
                    <Select
                      selectSize="sm"
                      className="w-auto"
                      aria-label={W.qualifyAnswer}
                      value={q.kind}
                      onChange={(e) => {
                        const kind = e.target.value;
                        if (isSimple(kind)) set(i, withKind(q, kind));
                      }}
                    >
                      {SIMPLE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {W.qualifyKinds[k]}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="text-[13px] font-medium">{q.kind}</span>
                  )}
                </div>
                {q.kind === 'choice' ? (
                  <Input
                    aria-label={W.qualifyChoices}
                    placeholder={W.qualifyChoices}
                    defaultValue={q.options.join(', ')}
                    onBlur={(e) => set(i, { ...q, options: choicesOf(e.target.value) })}
                    data-testid={`ai-setup-qualify-${i}-choices`}
                  />
                ) : null}
                <FieldError>{problem}</FieldError>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={W.removeQuestion}
                onClick={() => onChange(questions.filter((_, j) => j !== i))}
                data-testid={`ai-setup-qualify-${i}-remove`}
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </li>
          );
        })}
      </ol>
      {questions.length < MAX_QUALIFY ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() =>
            onChange([
              ...questions,
              {
                id: newQuestionId(questions.map((q) => q.id)),
                question: '',
                kind: 'text',
                options: [],
                required: true,
                notAFitIf: { answers: [], below: null, above: null },
                notify: null,
              },
            ])
          }
          data-testid="ai-setup-add-qualify"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {W.addQuestion}
        </Button>
      ) : null}
      <FieldError>{problems['questions']}</FieldError>
    </div>
  );
}
