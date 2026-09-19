/**
 * Plain English for forms: one line per question ("Your budget — amount, only sometimes"), a sentence per
 * change ("Made “Your phone” required"), and `diffForms(a, b)` — the ops that turn one form into another,
 * by stable ids, which is how a version is put back and how an agency template update is described before
 * anybody agrees to it. Browser-safe.
 */
import { ANSWER_OPERATOR_LABELS, type AnswerCondition, type AnyAnswerGroup } from './logic';
import {
  allQuestions,
  findQuestion,
  type FormDefinition,
  type FormPage,
  type FormResult,
  type Question,
} from './definition';
import { cloneJson, jsonEqual } from '../workflows/json';
import type { FormOp } from './ops';
import { CHOICE_TYPES, QUESTION_LABELS, type QuestionType } from './questions';

// ---- One question ----

const choicesOf = (question: Question): { id: string; label: string }[] =>
  ((question.config as { choices?: { id: string; label: string }[] }).choices ?? []);

/** "Your budget — amount, must be answered, only sometimes, fills in Lead value". */
export function questionLine(question: Question): string {
  const bits = [QUESTION_LABELS[question.type as QuestionType].toLowerCase()];
  if (question.required) bits.push('must be answered');
  if (CHOICE_TYPES.has(question.type)) {
    const choices = choicesOf(question);
    bits.push(choices.length === 1 ? '1 choice' : `${choices.length} choices`);
  }
  if (question.showIf.conditions.length) bits.push('only sometimes');
  if (question.mapTo) bits.push('fills in a field');
  return `${question.title} — ${bits.join(', ')}`;
}

/** What a rule says, in the business's words: "when “Do you have a dog?” is Yes". */
export function ruleText(group: AnyAnswerGroup, definition: FormDefinition): string {
  const parts = group.conditions.map((item) =>
    'conditions' in item
      ? `(${ruleText(item as AnyAnswerGroup, definition)})`
      : conditionText(item as AnswerCondition, definition),
  );
  if (!parts.length) return 'always';
  return parts.join(group.match === 'all' ? ' and ' : ' or ');
}

function conditionText(condition: AnswerCondition, definition: FormDefinition): string {
  const source = condition.source;
  const what =
    source.kind === 'question'
      ? `“${findQuestion(definition, source.questionId)?.question.title ?? 'a question'}”`
      : source.kind === 'calculation'
        ? `“${definition.calculations.find((c) => c.id === source.calculationId)?.name ?? 'a calculation'}”`
        : source.kind === 'score'
          ? 'the score'
          : 'the percentage';
  const how = ANSWER_OPERATOR_LABELS[condition.op];
  if (condition.op === 'answered' || condition.op === 'not_answered') return `${what} ${how}`;
  return `${what} ${how} ${valueText(condition, definition)}`;
}

function valueText(condition: AnswerCondition, definition: FormDefinition): string {
  const value = condition.value;
  const labelOf = (id: unknown): string => {
    if (typeof id !== 'string') return String(id);
    for (const question of allQuestions(definition)) {
      const found = choicesOf(question).find((c) => c.id === id);
      if (found) return found.label;
    }
    return id;
  };
  if (Array.isArray(value)) return value.map(labelOf).join(' or ');
  return labelOf(value);
}

/** Every question with what it is, page by page, for a summary or a card. */
export function describeForm(definition: FormDefinition): string[] {
  const lines: string[] = [];
  definition.pages.forEach((page, index) => {
    if (definition.pages.length > 1)
      lines.push(page.title ? `Page ${index + 1}: ${page.title}` : `Page ${index + 1}`);
    for (const question of page.questions) lines.push(questionLine(question));
  });
  if (definition.calculations.length)
    for (const calculation of definition.calculations) lines.push(`Works out ${calculation.name}`);
  if (definition.results.length > 1)
    lines.push(`${definition.results.length} results, depending on the answers`);
  return lines;
}

// ---- What a change did ----

const quoted = (text: string) => `“${text}”`;

