import { describe, expect, it } from 'vitest';
import {
  answerProblem,
  formState,
  nextQuestion,
  pageProblems,
  pickResult,
  prunedAnswers,
  recordAnswers,
  responseProblems,
  type AnswerValue,
  type FormDefinition,
  type Question,
} from '../../src/forms/index';
import { choice, cid, def, kid, number, page, pickOne, pid, qid, result, rid, shortText } from './fixtures';

/** "Do you have a dog?" and, only then, "What breed?" */
const dogForm = (): FormDefinition =>
  def({
    pages: [
      page('about', [
        { id: qid('dog'), type: 'yes_no', title: 'Do you have a dog?', config: {} },
        shortText('breed', {
          title: 'What breed?',
          showIf: {
            conditions: [{ source: { kind: 'question', questionId: qid('dog') }, op: 'is', value: 'yes' }],
          },
        }),
        shortText('name', { title: 'Your name', required: true }),
      ]),
    ],
  });

describe('what is showing', () => {
  it('hides the follow-up until the answer calls for it', () => {
    const form = dogForm();
    expect(formState(form, {}).questions.map((q) => q.id)).toEqual([qid('dog'), qid('name')]);
    expect(formState(form, { [qid('dog')]: 'yes' }).questions.map((q) => q.id)).toEqual([
      qid('dog'),
      qid('breed'),
      qid('name'),
    ]);
  });

  it('drops an answer to a question they can no longer see', () => {
    const form = dogForm();
    const answers = { [qid('dog')]: 'yes', [qid('breed')]: 'Collie' };
    expect(prunedAnswers(form, answers)).toEqual(answers);
    expect(prunedAnswers(form, { ...answers, [qid('dog')]: 'no' })).toEqual({ [qid('dog')]: 'no' });
  });

  it('settles when hiding one question hides another', () => {
    const form = def({
      pages: [
        page('about', [
          { id: qid('dog'), type: 'yes_no', title: 'Dog?', config: {} },
          shortText('breed', {
            showIf: {
              conditions: [{ source: { kind: 'question', questionId: qid('dog') }, op: 'is', value: 'yes' }],
            },
          }),
          shortText('size', {
            showIf: {
              conditions: [{ source: { kind: 'question', questionId: qid('breed') }, op: 'answered' }],
            },
          }),
        ]),
      ],
    });
    const answers = { [qid('dog')]: 'no', [qid('breed')]: 'Collie', [qid('size')]: 'Large' };
    expect(prunedAnswers(form, answers)).toEqual({ [qid('dog')]: 'no' });
  });

  it('hides a whole page at once', () => {
    const form = def({
      pages: [
        page('about', [{ id: qid('dog'), type: 'yes_no', title: 'Dog?', config: {} }]),
        page('dogs', [shortText('breed')], {
          showIf: {
            conditions: [{ source: { kind: 'question', questionId: qid('dog') }, op: 'is', value: 'yes' }],
          },
        }),
      ],
    });
    expect(formState(form, {}).pages.map((p) => p.page.id)).toEqual([pid('about')]);
    expect(formState(form, { [qid('dog')]: true }).pages.map((p) => p.page.id)).toEqual([
      pid('about'),
      pid('dogs'),
    ]);
  });

  it('counts how far along they are, ignoring what they can’t see', () => {
    const form = dogForm();
    expect(formState(form, {}).progress).toBe(0);
    expect(formState(form, { [qid('dog')]: 'no' }).progress).toBe(0.5);
    expect(formState(form, { [qid('dog')]: 'no', [qid('name')]: 'Dale' }).progress).toBe(1);
  });

  it('knows what to ask next, which is how the AI teammate holds a conversation', () => {
    const form = dogForm();
    expect(nextQuestion(form, {})?.id).toBe(qid('dog'));
    expect(nextQuestion(form, { [qid('dog')]: 'yes' })?.id).toBe(qid('breed'));
    expect(nextQuestion(form, { [qid('dog')]: 'no' })?.id).toBe(qid('name'));
    expect(nextQuestion(form, { [qid('dog')]: 'no', [qid('name')]: 'Dale' })).toBe(null);
  });

  it('works the calculations out as they go', () => {
    const form = def({
      pages: [page('about', [number('sqft')])],
      calculations: [
        {
          id: kid('quote'),
          name: 'Quote',
          terms: [
            { factors: [{ kind: 'question', questionId: qid('sqft') }, { kind: 'number', value: 3.5 }] },
            { factors: [{ kind: 'number', value: 75 }] },
          ],
          format: 'money',
        },
      ],
    });
    expect(formState(form, { [qid('sqft')]: 1200 }).calculations[kid('quote')]).toBe(4275);
  });
});

