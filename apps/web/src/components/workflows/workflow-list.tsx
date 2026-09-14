'use client';
import { WORKFLOW_RECIPES } from '@hfos/core';
import { Info, Search, WandSparkles, Workflow } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { TemplateUpdateButton } from '@/components/agency/template-update';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import type { WorkflowStats, WorkflowStatus, WorkflowSummary } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { endReasonText, isLive, RUN_STATUS, whenText } from '@/lib/workflows/run-words';
import { cn } from '@/lib/utils';
import {
  KindTile,
  recipeIcon,
  SourceChips,
  triggerIcon,
  workflowIcon,
  WorkflowStatusBadge,
} from './chips';
import { StatusChangeDialog, type StatusChange } from './publish';
import { WorkflowStatTiles } from './workflow-stats';

type Filter = 'all' | WorkflowStatus;

const COLUMNS =
  'lg:grid lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_128px_minmax(0,1.3fr)_112px] lg:items-center lg:gap-4';

/** Whom the last run was for and how it stands: "Mike Johnson · They replied". */
function lastRunLine(r: NonNullable<WorkflowSummary['lastRun']>): string {
  const who = r.person?.fullName ?? 'No customer';
  const how = isLive(r.status)
    ? RUN_STATUS[r.status].label
    : (endReasonText(r.endReason) ?? RUN_STATUS[r.status].label);
  return `${who} · ${how}`;
}

/**
 * Every workflow: what starts it, where it came from, its runs in the last 30 days and the last one, and a
 * switch to pause or resume it (with a confirm that says what happens), under today's tiles.
 */
