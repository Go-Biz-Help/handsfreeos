/**
 * add_expense (core's tools-expenses.ts): one purchase filed on a card, with its receipt when a photo or a PDF of it
 * came with the question. What's sent is gone once the question is answered, so the receipt waits for Confirm in the
 * staging folder (housekeeping/assistant-staging.ts), named by the card. Confirm adds the expense as the person
 * (`expense.create`), reserves the receipt's place on it (`expense.begin_receipt_upload`), puts the receipt there and
 * confirms it (`file.confirm`): the same three steps Money → Expenses takes.
 */
import { expenseCategoryLabel, expensePaidWithLabel, HfosError, money } from '@hfos/core/server';
import { STAGING_BUCKET, stagedPath } from '../housekeeping/assistant-staging';
import type { ToolContext } from './runtime';
import { command, rehearse } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

const expensesPath = (ws: string) => `/app/w/${ws}/money/expenses`;

/** "Tue, Nov 24, 2026". */
const dayWords = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

interface Receipt {
  readonly bytes: Buffer;
  readonly kind: 'jpg' | 'pdf';
  readonly mimeType: 'image/jpeg' | 'application/pdf';
  readonly label: string;
}

/** The receipt the model pointed at, from what came with this question; null when it named none. */
function receiptOf(ctx: ToolContext, args: Args): Receipt | null {
  const picture = int(args['receiptPicture']);
  const file = int(args['receiptFile']);
  if (picture && file)
    throw HfosError.validation(
      [{ path: 'receiptFile', message: 'A picture or a PDF, one of them.' }],
      'The receipt is either a picture or a PDF they sent, one of them.',
    );
  if (picture) {
    const sent = ctx.pictures ?? [];
    const p = sent[picture - 1];
    if (!p)
      throw HfosError.validation(
        [{ path: 'receiptPicture', message: 'No such picture.' }],
        sent.length
          ? `Only ${sent.length === 1 ? 'one picture' : `${sent.length} pictures`} came with this question.`
          : 'No picture came with this question. Ask them to send a photo of the receipt.',
      );
    return {
      bytes: Buffer.from(p.data, 'base64'),
      kind: 'jpg',
      mimeType: 'image/jpeg',
      label: sent.length > 1 ? `Picture ${picture} they sent` : 'The picture they sent',
    };
  }
  if (file) {
    const f = (ctx.files ?? [])[file - 1];
    if (!f || f.kind !== 'pdf')
      throw HfosError.validation(
        [{ path: 'receiptFile', message: 'That isn’t a PDF they sent.' }],
        'That isn’t a PDF they sent with this question. A receipt is a picture or a PDF.',
      );
    return {
      bytes: Buffer.from(f.data, 'base64'),
      kind: 'pdf',
      mimeType: 'application/pdf',
      label: f.name,
    };
  }
  return null;
}

/** What expense.create takes, from the card's arguments. */
const expenseInput = (args: Args) => ({
  spentOn: String(args['spentOn']),
  amountCents: Number(args['amountCents']),
  ...(int(args['taxCents']) !== undefined ? { taxCents: int(args['taxCents']) } : {}),
  vendor: String(args['vendor'] ?? '').trim(),
  category: String(args['category']),
  ...(str(args['paidWith']) ? { paidWith: str(args['paidWith']) } : {}),
  ...(str(args['note']) ? { note: str(args['note']) } : {}),
});

const receiptGone = () =>
  HfosError.rule(
    'assistant_file_gone',
    410,
    'The receipt from that question isn’t kept anymore, so nothing was filed. Send the photo again with your question.',
  );
const filingUnavailable = () =>
  HfosError.rule(
    'receipt_filing_unavailable',
    503,
    'Receipts can’t be filed from the chat just now. Add it under Money → Expenses instead, or try again in a minute.',
  );

const addExpense: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId, deps) {
    const input = expenseInput(args);
    // Refused here, before a card, when they can't add one: money.manage, and what the command itself checks.
    await rehearse(db, ctx, 'expense.create', input);
    const receipt = receiptOf(ctx, args);
    if (receipt) {
      if (!deps?.services?.store) throw filingUnavailable();
      await deps.services.store.upload(
        STAGING_BUCKET,
        stagedPath(ctx.workspaceId, toolCallId, receipt.kind),
        receipt.bytes,
        receipt.mimeType,
        { upsert: true },
      );
    }
    const tax = int(args['taxCents']);
    return {
      card: settingsCard(toolCallId, 'add_expense', {
        title: `File ${money(input.amountCents)} at ${input.vendor}?`,
        fields: [
          { label: 'Paid to', value: input.vendor },
          {
            label: 'Amount',
            value: tax
              ? `${money(input.amountCents)}, ${money(tax)} of it tax`
              : money(input.amountCents),
          },
          { label: 'Day', value: dayWords(input.spentOn) },
          { label: 'Category', value: expenseCategoryLabel(input.category) },
          { label: 'Paid with', value: expensePaidWithLabel(str(args['paidWith'])) ?? '' },
          { label: 'Note', value: str(args['note']) ?? '' },
          { label: 'Receipt', value: receipt ? receipt.label : 'None' },
        ],
        confirmLabel: 'File it',
        warnings: [
          {
            kind: 'note',
            text: 'Check the amount and day against the receipt. It goes under Money → Expenses, in this month’s money out.',
          },
        ],
      }),
      result: {
        waiting: true,
        ...input,
        receipt: receipt ? receipt.label : null,
      },
    };
  },
  async commit(db, ctx, args, extra) {
    const picture = int(args['receiptPicture']);
    const file = int(args['receiptFile']);
    const kind = picture ? 'jpg' : file ? 'pdf' : null;
    const s = extra.services ?? null;
    const staged = kind ? stagedPath(ctx.workspaceId, extra.toolCallId, kind) : null;
    let bytes: Buffer | null = null;
    if (staged) {
      if (!s) throw filingUnavailable();
      bytes = await s.store.download(STAGING_BUCKET, staged).catch(() => null);
      if (!bytes) throw receiptGone();
    }
    try {
      const input = expenseInput(args);
      const { expenseId } = await command<{ expenseId: string }>(db, ctx, 'expense.create', input);
      if (bytes && s && kind) {
        const mimeType = kind === 'pdf' ? 'application/pdf' : 'image/jpeg';
        const name = `Receipt ${input.vendor
          .replace(/[\\/:*?"<>|]+/g, ' ')
          .trim()
          .slice(0, 80)} ${input.spentOn}.${kind}`;
        const begun = await command<{ fileId: string; bucket: string; objectPath: string }>(
          db,
          ctx,
          'expense.begin_receipt_upload',
          { expenseId, name, mimeType, sizeBytes: bytes.length },
        );
        await s.store.upload(begun.bucket, begun.objectPath, bytes, mimeType);
        await command(db, ctx, 'file.confirm', { fileId: begun.fileId });
      }
      return {
        outcome: `Filed ${money(input.amountCents)} at ${input.vendor} under ${expenseCategoryLabel(input.category)}${bytes ? ', with the receipt' : ''}.`,
        href: expensesPath(ctx.workspaceId),
        command: 'expense.create',
        answer: { expenseId },
      };
    } finally {
      if (staged && s) await s.store.remove(STAGING_BUCKET, staged).catch(() => undefined);
    }
  },
};

export const expenseConfirmTools: Record<string, SettingsConfirmTool> = {
  add_expense: addExpense,
};

export const expenseStepLabels = { add_expense: 'Getting the expense ready' } as const;
