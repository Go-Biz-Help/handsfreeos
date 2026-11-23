'use client';
import { orderDayWords, orderNumberWords, orderStatusWords, orderSummary } from '@hfos/core';
import { Package } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import type { OrderSummary } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';

/**
 * The orders to hand over on the days showing (product sellers): each one's pickup or delivery day, still to make
 * or hand over, a tap from its page. Nothing shows on days with none.
 */
export function OrdersDue({
  workspaceId,
  orders,
  days,
  today,
  className,
}: {
  workspaceId: string;
  orders: readonly OrderSummary[];
  /** The days showing, in order. */
  days: readonly string[];
  today: string;
  className?: string;
}) {
  useLiveRefresh(['order']);
  const shown = days
    .map((day) => ({ day, list: orders.filter((o) => o.dueOn === day) }))
    .filter((d) => d.list.length);
  if (!shown.length) return null;
  return (
    <Card className={cn('px-4 py-3', className)} data-testid="calendar-orders-due">
      <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-text-2">
        <Package className="h-4 w-4" strokeWidth={1.75} />
        Pickups and deliveries
      </h2>
      <ul className="space-y-1.5">
        {shown.map(({ day, list }) => (
          <li key={day} className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
            <span
              className={cn(
                'w-[92px] shrink-0 text-[12.5px] font-medium',
                day === today ? 'text-accent-text' : 'text-text-3',
              )}
            >
              {day === today ? 'Today' : orderDayWords(day)}
            </span>
            {list.map((o) => (
              <Link
                key={o.id}
                href={`/app/w/${workspaceId}/money/orders/${o.id}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-control border border-border px-2 py-1 text-[12.5px] transition-colors hover:bg-card-2"
                data-testid={`calendar-order-${o.number}`}
                title={orderSummary(o.lines, 4)}
              >
                <span className="font-mono text-text-2">{orderNumberWords(o.number)}</span>
                <span className="truncate font-medium">{o.person.name}</span>
                <span className="whitespace-nowrap text-text-3">
                  · {orderStatusWords(o.status, o.fulfilment)}
                </span>
              </Link>
            ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}
