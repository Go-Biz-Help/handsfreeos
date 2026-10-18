/**
 * Partners in core (20261027008600): asked of the database rather than trusted.
 *   1. Partners and the clients they sent are seen and kept only with Manage partners: owners and admins, or whoever
 *      the business gives it to; never a member by default, and never anyone outside the business.
 *   2. What partners earned is written by the worker alone, for the business it works for; people only read it.
 *   3. A client who earned their partner something can't be taken off them, and partner settings change only with
 *      Manage partners.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
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

interface Business {
  readonly ws: string;
  readonly org: string;
}
let A: Business;
let B: Business;
let partnerId: string;
let clientId: string;
let paymentId: string;

const worker = (b: Business) => asService({ workspaceId: b.ws, organizationId: b.org });
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;

/** A contact of business A. */
const person = (first: string) =>
  rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.people (workspace_id, first_name) values (${A.ws}, ${first}) returning id`,
  ).then((r) => r[0]!.id);

const seen = (u: TestUser, table: string) =>
  as(u)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`select id from ${sql.raw(`app.${table}`)} where workspace_id = ${A.ws}`,
    ),
  );

beforeAll(async () => {
  [owner, adminUser, member, outsider] = await Promise.all([
    createTestUser('partners-rls-owner'),
    createTestUser('partners-rls-admin'),
    createTestUser('partners-rls-member'),
    createTestUser('partners-rls-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Partners Org A', 'Partners A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Partners Org B', 'Partners B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: A.ws, userId: adminUser.id, role: 'admin' },
    { workspaceId: A.ws, userId: member.id, role: 'member' },
  ]);
  const [paula, maria] = [await person('Paula'), await person('Maria')];
  clientId = maria;
  const [invoice] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.invoices (workspace_id, person_id, title, status)
        values (${A.ws}, ${maria}, 'Tune-up', 'sent') returning id`,
  );
  const [payment] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, status, received_at)
        values (${A.ws}, ${invoice!.id}, 10000, 'cash', 'succeeded', now()) returning id`,
  );
  paymentId = payment!.id;
  const [partner] = await as(owner)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.partners (workspace_id, person_id, code)
          values (${A.ws}, ${paula}, 'AbCdEfGh23') returning id`,
    ),
  );
  partnerId = partner!.id;
});
afterAll(closeAll);

describe('partners and their clients', () => {
  it('are seen only with Manage partners, and never outside the business', async () => {
    expect(await seen(owner, 'partners')).toEqual([{ id: partnerId }]);
    expect(await seen(adminUser, 'partners')).toEqual([{ id: partnerId }]);
    expect(await seen(member, 'partners')).toEqual([]);
    expect(await seen(outsider, 'partners')).toEqual([]);
    const add = (u: TestUser) =>
      as(u)((tx) =>
        tx.execute(
          sql`insert into app.partners (workspace_id, person_id, code)
              values (${A.ws}, ${clientId}, 'ZzYyXxWw98')`,
        ),
      );
    expect(await code(() => add(member))).toBe('42501');
    expect(await code(() => add(outsider))).toBe('42501');

    // Given Manage partners, a member sees them too.
    await rows(
      dbs.admin.db,
      sql`insert into app.member_permission_overrides (workspace_id, user_id, permission, allowed)
          values (${A.ws}, ${member.id}, 'partners.manage', true)`,
    );
    expect(await seen(member, 'partners')).toEqual([{ id: partnerId }]);
    await rows(
      dbs.admin.db,
      sql`delete from app.member_permission_overrides where workspace_id = ${A.ws} and user_id = ${member.id}`,
    );
  });

  it('send clients who are kept by hand, and never changed in place', async () => {
    const [referral] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.partner_referrals (workspace_id, partner_id, person_id, how, referred_at)
            values (${A.ws}, ${partnerId}, ${clientId}, 'by_hand', now() - interval '1 day') returning id`,
      ),
    );
    expect(await seen(member, 'partner_referrals')).toEqual([]);
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`update app.partner_referrals set referred_at = now() where id = ${referral!.id}`,
          ),
        ),
      ),
    ).toBe('42501');
    // Each customer is one partner's.
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`insert into app.partner_referrals (workspace_id, partner_id, person_id, how, referred_at)
                values (${A.ws}, ${partnerId}, ${clientId}, 'by_hand', now())`,
          ),
        ),
      ),
    ).toBe('23505');
  });
});

describe('what partners earned', () => {
  const keep = (as: Business, forWs: string, kind = 'earned', amount = 1000) =>
    worker(as)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.partner_commissions (workspace_id, partner_id, referral_id, payment_id, kind,
              base_cents, rate_bp, amount_cents, earned_at, payable_at)
            select ${forWs}, r.partner_id, r.id, ${paymentId}, ${kind}, 10000, 1000, ${amount}, now(),
              now() + interval '30 days'
            from app.partner_referrals r where r.person_id = ${clientId}
            returning id`,
      ),
    );

  it('is written by the worker alone, for its own business, and read with Manage partners', async () => {
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`insert into app.partner_commissions (workspace_id, partner_id, referral_id, payment_id, kind,
                  base_cents, rate_bp, amount_cents, earned_at, payable_at)
                select ${A.ws}, r.partner_id, r.id, ${paymentId}, 'earned', 10000, 1000, 1000, now(), now()
                from app.partner_referrals r where r.person_id = ${clientId}`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(await keep(B, A.ws)).toEqual([]);
    const [earned] = await keep(A, A.ws);
    expect(earned).toBeDefined();
    // A payment earns once, and the sign says which it is.
    expect(await code(() => keep(A, A.ws))).toBe('23505');
    expect(await code(() => keep(A, A.ws, 'taken_back', 500))).toBe('23514');
    expect(await seen(owner, 'partner_commissions')).toEqual([{ id: earned!.id }]);
    expect(await seen(member, 'partner_commissions')).toEqual([]);
    expect(await seen(outsider, 'partner_commissions')).toEqual([]);
  });

  it('keeps its client with their partner', async () => {
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(sql`delete from app.partner_referrals where person_id = ${clientId}`),
        ),
      ),
    ).toBe('23503');
  });
});

describe('partner settings', () => {
  it('change only with Manage partners', async () => {
    const save = (u: TestUser, rateBp: number) =>
      as(u)((tx) =>
        rows(
          tx,
          sql`update app.workspaces
              set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{partners}', ${JSON.stringify({ rateBp })}::jsonb)
              where id = ${A.ws} returning id`,
        ),
      );
    expect(await save(adminUser, 1200)).toHaveLength(1);
    await rows(
      dbs.admin.db,
      sql`insert into app.role_permission_overrides (workspace_id, role, permission, allowed)
          values (${A.ws}, 'admin', 'partners.manage', false)`,
    );
    const refused = await expectPgError(() => save(adminUser, 1500));
    expect(refused).toMatchObject({ code: '42501', detail: 'setting_needs_partners_manage' });
    expect(await seen(adminUser, 'partners')).toEqual([]);
  });
});
