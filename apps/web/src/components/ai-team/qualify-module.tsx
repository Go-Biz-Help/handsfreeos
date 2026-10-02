'use client';
import {
  QUESTION_KINDS,
  type NotifyWho,
  type QualifyingQuestion,
  type QuestionKind,
} from '@hfos/core';
import { ArrowDown, ArrowUp, Check, Plus, Trash2, Workflow } from 'lucide-react';
import { useState } from 'react';
import { SetRow } from '@/components/settings/set-row';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { notifyWords, stageOf } from '@/lib/ai-team/describe';
import type { PatchOptions } from '@/lib/ai-team/use-draft';
import { cn } from '@/lib/utils';
import type { ModuleProps } from './modules';
import { AddChip, Chip, DraftText, EditableChip, ModuleHeading, Note } from './parts';

const KIND_NAMES: Readonly<Record<QuestionKind, string>> = {
  choice: 'Choice',
  yes_no: 'Yes or no',
  number: 'Number',
  text: 'Text',
  file: 'File',
};
const MAX_QUESTIONS = 10;
const MAX_CHOICES = 20;

type Change = (next: QualifyingQuestion, label: string, options?: PatchOptions) => string | null;

function newId(taken: readonly string[]): string {
  let id: string;
  do id = `q${Math.random().toString(36).slice(2, 8)}`;
  while (taken.includes(id));
  return id;
}

/**
 * A question as another kind, keeping what still fits (choices need two, yes/no rules out one answer). Only a file
 * question tells anyone when it's answered: owners and admins, until someone picks otherwise.
 */
function withKind(q: QualifyingQuestion, kind: QuestionKind): QualifyingQuestion {
  const none = { answers: [], below: null, above: null };
  const base = { ...q, notify: null };
  switch (kind) {
    case 'choice': {
      const options = q.options.length >= 2 ? q.options : ['Option 1', 'Option 2'];
      const answers = q.notAFitIf.answers.filter((a) => options.includes(a));
      return { ...base, kind, options, notAFitIf: { ...none, answers } };
    }
    case 'yes_no': {
      const answers = q.notAFitIf.answers.filter((a) => a === 'yes' || a === 'no').slice(0, 1);
      return { ...base, kind, options: [], notAFitIf: { ...none, answers } };
    }
    case 'number':
      return {
        ...base,
        kind,
        options: [],
        notAFitIf: { ...none, below: q.notAFitIf.below, above: q.notAFitIf.above },
      };
    case 'text':
      return { ...base, kind, options: [], notAFitIf: none };
    case 'file':
      return { ...q, kind, options: [], notAFitIf: none, notify: q.notify ?? { kind: 'admins' } };
  }
}

const rulesOut = (q: QualifyingQuestion) =>
  q.notAFitIf.answers.length > 0 || q.notAFitIf.below !== null || q.notAFitIf.above !== null;

/** Qualify: the questions, their answers and what rules a lead out; then what happens when one qualifies. */
export function QualifyModule({ draft, patch, catalogs }: ModuleProps) {
  const q = draft.qualify;
  const name = draft.identity.name;
  const list = q.questions;
  const set = (next: readonly QualifyingQuestion[], label: string, options?: PatchOptions) =>
    patch({ qualify: { questions: [...next] } }, label, options);
  const move = (i: number, d: -1 | 1) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    set(next, 'Reorder the questions');
  };
  return (
    <>
      <ModuleHeading
        title="Qualify"
        description={`Questions ${name} asks new leads, one or two at a time and in its own words. The answers show on the lead.`}
        skill={{
          on: q.enabled,
          onChange: (v) =>
            patch({ qualify: { enabled: v } }, v ? 'Turn on Qualify' : 'Turn off Qualify'),
          label: 'Qualify',
          testId: 'skill-qualify',
        }}
      />
      <ol className="flex flex-col gap-2.5" data-testid="qualify-questions">
        {list.map((item, i) => (
          <QuestionCard
            key={item.id}
            q={item}
            index={i}
            count={list.length}
            name={name}
            members={catalogs.members}
            onChange={(next, label, options) =>
              set(
                list.map((x, j) => (j === i ? next : x)),
                label,
                options,
              )
            }
            onMove={(d) => move(i, d)}
            onRemove={() =>
              set(
                list.filter((_, j) => j !== i),
                'Remove a question',
              )
            }
          />
        ))}
      </ol>
      {!list.length ? (
        <p className="rounded-menu border border-dashed border-border-strong px-4 py-5 text-center text-[13px] text-text-2">
          No questions yet. Add the ones you’d ask on the phone.
        </p>
      ) : null}
      {list.length < MAX_QUESTIONS ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          data-testid="qualify-add"
          onClick={() =>
            set(
              [
                ...list,
                {
                  id: newId(list.map((x) => x.id)),
                  question: 'New question',
                  kind: 'text',
                  options: [],
                  required: true,
                  notAFitIf: { answers: [], below: null, above: null },
                  notify: null,
                },
              ],
              'Add a question',
            )
          }
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          Add a question
        </Button>
      ) : (
        <p className="mt-2 text-xs text-text-3">That’s the most it asks: 10 questions.</p>
      )}
      <WhenQualified draft={draft} patch={patch} catalogs={catalogs} />
      <WhenNotAFit draft={draft} patch={patch} />
      <SetRow
        center
        title={`${name} opens and closes deals`}
        description="Opens a lead for a customer who has none, sets what it’s worth, and marks it won or lost. Works with Qualify on or off."
      >
        <Switch
          checked={draft.deals.enabled}
          label="Deals"
          testId="deals-enabled"
          onChange={(v) => patch({ deals: { enabled: v } }, v ? 'Turn on deals' : 'Turn off deals')}
        />
      </SetRow>
    </>
  );
}

