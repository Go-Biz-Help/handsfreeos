import type { WorkflowRunListBody, WorkflowRunStatus } from '@/lib/api/types';

/** The Runs page's filters, kept in the address so a link (a tile, a reload) opens the same view. */
export type RunStatusFilter =
  'all' | 'waiting' | 'awaiting_approval' | 'failed' | 'completed' | 'stopped';
export type RunRange = '1d' | '7d' | '30d' | 'all';

export interface RunFilters {
  readonly workflowId: string | null;
  readonly status: RunStatusFilter;
  /** Test runs instead of real ones. */
  readonly tests: boolean;
  readonly range: RunRange;
}

export const DEFAULT_RUN_FILTERS: RunFilters = {
  workflowId: null,
  status: 'all',
  tests: false,
  range: '30d',
};

const STATUS_OF: Record<RunStatusFilter, WorkflowRunStatus[] | null> = {
  all: null,
  waiting: ['running', 'waiting', 'held'],
  awaiting_approval: ['awaiting_approval'],
  failed: ['failed'],
  completed: ['completed'],
  stopped: ['stopped'],
};
const RANGE_MS: Record<RunRange, number | null> = {
  '1d': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  all: null,
};
const UUID = /^[0-9a-f-]{36}$/i;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseRunFilters(q: Record<string, string | string[] | undefined>): RunFilters {
  const status = one(q.status);
  const range = one(q.range);
  const workflow = one(q.workflow);
  return {
    workflowId: workflow && UUID.test(workflow) ? workflow : null,
    status: status && status in STATUS_OF ? (status as RunStatusFilter) : 'all',
    tests: one(q.tests) === '1',
    range: range && range in RANGE_MS ? (range as RunRange) : '30d',
  };
}

export function runFiltersQuery(f: RunFilters): string {
  const p = new URLSearchParams();
  if (f.workflowId) p.set('workflow', f.workflowId);
  if (f.status !== 'all') p.set('status', f.status);
  if (f.tests) p.set('tests', '1');
  if (f.range !== '30d') p.set('range', f.range);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function isDefaultRunView(f: RunFilters): boolean {
  return !f.workflowId && !f.tests && f.range === '30d';
}

/** The run_list body for these filters, 25 at a time. */
export function runListBody(
  workspaceId: string,
  f: RunFilters,
  now: number,
  cursor?: string,
): WorkflowRunListBody {
  const statuses = STATUS_OF[f.status];
  const ms = RANGE_MS[f.range];
  return {
    workspaceId,
    limit: 25,
    ...(f.workflowId ? { workflowId: f.workflowId } : {}),
    ...(statuses ? { status: statuses } : {}),
    ...(f.tests ? { onlyTests: true } : {}),
    ...(ms ? { startedAfter: new Date(now - ms).toISOString() } : {}),
    ...(cursor ? { cursor } : {}),
  };
}
