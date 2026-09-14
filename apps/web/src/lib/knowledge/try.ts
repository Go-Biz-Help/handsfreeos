'use client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';
import type { KnowledgeItemKind } from '@/lib/api/types';

/** One knowledge item the answer used; `snippet` marks matched words with ** **. */
export interface TryItem {
  readonly id: string;
  readonly kind: KnowledgeItemKind;
  readonly title: string;
  readonly snippet: string;
}

/** What the worker's Try it route answers (apps/worker/src/knowledge/try.ts). */
export interface TryAnswer {
  readonly answer: string;
  readonly unanswered: boolean;
  readonly items: readonly TryItem[];
  /** The gap suggestion an unanswered question became, or joined when a similar one was waiting. */
  readonly gap: { readonly suggestionId: string; readonly grouped: boolean } | null;
}

/** Answers a sample customer question the way AI steps would (owners and admins; counts toward the AI limit). */
export function tryKnowledge(workspaceId: string, question: string): Promise<TryAnswer> {
  return workerPost<TryAnswer>('/v1/knowledge/try', { workspaceId, question });
}

/** Why Try it didn't answer, in plain words. */
export function tryErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return errorMessage(e);
  const why = e.rule ?? e.code;
  if (e.status === 0) return 'The AI isn’t reachable right now. Try again in a minute.';
  if (e.status === 403) return 'Only owners and admins can try questions.';
  if (why === 'budget_reached')
    return 'That’s today’s AI limit for this business. It resets at midnight.';
  if (why === 'ai_not_configured') return 'The AI isn’t set up yet.';
  return e.message;
}
