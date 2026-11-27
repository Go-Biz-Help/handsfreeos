/**
 * What the business spent (20261027036800; the owner, 25 Nov 2026: "I snap a receipt, it gets filed, and each month
 * I see money in and money out"). The categories and the ways it was paid, their words, and the month arithmetic the
 * web, the phone and the Assistant all show. Pure and browser-safe, like the rest of money/.
 */

import { monthOf } from './usage-keys';

/** The categories an expense goes under: plain words a small business and its accountant both read. */
export const EXPENSE_CATEGORIES = [
  { id: 'materials', label: 'Materials and supplies' },
  { id: 'tools', label: 'Tools and equipment' },
  { id: 'fuel', label: 'Gas and fuel' },
  { id: 'vehicle', label: 'Vehicle and repairs' },
  { id: 'subcontractors', label: 'Subcontractors and help' },
  { id: 'advertising', label: 'Advertising and marketing' },
  { id: 'meals', label: 'Meals' },
  { id: 'travel', label: 'Travel' },
  { id: 'phone', label: 'Phone and internet' },
  { id: 'software', label: 'Software and subscriptions' },
  { id: 'office', label: 'Office' },
  { id: 'rent', label: 'Rent' },
  { id: 'utilities', label: 'Utilities' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'licenses', label: 'Licenses, permits and fees' },
  { id: 'bank_fees', label: 'Bank and card fees' },
  { id: 'training', label: 'Training' },
  { id: 'other', label: 'Other' },
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]['id'];
export const EXPENSE_CATEGORY_IDS = EXPENSE_CATEGORIES.map((c) => c.id) as [
  ExpenseCategory,
  ...ExpenseCategory[],
];

/** How it was paid. */
export const EXPENSE_PAID_WITH = [
  { id: 'card', label: 'Card' },
  { id: 'cash', label: 'Cash' },
  { id: 'check', label: 'Check' },
  { id: 'bank', label: 'Bank transfer' },
  { id: 'other', label: 'Other' },
] as const;
export type ExpensePaidWith = (typeof EXPENSE_PAID_WITH)[number]['id'];
export const EXPENSE_PAID_WITH_IDS = EXPENSE_PAID_WITH.map((c) => c.id) as [
  ExpensePaidWith,
  ...ExpensePaidWith[],
];

/** The most one expense can be: $1 billion, as the table holds it. */
export const EXPENSE_MAX_CENTS = 100_000_000_000;
export const EXPENSE_VENDOR_MAX = 120;
export const EXPENSE_NOTE_MAX = 1000;
/** A receipt: a photo or a PDF, as big as any file. */
export const RECEIPT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;
export const RECEIPT_MAX_BYTES = 25 * 1024 * 1024;

export const expenseCategoryLabel = (id: string): string =>
  EXPENSE_CATEGORIES.find((c) => c.id === id)?.label ?? 'Other';
export const expensePaidWithLabel = (id: string | null | undefined): string | null =>
  id ? (EXPENSE_PAID_WITH.find((c) => c.id === id)?.label ?? null) : null;

/** "2026-11", the month a day falls in. */
export const monthOfDay = (day: string): string => day.slice(0, 7);

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "November 2026", or "November" when it's this year. */
export function monthLabel(month: string, thisYear?: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const name = MONTH_NAMES[m - 1] ?? month;
  return thisYear === y ? name : `${name} ${y}`;
}

/** The months from `last` back, newest first: ["2026-11", "2026-10", …]. */
export function monthsBack(last: string, count: number): string[] {
  const [y, m] = last.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** The first and last day of a month, for a query over it. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/**
 * "This month" in a time zone, as "2026-11". The wallet's month key works it out, through `intlTimeZone`, so a
 * device whose time-zone data lacks the business's zone still gets a month.
 */
export function monthNow(timeZone: string, now: Date = new Date()): string {
  return monthOf(now, timeZone);
}

export interface MonthInOut {
  readonly month: string;
  /** Payments that came in, less refunds that went back out. */
  readonly inCents: number;
  /** What the business spent. */
  readonly outCents: number;
}

/** What's left after spending: what came in less what went out (can be below zero). */
export const leftOf = (m: MonthInOut): number => m.inCents - m.outCents;

// ---- Money → Expenses, as the web and the phone show it ----

export const EXPENSES_TAB_LABEL = 'Expenses';
export const EXPENSES_DESCRIPTION =
  'What the business spent, with its receipts, and each month’s money in and money out.';
export const EXPENSES_ONLY_MANAGERS =
  'Only people who manage this business’s money see expenses. Ask an owner of this business if you need them.';
export const EXPENSES_EMPTY =
  'Nothing spent this month yet. Add an expense, or send the Assistant a photo of a receipt.';

export interface InOutFigure {
  readonly key: 'in' | 'out' | 'left';
  readonly value: string;
  readonly label: string;
  readonly sub: string;
  readonly tone?: 'good' | 'bad';
}

/** "$1,250.50", or "−$300.00" below zero. */
export const signedDollars = (cents: number): string =>
  `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** The three figures above a month's expenses: money in, money out, and what's left. */
export function inOutFigures(
  m: MonthInOut & { readonly expenseCount: number },
  thisMonth: string,
): readonly InOutFigure[] {
  const left = leftOf(m);
  const when = m.month === thisMonth ? 'this month' : `in ${monthLabel(m.month)}`;
  const count =
    m.expenseCount === 1 ? '1 expense' : `${m.expenseCount.toLocaleString('en-US')} expenses`;
  return [
    {
      key: 'in',
      value: signedDollars(m.inCents),
      label: 'Money in',
      sub: `Payments ${when}, less refunds`,
    },
    { key: 'out', value: signedDollars(m.outCents), label: 'Money out', sub: `${count} ${when}` },
    {
      key: 'left',
      value: signedDollars(left),
      label: 'What’s left',
      sub: left < 0 ? 'More went out than came in' : 'What came in, less what went out',
      ...(left < 0 ? { tone: 'bad' as const } : left > 0 ? { tone: 'good' as const } : {}),
    },
  ];
}
