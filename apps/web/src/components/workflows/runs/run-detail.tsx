'use client';
import {
  allSteps,
  findStep,
  parseDefinition,
  refName,
  type RefKind,
  type WorkflowDefinition,
  type WorkflowNames,
} from '@hfos/core';
import { AlertCircle, ChevronRight, CircleStop, RotateCcw, SkipForward } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  WorkflowApproval,
  WorkflowCatalogsOut,
  WorkflowRunGet,
  WorkflowRunStep,
} from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import {
  decisionLines,
  decisionsOf,
  endReasonText,
  isLive,
  knowledgeUsed,
  latestRows,
  messageOf,
  runOverlays,
  stepKeyParts,
  stepNote,
  truncate,
  whenText,
} from '@/lib/workflows/run-words';
import { stepLines, stepTone } from '@/lib/workflows/steps';
import { useWide } from '@/lib/workflows/use-wide';
import { KindTile, stepIcon } from '../chips';
import { StepList } from '../step-list';
import { RunStatusBadge } from './run-status';

const STEP_STATUS: Record<
  WorkflowRunStep['status'],
  { label: string; variant: 'ok' | 'gray' | 'pending' | 'danger' | 'accent' }
> = {
  running: { label: 'Running', variant: 'accent' },
  done: { label: 'Done', variant: 'ok' },
  skipped: { label: 'Skipped', variant: 'gray' },
  waiting: { label: 'Waiting', variant: 'accent' },
  failed: { label: 'Failed', variant: 'danger' },
  dead: { label: 'Failed', variant: 'danger' },
};

/**
 * One run: whom it's for and where it stands, the path it took on the read-only step list, and what each
 * step did (what it rendered, what came back, the checks before a text, an error and its tries). Retry and
 * Skip act on the failed step the run is on; Stop ends a run that is still going. It refreshes on run events
 * and polls while the run goes (steps have no events of their own).
 */
