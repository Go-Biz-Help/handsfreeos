'use client';
import {
  aiOutputKey,
  findStep,
  nextStep,
  render,
  type Step,
  type TemplateValues,
  type WorkflowDefinition,
} from '@hfos/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowRunGet } from '@/lib/api/types';
import { testOutcome } from '@/lib/workflows/run-words';
import { sampleValues } from '@/lib/workflows/sample';
import type { WorkflowTest } from '@/lib/workflows/use-test';

/**
 * Simulate for an agency template. A template has no business to run in, so its test walks the steps here in
 * the browser: messages are filled in with sample details and not sent, waits are skipped, approvals pass,
 * and branches and AI steps follow what the test takes as given (else the "otherwise" path, the last
 * category, or the step's fallback). The result has a test run's shape, so the Test tab and the step marks
 * show it as they show the engine's. Each business still tests its own copy before it can publish it.
 */

type Row = WorkflowRunGet['steps'][number];
type Json = Record<string, unknown>;

/** Steps one simulation may take (goto loops included), as for a real run. */
const MAX_STEPS = 200;
const UNIT_MS: Record<string, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 7 * 86_400_000,
};

interface Outcome {
  readonly status: Row['status'];
  readonly input: Json | null;
  readonly output: Json;
  readonly branchId?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function filled(template: unknown, values: TemplateValues, timeZone: string) {
  return render(str(template), values, { timeZone });
}

function actionOutcome(
  step: Extract<Step, { type: 'action' }>,
  values: TemplateValues,
  timeZone: string,
): Outcome {
  const config = step.config as Json;
  if (step.action === 'send_text' || step.action === 'send_email') {
    const body = filled(config['body'], values, timeZone);
    const subject = filled(config['subject'], values, timeZone);
    const missing = [...new Set([...body.missing, ...subject.missing])];
    if (missing.length)
      return {
        status: 'skipped',
        input: { body: body.text },
        output: { skipped: 'missing_variable', missing },
      };
    return step.action === 'send_text'
      ? {
          status: 'done',
          input: { body: body.text },
          output: { simulated: true, would: 'text', body: body.text },
        }
      : {
          status: 'done',
          input: { subject: subject.text, body: body.text },
          output: {
            simulated: true,
            would: 'email',
            subject: subject.text,
            body: body.text,
            to: str(typeof values === 'function' ? values('person.email') : null) || 'the customer',
          },
        };
  }
  return { status: 'done', input: config, output: { simulated: true } };
}

function stepOutcome(
  step: Step,
  assume: Readonly<Json>,
  values: TemplateValues,
  timeZone: string,
  at: number,
): Outcome {
  switch (step.type) {
    case 'action':
      return actionOutcome(step, values, timeZone);
    case 'wait': {
      const until = step.until;
      if (until.kind === 'duration')
        return {
          status: 'done',
          input: null,
          output: {
            fastForwarded: true,
            wakeAt: iso(at + until.duration.amount * (UNIT_MS[until.duration.unit] ?? 0)),
          },
        };
      if (until.kind === 'event')
        return {
          status: 'done',
          input: null,
          output: { fastForwarded: true, timedOut: assume['wait.timed_out'] !== false },
        };
      return { status: 'done', input: null, output: { fastForwarded: true } };
    }
    case 'branch': {
      const wanted = assume[`branch.${step.id}`];
      const assumed = step.branches.find((b) => b.id === wanted);
      const otherwise =
        step.mode === 'ai'
          ? step.branches.at(-1)
          : (step.branches.find((b) => !b.condition) ?? step.branches[0]);
      const chosen = assumed ?? otherwise;
      return {
        status: 'done',
        input: null,
        output: chosen
          ? {
              branchId: chosen.id,
              branch: chosen.name,
              matched: assumed ? 'assumed' : step.mode === 'ai' ? 'fallback' : 'otherwise',
            }
          : { matched: 'none' },
        branchId: chosen?.id,
      };
    }
    case 'ai': {
      const assumed = assume[`ai.${aiOutputKey(step)}`];
      const value =
        typeof assumed === 'string'
          ? assumed
          : step.task === 'classify'
            ? (step.fallback ?? step.categories.at(-1) ?? 'Other')
            : (step.fallback ?? (step.task === 'write' ? '(the AI writes this when it runs)' : ''));
      return {
        status: 'done',
        input: null,
        output: {
          task: step.task,
          value,
          ...(typeof assumed === 'string'
            ? { assumed: true }
            : step.fallback
              ? { fallback: true }
              : {}),
        },
      };
    }
    case 'approval':
      return { status: 'done', input: null, output: { autoApproved: true } };
    case 'end':
      return { status: 'done', input: null, output: { end: 'end_step' } };
    case 'goto':
      return { status: 'done', input: null, output: {} };
  }
}

/** Walks a definition the way a Simulate test would, into a test run's shape. */
export function simulateDefinition(
  def: WorkflowDefinition,
  opts: {
    readonly assume: Readonly<Json>;
    readonly values: TemplateValues;
    readonly timeZone: string;
    readonly revision: number;
    readonly workflow: { readonly id: string; readonly name: string };
    readonly now?: number;
  },
): WorkflowRunGet {
  const started = opts.now ?? Date.now();
  const rows: Row[] = [];
  const visits: Record<string, number> = {};
  const jumps: Record<string, number> = {};
  let cursor: string | null = def.steps[0]?.id ?? null;
  let endReason: string = 'finished';
  let at = started;
  while (cursor) {
    if (rows.length >= MAX_STEPS) {
      endReason = 'step_limit';
      break;
    }
    const step = findStep(def, cursor)?.step;
    if (!step) break;
    visits[cursor] = (visits[cursor] ?? 0) + 1;
    const o = stepOutcome(step, opts.assume, opts.values, opts.timeZone, at);
    let next: ReturnType<typeof nextStep>;
    try {
      next = nextStep(def, cursor, {
        branchId: o.branchId,
        approved: true,
        visits: jumps[cursor] ?? 0,
      });
    } catch {
      next = { kind: 'end', reason: 'finished' };
    }
    if (step.type === 'goto' && next.kind === 'step' && next.stepId === step.target)
      jumps[cursor] = (jumps[cursor] ?? 0) + 1;
    rows.push({
      id: `simulated-${rows.length + 1}`,
      stepKey: `${cursor}#${visits[cursor]}`,
      status: o.status,
      attempt: 1,
      input: o.input,
      output: o.output,
      error: null,
      eventIds: [],
      nextStepKey: next.kind === 'step' ? `${next.stepId}#${(visits[next.stepId] ?? 0) + 1}` : null,
      tokens: 0,
      startedAt: iso(at),
      finishedAt: iso(at),
    });
    at += 1000;
    if (next.kind === 'end') {
      endReason = next.reason;
      break;
    }
    cursor = next.stepId;
  }
  const failed = endReason === 'step_limit';
  return {
    run: {
      id: crypto.randomUUID(),
      workflow: opts.workflow,
      versionId: null,
      version: null,
      status: failed ? 'failed' : 'completed',
      isTest: true,
      testMode: 'simulate',
      testRevision: opts.revision,
      person: null,
      leadId: null,
      appointmentId: null,
      conversationId: null,
      cursor: null,
      stepCount: rows.length,
      endReason,
      depth: 0,
      startedBy: null,
      startedAt: iso(started),
      endedAt: iso(at),
      context: {},
      visits,
      waitingFor: [],
      stopOn: [],
      originRunId: null,
      triggerEventId: null,
    },
    definition: def as unknown as Json,
    steps: rows,
    approvals: [],
  };
}

/**
 * The template editor's Test tab: Simulate only, in the browser. A simulation counts for the draft it ran on;
 * once the draft changes it reads as out of date, as an engine test does.
 */
export function useTemplateSimulation(opts: {
  readonly def: WorkflowDefinition;
  /** The draft's saved revision. */
  readonly revision: number;
  readonly timeZone: string;
  readonly businessName: string;
  readonly workflow: { readonly id: string; readonly name: string };
}): WorkflowTest {
  const [assume, setAssumeState] = useState<Record<string, unknown>>({});
  const [ran, setRan] = useState<{ def: WorkflowDefinition; result: WorkflowRunGet } | null>(null);
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  const setAssume = useCallback((key: string, value: unknown) => {
    setAssumeState((a) => {
      const next = { ...a };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }, []);

  const start = useCallback(async () => {
    const o = latest.current;
    const values = sampleValues({
      person: null,
      businessName: o.businessName,
      workflowName: o.workflow.name,
    });
    setRan({
      def: o.def,
      result: simulateDefinition(o.def, {
        assume,
        values,
        timeZone: o.timeZone,
        revision: o.revision,
        workflow: o.workflow,
      }),
    });
  }, [assume]);

  // It ran on this draft: it counts for the revision the draft is saved as now.
  const result = useMemo(() => {
    if (!ran) return null;
    const testRevision = ran.def === opts.def ? opts.revision : -1;
    return { ...ran.result, run: { ...ran.result.run, testRevision } };
  }, [ran, opts.def, opts.revision]);

  return useMemo(
    () => ({
      mode: 'simulate' as const,
      setMode: () => {},
      assume,
      setAssume,
      result,
      outcome: result ? testOutcome(result.run, result.steps) : null,
      startingSince: null,
      busy: false,
      start,
      stop: async () => {},
    }),
    [assume, setAssume, result, start],
  );
}
