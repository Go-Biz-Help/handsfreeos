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
      videoLink: 'https://www.loom.com/share/abc123',
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

  it('waits on the playbook’s short video, which an owner or admin links', () => {
    const noVideo = { playbooks: [{ ...ready.playbooks[0]!, videoLink: null }] };
    const messages = (f: Partial<ReadyFacts>) =>
      readinessOf({ ...ready, ...noVideo, ...f }).items.find((i) => i.item === 'messages')!;
    expect(messages({})).toMatchObject({ state: 'todo', left: READY_WORDS.left.messagesVideo });
    expect(messages({ canPlaybooks: false })).toMatchObject({
      state: 'waiting',
      whose: 'business',
      left: READY_WORDS.left.messagesVideoWaiting,
    });
    expect(readinessOf({ ...ready, ...noVideo }).ready).toBe(false);
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
