'use client';
import {
  isSingleCheckbox,
  NAME_QUESTIONS,
  nameQuestionOf,
  PICTURE_SIZE_SHARE,
  questionRows,
  type AnswerValue,
  type ItemAlign,
  type PictureRef,
  type PictureSize,
  type Question,
} from '@hfos/core';
import { ImageIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { pictureSrc } from '@/lib/look';
import { cn } from '@/lib/utils';
import { AddressField } from './address-field';
import { BookingPicker } from './booking-picker';
import { FileField } from './file-field';
import { useFormLook } from './form-look';
import { QuantitiesField } from './quantities-field';
import { VideoPlayer } from './video-player';

/** Words lined up across the form. */
const TEXT_ALIGN: Readonly<Record<ItemAlign, string>> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/** A choice as the person answering sees it, with its picture when it has one. */
type ShownChoice = { id: string; label: string; picture?: PictureRef | null };

/** The boxes people type in, which can carry their question's words inside them (the design's labels). */
const TYPED = new Set(['short_text', 'long_text', 'email', 'phone', 'number', 'money']);

/**
 * A page's questions in rows: two half-width ones side by side once the form is wide enough (its section is the
 * container, so the editor's narrow preview stacks them as a phone does), every other one across the whole form.
 */
export function QuestionRows({
  questions,
  render,
}: {
  questions: readonly Question[];
  render: (question: Question) => ReactNode;
}) {
  return (
    <>
      {questionRows(questions).map((row) =>
        row.length === 1 ? (
          render(row[0]!)
        ) : (
          <div
            key={row.map((q) => q.id).join('+')}
            className="grid gap-[var(--form-gap,1.5rem)] @[480px]:grid-cols-2"
            data-testid="form-row"
          >
            {row.map(render)}
          </div>
        ),
      )}
    </>
  );
}

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
  const { labelsInside } = useFormLook();
  // Words inside the box: the label stays for screen readers, and the box shows the question until they type.
  const inside = labelsInside && TYPED.has(question.type);
  if (question.type === 'content') {
    const { body, align } = question.config as { body: string; align?: ItemAlign };
    return (
      <p
        id={id}
        className={cn('whitespace-pre-wrap text-[14px] text-text-2', TEXT_ALIGN[align ?? 'left'])}
      >
        {String(body)}
      </p>
    );
  }
  if (question.type === 'picture') return <PictureItem id={id} question={question} />;
  if (isSingleCheckbox(question)) {
    // One box to check: the question is the words beside it. Checked is a yes; unchecked is no answer at all.
    const checked = value === 'yes' || value === true;
    return (
      <div id={id}>
        <Checkbox
          id={`${id}-input`}
          className={cn(
            'rounded-control border px-3.5 py-2.5 text-[14px] transition-colors',
            checked ? 'border-accent bg-accent/5' : 'border-border hover:bg-card-2',
          )}
          label={
            <>
              {question.title}
              {question.required ? (
                <span className="ml-1 text-danger-text" aria-hidden="true">
                  *
                </span>
              ) : null}
            </>
          }
          checked={checked}
          aria-required={question.required}
          onChange={(e) => onChange(e.target.checked ? 'yes' : null)}
        />
        {question.help ? <p className="mt-1.5 text-[12.5px] text-text-3">{question.help}</p> : null}
        {problem ? (
          <p role="alert" className="mt-1.5 text-[12.5px] text-danger-text">
            {problem}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div id={id}>
      <label
        className={inside ? 'sr-only' : 'mb-1.5 block text-[14px] font-medium text-text'}
        htmlFor={`${id}-input`}
      >
        {question.title}
        {question.required ? (
          <span className="ml-1 text-danger-text" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {question.help && !inside ? (
        <p className="mb-2 text-[12.5px] text-text-3">{question.help}</p>
      ) : null}
      <Answer
        question={question}
        value={value}
        onChange={onChange}
        placeholder={inside ? `${question.title}${question.required ? ' *' : ''}` : undefined}
      />
      {question.help && inside ? (
        <p className="mt-1.5 text-[12.5px] text-text-3">{question.help}</p>
      ) : null}
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
  placeholder: inside,
}: {
  question: Question;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
  /** The question's own words, when the design puts them inside the box. */
  placeholder?: string;
}) {
  const config = question.config as Record<string, unknown>;
  const placeholder = inside ?? String(config.placeholder ?? '');
  const id = `q-${question.id}-input`;
  switch (question.type) {
    case 'long_text':
      return (
        <Textarea
          id={id}
          rows={4}
          value={typeof value === 'string' ? value : ''}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'choice': {
      const choices = (config.choices ?? []) as ShownChoice[];
      if (choices.some((c) => c.picture))
        return (
          <PictureChoices
            name={id}
            choices={choices}
            picked={value === null || value === undefined ? [] : [String(value)]}
            many={false}
            onPick={(choiceId) => onChange(choiceId)}
          />
        );
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
      const choices = (config.choices ?? []) as ShownChoice[];
      const picked = Array.isArray(value) ? value.map(String) : [];
      if (choices.some((c) => c.picture))
        return (
          <PictureChoices
            name={id}
            choices={choices}
            picked={picked}
            many
            onPick={(choiceId) =>
              onChange(
                picked.includes(choiceId)
                  ? picked.filter((p) => p !== choiceId)
                  : [...picked, choiceId],
              )
            }
          />
        );
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
            placeholder={placeholder}
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
    case 'address':
      return <AddressField question={question} value={value} onChange={onChange} />;
    case 'quantities':
      return <QuantitiesField question={question} value={value} onChange={onChange} inputId={id} />;
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
      return <FileField question={question} value={value} onChange={onChange} inputId={id} />;
    case 'payment':
      return (
        <p className="rounded-card border border-dashed border-border px-3 py-5 text-center text-[13px] text-text-3">
          {String(config.description ?? 'Payment')} — we’ll send a card link once this is in.
        </p>
      );
    case 'booking':
      return (
        <BookingPicker
          questionId={question.id}
          value={value}
          onChange={(answer) => onChange(answer as never)}
        />
      );
    case 'video':
      return (
        <VideoPlayer
          url={String(config.url ?? '')}
          title={question.title}
          value={typeof value === 'number' ? value : null}
          onChange={onChange}
        />
      );
    case 'button':
      // A live poll's button: pressing it is the answer.
      return (
        <Button
          type="button"
          variant={value === true ? 'primary' : 'secondary'}
          onClick={() => onChange(true)}
        >
          {String(config.label ?? 'Press')}
        </Button>
      );
    case 'email':
      return (
        <Input
          id={id}
          type="email"
          autoComplete="email"
          inputMode="email"
          value={typeof value === 'string' ? value : ''}
          placeholder={placeholder}
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
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default: {
      // A First name or Last name box tells the browser so, which offers to fill it in.
      const name = nameQuestionOf(question);
      return (
        <Input
          id={id}
          value={typeof value === 'string' ? value : ''}
          placeholder={placeholder}
          autoComplete={name ? NAME_QUESTIONS[name].autoComplete : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
  }
}

/**
 * A picture on the form: as much of the form's width as its size says, lined up left, centre or right, with its caption
 * underneath. Its title is what it shows, for people who can't see it. One not picked yet shows only in the editor.
 */
function PictureItem({ id, question }: { id: string; question: Question }) {
  const { picture, size, align, link } = question.config as {
    picture: PictureRef | null;
    size?: PictureSize;
    align?: ItemAlign;
    link?: string;
  };
  const share = PICTURE_SIZE_SHARE[size ?? 'large'];
  const place = size === 'full' ? 'center' : (align ?? 'center');
  const margin =
    place === 'center' ? 'mx-auto' : place === 'right' ? 'ml-auto mr-0' : 'ml-0 mr-auto';
  if (!picture)
    return (
      <div
        id={id}
        className={cn(
          'flex aspect-[3/2] items-center justify-center gap-2 rounded-control border border-dashed border-border-strong text-[13px] text-text-3',
          margin,
        )}
        style={{ width: `${share * 100}%` }}
        data-testid="form-picture-empty"
      >
        <ImageIcon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        Pick a picture
      </div>
    );
  const img = (
    // Storage's public address: plain <img>, with its size so the space it takes is held while it loads.
    <img
      src={pictureSrc(picture.path)}
      alt={question.title}
      width={picture.width}
      height={picture.height}
      loading="lazy"
      className="block h-auto w-full rounded-control"
    />
  );
  const opens = link && /^https?:\/\//i.test(link) ? link : null;
  return (
    <figure
      id={id}
      className={cn('m-0', margin)}
      style={{ width: `${share * 100}%` }}
      data-testid="form-picture"
      data-align={place}
      data-size={size ?? 'large'}
    >
      {opens ? (
        <a href={opens} target="_blank" rel="noopener noreferrer nofollow">
          {img}
        </a>
      ) : (
        img
      )}
      {question.help ? (
        <figcaption className={cn('mt-1.5 text-[12.5px] text-text-3', TEXT_ALIGN[place])}>
          {question.help}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** Choices with pictures: a grid of pictures to pick from, each with its words underneath. */
function PictureChoices({
  name,
  choices,
  picked,
  many,
  onPick,
}: {
  name: string;
  choices: ShownChoice[];
  picked: string[];
  many: boolean;
  onPick: (choiceId: string) => void;
}) {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5"
      data-testid="picture-choices"
    >
      {choices.map((choice) => {
        const on = picked.includes(choice.id);
        return (
          <label
            key={choice.id}
            className={cn(
              'flex cursor-pointer flex-col overflow-hidden rounded-control border text-[14px] transition-colors',
              on
                ? 'border-accent bg-accent/5 text-text ring-1 ring-accent'
                : 'border-border text-text-2 hover:bg-card-2',
            )}
          >
            {choice.picture ? (
              <img
                src={pictureSrc(choice.picture.path)}
                alt=""
                loading="lazy"
                className="aspect-[4/3] w-full object-cover"
              />
            ) : (
              <span className="aspect-[4/3] w-full bg-card-2" aria-hidden />
            )}
            <span className="flex items-center gap-2 px-3 py-2">
              <input
                type={many ? 'checkbox' : 'radio'}
                name={name}
                className="h-[16px] w-[16px] shrink-0 accent-accent"
                checked={on}
                onChange={() => onPick(choice.id)}
              />
              {choice.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}
