'use client';
import { invoiceDueLabel, invoicesEmpty, money, purposeLabel } from '@hfos/core';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { InvoiceListOut, InvoiceSummary } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { CustomerCell, ListNote, listState, RowLink, ShowMore, Td, Th, useMore } from './list-bits';
import type { MoneyFilters } from './list-options';
import { invoiceListBody } from './list-options';
import { StatusBadge } from './status-badge';

/** What the "Due" column says: core's `invoiceDueLabel`, so the phone's list reads the same. */
const dueLabel = (inv: InvoiceSummary, now: number, timeZone: string): string =>
  invoiceDueLabel(inv, now, timeZone);

function PurposePill({ purpose }: { purpose: string }) {
  const label = purposeLabel(purpose);
  return label ? <Badge variant="gray">{label}</Badge> : null;
}

export function InvoicesList({
  workspaceId,
  initial,
  filters,
  canManage,
  timeZone,
  now,
  accountNames,
}: {
  workspaceId: string;
  initial: InvoiceListOut;
  filters: MoneyFilters;
  canManage: boolean;
  timeZone: string;
  now: number;
  /** Each account's name, for a business with more than one to tell apart (0102). */
  accountNames?: Readonly<Record<string, string>> | null;
}) {
  const router = useRouter();
  useLiveRefresh(['invoice', 'payment', 'refund']);
  const key = JSON.stringify({
    filters,
    first: initial.invoices[0]?.id,
    n: initial.invoices.length,
  });
  const more = useMore<InvoiceSummary>(key, initial.nextCursor);
  const items = [...initial.invoices, ...more.items];
  const href = (inv: InvoiceSummary) => `/app/w/${workspaceId}/money/invoices/${inv.id}`;
  const paidInto = (inv: InvoiceSummary) =>
    inv.connectionId ? (accountNames?.[inv.connectionId] ?? '—') : 'No account';

  if (items.length === 0) {
    const filtered = !!(filters.q || filters.status || filters.account);
    const empty = invoicesEmpty(filtered);
    return (
      <Card>
        <EmptyState
          title={empty.title}
          actions={
            filtered || !canManage ? undefined : (
              <ButtonLink href={`/app/w/${workspaceId}/money/invoices/new`} size="sm">
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                New invoice
              </ButtonLink>
            )
          }
        >
          {empty.body}
        </EmptyState>
      </Card>
    );
  }

  return (
    <>
      <Card className="overflow-hidden">
        <table className="hidden w-full text-[13px] md:table" data-testid="invoices-table">
          <thead>
            <tr>
              <Th>Invoice</Th>
              <Th>Customer</Th>
              <Th>What</Th>
              <Th>Status</Th>
              <Th>Due</Th>
              {accountNames ? <Th>Paid into</Th> : null}
              <Th align="right">Total</Th>
              <Th align="right">Balance</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((inv) => (
              <tr
                key={inv.id}
                tabIndex={0}
                role="link"
                onClick={() => router.push(href(inv))}
                onKeyDown={(e) => e.key === 'Enter' && router.push(href(inv))}
                data-testid={`invoice-row-${inv.number ?? inv.id}`}
                className="cursor-pointer hover:bg-card-2 focus-visible:bg-card-2 focus-visible:outline-none"
              >
                <Td className="whitespace-nowrap font-mono text-[12.5px]">{inv.number ?? '—'}</Td>
                <Td>
                  <CustomerCell person={inv.person} />
                </Td>
                <Td className="max-w-[260px]">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-text-2">{inv.title ?? '—'}</span>
                    <PurposePill purpose={inv.purpose} />
                  </span>
                </Td>
                <Td>
                  <StatusBadge
                    kind="invoice"
                    state={listState(inv.state)}
                    testId="invoice-status"
                  />
                </Td>
                <Td className={cn('text-text-2', inv.state === 'overdue' && 'text-text')}>
                  {dueLabel(inv, now, timeZone)}
                </Td>
                {accountNames ? (
                  <Td className="max-w-[200px] truncate text-text-2">{paidInto(inv)}</Td>
                ) : null}
                <Td align="right">{money(inv.totals.totalCents)}</Td>
                <Td
                  align="right"
                  className={cn(
                    'font-semibold',
                    inv.balanceCents === 0 && 'font-normal text-text-3',
                    inv.state === 'overdue' && 'text-danger-text',
                  )}
                >
                  {money(inv.balanceCents)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>

        <ul className="md:hidden" data-testid="invoices-cards">
          {items.map((inv) => (
            <li key={inv.id} className="border-t border-border first:border-t-0">
              <RowLink
                href={href(inv)}
                testId={`invoice-card-${inv.number ?? inv.id}`}
                className="flex flex-col gap-1.5 px-4 py-3.5 active:bg-card-2"
              >
                <span className="flex items-center gap-2">
                  <span className="flex-1 truncate font-mono text-[12.5px] text-text-2">
                    {inv.number ?? 'Draft'}
                  </span>
                  <StatusBadge kind="invoice" state={listState(inv.state)} />
                </span>
                <CustomerCell person={inv.person} className="text-[15px]" />
                {inv.title ? (
                  <span className="truncate text-[13px] text-text-2">{inv.title}</span>
                ) : null}
                {accountNames ? (
                  <span className="truncate text-[13px] text-text-3">
                    {inv.connectionId ? `Paid into ${paidInto(inv)}` : 'No account'}
                  </span>
                ) : null}
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-text-3">{dueLabel(inv, now, timeZone)}</span>
                  <span className="whitespace-nowrap text-[15px] font-semibold tabular-nums">
                    {money(inv.balanceCents || inv.totals.totalCents)}
                  </span>
                </span>
              </RowLink>
            </li>
          ))}
        </ul>

        {more.cursor ? (
          <ShowMore
            busy={more.busy}
            onClick={() =>
              void more.load(async (cursor) => {
                const out = unwrap(
                  await apiBrowser().POST('/v1/queries/invoice.list', {
                    body: { ...invoiceListBody(workspaceId, filters), cursor },
                  }),
                );
                return { items: out.invoices, nextCursor: out.nextCursor };
              })
            }
          />
        ) : null}
      </Card>
      <ListNote>
        Members see only the invoices for jobs they are on. Owners and admins see them all.
      </ListNote>
    </>
  );
}
