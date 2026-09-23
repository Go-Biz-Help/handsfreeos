/**
 * The founding offers opening one after another (0092).
 *
 * The sequence is the growth plan's: free seats, then $497 seats once those are gone, then the monthly plan
 * beside the $497 ones partway through. What has to hold is that each switch happens exactly once, at exactly
 * the right seat, and never runs backwards — a website that flickers between stages as reservations come and
 * go is worse than one that never switched at all.
 *
 * Like the cap's own tests, these go at the database directly: the switch is taken where the seat is taken,
 * so any path that takes a seat has to cross the line, whatever called it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { closeAll, dbs, expectPgError, uniq } from './harness';

afterAll(closeAll);

const admin = dbs.admin.db;
const FREE = 'test_chain_free';
const PAID = 'test_chain_paid';
const PLAN = 'test_chain_plan';

const statusOf = async (id: string): Promise<string> => {
  const [row] = await rows<{ status: string }>(
    admin,
    sql`select status::text as status from platform.founding_offers where id = ${id}`,
  );
  return row?.status ?? 'missing';
};

async function business(): Promise<string> {
  const slug = `chain-${uniq()}`;
  const [org] = await rows<{ id: string }>(
    admin,
    sql`insert into app.organizations (name, slug) values (${slug}, ${slug}) returning id`,
  );
  if (!org) throw new Error('no organization');
  return org.id;
}

const takeSeat = async (offer: string, orgId?: string) =>
  rows<{ id: string }>(
    admin,
    sql`insert into platform.founding_grants (offer_id, organization_id, expires_at)
        values (${offer}, ${orgId ?? (await business())}::uuid, now() + interval '14 days')
        returning id`,
  );

const revoke = (grantId: string) =>
  admin.execute(
    sql`update platform.founding_grants
        set status = 'revoked', revoked_at = now(), revoke_reason = 'test'
        where id = ${grantId}::uuid`,
  );

beforeEach(async () => {
  await admin.execute(
    sql`delete from platform.founding_grants where offer_id in (${FREE}, ${PAID}, ${PLAN})`,
  );
  await admin.execute(
    sql`delete from platform.founding_applications where offer_id in (${FREE}, ${PAID}, ${PLAN})`,
  );
  // One statement, so the chain's own foreign keys are checked once, after every row has gone.
  await admin.execute(
    sql`delete from platform.founding_offers where id in (${FREE}, ${PAID}, ${PLAN})`,
  );
  await admin.execute(
    sql`insert into platform.founding_offers
          (id, name, seat_cap, price_cents, status, billing, show_counter, sort)
        values (${FREE}, 'Chain free', 2, 0, 'open', 'once', false, 901)`,
  );
  await admin.execute(
    sql`insert into platform.founding_offers
          (id, name, seat_cap, price_cents, status, billing, show_counter, sort, opens_after_offer_id)
        values (${PAID}, 'Chain paid', 5, 49700, 'draft', 'once', false, 902, ${FREE})`,
  );
  await admin.execute(
    sql`insert into platform.founding_offers
          (id, name, seat_cap, price_cents, status, billing, show_counter, sort,
           opens_after_offer_id, opens_after_count)
        values (${PLAN}, 'Chain plan', 100000, 9700, 'draft', 'monthly', false, 903, ${PAID}, 2)`,
  );
});

describe('the next offer opens itself', () => {
  it('waits until the one before it is full, then opens on the seat that fills it', async () => {
    await takeSeat(FREE);
    expect(await statusOf(PAID)).toBe('draft');
    await takeSeat(FREE);
    expect(await statusOf(PAID)).toBe('open');
  });

  it('writes down when it opened', async () => {
    await takeSeat(FREE);
    await takeSeat(FREE);
    // A raw query hands timestamptz back as text, so it is read as one.
    const [row] = await rows<{ opened_at: string | null }>(
      admin,
      sql`select opened_at::text as opened_at from platform.founding_offers where id = ${PAID}`,
    );
    expect(row?.opened_at).not.toBeNull();
    expect(Number.isNaN(Date.parse(row!.opened_at!))).toBe(false);
  });

  it('opens the monthly plan beside the paid seats, at the count it names', async () => {
    await takeSeat(FREE);
    await takeSeat(FREE);
    await takeSeat(PAID);
    expect(await statusOf(PLAN)).toBe('draft');
    await takeSeat(PAID);
    expect(await statusOf(PLAN)).toBe('open');
    // Beside, not instead: the paid seats are still what the site offers.
    expect(await statusOf(PAID)).toBe('open');
  });

  /**
   * Two approvals for the last free seat. The cap's lock lets one through and refuses the other, and the one
   * that got through is the one that opens the next offer — exactly once, with no second approval able to see
   * a half-crossed line.
   */
  it('opens once when two approvals race for the last seat', async () => {
    await takeSeat(FREE);
    const [a, b] = [await business(), await business()];
    const attempt = (orgId: string) =>
      admin
        .transaction(async (tx) => {
          await rows(
            tx,
            sql`insert into platform.founding_grants (offer_id, organization_id, expires_at)
                values (${FREE}, ${orgId}::uuid, now() + interval '14 days')`,
          );
          await tx.execute(sql`select pg_sleep(0.25)`);
          return 'in' as const;
        })
        .catch(() => 'out' as const);

    const results = await Promise.all([attempt(a), attempt(b)]);
    expect(results.filter((r) => r === 'in')).toHaveLength(1);
    expect(await statusOf(PAID)).toBe('open');
  });
});

