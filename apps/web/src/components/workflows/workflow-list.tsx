'use client';
import { WORKFLOW_RECIPES } from '@hfos/core';
import { Info, Search, WandSparkles, Workflow } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import type { WorkflowStatus, WorkflowSummary } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn, relativeTime } from '@/lib/utils';
import {
  KindTile,
  recipeIcon,
  SourceChips,
  triggerIcon,
  workflowIcon,
  WorkflowStatusBadge,
} from './chips';

type Filter = 'all' | WorkflowStatus;

const COLUMNS =
  'lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_136px_132px_88px] lg:items-center lg:gap-4';

/** Every workflow: its status, what starts it, where it came from, its live version and when it was edited. */
export function WorkflowList({
  workspaceId,
  items,
  canManage,
}: {
  workspaceId: string;
  items: WorkflowSummary[];
  canManage: boolean;
}) {
  useLiveRefresh(['workflow', 'workflow_template']);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
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
          <span>Live version</span>
          <span>Last edited</span>
          <span>Status</span>
        </div>
        {shown.map((w) => {
          const Trig = triggerIcon(w.trigger.kind, w.trigger.event);
          return (
            <Link
              key={w.id}
              href={`${base}/${w.id}`}
              data-testid={`workflow-row-${w.id}`}
              className={cn(
                'flex items-start gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-card-2 lg:px-[18px] lg:py-[13px]',
                COLUMNS,
              )}
            >
              <span className="flex min-w-0 flex-1 items-start gap-2.5">
                <KindTile tone="act" icon={workflowIcon(w)} />
                <span className="flex min-w-0 flex-col gap-[5px]">
                  <span className="truncate text-[15px] font-semibold leading-tight lg:text-sm lg:font-medium">
                    {w.name}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <SourceChips source={w.source} />
                    <span className="text-xs text-text-3 lg:hidden">{w.trigger.summary}</span>
                  </span>
                </span>
              </span>
              <span className="hidden items-start gap-2 text-[13px] text-text-2 lg:flex">
                <Trig className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
                <span className="min-w-0">{w.trigger.summary}</span>
              </span>
              <span className="hidden flex-col lg:flex">
                {w.activeVersion ? (
                  <>
                    <span className="text-[13px] font-semibold">
                      Version {w.activeVersion.version}
                    </span>
                    <span className="text-xs text-text-3">
                      {w.tested ? 'Draft tested' : 'Draft has changes'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-[13px]">Not published yet</span>
                    <span className="text-xs text-text-3">Run a test to publish it</span>
                  </>
                )}
              </span>
              <span className="hidden text-[13px] text-text-2 lg:block">
                {relativeTime(w.updatedAt)}
              </span>
              <span className="flex flex-none flex-col items-end gap-1 lg:items-start">
                <WorkflowStatusBadge status={w.status} />
                <span className="text-xs text-text-3 lg:hidden">
                  {w.activeVersion ? `v${w.activeVersion.version}` : 'Not published'}
                </span>
              </span>
            </Link>
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
