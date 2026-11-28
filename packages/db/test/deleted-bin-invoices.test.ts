/**
 * The Deleted bin, invoices (20261027037500): any invoice goes in the bin, paid ones too, and is emptied after.
 *   - Hidden from people and the worker, with its payments and refunds, which Money's totals read on their own; off
 *     phones with its lines. Its lines are only read through it, so they need no mark of their own.
 *   - Emptied with its lines, payments and refunds.
 *   - One waits while money is still moving or a payment is disputed, and one a partner earned from stays.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  type TestUser,
} from './harness';

const admin$ = dbs.admin.db;

let owner: TestUser;
let ws: string;
let org: string;
let maria: string;

const worker = () => asService({ workspaceId: ws, organizationId: org });
const uuids = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

const one = <T>(r: T[]): T => {
  expect(r).toHaveLength(1);
  return r[0]!;
};

const insert = (tx: Parameters<typeof rows>[0], q: ReturnType<typeof sql>) =>
  rows<{ id: string }>(tx, q).then((r) => one(r).id);

const bin = async (id: string): Promise<string> =>
  one(
    await as(owner)((tx) =>
      rows<{ id: string }>(tx, sql`select private.bin_put('invoice', ${id}::uuid) as id`),
    ),
  ).id;

const preview = (id: string) =>
  as(owner)((tx) =>
    rows<{ rule: string | null; contents: Record<string, unknown> }>(
      tx,
      sql`select rule, contents from private.bin_preview('invoice', ${uuids([id])})`,
    ),
  ).then(one);

async function empty(item: string): Promise<void> {
  await as(owner)((tx) => rows(tx, sql`select * from private.bin_start_purge(${uuids([item])})`));
  for (let i = 0; i < 100; i++) {
    const [r] = await worker()((tx) =>
      rows<{ r: { more: boolean } }>(
        tx,
        sql`select private.purge_bin_batch(${ws}::uuid, ${item}::uuid, 500) as r`,
      ),
    );
    if (!r!.r.more) return;
  }
  throw new Error('the bin never finished emptying');
}

const left = async (table: string, ids: string[]) =>
  one(
    await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from app.${sql.raw(table)} where id = any (${uuids(ids)})`,
    ),
  ).n;

const seen = (who: ReturnType<typeof as>, table: string, id: string) =>
  who((tx) => rows(tx, sql`select id from app.${sql.raw(table)} where id = ${id}`)).then(
    (r) => r.length,
  );

/** A draft with one line, and a payment on it as `payment` says. */
async function invoice(payment: 'none' | 'failed' | 'succeeded' | 'processing') {
  return worker()(async (tx) => {
    const id = await insert(
      tx,
      sql`insert into app.invoices (workspace_id, person_id, title, subtotal_cents, taxable_base_cents, tax_cents,
            total_cents, tax_rate_bp, tax_label)
          values (${ws}, ${maria}, 'Tune-up', 15000, 15000, 0, 15000, 0, 'Sales tax') returning id`,
    );
    const lineId = await insert(
      tx,
      sql`insert into app.invoice_lines (workspace_id, invoice_id, name, quantity, unit_price_cents, amount_cents)
          values (${ws}, ${id}, 'Tune-up', 1, 15000, 15000) returning id`,
    );
    const paymentId =
      payment === 'none'
        ? null
        : await insert(
            tx,
            sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, provider, status,
                  idempotency_key, received_at)
                values (${ws}, ${id}, 15000, 'card', 'stripe', ${payment}, ${`key-${randomUUID()}`},
                  ${payment === 'succeeded' ? sql`now()` : null})
                returning id`,
          );
    return { id, lineId, paymentId };
  });
}

beforeAll(async () => {
  owner = await createTestUser('bininv-owner');
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(owner, 'Bin Inv Org', 'Bin Inv Heating'));
  maria = await worker()((tx) =>
    insert(
      tx,
      sql`insert into app.people (workspace_id, first_name, last_name)
          values (${ws}, 'Maria', 'Lopez') returning id`,
    ),
  );
});
afterAll(closeAll);

describe('an invoice in the bin', () => {
  it('is hidden and off phones, lines and all, and emptied with them', async () => {
    const inv = await invoice('failed');
    expect(await preview(inv.id)).toEqual({
      rule: null,
      contents: { who: ['Maria Lopez'], totalCents: 15000 },
    });
    const item = await bin(inv.id);

    expect(await seen(as(owner), 'invoices', inv.id)).toBe(0);
    expect(await seen(worker(), 'invoices', inv.id)).toBe(0);
    const [row] = await rows<{ invoice: boolean; line: boolean; payment: boolean }>(
      admin$,
      sql`select (select sync_window from app.invoices where id = ${inv.id}) as invoice,
            (select sync_window from app.invoice_lines where id = ${inv.lineId}) as line,
            (select sync_window from app.payments where id = ${inv.paymentId}) as payment`,
    );
    expect(row).toEqual({ invoice: false, line: false, payment: false });

    await empty(item);
    expect(await left('invoices', [inv.id])).toBe(0);
    expect(await left('invoice_lines', [inv.lineId])).toBe(0);
    expect(await left('payments', [inv.paymentId!])).toBe(0);
    expect(await left('people', [maria])).toBe(1);
  });

  it('can be paid, its payments and refunds hidden and emptied with it', async () => {
    const inv = await invoice('succeeded');
    const refund = await worker()((tx) =>
      insert(
        tx,
        sql`insert into app.refunds (workspace_id, payment_id, invoice_id, amount_cents, status, refunded_at)
            values (${ws}, ${inv.paymentId}, ${inv.id}, 5000, 'succeeded', now()) returning id`,
      ),
    );
    expect(await preview(inv.id)).toEqual({
      rule: null,
      contents: { who: ['Maria Lopez'], totalCents: 15000, paidCents: 15000 },
    });
    const item = await bin(inv.id);
    for (const who of [as(owner), worker()]) {
      expect(await seen(who, 'payments', inv.paymentId!)).toBe(0);
      expect(await seen(who, 'refunds', refund)).toBe(0);
    }
    await empty(item);
    expect(await left('payments', [inv.paymentId!])).toBe(0);
    expect(await left('refunds', [refund])).toBe(0);
  });

  it('waits while money is still moving or disputed, and stays when a partner earned from it', async () => {
    const coming = await invoice('processing');
    expect((await preview(coming.id)).rule).toBe('bin_invoice_moving');

    const refunding = await invoice('succeeded');
    await worker()((tx) =>
      insert(
        tx,
        sql`insert into app.refunds (workspace_id, payment_id, invoice_id, amount_cents, status)
            values (${ws}, ${refunding.paymentId}, ${refunding.id}, 5000, 'pending') returning id`,
      ),
    );
    expect((await preview(refunding.id)).rule).toBe('bin_invoice_moving');

    const disputed = await invoice('succeeded');
    await rows(
      admin$,
      sql`insert into app.payment_disputes (workspace_id, payment_id, invoice_id, provider, provider_dispute_id,
            amount_cents, opened_at)
          values (${ws}, ${disputed.paymentId}, ${disputed.id}, 'stripe', ${`dp_${randomUUID()}`}, 15000, now())`,
    );
    expect((await preview(disputed.id)).rule).toBe('bin_invoice_disputed');

    const shared = await invoice('succeeded');
    const [partner] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.partners (workspace_id, person_id, code)
          values (${ws}, ${maria}, ${randomUUID().replace(/-/g, '').slice(0, 10)}) returning id`,
    );
    const [referral] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.partner_referrals (workspace_id, partner_id, how, referred_at)
          values (${ws}, ${partner!.id}, 'by_hand', now()) returning id`,
    );
    await rows(
      admin$,
      sql`insert into app.partner_commissions (workspace_id, partner_id, referral_id, payment_id, kind, base_cents,
            rate_bp, amount_cents, earned_at, payable_at)
          values (${ws}, ${partner!.id}, ${referral!.id}, ${shared.paymentId}, 'earned', 15000, 1000, 1500, now(),
            now() + interval '30 days')`,
    );
    expect((await preview(shared.id)).rule).toBe('bin_invoice_partner');
  });
});
