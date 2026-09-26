/**
 * Knowledge for AI prompts, shared by workflow AI steps and the AI teammate (plan M7, "Knowledge search"): the
 * retriever's full-text search, run for several queries in turn and merged best first without repeats. A
 * customer's words go in as an any-of search (`anyOfWords`), so one matching word is enough.
 */
import { knowledgeRetriever, type KnowledgeMatch } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';

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

/**
 * A workspace's short published FAQ answers and facts, whole, the most used first: what a phone call reads when
 * it's picked up, so most questions need no search. Longer items (articles, documents) are left to the search.
 */
export async function shortKnowledge(
  tx: Tx,
  input: {
    readonly workspaceId: string;
    readonly limit: number;
    /** An item longer than this (question and answer) is left to the search. */
    readonly itemChars: number;
  },
): Promise<KnowledgeMatch[]> {
  const list = await rows<{
    id: string;
    kind: KnowledgeMatch['kind'];
    title: string;
    body: string;
    tags: string[] | null;
    source_url: string | null;
    updated_at: Date | string;
  }>(
    tx,
    sql`select i.id, i.kind::text as kind, i.title, i.body, i.tags, i.source_url, i.updated_at
        from app.knowledge_items i
        where i.workspace_id = ${input.workspaceId} and i.status = 'published'
          and i.kind in ('faq', 'fact') and length(i.title) + length(i.body) <= ${input.itemChars}
        order by (i.kind = 'faq') desc, i.use_count desc, i.updated_at desc, i.id
        limit ${input.limit}`,
  );
  return list.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    tags: r.tags ?? [],
    status: 'published',
    sourceUrl: r.source_url,
    snippet: '',
    score: 0,
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}
