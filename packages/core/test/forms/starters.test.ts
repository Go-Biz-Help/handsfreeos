import { describe, expect, it } from 'vitest';
import {
  allQuestions,
  applyFormOps,
  FORM_STARTERS,
  formProblems,
  formState,
  pickResult,
  runCalculations,
  scoringProblems,
  starterForm,
} from '../../src/forms/index';

describe('the starters', () => {
  it('every one of them is a form that could be published today', () => {
    for (const starter of FORM_STARTERS) {
      const definition = starterForm(starter.key);
      expect(formProblems(definition), starter.key).toEqual([]);
      expect(scoringProblems(definition), starter.key).toEqual([]);
      expect(allQuestions(definition).length, starter.key).toBeGreaterThan(0);
    }
  });

  it('gives each business its own ids, so two never share a question', () => {
    const mine = starterForm('enquiry');
    const yours = starterForm('enquiry');
    const ids = (d: typeof mine) => allQuestions(d).map((q) => q.id);
    expect(ids(mine)).not.toEqual(ids(yours));
    expect(ids(mine)[0]).toMatch(/^q_[a-z0-9]{8}$/);
  });

  it('keeps the rules pointing at the right questions after the ids change', () => {
    const form = starterForm('after_job');
    const sorted = allQuestions(form).find((q) => q.type === 'yes_no')!;
    const followUp = allQuestions(form).find((q) => q.showIf.conditions.length)!;
    const condition = followUp.showIf.conditions[0] as {
      source: { kind: string; questionId: string };
    };
    expect(condition.source.questionId).toBe(sorted.id);
    // And it behaves: the follow-up shows only when they say no.
    expect(formState(form, { [sorted.id]: 'yes' }).questions.map((q) => q.id)).not.toContain(
      followUp.id,
    );
    expect(formState(form, { [sorted.id]: 'no' }).questions.map((q) => q.id)).toContain(
      followUp.id,
    );
  });

  it('prices the quote starter on the spot', () => {
    const form = starterForm('quote');
    const sqft = allQuestions(form).find((q) => q.type === 'number')!;
    const worked = runCalculations(form.calculations, { [sqft.id]: 2000 });
    // 2,000 sq ft at 15 cents, plus the trip fee.
    expect(Object.values(worked)[0]).toBe(375);
  });

  it('sends a happy review to the review screen and an unhappy one to a person', () => {
    const form = starterForm('review');
    const rating = allQuestions(form).find((q) => q.type === 'rating')!;
    expect(pickResult(form, { [rating.id]: 5 }).name).toBe('Happy');
    expect(pickResult(form, { [rating.id]: 2 }).name).toBe('Thank you');
  });

  it('still takes patch ops like any other form', () => {
    const form = starterForm('enquiry', 'Our enquiry form');
    expect(form.title).toBe('Our enquiry form');
    const after = applyFormOps(form, [
      { op: 'set_settings', patch: { submitLabel: 'Send it' } },
    ]).definition;
    expect(after.settings.submitLabel).toBe('Send it');
  });
});
