/**
 * Taking a founding seat up, and paying for one (0093).
 *
 * The claim link is the authority: whoever holds it may put the seat on a workspace they run, in the business
 * the seat was approved for, and nobody else may put it anywhere. These run as the people involved — the
 * owner who was approved, a plain member of their team, somebody from another business — because that is the
 * whole of what 0093 is for. 0091's claim ran as the person too, and every one of them was refused.
 *
 * The worker's half runs as the worker, scoped to the workspace the checkout is for, exactly as the job and
 * the webhook processor do.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rows, sql, type Tx } from '../src/client';
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

afterAll(closeAll);

const admin = dbs.admin.db;
const FREE = 'test_checkout_free';
const PAID = 'test_checkout_paid';

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let org: string;
let ws: string;
let otherWs: string;

const hash = (token: string): Buffer => createHash('sha256').update(token).digest();

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('seat-owner'),
    createTestUser('seat-member'),
    createTestUser('seat-outsider'),
  ]);
  ({ orgId: org, wsId: ws } = await bootstrapOrganization(owner, 'Seat Holder', 'Seat Holder'));
  ({ wsId: otherWs } = await bootstrapOrganization(outsider, 'Somebody Else', 'Somebody Else'));
  await admin.execute(
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${ws}, ${member.id}, 'member')`,
  );
});

beforeEach(async () => {
  for (const offer of [FREE, PAID]) {
    await admin.execute(sql`delete from platform.founding_checkouts where offer_id = ${offer}`);
    await admin.execute(sql`delete from platform.founding_applications where offer_id = ${offer}`);
    await admin.execute(sql`delete from platform.founding_grants where offer_id = ${offer}`);
    await admin.execute(sql`delete from platform.founding_offers where id = ${offer}`);
  }
  await admin.execute(sql`delete from app.workspace_plans where workspace_id = ${ws}`);
  await admin.execute(
    sql`insert into platform.founding_offers
          (id, name, seat_cap, price_cents, status, starting_credit_cents, show_counter)
        values (${FREE}, 'Free test', 5, 0, 'open', 1000, false),
               (${PAID}, 'Paid test', 5, 49700, 'open', 1000, false)`,
  );
});

/** An approval, as founding.approve writes it: a reserved seat, and the application holding the link's hash. */
async function approve(
  offer: string,
  opts: { organizationId?: string; linkExpired?: boolean } = {},
): Promise<{ token: string; grantId: string }> {
  const token = `link-${uniq()}-${uniq()}`;
  const [grant] = await rows<{ id: string }>(
    admin,
    sql`insert into platform.founding_grants (offer_id, organization_id, expires_at)
        values (${offer}, ${opts.organizationId ?? org}::uuid, now() + interval '14 days') returning id`,
  );
  await admin.execute(
    sql`insert into platform.founding_applications
          (offer_id, business_name, contact_name, email, status, claim_token_hash, claim_expires_at, grant_id)
        values (${offer}, 'Seat Holder', 'Owner', ${`${uniq()}@hfos.test`}, 'approved', ${hash(token)},
                ${opts.linkExpired ? sql`now() - interval '1 minute'` : sql`now() + interval '14 days'`},
                ${grant!.id}::uuid)`,
  );
  return { token, grantId: grant!.id };
}

const preview = (user: TestUser, token: string) =>
  as(user)((tx) =>
    rows<{ state: string; offer_id: string; price_cents: number; checkout_id: string | null }>(
      tx,
      sql`select * from private.founding_seat_by_token(${hash(token)})`,
    ),
  );

const claimFree = (user: TestUser, token: string, workspace: string) =>
  as(user)((tx) =>
    rows<{ grant_id: string; plan: string; credited_cents: number | string }>(
      tx,
      sql`select * from private.founding_claim_free(${hash(token)}, ${workspace}::uuid)`,
    ),
  );

