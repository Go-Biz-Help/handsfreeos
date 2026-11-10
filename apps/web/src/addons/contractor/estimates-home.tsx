'use client';
/**
 * Estimates (docs/contractor.md, "Costs and estimates"): every estimate the builder wrote, newest first, with where
 * each stands and which are waiting for an owner's or admin's OK. A draft opens in the builder; one that has gone
 * out opens on its costs, with the way to its own page.
 */
import { CONTRACTOR_WORDS } from '@hfos/core/addons/contractor/words';
import { formatDate, money } from '@hfos/core';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { StatusBadge } from '@/components/money/status-badge';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { contractorHref } from './bits';
import type { EstimateItem, EstimateList } from './types';

const W = CONTRACTOR_WORDS.estimates;

/** Where an estimate's OK stands, as a badge; nothing when it never needed one. */
export function OkBadge({ estimate }: { estimate: EstimateItem }) {
  if (estimate.status !== 'draft') return null;
  if (estimate.okStands) return <Badge variant="ok">{W.okGiven}</Badge>;
  if (estimate.asked)
    return (
      <Badge variant="danger" data-testid="estimate-waiting-ok">
        {W.waitingOk}
      </Badge>
    );
  return null;
}

/** One estimate as a row: its number or "Draft", who and what it's for, where it stands, and its total. */
export function EstimateLine({
  workspaceId,
  estimate,
  timeZone,
  showJob,
  href,
}: {
  workspaceId: string;
  estimate: EstimateItem;
  timeZone: string;
  showJob?: boolean;
  /** Where it opens, when that isn't the builder. */
  href?: string;
}) {
  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        href={href ?? contractorHref(workspaceId, `estimates/${estimate.id}`)}
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 hover:bg-card-2"
        data-testid="estimate-row"
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
            {estimate.number ?? W.draft}
            <span className="font-normal text-text-2">· {estimate.customer}</span>
            <StatusBadge kind="estimate" state={estimate.status} />
            <OkBadge estimate={estimate} />
          </span>
          <span className="mt-0.5 block truncate text-[12.5px] text-text-3">
            {[
              estimate.title,
              showJob ? estimate.job?.name : null,
              estimate.optionName
                ? W.picked(estimate.optionName)
                : estimate.optionCount
                  ? W.options(estimate.optionCount)
                  : null,
              formatDate(estimate.createdAt, { timeZone }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <span className="flex-none text-[13.5px] font-semibold tabular-nums">
          {estimate.optionCount && !estimate.optionName ? 'From ' : ''}
          {money(estimate.totalCents)}
        </span>
      </Link>
    </li>
  );
}

export function EstimatesHome({
  workspaceId,
  list,
  waiting,
  timeZone,
}: {
  workspaceId: string;
  list: EstimateList;
  waiting: boolean;
  timeZone: string;
}) {
  useLiveRefresh(['estimate']);
  const router = useRouter();
  const pathname = usePathname();
  return (
    <div data-testid="contractor-estimates">
      <PageHeader
        title={W.title}
        description={W.lede}
        actions={
          <ButtonLink
            href={contractorHref(workspaceId, 'estimates/new')}
            variant="primary"
            data-testid="estimate-new"
          >
            {W.add}
          </ButtonLink>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Which estimates">
        {(['all', 'waiting'] as const).map((k) => {
          const on = (k === 'waiting') === waiting;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => router.replace(k === 'waiting' ? `${pathname}?waiting=1` : pathname)}
              className={cn(
                'inline-flex h-8 items-center rounded-full border px-3 text-[13px]',
                on
                  ? 'border-accent-soft bg-accent-soft text-accent-text'
                  : 'border-border-strong text-text-2 hover:bg-card-2',
              )}
              data-testid={`estimates-filter-${k}`}
            >
              {W.filters[k]}
            </button>
          );
        })}
      </div>
      <Card className="p-0">
        {list.estimates.length === 0 ? (
          <p className="px-5 py-4 text-[13.5px] text-text-2">
            {waiting ? W.noneWaiting : W.noneAll}
          </p>
        ) : (
          <ul>
            {list.estimates.map((e) => (
              <EstimateLine
                key={e.id}
                workspaceId={workspaceId}
                estimate={e}
                timeZone={timeZone}
                showJob
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
