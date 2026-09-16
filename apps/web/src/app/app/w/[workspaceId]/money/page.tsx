import type { Metadata } from 'next';
import { HeadlineStrip } from '@/components/money/headline-strip';
import { MoneyFilterBar } from '@/components/money/filters';
import { InvoicesList } from '@/components/money/invoices-list';
import {
  INVOICE_STATUS_CHOICES,
  invoiceListBody,
  readFilters,
} from '@/components/money/list-options';
import { MoneyActions, MoneySubnav } from '@/components/money/subnav';
import { PageHeader } from '@/components/shell/page-header';
import { unwrapPage } from '@/lib/api/server';
import { COLLECTED_DAYS, loadMoneyShell } from './load';

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
  const filters = readFilters(await searchParams, { status: STATUSES });
  const shell = await loadMoneyShell(workspaceId);
  const invoices = unwrapPage(
    await shell.api.POST('/v1/queries/invoice.list', {
      body: invoiceListBody(workspaceId, filters),
    }),
  );

  return (
    <>
      <PageHeader
        title="Money"
        description="What you have quoted, what you are owed and what has come in."
        actions={shell.canManage ? <MoneyActions workspaceId={workspaceId} /> : undefined}
      />
      {shell.summary ? (
        <HeadlineStrip summary={shell.summary} days={COLLECTED_DAYS} timeZone={shell.timeZone} />
      ) : null}
      <MoneySubnav workspaceId={workspaceId} tab="invoices">
        <MoneyFilterBar
          filters={filters}
          statuses={INVOICE_STATUS_CHOICES}
          searchLabel="Search invoices"
          count={invoices.invoices.length}
        />
      </MoneySubnav>
      <InvoicesList
        workspaceId={workspaceId}
        initial={invoices}
        filters={filters}
        canManage={shell.canManage}
        timeZone={shell.timeZone}
        now={shell.now}
      />
    </>
  );
}
