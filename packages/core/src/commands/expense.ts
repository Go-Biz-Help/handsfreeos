/**
 * What the business spent (20261027036800, money/expenses.ts): add one, change it, remove it, and reserve a place for
 * its receipt. Only whoever manages money: RLS shows them to nobody else, and the kernel refuses everyone else first.
 *
 * A receipt is a file whose record is its expense (record type `expense`): reserved here, uploaded straight to
 * Storage, and confirmed with `file.confirm`, which keeps only the newest one.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { expenses, files } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  EXPENSE_CATEGORY_IDS,
  EXPENSE_MAX_CENTS,
  EXPENSE_NOTE_MAX,
  EXPENSE_PAID_WITH_IDS,
  EXPENSE_VENDOR_MAX,
  RECEIPT_MAX_BYTES,
  RECEIPT_TYPES,
} from '../money/expenses';
import { money } from '../money/format';
import { localDate } from '../schemas/money';
import { uuid } from '../schemas/common';
import { replaceReceipts, storedFilePath } from './file';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const amount = z
  .number()
  .int()
  .min(1, 'Say how much it was.')
  .max(EXPENSE_MAX_CENTS, 'That’s more than one expense can be. Check the amount.');
const vendor = z
  .string()
  .trim()
  .min(1, 'Say who it was paid to: the store, supplier or person.')
  .max(EXPENSE_VENDOR_MAX, `Keep who it was paid to under ${EXPENSE_VENDOR_MAX} characters.`);
const note = z
  .string()
  .trim()
  .max(EXPENSE_NOTE_MAX, `Keep the note under ${EXPENSE_NOTE_MAX} characters.`);

export const ExpenseCreateInput = z.object({
  workspaceId: uuid,
  /** The day on the receipt. */
  spentOn: localDate,
  /** The whole amount paid, tax and tip in it, in cents. */
  amountCents: amount,
  /** The tax in that amount, when the receipt says. */
  taxCents: z.number().int().min(0).nullable().optional(),
  vendor,
  category: z.enum(EXPENSE_CATEGORY_IDS),
  paidWith: z.enum(EXPENSE_PAID_WITH_IDS).nullable().optional(),
  note: note.nullable().optional(),
});
export const ExpenseOutput = z.object({ expenseId: uuid });

export const ExpenseUpdateInput = z.object({
  workspaceId: uuid,
  expenseId: uuid,
  spentOn: localDate.optional(),
  amountCents: amount.optional(),
  taxCents: z.number().int().min(0).nullable().optional(),
  vendor: vendor.optional(),
  category: z.enum(EXPENSE_CATEGORY_IDS).optional(),
  paidWith: z.enum(EXPENSE_PAID_WITH_IDS).nullable().optional(),
  note: note.nullable().optional(),
});
export const ExpenseDeleteInput = z.object({ workspaceId: uuid, expenseId: uuid });

export const ExpenseBeginReceiptUploadInput = z.object({
  workspaceId: uuid,
  expenseId: uuid,
  name: z.string().trim().min(1).max(200),
  mimeType: z.enum(RECEIPT_TYPES, {
    error: 'A receipt is a photo (JPEG, PNG, WebP or HEIC) or a PDF.',
  }),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(RECEIPT_MAX_BYTES, 'A receipt can be up to 25 MB. Take the photo again a little smaller.'),
});
export const ExpenseBeginReceiptUploadOutput = z.object({
  fileId: uuid,
  bucket: z.string(),
  objectPath: z.string(),
});

const gone = () =>
  HfosError.notFound(
    'That expense isn’t there anymore. Someone may have removed it. Refresh and try again.',
  );

function checkTax(amountCents: number, taxCents: number | null | undefined): void {
  if (taxCents != null && taxCents > amountCents)
    throw HfosError.validation(
      [{ path: 'taxCents', message: 'The tax is more than the whole amount.' }],
      `The tax (${money(taxCents)}) is more than the whole amount (${money(amountCents)}). The amount is everything paid, tax in it.`,
    );
}

async function loadExpense(ctx: CommandContext, expenseId: string) {
  const [row] = await ctx.tx
    .select()
    .from(expenses)
    .where(
      and(
        eq(expenses.id, expenseId),
        eq(expenses.workspaceId, ctx.scope.workspaceId!),
        isNull(expenses.deletedAt),
      ),
    )
    .for('update');
  if (!row) throw gone();
  return row;
}

