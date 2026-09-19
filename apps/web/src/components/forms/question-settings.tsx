'use client';
import {
  ANSWER_TARGETS,
  CHOICE_TYPES,
  findQuestion,
  QUESTION_LABELS,
  targetAccepts,
  type AnswerTargetKey,
  type FormDefinition,
  type FormOp,
  type Question,
} from '@hfos/core';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Hint, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { FormCatalogsOut } from '@/lib/api/types';
import { newChoice } from './editor-state';

const TARGET_KEYS = Object.keys(ANSWER_TARGETS) as AnswerTargetKey[];

/**
 * Everything about the question that is showing: what it asks, whether it must be answered, its choices,
 * and — the part that makes a form worth filling in — which field on the customer the answer goes into.
 */
export function QuestionSettings({
  definition,
  questionId,
  apply,
  catalogs,
  readOnly,
}: {
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
        {question.type !== 'content' ? (
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

      {question.type !== 'content' && question.type !== 'payment' ? (
        <WhereItGoes question={question} patch={patch} catalogs={catalogs} readOnly={readOnly} />
      ) : null}
    </div>
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
