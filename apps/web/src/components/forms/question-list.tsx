'use client';
import {
  allQuestions,
  newChoiceId,
  newQuestionId,
  type FormDefinition,
  type FormOp,
  type QuestionType,
} from '@hfos/core';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  GripVertical,
  Plus,
  SeparatorHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { newPage, newQuestion } from './editor-state';
import { QUESTION_ICONS, QUESTION_LABELS, QUESTION_MENU } from '@/lib/forms/words';
import { cn } from '@/lib/utils';

/**
 * The questions in the order they are asked, with what they are underneath. Reordering is by the arrows
 * rather than a drag: it works with a keyboard, on a phone, and for somebody who has one hand on a tape
 * measure. Moving a question past the top or bottom of its page takes it onto the next one.
 *
 * A form with more than one page shows where each starts, and can be shown one page at a time: a funnel's
 * steps.
 */
export function QuestionList({
  definition,
  selectedId,
  onSelect,
  apply,
  readOnly,
}: {
  definition: FormDefinition;
  selectedId: string | null;
  onSelect: (questionId: string) => void;
  apply: (ops: FormOp[]) => void;
  readOnly: boolean;
}) {
  const questions = allQuestions(definition);
  const pageOf = (questionId: string) =>
    definition.pages.find((p) => p.questions.some((q) => q.id === questionId))!;

  function add(type: QuestionType) {
    const page = definition.pages[definition.pages.length - 1]!;
    const question = newQuestion(type);
    apply([{ op: 'add_question', pageId: page.id, index: null, question }]);
    onSelect(question.id);
  }

  function move(questionId: string, by: -1 | 1) {
    const page = pageOf(questionId);
    const at = page.questions.findIndex((q) => q.id === questionId);
    const to = at + by;
    if (to >= 0 && to < page.questions.length) {
      apply([{ op: 'move_question', questionId, pageId: page.id, index: to }]);
      return;
    }
    // Past the edge of its page: onto the end of the page before, or the start of the page after.
    const p = definition.pages.findIndex((x) => x.id === page.id);
    const other = definition.pages[p + by];
    if (!other) return;
    apply([
      {
        op: 'move_question',
        questionId,
        pageId: other.id,
        index: by < 0 ? other.questions.length : 0,
      },
    ]);
  }

  /** A page break taken out: its questions join the page before. */
  function joinPage(pageId: string) {
    const p = definition.pages.findIndex((x) => x.id === pageId);
    const before = definition.pages[p - 1];
    if (!before) return;
    const page = definition.pages[p]!;
    apply([
      ...page.questions.map((q, i): FormOp => ({
        op: 'move_question',
        questionId: q.id,
        pageId: before.id,
        index: before.questions.length + i,
      })),
      { op: 'delete_page', pageId },
    ]);
  }

  function duplicate(questionId: string) {
    const page = pageOf(questionId);
    const original = page.questions.find((q) => q.id === questionId)!;
    const question = JSON.parse(JSON.stringify(original)) as {
      id: string;
      title: string;
      config?: { choices?: { id: string }[] };
    };
    question.id = newQuestionId();
    question.title = `${original.title} (copy)`;
    // A copied pick-one keeps its wording but needs choices of its own, or two questions share ids.
    if (question.config?.choices)
      question.config.choices = question.config.choices.map((c) => ({ ...c, id: newChoiceId() }));
    apply([
      {
        op: 'add_question',
        pageId: page.id,
        index: page.questions.findIndex((q) => q.id === questionId) + 1,
        question: question as never,
      },
    ]);
    onSelect(question.id);
  }

  const paged = definition.pages.length > 1;
  const row = (question: (typeof questions)[number], index: number) => {
    const Icon = QUESTION_ICONS[question.type];
    const selected = question.id === selectedId;
    return (
      <div
        key={question.id}
        className={cn(
          'group flex items-center gap-2 rounded-card border bg-card px-3 py-2.5 transition-colors',
          selected ? 'border-accent ring-1 ring-accent/30' : 'border-border hover:bg-card-2',
        )}
        data-testid="question-row"
      >
        <GripVertical className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} />
        <button
          type="button"
          onClick={() => onSelect(question.id)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <Icon className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} />
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] text-text">
              {question.title}
              {question.required ? <span className="ml-1 text-danger-text">*</span> : null}
            </span>
            <span className="block truncate text-[12px] text-text-3">
              {QUESTION_LABELS[question.type]}
              {question.showIf.conditions.length ? ' · only sometimes' : ''}
              {question.mapTo ? ' · fills a field' : ''}
            </span>
          </span>
        </button>
        {!readOnly ? (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Move up"
              disabled={index === 0}
              onClick={() => move(question.id, -1)}
            >
              <ChevronUp className="h-4 w-4" strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Move down"
              disabled={index === questions.length - 1}
              onClick={() => move(question.id, 1)}
            >
              <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Duplicate"
              onClick={() => duplicate(question.id)}
            >
              <Copy className="h-4 w-4" strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete"
              onClick={() => apply([{ op: 'delete_question', questionId: question.id }])}
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-2" data-testid="question-list">
      {definition.pages.map((page, p) => (
        <div key={page.id} className="space-y-2" data-testid="form-page">
          {paged ? (
            <div className="flex items-center gap-2 pt-2">
              <span className="shrink-0 text-[11.5px] font-medium uppercase tracking-wide text-text-3">
                Page {p + 1}
              </span>
              <Input
                aria-label={`Page ${p + 1} heading`}
                placeholder="Heading (optional)"
                className="h-8 text-[13px]"
                value={page.title}
                disabled={readOnly}
                onChange={(e) =>
                  apply([{ op: 'update_page', pageId: page.id, patch: { title: e.target.value } }])
                }
              />
              {!readOnly && p > 0 ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Join page ${p + 1} to the page before`}
                  title="Take out this page break"
                  onClick={() => joinPage(page.id)}
                >
                  <X className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              ) : null}
            </div>
          ) : null}
          {paged &&
          definition.settings.onePageAtATime &&
          definition.settings.identity !== 'anonymous' ? (
            <Checkbox
              className="text-[12.5px] text-text-2"
              label="Save their details when they leave this page"
              checked={page.savesContact}
              disabled={
                readOnly || (!page.savesContact && definition.pages.some((x) => x.savesContact))
              }
              onChange={(e) =>
                apply([
                  { op: 'update_page', pageId: page.id, patch: { savesContact: e.target.checked } },
                ])
              }
              data-testid="page-saves-contact"
            />
          ) : null}
          {page.questions.map((question) => row(question, questions.indexOf(question)))}
          {paged && !page.questions.length ? (
            <p className="rounded-card border border-dashed border-border px-4 py-4 text-center text-[12.5px] text-text-3">
              Nothing on this page yet.
            </p>
          ) : null}
        </div>
      ))}

      {!questions.length ? (
        <p className="rounded-card border border-dashed border-border px-4 py-8 text-center text-[13px] text-text-3">
          Nothing is asked yet. Add the first question.
        </p>
      ) : null}

      {!readOnly ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" className="w-full" data-testid="add-question">
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              Add a question
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-[60vh] w-64 overflow-y-auto">
            {QUESTION_MENU.map((group) => (
              <div key={group.group}>
                <p className="px-2 py-1.5 text-[11.5px] font-medium uppercase tracking-wide text-text-3">
                  {group.group}
                </p>
                {group.types.map((type) => {
                  const Icon = QUESTION_ICONS[type];
                  return (
                    <DropdownMenuItem key={type} onSelect={() => add(type)}>
                      <Icon className="h-4 w-4 text-text-3" strokeWidth={1.75} />
                      {QUESTION_LABELS[type]}
                    </DropdownMenuItem>
                  );
                })}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {!readOnly && questions.length ? (
        <Button
          variant="ghost"
          className="w-full"
          onClick={() => apply([{ op: 'add_page', index: null, page: newPage() }])}
          data-testid="add-page"
        >
          <SeparatorHorizontal className="h-4 w-4" strokeWidth={1.75} />
          Start a new page
        </Button>
      ) : null}

      {paged ? (
        <div className="flex items-center justify-between gap-4 rounded-card border border-border bg-card px-3.5 py-3">
          <div>
            <p className="text-[13.5px] font-medium text-text">One page at a time</p>
            <p className="text-[12px] text-text-3">
              Each page gets its own screen, with Back and Next. A video can hold Next until it’s
              watched.
            </p>
          </div>
          <Switch
            label="One page at a time"
            checked={definition.settings.onePageAtATime}
            disabled={readOnly}
            onChange={(on) => apply([{ op: 'set_settings', patch: { onePageAtATime: on } }])}
            testId="one-page-at-a-time"
          />
        </div>
      ) : null}
    </div>
  );
}
