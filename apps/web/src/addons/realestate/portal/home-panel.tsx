'use client';
/**
 * Real Estate's part of the client's portal Home (board 27, design/realestate/PortalHome.dc.html): each open deal
 * with where it stands, what's coming up, and the first things on their to-do.
 */
import { fmtAt, fmtMonthDay } from '@hfos/core';
import Link from 'next/link';
import { usePortal, usePortalQuery } from '@/components/portal/context';
import { PortalCardHead } from '@/components/portal/ui';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { feedbackDue, firstName, nextTour, TaskRow, weekday, zone } from './bits';
import type { PortalDeal, PortalDealRow } from './types';

const thisYear = () => new Date().getFullYear();

export default function RealestateHomePanel() {
  const { data } = usePortalQuery<{ deals: readonly PortalDealRow[] }>('realestate.portal.deals');
  const open = (data?.deals ?? []).filter((d) => !d.closed);
  const closed = (data?.deals ?? []).filter((d) => d.closed);
  return (
    <>
      {open.map((d) => (
        <DealOnHome key={d.dealId} row={d} />
      ))}
      {closed.length ? <ClosedDeals deals={closed} /> : null}
    </>
  );
}

function ClosedDeals({ deals }: { deals: readonly PortalDealRow[] }) {
  const { href } = usePortal();
  return (
    <Card className="p-4">
      <PortalCardHead>Past deals</PortalCardHead>
      <ul className="space-y-1 text-[14px]">
        {deals.map((d) => (
          <li key={d.dealId}>
            <Link href={href(`a/realestate/deals/${d.dealId}`)} className="hover:underline">
              {d.name}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DealOnHome({ row }: { row: PortalDealRow }) {
  const { href } = usePortal();
  const { data: deal, reload } = usePortalQuery<PortalDeal>('realestate.portal.deal', {
    dealId: row.dealId,
  });
  const tour = deal ? nextTour(deal.tours) : undefined;
  const today = new Date().toISOString().slice(0, 10);
  const dates = (deal?.keyDates ?? []).filter((k) => k.date >= today).slice(0, 3);
  const todo = (deal?.tasks ?? []).filter((t) => t.status === 'open' && !t.mine).slice(0, 3);
  const feedback = deal ? feedbackDue(deal.tours) : [];
  const agent = row.agentName;
  return (
    <div className="space-y-4" data-testid="portal-deal-home">
      <Link href={href(`a/realestate/deals/${row.dealId}`)} className="block">
        <Card className="p-4 hover:bg-card-2">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-[16px] font-semibold">
              {row.side === 'buyer' ? 'Buying a home' : 'Selling your home'}
              {agent ? ` with ${agent}` : ''}
            </h2>
            <Badge variant="accent">{row.stage}</Badge>
          </div>
          <p className="mt-1 text-[13.5px] text-text-2">
            {tour
              ? `Next: ${weekday(tour.startsAt)}’s tour, ${tour.stops.length} ${tour.stops.length === 1 ? 'home' : 'homes'}.`
              : row.nextDate
                ? `Next: ${row.nextDate.label}, ${fmtMonthDay(row.nextDate.date, thisYear())}.`
                : `${firstName(agent)} will let you know what’s next.`}
          </p>
        </Card>
      </Link>
      {tour || dates.length ? (
        <Card className="p-4">
          <PortalCardHead>Coming up</PortalCardHead>
          <ul className="space-y-1.5 text-[14px]">
            {tour ? (
              <li className="flex justify-between gap-3">
                <Link
                  href={href(`a/realestate/deals/${row.dealId}/tours/${tour.id}`)}
                  className="text-text-2 hover:underline"
                >
                  Tour · {tour.stops.length} {tour.stops.length === 1 ? 'home' : 'homes'}
                </Link>
                <span>{fmtAt(tour.startsAt, zone()).replace(' at ', ' · ')}</span>
              </li>
            ) : null}
            {dates.map((k) => (
              <li key={k.key} className="flex justify-between gap-3">
                <span className="text-text-2">{k.label}</span>
                <span>{fmtMonthDay(k.date, thisYear())}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {todo.length || feedback.length ? (
        <Card className="p-4">
          <PortalCardHead
            action={
              <Link
                href={href('a/realestate/todo')}
                className="text-[13px] text-accent-text hover:underline"
              >
                All
              </Link>
            }
          >
            Your to-do
          </PortalCardHead>
          <ul className="divide-y divide-border">
            {feedback.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2.5 text-[14px]">
                <span>Leave feedback on {weekday(t.startsAt)}’s homes</span>
                <Link
                  href={href(`a/realestate/deals/${row.dealId}/tours/${t.id}`)}
                  className="text-[13px] text-accent-text hover:underline"
                >
                  Open
                </Link>
              </li>
            ))}
            {todo.map((t) => (
              <TaskRow key={t.id} task={t} dealId={row.dealId} onDone={reload} />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
