/**
 * The workflow engine's limits and job names (plan: "Loops and fan-out", "Engine"). One `workflow.step` job per
 * run is its cursor; the others arm schedules and date triggers, release held runs and prune old step logs.
 */

/** A run started by another run's event is one deeper; past this, nothing starts. */
export const MAX_DEPTH = 3;
/** Runs still going per workflow; enrolling past this is refused and logged. */
export const MAX_LIVE_RUNS = 5_000;
/** Each pass of a run's job does at most this many steps, or this much time, then yields. */
export const JOB_STEP_BUDGET = 20;
export const JOB_TIME_BUDGET_MS = 10_000;
/** Steps one run may take in its life (goto loops included). */
export const MAX_RUN_STEPS = 200;
/** Tries of a step that keeps failing for a passing reason before it's dead (each manual Retry adds as many). */
export const MAX_STEP_ATTEMPTS = 5;
/** Held runs released per batch on Resume, and people enrolled per page by a schedule. */
export const BATCH = 200;
/** A batch's start times are spread over this long. */
export const SPREAD_MS = 60_000;
/** "Send to me" test runs shrink every wait to this. */
export const TEST_WAIT_MS = 5_000;
/** A customer who texted or called in this long may be texted back without having opted in. */
export const RECENT_CONTACT_MS = 24 * 3_600_000;
/** A text held for quiet hours goes out up to this long after they end. */
export const QUIET_JITTER_MS = 5 * 60_000;
/** Step logs of runs that ended longer ago than this are deleted. */
export const RETENTION_DAYS = 180;
/** A due time a little ahead still counts as now (clocks and rounding). */
export const EARLY_MS = 250;

export const LIVE_STATUSES = ['running', 'waiting', 'awaiting_approval', 'held'] as const;
export type RunStatus = (typeof LIVE_STATUSES)[number] | 'completed' | 'stopped' | 'failed';
export const isLive = (status: string): boolean =>
  (LIVE_STATUSES as readonly string[]).includes(status);

export const JOB = {
  /** A run's cursor: runs its next steps. */
  step: 'workflow.step',
  /** A scheduled workflow's next occurrence. */
  schedule: 'workflow.schedule',
  /** A date trigger for one record ("2 hours after the appointment ends"). */
  date: 'workflow.date',
  /** Releases held runs after Resume, a batch at a time. */
  release: 'workflow.release',
  /** Prunes one workspace's old step logs. */
  retention: 'workflow.retention',
} as const;

export const runJobKey = (runId: string): string => `wf-run:${runId}`;
export const scheduleJobKey = (workflowId: string): string => `wf-sched:${workflowId}`;
export const dateJobKey = (workflowId: string, recordId: string): string =>
  `date:${workflowId}:${recordId}`;
export const releaseJobKey = (workflowId: string): string => `wf-release:${workflowId}`;
export const retentionJobKey = (workspaceId: string): string => `wf-retention:${workspaceId}`;

/** 0 up to `max` milliseconds, so many runs due at once don't all go at the same instant. */
export const jitter = (max: number): number => Math.floor(Math.random() * max);
