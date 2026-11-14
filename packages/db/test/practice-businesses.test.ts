/**
 * 20261027027200: practice businesses, for Admin → Try onboarding.
 *
 * **Needs the stack up.** The functions run past every policy, so the rules worth testing are their own:
 *
 *   - only a staff admin can make one (a support agent and a customer cannot), five at once at most, and nobody can
 *     mark a business as practice, or unmark one, by updating the row themselves;
 *   - its "payment" puts the plan on it and holds no founding spot, and works only in a practice business;
 *   - when its time is up the sweep marks its business to be deleted, as an owner's request would;
 *   - once its business is purged the organization goes too, with its history, and a real one never can;
 *   - and Admin's totals never count it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

const admin$ = dbs.admin.db;
const OFFER = 'test_practice_yearly';

let staffAdmin: TestUser;
let agent: TestUser;
let customer: TestUser;

const start = (who: TestUser, name = 'Practice Plumbing', hours = 24) => {
  const slug = `practice-${uniq()}`;
  return as(who)((tx) =>
    rows<{ org_id: string; ws_id: string }>(
      tx,
      sql`select * from private.start_practice(${name}, ${slug}, ${name}, ${slug}, 'America/Chicago',
            'home_services', ${hours}::integer)`,
    ),
  ).then((r) => r[0]!);
};
const count = async (q: ReturnType<typeof sql>): Promise<number> =>
  (await rows<{ n: number }>(admin$, q))[0]!.n;

beforeAll(async () => {
  [staffAdmin, agent, customer] = await Promise.all([
    createTestUser('practice-admin'),
    createTestUser('practice-agent'),
    createTestUser('practice-customer'),
  ]);
  await admin$.execute(
    sql`insert into platform.staff (user_id, role) values (${staffAdmin.id}, 'admin'), (${agent.id}, 'agent')
        on conflict (user_id) do update set role = excluded.role, status = 'active'`,
  );
  await admin$.execute(sql`delete from platform.founding_offers where id = ${OFFER}`);
  // Closed, so it makes no other test's new business pick a plan; practice_pay takes any offer that isn't a draft.
  await admin$.execute(
    sql`insert into platform.founding_offers (id, name, seat_cap, price_cents, status, billing, paid_yearly, show_counter)
        values (${OFFER}, 'Founding yearly', 5, 49700, 'closed', 'once', true, false)`,
  );
});
afterAll(async () => {
  await admin$.execute(sql`delete from platform.founding_offers where id = ${OFFER}`);
  await closeAll();
});

describe('making one', () => {
  it('a staff admin makes a practice business they own, marked to go in 24 hours', async () => {
    const made = await start(staffAdmin);
    const [org] = await rows<{ ends_in: number; by: string }>(
      admin$,
      sql`select extract(epoch from practice_ends_at - now())::int as ends_in, practice_by as by
          from app.organizations where id = ${made.org_id}`,
    );
    expect(org!.by).toBe(staffAdmin.id);
    expect(org!.ends_in).toBeGreaterThan(23 * 3600);
    expect(org!.ends_in).toBeLessThanOrEqual(24 * 3600);
    const [role] = await rows<{ role: string }>(
      admin$,
      sql`select role::text from app.workspace_memberships
          where workspace_id = ${made.ws_id} and user_id = ${staffAdmin.id}`,
    );
    expect(role!.role).toBe('owner');
    const [is] = await as(staffAdmin)((tx) =>
      rows<{ yes: boolean }>(tx, sql`select private.is_practice_workspace(${made.ws_id}) as yes`),
    );
    expect(is!.yes).toBe(true);
  });

  it('a support agent and a customer cannot', async () => {
    for (const who of [agent, customer]) {
      const e = await expectPgError(() => start(who));
      expect(e.detail).toBe('practice_forbidden');
    }
  });

  it('refuses a length outside 1 to 168 hours', async () => {
    const e = await expectPgError(() => start(staffAdmin, 'Too long', 500));
    expect(e.detail).toBe('practice_hours');
  });

  it('five at once at most', async () => {
    const mine = await count(
      sql`select count(*)::int as n from app.organizations where practice_by = ${staffAdmin.id}`,
    );
    for (let i = mine; i < 5; i++) await start(staffAdmin, `Practice ${i}`);
    const e = await expectPgError(() => start(staffAdmin, 'One too many'));
    expect(e.detail).toBe('practice_too_many');
    await admin$.execute(
      sql`update app.organizations set practice_by = null where practice_by = ${staffAdmin.id}`,
    );
  });

  it('nobody marks or unmarks a business by updating it', async () => {
    const real = await bootstrapOrganization(customer, 'Real Roofing', 'Real Roofing');
    const mark = await expectPgError(() =>
      as(customer)((tx) =>
        tx.execute(
          sql`update app.organizations set practice_ends_at = now() + interval '1 day'
              where id = ${real.orgId}`,
        ),
      ),
    );
    expect(mark.detail).toBe('practice_mark_is_ours');
    const made = await start(staffAdmin, 'Keep me');
    const unmark = await expectPgError(() =>
      as(staffAdmin)((tx) =>
        tx.execute(
          sql`update app.organizations set practice_ends_at = null where id = ${made.org_id}`,
        ),
      ),
    );
    expect(unmark.detail).toBe('practice_mark_is_ours');
    // Its name is theirs to change, like any owner's.
    await as(staffAdmin)((tx) =>
      tx.execute(sql`update app.organizations set name = 'Renamed' where id = ${made.org_id}`),
    );
  });
});

describe('paying', () => {
  it('puts the plan on a practice business, with its trial, and holds no spot', async () => {
    const made = await start(staffAdmin, 'Pays');
    const [paid] = await as(staffAdmin)((tx) =>
      rows<{ plan: string }>(
        tx,
        sql`select private.practice_pay(${made.ws_id}, ${OFFER}, 14) as plan`,
      ),
    );
    expect(paid!.plan).toBe('founding_lifetime');
    const [plan] = await rows<{ status: string; trial_days: number }>(
      admin$,
      sql`select status::text, round(extract(epoch from trial_ends_at - now()) / 86400)::int as trial_days
          from app.workspace_plans where workspace_id = ${made.ws_id}`,
    );
    expect(plan).toEqual({ status: 'active', trial_days: 14 });
    expect(
      await count(
        sql`select count(*)::int as n from platform.founding_checkouts where organization_id = ${made.org_id}`,
      ),
    ).toBe(0);
    expect(
      await count(
        sql`select count(*)::int as n from platform.founding_grants where organization_id = ${made.org_id}`,
      ),
    ).toBe(0);
  });

  it('works only in a practice business', async () => {
    const real = await bootstrapOrganization(customer, 'Real Pays', 'Real Pays');
    const e = await expectPgError(() =>
      as(customer)((tx) =>
        rows(tx, sql`select private.practice_pay(${real.wsId}, ${OFFER}, null)`),
      ),
    );
    expect(e.detail).toBe('practice_only');
  });
});

describe('going', () => {
  it('when its time is up the sweep marks its business, and the organization goes once that does', async () => {
    const made = await start(staffAdmin, 'Expires');
    await admin$.execute(
      sql`update app.organizations set practice_ends_at = now() - interval '1 minute' where id = ${made.org_id}`,
    );
    const due = await asService({})((tx) =>
      rows<{ organization_id: string; workspace_id: string | null }>(
        tx,
        sql`select * from private.practice_expire()`,
      ),
    );
    expect(due).toContainEqual({ organization_id: made.org_id, workspace_id: made.ws_id });
    const [ws] = await rows<{ marked: boolean }>(
      admin$,
      sql`select deletion_requested_at is not null as marked from app.workspaces where id = ${made.ws_id}`,
    );
    expect(ws!.marked).toBe(true);

    // Not while its business is still there.
    const purge = () =>
      asService({})((tx) =>
        rows<{ purged: boolean }>(
          tx,
          sql`select private.purge_practice_organization(${made.org_id}) as purged`,
        ),
      ).then((r) => r[0]!.purged);
    expect(await purge()).toBe(false);

    await asService({ workspaceId: made.ws_id, organizationId: made.org_id })((tx) =>
      rows(tx, sql`select private.purge_workspace(${made.ws_id})`),
    );
    expect(await purge()).toBe(true);
    expect(
      await count(sql`select count(*)::int as n from app.organizations where id = ${made.org_id}`),
    ).toBe(0);
    expect(
      await count(
        sql`select count(*)::int as n from app.events where organization_id = ${made.org_id}`,
      ),
    ).toBe(0);
    // Again is nothing to do.
    expect(await purge()).toBe(false);
  });

  it('a real organization is never purged this way', async () => {
    const real = await bootstrapOrganization(customer, 'Real Stays', 'Real Stays');
    const e = await expectPgError(() =>
      asService({})((tx) =>
        rows(tx, sql`select private.purge_practice_organization(${real.orgId})`),
      ),
    );
    expect(e.detail).toBe('practice_only');
  });

  it('a customer cannot purge one', async () => {
    const made = await start(staffAdmin, 'Not yours');
    const e = await expectPgError(() =>
      as(customer)((tx) =>
        rows(tx, sql`select private.purge_practice_organization(${made.org_id})`),
      ),
    );
    expect(e.code).toBe('42501');
  });
});

describe('counted nowhere', () => {
  it('Admin’s business totals leave practice businesses out', async () => {
    const total = async () =>
      (
        await as(staffAdmin)((tx) =>
          rows<{ businesses: number }>(
            tx,
            sql`select businesses::int from private.admin_business_totals()`,
          ),
        )
      )[0]!.businesses;
    const before = await total();
    await start(staffAdmin, 'Not counted');
    expect(await total()).toBe(before);
  });
});
