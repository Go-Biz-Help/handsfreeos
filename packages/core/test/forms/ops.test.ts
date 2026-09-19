import { describe, expect, it } from 'vitest';
import {
  applyFormOps,
  FormOpList,
  formOutline,
  type FormDefinition,
  type FormOp,
  type FormOpError,
} from '../../src/forms/index';
import {
  choice,
  cid,
  def,
  kid,
  number,
  page,
  pickOne,
  pid,
  qid,
  result,
  rid,
  shortText,
} from './fixtures';

const base = (): FormDefinition =>
  def({
    pages: [
      page('about', [shortText('name'), number('sqft')]),
      page('extras', [
        pickOne('service', [choice('Mow', { value: 45 }), choice('Trim', { value: 80 })]),
      ]),
    ],
    results: [result('thanks')],
  });

/** Applies the ops, then applies the inverse and checks the form is exactly as it was. */
function roundTrip(start: FormDefinition, ops: FormOp[]): FormDefinition {
  const { definition, inverse } = applyFormOps(start, ops);
  expect(applyFormOps(definition, inverse).definition).toEqual(start);
  return definition;
}

const fails = (start: FormDefinition, ops: FormOp[]) => {
  try {
    applyFormOps(start, ops);
  } catch (error) {
    return error as FormOpError;
  }
  throw new Error('That was supposed to fail.');
};

describe('questions', () => {
  it('adds one where it’s asked for, and undoes it', () => {
    const after = roundTrip(base(), [
      { op: 'add_question', pageId: pid('about'), index: 1, question: shortText('email') },
    ]);
    expect(formOutline(after)).toEqual([
      `${pid('about')}:page`,
      `  ${qid('name')}:short_text`,
      `  ${qid('email')}:short_text`,
      `  ${qid('sqft')}:number`,
      `${pid('extras')}:page`,
      `  ${qid('service')}:choice`,
    ]);
  });

  it('appends when no position is given', () => {
    const after = applyFormOps(base(), [
      { op: 'add_question', pageId: pid('about'), index: null, question: shortText('email') },
    ]).definition;
    expect(after.pages[0]!.questions.map((q) => q.id)).toEqual([
      qid('name'),
      qid('sqft'),
      qid('email'),
    ]);
  });

  it('deletes one and puts it back exactly', () => {
    const after = roundTrip(base(), [{ op: 'delete_question', questionId: qid('sqft') }]);
    expect(after.pages[0]!.questions).toHaveLength(1);
  });

  it('moves one to another page', () => {
    const after = roundTrip(base(), [
      { op: 'move_question', questionId: qid('sqft'), pageId: pid('extras'), index: 0 },
    ]);
    expect(after.pages[1]!.questions.map((q) => q.id)).toEqual([qid('sqft'), qid('service')]);
    expect(after.pages[0]!.questions.map((q) => q.id)).toEqual([qid('name')]);
  });

  it('changes the wording and keeps the id', () => {
    const after = roundTrip(base(), [
      {
        op: 'update_question',
        questionId: qid('name'),
        patch: { title: 'What’s your name?', required: true },
      },
    ]);
    const question = after.pages[0]!.questions[0]!;
    expect(question.id).toBe(qid('name'));
    expect(question.title).toBe('What’s your name?');
    expect(question.required).toBe(true);
  });

  it('replaces the config when the type changes', () => {
    const after = roundTrip(base(), [
      {
        op: 'update_question',
        questionId: qid('name'),
        patch: { type: 'email', config: { placeholder: 'you@example.com' } },
      },
    ]);
    const question = after.pages[0]!.questions[0]!;
    expect(question.type).toBe('email');
    expect(question.config).toEqual({ placeholder: 'you@example.com' });
  });

  it('won’t change a question’s id', () => {
    expect(
      fails(base(), [
        { op: 'update_question', questionId: qid('name'), patch: { id: qid('other') } },
      ]).code,
    ).toBe('bad_patch');
  });

  it('refuses a question that isn’t there, and a position off the end', () => {
    expect(fails(base(), [{ op: 'delete_question', questionId: qid('ghost') }]).code).toBe(
      'question_not_found',
    );
    expect(
      fails(base(), [
        { op: 'add_question', pageId: pid('about'), index: 9, question: shortText('email') },
      ]).code,
    ).toBe('index_out_of_range');
  });

  it('refuses an id already in the form', () => {
    const error = fails(base(), [
      { op: 'add_question', pageId: pid('extras'), index: null, question: shortText('name') },
    ]);
    expect(error.code).toBe('duplicate_id');
  });
});

