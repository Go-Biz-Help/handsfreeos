/**
 * The two ladders, and the cases that decide whether they are kind or cruel.
 *
 * Chris's own case is the first one here: four top-ups in three days should be one bigger charge, not four
 * small ones, and the business should be told why in a sentence that also says how to stop it. The rest are
 * the ways that could go wrong — a runaway putting thousands on a card, a ceiling so tight a new business
 * cannot top up at all, a dead card retried forever.
 */
import { describe, expect, it } from 'vitest';
import {
  afterDecline,
  escalationCeilingCents,
  escalationWords,
  ESCALATION_HARD_CAP_CENTS,
  needsTopUp,
  nextEscalation,
  type EscalationState,
} from '../src/money/wallet-ladders';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-20T12:00:00Z');
const OLD_BUSINESS = NOW - 200 * DAY;

const fresh: EscalationState = {
  step: 0,
  recharges: 0,
  windowStartedAt: null,
  lastRechargeAt: null,
};

const climb = (over: Partial<EscalationState>, at = NOW, spent = 100_000) =>
  nextEscalation({
    state: { ...fresh, ...over },
    topupCents: 2500,
    spent30dCents: spent,
    workspaceCreatedAt: OLD_BUSINESS,
    now: at,
  });

describe('escalation', () => {
  it('charges what the business chose, the first time', () => {
    const first = climb({});
    expect(first.amountCents).toBe(2500);
    expect(first.step).toBe(0);
    expect(first.warnFirst).toBe(false);
  });

  /** Chris's case: four times in three days is one charge of $200, not four of $25. */
  it('doubles each time inside the window: $25, $50, $100, $200', () => {
    const start = NOW - 60 * HOUR;
    const amounts: number[] = [];
    let state = fresh;
    for (let i = 0; i < 4; i += 1) {
      // Spread out enough not to count as a rush, and inside the 72-hour window throughout.
      const at = start + i * 12 * HOUR;
      const next = climb(state, at);
      amounts.push(next.amountCents);
      state = {
        step: next.step,
        recharges: next.recharges,
        windowStartedAt: next.windowStartedAt,
        lastRechargeAt: at,
      };
    }
    expect(amounts).toEqual([2500, 5000, 10_000, 20_000]);
  });

  it('jumps two rungs when two top-ups come within six hours of each other', () => {
    // Not a business using its phone: a workflow in a loop, or an import gone wrong.
    const rushed = climb({
      step: 0,
      recharges: 1,
      windowStartedAt: NOW - 2 * HOUR,
      lastRechargeAt: NOW - HOUR,
    });
    expect(rushed.step).toBe(2);
    expect(rushed.amountCents).toBe(10_000);
  });

  it('stops climbing at the top rung', () => {
    const top = climb({
      step: 4,
      recharges: 9,
      windowStartedAt: NOW - 40 * HOUR,
      lastRechargeAt: NOW - 20 * HOUR,
    });
    expect(top.step).toBe(4);
    // Sixteen times $25 is $400, which is both the rung and the multiple ceiling.
    expect(top.amountCents).toBe(40_000);
  });

  it('starts again at the bottom after three quiet days', () => {
    const after = climb(
      { step: 4, recharges: 9, windowStartedAt: NOW - 80 * HOUR, lastRechargeAt: NOW - 80 * HOUR },
      NOW,
    );
    expect(after.step).toBe(0);
    expect(after.amountCents).toBe(2500);
    expect(after.recharges).toBe(1);
  });

  it('measures the window from the first top-up of a run, not the last', () => {
    // Otherwise a business topping up every 20 hours forever would climb the ladder without end.
    const long = climb({
      step: 3,
      recharges: 4,
      windowStartedAt: NOW - 80 * HOUR,
      lastRechargeAt: NOW - 20 * HOUR,
    });
    expect(long.step).toBe(0);
  });
});

