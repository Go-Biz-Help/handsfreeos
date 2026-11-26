/**
 * Receipts and expenses (the owner, 25 Nov 2026: "I snap a receipt, it gets filed, and each month I see money in and
 * money out"). add_expense files one purchase on a card, with the photo or PDF of its receipt when one came with the
 * question. Listing them, changing one and the month's money in and out are the screens' own (screen-reads.ts,
 * coverage.ts); removing one is the person's.
 */
import { z } from 'zod';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_IDS,
  EXPENSE_MAX_CENTS,
  EXPENSE_NOTE_MAX,
  EXPENSE_PAID_WITH_IDS,
  EXPENSE_VENDOR_MAX,
} from '../money/expenses';
import { define, text, type AssistantTool } from './tool-kit';

const CATEGORY_WORDS = EXPENSE_CATEGORIES.map((c) => `${c.id} (${c.label})`).join(', ');

export const expenseTools: readonly AssistantTool[] = [
  define({
    name: 'add_expense',
    description: `File something the business spent, on a card: from a photo or PDF of a receipt they sent (read the store or supplier, the day, the total paid and the tax off it), or from what they tell you ("I spent $42 on gas at Shell today"). The receipt is kept with it. One card a receipt: for three receipts, three calls. Under Money → Expenses; only for people who manage money. Pick the category that fits best: ${CATEGORY_WORDS}.`,
    input: z.object({
      spentOn: z.iso.date().describe('The day on the receipt, YYYY-MM-DD; today when it has none'),
      amountCents: z
        .int()
        .min(1)
        .max(EXPENSE_MAX_CENTS)
        .describe('The whole amount paid, tax and tip in it, in cents: 4250 is $42.50'),
      taxCents: z
        .int()
        .min(0)
        .max(EXPENSE_MAX_CENTS)
        .optional()
        .describe('The tax in that amount, in cents, when the receipt shows it'),
      vendor: text(EXPENSE_VENDOR_MAX).describe(
        'Who it was paid to: the store, supplier or person',
      ),
      category: z.enum(EXPENSE_CATEGORY_IDS),
      paidWith: z
        .enum(EXPENSE_PAID_WITH_IDS)
        .optional()
        .describe(
          'How it was paid, when the receipt or they say: card, cash, check, bank or other',
        ),
      note: text(EXPENSE_NOTE_MAX)
        .optional()
        .describe('What it was for, in a few words: "Shingles for the Ortiz roof"'),
      receiptPicture: z
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe('The picture they sent that is this receipt, 1 for the first'),
      receiptFile: z
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe('Or the PDF they sent that is this receipt, 1 for the first'),
    }),
    autonomy: 'confirm',
    permission: 'money.manage',
  }),
];
