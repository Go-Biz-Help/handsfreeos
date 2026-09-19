import { describe, expect, it } from 'vitest';
import {
  AnswerConditionGroup,
  Calculation,
  calculationProblems,
  emptyAnswerGroup,
  evaluateAnswers,
  numericAnswer,
  resultVotes,
  runCalculations,
  scoreAnswers,
  type AnswerSheet,
  type ScorableQuestion,
} from '../../src/forms/index';
import { cid, kid, qid, rid } from './fixtures';

const group = (input: unknown) => AnswerConditionGroup.parse(input);
const on = (questionId: string, op: string, value?: unknown) =>
  group({ conditions: [{ source: { kind: 'question', questionId }, op, ...(value === undefined ? {} : { value }) }] });

describe('showing and hiding', () => {
  const answers: AnswerSheet = {
    [qid('service')]: cid('Mow'),
    [qid('extras')]: [cid('Edging'), cid('Leaves')],
    [qid('sqft')]: 1200,
    [qid('notes')]: 'Back gate is locked',
    [qid('name')]: '',
  };
  const passes = (g: ReturnType<typeof group>) => evaluateAnswers(g, { answers });

  it('shows a question with no rule', () => {
    expect(passes(emptyAnswerGroup())).toBe(true);
  });

  it('matches a picked choice by its id', () => {
    expect(passes(on(qid('service'), 'is', cid('Mow')))).toBe(true);
    expect(passes(on(qid('service'), 'is', cid('Trim')))).toBe(false);
    expect(passes(on(qid('service'), 'is_not', cid('Trim')))).toBe(true);
  });

  it('handles one of a list', () => {
    expect(passes(on(qid('service'), 'is_one_of', [cid('Mow'), cid('Trim')]))).toBe(true);
    expect(passes(on(qid('service'), 'is_none_of', [cid('Trim')]))).toBe(true);
  });

  it('looks inside a pick-any answer', () => {
    expect(passes(on(qid('extras'), 'includes', cid('Edging')))).toBe(true);
    expect(passes(on(qid('extras'), 'excludes', cid('Hedges')))).toBe(true);
    expect(passes(on(qid('extras'), 'is_one_of', [cid('Leaves')]))).toBe(true);
  });

  it('compares numbers', () => {
    expect(passes(on(qid('sqft'), 'gt', 1000))).toBe(true);
    expect(passes(on(qid('sqft'), 'lte', 1200))).toBe(true);
    expect(passes(on(qid('sqft'), 'between', [1000, 2000]))).toBe(true);
    expect(passes(on(qid('sqft'), 'between', [2000, 3000]))).toBe(false);
  });

  it('searches text without minding the case', () => {
    expect(passes(on(qid('notes'), 'contains', 'GATE'))).toBe(true);
    expect(passes(on(qid('notes'), 'not_contains', 'dog'))).toBe(true);
  });

  it('treats a blank answer as unanswered', () => {
    expect(passes(on(qid('name'), 'answered'))).toBe(false);
    expect(passes(on(qid('name'), 'not_answered'))).toBe(true);
    expect(passes(on(qid('missing0'), 'not_answered'))).toBe(true);
  });

  it('honours all versus any, one group deep', () => {
    const all = group({
      match: 'all',
      conditions: [
        { source: { kind: 'question', questionId: qid('sqft') }, op: 'gt', value: 1000 },
        { source: { kind: 'question', questionId: qid('service') }, op: 'is', value: cid('Trim') },
      ],
    });
    expect(passes(all)).toBe(false);
    expect(passes(group({ ...all, match: 'any' }))).toBe(true);

    const nested = group({
      match: 'all',
      conditions: [
        { source: { kind: 'question', questionId: qid('sqft') }, op: 'gt', value: 1000 },
        {
          match: 'any',
          conditions: [
            { source: { kind: 'question', questionId: qid('service') }, op: 'is', value: cid('Mow') },
            { source: { kind: 'question', questionId: qid('service') }, op: 'is', value: cid('Trim') },
          ],
        },
      ],
    });
    expect(passes(nested)).toBe(true);
  });

  it('reads a calculation and a score', () => {
    const facts = { answers, calculations: { [kid('quote')]: 4275 }, score: { points: 8, percent: 80 } };
    const quote = group({
      conditions: [{ source: { kind: 'calculation', calculationId: kid('quote') }, op: 'gt', value: 4000 }],
    });
    expect(evaluateAnswers(quote, facts)).toBe(true);
    const passed = group({ conditions: [{ source: { kind: 'percent' }, op: 'gte', value: 70 }] });
    expect(evaluateAnswers(passed, facts)).toBe(true);
    expect(evaluateAnswers(passed, { answers })).toBe(false);
  });

  it('refuses a rule with nothing to compare against', () => {
    expect(
      AnswerConditionGroup.safeParse({
        conditions: [{ source: { kind: 'question', questionId: qid('sqft') }, op: 'gt' }],
      }).success,
    ).toBe(false);
  });
});

