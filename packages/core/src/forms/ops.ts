/**
 * Patch ops: the only way anything changes a form. The question list, the live preview and the Assistant
 * all produce these, so nothing is lost switching between them and every change can be undone.
 * `applyFormOps` applies a batch all or nothing — it places every op, then parses the result with zod and
 * checks the ids are unique — and returns the inverse ops for Undo.
 *
 * The richer checks (a rule reading an answer that hasn't been given, a payment charging a calculation that
 * isn't there) live in `formProblems`: the editor shows them as it goes, and publishing refuses while any
 * are left. A half-built form is allowed to be half-built.
 */
import { z } from 'zod';
import { cloneJson, isPlainObject, mergeJson } from '../workflows/json';
import {
  FormDefinition,
  type FormPageInput,
  type FormResultInput,
  type OnSubmitInput,
  type FormSettingsInput,
  type QuestionInput,
} from './definition';
import { CalculationId, ChoiceId, PageId, QuestionId, ResultId } from './ids';
import type { CalculationInput, ScoringInput } from './logic';
import type { QuestionChoiceInput } from './questions';

/** A merge patch: objects merge key by key, arrays and null replace. `config.choices` merges by id. */
export type FormPatch = Readonly<Record<string, unknown>>;

export type FormOp =
  | { readonly op: 'add_page'; readonly index: number | null; readonly page: FormPageInput }
  | { readonly op: 'update_page'; readonly pageId: string; readonly patch: FormPatch }
  | { readonly op: 'move_page'; readonly pageId: string; readonly index: number }
  | { readonly op: 'delete_page'; readonly pageId: string }
  | {
      readonly op: 'add_question';
      readonly pageId: string;
      /** null appends. */
      readonly index: number | null;
      readonly question: QuestionInput;
    }
  | { readonly op: 'update_question'; readonly questionId: string; readonly patch: FormPatch }
  | {
      readonly op: 'move_question';
      readonly questionId: string;
      readonly pageId: string;
      /** The position on the target page once the question has been taken out. */
      readonly index: number;
    }
  | { readonly op: 'delete_question'; readonly questionId: string }
  | {
      readonly op: 'add_choice';
      readonly questionId: string;
      readonly index: number | null;
      readonly choice: QuestionChoiceInput;
    }
  | { readonly op: 'delete_choice'; readonly questionId: string; readonly choiceId: string }
  | {
      readonly op: 'add_calculation';
      readonly index: number | null;
      readonly calculation: CalculationInput;
    }
  | { readonly op: 'update_calculation'; readonly calculationId: string; readonly patch: FormPatch }
  | { readonly op: 'delete_calculation'; readonly calculationId: string }
  | { readonly op: 'add_result'; readonly index: number | null; readonly result: FormResultInput }
  | { readonly op: 'update_result'; readonly resultId: string; readonly patch: FormPatch }
  | { readonly op: 'move_result'; readonly resultId: string; readonly index: number }
  | { readonly op: 'delete_result'; readonly resultId: string }
  /** The form itself: its mode, its name and the words above the first question. */
  | { readonly op: 'set_form'; readonly patch: FormPatch }
  | { readonly op: 'set_scoring'; readonly patch: Partial<ScoringInput> }
  | { readonly op: 'set_on_submit'; readonly patch: Partial<OnSubmitInput> }
  | { readonly op: 'set_settings'; readonly patch: Partial<FormSettingsInput> };
export type FormOpName = FormOp['op'];

const loose = z.record(z.string(), z.unknown());
const index = z.int().min(0);

