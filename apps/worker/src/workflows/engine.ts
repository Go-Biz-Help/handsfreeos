/**
 * The `workflow.step` job: one pending job per run is its cursor.
 *
 * Each pass loads the run (locked) and the definition it follows, then runs steps one transaction each, up to
 * JOB_STEP_BUDGET steps or JOB_TIME_BUDGET_MS, before yielding. Before every step: a paused workflow holds
 * the run (status held, no reschedule; Resume releases it); an archived one stops it; a run past its maximum
 * days, its step limit, or whose stop-on already happened is stopped.
 *
 * A step is claimed with INSERT … ON CONFLICT (run_id, step_key) DO UPDATE … WHERE status IN ('running',
 * 'failed'), so a step already done is never done again: it just advances by its stored next step. Step keys
 * are "<stepId>#<visit>". The step's work, its row and the run's new cursor, visits and context commit
 * together; outgoing webhooks, email and AI run between two transactions and commit under the step's key.
 *
 * Errors: a refusal (a rule, or anything a person must fix) isn't retried: the step's onError stops the run
 * (failed) or carries on (the step skipped, the error kept). Anything else is retried with the outbox's
 * backoff times jitter, by rescheduling this same job, so the cursor never dies; after MAX_STEP_ATTEMPTS the
 * step is dead, the run failed, and the business's own owners and admins get an email (workspaceManagers).
 * Retry and Skip revive it.
 */
import {
  ACTION_LABELS,
  aiOutputKey,
  findStep,
  laneSteps,
  nextStep,
  workspaceZone,
  type AiStep,
  type AnyConditionGroup,
  type BranchStep,
  type NextStep,
  type Step,
  type WaitStep,
  type WaitUntil,
  type WorkflowActor,
  type WorkflowDefinition,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { workflowRuns, workflowRunSteps, workflows } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { workspaceManagers } from '../handlers/telephony';
import type { JobHandler } from '../jobs';
import { backoffMs, errorMessage } from '../outbox';
import { tenantOf, type TenantScope } from '../services';
import { runAction } from './actions';
import {
  fallbackCategory,
  unavailableAiRunner,
  type AiStepInput,
  type AiStepResult,
  type AiStepTask,
} from './ai-step';
import { anchorRecord, readAnchor } from './anchors';
import {
  EARLY_MS,
  isLive,
  JOB_STEP_BUDGET,
  JOB_TIME_BUDGET_MS,
  MAX_RUN_STEPS,
  MAX_STEP_ATTEMPTS,
  TEST_WAIT_MS,
} from './constants';
import { RunData } from './data';
import { runDefinition } from './defs';
import { lateAfterWait, lateContext, lateMsOf, type Late } from './late';
import { runFailedEmail } from './emails';
import { endRun, pruneStepLogs, type EndedRun } from './runs';
import { openApproval, resumeApproval } from './approvals';
import {
  isRefusal,
  refusedFrom,
  type ContextPatch,
  type EngineServices,
  type ExecCtx,
  type Json,
  type Outcome,
  type RefsPatch,
  type RunRow,
  type SlowWork,
  type StepError,
  type StepRow,
  type WorkflowInfo,
} from './types';
import { addDuration, dateOffsetInstant, nextTimeOfDay } from './waits';
import { deliverWebhook, type Delivered } from './webhooks';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

type Tick =
  | { readonly kind: 'next' }
  | { readonly kind: 'at'; readonly at: number }
  | { readonly kind: 'stop' };
const NEXT: Tick = { kind: 'next' };
const STOP: Tick = { kind: 'stop' };

interface Claimed {
  readonly stepKey: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly manualRetries: number;
}

const endedOf = (run: RunRow): EndedRun => ({
  id: run.id,
  workflowId: run.workflowId,
  personId: run.personId,
  isTest: run.isTest,
  testRevision: run.testRevision,
});

function contextOf(run: RunRow): Json {
  return isRecord(run.context) ? (run.context as Json) : {};
}

/** Group-by-group merge: a patch's records merge into the context's, null removes a key. */
export function mergeContext(base: Json, patch: ContextPatch | undefined): Json {
  if (!patch) return base;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (isRecord(v) && isRecord(out[k])) out[k] = { ...(out[k] as Json), ...v };
    else out[k] = v;
  }
  return out;
}

const assumeOf = (context: Json): Record<string, unknown> =>
  isRecord(context['assume']) ? (context['assume'] as Record<string, unknown>) : {};

// ---- Loading ----

async function lockRun(tx: Tx, runId: string): Promise<RunRow | null> {
  const [run] = await tx
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .for('update');
  return run ?? null;
}

async function workflowInfo(tx: Tx, id: string): Promise<WorkflowInfo | null> {
  const [w] = await tx
    .select({ id: workflows.id, name: workflows.name, status: workflows.status })
    .from(workflows)
    .where(eq(workflows.id, id));
  return w ?? null;
}

const STEP_COLUMNS = sql`id, status::text as status, attempt, output, error, next_step_key`;

