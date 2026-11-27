/**
 * Deleting an invoice (20261027037200): a draft, or one nothing was paid on, goes in the Deleted bin and comes back
 * from it.
 *   - Owners only, never the AI, a workflow or the system, as every other kind.
 *   - One still out for payment is voided first, so its link stops taking payments, and comes back voided.
 *   - One with money on it stays for the business's books, and so does a booking's deposit still holding its time.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  binList,
  binPreview,
  binRestore,
  invoiceCreate,
  invoiceDelete,
  invoiceGet,
  invoiceList,
  invoiceRecordCashPayment,
  invoiceSend,
  invoiceVoid,
  personGet,
} from '../src/server';
import { admin, ask, expectHfos, run, runSystem, setupTeam, type Team } from './calendar-helpers';

let t: Team;
let maria: string;

beforeAll(async () => {
  t = await setupTeam('bininv');
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.people (workspace_id, first_name, last_name, email)
        values (${t.wsId}, 'Maria', 'Lopez', ${`maria-${randomUUID().slice(0, 8)}@example.test`}) returning id`,
  );
  maria = p!.id;
});
afterAll(closeTestDbs);

const draft = async (title = 'AC replacement') =>
  (
    await run(
      invoiceCreate,
      {
        workspaceId: t.wsId,
        personId: maria,
        title,
        lines: [{ name: 'Job', quantity: 1, unitPriceCents: 100_000, taxable: false }],
      },
      t.owner,
    )
  ).invoiceId;

const sent = async (title?: string) => {
  const invoiceId = await draft(title);
  return run(invoiceSend, { workspaceId: t.wsId, invoiceId }, t.owner);
};

const events = (type: string, entityId: string) =>
  rows<{ payload: Record<string, unknown> }>(
    admin(),
    sql`select payload from app.events where event_type = ${type} and entity_id = ${entityId} order by occurred_at`,
  );

const preview = async (id: string) =>
  (await ask(binPreview, { workspaceId: t.wsId, kind: 'invoice', ids: [id] }, t.owner)).items[0]!;

describe('who may delete an invoice', () => {
  it('is an owner, never a member unless given it, nor the system', async () => {
    const id = await draft();
    await expectHfos(
      () => run(invoiceDelete, { workspaceId: t.wsId, invoiceIds: [id] }, t.member),
      'forbidden',
      403,
    );
    await expectHfos(
      () => runSystem(invoiceDelete, { workspaceId: t.wsId, invoiceIds: [id] }, t.scope),
      'forbidden',
    );
    expect(invoiceDelete.risk).toBe(4);
  });
});

describe('deleting a draft', () => {
  it('hides it, leaves its customer, and brings it back', async () => {
    const id = await draft('Duct cleaning');
    expect(await preview(id)).toEqual({
      id,
      name: 'Duct cleaning',
      contents: { who: ['Maria Lopez'], totalCents: 100_000 },
      rule: null,
      message: null,
    });

    const out = await run(invoiceDelete, { workspaceId: t.wsId, invoiceIds: [id] }, t.owner);
    expect(out.deleted).toEqual([{ id, binItemId: expect.any(String), name: 'Duct cleaning' }]);
    expect((await events('invoice.deleted', id))[0]!.payload).toMatchObject({
      name: 'Duct cleaning',
      binItemId: out.deleted[0]!.binItemId,
    });
    await expectHfos(
      () => ask(invoiceGet, { workspaceId: t.wsId, invoiceId: id }, t.owner),
      'not_found',
      404,
    );
    const list = await ask(invoiceList, { workspaceId: t.wsId }, t.owner);
    expect(list.invoices.some((i) => i.id === id)).toBe(false);
    expect(
      (await ask(personGet, { workspaceId: t.wsId, personId: maria }, t.owner)).person.id,
    ).toBe(maria);
    const [row] = await rows<{ sync_window: boolean; lines_synced: number }>(
      admin(),
      sql`select i.sync_window,
            (select count(*)::int from app.invoice_lines l where l.invoice_id = i.id and l.sync_window) lines_synced
          from app.invoices i where i.id = ${id}`,
    );
    expect(row).toEqual({ sync_window: false, lines_synced: 0 });

    const bin = await ask(binList, { workspaceId: t.wsId }, t.owner);
    expect(bin.items.find((b) => b.recordId === id)).toMatchObject({
      kind: 'invoice',
      name: 'Duct cleaning',
      contents: { who: ['Maria Lopez'], totalCents: 100_000 },
    });

    const back = await run(
      binRestore,
      { workspaceId: t.wsId, binItemId: out.deleted[0]!.binItemId },
      t.owner,
    );
    expect(back).toEqual({ kind: 'invoice', recordId: id, name: 'Duct cleaning', joined: 0 });
    const got = await ask(invoiceGet, { workspaceId: t.wsId, invoiceId: id }, t.owner);
    expect(got.invoice.status).toBe('draft');
  });
});

describe('deleting an invoice still out for payment', () => {
  it('voids it first, and it comes back voided', async () => {
    const out = await sent();
    const id = out.invoiceId;
    const seen = await preview(id);
    expect(seen).toMatchObject({
      name: out.number,
      contents: { who: ['Maria Lopez'], totalCents: 100_000, voidFirst: 1 },
      // It doesn't stop it: the delete box says it's voided first.
      rule: null,
    });

    const gone = await run(invoiceDelete, { workspaceId: t.wsId, invoiceIds: [id] }, t.owner);
    expect(gone.deleted[0]!.name).toBe(out.number);
    expect(await events('invoice.voided', id)).toHaveLength(1);
    expect(await events('invoice.deleted', id)).toHaveLength(1);

    await run(binRestore, { workspaceId: t.wsId, binItemId: gone.deleted[0]!.binItemId }, t.owner);
    const got = await ask(invoiceGet, { workspaceId: t.wsId, invoiceId: id }, t.owner);
    expect(got.invoice.status).toBe('void');
  });

  it('takes a voided one nothing was paid on as it is', async () => {
    const out = await sent();
    await run(invoiceVoid, { workspaceId: t.wsId, invoiceId: out.invoiceId }, t.owner);
    expect((await preview(out.invoiceId)).rule).toBeNull();
    await run(invoiceDelete, { workspaceId: t.wsId, invoiceIds: [out.invoiceId] }, t.owner);
    expect(await events('invoice.voided', out.invoiceId)).toHaveLength(1);
  });
});

describe('what stays', () => {
  it('is an invoice with money on it', async () => {
    const out = await sent();
    await run(
      invoiceRecordCashPayment,
      { workspaceId: t.wsId, invoiceId: out.invoiceId, amountCents: 40_000 },
      t.owner,
    );
    expect((await preview(out.invoiceId)).rule).toBe('bin_invoice_paid');
    const err = await expectHfos(
      () => run(invoiceDelete, { workspaceId: t.wsId, invoiceIds: [out.invoiceId] }, t.owner),
      'bin_invoice_paid',
      409,
    );
    expect(err.message).toContain('refund the payment, then void it');
    // Nothing happened to it: not voided, not binned.
    const got = await ask(invoiceGet, { workspaceId: t.wsId, invoiceId: out.invoiceId }, t.owner);
    expect(got.invoice.status).toBe('partly_paid');
  });

  it('is a booking’s deposit still holding its time', async () => {
    const id = await draft('Deposit');
    await rows(admin(), sql`update app.invoices set origin = 'booking' where id = ${id}`);
    await expectHfos(
      () => run(invoiceDelete, { workspaceId: t.wsId, invoiceIds: [id] }, t.owner),
      'bin_invoice_deposit',
      409,
    );
    await rows(
      admin(),
      sql`update app.invoices set created_at = now() - interval '2 hours' where id = ${id}`,
    );
    await run(invoiceDelete, { workspaceId: t.wsId, invoiceIds: [id] }, t.owner);
  });
});
