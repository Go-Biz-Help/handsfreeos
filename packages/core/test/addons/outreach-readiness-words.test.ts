/**
 * Get ready for your best results (../../src/addons/outreach/readiness.ts, decision 63): where each item stands, what
 * changed in a new main offer, the profile as advice that never holds the day (decision 90), why Start my day waits in
 * words that name what and where, and the numbers worked as the video works them, honest about the safe pace of every
 * network the person works (decision 88). Pure.
 */
import { describe, expect, it } from 'vitest';
import { NETWORKS_DEFAULTS, NO_RULES } from '../../src/addons/outreach/automation';
import {
  ADVICE_ITEMS,
  adviceLeft,
  blocksStart,
  changedParts,
  firstHolding,
  holdingCount,
  notReadyWords,
  numbersLines,
  numbersMath,
  numbersPace,
  numbersVerdict,
  PROFILE_ITEMS,
  READY_WORDS,
  readinessOf,
  tickCounts,
  type ReadyFacts,
} from '../../src/addons/outreach/readiness';
import { checkCounts, type ProfileCheck } from '../../src/addons/outreach/profile-check';
import { MainOfferParts } from '../../src/main-offer/parts';

const parts = MainOfferParts.parse({
  who: { work: 'Roofers', slice: 'with 2 to 3 crews' },
  price: { amount: '$2,000 a month' },
  line: 'We help roofers with 2 to 3 crews get 10 to 20 booked inspections a month.',
});
const at = '2026-10-14T10:00:00.000Z';
const ticked = (items: readonly string[], version: number | null) =>
  Object.fromEntries(items.map((i) => [i, { at, version }]));