export function WorkflowList({
  workspaceId,
  items,
  canManage,
  stats = null,
  timeZone = 'America/Chicago',
}: {
  workspaceId: string;
  items: WorkflowSummary[];
  canManage: boolean;
  /** Today at a glance, for the tiles. */
  stats?: WorkflowStats | null;
  timeZone?: string;
}) {
  useLiveRefresh(['workflow', 'workflow_template', 'workflow_run']);
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<WorkflowSummary | null>(null);
  const [change, setChange] = useState<StatusChange | null>(null);
  const base = `/app/w/${workspaceId}/workflows`;

  const counts = useMemo(() => {
    const by = (s: WorkflowStatus) => items.filter((w) => w.status === s).length;
    return { all: items.length, active: by('active'), paused: by('paused'), draft: by('draft') };
  }, [items]);
  const shown = items.filter(
    (w) =>
      (filter === 'all' || w.status === filter) &&
      (!q.trim() || w.name.toLowerCase().includes(q.trim().toLowerCase())),
  );

  if (!items.length) return <NoWorkflows base={base} canManage={canManage} />;

  return (
    <div>
      {stats ? <WorkflowStatTiles workspaceId={workspaceId} stats={stats} /> : null}
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="relative w-full sm:w-[280px]">
          <Search
            className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-3"
            strokeWidth={1.5}
          />
          <Input
            inputSize="sm"
            className="pl-9"
            placeholder="Search workflows"
            aria-label="Search workflows"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Segmented
          ariaLabel="Show"
          value={filter}
          onChange={setFilter}
          className="max-w-full overflow-x-auto [scrollbar-width:none]"
          options={[
            { value: 'all', label: `All · ${counts.all}` },
            { value: 'active', label: `Active · ${counts.active}` },
            { value: 'paused', label: `Paused · ${counts.paused}` },
            { value: 'draft', label: `Drafts · ${counts.draft}` },
          ]}
        />
      </div>

      <Card className="overflow-hidden" data-testid="workflows-list">
        <div
          className={cn(
            'hidden border-b border-border bg-card-2 px-[18px] py-[9px] text-xs font-medium text-text-3',
            COLUMNS,
          )}
        >
          <span>Workflow</span>
          <span>Starts when</span>
          <span>Runs, last 30 days</span>
          <span>Last run</span>
          <span>On or off</span>
        </div>
        {shown.map((w) => {
          const Trig = triggerIcon(w.trigger.kind, w.trigger.event);
          const switchable = canManage && (w.status === 'active' || w.status === 'paused');
          const failed = w.lastRun?.status === 'failed' ? w.lastError : null;
          return (
            // The name is the row's link, stretched over the row, so the switch can sit on top of it.
            <div
              key={w.id}
              data-testid={`workflow-row-${w.id}`}
              data-status={w.status}
              className={cn(
                'relative flex items-start gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-card-2 lg:px-[18px] lg:py-[13px]',
                COLUMNS,
              )}
            >
              <span className="flex min-w-0 flex-1 items-start gap-2.5">
                <KindTile tone="act" icon={workflowIcon(w)} />
                <span className="flex min-w-0 flex-col gap-[5px]">
                  <Link
                    href={`${base}/${w.id}`}
                    className="truncate rounded-[4px] text-[15px] font-semibold leading-tight after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring lg:text-sm lg:font-medium"
                  >
                    {w.name}
                  </Link>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <SourceChips source={w.source} />
                    {canManage && w.source.template?.updateAvailable ? (
                      <TemplateUpdateButton
                        workspaceId={workspaceId}
                        workflowId={w.id}
                        className="h-6 px-2 text-xs"
                      />
                    ) : null}
                    <span className="text-xs text-text-3 lg:hidden">{w.trigger.summary}</span>
                  </span>
                  {w.activeVersion ? (
                    <span className="text-xs text-text-3 lg:hidden">
                      {w.runs30d} {w.runs30d === 1 ? 'run' : 'runs'} in 30 days
                      {w.lastRun ? ` · last ${whenText(w.lastRun.startedAt, timeZone)}` : ''}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="hidden items-start gap-2 text-[13px] text-text-2 lg:flex">
                <Trig className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
                <span className="min-w-0">{w.trigger.summary}</span>
              </span>
              <span className="hidden flex-col lg:flex">
                {w.activeVersion ? (
                  <>
                    <span className="text-[13px] font-semibold tabular-nums">{w.runs30d}</span>
                    <span className="text-xs text-text-3">
                      {w.activeRuns
                        ? `${w.activeRuns} going now`
                        : `Version ${w.activeVersion.version} live`}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-[13px]">Not published yet</span>
                    <span className="text-xs text-text-3">Run a test to publish it</span>
                  </>
                )}
              </span>
              <span className="hidden min-w-0 flex-col lg:flex">
                {w.lastRun ? (
                  <>
                    <span className="text-[13px]">{whenText(w.lastRun.startedAt, timeZone)}</span>
                    {failed ? (
                      <span className="text-xs text-danger-text">
                        <span className="line-clamp-2">{failed.message}</span>
                        <Link
                          href={`${base}/runs/${failed.runId}`}
                          className="relative z-10 font-medium hover:underline"
                        >
                          See the run
                        </Link>
                      </span>
                    ) : (
                      <span className="truncate text-xs text-text-3">{lastRunLine(w.lastRun)}</span>
                    )}
                  </>
                ) : (
                  <span className="text-xs text-text-3">No runs yet</span>
                )}
              </span>
              <span className="relative z-10 flex flex-none flex-col items-end gap-1 lg:items-start">
                {switchable ? (
                  <span className="flex items-center gap-2">
                    <Switch
                      checked={w.status === 'active'}
                      onChange={(on) => {
                        setTarget(w);
                        setChange(on ? 'resume' : 'pause');
                      }}
                      label={w.status === 'active' ? `Pause ${w.name}` : `Resume ${w.name}`}
                      testId={`workflow-switch-${w.id}`}
                    />
                    <span className="text-xs font-medium text-text-2">
                      {w.status === 'active' ? 'On' : 'Paused'}
                    </span>
                  </span>
                ) : (
                  <WorkflowStatusBadge status={w.status} />
                )}
                <span className="text-xs text-text-3 lg:hidden">
                  {w.activeVersion ? `v${w.activeVersion.version}` : 'Not published'}
                </span>
              </span>
            </div>
          );
        })}
        {!shown.length ? (
          <div className="px-6 py-[34px] text-center">
            <h3 className="text-[15px] font-semibold">No workflows match</h3>
            <p className="mt-1 text-[13px] text-text-2">Try another word, or clear the search.</p>
          </div>
        ) : null}
      </Card>
      <p className="mt-3 flex items-start gap-1.5 text-xs text-text-3">
        <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
        {canManage
          ? 'Recipes and Go Biz Help templates change only when you apply an update. Paused workflows ignore new triggers and hold their runs.'
          : 'Only owners and admins can change workflows. You can open any of them to see how it works.'}
      </p>
      <StatusChangeDialog
        change={change}
        onClose={() => setChange(null)}
        workspaceId={workspaceId}
        workflow={
          target
            ? { id: target.id, name: target.name, activeRuns: target.activeRuns }
            : { id: '', name: 'this workflow' }
        }
        onDone={() => router.refresh()}
      />
    </div>
  );
}

/** The first visit: what workflows are, and three recipes to start from. */
function NoWorkflows({ base, canManage }: { base: string; canManage: boolean }) {
  const picks = WORKFLOW_RECIPES.slice(0, 3);
  return (
    <Card className="overflow-hidden" data-testid="workflows-empty">
      <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
        <span className="mb-1 inline-flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent-text">
          <Workflow className="h-5 w-5" strokeWidth={1.5} />
        </span>
        <h3 className="text-[15px] font-semibold">No workflows yet</h3>
        <p className="max-w-[340px] text-[13px] text-text-2">
          Workflows follow up for you. Most businesses start with Speed to lead, which texts new
          leads within a minute.
        </p>
        {canManage ? (
          <div className="mt-2.5 flex flex-wrap justify-center gap-2">
            <ButtonLink href={`${base}/new`} variant="primary" size="sm">
              Browse recipes
            </ButtonLink>
            <Button
              variant="secondary"
              size="sm"
              disabled
              title="Coming with the AI builder"
              className="disabled:opacity-60"
            >
              <WandSparkles className="h-4 w-4" strokeWidth={1.5} />
              Describe it
              <Badge variant="gray" className="h-5">
                Soon
              </Badge>
            </Button>
          </div>
        ) : (
          <p className="mt-1 text-xs text-text-3">An owner or admin can add the first one.</p>
        )}
      </div>
      {canManage ? (
        <div className="border-t border-border">
          {picks.map((r) => (
            <div
              key={r.key}
              className="flex items-center gap-2.5 border-b border-border px-4 py-2.5 last:border-b-0"
            >
              <KindTile tone="act" icon={recipeIcon(r.key)} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[13px]">{r.name}</span>
              <Link
                href={`${base}/new?recipe=${r.key}`}
                className="text-xs font-medium text-accent-text hover:underline"
              >
                Use it
              </Link>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
