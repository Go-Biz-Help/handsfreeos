'use client';
import {
  money,
  orderNumberWords,
  orderStatusWords,
  orderSummary,
  orderWhenWords,
  ordersEmpty,
} from '@hfos/core';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { OrderListOut, OrderSummary } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { CustomerCell, ListNote, RowLink, ShowMore, Td, Th, useMore } from './list-bits';
import { orderListBody, type OrderShow } from './list-options';
import { StatusBadge } from './status-badge';

/** An order's status badge, worded for pickup or delivery ("Ready for pickup"). */
export function OrderStatus({ order, testId }: { order: OrderSummary; testId?: string }) {
  return (
    <StatusBadge
      kind="order"
      state={order.status}
      words={orderStatusWords(order.status, order.fulfilment)}
      testId={testId}
    />
  );
}

/** Money → Orders: what customers ordered, newest first, and where each one is. */
export function OrdersList({
  workspaceId,
  initial,
  show,
  q,
  canWrite,
}: {
  workspaceId: string;
  initial: OrderListOut;
  show: OrderShow;
  q: string;
  /** Whether they may take one, for the empty list's button. */
  canWrite: boolean;
}) {
  const router = useRouter();
  useLiveRefresh(['order', 'invoice']);
  const key = JSON.stringify({ show, q, first: initial.orders[0]?.id, n: initial.orders.length });
  const more = useMore<OrderSummary>(key, initial.nextCursor);
  const items = [...initial.orders, ...more.items];
  const href = (o: OrderSummary) => `/app/w/${workspaceId}/money/orders/${o.id}`;
  const filtered = !!q || show !== 'open';

  if (items.length === 0) {
    const empty = ordersEmpty(filtered);
    return (
      <Card>
        <EmptyState
          title={empty.title}
          actions={
            filtered || !canWrite ? undefined : (
              <ButtonLink href={`/app/w/${workspaceId}/money/orders/new`} size="sm">
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                New order
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
        <table className="hidden w-full text-[13px] md:table" data-testid="orders-table">
          <thead>
            <tr>
              <Th>Order</Th>
              <Th>Customer</Th>
              <Th>What</Th>
              <Th>When</Th>
              <Th>Status</Th>
              <Th align="right">Total</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr
                key={o.id}
                tabIndex={0}
                role="link"
                onClick={() => router.push(href(o))}
                onKeyDown={(e) => e.key === 'Enter' && router.push(href(o))}
                data-testid={`order-row-${o.number}`}
                className="cursor-pointer hover:bg-card-2 focus-visible:bg-card-2 focus-visible:outline-none"
              >
                <Td className="whitespace-nowrap font-mono text-[12.5px]">
                  {orderNumberWords(o.number)}
                </Td>
                <Td>
                  <CustomerCell person={{ id: o.person.id, fullName: o.person.name }} />
                </Td>
                <Td className="max-w-[280px]">
                  <span className="block truncate text-text-2">{orderSummary(o.lines)}</span>
                </Td>
                <Td className="whitespace-nowrap text-text-2">
                  {orderWhenWords(o.fulfilment, o.dueOn) ?? '—'}
                </Td>
                <Td>
                  <OrderStatus order={o} testId="order-status" />
                </Td>
                <Td align="right" className="font-semibold">
                  {o.totalCents > 0 ? money(o.totalCents) : '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>

        <ul className="md:hidden" data-testid="orders-cards">
          {items.map((o) => (
            <li key={o.id} className="border-t border-border first:border-t-0">
              <RowLink
                href={href(o)}
                testId={`order-card-${o.number}`}
                className="flex flex-col gap-1.5 px-4 py-3.5 active:bg-card-2"
              >
                <span className="flex items-center gap-2">
                  <span className="flex-1 truncate font-mono text-[12.5px] text-text-2">
                    {orderNumberWords(o.number)}
                  </span>
                  <OrderStatus order={o} />
                </span>
                <CustomerCell
                  person={{ id: o.person.id, fullName: o.person.name }}
                  className="text-[15px]"
                />
                <span className="truncate text-[13px] text-text-2">{orderSummary(o.lines)}</span>
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-text-3">
                    {orderWhenWords(o.fulfilment, o.dueOn) ?? 'No day yet'}
                  </span>
                  <span className="whitespace-nowrap text-[15px] font-semibold tabular-nums">
                    {o.totalCents > 0 ? money(o.totalCents) : ''}
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
                  await apiBrowser().POST('/v1/queries/order.list', {
                    body: { ...orderListBody(workspaceId, show, q), cursor },
                  }),
                );
                return { items: out.orders, nextCursor: out.nextCursor };
              })
            }
          />
        ) : null}
      </Card>
      <ListNote>
        An order form’s “How many of each” question makes an order here when it’s sent. Pickup and
        delivery days show on the calendar.
      </ListNote>
    </>
  );
}
