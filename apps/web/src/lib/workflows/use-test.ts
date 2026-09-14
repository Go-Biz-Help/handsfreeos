'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { WorkflowRunGet, WorkflowTestBody } from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { isLive, testOutcome, type TestOutcome } from './run-words';

export type TestMode = 'simulate' | 'send_to_me';

export interface WorkflowTest {
  readonly mode: TestMode;
  readonly setMode: (mode: TestMode) => void;
  /** What the test takes as given, by the engine's keys: `wait.timed_out`, `branch.<stepId>`, `ai.<key>`. */
  readonly assume: Readonly<Record<string, unknown>>;
  /** Sets one assumption; undefined lets the run decide. */
  readonly setAssume: (key: string, value: unknown) => void;
  /** The newest test of this workflow with its step log, once there is one. */
  readonly result: WorkflowRunGet | null;
  readonly outcome: TestOutcome | null;
  /** Asked for, and the engine hasn't started it yet (null when not waiting). */
  readonly startingSince: number | null;
  readonly busy: boolean;
  readonly start: (personId: string | null) => Promise<void>;
  readonly stop: () => Promise<void>;
}

const POLL_MS = 900;
const START_TIMEOUT_MS = 120_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One workflow's test runs for the editor: Run test asks the engine for a test of the saved draft, finds the
 * run it starts, and follows its log (polling while it runs, and on live run events) until it ends. The
 * newest test is loaded on open, so a reload still shows how the last one went. People can't start runs
 * themselves; `workflow.test` is a request the engine answers.
 */
export function useWorkflowTest(opts: {
  workspaceId: string;
  workflowId: string;
  /** Saves the draft first; false stops the test. */
  flush: () => Promise<boolean>;
  /** A test ended (a pass opens Publish, so the page reloads its data). */
  onEnded: () => void;
}): WorkflowTest {
  const { workspaceId, workflowId, flush } = opts;
  const [mode, setMode] = useState<TestMode>('simulate');
  const [assume, setAssumeState] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<WorkflowRunGet | null>(null);
  const [startingSince, setStartingSince] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const onEnded = useRef(opts.onEnded);
  const endedFor = useRef<string | null>(null);
  const live = useLiveVersion(['workflow_run', 'workflow_approval']);

  useEffect(() => {
    onEnded.current = opts.onEnded;
  }, [opts.onEnded]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const newestTests = useCallback(async () => {
    const out = unwrap(
      await apiBrowser().POST('/v1/queries/workflow.run_list', {
        body: { workspaceId, workflowId, onlyTests: true, limit: 5 },
      }),
    );
    return out.items;
  }, [workspaceId, workflowId]);

  const load = useCallback(
    async (runId: string) => {
      const got = unwrap(
        await apiBrowser().POST('/v1/queries/workflow.run_get', { body: { workspaceId, runId } }),
      );
      if (!alive.current) return null;
      setResult(got);
      return got;
    },
    [workspaceId],
  );

  // The newest test, when the editor opens.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [first] = await newestTests();
        if (first && !cancelled) {
          endedFor.current = isLive(first.status) ? null : first.id;
          await load(first.id);
        }
      } catch {
        // Nothing to show yet; Run test still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [newestTests, load]);

  // Follow a test while it runs: poll, and refetch when a run event arrives.
  const runId = result?.run.id ?? null;
  const running = result ? isLive(result.run.status) : false;
  useEffect(() => {
    if (!runId || !running) return;
    const timer = setInterval(() => void load(runId).catch(() => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [runId, running, load]);
  useEffect(() => {
    if (runId && live > 0) void load(runId).catch(() => {});
  }, [live, runId, load]);

  // Once a test ends, the page reloads (a pass opens Publish).
  useEffect(() => {
    if (!result || isLive(result.run.status) || endedFor.current === result.run.id) return;
    endedFor.current = result.run.id;
    onEnded.current();
  }, [result]);

  const setAssume = useCallback((key: string, value: unknown) => {
    setAssumeState((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }, []);

  const start = useCallback(
    async (personId: string | null) => {
      if (busy || startingSince) return;
      setBusy(true);
      try {
        if (!(await flush())) {
          toast.error('Your latest changes aren’t saved yet, so the test didn’t start.');
          return;
        }
        const before = new Set((await newestTests()).map((r) => r.id));
        const body: WorkflowTestBody = {
          workspaceId,
          workflowId,
          mode,
          personId,
          ...(Object.keys(assume).length ? { assume } : {}),
        };
        unwrap(await apiBrowser().POST('/v1/commands/workflow.test', { body }));
        const since = Date.now();
        setStartingSince(since);
        // The engine starts the run a moment later; find it by being new.
        while (alive.current && Date.now() - since < START_TIMEOUT_MS) {
          await sleep(POLL_MS);
          const fresh = (await newestTests()).find((r) => !before.has(r.id));
          if (fresh) {
            endedFor.current = null;
            await load(fresh.id);
            return;
          }
        }
        if (alive.current)
          toast.error('The test hasn’t started yet. Try again in a minute.', { duration: 8000 });
      } catch (e) {
        const problem =
          e instanceof ApiError && e.rule === 'workflow_issues'
            ? 'Fix the red items in Checks, then run the test.'
            : errorMessage(e);
        toast.error(problem);
      } finally {
        if (alive.current) {
          setBusy(false);
          setStartingSince(null);
        }
      }
    },
    [busy, startingSince, flush, newestTests, workspaceId, workflowId, mode, assume, load],
  );

  const stop = useCallback(async () => {
    if (!runId) return;
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/workflow.stop_run', {
          body: { workspaceId, runId, reason: 'stopped_by_person' },
        }),
      );
      await load(runId);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [runId, workspaceId, load]);

  return {
    mode,
    setMode,
    assume,
    setAssume,
    result,
    outcome: result ? testOutcome(result.run, result.steps) : null,
    startingSince,
    busy,
    start,
    stop,
  };
}