const openCheckout = (user: TestUser, token: string, workspace: string) =>
  as(user)((tx) =>
    rows<{ checkout_id: string; status: string; session_url: string | null; created: boolean }>(
      tx,
      sql`select * from private.founding_open_checkout(${hash(token)}, ${workspace}::uuid)`,
    ),
  );

const worker = <T>(workspace: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  asService({ workspaceId: workspace, organizationId: org })(fn);

const paid = (checkoutId: string, cents = 49700, workspace = ws) =>
  worker<{ outcome: string; plan: string | null }[]>(workspace, (tx) =>
    rows(
      tx,
      sql`select * from private.founding_checkout_paid(${checkoutId}::uuid, 'cs_test', 'pi_test', ${cents})`,
    ),
  );

const grantStatus = async (grantId: string): Promise<string> => {
  const [g] = await rows<{ status: string }>(
    admin,
    sql`select status::text as status from platform.founding_grants where id = ${grantId}::uuid`,
  );
  return g?.status ?? 'missing';
};

describe('a free seat, taken up from its link', () => {
  it('goes on the workspace of the owner who was approved, with its plan and its credit', async () => {
    const { token, grantId } = await approve(FREE);
    expect((await preview(owner, token))[0]).toMatchObject({ state: 'ready', price_cents: 0 });

    const [done] = await claimFree(owner, token, ws);
    expect(done).toMatchObject({ grant_id: grantId, plan: 'founding_free' });
    // Topped up to the offer's $10: the workspace already had the $5 every new business starts with.
    expect(Number(done!.credited_cents)).toBe(500);

    const [plan] = await rows<{ plan: string; status: string }>(
      admin,
      sql`select plan::text as plan, status::text as status from app.workspace_plans where workspace_id = ${ws}`,
    );
    expect(plan).toEqual({ plan: 'founding_free', status: 'active' });
    expect(await grantStatus(grantId)).toBe('active');
    expect((await preview(owner, token))[0]?.state).toBe('claimed');
  });

  it('works once: the same link a second time is refused', async () => {
    const { token } = await approve(FREE);
    await claimFree(owner, token, ws);
    const e = await expectPgError(() => claimFree(owner, token, ws));
    expect(e.detail).toBe('founding_claim_invalid');
  });

  it('is refused to a plain member, to somebody from another business, and onto another business', async () => {
    const { token, grantId } = await approve(FREE);
    expect((await expectPgError(() => claimFree(member, token, ws))).detail).toBe(
      'founding_claim_not_yours',
    );
    expect((await expectPgError(() => claimFree(outsider, token, ws))).detail).toBe(
      'founding_claim_not_yours',
    );
    // Holding the link is not enough to move somebody's seat onto a workspace you run.
    expect((await expectPgError(() => claimFree(outsider, token, otherWs))).detail).toBe(
      'founding_claim_wrong_business',
    );
    expect(await grantStatus(grantId)).toBe('reserved');
  });

  it('is refused once the link has run out', async () => {
    const { token } = await approve(FREE, { linkExpired: true });
    expect((await preview(owner, token))[0]?.state).toBe('expired');
    expect((await expectPgError(() => claimFree(owner, token, ws))).detail).toBe(
      'founding_claim_invalid',
    );
  });

  it('takes the seat up once when two tabs press the button together', async () => {
    const { token, grantId } = await approve(FREE);
    const results = await Promise.all(
      [1, 2].map(() =>
        claimFree(owner, token, ws).then(
          () => 'in' as const,
          () => 'out' as const,
        ),
      ),
    );
    expect(results.sort()).toEqual(['in', 'out']);
    const [credits] = await rows<{ n: number | string }>(
      admin,
      sql`select count(*) as n from app.usage_ledger
          where workspace_id = ${ws} and idempotency_key = ${`credit:founding:${grantId}`}`,
    );
    expect(Number(credits!.n)).toBe(1);
  });

  it('tells nobody but the link holder anything, and a signed-in stranger reads no checkout rows', async () => {
    await approve(FREE);
    const seen = await as(outsider)((tx) =>
      rows(tx, sql`select 1 from platform.founding_checkouts`),
    );
    expect(seen).toHaveLength(0);
    expect(await preview(outsider, 'not-a-real-link')).toHaveLength(0);
  });
});

describe('a paid seat', () => {
  it('cannot be taken up from its link without paying', async () => {
    const { token, grantId } = await approve(PAID);
    const e = await expectPgError(() => claimFree(owner, token, ws));
    expect(e.detail).toBe('founding_claim_needs_checkout');
    expect(await grantStatus(grantId)).toBe('reserved');
  });

  it('opens one checkout, picks it back up on a second press, and stretches the reservation', async () => {
    const { token, grantId } = await approve(PAID);
    await admin.execute(
      sql`update platform.founding_grants set expires_at = now() + interval '1 hour' where id = ${grantId}::uuid`,
    );
    const [first] = await openCheckout(owner, token, ws);
    expect(first).toMatchObject({ status: 'pending', created: true, session_url: null });
    const [again] = await openCheckout(owner, token, ws);
    expect(again).toMatchObject({ checkout_id: first!.checkout_id, created: false });

    const [g] = await rows<{ stretched: boolean }>(
      admin,
      sql`select expires_at > now() + interval '47 hours' as stretched
          from platform.founding_grants where id = ${grantId}::uuid`,
    );
    expect(g!.stretched).toBe(true);
    expect((await preview(owner, token))[0]?.checkout_id).toBe(first!.checkout_id);
  });

  it('refuses a second workspace in the same business while one checkout is under way', async () => {
    const { token } = await approve(PAID);
    const [second] = await rows<{ id: string }>(
      admin,
      sql`insert into app.workspaces (organization_id, name, slug)
          values (${org}, 'Second', ${`second-${uniq()}`}) returning id`,
    );
    await admin.execute(
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${second!.id}, ${owner.id}, 'owner')`,
    );
    await openCheckout(owner, token, ws);
    const e = await expectPgError(() => openCheckout(owner, token, second!.id));
    expect(e.detail).toBe('founding_checkout_elsewhere');
  });

  it('shows the checkout to whoever runs the workspace, and to nobody else', async () => {
    const { token } = await approve(PAID);
    const [co] = await openCheckout(owner, token, ws);
    const view = (user: TestUser) =>
      as(user)((tx) =>
        rows<{ status: string; amount_cents: number }>(
          tx,
          sql`select * from private.founding_checkout_view(${co!.checkout_id}::uuid)`,
        ),
      );
    expect((await view(owner))[0]).toMatchObject({ status: 'pending', amount_cents: 49700 });
    expect(await view(member)).toHaveLength(0);
    expect(await view(outsider)).toHaveLength(0);
  });

  it('goes active when the worker records the payment, once however often Stripe says so', async () => {
    const { token, grantId } = await approve(PAID);
    const [co] = await openCheckout(owner, token, ws);
    const opened = () =>
      worker<{ opened: boolean }[]>(ws, (tx) =>
        rows(
          tx,
          sql`select private.founding_checkout_opened(${co!.checkout_id}::uuid, 'cs_test',
                'https://checkout.stripe.com/c/pay/cs_test', now() + interval '1 day') as opened`,
        ),
      );
    expect((await opened())[0]!.opened).toBe(true);
    expect((await opened())[0]!.opened).toBe(false);

    expect((await paid(co!.checkout_id))[0]).toMatchObject({
      outcome: 'activated',
      plan: 'founding_lifetime',
    });
    expect((await paid(co!.checkout_id))[0]!.outcome).toBe('already');
    expect(await grantStatus(grantId)).toBe('active');

    const [plan] = await rows<{ plan: string }>(
      admin,
      sql`select plan::text as plan from app.workspace_plans where workspace_id = ${ws}`,
    );
    expect(plan!.plan).toBe('founding_lifetime');
  });

  /**
   * The worker records a payment inside its own transaction, and the events and outbox rows written after it
   * are allowed by the system scope. 0091's credit blanked that scope; it has to come back as it was.
   */
  it('leaves the worker able to write after the credit has landed', async () => {
    const { token } = await approve(PAID);
    const [co] = await openCheckout(owner, token, ws);
    const scope = await worker<{ scope: string }[]>(ws, async (tx) => {
      await rows(
        tx,
        sql`select * from private.founding_checkout_paid(${co!.checkout_id}::uuid, 'cs', 'pi', 49700)`,
      );
      return rows(tx, sql`select current_setting('app.system_scope.workspace_id') as scope`);
    });
    expect(scope[0]!.scope).toBe(ws);
  });

  it('keeps the payment and flags it when the seat was revoked meanwhile', async () => {
    const { token, grantId } = await approve(PAID);
    const [co] = await openCheckout(owner, token, ws);
    await admin.execute(
      sql`update platform.founding_grants
          set status = 'revoked', revoked_at = now(), revoke_reason = 'test'
          where id = ${grantId}::uuid`,
    );
    expect((await paid(co!.checkout_id))[0]!.outcome).toBe('no_seat');
    const [row] = await rows<{ status: string; problem: string }>(
      admin,
      sql`select status::text as status, problem from platform.founding_checkouts
          where id = ${co!.checkout_id}::uuid`,
    );
    expect(row!.status).toBe('paid');
    expect(row!.problem).toMatch(/could not be turned on/);
    expect(await grantStatus(grantId)).toBe('revoked');
  });

  it('does not turn the seat on for less than its price', async () => {
    const { token, grantId } = await approve(PAID);
    const [co] = await openCheckout(owner, token, ws);
    expect((await paid(co!.checkout_id, 100))[0]!.outcome).toBe('no_seat');
    expect(await grantStatus(grantId)).toBe('reserved');
  });
});

describe('reservations running out', () => {
  const sweep = () =>
    asService({})((tx) =>
      rows<{ n: number }>(tx, sql`select private.founding_expire_reservations() as n`),
    );

  it('gives back a lapsed seat with nothing under way, and keeps one somebody is paying for', async () => {
    const lapsed = await approve(FREE);
    // One seat per business, so the one being paid for belongs to a second business the owner also runs.
    const second = await bootstrapOrganization(owner, 'Second Seat', 'Second Seat');
    const other = await approve(PAID, { organizationId: second.orgId });
    await as(owner)((tx) =>
      rows(
        tx,
        sql`select * from private.founding_open_checkout(${hash(other.token)}, ${second.wsId}::uuid)`,
      ),
    );
    await admin.execute(
      sql`update platform.founding_grants set expires_at = now() - interval '1 minute'
          where id in (${lapsed.grantId}::uuid, ${other.grantId}::uuid)`,
    );

    await sweep();
    expect(await grantStatus(lapsed.grantId)).toBe('expired');
    expect(await grantStatus(other.grantId)).toBe('reserved');
  });

  it('closes a checkout whose page lapsed at Stripe, and then gives its seat back', async () => {
    const { token, grantId } = await approve(PAID);
    const [co] = await openCheckout(owner, token, ws);
    await admin.execute(
      sql`update platform.founding_checkouts
          set status = 'open', session_ref = ${`cs_${uniq()}`}, session_url = 'https://x',
              session_expires_at = now() - interval '2 hours'
          where id = ${co!.checkout_id}::uuid`,
    );
    await admin.execute(
      sql`update platform.founding_grants set expires_at = now() - interval '1 minute'
          where id = ${grantId}::uuid`,
    );
    await sweep();
    const [row] = await rows<{ status: string }>(
      admin,
      sql`select status::text as status from platform.founding_checkouts where id = ${co!.checkout_id}::uuid`,
    );
    expect(row!.status).toBe('expired');
    expect(await grantStatus(grantId)).toBe('expired');

    // Stripe's page closed, but a payment that did go through a moment before still takes the seat back up,
    // because nobody else has it.
    expect((await paid(co!.checkout_id))[0]!.outcome).toBe('activated');
    expect(await grantStatus(grantId)).toBe('active');
  });
});
