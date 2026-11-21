import { describe, expect, it } from 'vitest';
import {
  allQuestions,
  answerProblem,
  applyFormOps,
  describeFormOp,
  formProblems,
  formState,
  questionLine,
  quantitiesWords,
  quantityTotalWords,
  quantityWorthCents,
  recordAnswers,
  responseProblems,
  runCalculations,
  choiceValues,
  starterForm,
  ANSWER_THIS_ONE,
  type Question,
  type QuestionInput,
} from '../../src/forms/index';
import { patchesFromAnswers } from '../../src/forms/submit';
import { cid, def, page, qid, shortText } from './fixtures';

const row = (name: string, price: number | null = null) => ({ id: cid(name), label: name, price });

const grid = (
  name: string,
  rows: ReturnType<typeof row>[],
  extra: Partial<QuestionInput> & { config?: Record<string, unknown> } = {},
): QuestionInput =>
  ({
    id: qid(name),
    type: 'quantities',
    title: name,
    ...extra,
    config: { ...(extra.config ?? {}), choices: rows },
  }) as QuestionInput;

const shirts = [row('Adult M', 12), row('Adult L', 12), row('Adult 2XL', 14)];

const shirtForm = (extra: Parameters<typeof grid>[2] = {}) =>
  def({ pages: [page('about', [shortText('name'), grid('sizes', shirts, extra)])] });

const sizesOf = (form: ReturnType<typeof def>): Question =>
  allQuestions(form).find((q) => q.type === 'quantities')!;

describe('How many of each', () => {
  it('takes how many of each row, and nothing ordered is no answer', () => {
    const form = shirtForm({ required: true });
    const sizes = sizesOf(form);
    expect(answerProblem(sizes, { [cid('Adult M')]: 3 })).toBeNull();
    expect(answerProblem(sizes, null)).toBe(ANSWER_THIS_ONE);
    expect(answerProblem(sizes, {})).toBe(ANSWER_THIS_ONE);
    // Typing a row back to 0 is still nothing ordered.
    expect(answerProblem(sizes, { [cid('Adult M')]: 0 })).toBe(ANSWER_THIS_ONE);
  });

  it('turns away halves, negatives, rows it doesn’t have and silly amounts', () => {
    const sizes = sizesOf(shirtForm());
    expect(answerProblem(sizes, { [cid('Adult M')]: 1.5 })).toBe('Whole numbers only.');
    expect(answerProblem(sizes, { [cid('Adult M')]: -2 })).toBe('Whole numbers only.');
    expect(answerProblem(sizes, { [cid('Youth XS')]: 2 })).toMatch(/isn’t on the list/);
    expect(answerProblem(sizes, { [cid('Adult M')]: 20_000 })).toMatch(/Up to 10,000/);
  });

  it('holds them to the least and the most in all, in the words of what is counted', () => {
    const sizes = sizesOf(shirtForm({ config: { minTotal: 12, maxTotal: 100, unit: 'shirts' } }));
    expect(answerProblem(sizes, { [cid('Adult M')]: 5, [cid('Adult L')]: 3 })).toBe(
      'The least is 12 shirts in all. You have 8.',
    );
    expect(answerProblem(sizes, { [cid('Adult M')]: 101 })).toBe(
      'The most is 100 shirts in all. You have 101.',
    );
    expect(answerProblem(sizes, { [cid('Adult M')]: 6, [cid('Adult L')]: 6 })).toBeNull();
    // Optional and left empty: the least doesn't come into it.
    expect(answerProblem(sizes, {})).toBeNull();
  });

  it('says when the least is more than the most', () => {
    const form = shirtForm({ config: { minTotal: 50, maxTotal: 10 } });
    expect(formProblems(form).join(' ')).toMatch(/at least 50 and at most 10/);
  });

  it('records only the rows they ordered, with the order in words', () => {
    const form = shirtForm({ config: { unit: 'shirts' } });
    const sizes = sizesOf(form);
    const [, recorded] = recordAnswers(form, {
      [sizes.id]: { [cid('Adult M')]: 5, [cid('Adult L')]: 0, [cid('Adult 2XL')]: 2 },
    });
    expect(recorded!.value).toEqual({ [cid('Adult M')]: 5, [cid('Adult 2XL')]: 2 });
    expect(recorded!.words).toBe('Adult M × 5, Adult 2XL × 2 · 7 shirts · $88');
    // Nothing ordered isn't recorded at all.
    const [, none] = recordAnswers(form, { [sizes.id]: { [cid('Adult M')]: 0 } });
    expect(none!.value).toBeNull();
  });

  it('adds up the order in a calculation when its rows have prices, and counts them when not', () => {
    const priced = shirtForm();
    const order = { [sizesOf(priced).id]: { [cid('Adult M')]: 3, [cid('Adult 2XL')]: 1 } };
    const calc = {
      id: 'k_total000',
      name: 'Order total',
      terms: [{ factors: [{ kind: 'question' as const, questionId: qid('sizes') }] }],
      round: 'none' as const,
      min: null,
      max: null,
      format: 'money' as const,
      decimals: 0,
    };
    expect(runCalculations([calc], order, choiceValues(priced))['k_total000']).toBe(50);
    expect(quantityWorthCents(sizesOf(priced), order[sizesOf(priced).id])).toBe(5000);

    const counted = def({
      pages: [page('about', [grid('sizes', [row('Adult M'), row('Adult L')])])],
    });
    expect(
      runCalculations(
        [calc],
        { [qid('sizes')]: { [cid('Adult M')]: 3, [cid('Adult L')]: 4 } },
        choiceValues(counted),
      )['k_total000'],
    ).toBe(7);
  });

  it('counts a row with no price as nothing when the others have prices', () => {
    const form = def({
      pages: [page('about', [grid('sizes', [row('Adult M', 10.1), row('Sample')])])],
    });
    const worked = runCalculations(
      [
        {
          id: 'k_total000',
          name: 'Order total',
          terms: [{ factors: [{ kind: 'question', questionId: qid('sizes') }] }],
          round: 'none',
          min: null,
          max: null,
          format: 'money',
          decimals: 2,
        },
      ],
      { [qid('sizes')]: { [cid('Adult M')]: 3, [cid('Sample')]: 2 } },
      choiceValues(form),
    );
    expect(worked['k_total000']).toBe(30.3);
  });

  it('shows a question by how many in all, or by whether a row was ordered', () => {
    const form = def({
      pages: [
        page('about', [
          grid('sizes', shirts),
          shortText('bulk', {
            showIf: {
              match: 'all',
              conditions: [
                { source: { kind: 'question', questionId: qid('sizes') }, op: 'gte', value: 24 },
              ],
            },
          }),
          shortText('big sizes', {
            showIf: {
              match: 'all',
              conditions: [
                {
                  source: { kind: 'question', questionId: qid('sizes') },
                  op: 'includes',
                  value: cid('Adult 2XL'),
                },
              ],
            },
          }),
        ]),
      ],
    });
    const showing = (answer: Record<string, number>) =>
      formState(form, { [qid('sizes')]: answer }).questions.map((q) => q.title);
    expect(showing({ [cid('Adult M')]: 10 })).toEqual(['sizes']);
    expect(showing({ [cid('Adult M')]: 20, [cid('Adult L')]: 4 })).toContain('bulk');
    expect(showing({ [cid('Adult 2XL')]: 1 })).toContain('big sizes');
    expect(showing({ [cid('Adult 2XL')]: 0 })).not.toContain('big sizes');
  });

  it('puts what the order comes to on the lead when it fills in the lead’s value', () => {
    const form = shirtForm({ mapTo: 'lead.value' });
    const { lead } = patchesFromAnswers(form, {
      [qid('sizes')]: { [cid('Adult M')]: 2, [cid('Adult 2XL')]: 1 },
    });
    expect(lead.fields.value).toBe(38);
  });

  it('keeps its rows when a row is added, reworded or removed, like a choice', () => {
    const form = shirtForm();
    const added = applyFormOps(form, [
      { op: 'add_choice', questionId: qid('sizes'), index: null, choice: row('Adult 3XL', 16) },
      {
        op: 'update_question',
        questionId: qid('sizes'),
        patch: { config: { choices: [{ id: cid('Adult M'), label: 'Adult Medium', price: 13 }] } },
      },
      { op: 'delete_choice', questionId: qid('sizes'), choiceId: cid('Adult L') },
    ]).definition;
    expect(sizesOf(added).config).toMatchObject({
      choices: [
        { id: cid('Adult M'), label: 'Adult Medium', price: 13 },
        { id: cid('Adult 2XL'), label: 'Adult 2XL', price: 14 },
        { id: cid('Adult 3XL'), label: 'Adult 3XL', price: 16 },
      ],
    });
    expect(questionLine(sizesOf(added))).toBe('sizes — how many of each, 3 rows');
    expect(
      describeFormOp(
        { op: 'delete_choice', questionId: qid('sizes'), choiceId: cid('Adult L') },
        form,
      ),
    ).toBe('Removed a row from “sizes”');
  });

  it('says the total in the words of what it counts', () => {
    expect(quantityTotalWords(24, 'shirts')).toBe('24 shirts');
    expect(quantityTotalWords(1, 'shirts')).toBe('1 shirt');
    expect(quantityTotalWords(1, 'boxes')).toBe('1 box');
    expect(quantityTotalWords(1, 'pieces')).toBe('1 piece');
    expect(quantityTotalWords(3)).toBe('3 in all');
    expect(quantitiesWords(sizesOf(shirtForm()), {})).toBeNull();
  });
});