/** Claims a step: a new row, or a running or failed one again (one more attempt). Otherwise the row as it is. */
async function claim(
  tx: Tx,
  workspaceId: string,
  runId: string,
  stepKey: string,
): Promise<StepRow> {
  const [row] = await rows<StepRow & Record<string, unknown>>(
    tx,
    sql`insert into app.workflow_run_steps (workspace_id, run_id, step_key, status, attempt, started_at)
        values (${workspaceId}, ${runId}, ${stepKey}, 'running', 1, now())
        on conflict (run_id, step_key) do update
          set status = 'running', attempt = least(app.workflow_run_steps.attempt + 1, 100),
            started_at = now(), finished_at = null
          where app.workflow_run_steps.status in ('running', 'failed')
        returning ${STEP_COLUMNS}`,
  );
  if (row) return row;
  return (await stepRow(tx, runId, stepKey))!;
}

async function stepRow(tx: Tx, runId: string, stepKey: string): Promise<StepRow | null> {
  const [row] = await rows<StepRow & Record<string, unknown>>(
    tx,
    sql`select ${STEP_COLUMNS} from app.workflow_run_steps where run_id = ${runId} and step_key = ${stepKey}`,
  );
  return row ?? null;
}

const manualRetriesOf = (row: StepRow): number => {
  const n = row.output?.['manualRetries'];
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
};

/** Whether a stop-on already happened since the run began (the dispatcher may not have seen it yet). */
async function stopOnHappened(tx: Tx, run: RunRow): Promise<string | null> {
  if (run.isTest || !run.stopOn.length) return null;
  const since = run.startedAt.toISOString();
  for (const key of run.stopOn) {
    if (key === 'reply' && run.personId) {
      const hit = await rows(
        tx,
        sql`select 1 from app.messages m join app.conversations c on c.id = m.conversation_id
            where c.workspace_id = ${run.workspaceId} and c.person_id = ${run.personId}
              and m.direction = 'inbound' and m.occurred_at > ${since}::timestamptz
            limit 1`,
      );
      if (hit.length) return key;
    }
    if (key === 'booking' && run.personId) {
      const hit = await rows(
        tx,
        sql`select 1 from app.appointment_attendees a
            where a.workspace_id = ${run.workspaceId} and a.person_id = ${run.personId}
              and a.status in ('booked', 'attended') and a.created_at > ${since}::timestamptz
            limit 1`,
      );
      if (hit.length) return key;
    }
    if ((key === 'lead_won' || key === 'lead_lost') && run.leadId) {
      const column = key === 'lead_won' ? sql`won_at` : sql`lost_at`;
      const hit = await rows(
        tx,
        sql`select 1 from app.leads where id = ${run.leadId} and ${column} > ${since}::timestamptz limit 1`,
      );
      if (hit.length) return key;
    }
  }
  return null;
}

function execCtx(
  s: EngineServices,
  tx: Tx,
  scope: TenantScope,
  run: RunRow,
  def: WorkflowDefinition,
  workflow: WorkflowInfo,
  step: Step,
  stepKey: string,
  attempt: number,
  now: number,
  timeZone: string,
  log: Logger,
): ExecCtx {
  const context = contextOf(run);
  const actor: WorkflowActor = {
    type: 'workflow',
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
    workflowId: run.workflowId,
    versionId: run.versionId,
    runId: run.id,
    stepKey,
    depth: run.depth,
    originRunId: run.originRunId,
    workflowName: workflow.name,
    test: run.isTest,
  };
  return {
    s,
    tx,
    scope,
    run,
    context,
    def,
    workflow,
    step,
    stepKey,
    attempt,
    now,
    timeZone,
    data: new RunData(
      tx,
      {
        workspaceId: scope.workspaceId,
        personId: run.personId,
        leadId: run.leadId,
        appointmentId: run.appointmentId,
        conversationId: run.conversationId,
      },
      { timeZone, webUrl: s.webUrl, workflowName: workflow.name, context },
    ),
    actor,
    meta: { correlationId: run.id, causationId: run.triggerEventId ?? null, channel: 'workflow' },
    testMode: run.isTest ? run.testMode : null,
    log: log.child({ runId: run.id, stepKey }),
  };
}

type Prepared = { readonly tick: Tick } | { readonly ec: ExecCtx; readonly row: StepRow };

/**
 * Locks the run and gets its step ready. 'claim' runs the checks before a step and claims it; 'finish' (the
 * second half of slow work, or a refusal recorded after a rollback) only checks the run is still on that step.
 */
