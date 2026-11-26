/**
 * What the business spent (20261027036800, money/expenses.ts), and each month's money in and out. Only whoever manages
 * money: RLS shows expenses to nobody else, and money in is the whole business's, which the member rule withholds.
 */
import { z } from 'zod';
import { rows, sql } from '@hfos/db/client';
import { workspaceTimezone } from '../crm/records';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { decodeCursor, encodeCursor } from '../kernel/pagination';
import {
  EXPENSE_CATEGORY_IDS,
  EXPENSE_PAID_WITH_IDS,
  expenseCategoryLabel,
  monthBounds,
  monthNow,
  monthsBack,
} from '../money/expenses';
import { isoDateTime, uuid } from '../schemas/common';
import { localDate } from '../schemas/money';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month is written like 2026-11.');

export const ExpenseListInput = z.object({
  workspaceId: uuid,
  /** One month, like "2026-11". Or a range of days with from and to. */
  month: month.optional(),
  from: localDate.optional(),
  to: localDate.optional(),
  category: z.enum(EXPENSE_CATEGORY_IDS).optional(),
  /** Words in who it was paid to or the note. */
  query: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(400).optional(),
});
export const ExpenseRow = z.object({
  id: uuid,
  spentOn: localDate,
  amountCents: z.number(),
  taxCents: z.number().nullable(),
  vendor: z.string(),
  category: z.enum(EXPENSE_CATEGORY_IDS).or(z.string()),
  categoryLabel: z.string(),
  paidWith: z.enum(EXPENSE_PAID_WITH_IDS).or(z.string()).nullable(),
  note: z.string().nullable(),
  source: z.enum(['person', 'assistant']).or(z.string()),
  /** The newest receipt, a photo or a PDF in the attachments bucket. */
  receipt: z
    .object({
      fileId: uuid,
      name: z.string(),
      mimeType: z.string().nullable(),
      bucket: z.string(),
      objectPath: z.string(),
    })
    .nullable(),
  createdBy: z.object({ id: uuid, name: z.string() }).nullable(),
  createdAt: isoDateTime,
});
export type ExpenseRow = z.infer<typeof ExpenseRow>;
export const ExpenseListOutput = z.object({
  expenses: z.array(ExpenseRow),
  /** Every expense the filters match, not only this page. */
  count: z.number().int(),
  totalCents: z.number(),
  nextCursor: z.string().nullable(),
});

export const MoneyInAndOutInput = z.object({
  workspaceId: uuid,
  /** How many months, this one first. */
  months: z.number().int().min(1).max(24).default(6),
  /** The month to break down by category; this month when left out. */
  month: month.optional(),
});
export const MoneyInAndOutOutput = z.object({
  timeZone: z.string(),
  /** This month, in the business's time zone. */
  thisMonth: month,
  months: z.array(
    z.object({
      month,
      /** Payments that came in, less refunds that went back out. */
      inCents: z.number(),
      outCents: z.number(),
      expenseCount: z.number().int(),
    }),
  ),
  /** The month broken down: what was spent on what, biggest first. */
  breakdown: z.object({
    month,
    inCents: z.number(),
    outCents: z.number(),
    categories: z.array(
      z.object({
        category: z.string(),
        label: z.string(),
        cents: z.number(),
        count: z.number().int(),
      }),
    ),
  }),
});

/** The list's cursor: the day, then when it was added, then its id, as the list is ordered. */
function cursorAfter(cursor: string | undefined) {
  const c = decodeCursor(cursor);
  if (!c) return sql``;
  const m = /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/.exec(c.sort);
  if (!m || !/^[0-9a-f-]{36}$/.test(c.id))
    throw HfosError.validation(
      [{ path: 'cursor', message: 'That page isn’t there anymore.' }],
      'The list changed since that page. Start again from the top.',
    );
  return sql`and (e.spent_on, e.created_at, e.id) < (${m[1]}::date, ${m[2]}::timestamptz, ${c.id}::uuid)`;
}