export function RunDetail({
  workspaceId,
  initial,
  catalogs,
  timeZone,
  canManage,
}: {
  workspaceId: string;
  initial: WorkflowRunGet;
  catalogs: WorkflowCatalogsOut;
  timeZone: string;
  /** Owners and admins retry, skip and stop. */
  canManage: boolean;
}) {
  const names = catalogs as unknown as WorkflowNames;
  const [data, setData] = useState(initial);
  const run = data.run;
  const live = isLive(run.status);
  const def = useMemo<WorkflowDefinition | null>(() => {
    try {
      return data.definition ? parseDefinition(data.definition) : null;
    } catch {
      return null;
    }
  }, [data.definition]);
  const rows = useMemo(() => latestRows(data.steps), [data.steps]);
  const wide = useWide();
  const [selected, setSelected] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState<'retry' | 'skip' | 'stop' | null>(null);
  const [stopping, setStopping] = useState(false);
  /** Just asked the engine for something: poll faster until it answers. */
  const [asked, setAsked] = useState<number | null>(null);
  const changes = useLiveVersion([
    'workflow_run',
    'workflow_approval',
    'workflow',
    'message',
    'task',
    'lead',
    'activity',
  ]);

  const load = useCallback(async () => {
    try {
      setData(
        unwrap(
          await apiBrowser().POST('/v1/queries/workflow.run_get', {
            body: { workspaceId, runId: initial.run.id },
          }),
        ),
      );
    } catch {
      // Keep what's shown; the next poll tries again.
    }
  }, [workspaceId, initial.run.id]);

  useEffect(() => {
    if (changes > 0) void load();
  }, [changes, load]);
  useEffect(() => {
    if (!live && !asked) return;
    const timer = setInterval(() => void load(), asked ? 1000 : 3000);
    return () => clearInterval(timer);
  }, [live, asked, load]);
  useEffect(() => {
    if (!asked) return;
    const timer = setTimeout(() => setAsked(null), 30_000);
    return () => clearTimeout(timer);
  }, [asked]);

  const cursorKey = run.cursor ? `${run.cursor}#${run.visits[run.cursor] ?? 1}` : null;
  const cursorRow = cursorKey ? data.steps.find((s) => s.stepKey === cursorKey) : undefined;
  const stuck =
    !!cursorRow &&
    (cursorRow.status === 'failed' || cursorRow.status === 'dead') &&
    run.status !== 'completed' &&
    run.status !== 'stopped';
  const stuckStep = stuck && def && run.cursor ? findStep(def, run.cursor)?.step : undefined;
  const lastStepId = data.steps.length
    ? stepKeyParts(data.steps[data.steps.length - 1]!.stepKey).stepId
    : null;
  const shownId = selected ?? run.cursor ?? lastStepId;
  const overlays = useMemo(
    () => (def ? runOverlays(def, run, data.steps, { timeZone, names }) : {}),
    [def, run, data.steps, timeZone, names],
  );
  const unused = def ? unusedPaths(def, rows) : null;
  const personName = run.person?.fullName ?? (run.isTest ? 'Test run' : 'No customer');
  const base = `/app/w/${workspaceId}`;

  function pick(id: string) {
    if (id === 'trigger') return;
    setSelected(id);
    if (!wide) setSheet(true);
  }

  async function act(kind: 'retry' | 'skip') {
    if (!cursorRow) return;
    setBusy(kind);
    try {
      const body = { workspaceId, runId: run.id, stepKey: cursorRow.stepKey };
      unwrap(
        kind === 'retry'
          ? await apiBrowser().POST('/v1/commands/workflow.retry_step', { body })
          : await apiBrowser().POST('/v1/commands/workflow.skip_step', { body }),
      );
      toast.success(
        kind === 'retry'
          ? 'Trying that step again.'
          : 'Skipped. The run carries on with the next step.',
      );
      setAsked(Date.now());
      void load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    setBusy('stop');
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/workflow.stop_run', {
          body: { workspaceId, runId: run.id },
        }),
      );
      toast.success('Stopped the run.');
      setStopping(false);
      void load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const panel = shownId ? (
    <StepDetail
      def={def}
      stepId={shownId}
      steps={data.steps}
      approvals={data.approvals}
      names={names}
      timeZone={timeZone}
      runLive={live}
    />
  ) : (
    <p className="text-[13px] text-text-2">The run hasn’t taken a step yet.</p>
  );

  return (
    <div className="pb-6" data-testid="run-detail" data-status={run.status}>
      <div className="mb-2 flex items-center gap-1 text-xs text-text-3">
        <Link href={`${base}/workflows`} className="text-accent-text hover:underline">
          Workflows
        </Link>
        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
        <Link href={`${base}/workflows/runs`} className="text-accent-text hover:underline">
          Runs
        </Link>
        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
        <span className="truncate">{personName}</span>
      </div>

      <Card className="mb-4 p-4 md:px-6 md:py-5">
        <div className="flex flex-wrap items-start gap-3 md:gap-4">
          <Avatar
            name={personName}
            seed={run.person?.id ?? run.id}
            size="lg"
            className="h-11 w-11 text-base"
          />
          <div className="min-w-0 flex-1 basis-[220px]">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em]">
                {personName}
              </h1>
              <RunStatusBadge status={run.status} />
              {run.isTest ? (
                <Badge variant="gray">
                  Test · {run.testMode === 'send_to_me' ? 'Send to me' : 'Simulate'}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-[13px] text-text-2" data-testid="run-summary">
              <Link
                href={`${base}/workflows/${run.workflow.id}`}
                className="font-medium text-accent-text hover:underline"
              >
                {run.workflow.name}
              </Link>
              {' · '}
              {run.isTest
                ? `draft revision ${run.testRevision ?? '?'}`
                : `version ${run.version ?? '?'}`}
              {' · started '}
              {whenText(run.startedAt, timeZone)}
              {run.endedAt ? ` · ended ${whenText(run.endedAt, timeZone)}` : ''}
            </p>
            {!live && run.endReason ? (
              <p className="mt-1 text-[13px]" data-testid="run-end-reason">
                <span className="font-semibold">
                  {run.status === 'completed'
                    ? 'Finished'
                    : run.status === 'failed'
                      ? 'Failed'
                      : 'Stopped'}
                  :
                </span>{' '}
                {endReasonText(run.endReason)}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {run.person ? (
              <ButtonLink
                href={`${base}/customers/people/${run.person.id}`}
                variant="secondary"
                size="sm"
              >
                Open customer
              </ButtonLink>
            ) : null}
            {canManage && live ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setStopping(true)}
                data-testid="run-stop"
              >
                <CircleStop className="h-4 w-4" strokeWidth={1.5} />
                Stop run
              </Button>
            ) : null}
          </div>
        </div>

        {stuck && cursorRow ? (
          <div
            className="mt-4 flex flex-col gap-3 rounded-menu border border-[color-mix(in_oklab,var(--danger)_35%,var(--border))] bg-[color-mix(in_oklab,var(--danger-soft)_60%,var(--card))] px-3.5 py-3 sm:flex-row sm:items-center"
            data-testid="run-failed"
          >
            <AlertCircle className="h-5 w-5 flex-none text-danger-text" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold">
                Stopped at “{stuckStep && def ? stepLines(stuckStep, names, def).title : 'a step'}”
              </div>
              <div className="text-[13px] text-text-2" data-testid="run-failed-reason">
                {typeof cursorRow.error?.['message'] === 'string'
                  ? cursorRow.error['message']
                  : 'Something went wrong.'}
                {cursorRow.attempt > 1 ? ` It was tried ${cursorRow.attempt} times.` : ''}
              </div>
            </div>
            {canManage ? (
              <div className="flex flex-none gap-2">
                <Button
                  size="sm"
                  loading={busy === 'retry'}
                  disabled={busy !== null}
                  onClick={() => void act('retry')}
                  data-testid="run-retry"
                >
                  <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
                  Retry
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'skip'}
                  disabled={busy !== null}
                  onClick={() => void act('skip')}
                  data-testid="run-skip"
                >
                  <SkipForward className="h-4 w-4" strokeWidth={1.75} />
                  Skip
                </Button>
              </div>
            ) : (
              <p className="text-xs text-text-3">An owner or admin can retry or skip it.</p>
            )}
          </div>
        ) : null}
      </Card>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3 md:px-5">
            <h2 className="text-[15px] font-semibold">The path it took</h2>
            {unused ? <span className="text-xs text-text-3">{unused}</span> : null}
          </div>
          <div className="overflow-x-auto bg-card-2 px-3 pb-3 pt-3 md:px-4">
            {def ? (
              <StepList
                definition={def}
                names={names}
                overlays={overlays}
                selectedId={shownId}
                onSelect={pick}
                phone={!wide}
                testId="run-steps"
              />
            ) : (
              <p className="px-1 py-4 text-[13px] text-text-2">
                The steps this run followed aren’t available.
              </p>
            )}
          </div>
        </Card>
        {wide ? (
          <Card
            className="hidden p-4 md:p-5 lg:sticky lg:top-4 lg:block"
            data-testid="run-step-panel"
          >
            {panel}
          </Card>
        ) : null}
      </div>

      {!wide ? (
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent title="Step" hideHeader className="pb-6">
            <div data-testid="run-step-sheet">
              {panel}
              <Button size="lg" className="mt-4 w-full" onClick={() => setSheet(false)}>
                Done
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      ) : null}

      <Dialog open={stopping} onOpenChange={(o) => !o && busy !== 'stop' && setStopping(false)}>
        <DialogContent
          title="Stop this run?"
          description="It ends now and takes no more steps. This can’t be undone."
        >
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => setStopping(false)} disabled={busy === 'stop'}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy === 'stop'}
              onClick={() => void stop()}
              data-testid="run-stop-confirm"
            >
              Stop run
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** "“Emergency” and “Other” weren’t used", for branches the run went through. */
function unusedPaths(def: WorkflowDefinition, rows: Map<string, WorkflowRunStep>): string | null {
  const names: string[] = [];
  for (const { step } of allSteps(def)) {
    if (step.type !== 'branch') continue;
    const row = rows.get(step.id);
    if (!row || row.status !== 'done') continue;
    const took = row.output?.['branchId'];
    for (const b of step.branches) if (b.id !== took) names.push(`“${b.name}”`);
  }
  if (!names.length) return null;
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? 'wasn’t' : 'weren’t'} used`;
}

// ---- One step ----

const REF_KEYS: Record<string, RefKind> = {
  assigneeUserId: 'user',
  stageId: 'stage',
  pipelineId: 'pipeline',
  tagId: 'tag',
  workflowId: 'workflow',
};

const LABELS: Record<string, string> = {
  channel: 'Channel',
  to: 'To',
  subject: 'Subject',
  title: 'Title',
  notes: 'Notes',
  dueAt: 'Due',
  assigneeUserId: 'Assigned to',
  stageId: 'Stage',
  pipelineId: 'Pipeline',
  tagId: 'Tag',
  target: 'On the',
  mode: 'Change',
  workflowId: 'Workflow',
  message: 'Message',
  text: 'Text',
  lostReason: 'Lost reason',
  url: 'Address',
  wakeAt: 'Wakes',
  wokeAt: 'Woke',
  until: 'Until',
  expiresAt: 'Expires',
  value: 'Answer',
  status: 'Answer',
  instead: 'Instead, because',
  would: 'Would',
  emailed: 'Emailed',
  completed: 'Completed',
  updated: 'Updated',
  stopped: 'Stopped',
  fields: 'Changes',
  kind: 'Kind',
  timedOut: 'Timed out',
  branch: 'Path',
  matched: 'Chosen by',
  key: 'Saved as',
  task: 'Task',
  model: 'Model',
  tokens: 'AI tokens',
  reason: 'Why',
  note: 'Note',
  sentToTester: 'Sent to',
  via: 'By',
  missing: 'Missing',
  rule: 'Rule',
};

/** Keys shown elsewhere (the message, the checks, knowledge) or that only mean something to the engine. */
const HIDDEN = new Set([
  'decisions',
  'items',
  'body',
  'simulated',
  'messageId',
  'conversationId',
  'taskId',
  'taskIds',
  'tagIds',
  'runId',
  'activityId',
  'deliveryId',
  'approvalId',
  'approvers',
  'branchId',
  'duplicate',
  'held',
  'fastForwarded',
  'manualRetries',
  'retryRequestedBy',
  'skippedBy',
  'skipped',
  'end',
  'autoApproved',
  'events',
  'leadId',
  'fallback',
  'assumed',
  'workspaceId',
  'personId',
]);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const humanize = (k: string) => {
  const s = k
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : k;
};

function fieldValue(
  key: string,
  v: unknown,
  names: WorkflowNames,
  timeZone: string,
): string | null {
  if (v === null || v === undefined || v === '') return null;
  const kind = REF_KEYS[key];
  if (kind && typeof v === 'string') return refName(kind, v, names);
  if (key === 'channel') return v === 'sms' ? 'Text' : v === 'email' ? 'Email' : String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return ISO.test(v) ? whenText(v, timeZone) : v;
  if (Array.isArray(v)) {
    const out = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
    return out || null;
  }
  return truncate(JSON.stringify(v), 200);
}

function fieldEntries(
  obj: Record<string, unknown> | null | undefined,
  names: WorkflowNames,
  timeZone: string,
): [string, string][] {
  if (!obj) return [];
  return Object.entries(obj).flatMap(([k, v]) => {
    if (HIDDEN.has(k)) return [];
    const value = fieldValue(k, v, names, timeZone);
    return value === null ? [] : [[k, value] as [string, string]];
  });
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {title}
      </div>
      {children}
    </div>
  );
}

function Fields({ entries }: { entries: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-text-3">{LABELS[k] ?? humanize(k)}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

const APPROVAL_STATUS: Record<WorkflowApproval['status'], string> = {
  pending: 'Waiting for a decision',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** What one step did, visit by visit (a go-back can bring a run through a step again). */
function StepDetail({
  def,
  stepId,
  steps,
  approvals,
  names,
  timeZone,
  runLive,
}: {
  def: WorkflowDefinition | null;
  stepId: string;
  steps: readonly WorkflowRunStep[];
  approvals: readonly WorkflowApproval[];
  names: WorkflowNames;
  timeZone: string;
  runLive: boolean;
}) {
  const step = def ? findStep(def, stepId)?.step : undefined;
  const visits = steps.filter((s) => stepKeyParts(s.stepKey).stepId === stepId);
  const decided = approvals.filter((a) => stepKeyParts(a.stepKey).stepId === stepId);
  if (!step || !def)
    return <p className="text-[13px] text-text-2">This step isn’t in the workflow anymore.</p>;
  const { title, detail } = stepLines(step, names, def);
  return (
    <div data-testid="run-step-detail" data-step-id={stepId}>
      <div className="flex items-start gap-2.5">
        <KindTile tone={stepTone(step)} icon={stepIcon(step)} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold leading-tight" data-testid="run-step-title">
            {title}
          </h3>
          {detail ? (
            <p className="mt-0.5 line-clamp-3 break-words text-xs text-text-2">{detail}</p>
          ) : null}
        </div>
      </div>
      {!visits.length ? (
        <p className="mt-3 text-[13px] text-text-2">
          {runLive ? 'The run hasn’t reached this step yet.' : 'The run didn’t reach this step.'}
        </p>
      ) : null}
      {visits.map((row) => {
        const message = messageOf(row);
        const decisions = decisionLines(decisionsOf(row.output), timeZone);
        const knowledge = knowledgeUsed(row.output);
        const input = fieldEntries(row.input, names, timeZone);
        const output = fieldEntries(row.output, names, timeZone);
        const error = row.error ?? null;
        const status = STEP_STATUS[row.status];
        return (
          <section key={row.id} className="mt-3.5 border-t border-border pt-3">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              {visits.length > 1 ? (
                <span className="text-xs font-semibold text-text-3">
                  Visit {stepKeyParts(row.stepKey).visit}
                </span>
              ) : null}
              <Badge variant={status.variant}>{status.label}</Badge>
              <span className="text-xs text-text-3">
                {whenText(row.startedAt, timeZone)}
                {row.attempt > 1 ? ` · ${row.attempt} tries` : ''}
              </span>
            </div>
            <p className="text-[13px]" data-testid="run-step-note">
              {stepNote(step, row, { timeZone, names, def })}
            </p>
            {message ? (
              <blockquote className="mt-2 whitespace-pre-wrap break-words rounded-menu border border-border bg-card-2 px-3 py-2 text-[13px]">
                {message}
              </blockquote>
            ) : null}
            {decisions.length ? (
              <Block title="Checks before the text">
                <ul className="flex flex-col gap-0.5 text-[12.5px] text-text-2">
                  {decisions.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </Block>
            ) : null}
            {knowledge.length ? (
              <Block title="Knowledge used">
                <p className="text-[12.5px] text-text-2">{knowledge.join(' · ')}</p>
              </Block>
            ) : null}
            {input.length ? (
              <Block title="What it was set to do">
                <Fields entries={input} />
              </Block>
            ) : null}
            {output.length ? (
              <Block title="What came back">
                <Fields entries={output} />
              </Block>
            ) : null}
            {error ? (
              <Block title="Error">
                <p className="text-[12.5px] text-danger-text">
                  {typeof error['message'] === 'string'
                    ? error['message']
                    : 'Something went wrong.'}
                </p>
                {typeof error['rule'] === 'string' || typeof error['code'] === 'string' ? (
                  <p className="mt-0.5 font-mono text-[11.5px] text-text-3">
                    {String(error['rule'] ?? error['code'])}
                  </p>
                ) : null}
              </Block>
            ) : null}
          </section>
        );
      })}
      {decided.map((a) => (
        <Block key={a.id} title="Approval">
          <p className="text-[12.5px] text-text-2">
            {APPROVAL_STATUS[a.status]}
            {a.decidedBy ? ` by ${a.decidedBy.fullName}` : ''}
            {a.decidedAt ? `, ${whenText(a.decidedAt, timeZone)}` : ''}
            {a.via === 'assistant' ? ' in the Assistant' : ''}
            {a.edits ? ', with an edit' : ''}
            {a.reason ? `: “${a.reason}”` : ''}
          </p>
        </Block>
      ))}
    </div>
  );
}
