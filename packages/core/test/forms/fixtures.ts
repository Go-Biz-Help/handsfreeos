import {
  FormDefinition,
  type FormDefinitionInput,
  type FormPageInput,
  type FormResultInput,
  type QuestionInput,
} from '../../src/forms/index';

/** Readable ids in the right shape: `qid('sqft')` is always the same `q_…`. */
const id = (prefix: string) => (name: string) =>
  `${prefix}_${name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .padEnd(8, '0')
    .slice(0, 8)}`;

export const qid = id('q');
export const pid = id('p');
export const cid = id('c');
export const kid = id('k');
export const rid = id('r');

export const choice = (name: string, extra: Record<string, unknown> = {}) => ({
  id: cid(name),
  label: name,
  ...extra,
});

/** The spread widens `type`, so each helper says which member of the union it is making. */
export const shortText = (name: string, extra: Partial<QuestionInput> = {}): QuestionInput =>
  ({ id: qid(name), type: 'short_text', title: name, config: {}, ...extra }) as QuestionInput;

export const number = (name: string, extra: Partial<QuestionInput> = {}): QuestionInput =>
  ({ id: qid(name), type: 'number', title: name, config: {}, ...extra }) as QuestionInput;

export const pickOne = (
  name: string,
  choices: ReturnType<typeof choice>[],
  extra: Partial<QuestionInput> = {},
): QuestionInput =>
  ({ id: qid(name), type: 'choice', title: name, config: { choices }, ...extra }) as QuestionInput;

export const pickAny = (
  name: string,
  choices: ReturnType<typeof choice>[],
  extra: Partial<QuestionInput> = {},
): QuestionInput =>
  ({
    id: qid(name),
    type: 'checkboxes',
    title: name,
    config: { choices },
    ...extra,
  }) as QuestionInput;

export const page = (
  name: string,
  questions: QuestionInput[],
  extra: Partial<FormPageInput> = {},
): FormPageInput => ({
  id: pid(name),
  title: name,
  questions,
  ...extra,
});

export const result = (name: string, extra: Partial<FormResultInput> = {}): FormResultInput => ({
  id: rid(name),
  name,
  headline: `${name}!`,
  ...extra,
});

/** A parsed definition with sensible defaults; anything passed in wins. */
export function def(input: Partial<FormDefinitionInput> = {}): FormDefinition {
  return FormDefinition.parse({
    title: 'Get a quote',
    pages: [page('about', [shortText('name')])],
    results: [result('thanks')],
    ...input,
  });
}

/** The same, but returning zod's answer so a test can look at what went wrong. */
export function tryDef(input: Partial<FormDefinitionInput>) {
  return FormDefinition.safeParse({
    title: 'Get a quote',
    pages: [page('about', [shortText('name')])],
    results: [result('thanks')],
    ...input,
  });
}