function QuestionCard({
  q,
  index,
  count,
  name,
  members,
  onChange,
  onMove,
  onRemove,
}: {
  q: QualifyingQuestion;
  index: number;
  count: number;
  name: string;
  members: ModuleProps['catalogs']['members'];
  onChange: Change;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  return (
    <li
      className="flex flex-col gap-[9px] rounded-menu border border-border bg-card px-3 pb-3 pt-2.5"
      data-testid={`question-${n}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          aria-hidden
          className="inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-card-2 text-[11.5px] font-semibold text-text-2"
        >
          {n}
        </span>
        <DraftText
          id={`question-${q.id}-text`}
          ariaLabel={`Question ${n}`}
          value={q.question}
          maxLength={200}
          className="min-w-[180px] flex-1"
          inputClassName="h-[34px] text-sm"
          testId={`question-${n}-text`}
          onChange={(v) =>
            onChange({ ...q, question: v }, 'Edit a question', {
              group: `question.${q.id}`,
              quiet: true,
            })
          }
        />
        <Select
          selectSize="sm"
          className="w-[128px]"
          aria-label={`Answer for question ${n}`}
          value={q.kind}
          data-testid={`question-${n}-kind`}
          onChange={(e) =>
            onChange(withKind(q, e.target.value as QuestionKind), 'Change the answer')
          }
        >
          {QUESTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_NAMES[k]}
            </option>
          ))}
        </Select>
        <span className="flex flex-none items-center">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Move question ${n} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="h-4 w-4" strokeWidth={1.5} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Move question ${n} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-4 w-4" strokeWidth={1.5} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove question ${n}`}
            title="Remove this question"
            onClick={onRemove}
            data-testid={`question-${n}-remove`}
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.5} />
          </Button>
        </span>
      </div>
      {q.kind === 'choice' ? (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={`Choices for question ${n}`}
        >
          {q.options.map((o, i) => (
            <EditableChip
              key={o}
              value={o}
              maxLength={100}
              editLabel={`Change the choice ${o}`}
              removeLabel={`Remove the choice ${o}`}
              testId={`question-${n}-choice-${i + 1}`}
              onRename={(v) =>
                onChange(
                  {
                    ...q,
                    options: q.options.map((x) => (x === o ? v : x)),
                    notAFitIf: {
                      ...q.notAFitIf,
                      answers: q.notAFitIf.answers.map((x) => (x === o ? v : x)),
                    },
                  },
                  'Change a choice',
                ) === null
              }
              onRemove={() =>
                onChange(
                  {
                    ...q,
                    options: q.options.filter((x) => x !== o),
                    notAFitIf: {
                      ...q.notAFitIf,
                      answers: q.notAFitIf.answers.filter((x) => x !== o),
                    },
                  },
                  'Remove a choice',
                )
              }
            />
          ))}
          {q.options.length < MAX_CHOICES ? (
            <AddChip
              label="Add a choice"
              placeholder="Another choice"
              maxLength={100}
              testId={`question-${n}-add-choice`}
              onAdd={(v) => onChange({ ...q, options: [...q.options, v] }, 'Add a choice') === null}
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[12.5px] text-text-2">
        <label className="inline-flex items-center gap-[7px]">
          <Switch
            checked={q.required}
            label={`Question ${n} required`}
            className="origin-left scale-[0.85]"
            onChange={(v) =>
              onChange(
                { ...q, required: v },
                v ? 'Make a question required' : 'Make a question optional',
              )
            }
          />
          Required
        </label>
        {q.kind === 'file' ? (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            Tell when it arrives
            <NotifyPicker
              value={q.notify}
              members={members}
              label={`Question ${n}: who hears when the file arrives`}
              testId={`question-${n}-notify`}
              onChange={(notify) =>
                onChange({ ...q, notify }, 'Change who hears when a file arrives')
              }
            />
          </span>
        ) : (
          <NotAFit q={q} n={n} onChange={onChange} />
        )}
      </div>
      {q.kind === 'file' ? (
        <p className="text-[12.5px] text-text-3">
          {name} texts them a link to send a photo or PDF, or saves the one they text or email. It
          goes on the lead’s Files.
        </p>
      ) : q.kind === 'text' ? (
        <p className="text-[12.5px] text-text-3">Saved as they wrote it.</p>
      ) : rulesOut(q) ? (
        <p className="text-[12.5px] text-text-3">
          When an answer rules them out, {name} thanks them, explains kindly and doesn’t book.
        </p>
      ) : null}
    </li>
  );
}

function NotAFit({ q, n, onChange }: { q: QualifyingQuestion; n: number; onChange: Change }) {
  const rule = q.notAFitIf;
  if (q.kind === 'text')
    return (
      <span className="text-text-3">
        Not a fit if: only for choice, yes or no, and number questions
      </span>
    );
  if (q.kind === 'number')
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        Not a fit if below
        <NumberBox
          value={rule.below}
          label={`Question ${n}: not a fit below`}
          onChange={(below) =>
            onChange({ ...q, notAFitIf: { ...rule, below } }, 'Change the range', {
              group: `range.${q.id}`,
            })
          }
        />
        or above
        <NumberBox
          value={rule.above}
          label={`Question ${n}: not a fit above`}
          onChange={(above) =>
            onChange({ ...q, notAFitIf: { ...rule, above } }, 'Change the range', {
              group: `range.${q.id}`,
            })
          }
        />
      </span>
    );
  const yesNo = q.kind === 'yes_no';
  const options = yesNo ? ['yes', 'no'] : q.options;
  const words = (o: string) => (yesNo ? (o === 'yes' ? 'Yes' : 'No') : o);
  const toggle = (o: string) => {
    const has = rule.answers.includes(o);
    const answers = yesNo
      ? has
        ? []
        : [o]
      : has
        ? rule.answers.filter((x) => x !== o)
        : [...rule.answers, o];
    onChange({ ...q, notAFitIf: { ...rule, answers } }, 'Change who’s not a fit');
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      Not a fit if:
      {rule.answers.map((a) => (
        <Chip key={a} tone="bad" removeLabel={`${words(a)} is a fit`} onRemove={() => toggle(a)}>
          {words(a)}
        </Chip>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid={`question-${n}-not-a-fit`}
            className="inline-flex h-[26px] items-center rounded-full border border-dashed border-border-strong px-[9px] text-[12.5px] text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          >
            {rule.answers.length ? 'Change' : 'Pick answers'}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {options.map((o) => (
            <DropdownMenuItem
              key={o}
              onSelect={(e) => {
                // Choices can rule out several answers, so the menu stays open for them.
                if (!yesNo) e.preventDefault();
                toggle(o);
              }}
            >
              <Check
                className={cn('h-4 w-4', rule.answers.includes(o) ? 'opacity-100' : 'opacity-0')}
                strokeWidth={2}
              />
              {words(o)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/** A number that can be left empty; it takes each valid number as you type. */
function NumberBox({
  value,
  onChange,
  label,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  label: string;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      type="number"
      inputSize="sm"
      className="h-7 w-20 text-[13px]"
      aria-label={label}
      value={text ?? (value === null ? '' : String(value))}
      onChange={(e) => {
        setText(e.target.value);
        const raw = e.target.value.trim();
        if (!raw) onChange(null);
        else if (Number.isFinite(Number(raw))) onChange(Number(raw));
      }}
      onBlur={() => setText(null)}
    />
  );
}

function WhenQualified({
  draft,
  patch,
  catalogs,
}: Pick<ModuleProps, 'draft' | 'patch' | 'catalogs'>) {
  const w = draft.qualify.whenQualified;
  const pipelines = catalogs.pipelines ?? [];
  const stage = stageOf(w.stageId, catalogs);
  return (
    <div className="mt-5 border-t border-border pt-4" data-testid="qualify-when-qualified">
      <h3 className="text-[15px] font-semibold">When a lead qualifies</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">
        Every required question is answered, and nothing is marked not a fit.
      </p>
      <SetRow
        center
        title="Move the lead to"
        description={stage ? `In ${stage.pipeline}.` : 'Or leave it where it is.'}
      >
        <Select
          selectSize="sm"
          className="w-[190px]"
          aria-label="Move the lead to"
          value={w.stageId ?? ''}
          data-testid="qualify-stage"
          onChange={(e) =>
            patch(
              { qualify: { whenQualified: { stageId: e.target.value || null } } },
              'Change where qualified leads go',
            )
          }
        >
          <option value="">Leave it where it is</option>
          {w.stageId && !stage ? <option value={w.stageId}>A removed stage</option> : null}
          {pipelines
            .filter((p) => !p.archived || p.stages.some((s) => s.id === w.stageId))
            .map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.stages
                  .filter((s) => !s.archived || s.id === w.stageId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </optgroup>
            ))}
        </Select>
      </SetRow>
      <SetRow center title="Tell" description="By email, and on their phone.">
        <NotifyPicker
          value={w.notify}
          members={catalogs.members}
          label="Who hears about qualified leads"
          testId="qualify-notify"
          className="w-[190px]"
          onChange={(next) =>
            patch(
              { qualify: { whenQualified: { notify: next } } },
              'Change who hears about qualified leads',
            )
          }
        />
      </SetRow>
      <SetRow
        center
        title="Then offer times to book"
        description={draft.book.enabled ? 'From the calendars in Book.' : 'Only while Book is on.'}
      >
        <Switch
          checked={w.offerTimes}
          label="Then offer times to book"
          testId="qualify-offer-times"
          onChange={(v) =>
            patch(
              { qualify: { whenQualified: { offerTimes: v } } },
              v ? 'Offer qualified leads times' : 'Don’t offer qualified leads times',
            )
          }
        />
      </SetRow>
      <Note icon={Workflow} className="mt-2">
        Workflows can start from this too, with the trigger “A lead is qualified”.
      </Note>
    </div>
  );
}

/** Who hears about something: no one, owners and admins, the lead's assignee, the customer's owner, or someone. */
function NotifyPicker({
  value: notify,
  members: all,
  label,
  testId,
  className,
  onChange,
}: {
  value: NotifyWho | null;
  members: ModuleProps['catalogs']['members'];
  label: string;
  testId: string;
  className?: string;
  onChange: (next: NotifyWho | null) => void;
}) {
  const members = all.filter((m) => m.active);
  const single =
    notify?.kind === 'users' && notify.userIds.length === 1 && typeof notify.userIds[0] === 'string'
      ? notify.userIds[0]
      : null;
  const value = !notify
    ? 'none'
    : notify.kind === 'users'
      ? single
        ? `user:${single}`
        : 'several'
      : notify.kind;
  const set = (v: string) => {
    if (v === 'several') return;
    onChange(
      v === 'none'
        ? null
        : v === 'admins'
          ? { kind: 'admins' }
          : v === 'lead_assignee'
            ? { kind: 'lead_assignee' }
            : v === 'person_owner'
              ? { kind: 'person_owner' }
              : { kind: 'users', userIds: [v.slice('user:'.length)] },
    );
  };
  return (
    <Select
      selectSize="sm"
      className={className ?? 'w-[190px]'}
      aria-label={label}
      value={value}
      data-testid={testId}
      onChange={(e) => set(e.target.value)}
    >
      <option value="none">No one</option>
      <option value="admins">Owners and admins</option>
      <option value="lead_assignee">The lead’s assignee</option>
      <option value="person_owner">The customer’s owner</option>
      {value === 'several' ? <option value="several">{notifyWords(notify, all)}</option> : null}
      {single && !members.some((m) => m.userId === single) ? (
        <option value={`user:${single}`}>A former teammate</option>
      ) : null}
      {members.map((m) => (
        <option key={m.userId} value={`user:${m.userId}`}>
          {m.name}
        </option>
      ))}
    </Select>
  );
}

/** When an answer rules a lead out. The teammate never marks a lead lost itself, so it asks the team. */
function WhenNotAFit({ draft, patch }: Pick<ModuleProps, 'draft' | 'patch'>) {
  const tell = draft.qualify.whenNotAFit.tellTeam;
  return (
    <div className="mt-5 border-t border-border pt-4" data-testid="qualify-when-not-a-fit">
      <h3 className="text-[15px] font-semibold">When an answer is marked not a fit</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">
        {draft.identity.name} thanks them, explains kindly, and doesn’t book.
      </p>
      <SetRow
        center
        title="Tell the team"
        description="A task for the lead’s assignee, or the customer’s owner: “Not a fit: the reason. Mark the lead lost?” A person decides."
      >
        <Switch
          checked={tell}
          label="Tell the team when a lead isn’t a fit"
          testId="qualify-tell-team"
          onChange={(v) =>
            patch(
              { qualify: { whenNotAFit: { tellTeam: v } } },
              v ? 'Tell the team about leads that aren’t a fit' : 'Don’t tell the team',
            )
          }
        />
      </SetRow>
    </div>
  );
}