describe('the ceilings', () => {
  /**
   * The top rung already is sixteen times, so this ceiling never binds on its own — it is there so that raising
   * the number of rungs cannot quietly double what a card is charged. `cappedBy` is null because nothing was
   * actually held back.
   */
  it('never charges more than sixteen times what the business chose', () => {
    const big = nextEscalation({
      state: { step: 4, recharges: 9, windowStartedAt: NOW - HOUR, lastRechargeAt: NOW - HOUR },
      topupCents: 1000,
      spent30dCents: 10_000_000,
      workspaceCreatedAt: OLD_BUSINESS,
      now: NOW,
    });
    expect(big.amountCents).toBe(16_000);
    expect(big.cappedBy).toBeNull();
  });

  it('never charges more than five hundred dollars at once', () => {
    const runaway = nextEscalation({
      state: {
        step: 3,
        recharges: 4,
        windowStartedAt: NOW - HOUR,
        lastRechargeAt: NOW - 10 * HOUR,
      },
      topupCents: 5000,
      spent30dCents: 100_000_000,
      workspaceCreatedAt: OLD_BUSINESS,
      now: NOW,
    });
    // The ladder wanted $800; the hard cap is $500.
    expect(runaway.amountCents).toBe(ESCALATION_HARD_CAP_CENTS);
    expect(runaway.cappedBy).toBe('hard');
  });

  /**
   * A business that deliberately set a $1,000 top-up gets $1,000. The ceilings hold escalation down, and
   * overruling somebody's own choice would be a wallet that cannot be topped up at all.
   */
  it('never holds a business under the amount it chose itself', () => {
    const chosen = nextEscalation({
      state: fresh,
      topupCents: 100_000,
      spent30dCents: 0,
      workspaceCreatedAt: OLD_BUSINESS,
      now: NOW,
    });
    expect(chosen.amountCents).toBe(100_000);
    expect(chosen.cappedBy).toBeNull();
  });

  it('holds a top-up to half of what last month cost', () => {
    const modest = nextEscalation({
      state: {
        step: 2,
        recharges: 3,
        windowStartedAt: NOW - 20 * HOUR,
        lastRechargeAt: NOW - 10 * HOUR,
      },
      topupCents: 2500,
      spent30dCents: 12_000,
      workspaceCreatedAt: OLD_BUSINESS,
      now: NOW,
    });
    // The ladder wanted $200; half of the $120 they spent last month is $60.
    expect(modest.amountCents).toBe(6000);
    expect(modest.cappedBy).toBe('recent_spend');
  });

  /**
   * The one that would have bitten. A business that signed up this morning has spent nothing, half of nothing
   * is nothing, and a ceiling of nothing would leave them unable to put a penny on their balance.
   */
  it('does not measure a business against a month it has not had yet', () => {
    const newborn = nextEscalation({
      state: {
        step: 1,
        recharges: 2,
        windowStartedAt: NOW - 20 * HOUR,
        lastRechargeAt: NOW - 10 * HOUR,
      },
      topupCents: 2500,
      spent30dCents: 0,
      workspaceCreatedAt: NOW - 2 * DAY,
      now: NOW,
    });
    expect(newborn.amountCents).toBe(10_000);
    expect(newborn.cappedBy).toBeNull();
  });

  it('never lets a ceiling take a top-up below what the business asked for', () => {
    // At that point it is not a runaway being stopped, it is somebody's phone stopping working.
    const squeezed = nextEscalation({
      state: {
        step: 1,
        recharges: 2,
        windowStartedAt: NOW - 20 * HOUR,
        lastRechargeAt: NOW - 10 * HOUR,
      },
      topupCents: 2500,
      spent30dCents: 100,
      workspaceCreatedAt: OLD_BUSINESS,
      now: NOW,
    });
    expect(squeezed.amountCents).toBe(2500);
    expect(squeezed.cappedBy).toBeNull();
  });

  it('says somebody should be told before anything above twice their own amount', () => {
    expect(climb({}).warnFirst).toBe(false);
    expect(
      climb({
        step: 0,
        recharges: 1,
        windowStartedAt: NOW - 20 * HOUR,
        lastRechargeAt: NOW - 10 * HOUR,
      }).warnFirst,
    ).toBe(false);
    expect(
      climb({
        step: 1,
        recharges: 2,
        windowStartedAt: NOW - 20 * HOUR,
        lastRechargeAt: NOW - 10 * HOUR,
      }).warnFirst,
    ).toBe(true);
  });
});

describe('what the page says about it', () => {
  it('says why, and how to make it stop, in one breath', () => {
    const words = escalationWords({
      amountCents: 10_000,
      topupCents: 2500,
      recharges: 3,
      cappedBy: null,
    });
    expect(words).toBe(
      "Your top-up is $100 right now because you've topped up 3 times in the last three days. Raising your top-up amount makes this one charge instead of 3.",
    );
  });

  it('says when a ceiling is holding it down, and which one', () => {
    expect(
      escalationWords({
        amountCents: 6000,
        topupCents: 2500,
        recharges: 3,
        cappedBy: 'recent_spend',
      }),
    ).toContain('half of what you spent last month');
    expect(
      escalationWords({ amountCents: 40_000, topupCents: 2500, recharges: 5, cappedBy: 'hard' }),
    ).toContain('the most we will charge at once');
  });

  it('says nothing at all when nothing was raised', () => {
    expect(
      escalationWords({ amountCents: 2500, topupCents: 2500, recharges: 1, cappedBy: null }),
    ).toBeNull();
  });
});

