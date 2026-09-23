import type { Metadata } from 'next';
import { HeadlineStrip } from '@/components/money/headline-strip';
import { MoneyFilterBar } from '@/components/money/filters';
import { InvoicesList } from '@/components/money/invoices-list';
import {
  accountChoices,
  accountNames,
  INVOICE_STATUS_CHOICES,
  invoiceListBody,
  readFilters,
} from '@/components/money/list-options';
import { MoneyActions, MoneySubnav } from '@/components/money/subnav';
import { PageHeader } from '@/components/shell/page-header';
import { unwrapPage } from '@/lib/api/server';
import { COLLECTED_DAYS, loadAccounts, loadMoneyShell } from './load';

export const metadata: Metadata = { title: 'Money' };

const STATUSES = INVOICE_STATUS_CHOICES.map((s) => s.value);

/** Money's front door: the invoices, because what you are owed is what you came to look at. */
export default async function MoneyPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const filters = readFilters(await searchParams, { status: STATUSES, account: true });
  const shell = await loadMoneyShell(workspaceId);
  const [invoices, accounts] = await Promise.all([
    shell.api
      .POST('/v1/queries/invoice.list', { body: invoiceListBody(workspaceId, filters) })
      .then((r) => unwrapPage(r)),
    loadAccounts(shell.api, workspaceId, shell.canBill),
  ]);

  return (
    <>
      <PageHeader
        title="Money"
        description="What you have quoted, what you are owed and what has come in."
        actions={shell.canBill ? <MoneyActions workspaceId={workspaceId} /> : undefined}
      />
      {shell.summary ? (
        <HeadlineStrip summary={shell.summary} days={COLLECTED_DAYS} timeZone={shell.timeZone} />
      ) : null}
      <MoneySubnav workspaceId={workspaceId} tab="invoices">
        <MoneyFilterBar
          filters={filters}
          statuses={INVOICE_STATUS_CHOICES}
          accounts={accountChoices(accounts, filters.account)}
          searchLabel="Search invoices"
          count={invoices.invoices.length}
        />
      </MoneySubnav>
      <InvoicesList
        workspaceId={workspaceId}
        initial={invoices}
        filters={filters}
        canBill={shell.canBill}
        timeZone={shell.timeZone}
        now={shell.now}
        accountNames={accountNames(accounts)}
      />
    </>
  );
}
