/**
 * The affiliate program (20261027014000): asked of the database rather than trusted.
 *   1. A person sees only their own affiliate row and its clicks, and writes it only through private.affiliate_apply:
 *      never their status, their share or anyone else's row.
 *   2. Which businesses an affiliate sent is staff's alone, and a business is credited as it's made, by its maker,
 *      or never: not an older business, not somebody else's, and not to the maker's own link.
 *   3. Clicks are counted by the worker alone; the share everyone gets is read by anyone and changed by staff.
 *   4. What businesses paid us, and refunds, are staff's (20261027014200). An affiliate reads their own commissions,
 *      and the names of the businesses that earned them, never anybody else's; nobody but the worker writes one.
 *   5. Codes (20261027014300): an approved affiliate makes their own, up to their limit, and reads only their own;
 *      nobody writes one directly, a code staff turned off stays off until staff turn it on, and what a code takes
 *      off is held to the limit again when it's used. Nobody uses their own.
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

let seller: TestUser;
let other: TestUser;
let maker: TestUser;
let staff: TestUser;
let sellerId: string;
const code = `rls-${uniq()}`.slice(0, 20);

const apply = (u: TestUser, c: string) =>
  as(u)((tx) =>
    rows<{ affiliate_id: string; created: boolean }>(
      tx,
      sql`select * from private.affiliate_apply('Seller', ${c}, '', '')`,
    ),
  );

const credit = (u: TestUser, org: string, c = code) =>
  as(u)((tx) =>
    rows<{ id: string | null }>(
      tx,
      sql`select private.affiliate_note_signup(${org}, ${c}, 'link', now()) as id`,
    ),
  ).then((r) => r[0]!.id);

beforeAll(async () => {
  [seller, other, maker, staff] = await Promise.all([
    createTestUser('affiliates-rls-seller'),
    createTestUser('affiliates-rls-other'),
    createTestUser('affiliates-rls-maker'),
    createTestUser('affiliates-rls-staff'),
  ]);
  await dbs.admin.db.execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
  sellerId = (await apply(seller, code))[0]!.affiliate_id;
});

afterAll(async () => {
  await dbs.admin.db.execute(sql`delete from platform.affiliates where id = ${sellerId}`);
  await closeAll();
});

describe('a person and their own row', () => {
  it('sees their own row and nobody else’s', async () => {
    const mine = await as(seller)((tx) =>
      rows<{ id: string }>(tx, sql`select id from platform.affiliates`),
    );
    expect(mine.map((r) => r.id)).toEqual([sellerId]);
    const theirs = await as(other)((tx) =>
      rows<{ id: string }>(tx, sql`select id from platform.affiliates where id = ${sellerId}`),
    );
    expect(theirs).toEqual([]);
  });

  it('never approves themselves, sets their own share, or writes a row directly', async () => {
    const updated = await as(seller)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`update platform.affiliates set status = 'approved', rate_bp = 10000 where id = ${sellerId}
            returning id`,
      ),
    );
    expect(updated).toEqual([]);
    const e = await expectPgError(() =>
      as(other)((tx) =>
        tx.execute(
          sql`insert into platform.affiliates (user_id, code, name, status)
              values (${other.id}, ${`x-${uniq()}`.slice(0, 20)}, 'Other', 'approved')`,
        ),
      ),
    );
    expect(e.code).toBe('42501');
  });

  it('can’t take a code somebody has', async () => {
    const e = await expectPgError(() => apply(other, code));
    expect(e.detail).toBe('affiliate_code_taken');
  });
});

describe('crediting a business', () => {
  beforeAll(async () => {
    await dbs.admin.db.execute(
      sql`update platform.affiliates set status = 'approved' where id = ${sellerId}`,
    );
  });

  it('credits a business its maker just made, once, and only staff see it', async () => {
    const { orgId } = await bootstrapOrganization(maker, 'Credited Co', 'Credited Co');
    expect(await credit(maker, orgId)).toBe(sellerId);
    expect(await credit(maker, orgId)).toBeNull();
    const seen = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ affiliate_id: string }>(
          tx,
          sql`select affiliate_id from platform.affiliate_referrals where organization_id = ${orgId}`,
        ),
      );
    expect(await seen(maker)).toEqual([]);
    expect(await seen(seller)).toEqual([]);
    expect(await seen(staff)).toEqual([{ affiliate_id: sellerId }]);
  });

  it('never credits somebody else’s business, an older one, or the maker’s own link', async () => {
    const { orgId: theirs } = await bootstrapOrganization(other, 'Not Yours', 'Not Yours');
    expect(await credit(maker, theirs)).toBeNull();

    const { orgId: older } = await bootstrapOrganization(maker, 'Older Co', 'Older Co');
    await dbs.admin.db.execute(
      sql`update app.organizations set created_at = now() - interval '1 day' where id = ${older}`,
    );
    expect(await credit(maker, older)).toBeNull();

    const { orgId: own } = await bootstrapOrganization(seller, 'Own Co', 'Own Co');
    expect(await credit(seller, own)).toBeNull();
  });

  it('a person can’t write a credit directly', async () => {
    const { orgId } = await bootstrapOrganization(maker, 'Direct Co', 'Direct Co');
    const e = await expectPgError(() =>
      as(maker)((tx) =>
        tx.execute(
          sql`insert into platform.affiliate_referrals (organization_id, affiliate_id, how)
              values (${orgId}, ${sellerId}, 'by_hand')`,
        ),
      ),
    );
    expect(e.code).toBe('42501');
  });
});

describe('clicks and the share', () => {
  it('only the worker counts clicks', async () => {
    const e = await expectPgError(() =>
      as(other)((tx) => tx.execute(sql`select private.affiliate_click(${code})`)),
    );
    expect(e.code).toBe('42501');
    const [counted] = await asService({})((tx) =>
      rows<{ ok: boolean }>(tx, sql`select private.affiliate_click(${code}) as ok`),
    );
    expect(counted?.ok).toBe(true);
    const clicks = await as(seller)((tx) =>
      rows<{ clicks: number }>(tx, sql`select clicks from platform.affiliate_clicks`),
    );
    expect(clicks.map((c) => c.clicks)).toEqual([1]);
    expect(
      await as(other)((tx) =>
        rows(tx, sql`select 1 from platform.affiliate_clicks where affiliate_id = ${sellerId}`),
      ),
    ).toEqual([]);
  });

  it('anyone reads everyone’s share; only staff change it', async () => {
    const [s] = await as(other)((tx) =>
      rows<{ rate_bp: number }>(tx, sql`select rate_bp from platform.affiliate_settings`),
    );
    expect(s?.rate_bp).toBeGreaterThan(0);
    const changed = await as(other)((tx) =>
      rows(tx, sql`update platform.affiliate_settings set rate_bp = 9999 returning rate_bp`),
    );
    expect(changed).toEqual([]);
    const byStaff = await as(staff)((tx) =>
      rows<{ rate_bp: number }>(
        tx,
        sql`update platform.affiliate_settings set rate_bp = rate_bp returning rate_bp`,
      ),
    );
    expect(byStaff).toHaveLength(1);
  });
});

describe('what an affiliate earns', () => {
  let orgId: string;
  let paymentId: string;

  beforeAll(async () => {
    ({ orgId } = await bootstrapOrganization(maker, 'Paying Co', 'Paying Co'));
    const [p] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into platform.plan_payments (organization_id, how, payment_ref, amount_cents, period_from, paid_at)
          values (${orgId}, 'checkout', ${`pi_rls_${uniq()}`}, 9700, now(), now()) returning id`,
    );
    paymentId = p!.id;
    await dbs.admin.db.execute(
      sql`insert into platform.affiliate_commissions
            (affiliate_id, organization_id, payment_id, kind, base_cents, rate_bp, amount_cents, earned_at, payable_at)
          values (${sellerId}, ${orgId}, ${paymentId}, 'earned', 9700, 4000, 3880, now(), now() + interval '30 days')`,
    );
  });

  it('the affiliate reads their own commissions and the business’s name; nobody else does', async () => {
    const mine = await as(seller)((tx) =>
      rows<{ amount_cents: string }>(
        tx,
        sql`select amount_cents::text from platform.affiliate_commissions where payment_id = ${paymentId}`,
      ),
    );
    expect(mine).toEqual([{ amount_cents: '3880' }]);
    const named = await as(seller)((tx) =>
      rows<{ name: string; earned_cents: string }>(
        tx,
        sql`select name, earned_cents::text from private.affiliate_my_businesses()
            where organization_id = ${orgId}`,
      ),
    );
    expect(named).toEqual([{ name: 'Paying Co', earned_cents: '3880' }]);
    for (const u of [maker, other]) {
      expect(
        await as(u)((tx) =>
          rows(
            tx,
            sql`select 1 from platform.affiliate_commissions where payment_id = ${paymentId}`,
          ),
        ),
      ).toEqual([]);
      expect(
        await as(u)((tx) => rows(tx, sql`select * from private.affiliate_my_businesses()`)),
      ).toEqual([]);
    }
    expect(
      await as(staff)((tx) =>
        rows(tx, sql`select 1 from platform.affiliate_commissions where payment_id = ${paymentId}`),
      ),
    ).toHaveLength(1);
  });

  it('what a business paid us, and its refunds, are staff’s alone', async () => {
    const seen = (u: TestUser) =>
      as(u)((tx) => rows(tx, sql`select 1 from platform.plan_payments where id = ${paymentId}`));
    expect(await seen(maker)).toEqual([]);
    expect(await seen(seller)).toEqual([]);
    expect(await seen(staff)).toHaveLength(1);
  });

  it('nobody but the worker writes one, staff included', async () => {
    for (const u of [seller, staff]) {
      const e = await expectPgError(() =>
        as(u)((tx) =>
          tx.execute(
            sql`insert into platform.affiliate_commissions
                  (affiliate_id, organization_id, payment_id, kind, base_cents, rate_bp, amount_cents, earned_at,
                   payable_at)
                values (${sellerId}, ${orgId}, ${paymentId}, 'given_back', 9700, 4000, 100, now(), now())`,
          ),
        ),
      );
      expect(e.code).toBe('42501');
      const changed = await expectPgError(() =>
        as(u)((tx) =>
          tx.execute(
            sql`update platform.affiliate_commissions set amount_cents = 9700 where payment_id = ${paymentId}`,
          ),
        ),
      );
      expect(changed.code).toBe('42501');
    }
    const e = await expectPgError(() =>
      as(staff)((tx) =>
        tx.execute(
          sql`insert into platform.plan_refunds (payment_id, refund_ref, amount_cents, status, refunded_at)
              values (${paymentId}, ${`re_rls_${uniq()}`}, 100, 'succeeded', now())`,
        ),
      ),
    );
    expect(e.code).toBe('42501');
  });
});

describe('codes', () => {
  const MONTHLY = 'test_code_rls_monthly';
  const ONCE = 'test_code_rls_once';
  const make = (
    u: TestUser,
    c: string,
    terms: {
      affiliate?: string | null;
      offer?: string | null;
      bp?: number | null;
      cents?: number | null;
      trial?: number | null;
    } = {},
  ) =>
    as(u)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`select private.affiliate_make_code(
              ${terms.affiliate === undefined ? sellerId : terms.affiliate}::uuid, ${c},
              ${terms.offer === undefined ? MONTHLY : terms.offer}::text,
              ${terms.bp === undefined ? 2000 : terms.bp}::integer, ${terms.cents ?? null}::integer, null::integer,
              ${terms.trial ?? null}::integer) as id`,
      ),
    ).then((r) => r[0]!.id);
  const turn = (u: TestUser, id: string, on: boolean) =>
    as(u)((tx) =>
      rows<{ changed: boolean }>(
        tx,
        sql`select changed from private.affiliate_turn_code(${id}::uuid, ${on})`,
      ),
    ).then((r) => r[0]!.changed);
  const preview = (u: TestUser, ws: string, c: string) =>
    as(u)((tx) =>
      rows<{ offer_id: string; refusal: string | null; discount_cents: number }>(
        tx,
        sql`select offer_id, refusal, discount_cents from private.affiliate_code_preview(${c}, ${ws}::uuid)
            where offer_id in (${MONTHLY}, ${ONCE}) order by offer_id`,
      ),
    );
  let codeId: string;
  const theCode = `c-${uniq()}`.slice(0, 20);

  beforeAll(async () => {
    await dbs.admin.db.execute(
      sql`update platform.affiliates set status = 'approved', max_discount_bp = null where id = ${sellerId}`,
    );
    // Off sale, so no business made by these tests is asked to pay; a code is made for any plan not in draft.
    await dbs.admin.db.execute(
      sql`insert into platform.founding_offers
            (id, name, seat_cap, price_cents, status, billing, paid_yearly, starting_credit_cents, show_counter, sort)
          values (${MONTHLY}, 'Code monthly', 3, 9700, 'closed', 'monthly', false, 0, true, 961),
                 (${ONCE}, 'Code once', 3, 49700, 'closed', 'once', false, 0, true, 962)
          on conflict (id) do update set status = 'closed', price_cents = excluded.price_cents`,
    );
    codeId = await make(seller, theCode.toUpperCase());
  });

  afterAll(async () => {
    await dbs.admin.db.execute(
      sql`delete from platform.affiliate_codes where affiliate_id = ${sellerId}`,
    );
    await dbs.admin.db.execute(
      sql`delete from platform.founding_offers where id in (${MONTHLY}, ${ONCE})`,
    );
  });

  it('an affiliate reads their own codes, staff read them all, and nobody else reads any', async () => {
    const seen = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ code: string }>(
          tx,
          sql`select code from platform.affiliate_codes where id = ${codeId}`,
        ),
      );
    expect(await seen(seller)).toEqual([{ code: theCode }]);
    expect(await seen(staff)).toEqual([{ code: theCode }]);
    expect(await seen(other)).toEqual([]);
    expect(await seen(maker)).toEqual([]);
  });

  it('nobody writes a code directly, staff included', async () => {
    for (const u of [seller, staff]) {
      const e = await expectPgError(() =>
        as(u)((tx) =>
          tx.execute(
            sql`insert into platform.affiliate_codes (affiliate_id, code, percent_off_bp)
                values (${sellerId}, ${`d-${uniq()}`.slice(0, 20)}, 9000)`,
          ),
        ),
      );
      expect(e.code).toBe('42501');
      const changed = await expectPgError(() =>
        as(u)((tx) =>
          tx.execute(
            sql`update platform.affiliate_codes set percent_off_bp = 9000 where id = ${codeId}`,
          ),
        ),
      );
      expect(changed.code).toBe('42501');
    }
  });

  it('makes one only for their own row, never a house code, and only up to the limit', async () => {
    const refused = async (u: TestUser, terms: Parameters<typeof make>[2]) =>
      (await expectPgError(() => make(u, `r-${uniq()}`.slice(0, 20), terms))).detail;
    expect(await refused(other, {})).toBe('affiliate_code_not_yours');
    expect(await refused(seller, { affiliate: null })).toBe('affiliate_code_not_yours');
    expect(await refused(seller, { bp: 5001 })).toBe('affiliate_code_over_limit');
    // Dollars: at most half the cheapest plan it's for.
    expect(await refused(seller, { bp: null, cents: 4851 })).toBe('affiliate_code_over_limit');
    expect(await make(seller, `ok-${uniq()}`.slice(0, 20), { bp: null, cents: 4850 })).toBeTruthy();
    // A trial needs a plan paid by the month or the year.
    expect(await refused(seller, { offer: ONCE, bp: null, trial: 14 })).toBe(
      'affiliate_code_no_plan',
    );
    expect(await refused(seller, { offer: 'no-such-plan' })).toBe('affiliate_code_no_plan');
    expect((await expectPgError(() => make(seller, theCode))).detail).toBe('affiliate_code_taken');
    // Staff make a house code, up to 90%.
    expect(
      await make(staff, `h-${uniq()}`.slice(0, 20), { affiliate: null, bp: 9000 }),
    ).toBeTruthy();
    await dbs.admin.db.execute(
      sql`delete from platform.affiliate_codes where affiliate_id is null and created_by = ${staff.id}`,
    );
  });

  it('a code staff turned off stays off until staff turn it on; nobody else turns it', async () => {
    expect((await expectPgError(() => turn(other, codeId, false))).detail).toBe(
      'affiliate_code_not_yours',
    );
    expect(await turn(seller, codeId, false)).toBe(true);
    expect(await turn(seller, codeId, true)).toBe(true);
    expect(await turn(staff, codeId, false)).toBe(true);
    expect((await expectPgError(() => turn(seller, codeId, true))).detail).toBe(
      'affiliate_code_off_by_staff',
    );
    expect(await turn(seller, codeId, false)).toBe(false);
    expect(await turn(staff, codeId, true)).toBe(true);
  });

  it('what a code takes off is held to the limit as it stands, and works for nobody while its affiliate is paused', async () => {
    const { wsId } = await bootstrapOrganization(maker, 'Code Co', 'Code Co');
    expect(await preview(maker, wsId, theCode)).toEqual([
      { offer_id: MONTHLY, refusal: null, discount_cents: 1940 },
      { offer_id: ONCE, refusal: 'affiliate_code_other_plan', discount_cents: 0 },
    ]);
    await dbs.admin.db.execute(
      sql`update platform.affiliates set max_discount_bp = 1000 where id = ${sellerId}`,
    );
    expect((await preview(maker, wsId, theCode))[0]!.discount_cents).toBe(970);
    await dbs.admin.db.execute(
      sql`update platform.affiliates set max_discount_bp = null, status = 'paused' where id = ${sellerId}`,
    );
    expect((await preview(maker, wsId, theCode))[0]!.refusal).toBe('affiliate_code_unknown');
    await dbs.admin.db.execute(
      sql`update platform.affiliates set status = 'approved' where id = ${sellerId}`,
    );

    // Only somebody who may buy the business's spot asks.
    expect((await expectPgError(() => preview(other, wsId, theCode))).detail).toBe(
      'founding_buy_not_yours',
    );
    // Nobody reads a code's terms, and its affiliate, around the preview.
    const e = await expectPgError(() =>
      as(maker)((tx) =>
        tx.execute(sql`select * from private.affiliate_code_terms(${theCode}, ${MONTHLY}, null)`),
      ),
    );
    expect(e.code).toBe('42501');
  });

  it('nobody uses their own code', async () => {
    const { wsId } = await bootstrapOrganization(seller, 'Seller Own Co', 'Seller Own Co');
    expect((await preview(seller, wsId, theCode))[0]!.refusal).toBe('affiliate_code_own');
  });
});
