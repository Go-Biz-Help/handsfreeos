/**
 * A business its agency pays for is never topped up: its usage is the agency's to pay, so its card, if it has
 * one, is never charged for it — however far below its floor the balance runs.
 */
import { describe, expect, it } from 'vitest';
import { decideRecharge } from '../src/money/recharge';

const now = Date.UTC(2026, 8, 26, 12);
const low = (stage: string): Parameters<typeof decideRecharge>[0] => ({
  workspace_id: '00000000-0000-4000-8000-000000000001',
  organization_id: '00000000-0000-4000-8000-000000000002',
  balance_cents: -5_000,
  floor_cents: 500,
  topup_cents: 2_500,
  auto_topup: true,
  method_token: 'card_tok',
  customer_ref: 'cus_1',
  provider: 'stripe',
  suspended_at: null,
  paused_until: null,
  escalation_step: 0,
  recharges_in_window: 0,
  window_started_at: null,
  last_recharge_at: null,
  pending_recharges: 0,
  spent_30d_cents: 5_000,
  stage,
  workspace_created_at: new Date(now - 90 * 24 * 60 * 60 * 1000),
  in_trial: false,
});

describe('topping up', () => {
  it('tops up a business on the wallet that has run low', () => {
    expect(decideRecharge(low('warn'), now)).not.toBeNull();
  });

  it('never charges the card of a business its agency pays for', () => {
    expect(decideRecharge(low('agency'), now)).toBeNull();
  });

  it('leaves the card alone while the plan is in its free trial', () => {
    expect(decideRecharge({ ...low('enforce'), in_trial: true }, now)).toBeNull();
  });

  // The wallet is read with raw SQL, where timestamps and counts arrive as text. Treating them as Dates threw
  // "workspace_created_at.getTime is not a function" on every hourly sweep from 12 Nov, and no balance was topped up.
  it('tops up from the row as the database hands it over, with timestamps and counts as text', () => {
    const asText = {
      ...low('enforce'),
      workspace_created_at: '2026-06-28 12:00:00.123456+00',
      window_started_at: '2026-09-20 08:00:00+00',
      last_recharge_at: '2026-09-20 08:00:00+00',
      paused_until: '2026-09-01 00:00:00+00',
      pending_recharges: '0',
    };
    expect(decideRecharge(asText, now)).toMatchObject({ amountCents: expect.any(Number) });
    expect(decideRecharge({ ...asText, pending_recharges: '1' }, now)).toBeNull();
    expect(decideRecharge({ ...asText, paused_until: '2026-09-27 00:00:00+00' }, now)).toBeNull();
  });
});
