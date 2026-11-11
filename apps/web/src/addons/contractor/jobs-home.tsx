'use client';
/**
 * Jobs (docs/contractor.md, "Jobs"): every job, from a quick service call to a whole project, as a board by status
 * or a list, with what's open, late, on hold and done this month. Filters live in the address, so a saved link opens
 * the same view. New job starts one.
 */
import type { JobStatus } from '@hfos/core/addons/contractor/progress';
import { TRADE_NAMES } from '@hfos/core/addons/contractor/trades';
import {
  CONTRACTOR_WORDS,
  JOB_KIND_WORDS,
  JOB_STATUS_WORDS,
} from '@hfos/core/addons/contractor/words';
import { formatDate } from '@hfos/core';
import { CalendarClock, FileCheck, HardHat, MapPin, Search, User } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { contractorHref, DueLine, jobHref, PercentBar, StatusBadge } from './bits';
import { NewJobDialog } from './new-job-dialog';
import type { JobList, JobRow, Overview } from './types';

const W = CONTRACTOR_WORDS.jobs;

export type JobsView = 'board' | 'list';
export type JobsFilter = 'all' | 'mine' | 'late';

const BOARD: readonly JobStatus[] = ['new', 'scheduled', 'in_progress', 'on_hold'];
const CLOSED: readonly JobStatus[] = ['done', 'cancelled'];

