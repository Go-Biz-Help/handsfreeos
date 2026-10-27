/**
 * The plan page's choices (20261027012700): which founding spots a business can buy, which one it starts on, and the
 * words around them. Pure, so the web's page and anything else that sells a spot agree.
 */
import { describe, expect, it } from 'vitest';
import {
  FOUNDING_PICK_WORDS as W,
  foundingPickable,
  foundingPickFirst,
  foundingPriceWords,
  type FoundingPickOffer,
} from '../src/support/founding-words';

const offer = (over: Partial<FoundingPickOffer> & { offerId: string }): FoundingPickOffer => ({
  name: over.offerId,
  status: 'open',
  priceCents: 49700,
  seatCap: 100,
  remaining: 100,
  billing: 'yearly',
  superseded: false,
  ...over,
});

const PARTNER = offer({ offerId: 'founding_partner', priceCents: 0, billing: 'once' });
const YEARLY = offer({ offerId: 'founding_lifetime' });
const MONTHLY = offer({
  offerId: 'monthly',
  priceCents: 9700,
  seatCap: 1000,
  remaining: 1000,
  billing: 'monthly',
});

describe('foundingPickable', () => {
  it('keeps the spots with a price that are on sale, in the order they came', () => {
    const closed = offer({ offerId: 'closed', status: 'closed' });
    const replaced = offer({ offerId: 'replaced', superseded: true });
    expect(
      foundingPickable([PARTNER, YEARLY, closed, replaced, MONTHLY]).map((o) => o.offerId),
    ).toEqual(['founding_lifetime', 'monthly']);
  });

  it('keeps a full one, so the page can say it’s taken', () => {
    expect(foundingPickable([{ ...YEARLY, remaining: 0 }, MONTHLY])).toHaveLength(2);
  });
});

describe('foundingPickFirst', () => {
  const both = [YEARLY, MONTHLY];

  it('starts on the one the website’s button named', () => {
    expect(foundingPickFirst(both, 'monthly')).toBe('monthly');
    expect(foundingPickFirst(both, 'yearly')).toBe('founding_lifetime');
  });

  it('starts on the first with room when nothing was named, or the named one is full', () => {
    expect(foundingPickFirst(both, null)).toBe('founding_lifetime');
    expect(foundingPickFirst([{ ...YEARLY, remaining: 0 }, MONTHLY], 'yearly')).toBe('monthly');
  });

  it('starts on nothing when every spot is taken', () => {
    expect(foundingPickFirst([{ ...YEARLY, remaining: 0 }], null)).toBe('');
  });
});

describe('the words', () => {
  it('says the price the way the website does', () => {
    expect(foundingPriceWords(49700, 'yearly')).toBe('$497 a year');
    expect(foundingPriceWords(9700, 'monthly')).toBe('$97 a month');
    expect(foundingPriceWords(0, 'once')).toBe('Free');
  });

  it('counts what’s left with thousands marked', () => {
    expect(W.left(988, 1000)).toBe('988 of 1,000 spots left');
    expect(W.pay(9700)).toBe('Pay $97');
  });

  it('never prices anything on the phone', () => {
    const phone = [W.phoneTitle, W.phoneBody('Lone Star Plumbing'), W.phoneCheck, W.phoneOther];
    for (const line of phone) expect(line).not.toMatch(/\$|pay|price|a year|a month/i);
  });
});
