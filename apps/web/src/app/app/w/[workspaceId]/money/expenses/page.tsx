import { EXPENSE_CATEGORY_IDS, EXPENSES_ONLY_MANAGERS, type ExpenseCategory } from '@hfos/core';
import type { Metadata } from 'next';
import { ExpensesView } from '@/components/money/expenses-view';
import { MoneyActions, MoneySubnav } from '@/components/money/subnav';
import { PageHeader } from '@/components/shell/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { unwrapPage } from '@/lib/api/server';
import { loadMoneyShell } from '../load';

export const metadata: Metadata = { title: 'Expenses' };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * What the business spent (20261027036800): each month's money in and out, what it went on, and the expenses with
 * their receipts. Only for whoever manages money; anyone else is told so.
 */
export default async function ExpensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const shell = await loadMoneyShell(workspaceId);
  const header = (
    <PageHeader
      title="Money"
      description="What you have quoted, what you are owed and what has come in."
      actions={shell.canBill ? <MoneyActions workspaceId={workspaceId} /> : undefined}
    />
  );
  if (!shell.canManage)
    return (
      <>
        {header}
        <MoneySubnav workspaceId={workspaceId} tab="expenses" />
        <EmptyState title="Expenses are for money managers">{EXPENSES_ONLY_MANAGERS}</EmptyState>
      </>
    );

  const askedMonth = one(sp['month']);
  const month = askedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(askedMonth) ? askedMonth : undefined;
  const query = one(sp['q'])?.trim().slice(0, 120) || undefined;
  const askedCategory = one(sp['category']);
  const category = (EXPENSE_CATEGORY_IDS as readonly string[]).includes(askedCategory ?? '')
    ? (askedCategory as ExpenseCategory)
    : undefined;
  const inOut = await shell.api
    .POST('/v1/queries/money.in_and_out', { body: { workspaceId, months: 6, month } })
    .then((r) => unwrapPage(r));
  const shown = inOut.breakdown.month;
  const list = await shell.api
    .POST('/v1/queries/expense.list', {
      body: { workspaceId, month: shown, query, category, limit: 50 },
    })
    .then((r) => unwrapPage(r));

  return (
    <>
      {header}
      <MoneySubnav workspaceId={workspaceId} tab="expenses" showExpenses />
      <ExpensesView
        workspaceId={workspaceId}
        inOut={inOut}
        initial={list}
        filters={{ month: shown, query: query ?? '', category: category ?? '' }}
      />
    </>
  );
}
