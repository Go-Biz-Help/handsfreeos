/**
 * Payment disputes (20261027008700): asked of the database rather than trusted.
 *   1. Whoever manages money sees every dispute; a member who sees money sees the ones on invoices they can see, as
 *      with refunds; nobody outside the business sees any.
 *   2. Only the worker keeps them, for the business it works for, each on its own payment and that payment's invoice.
 *   3. A dispute settles once: a late "still open" leaves it won or lost.
 *   4. A partner's commission is taken back by a refund or by a lost dispute, never both.
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
let member: TestUser;
let outsider: TestUser;

interface Business {
  readonly ws: string;
  readonly org: string;
}
let A: Business;
let B: Business;

/** A payment by card on an invoice of business A, and its invoice. */
interface Paid {
  readonly invoiceId: string;
  readonly paymentId: string;
}
let theirs: Paid;
let others: Paid;

const worker = (b: Business) => asService({ workspaceId: b.ws, organizationId: b.org });
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;

async function paid(personId: string, leadId: string | null, ref: string): Promise<Paid> {
  const [invoice] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.invoices (workspace_id, person_id, lead_id, title, status)
        values (${A.ws}, ${personId}, ${leadId}, 'Tune-up', 'sent') returning id`,
  );
  const [payment] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, provider, provider_payment_id,
          status, received_at)
        values (${A.ws}, ${invoice!.id}, 10000, 'card', 'stripe', ${ref}, 'succeeded', now()) returning id`,
  );
  return { invoiceId: invoice!.id, paymentId: payment!.id };
}

/** A dispute as the worker keeps one. */
const keep = (as: Business, p: Paid, ref: string, invoiceId = p.invoiceId) =>
  worker(as)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.payment_disputes (workspace_id, payment_id, invoice_id, provider, provider_dispute_id,
            amount_cents, status, opened_at)
          values (${A.ws}, ${p.paymentId}, ${invoiceId}, 'stripe', ${ref}, 10000, 'open', now())
          returning id`,
    ),
  ).then((r) => r[0]!.id);

const seen = (u: TestUser) =>
  as(u)((tx) =>
    rows<{ provider_dispute_id: string }>(
      tx,
      sql`select provider_dispute_id from app.payment_disputes where workspace_id = ${A.ws}
          order by provider_dispute_id`,
    ),
  ).then((r) => r.map((d) => d.provider_dispute_id));

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('disputes-rls-owner'),
    createTestUser('disputes-rls-member'),
    createTestUser('disputes-rls-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Disputes Org A', 'Disputes A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Disputes Org B', 'Disputes B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: A.ws, userId: member.id, role: 'member' }]);
  const [person] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.people (workspace_id, first_name) values (${A.ws}, 'Maria') returning id`,
  );
  const [stage] = await rows<{ id: string; pipeline_id: string }>(
    dbs.admin.db,
    sql`select id, pipeline_id from app.pipeline_stages
        where workspace_id = ${A.ws} and kind = 'open' order by position limit 1`,
  );
  // The member's own lead: its invoice is one they see.
  const [lead] = await rows<{ id: string }>(
    dbs.admin.db,
    sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, assignee_user_id)
        values (${A.ws}, ${stage!.pipeline_id}, ${stage!.id}, ${person!.id}, 'Tune-up', ${member.id})
        returning id`,
  );
  theirs = await paid(person!.id, lead!.id, 'pi_disputes_rls_1');
  others = await paid(person!.id, null, 'pi_disputes_rls_2');
});
afterAll(closeAll);

describe('payment disputes', () => {
  it('are kept by the worker alone, for its own business, each on its payment’s invoice', async () => {
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`insert into app.payment_disputes (workspace_id, payment_id, invoice_id, provider,
                  provider_dispute_id, amount_cents, opened_at)
                values (${A.ws}, ${theirs.paymentId}, ${theirs.invoiceId}, 'stripe', 'dp_by_hand', 10000, now())`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(await code(() => keep(B, theirs, 'dp_wrong_business'))).toBe('42501');
    // A payment named with another invoice is refused.
    expect(await code(() => keep(A, theirs, 'dp_wrong_invoice', others.invoiceId))).toBe('23514');
    await keep(A, theirs, 'dp_theirs');
    await keep(A, others, 'dp_others');
    expect(await code(() => keep(A, theirs, 'dp_theirs'))).toBe('23505');
  });

  it('are seen by whoever manages money, by a member on the invoices they see, and by nobody outside', async () => {
    expect(await seen(owner)).toEqual(['dp_others', 'dp_theirs']);
    expect(await seen(member)).toEqual(['dp_theirs']);
    expect(await seen(outsider)).toEqual([]);
  });

  it('settle once', async () => {
    const settle = (status: string, closed: boolean) =>
      worker(A)((tx) =>
        rows<{ status: string }>(
          tx,
          sql`update app.payment_disputes
              set status = ${status}, closed_at = ${closed ? new Date().toISOString() : null}::timestamptz
              where provider_dispute_id = 'dp_theirs' returning status`,
        ),
      ).then((r) => r[0]!.status);
    expect(await settle('lost', true)).toBe('lost');
    expect(await settle('open', false)).toBe('lost');
    expect(
      await code(() =>
        worker(A)((tx) =>
          tx.execute(
            sql`update app.payment_disputes set payment_id = ${others.paymentId}
                where provider_dispute_id = 'dp_theirs'`,
          ),
        ),
      ),
    ).toBe('23514');
  });
});

describe('a partner’s commission taken back', () => {
  it('is taken back by a refund or by a lost dispute, never both', async () => {
    const [paula] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.people (workspace_id, first_name) values (${A.ws}, 'Paula') returning id`,
    );
    const [partner] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.partners (workspace_id, person_id, code) values (${A.ws}, ${paula!.id}, 'DsPtRlS234')
          returning id`,
    );
    const [maria] = await rows<{ person_id: string }>(
      dbs.admin.db,
      sql`select person_id from app.invoices where id = ${theirs.invoiceId}`,
    );
    const [referral] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.partner_referrals (workspace_id, partner_id, person_id, how, referred_at)
          values (${A.ws}, ${partner!.id}, ${maria!.person_id}, 'by_hand', now() - interval '1 day') returning id`,
    );
    const [refund] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.refunds (workspace_id, payment_id, invoice_id, amount_cents, status, refunded_at)
          values (${A.ws}, ${theirs.paymentId}, ${theirs.invoiceId}, 1000, 'succeeded', now()) returning id`,
    );
    const [dispute] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`select id from app.payment_disputes where provider_dispute_id = 'dp_theirs'`,
    );
    const takenBack = (refundId: string | null, disputeId: string | null) =>
      worker(A)((tx) =>
        tx.execute(
          sql`insert into app.partner_commissions (workspace_id, partner_id, referral_id, payment_id, refund_id,
                dispute_id, kind, base_cents, rate_bp, amount_cents, earned_at, payable_at)
              values (${A.ws}, ${partner!.id}, ${referral!.id}, ${theirs.paymentId}, ${refundId}, ${disputeId},
                'taken_back', 1000, 1000, -100, now(), now())`,
        ),
      );
    expect(await code(() => takenBack(refund!.id, dispute!.id))).toBe('23514');
    expect(await code(() => takenBack(null, null))).toBe('23514');
    await takenBack(null, dispute!.id);
    // A dispute takes back once.
    expect(await code(() => takenBack(null, dispute!.id))).toBe('23505');
  });
});
