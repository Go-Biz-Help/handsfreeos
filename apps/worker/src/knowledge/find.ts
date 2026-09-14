/**
 * Knowledge for AI prompts, shared by workflow AI steps and the AI teammate (plan M7, "Knowledge search"): the
 * retriever's full-text search, run for several queries in turn and merged best first without repeats. A
 * customer's words go in as an any-of search (`anyOfWords`), so one matching word is enough.
 */
import { knowledgeRetriever, type KnowledgeMatch } from '@hfos/core/server';
import type { Tx } from '@hfos/db/client';

/**
 * A customer's words as an any-of search ("maintenance or plan or rooftop"), so one matching word is enough
 * and items matching more of them rank higher. Short words are left out, and so is punctuation (web search
 * syntax).
 */
export function anyOfWords(text: string, max = 12): string {
  const words = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 3) continue;
    words.add(w);
    if (words.size >= max) break;
  }
  return [...words].join(' or ');
}

export interface FindKnowledgeInput {
  /** The workspace whose published items count; the transaction is scoped to it (asWorker). */
  readonly workspaceId: string;
  /** Searched in order, best first; blank ones are skipped. Put a customer's words through anyOfWords. */
  readonly queries: readonly string[];
  /** The most items it returns, and the most each search asks for. */
  readonly limit: number;
}

/** The published items for these queries, best first: the first query's matches, then new ones from the next. */
export async function findKnowledge(tx: Tx, input: FindKnowledgeInput): Promise<KnowledgeMatch[]> {
  const retriever = knowledgeRetriever();
  const found = new Map<string, KnowledgeMatch>();
  for (const q of input.queries) {
    if (found.size >= input.limit) break;
    if (!q.trim()) continue;
    for (const m of await retriever.search(tx, input.workspaceId, q, { limit: input.limit })) {
      if (found.size >= input.limit) break;
      if (!found.has(m.id)) found.set(m.id, m);
    }
  }
  return [...found.values()];
}
