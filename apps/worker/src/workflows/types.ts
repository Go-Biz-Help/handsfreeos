/**
 * What the step engine passes around: the run as loaded, the context one step runs in, and what a step comes
 * back with (its outcome), including work that must happen outside the database transaction.
 */
import {
  HfosError,
  type RequestMeta,
  type Step,
  type StepOutcome,
  type WorkflowActor,
  type WorkflowDefinition,
} from '@hfos/core/server';
import type { Tx } from '@hfos/db/client';
import type { workflowRuns } from '@hfos/db/schema';
import type { Logger } from 'pino';
import type { MailMessage } from '../mailer';
import type { TenantScope, WorkerServices } from '../services';
import type { AiStepInput, AiStepRunner } from './ai-step';
import type { RunData } from './data';

export type RunRow = typeof workflowRuns.$inferSelect;
export type Json = Record<string, unknown>;

/** The worker's services, with the AI seam step 9 fills in. */
export type EngineServices = WorkerServices & { readonly workflowAi?: AiStepRunner };

export interface WorkflowInfo {
  readonly id: string;
  readonly name: string;
  readonly status: 'draft' | 'active' | 'paused' | 'archived';
}

/** Everything one step runs with. */
export interface ExecCtx {
  readonly s: EngineServices;
  readonly tx: Tx;
  readonly scope: TenantScope;
  readonly run: RunRow;
  readonly context: Json;
  readonly def: WorkflowDefinition;
  readonly workflow: WorkflowInfo;
  readonly step: Step;
  readonly stepKey: string;
  readonly attempt: number;
  /** The moment the step runs as of (a job run by the test route runs as of when it was due). */
  readonly now: number;
  readonly timeZone: string;
  readonly data: RunData;
  readonly actor: WorkflowActor;
  readonly meta: RequestMeta;
  /** A test run's mode; null for a real run. */
  readonly testMode: 'simulate' | 'send_to_me' | null;
  readonly log: Logger;
}

/** Changes a step makes to the run's context, merged group by group; null removes a key. */
export type ContextPatch = Readonly<Record<string, unknown>>;

/** Records a step points the run at (a lead it created, the conversation a text went to). */
export interface RefsPatch {
  readonly leadId?: string;
  readonly conversationId?: string;
}

interface Common {
  /** What the step was about to do, rendered (never secrets). */
  readonly input?: Json;
  readonly context?: ContextPatch;
  readonly refs?: RefsPatch;
  /** Best-effort work once the step's transaction commits (emailing approvers). */
  readonly after?: readonly (() => Promise<void>)[];
}

/** A step's row in the log, as the engine reads it back. */
export interface StepRow {
  readonly id: string;
  readonly status: 'running' | 'done' | 'skipped' | 'waiting' | 'failed' | 'dead';
  readonly attempt: number;
  readonly output: Json | null;
  readonly error: Json | null;
  readonly next_step_key: string | null;
}

export type Outcome =
  | (Common & {
      readonly kind: 'done';
      readonly output: Json;
      readonly eventIds?: readonly string[];
      /** Branches: the path taken (null: none matched, go past the block). Approvals: approved or not. */
      readonly walk?: { readonly branchId?: string | null; readonly approved?: boolean };
      readonly tokens?: number;
    })
  | (Common & { readonly kind: 'skipped'; readonly reason: string; readonly output?: Json })
  | (Common & {
      readonly kind: 'wait';
      readonly until: number;
      readonly output: Json;
      readonly runStatus: 'waiting' | 'awaiting_approval';
      readonly waitingFor?: readonly string[];
    })
  /** A rule said no: the step's onError decides (stop the run, or carry on). */
  | (Common & { readonly kind: 'refused'; readonly error: StepError; readonly output?: Json })
  | (Common & { readonly kind: 'end'; readonly reason: string; readonly output?: Json })
  /** Slow or outside work (an outgoing webhook, email, AI): done after the step's claim commits. */
  | (Common & { readonly kind: 'slow'; readonly work: SlowWork });

export type SlowWork =
  | { readonly kind: 'mail'; readonly messages: readonly MailMessage[]; readonly output: Json }
  | {
      readonly kind: 'webhook';
      readonly url: string;
      readonly body: string;
      readonly secret: string;
      readonly deliveryId: string;
    }
  | { readonly kind: 'ai'; readonly input: AiStepInput };

export interface StepError {
  readonly message: string;
  readonly rule: string | null;
  readonly code: string;
  readonly details?: unknown;
}

/** One consent or quiet-hours decision before a text, logged on the step. */
export interface Decision {
  readonly check: 'consent' | 'quiet_hours' | 'email';
  readonly result: 'ok' | 'blocked' | 'wait' | 'email_instead' | 'skip';
  readonly reason?: string;
  readonly until?: string;
}

/** A rule refusal (or anything else a person must fix): not retried, the step's onError decides. */
export function isRefusal(e: unknown): e is HfosError {
  return e instanceof HfosError && e.status < 500;
}

export function stepErrorOf(e: unknown): StepError {
  if (e instanceof HfosError)
    return {
      message: e.message,
      rule: e.rule ?? null,
      code: e.code,
      ...(e.details !== undefined ? { details: e.details } : {}),
    };
  return { message: e instanceof Error ? e.message : String(e), rule: null, code: 'error' };
}

export function refusedFrom(e: HfosError, input?: Json): Outcome {
  return { kind: 'refused', error: stepErrorOf(e), ...(input ? { input } : {}) };
}

export type { StepOutcome };
