import { randomUUID } from 'node:crypto';
import {
  executeCommandIn,
  knowledgeSuggestionPropose,
  suggestionFromGap,
  type MachineActor,
  type RequestMeta,
} from '@hfos/core/server';
import type { Tx } from '@hfos/db/client';

export interface ProposedGap {
  readonly suggestionId: string;
  /** It joined a similar question already waiting (its count went up) instead of adding another. */
  readonly grouped: boolean;
}

/**
 * A question the AI couldn't answer from the knowledge base, as a gap suggestion ("Customers asked: do you
 * offer financing?"). Similar questions share a group key (core's suggestionFromGap), so a repeat raises the
 * waiting suggestion's count and the owner writes the answer once. `context` says where it came from
 * ({runId, stepKey} for an AI step, {threadId} for the Assistant, {via: 'try_it'} for Try it; strings of up
 * to 300 characters). Runs in the caller's transaction, opened with asWorker for the actor's workspace.
 * Null when there is no question.
 */
export async function proposeGap(
  tx: Tx,
  actor: MachineActor,
  input: { readonly question: string; readonly context?: Readonly<Record<string, string>> },
  meta?: RequestMeta,
): Promise<ProposedGap | null> {
  const question = input.question.replace(/\s+/g, ' ').trim();
  if (!question) return null;
  const draft = suggestionFromGap(question);
  const source = Object.fromEntries(
    Object.entries(input.context ?? {})
      .filter(([k, v]) => k && typeof v === 'string' && v)
      .map(([k, v]) => [k.slice(0, 100), v.slice(0, 300)]),
  );
  const { output } = await executeCommandIn(
    tx,
    knowledgeSuggestionPropose,
    {
      workspaceId: actor.workspaceId,
      suggestions: [
        {
          reason: 'gap',
          question: draft.question!,
          ...(draft.groupKey ? { groupKey: draft.groupKey } : {}),
          source,
        },
      ],
    },
    actor,
    meta ?? {
      correlationId: randomUUID(),
      causationId: null,
      channel: actor.type === 'workflow' ? 'workflow' : 'worker',
    },
  );
  return { suggestionId: output.suggestionIds[0]!, grouped: output.grouped > 0 };
}
