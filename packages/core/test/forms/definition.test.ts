import { describe, expect, it } from 'vitest';
import {
  allQuestions,
  choiceValues,
  findQuestion,
  FORM_DEFINITION_VERSION,
  formProblems,
  gradedQuestions,
  scoringProblems,
} from '../../src/forms/index';
import {
  choice,
  cid,
  def,
  kid,
  number,
  page,
  pickAny,
  pickOne,
  qid,
  rid,
  result,
  shortText,
  tryDef,
} from './fixtures';

describe('the definition', () => {
  it('fills in the version, the mode and the settings', () => {
    const form = def();
    expect(form.version).toBe(FORM_DEFINITION_VERSION);
    expect(form.mode).toBe('form');
    expect(form.settings.identity).toBe('required');
    expect(form.scoring.enabled).toBe(false);
    expect(form.onSubmit.person.create).toBe(true);
    expect(form.pages[0]!.questions[0]!.showIf).toEqual({ match: 'all', conditions: [] });
  });

  it('is the same shape in all three modes', () => {
    for (const mode of ['form', 'survey', 'quiz'] as const)
      expect(def({ mode }).mode).toBe(mode);
  });

  it('takes each question type with its own config', () => {
    const form = def({
      pages: [
        page('all', [
          shortText('name'),
          number('sqft', { config: { unit: 'sq ft', decimals: 0 } }),
          pickOne('service', [choice('Mow'), choice('Trim')]),
          { id: qid('sig'), type: 'signature', title: 'Sign', config: { statement: 'I agree.' } },
        ]),
      ],
    });
    expect(allQuestions(form)).toHaveLength(4);
    const sqft = findQuestion(form, qid('sqft'));
    expect(sqft?.question.type).toBe('number');
    expect((sqft?.question.config as { unit: string }).unit).toBe('sq ft');
  });

  it('refuses a question whose config belongs to another type', () => {
    const bad = tryDef({
      pages: [page('about', [{ id: qid('sig'), type: 'signature', title: 'Sign', config: {} }])],
    });
    expect(bad.success).toBe(false);
  });

  it('wants two choices on a pick-one', () => {
    expect(tryDef({ pages: [page('about', [pickOne('service', [choice('Mow')])])] }).success).toBe(
      false,
    );
  });

  it('needs a page and somewhere to land', () => {
    expect(tryDef({ pages: [] }).success).toBe(false);
    expect(tryDef({ results: [] }).success).toBe(false);
  });
});

describe('what the schema alone can’t catch', () => {
  it('passes a plain form', () => {
    expect(formProblems(def())).toEqual([]);
  });

  it('catches a rule that reads an answer not given yet', () => {
    const form = def({
      pages: [
        page('about', [
          shortText('name', {
            showIf: {
              conditions: [{ source: { kind: 'question', questionId: qid('later') }, op: 'answered' }],
            },
          }),
          shortText('later'),
        ]),
      ],
    });
    expect(formProblems(form)).toEqual(['The rule on “name” reads an answer that hasn’t been given yet.']);
  });

  it('is happy when the rule reads an earlier answer', () => {
    const form = def({
      pages: [
        page('about', [
          shortText('owner'),
          shortText('later', {
            showIf: {
              conditions: [{ source: { kind: 'question', questionId: qid('owner') }, op: 'answered' }],
            },
          }),
        ]),
      ],
    });
    expect(formProblems(form)).toEqual([]);
  });

  it('lets a result read every answer', () => {
    const form = def({
      results: [
        result('big', {
          showIf: {
            conditions: [{ source: { kind: 'question', questionId: qid('name') }, op: 'answered' }],
          },
        }),
      ],
    });
    expect(formProblems(form)).toEqual([]);
  });

  it('catches ids used twice', () => {
    const form = def({ pages: [page('about', [shortText('name'), shortText('name')])] });
    expect(formProblems(form)).toContain('Two questions share an id.');
  });

  it('catches a choice pointing at a result that isn’t there', () => {
    const form = def({
      pages: [page('about', [pickOne('service', [choice('Mow', { resultId: rid('gone') }), choice('Trim')])])],
    });
    expect(formProblems(form)).toContain('“service” points at a result that isn’t there.');
  });

  it('catches a payment charging a calculation that isn’t there', () => {
    const form = def({
      pages: [
        page('about', [
          {
            id: qid('pay'),
            type: 'payment',
            title: 'Deposit',
            config: {
              amount: { kind: 'calculation', calculationId: kid('quote') },
              description: 'Deposit',
            },
          },
        ]),
      ],
    });
    expect(formProblems(form)).toContain('“Deposit” charges a calculation that isn’t there.');
  });

  it('catches calculations that go round in a circle', () => {
    const form = def({
      calculations: [
        { id: kid('a'), name: 'A', terms: [{ factors: [{ kind: 'calculation', calculationId: kid('b') }] }] },
        { id: kid('b'), name: 'B', terms: [{ factors: [{ kind: 'calculation', calculationId: kid('a') }] }] },
      ],
    });
    expect(formProblems(form).some((p) => p.includes('circle'))).toBe(true);
  });

  it('catches an answer sent to a field that can’t hold it', () => {
    const form = def({
      pages: [page('about', [number('sqft', { mapTo: 'person.email' })])],
    });
    expect(formProblems(form)).toContain('“sqft” can’t fill in that field.');
  });

  it('won’t make a note on the page required', () => {
    const form = def({
      pages: [
        page('about', [
          { id: qid('note'), type: 'content', title: 'Read this', required: true, config: { body: 'Hello' } },
        ]),
      ],
    });
    expect(formProblems(form)).toContain('“Read this” asks nothing, so it can’t be required.');
  });
});

describe('reading the tree', () => {
  it('collects the choice values the calculations use', () => {
    const form = def({
      pages: [
        page('about', [
          pickOne('service', [choice('Mow', { value: 45 }), choice('Trim', { value: 80 })]),
        ]),
      ],
    });
    expect(choiceValues(form)).toEqual({ [cid('Mow')]: 45, [cid('Trim')]: 80 });
  });

  it('knows which questions a quiz can score', () => {
    const form = def({
      mode: 'quiz',
      scoring: { enabled: true },
      pages: [
        page('quiz', [
          pickOne('capital', [choice('Austin', { correct: true, points: 1 }), choice('Dallas')]),
          pickAny('colors', [choice('Red'), choice('Blue')]),
          shortText('name'),
        ]),
      ],
    });
    expect(gradedQuestions(form).map((q) => q.id)).toEqual([qid('capital')]);
    expect(scoringProblems(form)).toEqual([]);
  });

  it('says so when a quiz has no right answers', () => {
    const form = def({ mode: 'quiz', scoring: { enabled: true } });
    expect(scoringProblems(form)).toEqual([
      'Nothing is marked as a right answer, so there is nothing to score.',
    ]);
  });
});