describe('reading an answer as a number', () => {
  it('takes numbers, counts lists and finds the number in text', () => {
    expect(numericAnswer(1200)).toBe(1200);
    expect(numericAnswer(['a', 'b'])).toBe(2);
    expect(numericAnswer('$1,200')).toBe(1200);
    expect(numericAnswer(true)).toBe(1);
    expect(numericAnswer('')).toBe(null);
    expect(numericAnswer('about a thousand')).toBe(null);
  });
});

describe('calculations', () => {
  const calc = (input: unknown) => Calculation.parse(input);

  it('quotes square feet times a rate, plus a trip fee', () => {
    const quote = calc({
      id: kid('quote'),
      name: 'Quote',
      terms: [
        { factors: [{ kind: 'question', questionId: qid('sqft') }, { kind: 'number', value: 3.5 }] },
        { factors: [{ kind: 'number', value: 75 }] },
      ],
      format: 'money',
    });
    expect(runCalculations([quote], { [qid('sqft')]: 1200 })).toEqual({ [kid('quote')]: 4275 });
  });

  it('counts a picked choice as what it is worth', () => {
    const quote = calc({
      id: kid('quote'),
      name: 'Quote',
      terms: [{ factors: [{ kind: 'question', questionId: qid('service') }] }],
    });
    const values = { [cid('Mow')]: 45, [cid('Trim')]: 80 };
    expect(runCalculations([quote], { [qid('service')]: cid('Trim') }, values)).toEqual({
      [kid('quote')]: 80,
    });
    expect(
      runCalculations([quote], { [qid('service')]: [cid('Mow'), cid('Trim')] }, values),
    ).toEqual({ [kid('quote')]: 125 });
  });

  it('builds on another calculation, and rounds and caps', () => {
    const base = calc({
      id: kid('base'),
      name: 'Base',
      terms: [{ factors: [{ kind: 'question', questionId: qid('sqft') }, { kind: 'number', value: 0.11 }] }],
    });
    const withTax = calc({
      id: kid('total'),
      name: 'Total',
      terms: [{ factors: [{ kind: 'calculation', calculationId: kid('base') }, { kind: 'number', value: 1.0825 }] }],
      round: 'nearest',
      min: 150,
    });
    const out = runCalculations([base, withTax], { [qid('sqft')]: 1000 });
    expect(out[kid('base')]).toBeCloseTo(110);
    expect(out[kid('total')]).toBe(150);
  });

  it('treats a missing answer as nothing, not a crash', () => {
    const quote = calc({
      id: kid('quote'),
      name: 'Quote',
      terms: [{ factors: [{ kind: 'question', questionId: qid('sqft') }, { kind: 'number', value: 3 }] }],
    });
    expect(runCalculations([quote], {})).toEqual({ [kid('quote')]: 0 });
  });

  it('names calculations that go round in a circle', () => {
    const a = calc({ id: kid('a'), name: 'A', terms: [{ factors: [{ kind: 'calculation', calculationId: kid('b') }] }] });
    const b = calc({ id: kid('b'), name: 'B', terms: [{ factors: [{ kind: 'calculation', calculationId: kid('a') }] }] });
    expect(calculationProblems([a, b])).toHaveLength(1);
    expect(runCalculations([a, b], {})).toEqual({ [kid('a')]: 0, [kid('b')]: 0 });
  });
});

