/**
 * Get ready for your best results (../../src/addons/outreach/readiness.ts, decision 63): where each item stands, what
 * changed in a new main offer, and the numbers worked as the video works them, honest about Facebook's pace. Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  changedParts,
  notReadyWords,
  numbersLines,
  numbersMath,
  numbersVerdict,
  PROFILE_ITEMS,
  READY_WORDS,
  readinessOf,
  tickCounts,
  type ReadyFacts,
} from '../../src/addons/outreach/readiness';
import { MainOfferParts } from '../../src/main-offer/parts';

const parts = MainOfferParts.parse({
  who: { work: 'Roofers', slice: 'with 2 to 3 crews' },
  price: { amount: '$2,000 a month' },
  line: 'We help roofers with 2 to 3 crews get 10 to 20 booked inspections a month.',
});
const allTicked = (version: number | null) =>
  Object.fromEntries(PROFILE_ITEMS.map((i) => [i, { at: '2026-10-14T10:00:00.000Z', version }]));
const ready: ReadyFacts = {
  offer: { version: 1, parts, before: null },
  playbooks: [{ name: 'Roofers', niche: 'Roofers in Ohio', problem: 'Slow winters', proof: [] }],
  profile: allTicked(1),
  numbers: { goal: 8, at: '2026-10-14T10:00:00.000Z' },
  canOffer: true,
  canPlaybooks: true,
};
const stateOf = (f: ReadyFacts) =>
  Object.fromEntries(readinessOf(f).items.map((i) => [i.item, i.state]));

describe('getting ready', () => {
  it('is ready with every item done', () => {
    expect(readinessOf(ready)).toMatchObject({ ready: true, next: null, changed: [] });
  });

  it('says what’s left, first item first, and an owner can do the business’s', () => {
    const r = readinessOf({
      ...ready,
      offer: null,
      profile: {},
      numbers: { goal: null, at: null },
    });
    expect(r.ready).toBe(false);
    expect(r.next).toBe('offer');
    expect(stateOf({ ...ready, offer: null })).toMatchObject({ offer: 'todo' });
    expect(r.items.find((i) => i.item === 'profile')!.left).toBe(
      '6 things left to check on your Facebook profile.',
    );
    expect(notReadyWords(r)).toBe(
      'Your business’s main offer isn’t live yet. Finish it under Get ready on the Today tab.',
    );
  });

  it('has someone who can’t do the business’s items wait on them, and do their own', () => {
    const member = { ...ready, offer: null, playbooks: [], canOffer: false, canPlaybooks: false };
    expect(stateOf(member)).toEqual({
      offer: 'waiting',
      playbook: 'waiting',
      profile: 'done',
      numbers: 'done',
    });
    expect(notReadyWords(readinessOf(member))).toBe(READY_WORDS.left.offerWaiting);
  });

  it('wants a playbook’s niche and its problem, and proof only when the business has some', () => {
    const playbook = (p: Partial<ReadyFacts['playbooks'][number]>) =>
      readinessOf({ ...ready, playbooks: [{ ...ready.playbooks[0]!, ...p }] }).items.find(
        (i) => i.item === 'playbook',
      )!;
    expect(playbook({ niche: null }).left).toBe('Pick a niche for Roofers on the Playbooks tab.');
    expect(playbook({ problem: ' ' }).left).toBe('Write the niche’s biggest problem in Roofers.');
    expect(playbook({}).state).toBe('done');
    const withProof = {
      ...ready,
      offer: { ...ready.offer!, parts: { ...parts, proof: ['14 jobs'] } },
    };
    expect(stateOf(withProof).playbook).toBe('todo');
    expect(
      stateOf({ ...withProof, playbooks: [{ ...ready.playbooks[0]!, proof: ['14 jobs'] }] })
        .playbook,
    ).toBe('done');
  });

  it('asks for a look again at the profile when the main offer changes, saying what changed', () => {
    const v2 = MainOfferParts.parse({ ...parts, price: { amount: '$2,500 a month' } });
    const r = readinessOf({ ...ready, offer: { version: 2, parts: v2, before: parts } });
    expect(stateOf({ ...ready, offer: { version: 2, parts: v2, before: parts } }).profile).toBe(
      'look_again',
    );
    expect(r.changed).toEqual(['Price']);
    // Ticked before any version was live, they count for the first.
    expect(tickCounts({ at: '2026-10-14T10:00:00.000Z', version: null }, 1)).toBe(true);
    expect(tickCounts({ at: '2026-10-14T10:00:00.000Z', version: null }, 2)).toBe(false);
    expect(changedParts(parts, { ...parts, line: 'We help roofers.' })).toEqual(['The line']);
  });
});

describe('your numbers', () => {
  it('works a goal into a day, as the video does', () => {
    const m = numbersMath({ goal: 8, daysAWeek: 5 });
    expect(m).toMatchObject({
      daysAMonth: 22,
      messagesADay: { low: 14, high: 28 },
      canSend: 15,
      pace: { low: 4, high: 8 },
      fits: 'maybe',
    });
    expect(numbersLines(8, m)).toEqual([
      '8 calls a month ÷ 22 working days = 0.4 calls a day',
      '0.4 calls a day ÷ 1 in 3 who say yes book = 1.1 yeses a day',
      '1.1 yeses a day ÷ 4 to 8% of first messages = 14 to 28 first messages a day',
    ]);
  });

  it('says plainly when a goal is past one account’s safe pace, and what helps', () => {
    expect(numbersMath({ goal: 4, daysAWeek: 5 }).fits).toBe('yes');
    const big = numbersMath({ goal: 30, daysAWeek: 5 });
    expect(big.fits).toBe('no');
    expect(numbersVerdict(big)).toContain('more than one Facebook account can reach');
    expect(numbersVerdict(big)).toContain('working Saturdays');
    // A business's lower limit lowers the pace.
    expect(numbersMath({ goal: 8, daysAWeek: 5, canSend: 5 }).pace).toEqual({ low: 1, high: 2 });
  });
});