export const expenseCreate = defineCommand({
  name: 'expense.create',
  description:
    'Add something the business spent: the day, the whole amount (tax in it), who it was paid to, a category, how it was paid and a note. Add its receipt with expense.begin_receipt_upload.',
  risk: 1,
  input: ExpenseCreateInput,
  output: ExpenseOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['expense.changed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    checkTax(input.amountCents, input.taxCents);
    const [row] = await ctx.tx
      .insert(expenses)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        spentOn: input.spentOn,
        amountCents: input.amountCents,
        taxCents: input.taxCents ?? null,
        vendor: input.vendor,
        category: input.category,
        paidWith: input.paidWith ?? null,
        note: input.note || null,
        source: ctx.meta.channel === 'assistant' ? 'assistant' : 'person',
        createdBy: me,
      })
      .returning({ id: expenses.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'expense.changed',
      entityType: 'expense',
      entityId: row.id,
      payload: { change: 'added' },
      after: { vendor: input.vendor, amountCents: input.amountCents, spentOn: input.spentOn },
    });
    return { expenseId: row.id };
  },
});

export const expenseUpdate = defineCommand({
  name: 'expense.update',
  description:
    'Change an expense: its day, amount, tax, who it was paid to, category, how it was paid or note. Only what is given changes.',
  risk: 1,
  input: ExpenseUpdateInput,
  output: ExpenseOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['expense.changed'],
  async handler(ctx, input) {
    const current = await loadExpense(ctx, input.expenseId);
    const next = {
      spentOn: input.spentOn ?? current.spentOn,
      amountCents: input.amountCents ?? current.amountCents,
      taxCents: input.taxCents === undefined ? current.taxCents : input.taxCents,
      vendor: input.vendor ?? current.vendor,
      category: input.category ?? current.category,
      paidWith: input.paidWith === undefined ? current.paidWith : input.paidWith,
      note: input.note === undefined ? current.note : input.note || null,
    };
    checkTax(next.amountCents, next.taxCents);
    await ctx.tx.update(expenses).set(next).where(eq(expenses.id, current.id));
    await ctx.emit({
      type: 'expense.changed',
      entityType: 'expense',
      entityId: current.id,
      payload: { change: 'changed' },
      before: {
        vendor: current.vendor,
        amountCents: current.amountCents,
        spentOn: current.spentOn,
        category: current.category,
      },
      after: {
        vendor: next.vendor,
        amountCents: next.amountCents,
        spentOn: next.spentOn,
        category: next.category,
      },
    });
    return { expenseId: current.id };
  },
});

export const expenseDelete = defineCommand({
  name: 'expense.delete',
  description:
    'Remove an expense, and delete its receipt. It isn’t counted in money out again, and can’t be brought back.',
  risk: 2,
  input: ExpenseDeleteInput,
  output: ExpenseOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['expense.changed', 'file.deleted'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const current = await loadExpense(ctx, input.expenseId);
    await ctx.tx
      .update(expenses)
      .set({ deletedAt: new Date(), deletedBy: me })
      .where(eq(expenses.id, current.id));
    await replaceReceipts(ctx, current.id, null);
    await ctx.emit({
      type: 'expense.changed',
      entityType: 'expense',
      entityId: current.id,
      payload: { change: 'removed' },
      before: {
        vendor: current.vendor,
        amountCents: current.amountCents,
        spentOn: current.spentOn,
      },
      after: null,
    });
    return { expenseId: current.id };
  },
});

export const expenseBeginReceiptUpload = defineCommand({
  name: 'expense.begin_receipt_upload',
  description:
    'Reserve a place for an expense’s receipt, a photo or a PDF (25 MB at most). Upload it to the returned path, then confirm it with file.confirm; it takes the place of the receipt before.',
  risk: 1,
  input: ExpenseBeginReceiptUploadInput,
  output: ExpenseBeginReceiptUploadOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    const expense = await loadExpense(ctx, input.expenseId);
    const fileId = randomUUID();
    // The file belongs to the expense, not to a customer: its record is the expense.
    const objectPath = storedFilePath(ws, 'expense', expense.id, fileId, input.name);
    const [f] = await ctx.tx
      .insert(files)
      .values({
        id: fileId,
        workspaceId: ws,
        recordType: 'expense',
        recordId: expense.id,
        bucket: 'attachments',
        objectPath,
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        createdBy: me,
      })
      .returning({ id: files.id });
    if (!f) throw HfosError.forbidden();
    return { fileId, bucket: 'attachments', objectPath };
  },
});

export const expenseCommands = [
  expenseCreate,
  expenseUpdate,
  expenseDelete,
  expenseBeginReceiptUpload,
] as const;
