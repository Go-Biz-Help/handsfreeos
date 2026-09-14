/**
 * The seam AI steps and AI-sorted branches go through. Milestone 6 step 4 has no model behind it: every
 * call answers `ai_unavailable`, and the engine takes the step's fallback (the fallback text, the "other"
 * category, or the last path) and logs why. Step 9 plugs in Claude grounded in the knowledge base by setting
 * `workflowAi` on the worker's services; nothing else in the engine changes.
 *
 * The engine calls the runner outside any database transaction (it may be slow), then commits what it
 * returns under the step's key. Customer text arrives here as data, never as instructions.
 */

export type AiStepTask = 'write' | 'classify' | 'summarize' | 'decide';

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
