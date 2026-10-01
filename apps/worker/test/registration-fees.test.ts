/**
 * The carriers' texting registration fees on the wallet, at cost (money/registration-fees.ts), on the real
 * database: a brand is charged once however often it's sent, with its extra check only over 1,000 texts a month;
 * each campaign sent is a review; and an approved campaign pays a month at a time from the day it was approved,
 * once per month, in an account that's still open.
 */
import { randomUUID } from 'node:crypto';
import { executeCommand, organizationCreate } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs } from '@hfos/db/testing';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chargeAllCampaignMonths,
  chargeCampaignMonths,
  chargeRegistrationSent,
} from '../src/money/registration-fees';
import type { WalletDeps } from '../src/money/wallet';
import type { TenantScope } from '../src/services';

const admin = () => testDbs().admin.db;
const log = pino({ level: 'silent' });
let deps: WalletDeps;
const DAY = 24 * 60 * 60_000;

async function business(name: string): Promise<TenantScope> {
  const owner = await createTestUser(`a2p-fees-${name}`);
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: `A2P Fees ${name}` },
    { type: 'human', userId: owner.id, email: owner.email, claims: owner.claims },
    { correlationId: randomUUID(), channel: 'test' },
  );
  return { workspaceId: output.workspaceId, organizationId: output.organizationId };
}

/** An account, open or closed, with an approved campaign in it. */
async function approvedCampaign(
  scope: TenantScope,
  approvedAt: Date,
  status: 'active' | 'closed' = 'active',
): Promise<string> {
  const sid = `QE${randomUUID().replace(/-/g, '')}`;
  await rows(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${scope.workspaceId}, 'fake', ${`AC${randomUUID().slice(0, 8)}`}, ${status})`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, kind, status, provider_sid, approved_at)
        values (${scope.workspaceId}, 'a2p_campaign', 'approved', ${sid}, ${approvedAt.toISOString()})`,
  );
  return sid;
}

const ledger = (scope: TenantScope, key: string) =>
  rows<{
    amount_cents: string;
    cost_cents: string;
    unit: string;
    subject: string;
    idempotency_key: string;
    occurred_at: Date;
  }>(
    admin(),
    sql`select amount_cents::text, cost_cents::text, unit::text, subject, idempotency_key, occurred_at
        from app.usage_ledger where workspace_id = ${scope.workspaceId} and rate_key = ${key}
        order by occurred_at`,
  );

beforeAll(() => {
  deps = { db: testDbs().worker.db, log, mode: 'shadow' };
});
afterAll(async () => {
  await closeTestDbs();
});

describe('sending a brand', () => {
  it('charges $4.50 once, and the extra check for over 1,000 texts a month, at cost', async () => {
    const scope = await business('brand-big');
    const sent = {
      kind: 'a2p_brand' as const,
      providerSid: `BN${randomUUID().replace(/-/g, '')}`,
      again: false,
      monthlyVolume: '1000_10000',
      registrationId: randomUUID(),
    };
    await chargeRegistrationSent(deps, scope, sent);
    expect(await ledger(scope, 'a2p.brand.registration')).toEqual([
      expect.objectContaining({
        amount_cents: '-450',
        cost_cents: '450',
        unit: 'fee',
        subject: 'Registering your business for texting',
      }),
    ]);
    expect(await ledger(scope, 'a2p.brand.vetting')).toEqual([
      expect.objectContaining({ amount_cents: '-4150', cost_cents: '4150', unit: 'fee' }),
    ]);
    // Sent again after a rejection: same sid, free at Twilio, free here. A retry of the first send lands on
    // the same keys and counts once.
    await chargeRegistrationSent(deps, scope, { ...sent, again: true });
    await chargeRegistrationSent(deps, scope, sent);
    expect(await ledger(scope, 'a2p.brand.registration')).toHaveLength(1);
    expect(await ledger(scope, 'a2p.brand.vetting')).toHaveLength(1);
  });

  it('skips the extra check for a business sending under 1,000 texts a month', async () => {
    const scope = await business('brand-small');
    await chargeRegistrationSent(deps, scope, {
      kind: 'a2p_brand',
      providerSid: `BN${randomUUID().replace(/-/g, '')}`,
      again: false,
      monthlyVolume: 'under_1000',
      registrationId: randomUUID(),
    });
    expect(await ledger(scope, 'a2p.brand.registration')).toHaveLength(1);
    expect(await ledger(scope, 'a2p.brand.vetting')).toEqual([]);
  });

  it('charges nothing for the steps that cost nothing', async () => {
    const scope = await business('free-steps');
    for (const kind of [
      'a2p_customer_profile',
      'a2p_trust_product',
      'toll_free_verification',
    ] as const)
      await chargeRegistrationSent(deps, scope, {
        kind,
        providerSid: `BU${randomUUID().replace(/-/g, '')}`,
        again: false,
        registrationId: randomUUID(),
      });
    const all = await rows(
      admin(),
      sql`select 1 from app.usage_ledger where workspace_id = ${scope.workspaceId}`,
    );
    expect(all).toEqual([]);
  });
});

