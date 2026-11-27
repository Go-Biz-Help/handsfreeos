/**
 * Receipts and expenses (20261027036800; the owner, 25 Nov 2026: "I snap a receipt, it gets filed, and each month I
 * see money in and money out"), on the local database:
 * - **The words and month arithmetic** the web, the phone and the Assistant all show.
 * - **expense.create / update / delete**, only for whoever manages money; the tax is never more than the amount.
 * - **expense.list** pages by day, filters by month, category and words, and counts and totals every match.
 * - **A receipt** is reserved, uploaded and confirmed like any file; a new one takes the old one's place, and a member
 *   sees neither the row nor the stored photo.
 * - **money.in_and_out**: payments in less refunds, and expenses out, by month in the business's time zone.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { events, people, workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  expenseCategoryLabel,
  leftOf,
  monthBounds,
  monthLabel,
  monthNow,
  monthsBack,
} from '../src/money/expenses';
import {
  expenseBeginReceiptUpload,
  expenseCreate,
  expenseDelete,
  expenseList,
  expenseUpdate,
  fileConfirm,
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  moneyInAndOut,
  organizationCreate,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'web' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output as z.infer<O>);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta()) as Promise<z.infer<O>>;

async function refused(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect([err.rule, err.code]).toContain(code);
    return err;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

/** Stands in for the browser's upload: the object as Storage records it. */
const putObject = (path: string, size: number, mimetype: string) =>
  rows(
    admin(),
    sql`insert into storage.objects (bucket_id, name, metadata)
        values ('attachments', ${path}, ${JSON.stringify({ size, mimetype })}::jsonb)`,
  );

describe('the words and the months', () => {
  it('names categories and months as people read them', () => {
    expect(expenseCategoryLabel('fuel')).toBe('Gas and fuel');
    expect(expenseCategoryLabel('made_up')).toBe('Other');
    expect(monthLabel('2026-11', 2026)).toBe('November');
    expect(monthLabel('2025-12', 2026)).toBe('December 2025');
    expect(monthsBack('2026-02', 4)).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    // Just after midnight UTC on the 1st is still the month before in Texas.
    expect(monthNow('America/Chicago', new Date('2026-12-01T03:00:00Z'))).toBe('2026-11');
    expect(leftOf({ month: '2026-11', inCents: 500, outCents: 800 })).toBe(-300);
  });
});