async function prepare(
  s: EngineServices,
  tx: Tx,
  scope: TenantScope,
  runId: string,
  now: number,
  log: Logger,
  mode: { readonly kind: 'claim' } | { readonly kind: 'finish'; readonly claimed: Claimed },
): Promise<Prepared> {
  const run = await lockRun(tx, runId);
  if (!run || !isLive(run.status)) return { tick: STOP };
  const workflow = await workflowInfo(tx, run.workflowId);
  if (!workflow) return { tick: STOP };
  const end = async (
    status: 'completed' | 'stopped' | 'failed',
    reason: string,
  ): Promise<Prepared> => {
    await endRun(tx, scope, endedOf(run), status, reason);
    return { tick: STOP };
  };
  let def: WorkflowDefinition;
  try {
    def = await runDefinition(tx, run);
  } catch (e) {
    log.error({ runId, err: errorMessage(e) }, 'a workflow run’s definition can’t be read');
    return end('failed', 'definition_unreadable');
  }
  if (mode.kind === 'finish') {
    const loc = findStep(def, mode.claimed.stepId);
    const row = await stepRow(tx, run.id, mode.claimed.stepKey);
    if (!loc || !row || run.cursor !== mode.claimed.stepId) return { tick: STOP };
    const tz = await workspaceZone(tx, scope.workspaceId);
    return {
      ec: execCtx(
        s,
        tx,
        scope,
        run,
        def,
        workflow,
        loc.step,
        mode.claimed.stepKey,
        row.attempt,
        now,
        tz,
        log,
      ),
      row,
    };
  }
  if (workflow.status === 'archived') return end('stopped', 'workflow_archived');
  if (!run.isTest && workflow.status === 'paused') {
    // Held at its next step; Resume releases it.
    await tx.update(workflowRuns).set({ status: 'held' }).where(eq(workflowRuns.id, run.id));
    return { tick: STOP };
  }
  if (!run.cursor) return end('completed', 'finished');
  if (!run.isTest && now > run.startedAt.getTime() + def.settings.maxRunDays * DAY)
    return end('stopped', 'max_days');
  if (run.stepCount >= MAX_RUN_STEPS) return end('stopped', 'step_limit');
  const stopped = await stopOnHappened(tx, run);
  if (stopped) return end('stopped', `stop_on:${stopped}`);
  const loc = findStep(def, run.cursor);
  if (!loc) return end('failed', 'step_missing');
  const stepKey = `${run.cursor}#${run.visits[run.cursor] ?? 1}`;
  const row = await claim(tx, scope.workspaceId, run.id, stepKey);
  const tz = await workspaceZone(tx, scope.workspaceId);
  return {
    ec: execCtx(s, tx, scope, run, def, workflow, loc.step, stepKey, row.attempt, now, tz, log),
    row,
  };
}

// ---- Walking ----

/** Past a branch block whose paths all said no: the step after it, or up and out. */
function afterBlock(def: WorkflowDefinition, stepId: string): NextStep {
  const loc = findStep(def, stepId);
  if (!loc) return { kind: 'end', reason: 'finished' };
  const next = (laneSteps(def, loc.lane) ?? [])[loc.index + 1];
  if (next) return { kind: 'step', stepId: next.id };
  if (loc.laneKind === 'root') return { kind: 'end', reason: 'finished' };
  if (loc.laneKind === 'rejected') return { kind: 'end', reason: 'rejected' };
  return afterBlock(def, loc.lane.parentId!);
}

type Walk = { readonly branchId?: string | null; readonly approved?: boolean } | null;

/** What runs next. A null walk is a skipped step: a branch's last path, an approval's go-ahead, no jump. */
function nextOf(
  def: WorkflowDefinition,
  step: Step,
  visits: Record<string, number>,
  walk: Walk,
): NextStep {
  if (step.type === 'branch') {
    const branchId = walk === null ? step.branches.at(-1)!.id : walk.branchId;
    return branchId ? nextStep(def, step.id, { branchId }) : afterBlock(def, step.id);
  }
  if (step.type === 'approval')
    return nextStep(def, step.id, { approved: walk === null ? true : walk.approved !== false });
  if (step.type === 'goto')
    return nextStep(def, step.id, {
      visits: walk === null ? Number.MAX_SAFE_INTEGER : (visits[step.id] ?? 1) - 1,
    });
  return nextStep(def, step.id);
}

// ---- Writing ----

interface StepWrite {
  readonly status: StepRow['status'];
  readonly output?: Json | null;
  readonly input?: Json | null;
  readonly error?: StepError | Json | null;
  readonly eventIds?: readonly string[];
  readonly tokens?: number;
  readonly nextKey?: string | null;
  readonly finished?: boolean;
}

async function writeStep(tx: Tx, id: string, w: StepWrite): Promise<void> {
  await tx
    .update(workflowRunSteps)
    .set({
      status: w.status,
      ...(w.output !== undefined ? { output: w.output as Record<string, unknown> | null } : {}),
      ...(w.input ? { input: w.input as Record<string, unknown> } : {}),
      error: (w.error ?? null) as Record<string, unknown> | null,
      ...(w.eventIds ? { eventIds: [...w.eventIds].slice(0, 50) } : {}),
      ...(w.tokens !== undefined ? { tokens: Math.max(0, Math.round(w.tokens)) } : {}),
      ...(w.nextKey !== undefined ? { nextStepKey: w.nextKey } : {}),
      ...(w.finished ? { finishedAt: new Date() } : {}),
    })
    .where(eq(workflowRunSteps.id, id));
}

const refsOf = (run: RunRow, patch: RefsPatch | undefined) => ({
  leadId: patch?.leadId ?? run.leadId,
  conversationId: patch?.conversationId ?? run.conversationId,
});