describe('the custom order starter', () => {
  const form = starterForm('custom_order');
  const what = allQuestions(form).find((q) => q.title === 'What would you like?')!;
  const pick = (label: string) =>
    (what.config as { choices: { id: string; label: string }[] }).choices.find(
      (c) => c.label === label,
    )!.id;
  const grids = (picked: string[]) =>
    formState(form, { [what.id]: picked.map(pick) })
      .questions.filter((q) => q.type === 'quantities')
      .map((q) => q.title);

  it('asks how many of each only for what they picked', () => {
    expect(grids([])).toEqual([]);
    expect(grids(['T-shirts'])).toEqual(['T-shirts: how many of each size?']);
    expect(grids(['Mugs', 'Tumblers', 'Keychains', 'Pins'])).toEqual([
      'Mugs: how many of each?',
      'Tumblers: how many of each?',
      'Keychains: how many?',
      'Pins: how many?',
    ]);
  });

  it('has every size on the paper order form, Youth S to Adult 5XL', () => {
    const tees = allQuestions(form).find((q) => q.title.startsWith('T-shirts'))!;
    const labels = (tees.config as { choices: { label: string }[] }).choices.map((c) => c.label);
    expect(labels).toHaveLength(12);
    expect(labels[0]).toBe('Youth S');
    expect(labels.at(-1)).toBe('Adult 5XL');
  });

  it('needs a count for each thing they picked before it can be sent', () => {
    const tees = allQuestions(form).find((q) => q.title.startsWith('T-shirts'))!;
    const problems = responseProblems(form, { [what.id]: [pick('T-shirts')] });
    expect(problems.find((p) => p.questionId === tees.id)?.message).toBe(ANSWER_THIS_ONE);
  });
});
