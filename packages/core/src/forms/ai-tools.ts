/**
 * The AI builder's tools: flat, strict tool definitions (recursive schemas aren't supported), and
 * `formToolCallsToOps`, which turns the model's calls into patch ops — checking each one and applying it to
 * a working copy, so a bad call goes back to the model as a tool error it can repair rather than a form
 * that quietly half-changed.
 *
 * The model never sees a form's JSON to rewrite. It asks for one change at a time, in the same ops a person
 * makes by clicking, which is why "add a budget question and make the phone one required" ends up as a diff
 * a business can read before agreeing to it.
 */
import { z } from 'zod';
import { cloneJson, isPlainObject } from '../workflows/json';
import { allQuestions, type FormDefinition, type Question } from './definition';
import {
  newCalculationId,
  newChoiceId,
  newPageId,
  newQuestionId,
  newResultId,
  PAGE_ID_RE,
  QUESTION_ID_RE,
} from './ids';
import { applyFormOps, FormOpError, type FormOp } from './ops';
import { ANSWER_TARGET_KEYS, QUESTION_CONFIGS, QUESTION_TYPES } from './questions';

/** The same shape workflows' builder uses; named apart so both can be exported from the package. */
type FormJsonSchema = Readonly<Record<string, unknown>>;

export interface FormToolDef {
  readonly name: FormToolName;
  readonly description: string;
  readonly inputSchema: FormJsonSchema;
  readonly strict: true;
}

const str = (description: string): FormJsonSchema => ({ type: 'string', description });
const int = (description: string): FormJsonSchema => ({ type: 'integer', description });
const bool = (description: string): FormJsonSchema => ({ type: 'boolean', description });
const nullable = (schema: FormJsonSchema): FormJsonSchema => {
  const { description, ...rest } = schema;
  return { description, anyOf: [rest, { type: 'null' }] };
};
const oneOf = (values: readonly string[], description: string): FormJsonSchema => ({
  type: 'string',
  enum: [...values],
  description,
});
const obj = (properties: Record<string, FormJsonSchema>): FormJsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const questionRef = str(
  'A question id (q_…) or a ref you gave a question added earlier in this reply.',
);

export const FORM_TOOL_NAMES = [
  'add_question',
  'update_question',
  'move_question',
  'delete_question',
  'add_page',
  'add_calculation',
  'add_result',
  'set_form',
  'set_scoring',
  'set_on_submit',
  'set_settings',
  'finish',
] as const;
export type FormToolName = (typeof FORM_TOOL_NAMES)[number];

