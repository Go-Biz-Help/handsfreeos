'use client';
import {
  aiLimitReached,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowOp,
} from '@hfos/core';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';

/** What the worker's AI builder answers (apps/worker/src/workflows/builder.ts). */
export interface BuilderProposal {
  readonly proposalId: string;
  readonly workflowId: string | null;
  readonly baseRevision: number | null;
  /** Every op against the draft it was made for (a follow-up's include the earlier proposal's). */
  readonly ops: WorkflowOp[];
  /** The workflow with the ops applied. */
  readonly preview: WorkflowDefinition;
  readonly issues: WorkflowIssue[];
  /** The ops in plain words. */
  readonly summary: string[];
  /** The AI's own sentence about the change. */
  readonly reply: string;
  /** What was asked for that workflows can't do. */
  readonly unsupported: string[];
  readonly expiresAt: string;
}

export interface BuilderRequest {
  readonly workspaceId: string;
  /** null: a new workflow. */
  readonly workflowId: string | null;
  /** The saved draft revision the ops are made against; null for a new workflow. */
  readonly baseRevision: number | null;
  readonly prompt: string;
  /** The step "this" or "it" means. */
  readonly selectedStepId?: string | null;
  /** A follow-up refines this proposal. */
  readonly proposalId?: string | null;
}

/** Asks the AI builder for a proposal. Nothing changes until someone applies it. */
export function askBuilder(input: BuilderRequest): Promise<BuilderProposal> {
  return workerPost<BuilderProposal>('/v1/workflows/ai/edit', input);
}

/** Why the builder didn't answer, in plain words. */
export function builderErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return errorMessage(e);
  const why = e.rule ?? e.code;
  if (e.status === 0) return 'The AI isn’t reachable right now. Try again in a minute.';
  if (e.status === 403) return 'Only owners and admins can change workflows.';
  // The worker's own words name the business's daily AI limit; these are for when they didn't arrive.
  if (why === 'budget_reached') return e.message || aiLimitReached();
  if (why === 'ai_not_configured')
    return 'The AI isn’t set up for HandsFreeOS yet, so this can’t run. HandsFreeOS support can switch it on.';
  if (why === 'revision_conflict')
    return 'Someone saved this workflow in the meantime. Load their version, then ask again.';
  if (why === 'proposal_stale' || why === 'proposal_applied')
    return 'The workflow changed since that was drafted. Ask again.';
  return e.message;
}

/** Example requests for the prompt box: one line each, the kind the builder does well. */
export const EDIT_EXAMPLES = [
  'Wait two days instead',
  'Add a text after the first wait',
  'Stop if they book',
] as const;

export const NEW_EXAMPLES = [
  'Text new leads within a minute, then follow up the next day',
  'After a job is done, thank them and ask for a review',
  'When a call is missed, text them back and make a task',
] as const;