function pageName(definition: FormDefinition, pageId: string): string {
  const index = definition.pages.findIndex((p) => p.id === pageId);
  const page = definition.pages[index];
  if (!page) return 'a page';
  return page.title ? quoted(page.title) : `page ${index + 1}`;
}

const REQUIRED_WORDS = { true: 'required', false: 'optional' } as const;

/** What one op did, in a sentence, read against the form as it was before the batch. */
export function describeFormOp(op: FormOp, before: FormDefinition): string {
  const title = (questionId: string) =>
    findQuestion(before, questionId)?.question.title ?? 'a question';
  switch (op.op) {
    case 'add_question': {
      const question = op.question as { title?: string; type?: string };
      return `Added ${quoted(question.title ?? 'a question')}`;
    }
    case 'delete_question':
      return `Deleted ${quoted(title(op.questionId))}`;
    case 'move_question':
      return `Moved ${quoted(title(op.questionId))}`;
    case 'update_question': {
      const patch = op.patch as Record<string, unknown>;
      const name = quoted(title(op.questionId));
      const changes: string[] = [];
      if (typeof patch.title === 'string') changes.push(`renamed it to ${quoted(patch.title)}`);
      if (typeof patch.required === 'boolean')
        changes.push(`made it ${REQUIRED_WORDS[String(patch.required) as 'true' | 'false']}`);
      if (typeof patch.type === 'string') changes.push(`turned it into a ${patch.type.replace(/_/g, ' ')}`);
      if (patch.mapTo !== undefined)
        changes.push(patch.mapTo === null ? 'stopped it filling in a field' : 'pointed it at a field');
      if (patch.showIf !== undefined) changes.push('changed when it shows');
      if (patch.help !== undefined) changes.push('changed the line underneath');
      if (patch.config !== undefined) changes.push('changed its settings');
      return changes.length ? `${name}: ${changes.join(', ')}` : `Changed ${name}`;
    }
    case 'add_choice':
      return `Added a choice to ${quoted(title(op.questionId))}`;
    case 'delete_choice':
      return `Removed a choice from ${quoted(title(op.questionId))}`;
    case 'add_page':
      return 'Added a page';
    case 'delete_page':
      return `Deleted ${pageName(before, op.pageId)}`;
    case 'move_page':
      return `Moved ${pageName(before, op.pageId)}`;
    case 'update_page':
      return `Changed ${pageName(before, op.pageId)}`;
    case 'add_calculation':
      return `Added the calculation ${quoted(String((op.calculation as { name?: string }).name ?? ''))}`;
    case 'update_calculation':
      return 'Changed a calculation';
    case 'delete_calculation':
      return 'Deleted a calculation';
    case 'add_result':
      return `Added the result ${quoted(String((op.result as { name?: string }).name ?? ''))}`;
    case 'update_result':
      return 'Changed a result';
    case 'move_result':
      return 'Moved a result';
    case 'delete_result':
      return 'Deleted a result';
    case 'set_form': {
      const patch = op.patch as Record<string, unknown>;
      if (typeof patch.mode === 'string') return `Made it a ${patch.mode}`;
      if (typeof patch.title === 'string') return `Changed the heading to ${quoted(patch.title)}`;
      return 'Changed the words at the top';
    }
    case 'set_scoring':
      return 'Changed the scoring';
    case 'set_on_submit':
      return 'Changed what happens when somebody sends it';
    case 'set_settings':
      return 'Changed the settings';
  }
}

/** A line per op, for the audit log and the Assistant's card. */
export function describeFormOps(ops: readonly FormOp[], before: FormDefinition): string[] {
  return ops.map((op) => describeFormOp(op, before));
}

// ---- One form into another ----

const pageOfQuestion = (definition: FormDefinition, questionId: string): FormPage | null =>
  definition.pages.find((p) => p.questions.some((q) => q.id === questionId)) ?? null;

/**
 * The ops that turn `from` into `to`, following stable ids: what was added, what went, what moved and what
 * changed. Used to put an old version back and to show what an agency template update would do.
 */