describe('a declined card', () => {
  it('is tried again at six hours, a day, then three days', () => {
    const waits = [0, 1, 2].map((n) => {
      const out = afterDecline({
        declinesInRow: n,
        failureCode: 'insufficient_funds',
        failureMessage: 'There wasn’t enough in the account.',
        now: NOW,
      });
      return out.kind === 'retry' ? out.at - NOW : out.kind;
    });
    expect(waits).toEqual([6 * HOUR, DAY, 3 * DAY]);
  });

  it('is left alone after three tries, and the business is asked for another', () => {
    const out = afterDecline({
      declinesInRow: 3,
      failureCode: 'insufficient_funds',
      failureMessage: 'There wasn’t enough in the account.',
      now: NOW,
    });
    expect(out.kind).toBe('suspend');
    expect(out.kind === 'suspend' && out.reason).toContain('three times over four days');
  });

  /** Waiting six hours does not un-lose a lost card; it only costs the business six hours of texts. */
  it('is not tried again at all when the answer will never change', () => {
    for (const code of ['lost_card', 'stolen_card', 'expired_card', 'invalid_account'])
      expect(
        afterDecline({ declinesInRow: 0, failureCode: code, failureMessage: null, now: NOW }).kind,
        code,
      ).toBe('suspend');
  });

  it('carries the provider’s own words through to the business', () => {
    const out = afterDecline({
      declinesInRow: 0,
      failureCode: 'lost_card',
      failureMessage: 'That card was reported lost.',
      now: NOW,
    });
    expect(out.kind === 'suspend' && out.reason).toBe('That card was reported lost.');
  });
});

describe('needsTopUp', () => {
  const base = {
    balanceCents: 500,
    floorCents: 1000,
    autoTopup: true,
    hasCard: true,
    suspended: false,
    pausedUntil: null,
    now: NOW,
  };

  it('is yes at or under the floor, with a card and automatic top-up on', () => {
    expect(needsTopUp(base)).toBe(true);
    expect(needsTopUp({ ...base, balanceCents: 1000 })).toBe(true);
    expect(needsTopUp({ ...base, balanceCents: 1001 })).toBe(false);
  });

  it('is no without a card, with it turned off, or while suspended', () => {
    expect(needsTopUp({ ...base, hasCard: false })).toBe(false);
    expect(needsTopUp({ ...base, autoTopup: false })).toBe(false);
    expect(needsTopUp({ ...base, suspended: true })).toBe(false);
  });

  it('waits out a pause the decline ladder set', () => {
    expect(needsTopUp({ ...base, pausedUntil: NOW + HOUR })).toBe(false);
    expect(needsTopUp({ ...base, pausedUntil: NOW - 1 })).toBe(true);
  });
});

/**
 * The number the terms of service call "a cap shown in your account". Getting it wrong is not a bug in a
 * setting, it is a written promise that does not match what the card is charged — so it has to be the ceiling
 * that actually applies to this business today, never the headline one.
 */
describe('escalationCeilingCents', () => {
  const ceiling = (over: Partial<Parameters<typeof escalationCeilingCents>[0]> = {}) =>
    escalationCeilingCents({
      topupCents: 2500,
      spent30dCents: 100_000,
      workspaceCreatedAt: OLD_BUSINESS,
      now: NOW,
      ...over,
    });

  it('is sixteen times their own amount when nothing else binds', () => {
    expect(ceiling()).toBe(2500 * 16);
  });

  it('never reads higher than the hard cap', () => {
    // A $100 top-up: sixteen times that is $1,600, and nobody is ever charged that in one go.
    expect(ceiling({ topupCents: 10_000 })).toBe(ESCALATION_HARD_CAP_CENTS);
  });

  it('reads above the hard cap for somebody who chose an amount above it', () => {
    // The ceilings hold *escalation* down; they never hold a business under the amount it chose on purpose.
    // A $1,000 top-up is charged in full, so $1,000 is the honest number to print, not $500.
    expect(ceiling({ topupCents: 100_000 })).toBe(100_000);
  });

  it('shows half of last month’s spend when that is the ceiling in force', () => {
    // $200 spent in 30 days holds the ceiling to $100 — above their own $25, below 16 × $25.
    expect(ceiling({ spent30dCents: 20_000 })).toBe(10_000);
  });

  it('never reads lower than the amount they chose, because that is always charged in full', () => {
    // Half of a nearly empty month is pennies; their own $25 still goes through, so $25 is the honest cap.
    expect(ceiling({ spent30dCents: 100 })).toBe(2500);
  });

  it('ignores last month for a business that has not had one', () => {
    expect(ceiling({ spent30dCents: 0, workspaceCreatedAt: NOW - 3 * DAY })).toBe(2500 * 16);
  });

  it('is never below what the next top-up would actually be', () => {
    // The promise only holds if the cap bounds the ladder. Walk a long run and check every rung.
    let state: EscalationState = { ...fresh, windowStartedAt: NOW, lastRechargeAt: NOW };
    const cap = ceiling();
    for (let i = 0; i < 8; i++) {
      const next = nextEscalation({
        state,
        topupCents: 2500,
        spent30dCents: 100_000,
        workspaceCreatedAt: OLD_BUSINESS,
        now: NOW + i * HOUR,
      });
      expect(next.amountCents).toBeLessThanOrEqual(cap);
      state = {
        step: next.step,
        recharges: next.recharges,
        windowStartedAt: next.windowStartedAt,
        lastRechargeAt: NOW + i * HOUR,
      };
    }
  });
});
