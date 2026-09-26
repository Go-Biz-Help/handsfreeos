'use client';
import { dayLabel, localInstant, money, planPriceLabel } from '@hfos/core';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import type { PlanRow, SubscriptionRow } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { CustomerCell, ListNote, RowLink, Td, Th } from './list-bits';
import { PlanNameButton } from './plan-editor';
import { PlanVisitsButton, type ServiceChoice } from './plan-visits';
import { StatusBadge } from './status-badge';

/** "$29 a month", "$290 a year", "$149 every 3 months": core's, so the phone's list says the same. */
export { planPriceLabel };

const BILLING = new Set(['active', 'past_due']);

export function PlansList({
  workspaceId,
  plans,
  subscriptions,
  monthlyRecurringCents,
  timeZone,
  services = [],
  canManage = false,
  accountNames,
  filtered = false,
}: {
  workspaceId: string;
  plans: readonly PlanRow[];
  subscriptions: readonly SubscriptionRow[];
  monthlyRecurringCents: number;
  timeZone: string;
  /** For each plan's visits (Maintenance due). */
  services?: readonly ServiceChoice[];
  canManage?: boolean;
  /** Each account's name, for a business with more than one to tell apart (0105). */
  accountNames?: Readonly<Record<string, string>> | null;
  /** Whether "who is on a plan" is narrowed by a filter, so an empty list says so. */
  filtered?: boolean;
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
            A maintenance plan bills itself every month or every year.{' '}
            {canManage
              ? 'Press New plan to add the first one.'
              : 'Someone who manages the money adds them here.'}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="hidden w-full text-[13px] md:table" data-testid="plans-table">
            <thead>
              <tr>
                <Th>Plan</Th>
                <Th>Price</Th>
                <Th align="right">Members</Th>
                <Th className="max-md:hidden">What it includes</Th>
                <Th>Visits</Th>
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
                    <Td className="font-semibold">
                      <PlanNameButton workspaceId={workspaceId} plan={p} canManage={canManage} />
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">
                      {planPriceLabel(p.priceCents, p.interval, p.intervalCount)}
                    </Td>
                    <Td align="right">{members}</Td>
                    <Td className="max-w-[320px] text-text-2 max-md:hidden">
                      <span className="block truncate">
                        {p.includes.length ? p.includes.join(', ') : (p.description ?? '—')}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <PlanVisitsButton
                        workspaceId={workspaceId}
                        plan={p}
                        services={services}
                        canManage={canManage}
                      />
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
                <Td />
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
                  <Td />
                  <Td align="right" className="whitespace-nowrap text-text-3">
                    {money(Math.round(yearlyCents))} a year
                  </Td>
                </tr>
              ) : null}
            </tbody>
          </table>

          {/* On a phone the same rows read as cards: a five-column table would clip inside the card. */}
          <ul className="md:hidden" data-testid="plans-cards">
            {live.map((p) => {
              const members = membersOf(p.id);
              const monthly =
                p.interval === 'month' && p.intervalCount === 1 ? p.priceCents * members : null;
              return (
                <li
                  key={p.id}
                  data-testid={`plan-card-${p.name}`}
                  className="flex flex-col gap-1.5 border-t border-border px-4 py-3.5 first:border-t-0"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[15px] font-semibold">
                      <PlanNameButton
                        workspaceId={workspaceId}
                        plan={p}
                        canManage={canManage}
                        card
                      />
                    </span>
                    <span className="whitespace-nowrap text-[13px] tabular-nums text-text-2">
                      {planPriceLabel(p.priceCents, p.interval, p.intervalCount)}
                    </span>
                  </span>
                  {p.includes.length || p.description ? (
                    <span className="text-[13px] leading-[1.45] text-text-2">
                      {p.includes.length ? p.includes.join(', ') : p.description}
                    </span>
                  ) : null}
                  <span className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="text-text-3">
                      {members === 1 ? '1 member' : `${members} members`}
                    </span>
                    <span className="whitespace-nowrap font-semibold tabular-nums">
                      {monthly === null ? '—' : `${money(monthly)} a month`}
                    </span>
                  </span>
                </li>
              );
            })}
            <li className="flex flex-col gap-1 border-t border-border bg-card-2 px-4 py-3.5">
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] font-semibold">Recurring</span>
                <span className="whitespace-nowrap text-[15px] font-semibold tabular-nums">
                  {money(monthlyRecurringCents)} a month
                </span>
              </span>
              {yearlyCents > 0 ? (
                <span className="flex items-baseline justify-between gap-3 text-[13px] text-text-3">
                  <span>Plans that bill once a year</span>
                  <span className="whitespace-nowrap tabular-nums">
                    {money(Math.round(yearlyCents))} a year
                  </span>
                </span>
              ) : null}
            </li>
          </ul>
        </Card>
      )}

      <h2 className="mb-2.5 mt-6 text-[15px] font-semibold tracking-tight">Who is on a plan</h2>
      {subscriptions.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState title="Nobody matches">Try another status or account.</EmptyState>
          ) : (
            <EmptyState title="Nobody is on a plan yet">
              Press Put someone on a plan, or Put on a plan in a customer’s Money tab. It bills
              itself through the account you are paid into.
            </EmptyState>
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="hidden w-full text-[13px] md:table" data-testid="subscriptions-table">
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Plan</Th>
                <Th>Status</Th>
                <Th className="max-md:hidden">Next bill</Th>
                {accountNames ? <Th>Paid into</Th> : null}
                <Th align="right">Price</Th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <tr key={s.id} data-testid={`subscription-row-${s.id}`} className="hover:bg-card-2">
                  <Td>
                    {/* The row opens the plan itself: what it bills, its cycles, and pausing or cancelling it. */}
                    <Link href={`/app/w/${workspaceId}/money/plans/${s.id}`}>
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
                  {accountNames ? (
                    <Td className="max-w-[200px] truncate text-text-2">
                      {s.connectionId ? (accountNames[s.connectionId] ?? '—') : 'No account yet'}
                    </Td>
                  ) : null}
                  <Td align="right">{planPriceLabel(s.priceCents, s.interval, s.intervalCount)}</Td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="md:hidden" data-testid="subscriptions-cards">
            {subscriptions.map((s) => (
              <li key={s.id} className="border-t border-border first:border-t-0">
                <RowLink
                  href={`/app/w/${workspaceId}/money/plans/${s.id}`}
                  testId={`subscription-card-${s.id}`}
                  className="flex flex-col gap-1.5 px-4 py-3.5 active:bg-card-2"
                >
                  <span className="flex items-center gap-2">
                    <CustomerCell person={s.person} className="min-w-0 flex-1 text-[15px]" />
                    <StatusBadge kind="subscription" state={s.status} />
                  </span>
                  <span className="truncate text-[13px] text-text-2">{s.planName}</span>
                  {accountNames ? (
                    <span className="truncate text-[13px] text-text-3">
                      {s.connectionId
                        ? `Paid into ${accountNames[s.connectionId] ?? 'an account'}`
                        : 'No account yet'}
                    </span>
                  ) : null}
                  <span className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="text-text-3">
                      {s.nextBillingOn
                        ? `Next bill ${dayLabel(localInstant(s.nextBillingOn, '12:00', timeZone), timeZone)}`
                        : 'No next bill yet'}
                    </span>
                    <span className="whitespace-nowrap font-semibold tabular-nums">
                      {planPriceLabel(s.priceCents, s.interval, s.intervalCount)}
                    </span>
                  </span>
                </RowLink>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <ListNote>
        Plans bill themselves through Stripe or Square. A failed cycle shows here as “Payment
        failed”.
      </ListNote>
    </>
  );
}
