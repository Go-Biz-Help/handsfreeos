'use client';
import {
  ANSWER_TARGETS,
  CHOICE_TYPES,
  findQuestion,
  liveOf,
  parseVideoUrl,
  POLL_CUE_CHARS,
  POLL_MAX_CUES,
  POLL_MAX_SECONDS,
  POLL_MIN_SECONDS,
  POLL_WORDS,
  QUESTION_LABELS,
  SLIDE_WORDS,
  targetAccepts,
  VIDEO_HOST_NAMES,
  type AnswerTargetKey,
  type FormDefinition,
  type FormOp,
  type Question,
} from '@hfos/core';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { FormCatalogsOut } from '@/lib/api/types';
import { cueErrorMessage, writeCues } from '@/lib/forms/poll-cues';
import { newChoice } from './editor-state';

const TARGET_KEYS = Object.keys(ANSWER_TARGETS) as AnswerTargetKey[];

/**
 * Everything about the question that is showing: what it asks, whether it must be answered, its choices,
 * and — the part that makes a form worth filling in — which field on the customer the answer goes into.
 */
export function QuestionSettings({
  workspaceId,
  definition,
  questionId,
  apply,
  catalogs,
  readOnly,
}: {
  workspaceId: string;
  definition: FormDefinition;
  questionId: string;
  apply: (ops: FormOp[]) => void;
  catalogs: FormCatalogsOut | null;
  readOnly: boolean;
}) {
  const found = findQuestion(definition, questionId);
  if (!found)
    return (
      <Card className="p-6 text-center text-[13px] text-text-3">
        Pick a question on the left to change it.
      </Card>
    );
  const question = found.question;
  const patch = (fields: Record<string, unknown>) =>
    apply([{ op: 'update_question', questionId, patch: fields }]);
  const config = question.config as Record<string, unknown>;
  const patchConfig = (fields: Record<string, unknown>) => patch({ config: fields });
  // A live poll's questions pop up when they're asked, and are answered or let go: none must be answered.
  const poll = definition.mode === 'poll';

  return (
    <div className="space-y-4" data-testid="question-settings">
      <Card className="space-y-4 p-4">
        <p className="text-[12px] font-medium uppercase tracking-wide text-text-3">
          {QUESTION_LABELS[question.type]}
        </p>
        <Field label="What does it ask?" htmlFor="q-title">
          <Input
            id="q-title"
            value={question.title}
            disabled={readOnly}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </Field>
        <Field
          label="The smaller line underneath"
          htmlFor="q-help"
          hint="Anything that saves them a phone call."
        >
          <Input
            id="q-help"
            value={question.help}
            disabled={readOnly}
            onChange={(e) => patch({ help: e.target.value })}
          />
        </Field>
        {question.type !== 'content' && question.type !== 'video' && !poll ? (
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="q-required">Must be answered</Label>
              <Hint>They can’t send the form without it.</Hint>
            </div>
            <Switch
              label="Must be answered"
              checked={question.required}
              disabled={readOnly}
              onChange={(on) => patch({ required: on })}
              testId="question-required"
            />
          </div>
        ) : null}
      </Card>

      {CHOICE_TYPES.has(question.type) ? (
        <Choices
          question={question}
          questionId={questionId}
          apply={apply}
          readOnly={readOnly}
          quiz={definition.mode === 'quiz'}
        />
      ) : null}

      {question.type === 'content' ? (
        <Card className="p-4">
          <Field label="What it says" htmlFor="q-body">
            <Textarea
              id="q-body"
              rows={4}
              value={String(config.body ?? '')}
              disabled={readOnly}
              onChange={(e) => patchConfig({ body: e.target.value })}
            />
          </Field>
        </Card>
      ) : null}

      {question.type === 'video' ? (
        <VideoSettings config={config} patchConfig={patchConfig} readOnly={readOnly} />
      ) : null}

      {question.type === 'button' ? (
        <ButtonSettings
          config={config}
          patchConfig={patchConfig}
          readOnly={readOnly}
          catalogs={catalogs}
        />
      ) : null}

      {poll ? (
        <LiveSettings
          question={question}
          patch={patch}
          readOnly={readOnly}
          slides={definition.slides?.pages ?? 0}
          onWrite={async () => {
            const ops = await writeCues(workspaceId, definition, [question]);
            if (ops.length) apply(ops);
          }}
        />
      ) : null}

      {question.type === 'booking' ? (
        <BookingSettings
          config={config}
          patchConfig={patchConfig}
          readOnly={readOnly}
          catalogs={catalogs}
        />
      ) : null}

      {question.type === 'signature' ? (
        <Card className="p-4">
          <Field
            label="What they are signing"
            htmlFor="q-statement"
            hint="Shown above the box. They type their name to sign it."
          >
            <Textarea
              id="q-statement"
              rows={3}
              value={String(config.statement ?? '')}
              disabled={readOnly}
              onChange={(e) => patchConfig({ statement: e.target.value })}
            />
          </Field>
        </Card>
      ) : null}

      {question.type === 'number' || question.type === 'money' ? (
        <Card className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="Least it can be" htmlFor="q-min">
            <Input
              id="q-min"
              type="number"
              value={config.min === null || config.min === undefined ? '' : String(config.min)}
              disabled={readOnly}
              onChange={(e) =>
                patchConfig({ min: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
          </Field>
          <Field label="Most it can be" htmlFor="q-max">
            <Input
              id="q-max"
              type="number"
              value={config.max === null || config.max === undefined ? '' : String(config.max)}
              disabled={readOnly}
              onChange={(e) =>
                patchConfig({ max: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
          </Field>
          {question.type === 'number' ? (
            <Field
              label="What it counts"
              htmlFor="q-unit"
              hint="Shown beside the box: sq ft, rooms."
            >
              <Input
                id="q-unit"
                value={String(config.unit ?? '')}
                disabled={readOnly}
                onChange={(e) => patchConfig({ unit: e.target.value })}
              />
            </Field>
          ) : null}
        </Card>
      ) : null}

      {question.type === 'rating' || question.type === 'scale' ? (
        <Card className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="Highest" htmlFor="q-rating-max">
            <Input
              id="q-rating-max"
              type="number"
              value={String(config.max ?? 5)}
              disabled={readOnly}
              onChange={(e) => patchConfig({ max: Number(e.target.value) })}
            />
          </Field>
          {question.type === 'scale' ? (
            <>
              <Field label="What the low end means" htmlFor="q-min-label">
                <Input
                  id="q-min-label"
                  value={String(config.minLabel ?? '')}
                  disabled={readOnly}
                  onChange={(e) => patchConfig({ minLabel: e.target.value })}
                />
              </Field>
              <Field label="What the high end means" htmlFor="q-max-label">
                <Input
                  id="q-max-label"
                  value={String(config.maxLabel ?? '')}
                  disabled={readOnly}
                  onChange={(e) => patchConfig({ maxLabel: e.target.value })}
                />
              </Field>
            </>
          ) : null}
        </Card>
      ) : null}

      {question.type !== 'content' &&
      question.type !== 'payment' &&
      question.type !== 'video' &&
      question.type !== 'booking' &&
      !poll ? (
        <WhereItGoes question={question} patch={patch} catalogs={catalogs} readOnly={readOnly} />
      ) : null}
    </div>
  );
}

/** A live poll's question: how long it stays up, and whether everyone sees the totals when it closes. */
function LiveSettings({
  question,
  patch,
  readOnly,
  slides,
  onWrite,
}: {
  question: Question;
  patch: (fields: Record<string, unknown>) => void;
  readOnly: boolean;
  /** How many slides the poll has (part 4); 0 with none. */
  slides: number;
  /** The AI writes this question's when-to-ask phrases (part 3). */
  onWrite: () => Promise<void>;
}) {
  const live = liveOf(question);
  const counted = question.type !== 'short_text' && question.type !== 'button';
  const [writing, setWriting] = useState(false);
  // What's typed, kept as typed (blank lines too) while the box has focus; the draft holds the tidy list.
  const [typed, setTyped] = useState<string | null>(null);
  const write = async () => {
    setWriting(true);
    try {
      await onWrite();
      setTyped(null);
    } catch (e) {
      toast.error(cueErrorMessage(e));
    } finally {
      setWriting(false);
    }
  };
  return (
    <Card className="space-y-4 p-4" data-testid="question-live">
      <Field label={POLL_WORDS.cues} htmlFor="q-live-cues" hint={POLL_WORDS.cuesHelp}>
        <Textarea
          id="q-live-cues"
          rows={4}
          value={typed ?? live.cues.join('\n')}
          disabled={readOnly}
          placeholder="Let me ask you something about…"
          onFocus={() => setTyped(live.cues.join('\n'))}
          onBlur={() => setTyped(null)}
          onChange={(e) => {
            setTyped(e.target.value);
            const cues = e.target.value
              .split('\n')
              .map((c) => c.trim().slice(0, POLL_CUE_CHARS))
              .filter(Boolean)
              .slice(0, POLL_MAX_CUES);
            patch({ live: { ...live, cues } });
          }}
          data-testid="question-live-cues"
        />
      </Field>
      {!readOnly ? (
        <Button
          size="sm"
          variant="secondary"
          loading={writing}
          onClick={() => void write()}
          data-testid="question-live-write-cues"
        >
          <Sparkles size={14} aria-hidden /> {POLL_WORDS.writeCues}
        </Button>
      ) : null}
      {slides || live.slide ? (
        <Field
          label={SLIDE_WORDS.slide}
          htmlFor="q-live-slide"
          hint="The AI expects it around this slide, and your team is offered it when the slide comes up."
        >
          <Select
            id="q-live-slide"
            selectSize="sm"
            className="w-56"
            value={live.slide ? String(live.slide) : ''}
            disabled={readOnly}
            onChange={(e) =>
              patch({ live: { ...live, slide: e.target.value ? Number(e.target.value) : null } })
            }
            data-testid="question-live-slide"
          >
            <option value="">{SLIDE_WORDS.anySlide}</option>
            {Array.from({ length: Math.max(slides, live.slide ?? 0) }, (_, i) => (
              <option key={i + 1} value={String(i + 1)}>
                Slide {i + 1}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field
        label={POLL_WORDS.seconds}
        htmlFor="q-live-seconds"
        hint={`From ${POLL_MIN_SECONDS} to ${POLL_MAX_SECONDS}. It closes sooner once nearly everyone has answered, or when you close it.`}
      >
        <Input
          id="q-live-seconds"
          type="number"
          min={POLL_MIN_SECONDS}
          max={POLL_MAX_SECONDS}
          className="w-28"
          value={String(live.seconds)}
          disabled={readOnly}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            if (Number.isFinite(n) && n >= POLL_MIN_SECONDS && n <= POLL_MAX_SECONDS)
              patch({ live: { ...live, seconds: n } });
          }}
          data-testid="question-live-seconds"
        />
      </Field>
      {counted ? (
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="q-live-results">{POLL_WORDS.showResults}</Label>
            <Hint>Off, only your team sees how people answered.</Hint>
          </div>
          <Switch
            label={POLL_WORDS.showResults}
            checked={live.showResults}
            disabled={readOnly}
            onChange={(on) => patch({ live: { ...live, showResults: on } })}
            testId="question-live-results"
          />
        </div>
      ) : (
        <Hint>
          {question.type === 'button'
            ? 'Your team sees who pressed it. Everyone else sees only the button.'
            : 'Your team sees what people typed. Nobody else does.'}
        </Hint>
      )}
    </Card>
  );
}

/** A live poll's button: its words, and what pressing it does. */
function ButtonSettings({
  config,
  patchConfig,
  readOnly,
  catalogs,
}: {
  config: Record<string, unknown>;
  patchConfig: (fields: Record<string, unknown>) => void;
  readOnly: boolean;
  catalogs: FormCatalogsOut | null;
}) {
  const action = String(config.action ?? 'talk') as keyof typeof POLL_WORDS.buttonAction;
  const select =
    'h-9 w-full rounded-control border border-border-strong bg-card px-2.5 text-sm text-text';
  return (
    <Card className="space-y-4 p-4" data-testid="question-button">
      <Field label="The words on the button" htmlFor="q-button-label">
        <Input
          id="q-button-label"
          value={String(config.label ?? '')}
          maxLength={40}
          disabled={readOnly}
          onChange={(e) => patchConfig({ label: e.target.value })}
          data-testid="button-label"
        />
      </Field>
      <Field label="Pressing it" htmlFor="q-button-action">
        <select
          id="q-button-action"
          className={select}
          value={action}
          disabled={readOnly}
          onChange={(e) => patchConfig({ action: e.target.value })}
          data-testid="button-action"
        >
          {(Object.keys(POLL_WORDS.buttonAction) as (keyof typeof POLL_WORDS.buttonAction)[]).map(
            (a) => (
              <option key={a} value={a}>
                {POLL_WORDS.buttonAction[a]}
              </option>
            ),
          )}
        </select>
      </Field>
      {action === 'link' ? (
        <Field
          label="The web page it opens"
          htmlFor="q-button-url"
          hint="It opens in a new tab, so they stay in the call."
        >
          <Input
            id="q-button-url"
            value={String(config.url ?? '')}
            placeholder="https://"
            disabled={readOnly}
            onChange={(e) => patchConfig({ url: e.target.value })}
            data-testid="button-url"
          />
        </Field>
      ) : null}
      {action === 'book' ? (
        <Field
          label="The calendar it books on"
          htmlFor="q-button-calendar"
          hint="Its booking page opens in a new tab."
        >
          <select
            id="q-button-calendar"
            className={select}
            value={String(config.calendarId ?? '')}
            disabled={readOnly}
            onChange={(e) => patchConfig({ calendarId: e.target.value })}
            data-testid="button-calendar"
          >
            <option value="">Pick a calendar</option>
            {(catalogs?.calendars ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {action === 'talk' ? (
        <Hint>Your team sees who pressed it, live, and it’s saved on their contact.</Hint>
      ) : null}
    </Card>
  );
}

/** The link, and whether Next waits until they've watched enough. */
function VideoSettings({
  config,
  patchConfig,
  readOnly,
}: {
  config: Record<string, unknown>;
  patchConfig: (fields: Record<string, unknown>) => void;
  readOnly: boolean;
}) {
  const url = String(config.url ?? '');
  const source = url.trim() ? parseVideoUrl(url) : null;
  const minPercent = typeof config.minPercent === 'number' ? config.minPercent : null;
  return (
    <Card className="space-y-4 p-4">
      <Field
        label="The video’s link"
        htmlFor="q-video-url"
        hint={
          !url.trim()
            ? 'Paste a YouTube, Vimeo or Loom link. An unlisted YouTube video works well.'
            : !source
              ? 'That isn’t a link we can play. Use a YouTube, Vimeo or Loom link to one video.'
              : source.tracked
                ? `A ${VIDEO_HOST_NAMES[source.provider]} video. We can tell how much of it they watched.`
                : `A ${VIDEO_HOST_NAMES[source.provider]} video. It plays, but we can’t tell how much was watched, so it can’t hold the Next button.`
        }
      >
        <Input
          id="q-video-url"
          value={url}
          placeholder="https://www.youtube.com/watch?v=…"
          disabled={readOnly}
          onChange={(e) => patchConfig({ url: e.target.value })}
          data-testid="video-url"
        />
      </Field>
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="q-video-gate">Watch before moving on</Label>
          <Hint>Next waits until they’ve watched this much. Off lets them move on any time.</Hint>
        </div>
        <Switch
          label="Watch before moving on"
          checked={minPercent !== null}
          disabled={readOnly || (source !== null && !source.tracked)}
          onChange={(on) => patchConfig({ minPercent: on ? 80 : null })}
          testId="video-gate"
        />
      </div>
      {minPercent !== null ? (
        <Field label="How much of it" htmlFor="q-video-percent" hint="As a percentage, 1 to 100.">
          <Input
            id="q-video-percent"
            type="number"
            min={1}
            max={100}
            className="w-28"
            value={String(minPercent)}
            disabled={readOnly}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n >= 1 && n <= 100) patchConfig({ minPercent: n });
            }}
            data-testid="video-percent"
          />
        </Field>
      ) : null}
    </Card>
  );
}

/** Which calendar it books, the service when the calendar offers a choice, and how far ahead the times go. */
function BookingSettings({
  config,
  patchConfig,
  readOnly,
  catalogs,
}: {
  config: Record<string, unknown>;
  patchConfig: (fields: Record<string, unknown>) => void;
  readOnly: boolean;
  catalogs: FormCatalogsOut | null;
}) {
  const calendars = catalogs?.calendars ?? [];
  const calendarId = String(config.calendarId ?? '');
  const calendar = calendars.find((c) => c.id === calendarId) ?? null;
  const select =
    'h-9 w-full rounded-control border border-border-strong bg-card px-2.5 text-sm text-text';
  return (
    <Card className="space-y-4 p-4">
      <Field
        label="The calendar it books"
        htmlFor="q-booking-calendar"
        hint={
          calendar?.takesPayment
            ? 'This calendar takes a payment to book, which a form can’t take. Pick another, or turn payment off for it in Settings → Calendars.'
            : calendar && !calendar.active
              ? 'This calendar isn’t taking bookings. Turn it on in Settings → Calendars.'
              : 'They see its next open times as buttons, and the one they pick is booked when they send the form. Its booking page can stay off.'
        }
      >
        <select
          id="q-booking-calendar"
          className={select}
          value={calendarId}
          disabled={readOnly}
          onChange={(e) => patchConfig({ calendarId: e.target.value, serviceId: null })}
          data-testid="booking-calendar"
        >
          <option value="">Pick a calendar</option>
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      {calendar?.services.length ? (
        <Field label="The service it books" htmlFor="q-booking-service">
          <select
            id="q-booking-service"
            className={select}
            value={String(config.serviceId ?? '')}
            disabled={readOnly}
            onChange={(e) => patchConfig({ serviceId: e.target.value || null })}
          >
            <option value="">Pick a service</option>
            {calendar.services.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label="How many days ahead" htmlFor="q-booking-days" hint="Up to 31.">
        <Input
          id="q-booking-days"
          type="number"
          min={1}
          max={31}
          className="w-28"
          value={String(config.days ?? 14)}
          disabled={readOnly}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            if (Number.isFinite(n) && n >= 1 && n <= 31) patchConfig({ days: n });
          }}
        />
      </Field>
    </Card>
  );
}

function Choices({
  question,
  questionId,
  apply,
  readOnly,
  quiz,
}: {
  question: Question;
  questionId: string;
  apply: (ops: FormOp[]) => void;
  readOnly: boolean;
  quiz: boolean;
}) {
  const choices = (
    question.config as {
      choices: { id: string; label: string; correct: boolean; value: number | null }[];
    }
  ).choices;
  return (
    <Card className="space-y-3 p-4">
      <Label>The choices</Label>
      {choices.map((choice) => (
        <div key={choice.id} className="flex items-center gap-2">
          <Input
            value={choice.label}
            disabled={readOnly}
            aria-label="Choice"
            onChange={(e) =>
              apply([
                {
                  op: 'update_question',
                  questionId,
                  patch: { config: { choices: [{ id: choice.id, label: e.target.value }] } },
                },
              ])
            }
          />
          {quiz ? (
            <Checkbox
              className="shrink-0 text-[12.5px] text-text-2"
              label="Right"
              checked={choice.correct}
              disabled={readOnly}
              onChange={(e) =>
                apply([
                  {
                    op: 'update_question',
                    questionId,
                    patch: {
                      config: {
                        choices: [
                          {
                            id: choice.id,
                            correct: e.target.checked,
                            points: e.target.checked ? 1 : 0,
                          },
                        ],
                      },
                    },
                  },
                ])
              }
            />
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove choice"
            disabled={readOnly || choices.length <= 2}
            onClick={() => apply([{ op: 'delete_choice', questionId, choiceId: choice.id }])}
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </div>
      ))}
      {!readOnly ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            apply([
              {
                op: 'add_choice',
                questionId,
                index: null,
                choice: newChoice(`Choice ${choices.length + 1}`),
              },
            ])
          }
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          Add a choice
        </Button>
      ) : null}
    </Card>
  );
}

/** Where the answer lands on the customer: a field they already have, or one the business invented. */
function WhereItGoes({
  question,
  patch,
  catalogs,
  readOnly,
}: {
  question: Question;
  patch: (fields: Record<string, unknown>) => void;
  catalogs: FormCatalogsOut | null;
  readOnly: boolean;
}) {
  const builtIn = TARGET_KEYS.filter((key) => targetAccepts(key, question.type));
  const invented = (catalogs?.customFields ?? []).filter((f) => f.entity !== 'company');
  return (
    <Card className="p-4">
      <Field
        label="Where the answer goes"
        htmlFor="q-map"
        hint="Nowhere means it stays on the response, where it still shows on the customer’s timeline."
      >
        <select
          id="q-map"
          className="h-9 w-full rounded-control border border-border-strong bg-card px-2.5 text-sm text-text"
          value={question.mapTo ?? ''}
          disabled={readOnly}
          onChange={(e) => patch({ mapTo: e.target.value || null })}
        >
          <option value="">Nowhere — keep it on the response</option>
          {builtIn.length ? (
            <optgroup label="The customer">
              {builtIn.map((key) => (
                <option key={key} value={key}>
                  {ANSWER_TARGETS[key].label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {invented.length ? (
            <optgroup label="Fields you invented">
              {invented.map((field) => (
                <option key={field.id} value={`custom:${field.id}`}>
                  {field.label}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </Field>
    </Card>
  );
}