export function JobsHome({
  workspaceId,
  overview,
  list,
  view,
  filter,
  closed,
  q,
  myUserId,
  timeZone,
}: {
  workspaceId: string;
  overview: Overview;
  list: JobList;
  view: JobsView;
  filter: JobsFilter;
  closed: boolean;
  q: string;
  myUserId: string;
  timeZone: string;
}) {
  useLiveRefresh(['custom_record', 'appointment']);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState(q);
  const go = (next: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') sp.delete(k);
      else sp.set(k, v);
    }
    const s = sp.toString();
    router.replace(s ? `${pathname}?${s}` : pathname);
  };
  const { counts } = overview;
  const filtered = filter !== 'all' || !!q;
  return (
    <div data-testid="contractor-jobs">
      <PageHeader
        title={W.title}
        description={`${overview.name} · ${W.lede}`}
        actions={
          <Button onClick={() => setAdding(true)} data-testid="job-new">
            {W.newJob}
          </Button>
        }
      />
      {overview.may.manage && !overview.settings.trades.length ? (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="flex items-center gap-2.5 text-[13.5px] text-text-2">
            <HardHat className="h-4 w-4 flex-none text-accent-text" />
            {W.setUp}
          </p>
          <ButtonLink href={contractorHref(workspaceId, 'settings')} size="sm">
            {W.setUpButton}
          </ButtonLink>
        </Card>
      ) : null}
      {overview.estimatesWaitingOk > 0 ? (
        <Card
          className="mb-4 flex flex-wrap items-center justify-between gap-3 px-5 py-4"
          data-testid="jobs-estimates-waiting"
        >
          <p className="flex items-center gap-2.5 text-[13.5px] text-text-2">
            <FileCheck className="h-4 w-4 flex-none text-danger-text" />
            {CONTRACTOR_WORDS.estimates.needOk(overview.estimatesWaitingOk)}
          </p>
          <ButtonLink href={contractorHref(workspaceId, 'estimates?waiting=1')} size="sm">
            {CONTRACTOR_WORDS.estimates.review}
          </ButtonLink>
        </Card>
      ) : null}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label={W.counts.open} value={counts.open} onClick={() => go({ filter: null })} />
        <Tile
          label={W.counts.late}
          value={counts.late}
          tone={counts.late ? 'danger' : undefined}
          onClick={() => go({ filter: 'late' })}
        />
        <Tile label={W.counts.onHold} value={counts.onHold} />
        <Tile label={W.counts.doneThisMonth} value={counts.doneThisMonth} />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Which jobs">
          {(['all', 'mine', 'late'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={filter === k}
              onClick={() => go({ filter: k === 'all' ? null : k })}
              className={cn(
                'inline-flex h-8 items-center rounded-full border px-3 text-[13px]',
                filter === k
                  ? 'border-accent-soft bg-accent-soft text-accent-text'
                  : 'border-border-strong text-text-2 hover:bg-card-2',
              )}
              data-testid={`jobs-filter-${k}`}
            >
              {W.filters[k]}
            </button>
          ))}
        </div>
        <form
          className="relative min-w-[180px] flex-1 sm:max-w-[280px]"
          onSubmit={(e) => {
            e.preventDefault();
            go({ q: search.trim() || null });
          }}
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" />
          <Input
            value={search}
            inputSize="sm"
            placeholder={W.search}
            aria-label={W.search}
            className="pl-8"
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => search.trim() !== q && go({ q: search.trim() || null })}
            data-testid="jobs-search"
          />
        </form>
        <Checkbox
          label={W.showClosed}
          checked={closed}
          onChange={(e) => go({ closed: e.target.checked ? '1' : null })}
          className="text-[13px]"
        />
        <div className="ml-auto">
          <Segmented<JobsView>
            value={view}
            onChange={(v) => go({ view: v === 'board' ? null : v })}
            ariaLabel="Show as"
            options={[
              { value: 'board', label: W.views.board, testId: 'jobs-view-board' },
              { value: 'list', label: W.views.list, testId: 'jobs-view-list' },
            ]}
          />
        </div>
      </div>
      {list.jobs.length === 0 ? (
        <Card className="px-5 py-10 text-center text-[13.5px] text-text-2" data-testid="jobs-empty">
          {filtered ? W.noneMatch : W.none}
        </Card>
      ) : view === 'board' ? (
        <Board
          workspaceId={workspaceId}
          jobs={list.jobs}
          columns={closed ? [...BOARD, ...CLOSED] : BOARD}
          today={overview.today}
          myUserId={myUserId}
        />
      ) : (
        <List
          workspaceId={workspaceId}
          jobs={list.jobs}
          today={overview.today}
          timeZone={timeZone}
        />
      )}
      {list.truncated ? (
        <p className="mt-3 text-[12.5px] text-text-3">
          Showing the first {list.jobs.length} jobs. Search or filter to find others.
        </p>
      ) : null}
      <NewJobDialog
        open={adding}
        onOpenChange={setAdding}
        workspaceId={workspaceId}
        overview={overview}
        myUserId={myUserId}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  tone?: 'danger';
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="text-[12px] font-medium uppercase tracking-wide text-text-3">{label}</div>
      <div
        className={cn(
          'mt-1 text-2xl font-semibold tabular-nums',
          tone === 'danger' ? 'text-danger-text' : 'text-text',
        )}
      >
        {value}
      </div>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="rounded-card border border-border bg-card px-4 py-3 text-left hover:bg-card-2"
    >
      {body}
    </button>
  ) : (
    <div className="rounded-card border border-border bg-card px-4 py-3">{body}</div>
  );
}

