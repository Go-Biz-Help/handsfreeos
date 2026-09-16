'use client';
import { dayLabel, localInstant, money } from '@hfos/core';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import type { PlanRow, SubscriptionRow } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { CustomerCell, ListNote, Td, Th } from './list-bits';
import { StatusBadge } from './status-badge';

const EVERY: Readonly<Record<string, string>> = {
  month: 'a month',
  quarter: 'a quarter',
  year: 'a year',
};

/** "$29 a month", "$290 a year", "$149 every 3 months". */
export function planPriceLabel(
  priceCents: number,
  interval: string,
  intervalCount: number,
): string {
  const every = intervalCount === 1 ? EVERY[interval] : `every ${intervalCount} ${interval}s`;
  return `${money(priceCents)} ${every ?? ''}`.trim();
}

const BILLING = new Set(['active', 'past_due']);

export function PlansList({
  workspaceId,
  plans,
  subscriptions,
  monthlyRecurringCents,
  timeZone,
}: {
  workspaceId: string;
  plans: readonly PlanRow[];
  subscriptions: readonly SubscriptionRow[];
  monthlyRecurringCents: number;
  timeZone: string;
}) {
  useLiveRefresh(['subscription', 'plan']);
  const billing = subscriptions.filter((s) => BILLING.has(s.status));
  const membersOf = (planId: string) => billing.filter((s) => s.planId === planId).length;
  const live = plans.filter((p) => !p.archivedAt);
  // What the yearly plans come to in a year, so a monthly figure never quietly swallows them.
  const yearlyCents = live
    .filter((p) => p.interval === 'year')
    .reduce((sum, p) => sum + (p.priceCents * membersOf(p.id)) / p.intervalCount, 0);

  return (
    <>
      {live.length === 0 ? (
        <Card>
          <EmptyState title="No plans yet">
            A maintenance plan bills itself every month or every year. Add one in Settings →
            Products.
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-[13px]" data-testid="plans-table">
            <thead>
              <tr>
                <Th>Plan</Th>
                <Th>Price</Th>
                <Th align="right">Members</Th>
                <Th className="max-md:hidden">What it includes</Th>
                <Th align="right">A month</Th>
              </tr>
            </thead>
            <tbody>
              {live.map((p) => {
                const members = membersOf(p.id);
                const monthly =
                  p.interval === 'month' && p.intervalCount === 1 ? p.priceCents * members : null;
                return (
                  <tr key={p.id} data-testid={`plan-row-${p.name}`}>
                    <Td className="font-semibold">{p.name}</Td>
                    <Td className="whitespace-nowrap tabular-nums">
                      {planPriceLabel(p.priceCents, p.interval, p.intervalCount)}
                    </Td>
                    <Td align="right">{members}</Td>
                    <Td className="max-w-[320px] text-text-2 max-md:hidden">
                      <span className="block truncate">
                        {p.includes.length ? p.includes.join(', ') : (p.description ?? '—')}
                      </span>
                    </Td>
                    <Td align="right">{monthly === null ? '—' : money(monthly)}</Td>
                  </tr>
                );
              })}
              <tr>
                <Td className="font-semibold">Recurring</Td>
                <Td />
                <Td />
                <Td className="max-md:hidden" />
                <Td align="right" className="whitespace-nowrap font-semibold">
                  {money(monthlyRecurringCents)} a month
                </Td>
              </tr>
              {yearlyCents > 0 ? (
                <tr>
                  <Td className="text-text-3">Plans that bill once a year</Td>
                  <Td />
                  <Td />
                  <Td className="max-md:hidden" />
                  <Td align="right" className="whitespace-nowrap text-text-3">
                    {money(Math.round(yearlyCents))} a year
                  </Td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Card>
      )}

      <h2 className="mb-2.5 mt-6 text-[15px] font-semibold tracking-tight">Who is on a plan</h2>
      {subscriptions.length === 0 ? (
        <Card>
          <EmptyState title="Nobody is on a plan yet">
            Start a customer on a plan from their record. It bills itself through the account you
            are paid into.
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-[13px]" data-testid="subscriptions-table">
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Plan</Th>
                <Th>Status</Th>
                <Th className="max-md:hidden">Next bill</Th>
                <Th align="right">Price</Th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <tr key={s.id} data-testid={`subscription-row-${s.id}`} className="hover:bg-card-2">
                  <Td>
                    <Link href={`/app/w/${workspaceId}/customers/people/${s.person.id}`}>
                      <CustomerCell person={s.person} />
                    </Link>
                  </Td>
                  <Td className="text-text-2">{s.planName}</Td>
                  <Td>
                    <StatusBadge kind="subscription" state={s.status} testId="plan-status" />
                  </Td>
                  <Td className="whitespace-nowrap text-text-2 max-md:hidden">
                    {s.nextBillingOn
                      ? dayLabel(localInstant(s.nextBillingOn, '12:00', timeZone), timeZone)
                      : '—'}
                  </Td>
                  <Td align="right">{planPriceLabel(s.priceCents, s.interval, s.intervalCount)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <ListNote>
        Plans bill themselves through Stripe or Square. A failed cycle shows here as “Payment
        failed”.
      </ListNote>
    </>
  );
}