export const FORM_BUILDER_TOOLS: readonly FormToolDef[] = [
  {
    name: 'add_question',
    description:
      'Add one question to the end of a page. Choices for a pick-one or pick-any go in json as {"choices": [{"label": "…"}]} — ids are made here. To fill in a field on the customer, set mapTo.',
    inputSchema: obj({
      ref: nullable(str('A short name for it (e.g. "budget") so later calls can point at it.')),
      pageId: nullable(str('Which page; null is the last one, which is right for most forms.')),
      index: nullable(int('Position on that page, 0 first; null adds it at the end.')),
      type: oneOf(QUESTION_TYPES, 'What kind of question.'),
      title: str('What the customer reads.'),
      help: nullable(str('The smaller line underneath.')),
      required: nullable(bool('Whether it must be answered. Default: no.')),
      mapTo: nullable(
        oneOf(
          ANSWER_TARGET_KEYS,
          'The field on the customer or the lead this answer fills in, or null to keep it on the response.',
        ),
      ),
      json: nullable(
        str(
          'The question’s own settings as a JSON object (choices, min, max, statement…), or null. A video takes {"url": "a YouTube, Vimeo or Loom link", "minPercent": 80} — minPercent holds the Next button until they have watched that much, null lets them move on.',
        ),
      ),
      showIfJson: nullable(
        str(
          'When to show it, as a JSON condition group: {"match":"all","conditions":[{"source":{"kind":"question","questionId":"…"},"op":"is","value":"…"}]}. Only questions asked earlier.',
        ),
      ),
    }),
    strict: true,
  },
  {
    name: 'update_question',
    description:
      'Change a question with a JSON merge patch: objects merge, lists and null replace. Its own settings go under "config"; a new "type" replaces them. Choices are edited by id under config.choices: [{"id", "label"}]. In a live poll, "live" holds {"seconds": 60, "showResults": false, "cues": ["what the presenter might say just before asking it"], "points": {"c_…": 10}}; points are what each answer says about how ready someone is (-100 to 100), by a choice’s id, "yes" and "no", a rating or scale’s number, "answered" for a short answer or "pressed" for a button, and are replaced whole.',
    inputSchema: obj({
      questionId: questionRef,
      json: str('The merge patch as a JSON object.'),
    }),
    strict: true,
  },
  {
    name: 'move_question',
    description: 'Move a question to another place, which changes the order it is asked in.',
    inputSchema: obj({
      questionId: questionRef,
      pageId: nullable(str('Which page; null keeps it on the one it is on.')),
      index: int('Position on that page once it is taken out, 0 first.'),
    }),
    strict: true,
  },
  {
    name: 'delete_question',
    description: 'Take a question off the form. Answers already given to it are not touched.',
    inputSchema: obj({ questionId: questionRef }),
    strict: true,
  },
  {
    name: 'add_page',
    description:
      'Add a page. Only worth it for a long form or a step-by-step funnel (a video, then their details, then more); most forms are one page, and "one question at a time" is a setting rather than a page each. For steps, also set onePageAtATime with set_settings.',
    inputSchema: obj({
      ref: nullable(str('A short name for it so later add_question calls can point at it.')),
      title: nullable(str('The heading above its questions.')),
    }),
    strict: true,
  },
  {
    name: 'add_calculation',
    description:
      'Work something out from the answers: the terms are multiplied out and added up. "1200 sq ft × $3.50 plus a $75 trip fee" is two terms. json: {"name":"Quote","terms":[{"factors":[{"kind":"question","questionId":"q_…"},{"kind":"number","value":3.5}]},{"factors":[{"kind":"number","value":75}]}],"format":"money"}',
    inputSchema: obj({
      ref: nullable(str('A short name for it so later calls can point at it.')),
      json: str('The calculation as a JSON object, without an id.'),
    }),
    strict: true,
  },
  {
    name: 'add_result',
    description:
      'Add somewhere for people to land. Every form already has a thank-you screen; add more only for a quiz or a recommendation, with showIfJson deciding who sees which.',
    inputSchema: obj({
      ref: nullable(str('A short name for it.')),
      name: str('What the business calls it.'),
      headline: str('What the person reads.'),
      body: nullable(str('The paragraph under the headline.')),
      showIfJson: nullable(str('When they land here, as a JSON condition group.')),
    }),
    strict: true,
  },
  {
    name: 'set_form',
    description:
      'The form itself: which kind it is, its heading, the words at the top, and a live poll’s follow-up.',
    inputSchema: obj({
      mode: nullable(
        oneOf(
          ['form', 'survey', 'quiz', 'poll'],
          'Which kind it is. poll: a live poll, whose questions pop up one at a time during a HandsFreeOS video call or webinar.',
        ),
      ),
      title: nullable(str('The heading the customer reads.')),
      intro: nullable(str('The words above the first question.')),
      leadsJson: nullable(
        str(
          'A live poll only: who to follow up with after the call, as JSON {"stayed": 10, "hot": 30, "warm": 10, "hotAction": "text"}. Points for staying to the end; Hot from and Warm from so many points (Warm below Hot); and what happens to hot ones: list (just the ranked list), home (a card on Home too) or text (the AI teammate texts them, the default).',
        ),
      ),
    }),
    strict: true,
  },
  {
    name: 'set_scoring',
    description:
      'Quiz scoring: whether it is scored, the pass mark as a percentage, and whether people see their score.',
    inputSchema: obj({ json: str('The scoring settings as a JSON object.') }),
    strict: true,
  },
  {
    name: 'set_on_submit',
    description:
      'What happens when somebody sends it: the customer, a lead, a task, the workflows it starts. json: {"lead":{"pipelineId":"…","stageId":"…","title":"…"},"workflowIds":["…"]}',
    inputSchema: obj({ json: str('The merge patch as a JSON object.') }),
    strict: true,
  },
  {
    name: 'set_settings',
    description:
      'How it behaves: identity (required, optional or anonymous), one question at a time (oneQuestionAtATime), one page at a time with Back and Next (onePageAtATime), the button’s words, when it closes.',
    inputSchema: obj({ json: str('The merge patch as a JSON object.') }),
    strict: true,
  },
  {
    name: 'finish',
    description:
      'Say you are done, with one sentence about what this form does. Call it once, last.',
    inputSchema: obj({ summary: str('One sentence, in the business’s own words.') }),
    strict: true,
  },
];

