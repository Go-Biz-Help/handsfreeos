/**
 * Paying partners (20261027009000, and the 1099s of 20261027009400): asked of the database rather than trusted.
 *   1. The business's payout card, its partners' banks at Stripe, its payouts, their lines and the 1099s they charged
 *      for are seen only with Manage partners (the card with Manage money too), never outside the business.
 *   2. Only the worker writes them, for the business it works for. A person with Manage money may take the card off,
 *      and nothing else: not put one on, not open payouts.
 *   3. Only staff admins open payouts, one business at a time.
 *   4. A signed-in partner reads their own bank and payouts through the portal's look-ups, and nobody else's; the
 *      tables themselves stay shut to the portal.
 *   5. The worker's look-ups across businesses are the worker's alone.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asPortal,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

let owner: TestUser;
let adminUser: TestUser;
let member: TestUser;
let outsider: TestUser;
let staff: TestUser;

interface Business {
  readonly ws: string;
  readonly org: string;
}
let A: Business;
let B: Business;
let paula: string;
let petra: string;
let paulaPartner: string;
let payoutId: string;
let lineId: string;

const admin = () => dbs.admin.db;
const one = async (q: Promise<{ id: string }[]>) => (await q)[0]!.id;
const worker = (b: Business) => asService({ workspaceId: b.ws, organizationId: b.org });
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const hex = () => randomBytes(4).toString('hex');

const person = (first: string) =>
  one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name) values (${A.ws}, ${first}, 'Partner')
          returning id`,
    ),
  );

const partner = (personId: string) =>
  one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.partners (workspace_id, person_id, code) values (${A.ws}, ${personId}, ${`Pa${hex()}`})
          returning id`,
    ),
  );

const seen = (u: TestUser, table: string) =>
  as(u)((tx) =>
    rows(tx, sql`select 1 from ${sql.raw(`app.${table}`)} where workspace_id = ${A.ws}`),
  ).then((r) => r.length);

/** A live device for this person. */
async function signedIn(personId: string): Promise<string> {
  const access = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.portal_access (workspace_id, person_id, given_by) values (${A.ws}, ${personId}, ${owner.id})
          returning id`,
    ),
  );
  return one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.portal_sessions (workspace_id, access_id, person_id, token_hash, expires_at)
          values (${A.ws}, ${access}, ${personId}, ${createHash('sha256').update(randomBytes(32)).digest()},
            now() + interval '90 days')
          returning id`,
    ),
  );
}

