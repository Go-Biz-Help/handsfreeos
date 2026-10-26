/**
 * The founding cap (0091), which is the one thing in this feature that must never be wrong.
 *
 * Twenty-five free-for-life seats becoming twenty-six is not a bug you apologise your way out of: somebody
 * was promised something and then told it was a mistake. Every test here is about that promise holding under
 * something — two approvals at once, a revocation, a restore, a cap being edited while seats are out.
 *
 * These run against the database directly rather than through the API, because the guarantee is the
 * database's. A test that went through a command would be testing whether the command remembered to ask,
 * which is not the property worth protecting — anything that inserts a grant, from any language, by any
 * route, has to be refused when the offer is full.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { closeAll, dbs, expectPgError, uniq } from './harness';

afterAll(closeAll);

const admin = dbs.admin.db;
const OFFER = 'test_cap_offer';

const seatsHeld = async (): Promise<number> => {
  const [row] = await rows<{ n: number | string }>(
    admin,
    sql`select private.founding_seats_held(${OFFER}) as n`,
  );
  return Number(row?.n ?? -1);
};

const remaining = async (): Promise<number> => {
  const [row] = await rows<{ n: number | string }>(
    admin,
    sql`select greatest(seat_cap - private.founding_seats_held(id), 0) as n
        from platform.founding_offers where id = ${OFFER}`,
  );
  return Number(row?.n ?? -1);
};

/** A business to hold a seat. Created straight through the admin connection: no auth, no RLS, no fixtures. */
async function business(): Promise<string> {
  const slug = `cap-${uniq()}`;
  const [org] = await rows<{ id: string }>(
    admin,
    sql`insert into app.organizations (name, slug) values (${slug}, ${slug}) returning id`,
  );
  if (!org) throw new Error('no organization');
  return org.id;
}

const takeSeat = (orgId: string) =>
  rows<{ id: string }>(
    admin,
    sql`insert into platform.founding_grants (offer_id, organization_id, expires_at)
        values (${OFFER}, ${orgId}::uuid, now() + interval '14 days') returning id`,
  );

const setCap = (cap: number) =>
  admin.execute(sql`update platform.founding_offers set seat_cap = ${cap} where id = ${OFFER}`);

const setStatus = (status: string) =>
  admin.execute(
    sql`update platform.founding_offers set status = ${status}::platform.founding_offer_status
        where id = ${OFFER}`,
  );

beforeEach(async () => {
  await admin.execute(sql`delete from platform.founding_grants where offer_id = ${OFFER}`);
  await admin.execute(sql`delete from platform.founding_applications where offer_id = ${OFFER}`);
  await admin.execute(sql`delete from platform.founding_offers where id = ${OFFER}`);
  await admin.execute(
    sql`insert into platform.founding_offers
          (id, name, seat_cap, price_cents, status, starting_credit_cents, show_counter)
        values (${OFFER}, 'Cap test', 2, 0, 'open', 1000, false)`,
  );
});

describe('the cap', () => {
  it('lets seats out up to the cap and refuses the one past it', async () => {
    await takeSeat(await business());
    await takeSeat(await business());
    expect(await seatsHeld()).toBe(2);

    const e = await expectPgError(async () => takeSeat(await business()));
    expect(e.detail).toBe('founding_offer_full');
    expect(await seatsHeld()).toBe(2);
  });

  /**
   * The one that matters. Two approvals arrive together for the last seat; without the row lock both read
   * the same count and both write. The second transaction blocks on the offer's row until the first commits,
   * then counts again and is refused.
   */
  it('cannot be oversold by two approvals at the same moment', async () => {
    await setCap(1);
    const [a, b] = [await business(), await business()];

    const attempt = (orgId: string) =>
      admin
        .transaction(async (tx) => {
          await rows(
            tx,
            sql`insert into platform.founding_grants (offer_id, organization_id, expires_at)
                values (${OFFER}, ${orgId}::uuid, now() + interval '14 days')`,
          );
          // Held open so the other transaction is certainly inside the lock when this one commits.
          await tx.execute(sql`select pg_sleep(0.25)`);
          return 'committed' as const;
        })
        .catch(() => 'refused' as const);

    const results = await Promise.all([attempt(a), attempt(b)]);
    expect(results.filter((r) => r === 'committed')).toHaveLength(1);
    expect(results.filter((r) => r === 'refused')).toHaveLength(1);
    expect(await seatsHeld()).toBe(1);
  });

  it('holds when twenty approvals race for five seats', async () => {
    await setCap(5);
    const orgs = await Promise.all(Array.from({ length: 20 }, () => business()));
    const results = await Promise.all(
      orgs.map((id) =>
        takeSeat(id).then(
          () => 'in' as const,
          () => 'out' as const,
        ),
      ),
    );
    expect(results.filter((r) => r === 'in')).toHaveLength(5);
    expect(await seatsHeld()).toBe(5);
  });

  it('gives one business one seat, however many times it asks', async () => {
    const org = await business();
    await takeSeat(org);
    const e = await expectPgError(() => takeSeat(org));
    expect(e.code).toBe('23505');
    expect(await seatsHeld()).toBe(1);
  });

  it('grants nothing from an offer that is closed, or still a draft', async () => {
    await setStatus('closed');
    expect((await expectPgError(async () => takeSeat(await business()))).detail).toBe(
      'founding_offer_closed',
    );
    await setStatus('draft');
    expect((await expectPgError(async () => takeSeat(await business()))).detail).toBe(
      'founding_offer_closed',
    );
  });
});

