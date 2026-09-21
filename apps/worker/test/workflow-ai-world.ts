/**
 * Workflow worlds whose AI steps answer from a model, through the worker's real runner (createWorkflowAi,
 * wired as main.ts wires it): the scripted stand-in by default, or a test's own provider, inside a daily
 * token limit. `recording` keeps every request a provider saw, and can fail the next calls on purpose.
 */
import type { AiProvider, AiRequest } from '@hfos/ai';
import { rows, sql } from '@hfos/db/client';
import { scriptedAi } from '../src/ai/scripted';
import { createWorkflowAi } from '../src/workflows/ai-runner';
import { runJobKey } from '../src/workflows/index';
import type { TestServices } from './helpers';
import { admin, drain, flowWorld, type World } from './workflow-world';

export interface AiWorldOptions {
  /** The model (default: the scripted stand-in); null for none. */
  readonly provider?: AiProvider | null;
  readonly dailyTokens?: number;
}

/** Gives a world's worker services a model and the workflow AI runner that uses it. */
export function withWorkflowAi(w: World, opts: AiWorldOptions = {}): World {
  const ai = {
    provider: opts.provider === undefined ? scriptedAi() : opts.provider,
    dailyTokens: opts.dailyTokens ?? 5_000_000,
  };
  const s = {
    ...w.s,
    ai,
    workflowAi: createWorkflowAi({ db: w.s.db, ai, log: w.s.log, wallet: w.s.wallet }),
  };
  Object.assign(w, { s: s as TestServices });
  return w;
}

/** A workflow world (workflow-world.ts) whose AI steps answer from a model. */
export async function aiFlowWorld(label: string, opts: AiWorldOptions = {}): Promise<World> {
  return withWorkflowAi(await flowWorld(label), opts);
}

/**
 * Brings a run's pending job forward to now and drains, through the world's services (the AI runner
 * included). Use it instead of runJob there: the world's HTTP test route was built before the model was added.
 */
export async function runJobNow(w: World, runId: string): Promise<void> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now()
        where dedupe_key = ${runJobKey(runId)} and status = 'pending'`,
  );
  await drain(w);
}

export interface Recording {
  readonly provider: AiProvider;
  readonly requests: AiRequest[];
  /** Errors the next calls throw instead of answering, first in first out. */
  readonly failures: Error[];
}

/** A provider that remembers every request, then lets `inner` answer (unless a failure is queued). */
export function recording(inner: AiProvider = scriptedAi()): Recording {
  const requests: AiRequest[] = [];
  const failures: Error[] = [];
  const provider: AiProvider = {
    id: 'recording',
    model: inner.model,
    stream: async (request, options) => {
      requests.push(request);
      const failure = failures.shift();
      if (failure) throw failure;
      return inner.stream(request, options);
    },
  };
  return { provider, requests, failures };
}
