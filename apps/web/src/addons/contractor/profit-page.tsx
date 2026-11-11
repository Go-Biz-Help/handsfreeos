'use client';
/**
 * Profit (docs/contractor.md, "Time and job costing"; the owner's decision 11): what the jobs made. The price of
 * each, what it cost in labor (time tracked), materials and everything else, and what's left, for the jobs done in
 * a stretch of time, or the open jobs at what they're heading for; split by job, customer, crew or service. Only
 * people who may see job costs open this page.
 *
 * Which jobs and how they're split are in the address (`?period=…&by=…`), so a link stays what it showed. Every
 * figure comes worked out from the server (`contractor.profit`), the same numbers the AI reads.
 */
import {
  PROFIT_GROUPS,
  PROFIT_PERIODS,
  type ProfitGroup,
  type ProfitPeriod,
} from '@hfos/core/addons/contractor/job-costing';
import {
  CONTRACTOR_WORDS,
  hoursWords,
  PROFIT_GROUP_WORDS,
  PROFIT_NONE_WORDS,
  PROFIT_PERIOD_WORDS,
} from '@hfos/core/addons/contractor/words';
import { formatDateOnly, money } from '@hfos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { contractorHref, jobHref } from './bits';
import { Margin } from './costing';
import type { Profit, ProfitRow } from './types';

const P = CONTRACTOR_WORDS.profit;

export function ProfitPage({ workspaceId, profit }: { workspaceId: string; profit: Profit }) {
  const router = useRouter();
  const { period, by, total, rows, minMarginBp } = profit;
  const go = (next: { period?: ProfitPeriod; by?: ProfitGroup }) => {
    const q = new URLSearchParams();
    const p = next.period ?? period;
    const b = next.by ?? by;
    // The page's own start (done this month, by job) needs nothing in the address.
    if (p !== 'month') q.set('period', p);
    if (b !== 'job') q.set('by', b);
    const qs = q.toString();
    router.push(contractorHref(workspaceId, qs ? `profit?${qs}` : 'profit'));
  };
  /** Where a row's name leads: the job, or the customer. A crew or a service has no page of its own. */
  const hrefOf = (r: ProfitRow) =>
    !r.key
      ? null
      : by === 'job'
        ? jobHref(workspaceId, r.key)
        : by === 'customer'
          ? `/app/w/${workspaceId}/customers/people/${r.key}`
          : null;
  return (
    <div className="max-w-[1040px]" data-testid="contractor-profit">
      <PageHeader
        title={P.title}
        description={P.lede}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              selectSize="sm"
              className="w-[168px]"
              aria-label={P.which}
              value={period}
              onChange={(e) => go({ period: e.target.value as ProfitPeriod })}
              data-testid="profit-period"
            >
              {PROFIT_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {PROFIT_PERIOD_WORDS[p]}
                </option>
              ))}
            </Select>
            <Select
              selectSize="sm"
              className="w-[140px]"
              aria-label={P.split}
              value={by}
              onChange={(e) => go({ by: e.target.value as ProfitGroup })}
              data-testid="profit-by"
            >
              {PROFIT_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {PROFIT_GROUP_WORDS[g]}
                </option>
              ))}
            </Select>
          </div>
        }
      />
      <p className="mb-3 text-[13px] text-text-2" data-testid="profit-range">
        {profit.from && profit.to ? (
          <span className="font-medium text-text">
            {formatDateOnly(profit.from)} to {formatDateOnly(profit.to)}.{' '}
          </span>
        ) : null}
        {period === 'open' ? P.openNote : P.doneNote}
        {by === 'crew' ? ` ${P.crewNote}` : ''}
      </p>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="profit-total">
        <Stat label={P.price} value={money(total.priceCents)} testId="profit-total-price" />
        <Stat label={P.cost} value={money(total.costCents)} testId="profit-total-cost" />
        <Stat
          label={P.profit}
          value={
            <span className={total.profitCents < 0 ? 'text-danger-text' : undefined}>
              {money(total.profitCents)}
            </span>
          }
          testId="profit-total-profit"
        />
        <Stat
          label={P.margin}
          value={<Margin bp={total.marginBp} minBp={minMarginBp} />}
          note={`${total.jobs} ${total.jobs === 1 ? 'job' : 'jobs'} · ${hoursWords(total.laborHours)}`}
          testId="profit-total-margin"
        />
      </div>
      <Card className="p-0">
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13.5px] text-text-2" data-testid="profit-empty">
            {period === 'open' ? P.noneOpen : P.none}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13.5px]">
              <thead>
                <tr className="border-b border-border text-[12px] font-medium uppercase tracking-wide text-text-3">
                  <th scope="col" className="px-5 py-2.5 text-left font-medium">
                    {P.name}
                  </th>
                  {by === 'job' ? null : (
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">
                      {P.jobs}
                    </th>
                  )}
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">
                    {P.price}
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">
                    {P.cost}
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">
                    {P.profit}
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">
                    {P.margin}
                  </th>
                  <th scope="col" className="py-2.5 pl-3 pr-5 text-right font-medium">
                    {P.hours}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const href = hrefOf(r);
                  const name = r.name ?? PROFIT_NONE_WORDS[by];
                  return (
                    <tr
                      key={r.key ?? ''}
                      className="border-b border-border last:border-b-0"
                      data-testid="profit-row"
                    >
                      <th scope="row" className="max-w-[280px] px-5 py-2.5 text-left font-medium">
                        {href ? (
                          <Link href={href} className="block truncate hover:underline">
                            {name}
                          </Link>
                        ) : (
                          <span className={cn('block truncate', !r.key && 'text-text-2')}>
                            {name}
                          </span>
                        )}
                      </th>
                      {by === 'job' ? null : (
                        <td className="px-3 py-2.5 text-right tabular-nums">{r.jobs}</td>
                      )}
                      <td className="px-3 py-2.5 text-right tabular-nums">{money(r.priceCents)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{money(r.costCents)}</td>
                      <td
                        className={cn(
                          'px-3 py-2.5 text-right font-medium tabular-nums',
                          r.profitCents < 0 && 'text-danger-text',
                        )}
                      >
                        {money(r.profitCents)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <Margin bp={r.marginBp} minBp={minMarginBp} />
                      </td>
                      <td className="py-2.5 pl-3 pr-5 text-right tabular-nums text-text-2">
                        {hoursWords(r.laborHours)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {profit.truncated ? (
        <p className="mt-3 text-[12.5px] text-text-3" data-testid="profit-truncated">
          {P.truncated(total.jobs)}
        </p>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  testId: string;
}) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-[12px] font-medium uppercase tracking-wide text-text-3">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums" data-testid={testId}>
        {value}
      </div>
      {note ? <div className="mt-0.5 text-[12.5px] text-text-3">{note}</div> : null}
    </Card>
  );
}