describe('choices', () => {
  it('edits them by id, so answers already given still point at the right one', () => {
    const after = roundTrip(base(), [
      {
        op: 'update_question',
        questionId: qid('service'),
        patch: { config: { choices: [{ id: cid('Trim'), label: 'Hedge trimming', value: 95 }] } },
      },
    ]);
    const choices = (
      after.pages[1]!.questions[0]!.config as {
        choices: { id: string; label: string; value: number | null }[];
      }
    ).choices;
    expect(choices.map((c) => c.id)).toEqual([cid('Mow'), cid('Trim')]);
    expect(choices[1]).toMatchObject({ label: 'Hedge trimming', value: 95 });
  });

  it('reorders them when every one is listed', () => {
    const after = roundTrip(base(), [
      {
        op: 'update_question',
        questionId: qid('service'),
        patch: { config: { choices: [{ id: cid('Trim') }, { id: cid('Mow') }] } },
      },
    ]);
    const choices = (after.pages[1]!.questions[0]!.config as { choices: { id: string }[] }).choices;
    expect(choices.map((c) => c.id)).toEqual([cid('Trim'), cid('Mow')]);
  });

  it('adds and removes one', () => {
    const after = roundTrip(base(), [
      {
        op: 'add_choice',
        questionId: qid('service'),
        index: null,
        choice: { id: cid('Leaves'), label: 'Leaf clearing', value: 120 },
      },
    ]);
    expect(
      (after.pages[1]!.questions[0]!.config as { choices: { id: string }[] }).choices,
    ).toHaveLength(3);
    roundTrip(after, [
      { op: 'delete_choice', questionId: qid('service'), choiceId: cid('Leaves') },
    ]);
  });

  it('won’t leave a pick-one with a single choice', () => {
    expect(
      fails(base(), [{ op: 'delete_choice', questionId: qid('service'), choiceId: cid('Mow') }])
        .code,
    ).toBe('invalid');
  });

  it('refuses a choice that isn’t on the question, and choices on a question that has none', () => {
    expect(
      fails(base(), [{ op: 'delete_choice', questionId: qid('service'), choiceId: cid('Ghost') }])
        .code,
    ).toBe('choice_not_found');
    expect(
      fails(base(), [
        {
          op: 'add_choice',
          questionId: qid('name'),
          index: null,
          choice: { id: cid('X'), label: 'X' },
        },
      ]).code,
    ).toBe('bad_patch');
  });
});

describe('pages', () => {
  it('adds, moves and deletes them', () => {
    const added = roundTrip(base(), [{ op: 'add_page', index: null, page: page('photos', []) }]);
    expect(added.pages.map((p) => p.id)).toEqual([pid('about'), pid('extras'), pid('photos')]);
    const moved = roundTrip(added, [{ op: 'move_page', pageId: pid('photos'), index: 0 }]);
    expect(moved.pages.map((p) => p.id)).toEqual([pid('photos'), pid('about'), pid('extras')]);
    roundTrip(moved, [{ op: 'delete_page', pageId: pid('photos') }]);
  });

  it('takes the questions with it when a page goes, and brings them back', () => {
    const after = roundTrip(base(), [{ op: 'delete_page', pageId: pid('extras') }]);
    expect(after.pages).toHaveLength(1);
  });

  it('keeps at least one page, and won’t edit questions through the page', () => {
    const one = applyFormOps(base(), [{ op: 'delete_page', pageId: pid('extras') }]).definition;
    expect(fails(one, [{ op: 'delete_page', pageId: pid('about') }]).code).toBe('last_page');
    expect(
      fails(base(), [{ op: 'update_page', pageId: pid('about'), patch: { questions: [] } }]).code,
    ).toBe('bad_patch');
  });
});