describe('whether an answer will do', () => {
  const ask = (type: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    ({ id: qid('x'), type, title: 'X', required: false, config, showIf: { match: 'all', conditions: [] }, mapTo: null, ...extra }) as unknown as Question;

  it('only insists when the question is required', () => {
    expect(answerProblem(ask('short_text', { maxLength: 120 }), null)).toBe(null);
    expect(answerProblem(ask('short_text', { maxLength: 120 }, { required: true }), '')).toBe(
      'Answer this one.',
    );
  });

  it('checks emails and phone numbers the way the rest of the app does', () => {
    expect(answerProblem(ask('email'), 'dale@example.com')).toBe(null);
    expect(answerProblem(ask('email'), 'dale@')).toBe('Enter an email address.');
    expect(answerProblem(ask('phone'), '(512) 555-0134')).toBe(null);
    expect(answerProblem(ask('phone'), 'call me')).toBe('Enter a phone number.');
  });

  it('keeps a pick-one to its choices unless “other” is allowed', () => {
    const choices = [{ id: cid('Mow'), label: 'Mow' }, { id: cid('Trim'), label: 'Trim' }];
    expect(answerProblem(ask('choice', { choices }), cid('Mow'))).toBe(null);
    expect(answerProblem(ask('choice', { choices }), 'something else')).toBe('Pick one of the choices.');
    expect(answerProblem(ask('choice', { choices, allowOther: true }), 'something else')).toBe(null);
  });

  it('counts the boxes ticked', () => {
    const choices = [
      { id: cid('A'), label: 'A' },
      { id: cid('B'), label: 'B' },
      { id: cid('C'), label: 'C' },
    ];
    const question = ask('checkboxes', { choices, min: 2, max: 3 });
    expect(answerProblem(question, [cid('A')])).toBe('Pick at least 2.');
    expect(answerProblem(question, [cid('A'), cid('B')])).toBe(null);
  });

  it('holds numbers to their range and their decimals', () => {
    const question = ask('number', { min: 100, max: 5000, decimals: 0 });
    expect(answerProblem(question, 1200)).toBe(null);
    expect(answerProblem(question, 20)).toBe('Enter 100 or more.');
    expect(answerProblem(question, 1200.5)).toBe('Whole numbers only.');
    expect(answerProblem(ask('money', { min: null, max: null }), 19.995)).toBe('Cents only, please.');
  });

  it('checks dates, times, ratings and signatures', () => {
    expect(answerProblem(ask('date', { range: 'any' }), '2026-09-18')).toBe(null);
    expect(answerProblem(ask('date', { range: 'future' }), '2020-01-01')).toBe('Pick a date to come.');
    expect(answerProblem(ask('time'), '09:30')).toBe(null);
    expect(answerProblem(ask('time'), 'morning')).toBe('Pick a time.');
    expect(answerProblem(ask('rating', { max: 5 }), 6)).toBe('Pick from 1 to 5.');
    expect(answerProblem(ask('signature', { statement: 'I agree.' }), { name: 'Dale', signedAt: '2026-09-18T10:00:00Z' })).toBe(null);
    const unsigned = { name: ' ' } as unknown as AnswerValue;
    expect(answerProblem(ask('signature', { statement: 'I agree.' }), unsigned)).toBe(
      'Type your name to sign.',
    );
  });

  it('holds uploads to their count and their size', () => {
    const question = ask('file', { maxFiles: 2, maxMb: 10, accept: 'any' });
    const file = (bytes: number) => ({ fileId: '00000000-0000-4000-8000-000000000001', name: 'a.jpg', bytes });
    expect(answerProblem(question, [file(1000)])).toBe(null);
    expect(answerProblem(question, [file(1000), file(1000), file(1000)])).toBe('Up to 2 files.');
    expect(answerProblem(question, [file(20 * 1024 * 1024)])).toBe('Each file under 10MB.');
  });

  it('never complains about a question that asks nothing', () => {
    expect(answerProblem(ask('content', { body: 'Read this' }, { required: true }), null)).toBe(null);
  });
});

describe('a whole response', () => {
  it('asks for what is missing, and doesn’t ask for what is hidden', () => {
    const form = dogForm();
    expect(responseProblems(form, {})).toEqual([{ questionId: qid('name'), message: 'Answer this one.' }]);
    expect(responseProblems(form, { [qid('name')]: 'Dale' })).toEqual([]);
    // An answer to a hidden question is dropped rather than complained about.
    expect(responseProblems(form, { [qid('name')]: 'Dale', [qid('breed')]: 'x'.repeat(500) })).toEqual([]);
  });

  it('checks one page at a time', () => {
    const form = def({
      pages: [page('one', [shortText('name', { required: true })]), page('two', [shortText('notes', { required: true })])],
    });
    expect(pageProblems(form, {}, pid('one'))).toEqual([
      { questionId: qid('name'), message: 'Answer this one.' },
    ]);
    expect(pageProblems(form, { [qid('name')]: 'Dale' }, pid('one'))).toEqual([]);
  });

  it('copies the wording in, so the answers still read right after the questions change', () => {
    const form = def({
      pages: [page('about', [pickOne('service', [choice('Mow'), choice('Trim')])])],
    });
    expect(recordAnswers(form, { [qid('service')]: cid('Trim') })).toEqual([
      {
        questionId: qid('service'),
        title: 'service',
        type: 'choice',
        value: cid('Trim'),
        labels: ['Trim'],
      },
    ]);
  });
});

describe('where they land', () => {
  const quiz = (): FormDefinition =>
    def({
      mode: 'quiz',
      scoring: { enabled: true, passPercent: 60 },
      pages: [
        page('quiz', [
          pickOne('capital', [
            choice('Austin', { correct: true, points: 1, resultId: rid('gold') }),
            choice('Dallas', { points: 0, resultId: rid('bronze') }),
          ]),
        ]),
      ],
      results: [
        result('gold', { headline: 'Gold', showIf: { conditions: [{ source: { kind: 'percent' }, op: 'gte', value: 60 }] } }),
        result('bronze', { headline: 'Bronze' }),
      ],
    });

  it('takes the first rule that passes', () => {
    expect(pickResult(quiz(), { [qid('capital')]: cid('Austin') }).id).toBe(rid('gold'));
  });

  it('falls back to the choices’ votes', () => {
    const form = def({
      pages: [
        page('about', [
          pickOne('style', [
            choice('Quick', { resultId: rid('starter') }),
            choice('Thorough', { resultId: rid('full') }),
          ]),
        ]),
      ],
      results: [result('starter'), result('full')],
    });
    expect(pickResult(form, { [qid('style')]: cid('Thorough') }).id).toBe(rid('full'));
  });

  it('lands on the last result when nothing else decides', () => {
    expect(pickResult(quiz(), {}).id).toBe(rid('bronze'));
    expect(pickResult(def(), {}).id).toBe(rid('thanks'));
  });
});