/** Records the step and moves the run to what runs next (or ends it). */
async function advance(
  ec: ExecCtx,
  row: StepRow,
  w: StepWrite,
  walk: Walk,
  context: Json,
  refs: { leadId: string | null; conversationId: string | null },
): Promise<Tick> {
  const { run, def, step } = ec;
  const next = nextOf(def, step, run.visits, walk);
  let visits = run.visits;
  let nextKey: string | null = null;
  if (next.kind === 'step') {
    const n = (visits[next.stepId] ?? 0) + 1;
    visits = { ...visits, [next.stepId]: n };
    nextKey = `${next.stepId}#${n}`;
  }
  const output =
    step.type === 'goto'
      ? {
          ...(w.output ?? {}),
          target: step.target,
          jumped: next.kind === 'step' && next.stepId === step.target,
        }
      : (w.output ?? {});
  await writeStep(ec.tx, row.id, { ...w, output, nextKey, finished: true });
  await ec.tx
    .update(workflowRuns)
    .set({
      cursor: next.kind === 'step' ? next.stepId : run.cursor,
      visits,
      stepCount: run.stepCount + 1,
      context,
      status: 'running',
      waitingFor: [],
      leadId: refs.leadId,
      conversationId: refs.conversationId,
    })
    .where(eq(workflowRuns.id, run.id));
  if (next.kind === 'end') {
    await endRun(ec.tx, ec.scope, endedOf(run), 'completed', next.reason);
    return STOP;
  }
  return NEXT;
}

/** Commits what a step came back with. */
async function settle(ec: ExecCtx, row: StepRow, o: Outcome): Promise<Tick> {
  const { tx, run, step } = ec;
  const context = mergeContext(ec.context, o.context);
  const refs = refsOf(run, o.refs);
  const input = o.input ?? null;
  switch (o.kind) {
    case 'done':
      return advance(
        ec,
        row,
        {
          status: 'done',
          output: o.output,
          input,
          eventIds: o.eventIds ?? [],
          tokens: o.tokens ?? 0,
        },
        o.walk ?? {},
        context,
        refs,
      );
    case 'skipped':
      return advance(
        ec,
        row,
        { status: 'skipped', output: { ...o.output, skipped: o.reason }, input },
        null,
        context,
        refs,
      );
    case 'wait': {
      await writeStep(tx, row.id, { status: 'waiting', output: o.output, input });
      await tx
        .update(workflowRuns)
        .set({
          status: o.runStatus,
          waitingFor: [...(o.waitingFor ?? [])],
          context,
          leadId: refs.leadId,
          conversationId: refs.conversationId,
        })
        .where(eq(workflowRuns.id, run.id));
      // A run past its maximum days stops when it next wakes.
      const deadline = run.isTest
        ? Infinity
        : run.startedAt.getTime() + ec.def.settings.maxRunDays * DAY + 1000;
      return { kind: 'at', at: Math.min(o.until, deadline) };
    }
    case 'refused': {
      const onError = step.type === 'action' ? step.onError : 'stop';
      if (onError === 'continue')
        return advance(
          ec,
          row,
          {
            status: 'skipped',
            output: { ...o.output, skipped: 'refused', rule: o.error.rule ?? o.error.code },
            input,
            error: o.error,
          },
          null,
          context,
          refs,
        );
      await writeStep(tx, row.id, {
        status: 'failed',
        output: o.output ?? null,
        input,
        error: o.error,
        finished: true,
      });
      await endRun(tx, ec.scope, endedOf(run), 'failed', o.error.rule ?? o.error.code);
      return STOP;
    }
    case 'end':
      await writeStep(tx, row.id, {
        status: 'done',
        output: { ...o.output, end: o.reason },
        input,
        nextKey: null,
        finished: true,
      });
      await tx
        .update(workflowRuns)
        .set({
          context,
          stepCount: run.stepCount + 1,
          leadId: refs.leadId,
          conversationId: refs.conversationId,
        })
        .where(eq(workflowRuns.id, run.id));
      await endRun(tx, ec.scope, endedOf(run), 'completed', o.reason);
      return STOP;
    case 'slow':
      throw new Error('slow work is performed before it settles');
  }
}

/** The step at the cursor was already done or skipped (a crash in between, or Skip): move on from it. */
async function advanceFromLog(ec: ExecCtx, row: StepRow): Promise<Tick> {
  if (row.next_step_key) {
    const at = row.next_step_key.lastIndexOf('#');
    const stepId = row.next_step_key.slice(0, at);
    const visit = Number(row.next_step_key.slice(at + 1));
    await ec.tx
      .update(workflowRuns)
      .set({
        cursor: stepId,
        visits: { ...ec.run.visits, [stepId]: visit },
        status: 'running',
        waitingFor: [],
      })
      .where(eq(workflowRuns.id, ec.run.id));
    return NEXT;
  }
  if (row.status === 'skipped')
    return advance(
      ec,
      row,
      { status: 'skipped', output: row.output ?? {} },
      null,
      ec.context,
      refsOf(ec.run, undefined),
    );
  const end = row.output?.['end'];
  await endRun(
    ec.tx,
    ec.scope,
    endedOf(ec.run),
    'completed',
    typeof end === 'string' ? end : 'finished',
  );
  return STOP;
}

// ---- Steps ----

