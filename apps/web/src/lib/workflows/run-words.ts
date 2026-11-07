import {
  allSteps,
  isLiveRun,
  latestRows,
  stepNote,
  type WorkflowDefinition,
  type WorkflowNames,
} from '@hfos/core';
import type { StepOverlay } from '@/components/workflows/step-list';
import type { WorkflowRunDetail, WorkflowRunStep } from '@/lib/api/types';

/**
 * Runs and test logs in plain words. The words live once in core (packages/core/src/workflows/run-words.ts), so the
 * Assistant says what these screens say; this keeps the names the Test tab, run detail and the customer page's
 * Workflows card use, and adds the step list's marks.
 */
export {
  decisionLines,
  decisionsOf,
  endReasonText,
  failedStep,
  isLiveRun as isLive,
  knowledgeUsed,
  latestRows,
  LIVE_RUN,
  messageOf,
  RUN_STATUS,
  runClockSeconds as clockSeconds,
  runClockText as clockText,
  runLine,
  runTruncate as truncate,
  runWhenText as whenText,
  skipReasonText,
  stepKeyParts,
  stepNote,
  testOutcome,
  type RunDecision as Decision,
  type RunTestOutcome as TestOutcome,
} from '@hfos/core';

const OVERLAY: Record<WorkflowRunStep['status'], NonNullable<StepOverlay['status']>> = {
  running: 'running',
  done: 'done',
  skipped: 'skipped',
  waiting: 'waiting',
  failed: 'failed',
  dead: 'failed',
};

/**
 * The step list's marks for a run: each step it reached with its status and note; once the run is over, the
 * steps it never reached. A held run shows where it will pick up.
 */
export function runOverlays(
  def: WorkflowDefinition,
  run: Pick<WorkflowRunDetail, 'status' | 'cursor'>,
  steps: readonly WorkflowRunStep[],
  opts: { timeZone: string; names: WorkflowNames },
): Record<string, StepOverlay> {
  const out: Record<string, StepOverlay> = {};
  const rows = latestRows(steps);
  for (const loc of allSteps(def)) {
    const row = rows.get(loc.step.id);
    if (row) {
      out[loc.step.id] = {
        status: OVERLAY[row.status],
        note: stepNote(loc.step, row, { ...opts, def }),
      };
    } else if (run.status === 'held' && run.cursor === loc.step.id) {
      out[loc.step.id] = { status: 'waiting', note: 'Held here while the workflow is paused' };
    } else if (!isLiveRun(run.status)) {
      out[loc.step.id] = { status: 'not_reached' };
    }
  }
  return out;
}
