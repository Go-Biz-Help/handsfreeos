/**
 * The nightly true-up's decisions (M16, step 4). Every charge the wallet writes is a guess from our own rate
 * card, because a carrier's price arrives late or not at all; this is where the guess meets the truth, and
 * these are the four judgements it makes about what to do with the difference.
 *
 * No database: a fake `chargeUsage` records what it was asked to write.
 */
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  CARRIER_CATEGORIES,
  dayToReconcile,
  nextReconcileAt,
  reconcileDay,
} from '../src/money/reconcile';
import * as wallet from '../src/money/wallet';
import type { DailyUsage } from '../src/telephony/provider';
import type { TenantScope } from '../src/services';

const scope: TenantScope = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
};
const ctx = { wallet: { db: null as never, log: pino({ level: 'silent' }), mode: 'on' as const } };
const DAY = '2026-09-18';

function watch() {
  const asked: wallet.ChargeInput[] = [];
  vi.spyOn(wallet, 'chargeUsage').mockImplementation(async (_d, _s, input) => {
    asked.push(input);
    return {
      recorded: true,
      amountCents: input.amountCents ?? 0,
      costCents: input.costCents ?? 0,
      balanceAfterCents: 0,
      crossed: null,
    };
  });
  return asked;
}

/** A carrier line, in micro-dollars, the way Twilio reports one. */
const line = (category: string, dollars: number, count = 1): DailyUsage => ({
  day: DAY,
  category,
  count,
  costMicros: Math.round(dollars * 1_000_000),
});

describe('where the carrier charged more than we did', () => {
  it('writes one adjustment, at the card’s markup, for the difference only', async () => {
    const asked = watch();
    // Twilio says $2.00 of outbound texts; our ledger says $1.00 of cost. The shortfall is 100c of cost.
    const found = await reconcileDay(
      ctx,
      scope,
      DAY,
      [line('sms-outbound', 2)],
      new Map([['sms-outbound', 100]]),
    );
    expect(found.rows).toBe(1);
    expect(asked[0]).toMatchObject({
      kind: 'adjustment',
      costCents: 100,
      amountCents: 150,
      costSource: 'reconciled',
      idempotencyKey: 'reconcile:sms-outbound:2026-09-18',
    });
    // Never the whole of the carrier's number: we already charged for most of it.
    expect(asked[0]!.amountCents).toBeLessThan(300);
    vi.restoreAllMocks();
  });

  it('dates it to the day it covers, not the night it ran', async () => {
    const asked = watch();
    await reconcileDay(ctx, scope, DAY, [line('sms-outbound', 2)], new Map());
    expect(asked[0]!.occurredAt?.toISOString()).toBe('2026-09-18T23:59:00.000Z');
    vi.restoreAllMocks();
  });

  it('keys it so running the same week again writes nothing', async () => {
    const asked = watch();
    for (let i = 0; i < 3; i += 1)
      await reconcileDay(ctx, scope, DAY, [line('calls-inbound', 5)], new Map());
    // Three passes, three identical keys: the ledger's unique index makes them one row.
    expect(new Set(asked.map((a) => a.idempotencyKey)).size).toBe(1);
    vi.restoreAllMocks();
  });
});

describe('where we charged more than the carrier did', () => {
  /**
   * Deliberate. Giving money back is somebody's decision, not a nightly job's, and nobody should wake up to a
   * job having quietly rewritten their statement in either direction.
   */
  it('leaves it alone rather than taking money back while everyone sleeps', async () => {
    const asked = watch();
    const found = await reconcileDay(
      ctx,
      scope,
      DAY,
      [line('sms-outbound', 1)],
      new Map([['sms-outbound', 300]]),
    );
    expect(found.rows).toBe(0);
    expect(asked).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('ignores a difference too small to be worth a line on a statement', async () => {
    const asked = watch();
    // Two cents of cost, three of charge: carriers round differently and a busy day always disagrees a little.
    await reconcileDay(
      ctx,
      scope,
      DAY,
      [line('sms-outbound', 1.02)],
      new Map([['sms-outbound', 100]]),
    );
    expect(asked).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

describe('a category we price at nothing', () => {
  /** This is the point of the whole job: recordings and carrier fees were free until somebody noticed. */
  it('is charged in full, and says on the statement that it came from the carrier', async () => {
    const asked = watch();
    await reconcileDay(ctx, scope, DAY, [line('recordings', 0.4)], new Map());
    expect(asked[0]).toMatchObject({ costCents: 40, amountCents: 60 });
    expect(asked[0]!.subject).toBe('Carrier charge for recordings on Sep 18');
    vi.restoreAllMocks();
  });

  it('reads differently from a correction to something we did charge for', async () => {
    const asked = watch();
    await reconcileDay(
      ctx,
      scope,
      DAY,
      [line('sms-outbound', 2)],
      new Map([['sms-outbound', 100]]),
    );
    expect(asked[0]!.subject).toBe('Correction for sms-outbound on Sep 18');
    vi.restoreAllMocks();
  });
});

describe('a category nothing here has heard of', () => {
  /**
   * Reported, never guessed at. The alternative — charging for anything the carrier names — is how a parent
   * category like `sms` (which is `sms-inbound` plus `sms-outbound`) ends up billed on top of its own children.
   */
  it('is named in the result rather than charged for', async () => {
    const asked = watch();
    const found = await reconcileDay(
      ctx,
      scope,
      DAY,
      [line('some-new-thing', 9), line('sms-outbound', 2)],
      new Map(),
    );
    expect(found.unknown).toEqual(['some-new-thing']);
    expect(asked.map((a) => a.meta?.['carrier_category'])).toEqual(['sms-outbound']);
    vi.restoreAllMocks();
  });

  it('includes the parent categories, which are the sums of their own children', async () => {
    // If `sms` were ever charged alongside `sms-inbound` and `sms-outbound`, every text would cost twice.
    for (const parent of ['sms', 'calls', 'mms', 'phonenumbers', 'totalprice'])
      expect(CARRIER_CATEGORIES, parent).not.toHaveProperty(parent);
    expect(CARRIER_CATEGORIES).toHaveProperty('sms-inbound');
    expect(CARRIER_CATEGORIES).toHaveProperty('sms-outbound');
  });
});

describe('an inbound call', () => {
  it('counts both our local and toll-free rates against the carrier’s one category', async () => {
    // Twilio calls it all `calls-inbound`; we price a toll-free minute at two and a half times a local one.
    expect(CARRIER_CATEGORIES['calls-inbound']).toEqual([
      'voice.inbound.local.minute',
      'voice.inbound.tollfree.minute',
    ]);
  });
});

describe('when it runs', () => {
  it('reaches two days back, so it reads a day the carrier has finished settling', async () => {
    expect(dayToReconcile(Date.parse('2026-09-20T04:00:00Z'))).toBe('2026-09-18');
  });

  it('runs at four in the morning, tonight or tomorrow', () => {
    expect(nextReconcileAt(Date.parse('2026-09-20T01:00:00Z')).toISOString()).toBe(
      '2026-09-20T04:00:00.000Z',
    );
    expect(nextReconcileAt(Date.parse('2026-09-20T09:00:00Z')).toISOString()).toBe(
      '2026-09-21T04:00:00.000Z',
    );
  });
});