describe('what the business spent', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  let personId: string;
  const thisMonth = monthNow('America/Chicago');
  const lastMonth = monthsBack(thisMonth, 2)[1]!;
  const day = (month: string, d: number) => `${month}-${String(d).padStart(2, '0')}`;

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('expense-owner'),
      createTestUser('expense-member'),
    ]);
    const made = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Lone Star HVAC & Roofing', timezone: 'America/Chicago' },
      human(owner),
      meta(),
    );
    ws = made.output.workspaceId;
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    const [p] = await admin()
      .insert(people)
      .values({ workspaceId: ws, firstName: 'Bob', lastName: 'Ortiz' })
      .returning({ id: people.id });
    personId = p!.id;
  });

  afterAll(closeTestDbs);

  it('adds, changes and lists them, newest day first, with a total of every match', async () => {
    const gas = await run(
      expenseCreate,
      {
        workspaceId: ws,
        spentOn: day(thisMonth, 2),
        amountCents: 4_250,
        vendor: 'Shell',
        category: 'fuel',
        paidWith: 'card',
      },
      owner,
    );
    await run(
      expenseCreate,
      {
        workspaceId: ws,
        spentOn: day(thisMonth, 1),
        amountCents: 32_018,
        taxCents: 2_418,
        vendor: 'ABC Supply',
        category: 'materials',
        note: 'Shingles for the Ortiz roof',
      },
      owner,
    );
    await run(
      expenseCreate,
      {
        workspaceId: ws,
        spentOn: day(lastMonth, 20),
        amountCents: 9_900,
        vendor: 'Google',
        category: 'advertising',
      },
      owner,
    );

    const page1 = await ask(expenseList, { workspaceId: ws, limit: 2 }, owner);
    expect(page1.expenses.map((e) => e.vendor)).toEqual(['Shell', 'ABC Supply']);
    expect(page1.count).toBe(3);
    expect(page1.totalCents).toBe(46_168);
    expect(page1.expenses[0]).toMatchObject({
      categoryLabel: 'Gas and fuel',
      paidWith: 'card',
      source: 'person',
      receipt: null,
      createdBy: { id: owner.id },
    });
    const page2 = await ask(
      expenseList,
      { workspaceId: ws, limit: 2, cursor: page1.nextCursor },
      owner,
    );
    expect(page2.expenses.map((e) => e.vendor)).toEqual(['Google']);
    expect(page2.nextCursor).toBeNull();

    const month = await ask(expenseList, { workspaceId: ws, month: thisMonth }, owner);
    expect(month.count).toBe(2);
    expect(month.totalCents).toBe(36_268);
    const words = await ask(expenseList, { workspaceId: ws, query: 'ortiz' }, owner);
    expect(words.expenses.map((e) => e.vendor)).toEqual(['ABC Supply']);
    const ads = await ask(expenseList, { workspaceId: ws, category: 'advertising' }, owner);
    expect(ads.expenses.map((e) => e.vendor)).toEqual(['Google']);

    await run(
      expenseUpdate,
      { workspaceId: ws, expenseId: gas.expenseId, amountCents: 4_500, note: 'Truck' },
      owner,
    );
    const after = await ask(expenseList, { workspaceId: ws, query: 'shell' }, owner);
    expect(after.expenses[0]).toMatchObject({ amountCents: 4_500, note: 'Truck', vendor: 'Shell' });

    const told = await admin()
      .select({ type: events.eventType, payload: events.payload })
      .from(events)
      .where(and(eq(events.workspaceId, ws), eq(events.entityId, gas.expenseId)));
    expect(told.map((e) => (e.payload as { change: string }).change).sort()).toEqual([
      'added',
      'changed',
    ]);
  });

  it('never takes more tax than the whole amount', async () => {
    const err = await refused(
      () =>
        run(
          expenseCreate,
          {
            workspaceId: ws,
            spentOn: day(thisMonth, 3),
            amountCents: 1_000,
            taxCents: 2_000,
            vendor: 'Lowe’s',
            category: 'materials',
          },
          owner,
        ),
      'validation',
    );
    expect(err.message).toContain('more than the whole amount');
  });

  it('is only for whoever manages money', async () => {
    await refused(
      () =>
        run(
          expenseCreate,
          {
            workspaceId: ws,
            spentOn: day(thisMonth, 3),
            amountCents: 1_000,
            vendor: 'Lowe’s',
            category: 'materials',
          },
          member,
        ),
      'forbidden',
    );
    await refused(() => ask(expenseList, { workspaceId: ws }, member), 'forbidden');
    await refused(() => ask(moneyInAndOut, { workspaceId: ws }, member), 'forbidden');
    // And the table itself shows a member nothing.
    const seen = await asUser(api(), member.claims, (tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from app.expenses where workspace_id = ${ws}`,
      ),
    );
    expect(seen[0]!.n).toBe(0);
  });

  it('keeps one receipt on an expense, only for whoever manages money', async () => {
    const { expenseId } = await run(
      expenseCreate,
      {
        workspaceId: ws,
        spentOn: day(thisMonth, 4),
        amountCents: 2_599,
        vendor: 'Home Depot',
        category: 'tools',
      },
      owner,
    );
    const first = await run(
      expenseBeginReceiptUpload,
      { workspaceId: ws, expenseId, name: 'receipt.jpg', mimeType: 'image/jpeg', sizeBytes: 900 },
      owner,
    );
    expect(first.objectPath).toBe(`${ws}/expense/${expenseId}/${first.fileId}/receipt.jpg`);
    await refused(
      () => run(fileConfirm, { workspaceId: ws, fileId: first.fileId }, owner),
      'file_not_uploaded',
    );
    // A member may neither reserve a receipt's place nor upload into one.
    await refused(
      () =>
        run(
          expenseBeginReceiptUpload,
          { workspaceId: ws, expenseId, name: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 10 },
          member,
        ),
      'forbidden',
    );
    const memberUpload = await asUser(api(), member.claims, (tx) =>
      rows<{ ok: boolean }>(
        tx,
        sql`select private.storage_upload_allowed('attachments', ${first.objectPath}) as ok`,
      ),
    );
    expect(memberUpload[0]!.ok).toBe(false);

    await putObject(first.objectPath, 900, 'image/jpeg');
    await run(fileConfirm, { workspaceId: ws, fileId: first.fileId }, owner);
    const listed = await ask(expenseList, { workspaceId: ws, query: 'home depot' }, owner);
    expect(listed.expenses[0]!.receipt).toMatchObject({
      fileId: first.fileId,
      name: 'receipt.jpg',
      mimeType: 'image/jpeg',
    });

    // Who may read the stored photo: the owner, never a member.
    const canRead = (u: TestUser) =>
      asUser(api(), u.claims, (tx) =>
        rows<{ ok: boolean }>(
          tx,
          sql`select private.storage_read_allowed('attachments', ${first.objectPath}) as ok`,
        ),
      ).then((r) => r[0]!.ok);
    expect(await canRead(owner)).toBe(true);
    expect(await canRead(member)).toBe(false);
    const memberFiles = await asUser(api(), member.claims, (tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from app.files where record_id = ${expenseId}::uuid`,
      ),
    );
    expect(memberFiles[0]!.n).toBe(0);
    // A receipt is never tagged.
    const check = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from pg_constraint where conname = 'record_tags_not_expense'`,
    );
    expect(check[0]!.n).toBe(1);

    // A second receipt takes the first one's place, and the worker is told to delete the first.
    const second = await run(
      expenseBeginReceiptUpload,
      {
        workspaceId: ws,
        expenseId,
        name: 'clearer.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1200,
      },
      owner,
    );
    await putObject(second.objectPath, 1200, 'application/pdf');
    await run(fileConfirm, { workspaceId: ws, fileId: second.fileId }, owner);
    const again = await ask(expenseList, { workspaceId: ws, query: 'home depot' }, owner);
    expect(again.expenses[0]!.receipt).toMatchObject({
      fileId: second.fileId,
      name: 'clearer.pdf',
    });
    const deleted = await admin()
      .select({ id: events.entityId })
      .from(events)
      .where(and(eq(events.workspaceId, ws), eq(events.eventType, 'file.deleted')));
    expect(deleted.map((d) => d.id)).toContain(first.fileId);

    // Removing the expense takes its receipt with it, and it's never listed again.
    await run(expenseDelete, { workspaceId: ws, expenseId }, owner);
    const gone = await ask(expenseList, { workspaceId: ws, query: 'home depot' }, owner);
    expect(gone.count).toBe(0);
    const deletedNow = await admin()
      .select({ id: events.entityId })
      .from(events)
      .where(and(eq(events.workspaceId, ws), eq(events.eventType, 'file.deleted')));
    expect(deletedNow.map((d) => d.id)).toContain(second.fileId);
    await refused(
      () => run(expenseUpdate, { workspaceId: ws, expenseId, amountCents: 1 }, owner),
      'not_found',
    );
  });

  it('adds up each month’s money in and money out, and what was spent on what', async () => {
    const inv = await run(
      invoiceCreate,
      {
        workspaceId: ws,
        personId,
        title: 'Roof repair',
        lines: [{ name: 'Repair', quantity: 1, unitPriceCents: 150_000, taxable: false }],
      },
      owner,
    );
    await run(invoiceSend, { workspaceId: ws, invoiceId: inv.invoiceId }, owner);
    await run(
      invoiceRecordCashPayment,
      { workspaceId: ws, invoiceId: inv.invoiceId, amountCents: 150_000, receipt: false },
      owner,
    );
    const out = await ask(moneyInAndOut, { workspaceId: ws, months: 3 }, owner);
    expect(out.thisMonth).toBe(thisMonth);
    expect(out.months.map((m) => m.month)).toEqual(monthsBack(thisMonth, 3));
    expect(out.months[0]).toMatchObject({ inCents: 150_000, outCents: 36_518, expenseCount: 2 });
    expect(out.months[1]).toMatchObject({ inCents: 0, outCents: 9_900, expenseCount: 1 });
    expect(out.breakdown.categories).toEqual([
      { category: 'materials', label: 'Materials and supplies', cents: 32_018, count: 1 },
      { category: 'fuel', label: 'Gas and fuel', cents: 4_500, count: 1 },
    ]);
    const before = await ask(moneyInAndOut, { workspaceId: ws, month: lastMonth }, owner);
    expect(before.breakdown).toMatchObject({ month: lastMonth, outCents: 9_900 });
  });
});