// ---- Turning calls into ops ----

export interface AiFormCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface AiFormResult {
  readonly id: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface AiFormConversion {
  readonly ops: FormOp[];
  readonly definition: FormDefinition;
  readonly results: AiFormResult[];
  readonly finish: { readonly summary: string } | null;
}

class CallError extends Error {}

const INPUTS = {
  add_question: z.object({
    ref: z.string().nullish(),
    pageId: z.string().nullish(),
    index: z.number().int().min(0).nullish(),
    type: z.enum(QUESTION_TYPES),
    title: z.string().trim().min(1).max(300),
    help: z.string().max(500).nullish(),
    required: z.boolean().nullish(),
    mapTo: z.string().nullish(),
    json: z.string().nullish(),
    showIfJson: z.string().nullish(),
  }),
  update_question: z.object({ questionId: z.string(), json: z.string() }),
  move_question: z.object({
    questionId: z.string(),
    pageId: z.string().nullish(),
    index: z.number().int().min(0),
  }),
  delete_question: z.object({ questionId: z.string() }),
  add_page: z.object({ ref: z.string().nullish(), title: z.string().max(160).nullish() }),
  add_calculation: z.object({ ref: z.string().nullish(), json: z.string() }),
  add_result: z.object({
    ref: z.string().nullish(),
    name: z.string().trim().min(1).max(80),
    headline: z.string().trim().min(1).max(200),
    body: z.string().max(4000).nullish(),
    showIfJson: z.string().nullish(),
  }),
  set_form: z.object({
    mode: z.enum(['form', 'survey', 'quiz', 'poll']).nullish(),
    title: z.string().max(160).nullish(),
    intro: z.string().max(4000).nullish(),
    leadsJson: z.string().nullish(),
  }),
  set_scoring: z.object({ json: z.string() }),
  set_on_submit: z.object({ json: z.string() }),
  set_settings: z.object({ json: z.string() }),
  finish: z.object({ summary: z.string().trim().min(1).max(500) }),
};

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CallError(`${what} isn’t valid JSON.`);
  }
  if (!isPlainObject(value)) throw new CallError(`${what} must be a JSON object.`);
  return value;
}

const zodMessage = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
    .join('; ');

/**
 * Turns the model's calls into validated ops. Each call is checked and applied to a working copy in turn; a
 * failing call is left out and reported back, and later calls see the form as the good ones left it.
 */