/** The shape of ops arriving over the wire; their contents are checked when they're applied. */
export const FormOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_page'), index: index.nullable(), page: loose }),
  z.object({ op: z.literal('update_page'), pageId: PageId, patch: loose }),
  z.object({ op: z.literal('move_page'), pageId: PageId, index }),
  z.object({ op: z.literal('delete_page'), pageId: PageId }),
  z.object({
    op: z.literal('add_question'),
    pageId: PageId,
    index: index.nullable(),
    question: loose,
  }),
  z.object({ op: z.literal('update_question'), questionId: QuestionId, patch: loose }),
  z.object({ op: z.literal('move_question'), questionId: QuestionId, pageId: PageId, index }),
  z.object({ op: z.literal('delete_question'), questionId: QuestionId }),
  z.object({
    op: z.literal('add_choice'),
    questionId: QuestionId,
    index: index.nullable(),
    choice: loose,
  }),
  z.object({ op: z.literal('delete_choice'), questionId: QuestionId, choiceId: ChoiceId }),
  z.object({ op: z.literal('add_calculation'), index: index.nullable(), calculation: loose }),
  z.object({ op: z.literal('update_calculation'), calculationId: CalculationId, patch: loose }),
  z.object({ op: z.literal('delete_calculation'), calculationId: CalculationId }),
  z.object({ op: z.literal('add_result'), index: index.nullable(), result: loose }),
  z.object({ op: z.literal('update_result'), resultId: ResultId, patch: loose }),
  z.object({ op: z.literal('move_result'), resultId: ResultId, index }),
  z.object({ op: z.literal('delete_result'), resultId: ResultId }),
  z.object({ op: z.literal('set_form'), patch: loose }),
  z.object({ op: z.literal('set_scoring'), patch: loose }),
  z.object({ op: z.literal('set_on_submit'), patch: loose }),
  z.object({ op: z.literal('set_settings'), patch: loose }),
]);
export const FormOpList = z.array(FormOpSchema).max(500);

export const FORM_OP_ERROR_CODES = [
  'page_not_found',
  'question_not_found',
  'choice_not_found',
  'calculation_not_found',
  'result_not_found',
  'index_out_of_range',
  'bad_patch',
  'duplicate_id',
  'last_page',
  'last_result',
  'invalid',
] as const;
export type FormOpErrorCode = (typeof FORM_OP_ERROR_CODES)[number];

export interface FormOpIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export class FormOpError extends Error {
  constructor(
    /** The op that failed, or the last one that touched what the batch ended up breaking. */
    readonly opIndex: number,
    readonly code: FormOpErrorCode,
    message: string,
    /** The question, page or result the trouble is on. */
    readonly targetId: string | null = null,
    readonly issues: readonly FormOpIssue[] = [],
  ) {
    super(message);
    this.name = 'FormOpError';
  }
}

export interface ApplyFormResult {
  readonly definition: FormDefinition;
  /** Applying these to `definition` gives back the original (Undo). */
  readonly inverse: FormOp[];
}

type Bag = Record<string, unknown>;
type Work = FormDefinition;

function fail(i: number, code: FormOpErrorCode, message: string, targetId: string | null = null): never {
  throw new FormOpError(i, code, message, targetId);
}

const pagesOf = (work: Work) => work.pages as unknown as Bag[];
const questionsOf = (page: Bag) => {
  if (!Array.isArray(page.questions)) page.questions = [];
  return page.questions as Bag[];
};
const calculationsOf = (work: Work) => work.calculations as unknown as Bag[];
const resultsOf = (work: Work) => work.results as unknown as Bag[];

function page(work: Work, pageId: string, i: number): Bag {
  const found = pagesOf(work).find((p) => p.id === pageId);
  if (!found) fail(i, 'page_not_found', 'That page isn’t in the form.', pageId);
  return found;
}

function question(work: Work, questionId: string, i: number): { page: Bag; list: Bag[]; at: number; question: Bag } {
  for (const p of pagesOf(work)) {
    const list = questionsOf(p);
    const at = list.findIndex((q) => q.id === questionId);
    if (at >= 0) return { page: p, list, at, question: list[at]! };
  }
  return fail(i, 'question_not_found', 'That question isn’t in the form.', questionId);
}

function place(list: unknown[], want: number | null, i: number, targetId: string | null): number {
  const at = want ?? list.length;
  if (!Number.isInteger(at) || at < 0 || at > list.length)
    fail(i, 'index_out_of_range', 'That position is outside the list.', targetId);
  return at;
}