export const expenseList = defineQuery({
  name: 'expense.list',
  description:
    'What the business spent, newest day first: each one’s day, amount, tax, who it was paid to, category, how it was paid, note and receipt. One month, a range of days, a category or words; with the count and total of every one that matches.',
  input: ExpenseListInput,
  output: ExpenseListOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const range = input.month ? monthBounds(input.month) : { from: input.from, to: input.to };
    const words = input.query ? `%${input.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = sql`e.workspace_id = ${ws} and e.deleted_at is null
      ${range.from ? sql`and e.spent_on >= ${range.from}::date` : sql``}
      ${range.to ? sql`and e.spent_on <= ${range.to}::date` : sql``}
      ${input.category ? sql`and e.category = ${input.category}` : sql``}
      ${words ? sql`and (e.vendor ilike ${words} or coalesce(e.note, '') ilike ${words})` : sql``}`;
    const [list, [sum]] = await Promise.all([
      rows<{
        id: string;
        spent_on: string;
        amount_cents: number;
        tax_cents: number | null;
        vendor: string;
        category: string;
        paid_with: string | null;
        note: string | null;
        source: string;
        created_at: string;
        sort_key: string;
        created_by: string | null;
        created_by_name: string | null;
        file_id: string | null;
        file_name: string | null;
        file_mime: string | null;
        file_bucket: string | null;
        file_path: string | null;
      }>(
        ctx.tx,
        sql`select e.id, to_char(e.spent_on, 'YYYY-MM-DD') as spent_on, e.amount_cents::float8 as amount_cents,
              e.tax_cents::float8 as tax_cents, e.vendor, e.category, e.paid_with, e.note, e.source,
              to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
              to_char(e.spent_on, 'YYYY-MM-DD') || '|' ||
                to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key,
              e.created_by, coalesce(nullif(u.full_name, ''), u.email::text) as created_by_name,
              f.id as file_id, f.name as file_name, f.mime_type as file_mime, f.bucket as file_bucket,
              f.object_path as file_path
            from app.expenses e
            left join app.users u on u.id = e.created_by
            left join lateral (
              select f.id, f.name, f.mime_type, f.bucket, f.object_path from app.files f
              where f.workspace_id = e.workspace_id and f.record_type = 'expense' and f.record_id = e.id
                and f.status = 'ready' and f.deleted_at is null
              order by f.created_at desc limit 1) f on true
            where ${where} ${cursorAfter(input.cursor)}
            order by e.spent_on desc, e.created_at desc, e.id desc
            limit ${input.limit + 1}`,
      ),
      rows<{ n: number; cents: number }>(
        ctx.tx,
        sql`select count(*)::int as n, coalesce(sum(e.amount_cents), 0)::float8 as cents
            from app.expenses e where ${where}`,
      ),
    ]);
    const more = list.length > input.limit;
    const items = more ? list.slice(0, input.limit) : list;
    const last = items[items.length - 1];
    return {
      expenses: items.map((r) => ({
        id: r.id,
        spentOn: r.spent_on,
        amountCents: Number(r.amount_cents),
        taxCents: r.tax_cents == null ? null : Number(r.tax_cents),
        vendor: r.vendor,
        category: r.category,
        categoryLabel: expenseCategoryLabel(r.category),
        paidWith: r.paid_with,
        note: r.note,
        source: r.source,
        receipt:
          r.file_id && r.file_bucket && r.file_path
            ? {
                fileId: r.file_id,
                name: r.file_name ?? 'Receipt',
                mimeType: r.file_mime,
                bucket: r.file_bucket,
                objectPath: r.file_path,
              }
            : null,
        createdBy: r.created_by ? { id: r.created_by, name: r.created_by_name ?? 'Someone' } : null,
        createdAt: r.created_at,
      })),
      count: Number(sum?.n ?? 0),
      totalCents: Number(sum?.cents ?? 0),
      nextCursor: more && last ? encodeCursor({ sort: last.sort_key, id: last.id }) : null,
    };
  },
});

export const moneyInAndOut = defineQuery({
  name: 'money.in_and_out',
  description:
    'Each month’s money in (payments, less refunds) and money out (expenses), this month first, in the business’s time zone; and one month’s spending by category.',
  input: MoneyInAndOutInput,
  output: MoneyInAndOutOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const timeZone = await workspaceTimezone(ctx.tx, ws);
    const thisMonth = monthNow(timeZone);
    const months = monthsBack(thisMonth, input.months);
    const oldest = monthBounds(months[months.length - 1]!).from;
    const asked = input.month ?? thisMonth;
    const span = (m: string) => (m < oldest.slice(0, 7) ? monthBounds(m).from : oldest);
    const from = span(asked);
    const [ins, outs, cats] = await Promise.all([
      rows<{ month: string; cents: number }>(
        ctx.tx,
        sql`select m.month, sum(m.cents)::float8 as cents from (
              select to_char(p.received_at at time zone ${timeZone}, 'YYYY-MM') as month, p.amount_cents as cents
              from app.payments p
              where p.workspace_id = ${ws} and p.status = 'succeeded'
                and p.received_at >= (${from}::date::timestamp at time zone ${timeZone})
              union all
              select to_char(r.refunded_at at time zone ${timeZone}, 'YYYY-MM'), -r.amount_cents
              from app.refunds r
              where r.workspace_id = ${ws} and r.status = 'succeeded'
                and r.refunded_at >= (${from}::date::timestamp at time zone ${timeZone})) m
            group by m.month`,
      ),
      rows<{ month: string; cents: number; n: number }>(
        ctx.tx,
        sql`select to_char(e.spent_on, 'YYYY-MM') as month, sum(e.amount_cents)::float8 as cents,
              count(*)::int as n
            from app.expenses e
            where e.workspace_id = ${ws} and e.deleted_at is null and e.spent_on >= ${from}::date
            group by 1`,
      ),
      rows<{ category: string; cents: number; n: number }>(
        ctx.tx,
        sql`select e.category, sum(e.amount_cents)::float8 as cents, count(*)::int as n
            from app.expenses e
            where e.workspace_id = ${ws} and e.deleted_at is null
              and e.spent_on between ${monthBounds(asked).from}::date and ${monthBounds(asked).to}::date
            group by e.category
            order by 2 desc, 1`,
      ),
    ]);
    const inOf = (m: string) => Number(ins.find((r) => r.month === m)?.cents ?? 0);
    const outOf = (m: string) => outs.find((r) => r.month === m);
    return {
      timeZone,
      thisMonth,
      months: months.map((m) => ({
        month: m,
        inCents: inOf(m),
        outCents: Number(outOf(m)?.cents ?? 0),
        expenseCount: Number(outOf(m)?.n ?? 0),
      })),
      breakdown: {
        month: asked,
        inCents: inOf(asked),
        outCents: Number(outOf(asked)?.cents ?? 0),
        categories: cats.map((c) => ({
          category: c.category,
          label: expenseCategoryLabel(c.category),
          cents: Number(c.cents),
          count: Number(c.n),
        })),
      },
    };
  },
});

export const expenseQueries = [expenseList, moneyInAndOut] as const;