export function formToolCallsToOps(
  calls: readonly AiFormCall[],
  definition: FormDefinition,
  random?: () => number,
): AiFormConversion {
  let work = definition;
  const ops: FormOp[] = [];
  const results: AiFormResult[] = [];
  const questionRefs: Record<string, string> = {};
  const pageRefs: Record<string, string> = {};
  const otherRefs: Record<string, string> = {};
  let finish: AiFormConversion['finish'] = null;

  const questionId = (value: string): string => {
    if (QUESTION_ID_RE.test(value)) return value;
    const id = questionRefs[value];
    if (!id) throw new CallError(`There’s no question “${value}”.`);
    return id;
  };
  const pageId = (value: string | null | undefined): string => {
    if (!value) return work.pages[work.pages.length - 1]!.id;
    if (PAGE_ID_RE.test(value)) return value;
    const id = pageRefs[value];
    if (!id) throw new CallError(`There’s no page “${value}”.`);
    return id;
  };
  const checked = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new CallError(`${what}: ${zodMessage(parsed.error)}`);
    return parsed.data;
  };
  /** Choices arrive with labels only; ids are made here so nothing the model writes can collide. */
  const withChoiceIds = (config: Record<string, unknown>): Record<string, unknown> => {
    if (!Array.isArray(config.choices)) return config;
    return {
      ...config,
      choices: config.choices.map((choice) =>
        isPlainObject(choice) ? { ...choice, id: newChoiceId(random) } : choice,
      ),
    };
  };

  const toOps = (name: FormToolName, raw: unknown): FormOp[] => {
    switch (name) {
      case 'add_question': {
        const input = checked(INPUTS.add_question, raw, 'The call');
        const config = withChoiceIds(input.json ? parseJsonObject(input.json, 'json') : {});
        const parsedConfig = QUESTION_CONFIGS[input.type].safeParse(config);
        if (!parsedConfig.success)
          throw new CallError(
            `Those settings don’t fit a ${input.type}: ${zodMessage(parsedConfig.error)}`,
          );
        const id = newQuestionId(random);
        if (input.ref) {
          if (questionRefs[input.ref])
            throw new CallError(`The ref “${input.ref}” is already used.`);
          questionRefs[input.ref] = id;
        }
        const showIf = input.showIfJson
          ? parseJsonObject(input.showIfJson, 'showIfJson')
          : undefined;
        return [
          {
            op: 'add_question',
            pageId: pageId(input.pageId),
            index: input.index ?? null,
            question: {
              id,
              type: input.type,
              title: input.title,
              ...(input.help ? { help: input.help } : {}),
              ...(input.required ? { required: true } : {}),
              ...(input.mapTo ? { mapTo: input.mapTo } : {}),
              ...(showIf ? { showIf } : {}),
              config: parsedConfig.data,
            } as never,
          },
        ];
      }
      case 'update_question': {
        const input = checked(INPUTS.update_question, raw, 'The call');
        const patch = parseJsonObject(input.json, 'json');
        delete patch.id;
        return [{ op: 'update_question', questionId: questionId(input.questionId), patch }];
      }
      case 'move_question': {
        const input = checked(INPUTS.move_question, raw, 'The call');
        const id = questionId(input.questionId);
        const page = input.pageId
          ? pageId(input.pageId)
          : (work.pages.find((p) => p.questions.some((q) => q.id === id))?.id ?? pageId(null));
        return [{ op: 'move_question', questionId: id, pageId: page, index: input.index }];
      }
      case 'delete_question': {
        const input = checked(INPUTS.delete_question, raw, 'The call');
        return [{ op: 'delete_question', questionId: questionId(input.questionId) }];
      }
      case 'add_page': {
        const input = checked(INPUTS.add_page, raw, 'The call');
        const id = newPageId(random);
        if (input.ref) pageRefs[input.ref] = id;
        return [
          { op: 'add_page', index: null, page: { id, title: input.title ?? '', questions: [] } },
        ];
      }
      case 'add_calculation': {
        const input = checked(INPUTS.add_calculation, raw, 'The call');
        const json = parseJsonObject(input.json, 'json');
        const id = newCalculationId(random);
        if (input.ref) otherRefs[input.ref] = id;
        // A calculation may name questions by the refs used earlier in this same reply.
        const terms = Array.isArray(json.terms)
          ? json.terms.map((term) =>
              isPlainObject(term) && Array.isArray(term.factors)
                ? {
                    ...term,
                    factors: term.factors.map((factor) =>
                      isPlainObject(factor) &&
                      factor.kind === 'question' &&
                      typeof factor.questionId === 'string'
                        ? { ...factor, questionId: questionId(factor.questionId) }
                        : factor,
                    ),
                  }
                : term,
            )
          : json.terms;
        return [
          { op: 'add_calculation', index: null, calculation: { ...json, terms, id } as never },
        ];
      }
      case 'add_result': {
        const input = checked(INPUTS.add_result, raw, 'The call');
        const id = newResultId(random);
        if (input.ref) otherRefs[input.ref] = id;
        const showIf = input.showIfJson
          ? parseJsonObject(input.showIfJson, 'showIfJson')
          : undefined;
        return [
          {
            op: 'add_result',
            // Before the fallback, so a rule that matches wins over the thank-you screen.
            index: Math.max(0, work.results.length - 1),
            result: {
              id,
              name: input.name,
              headline: input.headline,
              ...(input.body ? { body: input.body } : {}),
              ...(showIf ? { showIf } : {}),
            } as never,
          },
        ];
      }
      case 'set_form': {
        const input = checked(INPUTS.set_form, raw, 'The call');
        const patch: Record<string, unknown> = {};
        if (input.mode) patch.mode = input.mode;
        if (input.title) patch.title = input.title;
        if (input.intro !== null && input.intro !== undefined) patch.intro = input.intro;
        if (input.leadsJson) patch.leads = parseJsonObject(input.leadsJson, 'leadsJson');
        if (!Object.keys(patch).length) throw new CallError('Nothing to change.');
        return [{ op: 'set_form', patch }];
      }
      case 'set_scoring':
        return [
          {
            op: 'set_scoring',
            patch: parseJsonObject(checked(INPUTS.set_scoring, raw, 'The call').json, 'json'),
          },
        ];
      case 'set_on_submit':
        return [
          {
            op: 'set_on_submit',
            patch: parseJsonObject(checked(INPUTS.set_on_submit, raw, 'The call').json, 'json'),
          },
        ];
      case 'set_settings':
        return [
          {
            op: 'set_settings',
            patch: parseJsonObject(checked(INPUTS.set_settings, raw, 'The call').json, 'json'),
          },
        ];
      case 'finish': {
        const input = checked(INPUTS.finish, raw, 'The call');
        finish = { summary: input.summary };
        return [];
      }
    }
  };

  for (const call of calls) {
    if (!(FORM_TOOL_NAMES as readonly string[]).includes(call.name)) {
      results.push({ id: call.id, ok: false, message: `There’s no tool called ${call.name}.` });
      continue;
    }
    try {
      const made = toOps(call.name as FormToolName, call.arguments);
      if (made.length) {
        const applied = applyFormOps(work, made);
        work = applied.definition;
        ops.push(...made);
      }
      results.push({ id: call.id, ok: true, message: doneMessage(made) });
    } catch (e) {
      const message =
        e instanceof CallError || e instanceof FormOpError
          ? e.message
          : 'That change didn’t work. Try a smaller one.';
      results.push({ id: call.id, ok: false, message });
    }
  }

  return { ops, definition: work, results, finish };
}