/** The AI's check, read against `version`: the picture, cover and bio right, the rest to change. */
const check = (version: number | null): ProfileCheck => ({
  items: Object.fromEntries(
    PROFILE_ITEMS.map((i) => [
      i,
      ['picture', 'cover', 'bio'].includes(i)
        ? { ok: true, why: 'Looks right.', fix: null }
        : { ok: false, why: 'Not there yet.', fix: 'Add it.' },
    ]),
  ) as ProfileCheck['items'],
  bios: ['I help roofers fill their calendars.'],
  coverLine: 'More booked jobs for roofers',
  feature: [],
  at,
  version,
});
const ready: ReadyFacts = {
  offer: { version: 1, parts, before: null },
  playbooks: [
    {
      name: 'Roofers',
      niche: 'Roofers in Ohio',
      problem: 'Slow winters',
      proof: [],
    },
  ],
  // The rest ticked by hand once done.
  profile: ticked(['work', 'featured', 'posts'], 1),
  profileCheck: check(1),
  messages: { at, version: 1 },
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
      profileCheck: null,
      numbers: { goal: null, at: null },
    });
    expect(r.ready).toBe(false);
    expect(r.next).toBe('offer');
    expect(stateOf({ ...ready, offer: null })).toMatchObject({ offer: 'todo' });
    expect(r.items.find((i) => i.item === 'profile')!.left).toBe(READY_WORDS.left.profileRead);
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
      // OK'd for a version that isn't live any more: there's none live now.
      messages: 'todo',
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
    expect(playbook({ problem: ' ' }).left).toBe(
      'Write the niche’s biggest problem in Roofers on the Playbooks tab.',
    );
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

  it('wants the profile read by the extension, each item right by the AI or ticked done', () => {
    const left = (f: Partial<ReadyFacts>) =>
      readinessOf({ ...ready, ...f }).items.find((i) => i.item === 'profile')!;
    // Ticks alone aren't enough: the extension reads it first.
    expect(left({ profileCheck: null, profile: ticked(PROFILE_ITEMS, 1) })).toMatchObject({
      state: 'todo',
      left: READY_WORDS.left.profileRead,
    });
    // Read, with three to change and none ticked yet.
    expect(left({ profile: {} })).toMatchObject({
      state: 'todo',
      left: '3 things left to change on your Facebook profile.',
    });
    expect(left({}).state).toBe('done');
    expect(checkCounts(check(null), 1)).toBe(true);
    expect(checkCounts(check(1), 2)).toBe(false);
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

  it('wants the messages OK’d since the live version, after the offer and a niche', () => {
    const messages = (f: Partial<ReadyFacts>) =>
      readinessOf({ ...ready, ...f }).items.find((i) => i.item === 'messages')!;
    expect(messages({}).state).toBe('done');
    expect(messages({ messages: null })).toMatchObject({
      state: 'todo',
      left: READY_WORDS.left.messages,
    });
    expect(messages({ messages: null, playbooks: [] }).left).toBe(READY_WORDS.left.messagesFirst);
    const v2 = MainOfferParts.parse({ ...parts, price: { amount: '$2,500 a month' } });
    expect(messages({ offer: { version: 2, parts: v2, before: parts } })).toMatchObject({
      state: 'look_again',
      left: READY_WORDS.left.messagesAgain,
    });
    expect(notReadyWords(readinessOf({ ...ready, messages: null }))).toBe(
      'You haven’t OK’d how your messages read yet. Finish it under Get ready on the Today tab.',
    );
  });

  it('never holds the day on the profile: it’s advice, still shown with what’s left (decision 90)', () => {
    expect([...ADVICE_ITEMS]).toEqual(['profile']);
    expect(blocksStart('profile')).toBe(false);
    expect(blocksStart('numbers')).toBe(true);
    // Not read yet, read with things to change, or wanting a look again: ready all the same.
    const v2 = MainOfferParts.parse({ ...parts, price: { amount: '$2,500 a month' } });
    for (const f of [
      { profileCheck: null, profile: {} },
      { profile: {} },
      {
        offer: { version: 2, parts: v2, before: parts },
        messages: { at, version: 2 },
      },
    ] satisfies Partial<ReadyFacts>[]) {
      const r = readinessOf({ ...ready, ...f });
      expect(r).toMatchObject({ ready: true, next: null });
      expect(firstHolding(r.items)).toBeUndefined();
      expect(adviceLeft(r.items).map((i) => i.item)).toEqual(['profile']);
      expect(notReadyWords(r)).toBe('');
      // Get ready counts what holds the day: the profile is shown, never counted.
      expect(holdingCount(r.items)).toEqual({ done: 4, of: 4 });
    }
    // A look again says what changed, though the day isn't held.
    expect(
      readinessOf({
        ...ready,
        offer: { version: 2, parts: v2, before: parts },
        messages: { at, version: 2 },
      }).changed,
    ).toEqual(['Price']);
    // With the profile and the messages left, the messages are what holds it, and what's said.
    const both = readinessOf({ ...ready, profile: {}, messages: null });
    expect(both).toMatchObject({ ready: false, next: 'messages' });
    expect(holdingCount(both.items)).toEqual({ done: 3, of: 4 });
    expect(notReadyWords(both)).toBe(
      'You haven’t OK’d how your messages read yet. Finish it under Get ready on the Today tab.',
    );
  });

  it('says what holds the day and where it’s done, by the item that does', () => {
    // A playbook says which part of which, and where.
    const problem = readinessOf({
      ...ready,
      playbooks: [{ ...ready.playbooks[0]!, problem: null }],
    });
    expect(notReadyWords(problem)).toBe(
      'No playbook is ready to use yet. Write the niche’s biggest problem in Roofers on the Playbooks tab.',
    );
    expect(notReadyWords(readinessOf({ ...ready, playbooks: [] }))).toBe(
      'No playbook is ready to use yet. Write a playbook and pick its niche on the Playbooks tab.',
    );
    // On another network with none running there, its own line says so, and where.
    const onLinkedIn = readinessOf({ ...ready, playbooks: [], platform: 'linkedin' });
    expect(notReadyWords({ ...onLinkedIn, platform: 'linkedin' })).toBe(
      READY_WORDS.left.playbookNoneOn('linkedin'),
    );
    // Messages OK'd for an older version want a look again, said so.
    const v2 = MainOfferParts.parse({ ...parts, price: { amount: '$2,500 a month' } });
    expect(
      notReadyWords(readinessOf({ ...ready, offer: { version: 2, parts: v2, before: parts } })),
    ).toBe(
      'Your main offer changed since you OK’d how your messages read. Look at them again under Get ready on the Today tab.',
    );
    expect(notReadyWords(readinessOf({ ...ready, numbers: { goal: null, at: null } }))).toBe(
      'Your numbers aren’t set yet. Finish it under Get ready on the Today tab.',
    );
    // Get ready's card counts only what holds the day.
    expect(READY_WORDS.cardHint(1)).toBe(
      '1 thing to do before the extension reaches anyone for you.',
    );
  });

  it('never waits on a short video: it’s the business’s to add if it wants one (decision 83)', () => {
    const messages = readinessOf(ready).items.find((i) => i.item === 'messages')!;
    expect(messages).toMatchObject({ state: 'done', left: null });
    expect(readinessOf({ ...ready, canPlaybooks: false }).ready).toBe(true);
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

  it('adds up the safe pace of every network the person works (decision 88)', () => {
    const facebookOnly = { networks: NETWORKS_DEFAULTS };
    expect(numbersPace(facebookOnly, NO_RULES)).toEqual({
      canSend: 15,
      networks: [{ platform: 'facebook', canSend: 15 }],
      more: ['linkedin', 'instagram', 'alignable'],
    });
    const three = {
      networks: {
        ...NETWORKS_DEFAULTS,
        linkedin: { ...NETWORKS_DEFAULTS.linkedin, on: true },
        instagram: { ...NETWORKS_DEFAULTS.instagram, on: true },
      },
    };
    expect(numbersPace(three, NO_RULES)).toEqual({
      canSend: 40,
      networks: [
        { platform: 'facebook', canSend: 15 },
        { platform: 'linkedin', canSend: 15 },
        { platform: 'instagram', canSend: 10 },
      ],
      more: ['alignable'],
    });
    // The business's own limits on each, and only the networks it allows.
    const rules = {
      ...NO_RULES,
      dailyLimits: { first_message: 10 },
      networkLimits: { linkedin: { first_message: 5 } },
      networksAllowed: ['facebook' as const, 'linkedin' as const],
    };
    expect(numbersPace(three, rules)).toEqual({
      canSend: 15,
      networks: [
        { platform: 'facebook', canSend: 10 },
        { platform: 'linkedin', canSend: 5 },
      ],
      more: [],
    });
    // A network whose first messages the business set to none isn't one to turn on.
    const noInstagram = { ...NO_RULES, networkLimits: { instagram: { first_message: 0 } } };
    expect(numbersPace(facebookOnly, noInstagram).more).toEqual(['linkedin', 'alignable']);
    // Working no network at all counts Facebook, as it's on to start.
    const none = { networks: { ...NETWORKS_DEFAULTS, facebook: { on: false } } };
    expect(numbersPace(none, NO_RULES).networks).toEqual([{ platform: 'facebook', canSend: 15 }]);
  });

  it('names the networks it counted, and turning on another when the goal is past them', () => {
    const both = [
      { platform: 'facebook' as const, canSend: 15 },
      { platform: 'linkedin' as const, canSend: 15 },
    ];
    // The screenshot's goal: 20 calls a month, Monday to Friday, on Facebook and LinkedIn.
    const m = numbersMath({ goal: 20, daysAWeek: 5, canSend: 30 });
    expect(m).toMatchObject({ messagesADay: { low: 35, high: 69 }, pace: { low: 8, high: 17 } });
    const verdict = numbersVerdict(m, both, ['instagram', 'alignable']);
    expect(verdict).toContain(
      'Your safe pace is 30 first messages a day: 15 on Facebook and 15 on LinkedIn. That’s about 8 to 17 calls a month.',
    );
    expect(verdict).toContain('more than Facebook and LinkedIn can reach together');
    expect(verdict).toContain('turning on Instagram or Alignable too');
    expect(verdict).not.toContain('one Facebook account');
    // A goal the networks reach together fits, though it's past Facebook's alone.
    const eight = numbersMath({ goal: 8, daysAWeek: 5, canSend: 30 });
    expect(numbersMath({ goal: 8, daysAWeek: 5 }).fits).toBe('maybe');
    expect(eight.fits).toBe('yes');
    expect(numbersVerdict(eight, both)).toMatch(/^Your safe pace is 30 .* Your goal fits\.$/);
    // One network says it on its own, in its name; none given is Facebook's, as an API from before them sends.
    const linkedIn = numbersMath({ goal: 30, daysAWeek: 5, canSend: 15 });
    expect(numbersVerdict(linkedIn, [{ platform: 'linkedin', canSend: 15 }])).toContain(
      'LinkedIn’s safe pace is 15 first messages a day',
    );
    expect(numbersVerdict(linkedIn, [{ platform: 'linkedin', canSend: 15 }])).toContain(
      'more than one LinkedIn account can reach',
    );
    expect(numbersVerdict(linkedIn)).toBe(
      `Facebook’s safe pace is 15 first messages a day, about 4 to 8 calls a month. Your goal is more than one Facebook account can reach. ${READY_WORDS.numbersHelps}`,
    );
  });
});