describe('calculations and results', () => {
  const quote = {
    id: kid('quote'),
    name: 'Quote',
    terms: [
      {
        factors: [
          { kind: 'question' as const, questionId: qid('sqft') },
          { kind: 'number' as const, value: 3.5 },
        ],
      },
    ],
    format: 'money' as const,
  };

  it('adds one, changes its rate and takes it away', () => {
    const added = roundTrip(base(), [{ op: 'add_calculation', index: null, calculation: quote }]);
    expect(added.calculations).toHaveLength(1);
    const changed = roundTrip(added, [
      {
        op: 'update_calculation',
        calculationId: kid('quote'),
        patch: { terms: [{ factors: [{ kind: 'number', value: 500 }] }] },
      },
    ]);
    expect(changed.calculations[0]!.terms[0]!.factors).toEqual([{ kind: 'number', value: 500 }]);
    roundTrip(changed, [{ op: 'delete_calculation', calculationId: kid('quote') }]);
  });

  it('adds an outcome and keeps the last one as the fallback', () => {
    const after = roundTrip(base(), [
      { op: 'add_result', index: 0, result: result('gold', { headline: 'Gold plan' }) },
    ]);
    expect(after.results.map((r) => r.id)).toEqual([rid('gold'), rid('thanks')]);
    expect(fails(base(), [{ op: 'delete_result', resultId: rid('thanks') }]).code).toBe(
      'last_result',
    );
  });
});

describe('the form itself', () => {
  it('turns a survey into a quiz without touching the questions', () => {
    const start = base();
    const after = roundTrip(start, [
      { op: 'set_form', patch: { mode: 'quiz' } },
      { op: 'set_scoring', patch: { enabled: true, passPercent: 80 } },
    ]);
    expect(after.mode).toBe('quiz');
    expect(after.scoring).toMatchObject({ enabled: true, passPercent: 80 });
    expect(formOutline(after)).toEqual(formOutline(start));
  });

  it('merges settings and what happens on submit, leaving the rest alone', () => {
    const after = roundTrip(base(), [
      { op: 'set_settings', patch: { identity: 'anonymous', oneQuestionAtATime: true } },
      { op: 'set_on_submit', patch: { person: { create: false } } },
    ]);
    expect(after.settings.identity).toBe('anonymous');
    expect(after.settings.submitLabel).toBe('Submit');
    expect(after.onSubmit.person.create).toBe(false);
    expect(after.onSubmit.person.match).toBe('phone_or_email');
  });

  it('sends anything else to its own op', () => {
    expect(
      fails(base(), [{ op: 'set_form', patch: { settings: { identity: 'anonymous' } } }]).code,
    ).toBe('bad_patch');
  });
});

describe('a batch', () => {
  it('goes in all together or not at all', () => {
    const start = base();
    const error = fails(start, [
      { op: 'delete_question', questionId: qid('sqft') },
      { op: 'delete_question', questionId: qid('ghost') },
    ]);
    expect(error.opIndex).toBe(1);
    expect(start.pages[0]!.questions).toHaveLength(2);
  });

  it('blames the op that broke it', () => {
    const error = fails(base(), [
      { op: 'add_question', pageId: pid('about'), index: null, question: shortText('email') },
      { op: 'update_question', questionId: qid('email'), patch: { title: '' } },
    ]);
    expect(error.opIndex).toBe(1);
    expect(error.targetId).toBe(qid('email'));
  });

  it('undoes a whole batch in one go', () => {
    roundTrip(base(), [
      { op: 'add_page', index: null, page: page('photos', []) },
      { op: 'add_question', pageId: pid('photos'), index: null, question: shortText('anything') },
      { op: 'move_question', questionId: qid('sqft'), pageId: pid('photos'), index: 0 },
      { op: 'set_settings', patch: { showProgress: false } },
    ]);
  });

  it('checks the shape of ops arriving over the wire', () => {
    expect(FormOpList.safeParse([{ op: 'delete_question', questionId: 'nope' }]).success).toBe(
      false,
    );
    expect(FormOpList.safeParse([{ op: 'delete_question', questionId: qid('name') }]).success).toBe(
      true,
    );
  });
});
