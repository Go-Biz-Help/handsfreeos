'use client';
import { dayLabel, expiryPhrase, money } from '@hfos/core';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { EstimateListOut, EstimateSummary } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { CustomerCell, ListNote, listState, RowLink, ShowMore, Td, Th, useMore } from './list-bits';
import type { MoneyFilters } from './list-options';
import { estimateListBody } from './list-options';
import { StatusBadge } from './status-badge';

/** Where an estimate stands, in one sentence: the column the canvas calls "Where it stands". */
export function estimateStanding(est: EstimateSummary, now: number, timeZone: string): string {
  const day = (iso: string | null) => (iso ? dayLabel(Date.parse(iso), timeZone) : '');
  if (est.voidedAt) return `Voided ${day(est.voidedAt)}`;
  if (est.acceptedAt) return `Approved ${day(est.acceptedAt)}`;
  if (est.declinedAt) return `Declined ${day(est.declinedAt)}`;
  if (!est.sentAt) return `Started ${day(est.createdAt)} · not sent`;
  const seen = est.firstViewedAt ? ' · opened' : '';
  return `Sent ${day(est.sentAt)}${seen} · ${expiryPhrase(est.expiresOn, now, timeZone)}`;
}

export function EstimatesList({
  workspaceId,
  initial,
  filters,
  canManage,
  timeZone,
  now,
  goodForDays,
}: {
  workspaceId: string;
  initial: EstimateListOut;
  filters: MoneyFilters;
  canManage: boolean;
  timeZone: string;
  now: number;
  goodForDays: number;
}) {
  const router = useRouter();
  useLiveRefresh(['estimate']);
  const key = JSON.stringify({
    filters,
    first: initial.estimates[0]?.id,
    n: initial.estimates.length,
  });
  const more = useMore<EstimateSummary>(key, initial.nextCursor);
  const items = [...initial.estimates, ...more.items];
  const href = (est: EstimateSummary) => `/app/w/${workspaceId}/money/estimates/${est.id}`;

  if (items.length === 0)
    return (
      <Card>
        <EmptyState
          title={filters.q || filters.status ? 'No estimates match' : 'No estimates yet'}
          actions={
            filters.q || filters.status || !canManage ? undefined : (
              <ButtonLink href={`/app/w/${workspaceId}/money/estimates/new`} size="sm">
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                New estimate
              </ButtonLink>
            )
          }
        >
          {filters.q || filters.status
            ? 'Try a different search, or show every status.'
            : 'Quote a job from the catalogue. The customer approves it on their own page.'}
        </EmptyState>
      </Card>
    );

  return (
    <>
      <Card className="overflow-hidden">
        <table className="hidden w-full text-[13px] md:table" data-testid="estimates-table">
          <thead>
            <tr>
              <Th>Estimate</Th>
              <Th>Customer</Th>
              <Th>What</Th>
              <Th>Status</Th>
              <Th>Where it stands</Th>
              <Th align="right">Total</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((est) => (
              <tr
                key={est.id}
                tabIndex={0}
                role="link"
                onClick={() => router.push(href(est))}
                onKeyDown={(e) => e.key === 'Enter' && router.push(href(est))}
                data-testid={`estimate-row-${est.number ?? est.id}`}
                className="cursor-pointer hover:bg-card-2 focus-visible:bg-card-2 focus-visible:outline-none"
              >
                <Td className="whitespace-nowrap font-mono text-[12.5px]">{est.number ?? '—'}</Td>
                <Td>
                  <CustomerCell person={est.person} />
                </Td>
                <Td className="max-w-[240px]">
                  <span className="block truncate text-text-2">{est.title ?? '—'}</span>
                </Td>
                <Td>
                  <StatusBadge
                    kind="estimate"
                    state={listState(est.state)}
                    testId="estimate-status"
                  />
                </Td>
                <Td className="text-text-2">{estimateStanding(est, now, timeZone)}</Td>
                <Td align="right" className="font-semibold">
                  {money(est.totals.totalCents)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>

        <ul className="md:hidden" data-testid="estimates-cards">
          {items.map((est) => (
            <li key={est.id} className="border-t border-border first:border-t-0">
              <RowLink
                href={href(est)}
                testId={`estimate-card-${est.number ?? est.id}`}
                className="flex flex-col gap-1.5 px-4 py-3.5 active:bg-card-2"
              >
                <span className="flex items-center gap-2">
                  <span className="flex-1 truncate font-mono text-[12.5px] text-text-2">
                    {est.number ?? 'Draft'}
                  </span>
                  <StatusBadge kind="estimate" state={listState(est.state)} />
                </span>
                <CustomerCell person={est.person} className="text-[15px]" />
                {est.title ? (
                  <span className="truncate text-[13px] text-text-2">{est.title}</span>
                ) : null}
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-text-3">
                    {estimateStanding(est, now, timeZone)}
                  </span>
                  <span className="whitespace-nowrap text-[15px] font-semibold tabular-nums">
                    {money(est.totals.totalCents)}
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
                  await apiBrowser().POST('/v1/queries/estimate.list', {
                    body: { ...estimateListBody(workspaceId, filters), cursor },
                  }),
                );
                return { items: out.estimates, nextCursor: out.nextCursor };
              })
            }
          />
        ) : null}
      </Card>
      <ListNote>
        An estimate stays good for {goodForDays} days, then it expires and says so on the customer’s
        page.
      </ListNote>
    </>
  );
}
