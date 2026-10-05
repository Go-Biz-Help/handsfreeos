'use client';
/**
 * Deals (board 1, design/realestate/DealsHome.dc.html): how the business's deals stand, the person's own and every
 * one they see, what needs attention, and the closed and archived ones. Every deal here is one the person may see;
 * row security decides that, never this page. Round four (board 59) adds filters, kept in the address so a saved
 * link opens the same list: the agent, the side, the stage, closing within so many days, what it's waiting on, and
 * its health.
 */
import { dayWords, dueWords } from '@hfos/core/addons/realestate/rule-words';
import { OUTCOME_LABELS } from '@hfos/core/addons/realestate/words';
import { STAGE_LABELS, stagesOf, type DealStage } from '@hfos/core/addons/realestate/states';
import { zoneLabel } from '@hfos/core';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { dealHref, HealthDot, realestateHref, SideBadge, type Health } from './bits';
import { StartDealDialog } from './start-deal-dialog';
import type { DealRow, Teammate } from './types';

export type DealsView = 'mine' | 'all' | 'attention' | 'closed' | 'archived';

/** The list's filters, as the address has them. */
export interface DealFilters {
  readonly agent: string | null;
  readonly side: 'buyer' | 'listing' | null;
  readonly stage: string | null;
  readonly closing: number | null;
  readonly waiting: 'outside' | 'blocked' | 'either' | null;
  readonly health: Health | null;
}

const WAITING_WORDS = {
  outside: 'someone outside',
  blocked: 'blocked',
  either: 'either',
} as const;

const needsAttention = (d: DealRow) => d.health !== 'green' || d.datesToConfirm > 0;