describe('taking a seat back', () => {
  it('frees the seat the moment it is revoked, and lets the next business in', async () => {
    const first = await business();
    await takeSeat(first);
    await takeSeat(await business());
    expect(await remaining()).toBe(0);

    await admin.execute(
      sql`update platform.founding_grants
          set status = 'revoked', revoked_at = now(), revoke_reason = 'never onboarded'
          where organization_id = ${first}::uuid`,
    );
    expect(await remaining()).toBe(1);

    // And it is a real seat, not just a number: somebody can actually have it.
    await expect(takeSeat(await business())).resolves.toBeDefined();
    expect(await seatsHeld()).toBe(2);
  });

  it('refuses to restore a seat that has since gone to somebody else', async () => {
    await setCap(1);
    const first = await business();
    await takeSeat(first);
    await admin.execute(
      sql`update platform.founding_grants
          set status = 'revoked', revoked_at = now(), revoke_reason = 'changed our mind'
          where organization_id = ${first}::uuid`,
    );
    await takeSeat(await business());

    const e = await expectPgError(() =>
      admin.execute(
        sql`update platform.founding_grants
            set status = 'reserved', revoked_at = null, revoke_reason = ''
            where organization_id = ${first}::uuid`,
      ),
    );
    expect(e.detail).toBe('founding_offer_full');
    expect(await seatsHeld()).toBe(1);
  });

  it('lets a business whose seat was revoked be given a new one later', async () => {
    const org = await business();
    await takeSeat(org);
    await admin.execute(
      sql`update platform.founding_grants
          set status = 'revoked', revoked_at = now(), revoke_reason = 'a reason'
          where organization_id = ${org}::uuid`,
    );
    // The one-live-per-org index covers only the two statuses that hold a seat, which is what allows this.
    await expect(takeSeat(org)).resolves.toBeDefined();
  });
});

describe('editing the cap', () => {
  it('opens seats at once when it goes up', async () => {
    await takeSeat(await business());
    await takeSeat(await business());
    expect(await remaining()).toBe(0);
    await setCap(3);
    expect(await remaining()).toBe(1);
  });

  it('refuses to go below the seats already out', async () => {
    await takeSeat(await business());
    await takeSeat(await business());
    const e = await expectPgError(() => setCap(1));
    expect(e.detail).toBe('founding_cap_below_held');
  });

  it('may go to exactly the number already out', async () => {
    await takeSeat(await business());
    await setCap(1);
    expect(await remaining()).toBe(0);
  });
});

describe('applying', () => {
  const apply = (email: string) =>
    rows<{ application_id: string; status: string; created: boolean }>(
      admin,
      sql`select * from private.founding_apply(${OFFER}, 'A Business', 'A Person', ${email},
            null, null, null, null, 'the phone rings all day', '')`,
    );

  it('joins the queue while there is room', async () => {
    const [row] = await apply(`${uniq()}@test.invalid`);
    expect(row?.status).toBe('pending');
    expect(row?.created).toBe(true);
  });

  it('joins the waitlist instead of failing once every seat is out', async () => {
    await takeSeat(await business());
    await takeSeat(await business());
    const [row] = await apply(`${uniq()}@test.invalid`);
    expect(row?.status).toBe('waitlisted');
  });

  /**
   * Somebody pressing the button twice, capitalised differently the second time. The unique index is
   * case-insensitive because the column is citext, so the insert conflicts — and the row it conflicted with
   * has to come back, or the page answers an innocent person with nothing. Inside a security-definer
   * function with an empty search_path a bare `=` is *text* equality and would miss it.
   */
  it('answers a repeat application with the row it already has, whatever the capitals', async () => {
    const email = `${uniq()}@test.invalid`;
    const [first] = await apply(email);
    const [again] = await apply(email.toUpperCase());
    expect(again?.created).toBe(false);
    expect(again?.application_id).toBe(first?.application_id);
    expect(again?.status).toBe('pending');
  });

  it('refuses an offer that does not exist', async () => {
    const e = await expectPgError(() =>
      rows(
        admin,
        sql`select * from private.founding_apply('no_such_offer', 'B', 'P', 'x@test.invalid',
              null, null, null, null, '', '')`,
      ),
    );
    expect(e.detail).toBe('founding_offer_missing');
  });
});

describe('the starting credit', () => {
  it('lands once, however many times the link is followed', async () => {
    const org = await business();
    const slug = `cap-${uniq()}`;
    const [ws] = await rows<{ id: string }>(
      admin,
      sql`insert into app.workspaces (organization_id, name, slug, timezone)
          values (${org}::uuid, ${slug}, ${slug}, 'America/Chicago') returning id`,
    );
    const [grant] = await rows<{ id: string }>(
      admin,
      sql`insert into platform.founding_grants
            (offer_id, organization_id, workspace_id, status, activated_at)
          values (${OFFER}, ${org}::uuid, ${ws!.id}::uuid, 'active', now()) returning id`,
    );

    const credit = () =>
      rows<{ credited_cents: number | string; recorded: boolean }>(
        admin,
        sql`select * from private.founding_credit_wallet(${grant!.id}::uuid)`,
      );

    const [first] = await credit();
    // The offer's $10 in all: the business already had the $5 every new business starts with.
    expect(Number(first?.credited_cents)).toBe(500);
    expect(first?.recorded).toBe(true);

    const [second] = await credit();
    expect(Number(second?.credited_cents)).toBe(0);
    expect(second?.recorded).toBe(false);

    const [wallet] = await rows<{ balance_cents: number | string }>(
      admin,
      sql`select balance_cents from app.usage_wallets where workspace_id = ${ws!.id}::uuid`,
    );
    expect(Number(wallet?.balance_cents)).toBe(1000);
  });
});