describe('it only ever runs forwards', () => {
  it('keeps the next offer open when a seat before it frees up', async () => {
    const [first] = await takeSeat(FREE);
    await takeSeat(FREE);
    expect(await statusOf(PAID)).toBe('open');
    await revoke(first!.id);
    expect(await statusOf(PAID)).toBe('open');
  });

  it('never reopens an offer somebody closed by hand', async () => {
    const [first] = await takeSeat(FREE);
    await takeSeat(FREE);
    await admin.execute(
      sql`update platform.founding_offers set status = 'closed' where id = ${PAID}`,
    );
    // Free a seat and fill it again: the line is crossed a second time, and the closed offer must stay closed.
    await revoke(first!.id);
    await takeSeat(FREE);
    expect(await statusOf(PAID)).toBe('closed');
  });

  it('does nothing to an offer that is already open', async () => {
    await admin.execute(
      sql`update platform.founding_offers set status = 'open' where id = ${PAID}`,
    );
    const openedAt = async () =>
      (
        await rows<{ opened_at: string }>(
          admin,
          sql`select opened_at::text as opened_at from platform.founding_offers where id = ${PAID}`,
        )
      )[0]?.opened_at;
    const before = await openedAt();
    await takeSeat(FREE);
    await takeSeat(FREE);
    expect(before).toBeDefined();
    expect(await openedAt()).toBe(before);
  });
});

describe('the line can be crossed without a new seat', () => {
  it('opens the next offer when the cap is lowered to the seats already out', async () => {
    await admin.execute(sql`update platform.founding_offers set seat_cap = 3 where id = ${FREE}`);
    await takeSeat(FREE);
    await takeSeat(FREE);
    expect(await statusOf(PAID)).toBe('draft');
    await admin.execute(sql`update platform.founding_offers set seat_cap = 2 where id = ${FREE}`);
    expect(await statusOf(PAID)).toBe('open');
  });

  it('opens straight away when chained onto an offer that is already full', async () => {
    await admin.execute(
      sql`update platform.founding_offers set opens_after_offer_id = null where id = ${PAID}`,
    );
    await takeSeat(FREE);
    await takeSeat(FREE);
    expect(await statusOf(PAID)).toBe('draft');
    await admin.execute(
      sql`update platform.founding_offers set opens_after_offer_id = ${FREE} where id = ${PAID}`,
    );
    expect(await statusOf(PAID)).toBe('open');
  });

  it('opens when a revoked seat is restored onto the line', async () => {
    const [first] = await takeSeat(FREE);
    await revoke(first!.id);
    await takeSeat(FREE);
    expect(await statusOf(PAID)).toBe('draft');
    await admin.execute(
      sql`update platform.founding_grants
          set status = 'reserved', revoked_at = null, revoke_reason = ''
          where id = ${first!.id}::uuid`,
    );
    expect(await statusOf(PAID)).toBe('open');
  });
});

describe('the monthly plan is not a founding offer', () => {
  it('has no seat anybody can take', async () => {
    await admin.execute(
      sql`update platform.founding_offers set status = 'open' where id = ${PLAN}`,
    );
    const e = await expectPgError(() => takeSeat(PLAN));
    expect(e.detail).toBe('founding_offer_not_seats');
  });

  it('takes no applications', async () => {
    await admin.execute(
      sql`update platform.founding_offers set status = 'open' where id = ${PLAN}`,
    );
    const e = await expectPgError(() =>
      rows(
        admin,
        sql`select * from private.founding_apply(${PLAN}, 'B', 'P', 'x@test.invalid',
              null, null, null, null, '', '')`,
      ),
    );
    expect(e.detail).toBe('founding_offer_missing');
  });
});

describe('what the website reads', () => {
  const view = (id: string) =>
    rows<{ superseded: boolean; billing: string; show_counter: boolean }>(
      admin,
      sql`select superseded, billing, show_counter from platform.founding_counts where id = ${id}`,
    );

  it('marks an offer superseded once a later founding offer has opened after it', async () => {
    expect((await view(FREE))[0]?.superseded).toBe(false);
    await takeSeat(FREE);
    await takeSeat(FREE);
    expect((await view(FREE))[0]?.superseded).toBe(true);
    expect((await view(PAID))[0]?.superseded).toBe(false);
  });

  it('never lets the monthly plan supersede the paid seats it opens beside', async () => {
    await takeSeat(FREE);
    await takeSeat(FREE);
    await takeSeat(PAID);
    await takeSeat(PAID);
    expect(await statusOf(PLAN)).toBe('open');
    expect((await view(PAID))[0]?.superseded).toBe(false);
  });

  it('shows the monthly plan once it is open, with its counter off', async () => {
    expect(await view(PLAN)).toHaveLength(0);
    await admin.execute(
      sql`update platform.founding_offers set status = 'open' where id = ${PLAN}`,
    );
    const [row] = await view(PLAN);
    expect(row?.billing).toBe('monthly');
    expect(row?.show_counter).toBe(false);
  });
});