/**
 * When a wait wakes. Durations and times of day count from when the run's steps were meant to happen: a run started
 * by an event that reached HandsFreeOS late counts from when it really happened (late.ts).
 */
async function wakeFor(ec: ExecCtx, u: WaitUntil): Promise<number | null> {
  const from = ec.now - lateMsOf(ec.context);
  switch (u.kind) {
    case 'duration':
      return addDuration(from, u.duration, ec.timeZone);
    case 'time_of_day':
      return nextTimeOfDay(from, u.at, u.days, ec.timeZone);
    case 'date_field': {
      const record = anchorRecord(u.anchor);
      const id =
        record === 'person'
          ? ec.run.personId
          : record === 'lead'
            ? ec.run.leadId
            : ec.run.appointmentId;
      const anchor = await readAnchor(ec.tx, ec.scope.workspaceId, u.anchor, id);
      return anchor === null ? null : dateOffsetInstant(anchor, u.offset, u.at, ec.timeZone);
    }
    case 'event':
      return addDuration(from, u.timeout, ec.timeZone);
  }
}

async function startWait(ec: ExecCtx): Promise<Outcome> {
  const u = (ec.step as WaitStep).until;
  const isEvent = u.kind === 'event';
  if (ec.testMode === 'simulate') {
    // Fast-forward: log when it would wake, and carry on. An event wait times out unless the test assumes not.
    const at = await wakeFor(ec, u);
    const assumed = assumeOf(ec.context)['wait.timed_out'];
    const timedOut = typeof assumed === 'boolean' ? assumed : true;
    return {
      kind: 'done',
      output: {
        kind: u.kind,
        wakeAt: at === null ? null : iso(at),
        fastForwarded: true,
        ...(isEvent ? { timedOut } : {}),
      },
      ...(isEvent ? { context: { wait: { timed_out: timedOut, event: null, at: null } } } : {}),
    };
  }
  const at = ec.testMode === 'send_to_me' ? ec.now + TEST_WAIT_MS : await wakeFor(ec, u);
  if (at === null) return { kind: 'done', output: { kind: u.kind, anchorMissing: true } };
  if (!isEvent && at <= ec.now + EARLY_MS)
    return {
      kind: 'done',
      output: { kind: u.kind, wakeAt: iso(at), alreadyPast: true },
      // Already past: a late run stays as far behind as the wait's time is.
      context: lateContext(lateAfterWait(ec.context, at, ec.now)),
    };
  return {
    kind: 'wait',
    until: at,
    runStatus: 'waiting',
    output: { kind: u.kind, wakeAt: iso(at), ...(isEvent ? { events: u.events } : {}) },
    ...(isEvent ? { waitingFor: u.events, context: { _woke: null } } : {}),
  };
}

async function resumeWait(ec: ExecCtx, row: StepRow): Promise<Outcome> {
  const u = (ec.step as WaitStep).until;
  const out = row.output ?? {};
  const stored = typeof out['wakeAt'] === 'string' ? Date.parse(out['wakeAt']) : ec.now;
  if (u.kind === 'event') {
    const woke = ec.context['_woke'];
    if (isRecord(woke) && woke['stepKey'] === ec.stepKey) {
      const conversationId =
        typeof woke['conversationId'] === 'string' ? woke['conversationId'] : null;
      // What happened just now wakes it: the run is as far behind as that event reached HandsFreeOS late.
      const late = isRecord(woke['late']) ? (woke['late'] as unknown as Late) : null;
      return {
        kind: 'done',
        output: { ...out, timedOut: false, event: woke['event'] ?? null, at: woke['at'] ?? null },
        context: {
          wait: { timed_out: false, event: woke['event'] ?? null, at: woke['at'] ?? null },
          _woke: null,
          _late: late,
        },
        ...(conversationId && !ec.run.conversationId ? { refs: { conversationId } } : {}),
      };
    }
    if (ec.now >= stored - EARLY_MS)
      return {
        kind: 'done',
        output: { ...out, timedOut: true },
        context: {
          wait: { timed_out: true, event: null, at: null },
          _woke: null,
          ...lateContext(lateAfterWait(ec.context, stored, ec.now)),
        },
      };
    return { kind: 'wait', until: stored, runStatus: 'waiting', output: out, waitingFor: u.events };
  }
  let at = stored;
  if (u.kind === 'date_field' && ec.testMode === null) {
    // The date may have moved (a rescheduled appointment): read it again.
    const fresh = await wakeFor(ec, u);
    if (fresh === null) return { kind: 'done', output: { ...out, anchorMissing: true } };
    at = fresh;
  }
  if (ec.now >= at - EARLY_MS)
    return {
      kind: 'done',
      output: { ...out, wakeAt: iso(at), wokeAt: iso(ec.now) },
      context: lateContext(lateAfterWait(ec.context, at, ec.now)),
    };
  return { kind: 'wait', until: at, runStatus: 'waiting', output: { ...out, wakeAt: iso(at) } };
}