/** What a call that worked tells the model: the ids it made, so a later reply can point at them. */
function doneMessage(ops: readonly FormOp[]): string {
  const op = ops[0];
  if (!op) return 'Done.';
  if (op.op === 'add_question') {
    const question = op.question as {
      id?: string;
      config?: { choices?: { id: string; label: string }[] };
    };
    const choices = question.config?.choices ?? [];
    const ids = choices.map((c) => `${c.label} is ${c.id}`).join(', ');
    return `Done. The question’s id is ${question.id}${ids ? `; its choices: ${ids}` : ''}.`;
  }
  if (op.op === 'add_page') return `Done. The page’s id is ${(op.page as { id: string }).id}.`;
  if (op.op === 'add_calculation')
    return `Done. The calculation’s id is ${(op.calculation as { id: string }).id}.`;
  if (op.op === 'add_result')
    return `Done. The result’s id is ${(op.result as { id: string }).id}.`;
  return 'Done.';
}

/** The form as the model should read it before changing anything: ids, questions and what they are. */
export function formForModel(definition: FormDefinition): string {
  const lines = [
    `Mode: ${definition.mode}. Heading: ${definition.title}.`,
    ...definition.pages.flatMap((page, i) => [
      `Page ${i + 1} (${page.id})${page.title ? `: ${page.title}` : ''}`,
      ...page.questions.map((question: Question) => {
        const choices = (question.config as { choices?: { id: string; label: string }[] }).choices;
        return `  ${question.id} · ${question.type} · ${question.title}${
          question.required ? ' · required' : ''
        }${choices ? ` · choices: ${choices.map((c) => `${c.label}=${c.id}`).join(', ')}` : ''}`;
      }),
    ]),
  ];
  for (const calculation of definition.calculations)
    lines.push(`Calculation ${calculation.id}: ${calculation.name}`);
  for (const result of definition.results) lines.push(`Result ${result.id}: ${result.name}`);
  if (!allQuestions(definition).length) lines.push('It asks nothing yet.');
  return lines.join('\n');
}

/** A copy of a definition, for a builder that works on a scratch form. */
export const copyForm = (definition: FormDefinition): FormDefinition => cloneJson(definition);
