/**
 * The plan page's choices (20261027012700): which founding spots a business can buy, which one it starts on, and the
 * words around them. Pure, so the web's page and anything else that sells a spot agree.
 */
import { describe, expect, it } from 'vitest';
import {
  FOUNDING_PICK_WORDS as W,
  foundingBusinessSeatLine,
  foundingGivenBackLine,
  foundingPickable,
  foundingPickFirst,
  foundingPriceWords,
  foundingSeatLine,
  type FoundingPickOffer,
  type FoundingSeatFacts,
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

describe('a spot the business picked itself, in Admin → Founding', () => {
  const held: FoundingSeatFacts = {
    status: 'reserved',
    offerId: 'monthly',
    reservedAt: '2026-10-27T15:00:00.000Z',
    expiresAt: '2026-10-27T16:00:00.000Z',
    activatedAt: null,
    revokedAt: null,
    revokeReason: '',
    graceEndsAt: null,
    checkoutStatus: 'open',
    checkoutProblem: '',
    selfServe: true,
  };

  it('says it was picked, not approved, while they pay', () => {
    const line = foundingSeatLine(held);
    expect(line).toMatch(/picked .* on the plan page, not paid yet · paying now$/);
    expect(line).not.toMatch(/approved/);
    const business = foundingBusinessSeatLine(
      { ...held, offerName: 'Founding Monthly', workspaceId: null, workspaceName: null },
      'ws',
    );
    expect(business).toMatch(/^Founding Monthly · picked .* on the plan page, not paid yet$/);
  });

  it('says it was never paid once the hold lapses', () => {
    expect(foundingGivenBackLine({ ...held, status: 'expired' })).toMatch(
      /^picked on the plan page, never paid · expired /,
    );
  });

  it('still says approved for a spot staff approved', () => {
    expect(foundingSeatLine({ ...held, selfServe: false })).toMatch(/approved .*, not taken up/);
    expect(foundingGivenBackLine({ ...held, selfServe: false, status: 'expired' })).toMatch(
      /^never taken up · expired /,
    );
  });
});