async function aiInput(ec: ExecCtx, task: AiStepTask): Promise<AiStepInput> {
  const step = ec.step;
  const facts: Record<string, string> = {};
  const paths = [
    'person.first_name',
    'lead.title',
    'appointment.title',
    'appointment.starts_at',
    'business.name',
  ];
  await ec.data.need(paths);
  for (const p of paths) {
    const v = ec.data.value(p);
    if (typeof v === 'string' && v) facts[p] = v;
  }
  const conv = await ec.data.conversation();
  return {
    workspaceId: ec.scope.workspaceId,
    organizationId: ec.scope.organizationId,
    workflowId: ec.run.workflowId,
    runId: ec.run.id,
    stepKey: ec.stepKey,
    task,
    prompt: step.type === 'ai' ? step.prompt : '',
    categories: step.type === 'ai' ? step.categories : [],
    branches:
      step.type === 'branch'
        ? step.branches.map((b) => ({
            id: b.id,
            name: b.name,
            description: b.description ?? b.name,
          }))
        : [],
    channel: step.type === 'ai' ? step.channel : 'sms',
    useKnowledge: step.type === 'ai' ? step.useKnowledge : true,
    customerMessage: conv?.last_message ?? null,
    facts,
    test: ec.run.isTest,
    attempt: ec.attempt,
    actor: ec.actor,
  };
}

async function branch(ec: ExecCtx): Promise<Outcome> {
  const step = ec.step as BranchStep;
  if (step.mode !== 'ai') {
    for (const b of step.branches)
      if (b.condition === null || (await ec.data.passes(b.condition as AnyConditionGroup, ec.now)))
        return {
          kind: 'done',
          walk: { branchId: b.id },
          output: {
            branchId: b.id,
            branch: b.name,
            matched: b.condition ? 'condition' : 'otherwise',
          },
        };
    return { kind: 'done', walk: { branchId: null }, output: { branchId: null, matched: 'none' } };
  }
  const forced = assumeOf(ec.context)[`branch.${step.id}`];
  if (typeof forced === 'string') {
    const b = step.branches.find(
      (x) => x.id === forced || x.name.toLowerCase() === forced.toLowerCase(),
    );
    if (b)
      return {
        kind: 'done',
        walk: { branchId: b.id },
        output: { branchId: b.id, branch: b.name, matched: 'assumed' },
      };
  }
  return { kind: 'slow', work: { kind: 'ai', input: await aiInput(ec, 'decide') } };
}

async function aiStep(ec: ExecCtx): Promise<Outcome> {
  const step = ec.step as AiStep;
  const key = aiOutputKey(step);
  const forced = assumeOf(ec.context)[`ai.${key}`];
  if (typeof forced === 'string')
    return {
      kind: 'done',
      output: { task: step.task, key, value: forced, assumed: true },
      context: { ai: { [key]: forced } },
    };
  return { kind: 'slow', work: { kind: 'ai', input: await aiInput(ec, step.task) } };
}

const WRITE_CAP = { sms: 1600, email: 10_000 } as const;

/** What an AI answer (or the lack of one) means for the step: its value, or the fallback, and why. */
function aiOutcome(ec: ExecCtx, r: AiStepResult): Outcome {
  const step = ec.step;
  // The knowledge it used: ids, and each item's kind and title for the run's log ("Knowledge used").
  const extra = r.ok
    ? {
        ...(r.itemIds ? { itemIds: [...r.itemIds] } : {}),
        ...(r.items?.length
          ? { items: r.items.map((i) => ({ id: i.id, kind: i.kind, title: i.title })) }
          : {}),
        ...(r.gapSuggestionId ? { gapSuggestionId: r.gapSuggestionId } : {}),
        ...(r.model ? { model: r.model } : {}),
      }
    : {};
  if (step.type === 'branch') {
    const pick = r.ok ? step.branches.find((b) => b.id === r.value) : undefined;
    const b = pick ?? step.branches.at(-1)!;
    return {
      kind: 'done',
      walk: { branchId: b.id },
      tokens: r.tokens ?? 0,
      output: {
        branchId: b.id,
        branch: b.name,
        matched: pick ? 'ai' : 'fallback',
        ...(pick
          ? { reason: r.ok ? (r.reason ?? null) : null }
          : { fallbackReason: r.ok ? 'invalid_choice' : r.reason }),
        ...extra,
      },
    };
  }
  const ai = step as AiStep;
  const key = aiOutputKey(ai);
  let value: string | null;
  let reason: string | null = null;
  if (r.ok && ai.task === 'classify') {
    const m = ai.categories.find((c) => c.toLowerCase() === r.value.trim().toLowerCase());
    value = m ?? fallbackCategory(ai.categories, ai.fallback);
    if (!m) reason = 'invalid_category';
  } else if (r.ok) {
    value = r.value.trim().slice(0, ai.task === 'write' ? WRITE_CAP[ai.channel] : 4000) || null;
    if (!value) {
      value = ai.fallback;
      reason = 'empty_answer';
    }
  } else {
    reason = r.reason;
    value = ai.task === 'classify' ? fallbackCategory(ai.categories, ai.fallback) : ai.fallback;
  }
  return {
    kind: 'done',
    tokens: r.tokens ?? 0,
    output: {
      task: ai.task,
      key,
      value,
      fallback: reason !== null,
      ...(reason ? { reason } : {}),
      ...extra,
    },
    ...(value !== null ? { context: { ai: { [key]: value } } } : {}),
  };
}

