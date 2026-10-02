/**
 * Phone numbers on the wallet (money/number-months.ts), and the nightly reconciliation finding the businesses it
 * checks (money/reconcile.ts), on the real database. A number is charged once per calendar month where the
 * business is, for every month it was held; a number given back before the month began, still on its way to us,
 * or never bought isn't. Before this, numbers were never charged, and the reconciliation's plan read nobody.
 */
import { randomUUID } from 'node:crypto';
import { executeCommand, organizationCreate } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs } from '@hfos/db/testing';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chargeAllNumberMonths, chargeNumberMonths } from '../src/money/number-months';
import { dayToReconcile, planReconcile, reconcileJobKey } from '../src/money/reconcile';
import type { WalletDeps } from '../src/money/wallet';
import type { JobContext } from '../src/jobs';
import type { TenantScope } from '../src/services';

const admin = () => testDbs().admin.db;
const log = pino({ level: 'silent' });
const DAY = 24 * 60 * 60_000;
let deps: WalletDeps;
let scope: TenantScope;
let accountId: string;

// A real US exchange starts with 2–9; one starting 0 or 1 isn't formatted as "(512) 555-1234", so the subject check
// below would fail at random.
const e164 = () =>
  `+1512${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;

async function number(input: {
  type?: 'local' | 'toll_free';
  status: 'active' | 'released' | 'porting';
  purchased?: boolean;
  releasedAt?: Date | null;
}): Promise<string> {
  const [row] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers
          (workspace_id, account_id, provider_sid, e164, number_type, status, purchased_at, released_at)
        values (${scope.workspaceId}, ${accountId}, ${`PN${randomUUID().replace(/-/g, '')}`}, ${e164()},
          ${input.type ?? 'local'}, ${input.status},
          ${input.purchased === false ? null : new Date(Date.now() - 60 * DAY).toISOString()},
          ${input.releasedAt ? input.releasedAt.toISOString() : null})
        returning id`,
  );
  return row!.id;
}

const charges = () =>
  rows<{
    rate_key: string;
    amount_cents: string;
    entity_id: string;
    subject: string;
    idempotency_key: string;
  }>(
    admin(),
    sql`select rate_key, amount_cents::text, entity_id, subject, idempotency_key from app.usage_ledger
        where workspace_id = ${scope.workspaceId} and rate_key like 'number.%'
        order by created_at`,
  );

beforeAll(async () => {
  deps = { db: testDbs().worker.db, log, mode: 'shadow' };
  const owner = await createTestUser('number-months-owner');
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Number Months Plumbing' },
    { type: 'human', userId: owner.id, email: owner.email, claims: owner.claims },
    { correlationId: randomUUID(), channel: 'test' },
  );
  scope = { workspaceId: output.workspaceId, organizationId: output.organizationId };
  await rows(
    admin(),
    sql`update app.workspaces set timezone = 'America/Chicago' where id = ${scope.workspaceId}`,
  );
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${scope.workspaceId}, 'fake', ${`AC${randomUUID().slice(0, 8)}`}, 'active') returning id`,
  );
  accountId = account!.id;
});
afterAll(async () => {
  await closeTestDbs();
});

describe('a phone number’s month', () => {
  it('is charged once a month for each number held this month, at the card’s price', async () => {
    const local = await number({ status: 'active' });
    const tollFree = await number({ type: 'toll_free', status: 'active' });
    const givenBackToday = await number({ status: 'released', releasedAt: new Date() });
    // Not charged: given back before this month, still on its way to us, or never bought.
    await number({ status: 'released', releasedAt: new Date(Date.now() - 45 * DAY) });
    await number({ status: 'porting', purchased: false });
    await number({ status: 'active', purchased: false });

    const now = Date.now();
    expect(await chargeNumberMonths(deps, scope, now)).toBe(3);
    const first = await charges();
    expect(first.map((c) => [c.entity_id, c.rate_key, c.amount_cents]).sort()).toEqual(
      [
        [local, 'number.local.month', '-200'],
        [tollFree, 'number.tollfree.month', '-350'],
        [givenBackToday, 'number.local.month', '-200'],
      ].sort(),
    );
    expect(first.find((c) => c.entity_id === tollFree)!.subject).toMatch(
      /^Toll-free number \(512\) \d{3}-\d{4}, \w+ \d{4}$/,
    );

    // The daily sweep the same month finds them paid.
    expect(await chargeNumberMonths(deps, scope, now + 60_000)).toBe(0);
    expect(await charges()).toHaveLength(3);

    // Next month: the two still held pay again; the one given back doesn't.
    expect(await chargeNumberMonths(deps, scope, now + 32 * DAY)).toBe(2);
    const next = await charges();
    expect(next).toHaveLength(5);
    expect(next.filter((c) => c.entity_id === givenBackToday)).toHaveLength(1);
  });

  it('is found by the daily sweep, and charges nothing with the wallet off', async () => {
    expect(await chargeAllNumberMonths({ ...deps, mode: 'off' }, Date.now() + 70 * DAY)).toBe(0);
    const before = (await charges()).length;
    expect(await chargeAllNumberMonths(deps, Date.now() + 70 * DAY)).toBeGreaterThanOrEqual(2);
    expect((await charges()).length).toBe(before + 2);
  });
});

describe('the nightly reconciliation’s plan', () => {
  it('finds a business with a carrier account, which it used to miss', async () => {
    const now = Date.now();
    await planReconcile({ db: testDbs().worker.db, now } as unknown as JobContext);
    const key = reconcileJobKey(scope.workspaceId, dayToReconcile(now));
    const planned = await rows<{ kind: string }>(
      admin(),
      sql`select kind from app.scheduled_jobs where workspace_id = ${scope.workspaceId} and dedupe_key = ${key}`,
    );
    expect(planned).toEqual([{ kind: 'wallet.reconcile' }]);
  });
});