describe('sending a campaign', () => {
  it('charges $15 for each review, since a campaign sent again is a new campaign', async () => {
    const scope = await business('reviews');
    for (const providerSid of ['QE-first', 'QE-second'])
      await chargeRegistrationSent(deps, scope, {
        kind: 'a2p_campaign',
        providerSid: `${providerSid}-${randomUUID()}`,
        again: false,
        registrationId: randomUUID(),
      });
    const reviews = await ledger(scope, 'a2p.campaign.vetting');
    expect(reviews.map((r) => r.amount_cents)).toEqual(['-1500', '-1500']);
  });
});

describe('an approved campaign', () => {
  it('pays its first month on approval, and each month after on the same day, once', async () => {
    const scope = await business('months');
    const approvedAt = new Date(Date.now() - 60_000);
    const sid = await approvedCampaign(scope, approvedAt);
    const now = Date.now();
    expect(await chargeCampaignMonths(deps, scope, now, true)).toBe(true);
    // The daily sweep the same month finds it paid.
    expect(await chargeCampaignMonths(deps, scope, now + DAY)).toBe(false);
    const [first, ...none] = await ledger(scope, 'a2p.campaign.month');
    expect(none).toEqual([]);
    expect(first).toMatchObject({ amount_cents: '-1000', cost_cents: '1000', unit: 'month' });
    expect(first!.idempotency_key).toMatch(new RegExp(`^a2p-campaign:${sid}:\\d{4}-\\d{2}$`));

    // A month and a bit later, the next month: dated to the day the first one was.
    expect(await chargeCampaignMonths(deps, scope, now + 32 * DAY)).toBe(true);
    const months = await ledger(scope, 'a2p.campaign.month');
    expect(months).toHaveLength(2);
    const gap =
      new Date(months[1]!.occurred_at).getTime() - new Date(months[0]!.occurred_at).getTime();
    expect(gap).toBeGreaterThanOrEqual(28 * DAY);
    expect(gap).toBeLessThanOrEqual(31 * DAY);
    expect(months[1]!.idempotency_key).not.toBe(months[0]!.idempotency_key);
  });

  it('is charged by the daily sweep, but not in an account that was closed, nor with the wallet off', async () => {
    const open = await business('sweep-open');
    const closed = await business('sweep-closed');
    await approvedCampaign(open, new Date(Date.now() - 3 * DAY));
    await approvedCampaign(closed, new Date(Date.now() - 3 * DAY), 'closed');
    expect(await chargeAllCampaignMonths({ ...deps, mode: 'off' }, Date.now())).toBe(0);
    expect(await ledger(open, 'a2p.campaign.month')).toEqual([]);

    await chargeAllCampaignMonths(deps, Date.now());
    expect(await ledger(open, 'a2p.campaign.month')).toHaveLength(1);
    expect(await ledger(closed, 'a2p.campaign.month')).toEqual([]);
  });
});