beforeAll(async () => {
  [owner, adminUser, member, outsider, staff] = await Promise.all([
    createTestUser('payouts-rls-owner'),
    createTestUser('payouts-rls-admin'),
    createTestUser('payouts-rls-member'),
    createTestUser('payouts-rls-outsider'),
    createTestUser('payouts-rls-staff'),
  ]);
  const a = await bootstrapOrganization(owner, 'Payouts Org A', 'Payouts A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Payouts Org B', 'Payouts B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: A.ws, userId: adminUser.id, role: 'admin' },
    { workspaceId: A.ws, userId: member.id, role: 'member' },
  ]);
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
  paula = await person('Paula');
  petra = await person('Petra');
  paulaPartner = await partner(paula);
  await partner(petra);
  // What the worker writes: the card, Paula's bank, and a month's payout with her line on it.
  await worker(A)(async (tx) => {
    await tx.execute(
      sql`insert into app.partner_payout_billing (workspace_id, organization_id, opened_at, provider, customer_ref,
            method_token, card_brand, card_last4)
          values (${A.ws}, ${A.org}, now(), 'stripe', 'cus_a', 'pm_a', 'Visa', '4242')`,
    );
    await tx.execute(
      sql`insert into app.partner_payout_accounts (workspace_id, partner_id, account_ref, livemode,
            details_submitted, payouts_enabled, transfers_active)
          values (${A.ws}, ${paulaPartner}, ${`acct_${hex()}`}, true, true, true, true)`,
    );
    payoutId = await one(
      rows<{ id: string }>(
        tx,
        sql`insert into app.partner_payouts (workspace_id, organization_id, month, livemode, owed_cents,
              account_fees_cents, payout_fees_cents, card_fee_cents, charge_cents)
            values (${A.ws}, ${A.org}, '2026-11-01', true, 10000, 200, 50, 338, 10588) returning id`,
      ),
    );
    lineId = await one(
      rows<{ id: string }>(
        tx,
        sql`insert into app.partner_payout_lines (workspace_id, payout_id, partner_id, account_ref, amount_cents,
              account_fee_cents, payout_fee_cents)
            values (${A.ws}, ${payoutId}, ${paulaPartner}, 'acct_line', 10000, 200, 50) returning id`,
      ),
    );
    await tx.execute(
      sql`insert into app.partner_tax_forms (workspace_id, account_ref, partner_id, tax_year, paid_cents, fee_cents,
            payout_id)
          values (${A.ws}, 'acct_line', ${paulaPartner}, 2026, 250000, 448, ${payoutId})`,
    );
  });
  // Paula's share of a client's payment, on its way to her in that line.
  const client = await person('Maria');
  const referral = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.partner_referrals (workspace_id, partner_id, person_id, how, referred_at)
          values (${A.ws}, ${paulaPartner}, ${client}, 'by_hand', now() - interval '40 days') returning id`,
    ),
  );
  const invoice = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.invoices (workspace_id, person_id, title, status)
          values (${A.ws}, ${client}, 'Tune-up', 'sent') returning id`,
    ),
  );
  const payment = await one(
    rows<{ id: string }>(
      admin(),
      sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, status, received_at)
          values (${A.ws}, ${invoice}, 10000, 'cash', 'succeeded', now() - interval '35 days') returning id`,
    ),
  );
  await admin().execute(
    sql`insert into app.partner_commissions (workspace_id, partner_id, referral_id, payment_id, kind, base_cents,
          rate_bp, amount_cents, earned_at, payable_at, payout_line_id)
        values (${A.ws}, ${paulaPartner}, ${referral}, ${payment}, 'earned', 10000, 1500, 1500,
          now() - interval '35 days', now() - interval '5 days', ${lineId})`,
  );
});
afterAll(closeAll);

const TABLES = [
  'partner_payout_billing',
  'partner_payout_accounts',
  'partner_payouts',
  'partner_payout_lines',
  'partner_tax_forms',
];

describe('partner payouts', () => {
  it('are seen only with Manage partners, and never outside the business', async () => {
    for (const table of TABLES) {
      expect(await seen(owner, table), table).toBe(1);
      expect(await seen(adminUser, table), table).toBe(1);
      expect(await seen(member, table), table).toBe(0);
      expect(await seen(outsider, table), table).toBe(0);
    }
  });

  it('are written by the worker alone, for the business it works for', async () => {
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`insert into app.partner_payouts (workspace_id, organization_id, month, livemode, owed_cents,
                  account_fees_cents, payout_fees_cents, card_fee_cents, charge_cents)
                values (${A.ws}, ${A.org}, '2026-12-01', true, 1, 0, 0, 0, 1)`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`update app.partner_payout_lines set status = 'paid' where workspace_id = ${A.ws}`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(sql`delete from app.partner_tax_forms where workspace_id = ${A.ws}`),
        ),
      ),
    ).toBe('42501');
    // Another business's worker sees none of it, and writes none of it.
    expect(
      await worker(B)((tx) =>
        rows(tx, sql`select 1 from app.partner_payouts where workspace_id = ${A.ws}`),
      ),
    ).toEqual([]);
    expect(
      await code(() =>
        worker(B)((tx) =>
          tx.execute(
            sql`insert into app.partner_payout_billing (workspace_id, organization_id) values (${A.ws}, ${A.org})
                on conflict do nothing`,
          ),
        ),
      ),
    ).toBe('42501');
  });

  it('let someone who manages money take the card off, and nothing more', async () => {
    for (const change of [
      sql`set method_token = 'pm_mine', card_last4 = '1111'`,
      sql`set opened_at = null`,
      sql`set last_month = '2026-11-01'`,
      sql`set customer_ref = 'cus_mine'`,
    ])
      expect(
        await code(() =>
          as(owner)((tx) =>
            tx.execute(
              sql`update app.partner_payout_billing ${change} where workspace_id = ${A.ws}`,
            ),
          ),
        ),
      ).toBe('42501');
    // A member without Manage money changes nothing at all.
    const none = await as(member)((tx) =>
      rows(
        tx,
        sql`update app.partner_payout_billing set method_token = null where workspace_id = ${A.ws}
            returning 1`,
      ),
    );
    expect(none).toEqual([]);
    const taken = await as(owner)((tx) =>
      rows<{ method_token: string | null }>(
        tx,
        sql`update app.partner_payout_billing set method_token = null, card_brand = null, card_last4 = null
            where workspace_id = ${A.ws} returning method_token`,
      ),
    );
    expect(taken).toEqual([{ method_token: null }]);
  });

  it('are opened only by staff admins, one business at a time', async () => {
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(sql`select * from private.set_partner_payouts_open(${B.ws}::uuid, true)`),
        ),
      ),
    ).toBe('42501');
    const [opened] = await as(staff)((tx) =>
      rows<{ was_open: boolean; changed: boolean }>(
        tx,
        sql`select * from private.set_partner_payouts_open(${B.ws}::uuid, true)`,
      ),
    );
    expect(opened).toEqual({ was_open: false, changed: true });
    const [b] = await rows<{ open: boolean; scope: string | null }>(
      admin(),
      sql`select opened_at is not null as open,
            nullif(current_setting('app.system_scope.workspace_id', true), '') as scope
          from app.partner_payout_billing where workspace_id = ${B.ws}`,
    );
    expect(b).toEqual({ open: true, scope: null });
  });

  it('show a signed-in partner their own bank and payouts, and nobody else’s', async () => {
    const read = (session: string) =>
      asPortal(session)(async (tx) => ({
        account: await rows<{ payouts_enabled: boolean }>(
          tx,
          sql`select payouts_enabled from portal.partner_payout_account()`,
        ),
        lines: await rows<{ amount_cents: string }>(
          tx,
          sql`select amount_cents from portal.partner_payouts()`,
        ),
        totals: await rows<{ paying_cents: string; paid_cents: string }>(
          tx,
          sql`select paying_cents, paid_cents from portal.partner_payout_totals()`,
        ),
        open: (
          await rows<{ open: boolean }>(tx, sql`select portal.partner_payouts_open() as open`)
        )[0]!.open,
      }));
    const none = [{ paying_cents: '0', paid_cents: '0' }];
    expect(await read(await signedIn(paula))).toEqual({
      account: [{ payouts_enabled: true }],
      lines: [{ amount_cents: '10000' }],
      totals: [{ paying_cents: '1500', paid_cents: '0' }],
      open: true,
    });
    const session = await signedIn(petra);
    expect(await read(session)).toEqual({ account: [], lines: [], totals: none, open: true });
    const client = await person('Nina');
    expect(await read(await signedIn(client))).toEqual({
      account: [],
      lines: [],
      totals: none,
      open: false,
    });
    for (const table of TABLES)
      expect(
        await code(() =>
          asPortal(session)((tx) => rows(tx, sql`select 1 from ${sql.raw(`app.${table}`)}`)),
        ),
        table,
      ).toBe('42501');
  });

  it('keep the worker’s look-ups across businesses for the worker', async () => {
    for (const call of [
      sql`select * from private.partner_payouts_due(10)`,
      sql`select * from private.partner_payouts_unfinished(10)`,
      sql`select * from private.partner_payout_account_by_ref('acct_x')`,
    ])
      expect(await code(() => as(owner)((tx) => tx.execute(call)))).toBe('42501');
    const unfinished = await asService({})((tx) =>
      rows<{ payout_id: string }>(
        tx,
        sql`select payout_id from private.partner_payouts_unfinished(500)`,
      ),
    );
    expect(unfinished.map((u) => u.payout_id)).toContain(payoutId);
  });
});