describe('scoring a quiz', () => {
  const questions: ScorableQuestion[] = [
    {
      id: qid('capital'),
      type: 'choice',
      config: {
        choices: [
          { id: cid('Austin'), correct: true, points: 2, resultId: rid('gold') },
          { id: cid('Dallas'), correct: false, points: 0, resultId: rid('bronze') },
        ],
      },
    },
    {
      id: qid('tools'),
      type: 'checkboxes',
      config: {
        choices: [
          { id: cid('Mower'), correct: true, points: 1 },
          { id: cid('Edger'), correct: true, points: 1 },
          { id: cid('Chainsaw'), correct: false, points: 0 },
        ],
      },
    },
    { id: qid('licensed'), type: 'yes_no', config: { correct: 'yes', points: 1 } },
    { id: qid('name'), type: 'short_text', config: {} },
  ];

  it('adds up the points and works out the percentage', () => {
    const answers = {
      [qid('capital')]: cid('Austin'),
      [qid('tools')]: [cid('Mower'), cid('Edger')],
      [qid('licensed')]: 'yes',
      [qid('name')]: 'Dale',
    };
    const score = scoreAnswers(questions, answers, { passPercent: 80 });
    expect(score.points).toBe(5);
    expect(score.possible).toBe(5);
    expect(score.percent).toBe(100);
    expect(score.correct).toBe(3);
    expect(score.graded).toBe(3);
    expect(score.passed).toBe(true);
  });

  it('wants every right box ticked and no wrong ones', () => {
    const score = scoreAnswers(questions, {
      [qid('tools')]: [cid('Mower'), cid('Edger'), cid('Chainsaw')],
    });
    expect(score.byQuestion.find((s) => s.questionId === qid('tools'))?.correct).toBe(false);
  });

  it('fails them below the pass mark, and leaves it open with no mark', () => {
    const answers = { [qid('capital')]: cid('Dallas'), [qid('licensed')]: 'no' };
    expect(scoreAnswers(questions, answers, { passPercent: 50 }).passed).toBe(false);
    expect(scoreAnswers(questions, answers).passed).toBe(null);
  });

  it('leaves ungraded questions out of the count', () => {
    const score = scoreAnswers(questions, { [qid('name')]: 'Dale' });
    expect(score.byQuestion.find((s) => s.questionId === qid('name'))?.correct).toBe(null);
    expect(score.graded).toBe(3);
  });

  it('counts the votes an outcome quiz gathers', () => {
    expect(resultVotes(questions, { [qid('capital')]: cid('Austin') })).toEqual({ [rid('gold')]: 1 });
    expect(resultVotes(questions, {})).toEqual({});
  });
});

describe('yes and no', () => {
  it('reads the same whether the page sends true or “yes”', () => {
    const rule = on(qid('licensed'), 'is', 'yes');
    expect(evaluateAnswers(rule, { answers: { [qid('licensed')]: true } })).toBe(true);
    expect(evaluateAnswers(rule, { answers: { [qid('licensed')]: 'yes' } })).toBe(true);
    expect(evaluateAnswers(rule, { answers: { [qid('licensed')]: false } })).toBe(false);
    expect(evaluateAnswers(on(qid('licensed'), 'is', 'no'), { answers: { [qid('licensed')]: false } })).toBe(
      true,
    );
  });
});
