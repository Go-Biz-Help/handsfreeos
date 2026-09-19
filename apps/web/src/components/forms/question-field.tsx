'use client';
import type { AnswerValue, Question } from '@hfos/core';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * One question as the person answering it sees it. The preview in the editor and the public page both use
 * this, so "what it looks like" and "what they see" can't drift apart.
 */
export function QuestionField({
  question,
  value,
  problem,
  onChange,
}: {
  question: Question;
  value: AnswerValue;
  problem: string | null;
  onChange: (value: AnswerValue) => void;
}) {
  const id = `q-${question.id}`;
  if (question.type === 'content')
    return (
      <p id={id} className="whitespace-pre-wrap text-[14px] text-text-2">
        {String((question.config as { body: string }).body)}
      </p>
    );
  return (
    <div id={id}>
      <label className="mb-1.5 block text-[14px] font-medium text-text" htmlFor={`${id}-input`}>
        {question.title}
        {question.required ? (
          <span className="ml-1 text-danger-text" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {question.help ? <p className="mb-2 text-[12.5px] text-text-3">{question.help}</p> : null}
      <Answer question={question} value={value} onChange={onChange} />
      {problem ? (
        <p role="alert" className="mt-1.5 text-[12.5px] text-danger-text">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function Answer({
  question,
  value,
  onChange,
}: {
  question: Question;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
}) {
  const config = question.config as Record<string, unknown>;
  const id = `q-${question.id}-input`;
  switch (question.type) {
    case 'long_text':
      return (
        <Textarea
          id={id}
          rows={4}
          value={typeof value === 'string' ? value : ''}
          placeholder={String(config.placeholder ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'choice': {
      const choices = (config.choices ?? []) as { id: string; label: string }[];
      return (
        <div className="space-y-2">
          {choices.map((choice) => (
            <label
              key={choice.id}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-control border px-3.5 py-2.5 text-[14px] transition-colors',
                value === choice.id
                  ? 'border-accent bg-accent/5 text-text'
                  : 'border-border text-text-2 hover:bg-card-2',
              )}
            >
              <input
                type="radio"
                name={id}
                className="h-[18px] w-[18px] accent-accent"
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
        <div className="space-y-2">
          {choices.map((choice) => (
            <Checkbox
              key={choice.id}
              className={cn(
                'rounded-control border px-3.5 py-2.5 text-[14px] transition-colors',
                picked.includes(choice.id)
                  ? 'border-accent bg-accent/5'
                  : 'border-border hover:bg-card-2',
              )}
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
              {String(
                config[answer === 'yes' ? 'yesLabel' : 'noLabel'] ??
                  (answer === 'yes' ? 'Yes' : 'No'),
              )}
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
        <div>
          <div className="flex flex-wrap gap-2">
            {numbers.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onChange(n)}
                aria-pressed={value === n}
                className={cn(
                  'h-10 w-10 rounded-control border text-[14px] transition-colors',
                  value === n
                    ? 'border-accent bg-accent text-white'
                    : 'border-border text-text-2 hover:bg-card-2',
                )}
              >
                {n}
              </button>
            ))}
          </div>
          {config.minLabel || config.maxLabel ? (
            <div className="mt-1.5 flex justify-between text-[12px] text-text-3">
              <span>{String(config.minLabel ?? '')}</span>
              <span>{String(config.maxLabel ?? '')}</span>
            </div>
          ) : null}
        </div>
      );
    }
    case 'number':
    case 'money':
      return (
        <div className="flex items-center gap-2">
          {question.type === 'money' ? <span className="text-[14px] text-text-3">$</span> : null}
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            value={
              typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
            }
            placeholder={String(config.placeholder ?? '')}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
          {config.unit ? (
            <span className="shrink-0 text-[13px] text-text-3">{String(config.unit)}</span>
          ) : null}
        </div>
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
      const part = (key: string, label: string, className?: string) => (
        <Input
          key={key}
          aria-label={label}
          placeholder={label}
          className={className}
          value={address[key] ?? ''}
          onChange={(e) => onChange({ ...address, [key]: e.target.value } as never)}
        />
      );
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {config.detail === 'full' ? part('line1', 'Street', 'sm:col-span-2') : null}
          {part('city', 'Town')}
          {part('state', 'State')}
          {part('postalCode', 'Postcode')}
        </div>
      );
    }
    case 'signature':
      return (
        <div>
          <p className="mb-2 whitespace-pre-wrap rounded-card bg-card-2 p-3 text-[13px] text-text-2">
            {String(config.statement ?? '')}
          </p>
          <Input
            id={id}
            placeholder="Type your full name"
            autoComplete="name"
            value={
              value && typeof value === 'object' && 'name' in value
                ? String((value as { name: string }).name)
                : ''
            }
            onChange={(e) =>
              onChange({ name: e.target.value, signedAt: new Date().toISOString() } as never)
            }
          />
          <p className="mt-1.5 text-[12px] text-text-3">
            Typing your name here counts as signing it.
          </p>
        </div>
      );
    case 'file':
      return (
        <p className="rounded-card border border-dashed border-border px-3 py-5 text-center text-[13px] text-text-3">
          Uploads are coming shortly. For now, tell us in the box above and we’ll ask for photos by
          text.
        </p>
      );
    case 'payment':
      return (
        <p className="rounded-card border border-dashed border-border px-3 py-5 text-center text-[13px] text-text-3">
          {String(config.description ?? 'Payment')} — we’ll send a card link once this is in.
        </p>
      );
    case 'email':
      return (
        <Input
          id={id}
          type="email"
          autoComplete="email"
          inputMode="email"
          value={typeof value === 'string' ? value : ''}
          placeholder={String(config.placeholder ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'phone':
      return (
        <Input
          id={id}
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          value={typeof value === 'string' ? value : ''}
          placeholder={String(config.placeholder ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return (
        <Input
          id={id}
          value={typeof value === 'string' ? value : ''}
          placeholder={String(config.placeholder ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