function Board({
  workspaceId,
  jobs,
  columns,
  today,
  myUserId,
}: {
  workspaceId: string;
  jobs: readonly JobRow[];
  columns: readonly JobStatus[];
  today: string;
  myUserId: string;
}) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0" data-testid="jobs-board">
      <div className="flex min-w-max gap-3">
        {columns.map((status) => {
          const here = jobs.filter((j) => j.status === status);
          return (
            <section
              key={status}
              className="w-[272px] flex-none rounded-card bg-card-2 p-2.5"
              aria-label={JOB_STATUS_WORDS[status]}
              data-testid={`jobs-column-${status}`}
            >
              <h2 className="mb-2 flex items-center justify-between px-1 text-[13px] font-semibold">
                {JOB_STATUS_WORDS[status]}
                <span className="font-normal tabular-nums text-text-3">{here.length}</span>
              </h2>
              <div className="space-y-2">
                {here.map((j) => (
                  <JobCard
                    key={j.id}
                    workspaceId={workspaceId}
                    job={j}
                    today={today}
                    mine={j.lead?.userId === myUserId}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function JobCard({
  workspaceId,
  job: j,
  today,
  mine,
}: {
  workspaceId: string;
  job: JobRow;
  today: string;
  mine: boolean;
}) {
  const finished = j.status === 'done' || j.status === 'cancelled';
  return (
    <Link
      href={jobHref(workspaceId, j.id)}
      className="block rounded-card border border-border bg-card p-3 text-[13px] shadow-1 hover:border-border-strong"
      data-testid={`job-card-${j.name}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold leading-snug">{j.name}</span>
        <span className="flex-none text-[11.5px] text-text-3">{JOB_KIND_WORDS[j.kind]}</span>
      </div>
      {j.customer || j.property ? (
        <div className="mt-1 space-y-0.5 text-[12.5px] text-text-2">
          {j.customer ? (
            <div className="flex items-center gap-1.5 truncate">
              <User className="h-3.5 w-3.5 flex-none text-text-3" />
              {j.customer.name}
            </div>
          ) : null}
          {j.property ? (
            <div className="flex items-center gap-1.5 truncate">
              <MapPin className="h-3.5 w-3.5 flex-none text-text-3" />
              {j.property.name}
            </div>
          ) : null}
        </div>
      ) : null}
      {j.kind === 'project' || j.percentDone > 0 ? (
        <PercentBar percent={j.percentDone} late={!!j.daysLate} className="mt-2" />
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[12px]">
        <DueLine dueOn={j.dueOn} daysLate={j.daysLate} today={today} finished={finished} />
        <span className="text-text-3">{j.lead ? (mine ? 'You' : j.lead.name) : 'No lead'}</span>
      </div>
      {j.status === 'on_hold' && j.statusReason ? (
        <p className="mt-1.5 line-clamp-2 text-[12px] text-danger-text">{j.statusReason}</p>
      ) : null}
    </Link>
  );
}

function List({
  workspaceId,
  jobs,
  today,
  timeZone,
}: {
  workspaceId: string;
  jobs: readonly JobRow[];
  today: string;
  timeZone: string;
}) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[760px] text-left text-[13.5px]" data-testid="jobs-list">
        <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
          <tr>
            <th className="px-5 py-3 font-semibold">Job</th>
            <th className="px-3 py-3 font-semibold">Status</th>
            <th className="px-3 py-3 font-semibold">Customer and property</th>
            <th className="px-3 py-3 font-semibold">% done</th>
            <th className="px-3 py-3 font-semibold">Deadline</th>
            <th className="px-5 py-3 font-semibold">Next visit</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const finished = j.status === 'done' || j.status === 'cancelled';
            return (
              <tr key={j.id} className="border-b border-border align-top last:border-b-0">
                <td className="px-5 py-3">
                  <Link
                    href={jobHref(workspaceId, j.id)}
                    className="font-semibold hover:underline"
                    data-testid={`job-row-${j.name}`}
                  >
                    {j.name}
                  </Link>
                  <div className="text-[12.5px] text-text-3">
                    {[JOB_KIND_WORDS[j.kind], j.trade ? TRADE_NAMES[j.trade] : null, j.lead?.name]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <StatusBadge status={j.status} />
                </td>
                <td className="px-3 py-3 text-text-2">
                  <div>{j.customer?.name ?? '—'}</div>
                  {j.property ? (
                    <div className="text-[12.5px] text-text-3">{j.property.name}</div>
                  ) : null}
                </td>
                <td className="w-[150px] px-3 py-3">
                  <PercentBar percent={j.percentDone} late={!!j.daysLate} />
                  {j.phases.count ? (
                    <div className="mt-0.5 text-[12px] text-text-3">
                      {j.phases.done} of {j.phases.count} phases done
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-3 text-[13px]">
                  <DueLine
                    dueOn={j.dueOn}
                    daysLate={j.daysLate}
                    today={today}
                    finished={finished}
                  />
                </td>
                <td className="px-5 py-3 text-[13px] text-text-2">
                  {j.nextVisitAt ? (
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarClock className="h-3.5 w-3.5 text-text-3" />
                      {formatDate(j.nextVisitAt, { time: true, timeZone })}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
