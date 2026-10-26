/**
 * What the web and the phone both show of the main offer's review (HANDSFREEOS_MAIN_OFFER_PHONE_IMPLEMENTATION_PLAN.md,
 * steps 1 and 2), worked out once: the score at a glance, the quick checks, what goes into the next try, Settings' line
 * on the phone, whether the phone shows the offer at all with no signal, the step a box is on, and the AI's refusals.
 * Pure.
 */
import { describe, expect, it } from 'vitest';
import { ADDON_CATALOG } from '../src/addons/catalog';
import { coreFeatureHeld } from '../src/addons/capabilities';
import type { MainOfferScore, ScoredPart } from '../src/main-offer/parts';
import {
  goingInto,
  offerAiWords,
  offerChecks,
  offerRowLine,
  offerStepOf,
  underBarTitle,
} from '../src/main-offer/words';

function scoreOf(each: number, low: Partial<Record<ScoredPart, number>> = {}): MainOfferScore {
  const part = (p: ScoredPart) => ({ score: low[p] ?? each, why: 'Clear and specific.' });
  return {
    parts: {
      who: part('who'),
      outcome: part('outcome'),
      timeframe: part('timeframe'),
      method: part('method'),
      guarantee: part('guarantee'),
      price: part('price'),
    },
    weakest: 'price',
    fix: 'Say what the guarantee needs from them.',
    flags: { vague: false, generic: true, hardToBelieve: false },
    threeSeconds: true,
  };
}

describe('the score at a glance', () => {
  it('names the parts under 7, lowest first, or says every part clears', () => {
    expect(underBarTitle(scoreOf(8))).toBe('Every part scores 7 or more');
    expect(underBarTitle(scoreOf(8, { guarantee: 6 }))).toBe('Under 7: guarantee');
    expect(underBarTitle(scoreOf(8, { guarantee: 6, who: 4 }))).toBe('Under 7: who and guarantee');
    expect(underBarTitle(scoreOf(3))).toBe(
      'Under 7: who, outcome, timeframe, method, guarantee and price',
    );
  });

  it('lists the quick checks in the video’s order', () => {
    expect(offerChecks(scoreOf(8))).toEqual([
      { text: 'A stranger sees the result in 3 seconds', ok: true },
      { text: 'Specific, not vague', ok: true },
      { text: 'Stands out from others like you', ok: false },
      { text: 'Easy to believe', ok: true },
    ]);
  });
});

describe('what goes into the next try', () => {
  it('is the direction, the notes on parts not kept, then the kept parts', () => {
    expect(
      goingInto(
        ' Lead with the AI. ',
        { guarantee: 'Say which leads count.', who: 'Broad on purpose.', method: 'Kept anyway.' },
        ['price', 'method'],
      ),
    ).toEqual([
      { key: 'direction', text: 'Your direction', kept: false },
      { key: 'note-who', text: 'Your note on who', kept: false },
      { key: 'note-guarantee', text: 'Your note on guarantee', kept: false },
      { key: 'kept-method', text: 'Method kept as is', kept: true },
      { key: 'kept-price', text: 'Price kept as is', kept: true },
    ]);
  });

  it('is nothing when nothing is said or kept', () => {
    expect(goingInto('  ', { who: ' ' }, [])).toEqual([]);
  });
});

describe('Settings’ Main offer row on the phone', () => {
  const base = { inUse: true, comesWith: ['Social Outreach'], live: null, draft: null };

  it('says how the live version and the draft are doing', () => {
    expect(offerRowLine(base)).toBe('Not built yet');
    expect(offerRowLine({ ...base, live: { version: 3, score: scoreOf(8) } })).toBe(
      'Version 3 is live',
    );
    expect(offerRowLine({ ...base, live: { version: 2, score: scoreOf(8, { price: 5 }) } })).toBe(
      'Version 2 is live, under the bar',
    );
    expect(
      offerRowLine({
        ...base,
        live: { version: 3, score: scoreOf(8) },
        draft: { score: scoreOf(8, { guarantee: 6, who: 4 }) },
      }),
    ).toBe('Version 3 is live · your draft is under 7 on the who and the guarantee');
    expect(offerRowLine({ ...base, draft: { score: null } })).toBe('Your draft isn’t scored yet');
    expect(offerRowLine({ ...base, draft: { score: scoreOf(9) } })).toBe(
      'Your draft is ready to go live',
    );
  });

  it('says which add-on brings it when none that uses it is on', () => {
    expect(offerRowLine({ ...base, inUse: false })).toBe('Comes with Social Outreach');
  });

  it('shows with no signal while the person holds a permission of an add-on that uses it', () => {
    expect(coreFeatureHeld(ADDON_CATALOG, ['outreach.use'], 'main_offer')).toBe(true);
    expect(
      coreFeatureHeld(ADDON_CATALOG, ['main_offer.manage', 'records.read'], 'main_offer'),
    ).toBe(false);
    expect(coreFeatureHeld(ADDON_CATALOG, ['realestate.use'], 'main_offer')).toBe(false);
  });
});

describe('the builder’s steps and the AI’s refusals', () => {
  it('names the step a box is on', () => {
    expect(offerStepOf('who.work')).toBe('who');
    expect(offerStepOf('method.steps')).toBe('method');
    expect(offerStepOf('line')).toBe('line');
    expect(offerStepOf('inAFewWords.outcome')).toBe('line');
    expect(offerStepOf('proof')).toBe('proof');
    expect(offerStepOf('nothing.here')).toBe('who');
  });

  it('says why the AI didn’t help, in its own words unless they can be plainer', () => {
    const refusal = (status: number, rule: string | null, code = 'refused') => ({
      status,
      rule,
      code,
      message: 'The worker’s words.',
    });
    expect(offerAiWords(refusal(0, null))).toBe(
      'The AI isn’t reachable right now. Try again in a minute.',
    );
    expect(offerAiWords(refusal(403, null))).toBe(
      'Only owners and admins can build the main offer.',
    );
    // The worker names the business's own limit, so its words come through.
    expect(offerAiWords(refusal(429, 'budget_reached'))).toBe('The worker’s words.');
    expect(offerAiWords({ ...refusal(429, 'budget_reached'), message: '' })).toMatch(
      /AI limit, so the AI is paused until midnight/,
    );
    expect(offerAiWords({ ...refusal(503, null, 'ai_not_configured'), rule: undefined })).toMatch(
      /isn’t set up/,
    );
    expect(offerAiWords(refusal(422, 'main_offer_all_kept'))).toBe('The worker’s words.');
  });
});
