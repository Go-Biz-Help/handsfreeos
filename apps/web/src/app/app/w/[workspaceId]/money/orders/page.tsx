import { ORDER_SHOW_WORDS } from '@hfos/core';
import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import { MoneyFilterBar } from '@/components/money/filters';
import { orderListBody, readFilters, type OrderShow } from '@/components/money/list-options';
import { HeadlineStrip } from '@/components/money/headline-strip';
import { OrdersList } from '@/components/money/orders-list';
import { MoneySubnav } from '@/components/money/subnav';
import { PageHeader } from '@/components/shell/page-header';
import { ButtonLink } from '@/components/ui/button';
import { unwrapPage } from '@/lib/api/server';
import { COLLECTED_DAYS, loadMoneyShell } from '../load';

export const metadata: Metadata = { title: 'Orders' };

/** The filter's choices: still to do is the list's own, so it has no value in the address. */
const SHOWS = [
  { value: '', label: ORDER_SHOW_WORDS.open },
  { value: 'done', label: ORDER_SHOW_WORDS.done },
  { value: 'cancelled', label: ORDER_SHOW_WORDS.cancelled },
  { value: 'all', label: ORDER_SHOW_WORDS.all },
] as const;

/** Money → Orders (product sellers): what customers ordered and where each one is. */
export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const filters = readFilters(await searchParams, { status: ['done', 'cancelled', 'all'] });
  const show = (filters.status || 'open') as OrderShow;
  const shell = await loadMoneyShell(workspaceId);
  const canWrite = shell.permissions.includes('records.write');
  const orders = unwrapPage(
    await shell.api.POST('/v1/queries/order.list', {
      body: orderListBody(workspaceId, show, filters.q),
    }),
  );

  return (
    <>
      <PageHeader
        title="Money"
        description="What you have quoted, what you are owed and what has come in."
        actions={
          canWrite ? (
            <ButtonLink
              href={`/app/w/${workspaceId}/money/orders/new`}
              className="max-md:h-11 max-md:flex-1"
              data-testid="money-new-order"
            >
              <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
              New order
            </ButtonLink>
          ) : undefined
        }
      />
      {shell.summary ? (
        <HeadlineStrip summary={shell.summary} days={COLLECTED_DAYS} timeZone={shell.timeZone} />
      ) : null}
      <MoneySubnav workspaceId={workspaceId} tab="orders">
        <MoneyFilterBar
          filters={filters}
          statuses={SHOWS}
          searchLabel="Search orders"
          count={orders.orders.length}
        />
      </MoneySubnav>
      <OrdersList
        workspaceId={workspaceId}
        initial={orders}
        show={show}
        q={filters.q}
        canWrite={canWrite}
      />
    </>
  );
}