async function execute(ec: ExecCtx): Promise<Outcome> {
  const step = ec.step;
  switch (step.type) {
    case 'action':
      return runAction(ec);
    case 'wait':
      return startWait(ec);
    case 'branch':
      return branch(ec);
    case 'ai':
      return aiStep(ec);
    case 'approval':
      return openApproval(ec);
    case 'goto':
      return { kind: 'done', output: {} };
    case 'end':
      return { kind: 'end', reason: 'end_step', output: {} };
  }
}

async function resume(ec: ExecCtx, row: StepRow): Promise<Outcome> {
  switch (ec.step.type) {
    case 'wait':
      return resumeWait(ec, row);
    case 'approval': {
      const o = await resumeApproval(ec, row);
      // A person decided just now (or it expired as it was meant to): what follows is on time.
      return o.kind === 'wait' || !lateMsOf(ec.context)
        ? o
        : ({ ...o, context: { ...(o.context ?? {}), _late: null } } as Outcome);
    }
    default:
      // A text held for quiet hours: every check runs again.
      return execute(ec);
  }
}

// ---- Slow work ----

type SlowResult =
  | { readonly kind: 'mail' }
  | { readonly kind: 'webhook'; readonly delivered: Delivered }
  | { readonly kind: 'ai'; readonly result: AiStepResult };

async function perform(s: EngineServices, work: SlowWork): Promise<SlowResult> {
  switch (work.kind) {
    case 'mail':
      for (const m of work.messages) await s.mailer.send(m);
      return { kind: 'mail' };
    case 'webhook':
      return { kind: 'webhook', delivered: await deliverWebhook(s.fetchUrl, work) };
    case 'ai':
      return { kind: 'ai', result: await (s.workflowAi ?? unavailableAiRunner).run(work.input) };
  }
}

function slowOutcome(ec: ExecCtx, work: SlowWork, result: SlowResult): Outcome {
  switch (result.kind) {
    case 'mail':
      return { kind: 'done', output: work.kind === 'mail' ? work.output : {} };
    case 'webhook':
      return result.delivered.ok
        ? {
            kind: 'done',
            output: {
              ...result.delivered.output,
              deliveryId: work.kind === 'webhook' ? work.deliveryId : null,
            },
          }
        : { kind: 'refused', error: result.delivered.error };
    case 'ai':
      return aiOutcome(ec, result.result);
  }
}

// ---- Failure ----

function stepLabel(def: WorkflowDefinition | null, stepId: string): string {
  const step = def ? findStep(def, stepId)?.step : null;
  if (!step) return 'a step';
  if (step.type === 'action') return ACTION_LABELS[step.action];
  return {
    wait: 'Wait',
    branch: 'Branch',
    ai: 'AI step',
    approval: 'Approval',
    goto: 'Go to',
    end: 'End',
  }[step.type];
}

/** A step failed for a passing reason: try again later, or after too many tries the step is dead. */
async function failed(
  s: EngineServices,
  scope: TenantScope,
  runId: string,
  claimed: Claimed | null,
  e: unknown,
  now: number,
  log: Logger,
): Promise<Tick> {
  if (!claimed) throw e;
  if (isRefusal(e)) {
    // Refused outside a savepoint (the whole transaction rolled back): record it now, onError decides.
    const st: { after: readonly (() => Promise<void>)[] } = { after: [] };
    const tick = await asWorker(s.db, scope, async (tx) => {
      const prep = await prepare(s, tx, scope, runId, now, log, { kind: 'finish', claimed });
      if ('tick' in prep) return prep.tick;
      await tx.execute(
        sql`update app.workflow_run_steps set attempt = ${claimed.attempt} where id = ${prep.row.id}`,
      );
      return settle(prep.ec, prep.row, refusedFrom(e));
    }).catch(async (again: unknown) => {
      log.error({ runId, err: errorMessage(again) }, 'could not record a refused workflow step');
      return { kind: 'at', at: now + backoffMs(claimed.attempt) } as Tick;
    });
    for (const fn of st.after) await fn();
    return tick;
  }
  const message = errorMessage(e);
  log.warn(
    { runId, stepKey: claimed.stepKey, attempt: claimed.attempt, err: message },
    'workflow step failed',
  );
  const st: { after: (() => Promise<void>)[] } = { after: [] };
  const tick = await asWorker(s.db, scope, async (tx): Promise<Tick> => {
    const run = await lockRun(tx, runId);
    if (!run || !isLive(run.status)) return STOP;
    const dead = claimed.attempt >= MAX_STEP_ATTEMPTS * (1 + claimed.manualRetries);
    const error = {
      message: message.slice(0, 2000),
      code: 'transient',
      rule: null,
      attempt: claimed.attempt,
      at: new Date().toISOString(),
    };
    await tx.execute(
      sql`insert into app.workflow_run_steps (workspace_id, run_id, step_key, status, attempt, error, started_at)
          values (${scope.workspaceId}, ${runId}, ${claimed.stepKey}, ${dead ? 'dead' : 'failed'}::app.workflow_step_status,
            ${claimed.attempt}, ${JSON.stringify(error)}::jsonb, now())
          on conflict (run_id, step_key) do update
            set status = excluded.status, attempt = excluded.attempt, error = excluded.error,
              finished_at = case when excluded.status = 'dead' then now() end`,
    );
    if (!dead)
      return {
        kind: 'at',
        at: now + Math.round(backoffMs(claimed.attempt) * (0.8 + Math.random() * 0.4)),
      };
    await endRun(tx, scope, endedOf(run), 'failed', 'step_failed');
    if (!run.isTest) {
      const def = await runDefinition(tx, run).catch(() => null);
      const people = await workspaceManagers(tx, scope.workspaceId);
      const [w] = await rows<{ name: string }>(
        tx,
        sql`select name from app.workflows where id = ${run.workflowId}`,
      );
      const [p] = run.personId
        ? await rows<{ name: string }>(
            tx,
            sql`select coalesce(nullif(btrim(first_name || ' ' || last_name), ''), 'a customer') as name
                from app.people where id = ${run.personId}`,
          )
        : [];
      const mail = runFailedEmail({
        workflow: w?.name ?? 'A workflow',
        customer: p?.name ?? null,
        step: stepLabel(def, claimed.stepId),
        error: message.slice(0, 500),
        link: `${s.webUrl}/app/w/${scope.workspaceId}/workflows/runs/${run.id}`,
      });
      st.after.push(async () => {
        for (const u of people)
          try {
            await s.mailer.send({ to: u.email, ...mail });
          } catch (err) {
            log.warn(
              { err: errorMessage(err), runId },
              'could not email about a failed workflow run',
            );
          }
      });
    }
    return STOP;
  });
  for (const fn of st.after) await fn();
  return tick;
}