/** Choices are edited in place by id, so an answer already given still points at the right one. */
function patchChoices(target: Bag, edits: unknown, i: number, questionId: string): unknown {
  const config = (target.config ?? {}) as Bag;
  if (!Array.isArray(config.choices))
    fail(i, 'bad_patch', 'That question has no choices.', questionId);
  const choices = config.choices as Bag[];
  const before = cloneJson(choices);
  if (!Array.isArray(edits)) fail(i, 'bad_patch', 'Choice changes come as a list.', questionId);
  for (const edit of edits as Bag[]) {
    const choice = isPlainObject(edit) ? choices.find((c) => c.id === edit.id) : undefined;
    if (!choice) fail(i, 'choice_not_found', 'That choice isn’t on this question.', questionId);
    for (const [key, value] of Object.entries(edit))
      if (key !== 'id' && value !== undefined) choice[key] = cloneJson(value);
  }
  // Every choice listed once and no others: that's a reorder as well as an edit.
  const ids = (edits as Bag[]).map((e) => e.id);
  if (ids.length === choices.length && new Set(ids).size === ids.length)
    config.choices = ids.map((id) => choices.find((c) => c.id === id)!);
  return before;
}

function updateQuestion(work: Work, op: Extract<FormOp, { op: 'update_question' }>, i: number): FormOp {
  const { question: target } = question(work, op.questionId, i);
  if (!isPlainObject(op.patch)) fail(i, 'bad_patch', 'A change must be an object.', op.questionId);
  const old: Bag = {};
  // A different type replaces the config, since the old one's fields mean nothing to the new type.
  const changesType = op.patch.type !== undefined && op.patch.type !== target.type;
  if (changesType) {
    old.type = target.type;
    old.config = cloneJson(target.config);
    target.type = op.patch.type;
    target.config = cloneJson(isPlainObject(op.patch.config) ? op.patch.config : {});
  }
  for (const [key, value] of Object.entries(op.patch)) {
    if (value === undefined) continue;
    if (changesType && (key === 'type' || key === 'config')) continue;
    if (key === 'id' && value !== target.id)
      fail(i, 'bad_patch', 'A question’s id can’t change.', op.questionId);
    if (key === 'config' && isPlainObject(value) && value.choices !== undefined) {
      const { choices, ...rest } = value;
      const beforeChoices = patchChoices(target, choices, i, op.questionId);
      const beforeRest: Bag = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v === undefined) continue;
        beforeRest[k] = cloneJson((target.config as Bag)[k]);
        (target.config as Bag)[k] = mergeJson((target.config as Bag)[k], v);
      }
      old.config = { ...beforeRest, choices: beforeChoices };
      continue;
    }
    old[key] = cloneJson(target[key]);
    target[key] = mergeJson(target[key], value);
  }
  return { op: 'update_question', questionId: op.questionId, patch: old };
}

/** Merges a patch into part of the form and returns the old values, for the inverse op. */
function patchInto(into: Bag, patch: FormPatch, i: number, what: string): Bag {
  if (!isPlainObject(patch)) fail(i, 'bad_patch', `${what} changes must be an object.`);
  const old: Bag = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    old[key] = cloneJson(into[key]);
    into[key] = mergeJson(into[key], value);
  }
  return old;
}

