/**
 * The seam AI steps and AI-sorted branches go through. Without a model behind it every call answers
 * `ai_unavailable`, and the engine takes the step's fallback (the fallback text, the "other" category, or the
 * last path) and logs why. The worker plugs in Claude grounded in the knowledge base (ai-runner.ts,
 * `createWorkflowAi`) by setting `workflowAi` on its services.
 *
 * The engine calls the runner outside any database transaction (it may be slow), then commits what it
 * returns under the step's key. Customer text arrives here as data, never as instructions.
 */
import type { KnowledgeKind, WorkflowActor } from '@hfos/core/server';

export type AiStepTask = 'write' | 'classify' | 'summarize' | 'decide';

/** A knowledge item an answer used, as the step's log lists it. */
export interface AiStepItem {
  readonly id: string;
  readonly kind: KnowledgeKind;
  readonly title: string;
}

export interface AiBranchChoice {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface AiStepInput {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly stepKey: string;
  /** decide: an AI-sorted branch picking one of `branches`. */
  readonly task: AiStepTask;
  /** What the business asked for (an AI step's prompt; empty for a branch). */
  readonly prompt: string;
  /** classify: the categories it may answer with. */
  readonly categories: readonly string[];
  /** decide: the paths, each with what the AI reads to pick it. */
  readonly branches: readonly AiBranchChoice[];
  /** write: the channel the text is for (length caps differ). */
  readonly channel: 'sms' | 'email';
  readonly useKnowledge: boolean;
  /** The customer's latest message, quoted as data. */
  readonly customerMessage: string | null;
  /** A few plain facts about the customer and the trigger (first name, lead title, appointment time). */
  readonly facts: Readonly<Record<string, string>>;
  /** A test run (Simulate or Send to me). */
  readonly test: boolean;
  /** This try of the step (1 on the first): the last try before the step would die falls back instead. */
  readonly attempt?: number;
  /** Who the step runs as: knowledge use and gap suggestions are recorded as the workflow. */
  readonly actor?: WorkflowActor;
}

export type AiStepResult =
  | {
      readonly ok: true;
      /** write and summarize: the text; classify: a category; decide: a branch id. */
      readonly value: string;
      readonly reason?: string | null;
      readonly tokens?: number;
      readonly model?: string | null;
      /** Knowledge items the answer was grounded in. */
      readonly itemIds?: readonly string[];
      /** The same items with their kind and title, so a run's log lists them without another query. */
      readonly items?: readonly AiStepItem[];
      /** The knowledge gap suggestion a question it couldn't answer became (or joined). */
      readonly gapSuggestionId?: string | null;
    }
  | {
      readonly ok: false;
      /** ai_unavailable, budget_reached, ai_error… logged on the step. */
      readonly reason: string;
      readonly tokens?: number;
    };

export interface AiStepRunner {
  run(input: AiStepInput): Promise<AiStepResult>;
}

/** No model yet: every AI step takes its fallback. */
export const unavailableAiRunner: AiStepRunner = {
  run: async () => ({ ok: false, reason: 'ai_unavailable' }),
};

/** The fallback category: the step's own, else one called "other", else the last one. */
export function fallbackCategory(
  categories: readonly string[],
  fallback: string | null,
): string | null {
  if (fallback && categories.includes(fallback)) return fallback;
  return categories.find((c) => c.trim().toLowerCase() === 'other') ?? categories.at(-1) ?? null;
}
