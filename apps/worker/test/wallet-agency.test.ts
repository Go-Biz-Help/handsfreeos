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
});

describe('topping up', () => {
  it('tops up a business on the wallet that has run low', () => {
    expect(decideRecharge(low('warn'), now)).not.toBeNull();
  });

  it('never charges the card of a business its agency pays for', () => {
    expect(decideRecharge(low('agency'), now)).toBeNull();
  });
});