/** Applies one op to the working copy and returns its inverse. */
function applyOne(work: Work, op: FormOp, i: number): FormOp {
  switch (op.op) {
    case 'add_page': {
      if (!isPlainObject(op.page) || typeof op.page.id !== 'string')
        fail(i, 'invalid', 'A new page needs an id.');
      const pages = pagesOf(work);
      const at = place(pages, op.index, i, op.page.id);
      const added = cloneJson(op.page) as unknown as Bag;
      if (!Array.isArray(added.questions)) added.questions = [];
      pages.splice(at, 0, added);
      return { op: 'delete_page', pageId: op.page.id };
    }
    case 'delete_page': {
      const pages = pagesOf(work);
      if (pages.length === 1) fail(i, 'last_page', 'A form needs a page.', op.pageId);
      const at = pages.findIndex((p) => p.id === op.pageId);
      if (at < 0) fail(i, 'page_not_found', 'That page isn’t in the form.', op.pageId);
      const [removed] = pages.splice(at, 1);
      return { op: 'add_page', index: at, page: removed as unknown as FormPageInput };
    }
    case 'move_page': {
      const pages = pagesOf(work);
      const from = pages.findIndex((p) => p.id === op.pageId);
      if (from < 0) fail(i, 'page_not_found', 'That page isn’t in the form.', op.pageId);
      const [moved] = pages.splice(from, 1);
      const at = place(pages, op.index, i, op.pageId);
      pages.splice(at, 0, moved!);
      return { op: 'move_page', pageId: op.pageId, index: from };
    }
    case 'update_page': {
      const target = page(work, op.pageId, i);
      if (op.patch.questions !== undefined)
        fail(i, 'bad_patch', 'Change a page’s questions with question ops.', op.pageId);
      if (op.patch.id !== undefined && op.patch.id !== target.id)
        fail(i, 'bad_patch', 'A page’s id can’t change.', op.pageId);
      return { op: 'update_page', pageId: op.pageId, patch: patchInto(target, op.patch, i, 'Page') };
    }
    case 'add_question': {
      if (!isPlainObject(op.question) || typeof op.question.id !== 'string')
        fail(i, 'invalid', 'A new question needs an id.');
      const list = questionsOf(page(work, op.pageId, i));
      const at = place(list, op.index, i, op.question.id);
      list.splice(at, 0, cloneJson(op.question) as unknown as Bag);
      return { op: 'delete_question', questionId: op.question.id };
    }
    case 'delete_question': {
      const found = question(work, op.questionId, i);
      found.list.splice(found.at, 1);
      return {
        op: 'add_question',
        pageId: String(found.page.id),
        index: found.at,
        question: found.question as unknown as QuestionInput,
      };
    }
    case 'move_question': {
      const found = question(work, op.questionId, i);
      const fromPage = String(found.page.id);
      found.list.splice(found.at, 1);
      const list = questionsOf(page(work, op.pageId, i));
      const at = place(list, op.index, i, op.questionId);
      list.splice(at, 0, found.question);
      return { op: 'move_question', questionId: op.questionId, pageId: fromPage, index: found.at };
    }
    case 'update_question':
      return updateQuestion(work, op, i);
    case 'add_choice': {
      const { question: target } = question(work, op.questionId, i);
      const config = (target.config ?? {}) as Bag;
      if (!Array.isArray(config.choices))
        fail(i, 'bad_patch', 'That question has no choices.', op.questionId);
      if (!isPlainObject(op.choice) || typeof op.choice.id !== 'string')
        fail(i, 'invalid', 'A new choice needs an id.', op.questionId);
      const choices = config.choices as Bag[];
      const at = place(choices, op.index, i, op.questionId);
      choices.splice(at, 0, cloneJson(op.choice) as unknown as Bag);
      return { op: 'delete_choice', questionId: op.questionId, choiceId: op.choice.id };
    }
    case 'delete_choice': {
      const { question: target } = question(work, op.questionId, i);
      const config = (target.config ?? {}) as Bag;
      if (!Array.isArray(config.choices))
        fail(i, 'bad_patch', 'That question has no choices.', op.questionId);
      const choices = config.choices as Bag[];
      const at = choices.findIndex((c) => c.id === op.choiceId);
      if (at < 0) fail(i, 'choice_not_found', 'That choice isn’t on this question.', op.questionId);
      const [removed] = choices.splice(at, 1);
      return {
        op: 'add_choice',
        questionId: op.questionId,
        index: at,
        choice: removed as unknown as QuestionChoiceInput,
      };
    }
    case 'add_calculation': {
      if (!isPlainObject(op.calculation) || typeof op.calculation.id !== 'string')
        fail(i, 'invalid', 'A new calculation needs an id.');
      const list = calculationsOf(work);
      const at = place(list, op.index, i, op.calculation.id);
      list.splice(at, 0, cloneJson(op.calculation) as unknown as Bag);
      return { op: 'delete_calculation', calculationId: op.calculation.id };
    }
    case 'update_calculation': {
      const target = calculationsOf(work).find((c) => c.id === op.calculationId);
      if (!target)
        fail(i, 'calculation_not_found', 'That calculation isn’t in the form.', op.calculationId);
      return {
        op: 'update_calculation',
        calculationId: op.calculationId,
        patch: patchInto(target, op.patch, i, 'Calculation'),
      };
    }
    case 'delete_calculation': {
      const list = calculationsOf(work);
      const at = list.findIndex((c) => c.id === op.calculationId);
      if (at < 0)
        fail(i, 'calculation_not_found', 'That calculation isn’t in the form.', op.calculationId);
      const [removed] = list.splice(at, 1);
      return {
        op: 'add_calculation',
        index: at,
        calculation: removed as unknown as CalculationInput,
      };
    }
    case 'add_result': {
      if (!isPlainObject(op.result) || typeof op.result.id !== 'string')
        fail(i, 'invalid', 'A new result needs an id.');
      const list = resultsOf(work);
      const at = place(list, op.index, i, op.result.id);
      list.splice(at, 0, cloneJson(op.result) as unknown as Bag);
      return { op: 'delete_result', resultId: op.result.id };
    }
    case 'update_result': {
      const target = resultsOf(work).find((r) => r.id === op.resultId);
      if (!target) fail(i, 'result_not_found', 'That result isn’t in the form.', op.resultId);
      return {
        op: 'update_result',
        resultId: op.resultId,
        patch: patchInto(target, op.patch, i, 'Result'),
      };
    }
    case 'move_result': {
      const list = resultsOf(work);
      const from = list.findIndex((r) => r.id === op.resultId);
      if (from < 0) fail(i, 'result_not_found', 'That result isn’t in the form.', op.resultId);
      const [moved] = list.splice(from, 1);
      const at = place(list, op.index, i, op.resultId);
      list.splice(at, 0, moved!);
      return { op: 'move_result', resultId: op.resultId, index: from };
    }
    case 'delete_result': {
      const list = resultsOf(work);
      if (list.length === 1) fail(i, 'last_result', 'A form needs somewhere to land.', op.resultId);
      const at = list.findIndex((r) => r.id === op.resultId);
      if (at < 0) fail(i, 'result_not_found', 'That result isn’t in the form.', op.resultId);
      const [removed] = list.splice(at, 1);
      return { op: 'add_result', index: at, result: removed as unknown as FormResultInput };
    }
    case 'set_form': {
      const allowed = new Set(['mode', 'title', 'intro']);
      for (const key of Object.keys(op.patch))
        if (!allowed.has(key))
          fail(i, 'bad_patch', `Change ${key} with its own op.`);
      return { op: 'set_form', patch: patchInto(work as unknown as Bag, op.patch, i, 'Form') };
    }
    case 'set_scoring':
      return {
        op: 'set_scoring',
        patch: patchInto(work.scoring as unknown as Bag, op.patch, i, 'Scoring') as Partial<ScoringInput>,
      };
    case 'set_on_submit':
      return {
        op: 'set_on_submit',
        patch: patchInto(work.onSubmit as unknown as Bag, op.patch, i, 'Submit') as Partial<OnSubmitInput>,
      };
    case 'set_settings':
      return {
        op: 'set_settings',
        patch: patchInto(
          work.settings as unknown as Bag,
          op.patch,
          i,
          'Settings',
        ) as Partial<FormSettingsInput>,
      };
    default: {
      const unknown: { op?: unknown } = op;
      return fail(i, 'invalid', `Unknown op ${String(unknown.op)}.`);
    }
  }
}

