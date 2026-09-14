'use client';
import { ChevronRight, History } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { WorkflowRunList, WorkflowStats } from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import {
  isDefaultRunView,
  runFiltersQuery,
  runListBody,
  type RunFilters,
  type RunRange,
  type RunStatusFilter,
} from '@/lib/workflows/run-filters';
import { endReasonText, isLive, whenText } from '@/lib/workflows/run-words';
import { cn } from '@/lib/utils';
import { RunStatusBadge } from './run-status';

const COLUMNS =
  'lg:grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.6fr)_150px] lg:items-center lg:gap-4';

/**
 * Every run, newest first: by workflow, where it stands, real runs or tests, and when it started. Pages 25
 * at a time; a run starting or ending refreshes the list.
 */
export function RunsList({
  workspaceId,
  initial,
  initialFilters,
  workflows,
  stats,
  timeZone,
}: {
  workspaceId: string;
  initial: WorkflowRunList;
  initialFilters: RunFilters;
  workflows: readonly { id: string; name: string }[];
  stats: WorkflowStats | null;
  timeZone: string;
}) {
  const [filters, setFilters] = useState(initialFilters);
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const changes = useLiveVersion(['workflow_run']);
  const key = `${JSON.stringify(filters)}:${changes}`;
  const shown = useRef(key);
  const base = `/app/w/${workspaceId}/workflows`;

  useEffect(() => {
    if (shown.current === key) return;
    shown.current = key;
    let cancelled = false;
    window.history.replaceState(null, '', `${window.location.pathname}${runFiltersQuery(filters)}`);
    void (async () => {
      setBusy(true);
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/workflow.run_list', {
            body: runListBody(workspaceId, filters, Date.now()),
          }),
        );
        if (!cancelled) setData(out);
      } catch (e) {
        if (!cancelled) toast.error(errorMessage(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, filters, workspaceId]);

  async function loadMore() {
    if (!data.nextCursor) return;
    setBusy(true);
    try {
      const more = unwrap(
        await apiBrowser().POST('/v1/queries/workflow.run_list', {
          body: runListBody(workspaceId, filters, Date.now(), data.nextCursor),
        }),
      );
      setData({ items: [...data.items, ...more.items], nextCursor: more.nextCursor });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const counts = stats && isDefaultRunView(filters) ? stats.runs30d : null;
  const label = (text: string, n: number | undefined) =>
    n === undefined ? text : `${text} · ${n}`;
  const set = (patch: Partial<RunFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div data-testid="runs-page">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Select
          selectSize="sm"
          className="w-full sm:w-[220px]"
          aria-label="Workflow"
          value={filters.workflowId ?? ''}
          onChange={(e) => set({ workflowId: e.target.value || null })}
          data-testid="runs-workflow"
        >
          <option value="">All workflows</option>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <Segmented
          ariaLabel="Where it stands"
          value={filters.status}
          onChange={(v: RunStatusFilter) => set({ status: v })}
          className="max-w-full overflow-x-auto [scrollbar-width:none]"
          options={[
            { value: 'all', label: label('All', counts?.all), testId: 'runs-status-all' },
            {
              value: 'waiting',
              label: label('Going', counts?.waiting),
              testId: 'runs-status-waiting',
            },
            {
              value: 'awaiting_approval',
              label: label('Needs approval', counts?.awaitingApproval),
              testId: 'runs-status-approval',
            },
            {
              value: 'failed',
              label: label('Failed', counts?.failed),
              testId: 'runs-status-failed',
            },
            { value: 'completed', label: 'Completed', testId: 'runs-status-completed' },
            { value: 'stopped', label: 'Stopped', testId: 'runs-status-stopped' },
          ]}
        />
        <Segmented
          ariaLabel="Real runs or tests"
          value={filters.tests ? 'tests' : 'live'}
          onChange={(v) => set({ tests: v === 'tests' })}
          options={[
            { value: 'live', label: 'Real runs', testId: 'runs-live' },
            { value: 'tests', label: 'Tests', testId: 'runs-tests' },
          ]}
        />
        <Select
          selectSize="sm"
          className="w-[150px]"
          aria-label="Started"
          value={filters.range}
          onChange={(e) => set({ range: e.target.value as RunRange })}
          data-testid="runs-range"
        >
          <option value="1d">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">Any time</option>
        </Select>
        <span className="ml-auto text-[13px] text-text-3" aria-live="polite">
          {busy ? 'Loading…' : null}
        </span>
      </div>

      <Card className="overflow-hidden" data-testid="runs-list">
        <div
          className={cn(
            'hidden border-b border-border bg-card-2 px-[18px] py-[9px] text-xs font-medium text-text-3',
            COLUMNS,
          )}
        >
          <span>Customer</span>
          <span>Workflow</span>
          <span>Status</span>
          <span>Started</span>
        </div>
        {data.items.map((r) => {
          const name = r.person?.fullName ?? (r.isTest ? 'Test run' : 'No customer');
          const why = isLive(r.status)
            ? r.isTest
              ? `Test of revision ${r.testRevision ?? '?'}`
              : `Version ${r.version ?? '?'}`
            : endReasonText(r.endReason);
          return (
            <Link
              key={r.id}
              href={`${base}/runs/${r.id}`}
              data-testid={`run-row-${r.id}`}
              className={cn(
                'flex flex-col gap-1 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-card-2 lg:px-[18px] lg:py-3',
                COLUMNS,
              )}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <Avatar name={name} seed={r.person?.id ?? r.id} size="sm" />
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{name}</span>
                <span className="lg:hidden">
                  <RunStatusBadge status={r.status} />
                </span>
              </span>
              <span className="truncate pl-[34px] text-[13px] text-text-2 lg:pl-0">
                {r.workflow.name}
                {r.isTest ? ` · ${r.testMode === 'send_to_me' ? 'Send to me' : 'Simulate'}` : ''}
                <span className="lg:hidden"> · {whenText(r.startedAt, timeZone)}</span>
              </span>
              <span className="flex min-w-0 items-center gap-2 pl-[34px] lg:pl-0">
                <span className="hidden lg:inline-flex">
                  <RunStatusBadge status={r.status} />
                </span>
                <span className="truncate text-xs text-text-3">{why}</span>
              </span>
              <span className="hidden text-[13px] text-text-2 lg:block">
                {whenText(r.startedAt, timeZone)}
              </span>
            </Link>
          );
        })}
        {!data.items.length ? (
          <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
            <span className="mb-1 inline-flex h-10 w-10 items-center justify-center rounded-full bg-card-2 text-text-3">
              <History className="h-5 w-5" strokeWidth={1.5} />
            </span>
            <h3 className="text-[15px] font-semibold">No runs match</h3>
            <p className="max-w-[360px] text-[13px] text-text-2">
              {filters.tests
                ? 'Tests you run from a workflow’s Test tab show here.'
                : 'Runs show here once a published workflow starts for a customer.'}
            </p>
          </div>
        ) : null}
      </Card>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-text-3">
        <span>
          {data.items.length} {data.items.length === 1 ? 'run' : 'runs'} shown
        </span>
        {data.nextCursor ? (
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => void loadMore()}
            data-testid="runs-more"
          >
            Load more
            <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