// ---- One step ----

async function stepOnce(
  s: EngineServices,
  scope: TenantScope,
  runId: string,
  now: number,
  log: Logger,
): Promise<Tick> {
  const st: {
    claimed: Claimed | null;
    slow: Extract<Outcome, { kind: 'slow' }> | null;
    after: readonly (() => Promise<void>)[];
  } = { claimed: null, slow: null, after: [] };
  let tick: Tick;
  try {
    tick = await asWorker(s.db, scope, async (tx): Promise<Tick> => {
      const prep = await prepare(s, tx, scope, runId, now, log, { kind: 'claim' });
      if ('tick' in prep) return prep.tick;
      const { ec, row } = prep;
      st.claimed = {
        stepKey: ec.stepKey,
        stepId: ec.step.id,
        attempt: row.attempt,
        manualRetries: manualRetriesOf(row),
      };
      if (row.status === 'done' || row.status === 'skipped') return advanceFromLog(ec, row);
      if (row.status === 'dead') return STOP;
      const outcome = row.status === 'waiting' ? await resume(ec, row) : await execute(ec);
      if (outcome.kind === 'slow') {
        // The claim commits first; the work happens outside any transaction.
        if (outcome.input)
          await tx.execute(
            sql`update app.workflow_run_steps set input = ${JSON.stringify(outcome.input)}::jsonb where id = ${row.id}`,
          );
        st.slow = outcome;
        return NEXT;
      }
      st.after = outcome.after ?? [];
      return settle(ec, row, outcome);
    });
  } catch (e) {
    return failed(s, scope, runId, st.claimed, e, now, log);
  }
  for (const fn of st.after) await fn();
  if (!st.slow || !st.claimed) return tick;
  const claimed = st.claimed;
  const work = st.slow.work;
  let result: SlowResult;
  try {
    result = await perform(s, work);
  } catch (e) {
    return failed(s, scope, runId, claimed, e, now, log);
  }
  try {
    return await asWorker(s.db, scope, async (tx): Promise<Tick> => {
      const prep = await prepare(s, tx, scope, runId, now, log, { kind: 'finish', claimed });
      if ('tick' in prep) return prep.tick;
      if (prep.row.status !== 'running' || prep.row.attempt !== claimed.attempt) return NEXT;
      return settle(prep.ec, prep.row, slowOutcome(prep.ec, work, result));
    });
  } catch (e) {
    return failed(s, scope, runId, claimed, e, now, log);
  }
}

/** The cursor job. */
export const workflowStepJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const runId = String(ctx.job.payload['runId'] ?? '');
  if (!runId) return;
  const s = ctx as EngineServices;
  const began = Date.now();
  for (let steps = 0; ;) {
    const t = await stepOnce(s, scope, runId, ctx.now + (Date.now() - began), ctx.log);
    if (t.kind === 'stop') return;
    if (t.kind === 'at') return { rescheduleAt: new Date(t.at) };
    steps += 1;
    if (steps >= JOB_STEP_BUDGET || Date.now() - began >= JOB_TIME_BUDGET_MS)
      return { rescheduleAt: new Date() };
  }
};

/** Prunes one workspace's step logs of runs that ended long ago, then waits for the next to come due. */
export const retentionJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const next = await asWorker(ctx.db, scope, (tx) => pruneStepLogs(tx, scope.workspaceId));
  return next ? { rescheduleAt: next } : undefined;
};