/** Ids used twice over, which no form may be saved with. */
function duplicateIds(definition: FormDefinition): { id: string; message: string } | null {
  const seen = new Set<string>();
  const check = (id: string, what: string): { id: string; message: string } | null => {
    if (seen.has(id)) return { id, message: `Two ${what} share the id ${id}.` };
    seen.add(id);
    return null;
  };
  for (const page of definition.pages) {
    const problem = check(page.id, 'pages');
    if (problem) return problem;
    for (const question of page.questions) {
      const q = check(question.id, 'questions');
      if (q) return q;
      const choices = (question.config as { choices?: { id: string }[] }).choices ?? [];
      for (const choice of choices) {
        const c = check(choice.id, 'choices');
        if (c) return { id: question.id, message: c.message };
      }
    }
  }
  for (const calculation of definition.calculations) {
    const problem = check(calculation.id, 'calculations');
    if (problem) return problem;
  }
  for (const result of definition.results) {
    const problem = check(result.id, 'results');
    if (problem) return problem;
  }
  return null;
}

/** The ids an op touches, for pinning a batch-level problem on the op most likely to blame. */
function touched(op: FormOp): string[] {
  switch (op.op) {
    case 'add_page':
      return [String((op.page as { id?: unknown }).id ?? '')];
    case 'add_question':
      return [op.pageId, String((op.question as { id?: unknown }).id ?? '')];
    case 'add_choice':
      return [op.questionId, String((op.choice as { id?: unknown }).id ?? '')];
    case 'add_calculation':
      return [String((op.calculation as { id?: unknown }).id ?? '')];
    case 'add_result':
      return [String((op.result as { id?: unknown }).id ?? '')];
    case 'update_page':
    case 'move_page':
    case 'delete_page':
      return [op.pageId];
    case 'update_question':
    case 'delete_question':
      return [op.questionId];
    case 'move_question':
      return [op.questionId, op.pageId];
    case 'delete_choice':
      return [op.questionId, op.choiceId];
    case 'update_calculation':
    case 'delete_calculation':
      return [op.calculationId];
    case 'update_result':
    case 'move_result':
    case 'delete_result':
      return [op.resultId];
    default:
      return [];
  }
}