export function DealsHome({
  workspaceId,
  businessName,
  timeZone,
  view,
  openDeals,
  matchingDeals,
  filters,
  otherDeals,
  members,
  myUserId,
  canChooseAgent,
}: {
  workspaceId: string;
  businessName: string;
  timeZone: string;
  view: DealsView;
  /** Every open deal the person sees: the counts and the first three tabs. */
  openDeals: readonly DealRow[];
  /** The open ones the server's filters keep, when any is set. */
  matchingDeals: readonly DealRow[] | null;
  filters: DealFilters;
  /** The closed and ended ones, or the archived ones, when that tab is open. */
  otherDeals: readonly DealRow[];
  members: readonly Teammate[];
  myUserId: string;
  canChooseAgent: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState('');
  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    // A stage belongs to a side.
    if (key === 'side') next.delete('stage');
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
  const anyFilter = Object.values(filters).some((v) => v !== null);
  const clearFilters = () => {
    const next = new URLSearchParams(params.toString());
    for (const k of ['agent', 'side', 'stage', 'closing', 'waiting', 'health']) next.delete(k);
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
  const agents = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of openDeals) if (d.mainAgent) m.set(d.mainAgent.userId, d.mainAgent.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [openDeals]);
  const stages = useMemo(() => {
    const list = filters.side
      ? stagesOf(filters.side)
      : [...new Set([...stagesOf('buyer'), ...stagesOf('listing')])];
    return list.filter((st) => st !== 'past_client');
  }, [filters.side]);
  const [starting, setStarting] = useState<'buyer' | 'listing' | null>(null);

  const counts = useMemo(() => {
    const by = (h: Health) => openDeals.filter((d) => d.health === h).length;
    return {
      green: by('green'),
      yellow: by('yellow'),
      red: by('red'),
      dates: openDeals.filter((d) => d.datesToConfirm > 0).length,
      mine: openDeals.filter((d) => d.mine).length,
      attention: openDeals.filter(needsAttention).length,
    };
  }, [openDeals]);

  const shown = useMemo(() => {
    const live = (matchingDeals ?? openDeals).filter(
      (d) => !filters.health || d.health === filters.health,
    );
    const base =
      view === 'mine'
        ? live.filter((d) => d.mine)
        : view === 'all'
          ? live
          : view === 'attention'
            ? live.filter(needsAttention)
            : otherDeals;
    const needle = q.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((d) =>
      [d.name, d.property?.address, d.client?.name, d.mainAgent?.name].some((s) =>
        s?.toLowerCase().includes(needle),
      ),
    );
  }, [view, openDeals, matchingDeals, filters.health, otherDeals, q]);
  const live = view !== 'closed' && view !== 'archived';
  const showWaiting = !!filters.waiting || shown.some((d) => d.waiting);

  const tabs: { key: DealsView; label: string }[] = [
    { key: 'mine', label: `My deals · ${counts.mine}` },
    { key: 'all', label: `All deals · ${openDeals.length}` },
    { key: 'attention', label: `Needs attention · ${counts.attention}` },
    { key: 'closed', label: 'Closed' },
    { key: 'archived', label: 'Archived' },
  ];
  const tabHref = (key: DealsView) =>
    key === 'mine' ? realestateHref(workspaceId) : `${realestateHref(workspaceId)}?view=${key}`;
  const open = (d: DealRow) => router.push(dealHref(workspaceId, d.dealId));

  return (
    <div data-testid="realestate-deals">
      <PageHeader
        title="Deals"
        description={
          anyFilter && live
            ? `${businessName} · ${shown.length} of ${openDeals.length} open match`
            : `${businessName} · ${openDeals.length} open · ${zoneLabel(timeZone)}`
        }
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => setStarting('listing')}
              data-testid="start-listing"
            >
              Start a listing
            </Button>
            <Button onClick={() => setStarting('buyer')} data-testid="start-buyer-deal">
              <Plus className="h-[18px] w-[18px]" strokeWidth={1.75} />
              Start a buyer deal
            </Button>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Count label="Healthy" value={counts.green} health="green" />
        <Count label="Needs attention" value={counts.yellow} health="yellow" />
        <Count label="At risk" value={counts.red} health="red" />
        <Card className="p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-3">
            Dates to confirm
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="text-2xl font-semibold tabular-nums">{counts.dates}</span>
            {counts.dates ? (
              <Link
                href={tabHref('attention')}
                className="text-[13px] text-accent-text hover:underline"
              >
                Confirm
              </Link>
            ) : null}
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 pt-2 md:px-5">
          <nav aria-label="Which deals" className="-mb-px flex flex-wrap gap-1">
            {tabs.map((t) => (
              <Link
                key={t.key}
                href={tabHref(t.key)}
                aria-current={view === t.key ? 'page' : undefined}
                className={cn(
                  'border-b-2 px-3 py-2.5 text-[14px]',
                  view === t.key
                    ? 'border-accent font-medium text-accent-text'
                    : 'border-transparent text-text-2 hover:text-text',
                )}
                data-testid={`deals-tab-${t.key}`}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          <div className="relative mb-2 w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-3"
              strokeWidth={1.5}
            />
            <Input
              inputSize="sm"
              className="pl-9"
              placeholder="Find a deal or address"
              aria-label="Find a deal or address"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        {live ? (
          <div
            className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-[13px] md:px-5"
            data-testid="deals-filters"
          >
            <FilterSelect
              label="Agent"
              value={filters.agent}
              onChange={(v) => setFilter('agent', v)}
              options={agents.map(([id, name]) => [id, name])}
              testId="deals-filter-agent"
            />
            <FilterSelect
              label="Side"
              value={filters.side}
              onChange={(v) => setFilter('side', v)}
              options={[
                ['buyer', 'Buyer'],
                ['listing', 'Listing'],
              ]}
              testId="deals-filter-side"
            />
            <FilterSelect
              label="Stage"
              value={filters.stage}
              onChange={(v) => setFilter('stage', v)}
              options={stages.map((st) => [st, STAGE_LABELS[st as DealStage] ?? st])}
              testId="deals-filter-stage"
            />
            <FilterSelect
              label="Closing within"
              value={filters.closing ? String(filters.closing) : null}
              onChange={(v) => setFilter('closing', v)}
              options={[14, 30, 60, 90].map((n) => [String(n), `${n} days`])}
              testId="deals-filter-closing"
            />
            <FilterSelect
              label="Waiting on"
              value={filters.waiting}
              onChange={(v) => setFilter('waiting', v)}
              options={Object.entries(WAITING_WORDS)}
              testId="deals-filter-waiting"
            />
            <FilterSelect
              label="Health"
              value={filters.health}
              onChange={(v) => setFilter('health', v)}
              options={[
                ['red', 'At risk'],
                ['yellow', 'Needs attention'],
                ['green', 'On track'],
              ]}
              testId="deals-filter-health"
            />
            {anyFilter ? (
              <button
                type="button"
                className="text-accent-text hover:underline"
                onClick={clearFilters}
                data-testid="deals-filter-clear"
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : null}

        {shown.length === 0 ? (
          <EmptyState
            title={
              q.trim() || (anyFilter && live)
                ? 'No deal matches that.'
                : view === 'mine'
                  ? 'You’re not on any open deals yet.'
                  : view === 'attention'
                    ? 'Nothing needs attention.'
                    : view === 'closed'
                      ? 'No closed deals yet.'
                      : view === 'archived'
                        ? 'Nothing archived.'
                        : 'No open deals yet.'
            }
          >
            {view === 'mine' || view === 'all'
              ? 'Start a buyer deal or a listing. Its duties and deadlines are added for you.'
              : null}
          </EmptyState>
        ) : (
          <>
            <table
              className="hidden w-full table-fixed text-[13.5px] md:table"
              data-testid="deals-table"
            >
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-text-3">
                  <th className="px-5 py-2.5 font-semibold">Deal</th>
                  <th className="w-[92px] px-3 py-2.5 font-semibold">Side</th>
                  <th className="w-[128px] px-3 py-2.5 font-semibold">Stage</th>
                  <th className="w-[26%] px-3 py-2.5 font-semibold">
                    {showWaiting ? 'Waiting on' : 'Next duty'}
                  </th>
                  <th className="w-[84px] px-3 py-2.5 font-semibold">Closing</th>
                  <th className="w-[140px] px-5 py-2.5 font-semibold">Agent</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <tr
                    key={d.dealId}
                    tabIndex={0}
                    role="link"
                    aria-label={d.name}
                    onClick={() => open(d)}
                    onKeyDown={(e) => e.key === 'Enter' && open(d)}
                    className="cursor-pointer border-t border-border hover:bg-card-2 focus-visible:bg-card-2 focus-visible:outline-none"
                    data-testid={`deal-row-${d.dealId}`}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-start gap-2.5">
                        <HealthDot health={d.health} className="mt-1.5" />
                        <div className="min-w-0">
                          <div className="truncate font-semibold">{dealTitle(d)}</div>
                          <div className="truncate text-[12.5px] text-text-2" title={dealLine(d)}>
                            {dealLine(d)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <SideBadge side={d.side} />
                    </td>
                    <td className="px-3 py-3">{stageWords(d)}</td>
                    <td className="px-3 py-3">
                      {showWaiting ? (
                        d.waiting ? (
                          <>
                            <div className="truncate" title={d.waiting.title}>
                              {d.waiting.title}
                            </div>
                            <div className="truncate text-[12.5px] text-text-2">
                              {d.waiting.who}
                            </div>
                          </>
                        ) : (
                          '—'
                        )
                      ) : d.nextDue ? (
                        <>
                          <div className="truncate" title={d.nextDue.title}>
                            {d.nextDue.title}
                          </div>
                          <div className="text-[12.5px] text-text-2">
                            {dueWords(d.nextDue.dueAt, timeZone)}
                          </div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-3 tabular-nums">{dayWords(d.closing, timeZone)}</td>
                    <td className="truncate px-5 py-3">{d.mainAgent?.name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="md:hidden">
              {shown.map((d) => (
                <li key={d.dealId} className="border-t border-border first:border-t-0">
                  <Link
                    href={dealHref(workspaceId, d.dealId)}
                    className="flex items-start gap-2.5 px-4 py-3"
                  >
                    <HealthDot health={d.health} className="mt-1.5" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{dealTitle(d)}</div>
                      <div className="truncate text-[12.5px] text-text-2">
                        {d.stageLabel} · {dealLine(d)}
                      </div>
                      {d.waiting ? (
                        <div className="truncate text-[12.5px] text-text-3">
                          Waiting on {d.waiting.who}: {d.waiting.title}
                        </div>
                      ) : null}
                    </div>
                    <SideBadge side={d.side} />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <StartDealDialog
        workspaceId={workspaceId}
        side={starting ?? 'buyer'}
        open={starting !== null}
        onOpenChange={(o) => !o && setStarting(null)}
        members={members}
        myUserId={myUserId}
        canChooseAgent={canChooseAgent}
      />
    </div>
  );
}

/** "Smith purchase · 123 Main St", or just its name when the address is in it already. */
export function dealTitle(d: Pick<DealRow, 'name' | 'property'>): string {
  const address = d.property?.address;
  return address && !d.name.includes(address) ? `${d.name} · ${address}` : d.name;
}

/** What to know about it at a glance: the first thing wrong, how it ended, or that it's on track. */
function dealLine(d: DealRow): string {
  if (d.archived) return 'Archived';
  if (d.outcome) return stageWords(d);
  if (d.headline) return d.headline;
  if (d.datesToConfirm)
    return d.datesToConfirm === 1 ? '1 date to confirm' : `${d.datesToConfirm} dates to confirm`;
  return 'On track';
}

/** Its stage, or how it ended. */
function stageWords(d: DealRow): string {
  return d.outcome
    ? ((OUTCOME_LABELS as Readonly<Record<string, string>>)[d.outcome] ?? d.stageLabel)
    : d.stageLabel;
}

/** One filter: "Agent: Dana Reyes", or "Any" when it's off. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: readonly (readonly [string, string])[];
  testId: string;
}) {
  return (
    <label
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        value ? 'border-accent bg-accent-soft text-accent-text' : 'border-border text-text-2',
      )}
    >
      <span>{label}:</span>
      <select
        className="max-w-[160px] cursor-pointer bg-transparent py-1 font-medium text-text focus:outline-none"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        data-testid={testId}
      >
        <option value="">Any</option>
        {options.map(([v, words]) => (
          <option key={v} value={v}>
            {words}
          </option>
        ))}
      </select>
    </label>
  );
}

function Count({ label, value, health }: { label: string; value: number; health: Health }) {
  return (
    <Card className="p-4" data-testid={`deals-count-${health}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-text-3">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        <HealthDot health={health} />
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
      </div>
    </Card>
  );
}