export function diffForms(from: FormDefinition, to: FormDefinition): FormOp[] {
  const ops: FormOp[] = [];

  // Pages first, so the questions have somewhere to go.
  const fromPages = new Map(from.pages.map((p) => [p.id, p]));
  const toPages = new Map(to.pages.map((p) => [p.id, p]));
  to.pages.forEach((page, index) => {
    const was = fromPages.get(page.id);
    if (!was) {
      ops.push({ op: 'add_page', index, page: { ...cloneJson(page), questions: [] } });
      return;
    }
    if (was.title !== page.title || !jsonEqual(was.showIf, page.showIf))
      ops.push({
        op: 'update_page',
        pageId: page.id,
        patch: { title: page.title, showIf: cloneJson(page.showIf) },
      });
  });

  // Questions: gone, new, moved, changed.
  const fromQuestions = new Map(allQuestions(from).map((q) => [q.id, q]));
  const toQuestions = new Map(allQuestions(to).map((q) => [q.id, q]));
  for (const question of allQuestions(from))
    if (!toQuestions.has(question.id))
      ops.push({ op: 'delete_question', questionId: question.id });
  for (const page of to.pages)
    page.questions.forEach((question, index) => {
      const was = fromQuestions.get(question.id);
      if (!was) {
        ops.push({ op: 'add_question', pageId: page.id, index, question: cloneJson(question) });
        return;
      }
      const wasPage = pageOfQuestion(from, question.id);
      const wasIndex = wasPage?.questions.findIndex((q) => q.id === question.id) ?? -1;
      if (wasPage?.id !== page.id || wasIndex !== index)
        ops.push({ op: 'move_question', questionId: question.id, pageId: page.id, index });
      if (!jsonEqual(was, question)) {
        const { id: _id, ...rest } = cloneJson(question) as Record<string, unknown>;
        ops.push({ op: 'update_question', questionId: question.id, patch: rest });
      }
    });

  // Pages that have gone, once their questions are out of the way.
  for (const page of from.pages)
    if (!toPages.has(page.id)) ops.push({ op: 'delete_page', pageId: page.id });

  // Calculations and results.
  for (const calculation of from.calculations)
    if (!to.calculations.some((c) => c.id === calculation.id))
      ops.push({ op: 'delete_calculation', calculationId: calculation.id });
  to.calculations.forEach((calculation, index) => {
    const was = from.calculations.find((c) => c.id === calculation.id);
    if (!was) ops.push({ op: 'add_calculation', index, calculation: cloneJson(calculation) });
    else if (!jsonEqual(was, calculation)) {
      const { id: _id, ...rest } = cloneJson(calculation) as Record<string, unknown>;
      ops.push({ op: 'update_calculation', calculationId: calculation.id, patch: rest });
    }
  });
  for (const result of from.results)
    if (!to.results.some((r) => r.id === result.id) && from.results.length > 1)
      ops.push({ op: 'delete_result', resultId: result.id });
  to.results.forEach((result: FormResult, index) => {
    const was = from.results.find((r) => r.id === result.id);
    if (!was) ops.push({ op: 'add_result', index, result: cloneJson(result) });
    else if (!jsonEqual(was, result)) {
      const { id: _id, ...rest } = cloneJson(result) as Record<string, unknown>;
      ops.push({ op: 'update_result', resultId: result.id, patch: rest });
    }
  });

  // The form itself.
  const formPatch: Record<string, unknown> = {};
  if (from.mode !== to.mode) formPatch.mode = to.mode;
  if (from.title !== to.title) formPatch.title = to.title;
  if (from.intro !== to.intro) formPatch.intro = to.intro;
  if (Object.keys(formPatch).length) ops.push({ op: 'set_form', patch: formPatch });
  if (!jsonEqual(from.scoring, to.scoring))
    ops.push({ op: 'set_scoring', patch: cloneJson(to.scoring) });
  if (!jsonEqual(from.onSubmit, to.onSubmit))
    ops.push({ op: 'set_on_submit', patch: cloneJson(to.onSubmit) });
  if (!jsonEqual(from.settings, to.settings))
    ops.push({ op: 'set_settings', patch: cloneJson(to.settings) });

  return ops;
}