const AREA_OPS: Readonly<Record<string, FormOpName>> = {
  scoring: 'set_scoring',
  onSubmit: 'set_on_submit',
  settings: 'set_settings',
};

function blame(ops: readonly FormOp[], targetId: string | null, area: FormOpName | null): number {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    if (area && op.op === area) return i;
    if (targetId && touched(op).includes(targetId)) return i;
  }
  return Math.max(0, ops.length - 1);
}

/** The innermost question, page or result a zod issue runs through. */
function targetAtPath(root: unknown, path: readonly PropertyKey[]): string | null {
  let at: unknown = root;
  let found: string | null = null;
  for (const key of path) {
    if (!at || typeof at !== 'object') break;
    at = (at as Record<PropertyKey, unknown>)[key];
    if (isPlainObject(at) && typeof at.id === 'string') found = at.id;
  }
  return found;
}

/** Applies ops all or nothing. Throws a FormOpError naming the op that failed. */
export function applyFormOps(definition: FormDefinition, ops: readonly FormOp[]): ApplyFormResult {
  const work = cloneJson(definition);
  const inverse: FormOp[] = [];
  ops.forEach((op, i) => inverse.unshift(applyOne(work, op, i)));
  const parsed = FormDefinition.safeParse(work);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((x) => ({
      path: x.path as (string | number)[],
      message: x.message,
    }));
    const first = parsed.error.issues[0]!;
    const targetId = targetAtPath(work, first.path);
    const area = AREA_OPS[String(first.path[0] ?? '')] ?? null;
    throw new FormOpError(blame(ops, targetId, area), 'invalid', first.message, targetId, issues);
  }
  const duplicate = duplicateIds(parsed.data);
  if (duplicate)
    throw new FormOpError(
      blame(ops, duplicate.id, null),
      'duplicate_id',
      duplicate.message,
      duplicate.id,
    );
  return { definition: parsed.data, inverse };
}

/**
 * Applies ops without the final parse, for previews and for describing a batch op by op. Throws a
 * FormOpError for an op that can't be placed.
 */
export function applyFormOpsUnchecked(
  definition: FormDefinition,
  ops: readonly FormOp[],
): FormDefinition {
  const work = cloneJson(definition);
  ops.forEach((op, i) => applyOne(work, op, i));
  return work;
}

/** The questions as a flat list with the page they sit on, handy for tests and previews. */
export function formOutline(definition: FormDefinition): string[] {
  return definition.pages.flatMap((page) => [
    `${page.id}:page`,
    ...page.questions.map((q) => `  ${q.id}:${q.type}`),
  ]);
}
