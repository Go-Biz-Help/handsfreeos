'use client';
import {
  dayLabel,
  money,
  PAYMENT_METHOD_LABELS,
  paymentsEmpty,
  type PaymentMethod,
} from '@hfos/core';
import { Banknote, CreditCard, HandCoins, Receipt } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { PaymentListOut, PaymentListRow } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { CustomerCell, ListNote, ShowMore, Td, Th, useMore } from './list-bits';
import type { MoneyFilters } from './list-options';
import { paymentListBody } from './list-options';
import { StatusBadge } from './status-badge';

const PROVIDER_WORDS: Readonly<Record<string, string>> = {
  stripe: 'Stripe',
  square: 'Square',
  paypal: 'PayPal',
  nmi: 'NMI',
  authorize_net: 'Authorize.net',
};

function MethodCell({
  payment,
  names,
}: {
  payment: PaymentListRow;
  /** Each account's name, when there's more than one to tell apart (0105). */
  names?: Readonly<Record<string, string>> | null;
}) {
  const method = payment.method as PaymentMethod;
  const Icon =
    method === 'card'
      ? CreditCard
      : method === 'ach'
        ? Banknote
        : method === 'check'
          ? Receipt
          : HandCoins;
  const where =
    (payment.connectionId ? names?.[payment.connectionId] : undefined) ??
    (payment.provider ? (PROVIDER_WORDS[payment.provider] ?? payment.provider) : null);
  return (
    <span className="flex items-center gap-1.5 text-text-2">
      <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
      {PAYMENT_METHOD_LABELS[method] ?? method}
      {where ? ` · ${where}` : ''}
    </span>
  );
}

export function PaymentsList({
  workspaceId,
  initial,
  filters,
  timeZone,
  collectedCents,
  days,
  accountNames,
}: {
  workspaceId: string;
  initial: PaymentListOut;
  filters: MoneyFilters;
  timeZone: string;
  collectedCents: number;
  days: number;
  /** Each account's name, for a business with more than one (0105). */
  accountNames?: Readonly<Record<string, string>> | null;
}) {
  useLiveRefresh(['payment', 'invoice', 'refund']);
  const key = JSON.stringify({
    filters,
    first: initial.payments[0]?.id,
    n: initial.payments.length,
  });
  const more = useMore<PaymentListRow>(key, initial.nextCursor);
  const items = [...initial.payments, ...more.items];
  const when = (p: PaymentListRow) => dayLabel(Date.parse(p.receivedAt ?? p.createdAt), timeZone);
  const href = (p: PaymentListRow) => `/app/w/${workspaceId}/money/invoices/${p.invoiceId}`;

  if (items.length === 0)
    return (
      <Card>
        <EmptyState
          title={paymentsEmpty(!!(filters.status || filters.method || filters.account)).title}
        >
          {filters.status || filters.method || filters.account
            ? paymentsEmpty(true).body
            : paymentsEmpty(false).body}
        </EmptyState>
      </Card>
    );

  return (
    <>
      <Card className="overflow-hidden">
        <table className="hidden w-full text-[13px] md:table" data-testid="payments-table">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Customer</Th>
              <Th>How</Th>
              <Th>Invoice</Th>
              <Th>Status</Th>
              <Th align="right">Amount</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} data-testid={`payment-row-${p.id}`} className="hover:bg-card-2">
                <Td className="whitespace-nowrap">{when(p)}</Td>
                <Td>
                  {p.person ? (
                    <CustomerCell person={p.person} />
                  ) : (
                    <span className="text-text-3">—</span>
                  )}
                </Td>
                <Td>
                  <MethodCell payment={p} names={accountNames} />
                </Td>
                <Td>
                  <Link
                    href={href(p)}
                    className="font-mono text-[12.5px] text-accent-text hover:underline"
                  >
                    {p.invoiceNumber ?? 'Draft'}
                  </Link>
                </Td>
                <Td>
                  <StatusBadge kind="payment" state={p.status} testId="payment-status" />
                </Td>
                <Td align="right" className="font-semibold">
                  {money(p.amountCents)}
                  {p.refundedCents > 0 ? (
                    <span className="block text-xs font-normal text-text-3">
                      {money(p.refundedCents)} refunded
                    </span>
                  ) : null}
                </Td>
              </tr>
            ))}
            <tr>
              <Td className="font-semibold" />
              <Td className="font-semibold">
                Collected in {days} days{filters.account ? ', every account' : ''}
              </Td>
              <Td />
              <Td />
              <Td />
              <Td align="right" className="font-semibold">
                {money(collectedCents)}
              </Td>
            </tr>
          </tbody>
        </table>

        <ul className="md:hidden" data-testid="payments-cards">
          {items.map((p) => (
            <li
              key={p.id}
              className="flex flex-col gap-1.5 border-t border-border px-4 py-3.5 first:border-t-0"
              data-testid={`payment-card-${p.id}`}
            >
              <span className="flex items-center gap-2">
                <span className="flex-1 text-[13px] text-text-3">{when(p)}</span>
                <StatusBadge kind="payment" state={p.status} />
              </span>
              {p.person ? <CustomerCell person={p.person} className="text-[15px]" /> : null}
              <span className="flex items-baseline justify-between gap-3">
                <MethodCell payment={p} names={accountNames} />
                <span className="whitespace-nowrap text-[15px] font-semibold tabular-nums">
                  {money(p.amountCents)}
                </span>
              </span>
              <Link
                href={href(p)}
                className="font-mono text-[12.5px] text-accent-text hover:underline"
              >
                {p.invoiceNumber ?? 'Draft invoice'}
              </Link>
            </li>
          ))}
        </ul>

        {more.cursor ? (
          <ShowMore
            busy={more.busy}
            onClick={() =>
              void more.load(async (cursor) => {
                const out = unwrap(
                  await apiBrowser().POST('/v1/queries/payment.list', {
                    body: { ...paymentListBody(workspaceId, filters), cursor },
                  }),
                );
                return { items: out.payments, nextCursor: out.nextCursor };
              })
            }
          />
        ) : null}
      </Card>
      <ListNote>Every payment belongs to an invoice, even a quick payment or a setup fee.</ListNote>
    </>
  );
}
