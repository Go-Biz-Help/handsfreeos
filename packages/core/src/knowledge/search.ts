/**
 * Finding knowledge for prompts and people. Postgres full-text search over the weighted `search` column
 * (title A, tags B, text C; `websearch_to_tsquery('english', …)`), plus trigram similarity on titles for
 * typos, ranked together (`ts_rank_cd` + similarity), with `ts_headline` snippets. It sits behind
 * `KnowledgeRetriever`, so meaning-based search (embeddings, M7) can replace it without touching callers.
 * Reads the database: exported from '@hfos/core/server' only.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import type { KnowledgeKind, KnowledgeStatus } from './items';

export interface KnowledgeSearchOptions {
  /** 5 when missing; at most 20. */
  readonly limit?: number;
  readonly kinds?: readonly KnowledgeKind[];
  /** Published items only unless this is set (drafts then count too; archived never do). */
  readonly includeDrafts?: boolean;
}

export interface KnowledgeMatch {
  readonly id: string;
  readonly kind: KnowledgeKind;
  readonly title: string;
  readonly body: string;
  readonly tags: string[];
  readonly status: KnowledgeStatus;
  readonly sourceUrl: string | null;
  /** The best passages of the text, matched words wrapped in ** **. */
  readonly snippet: string;
  /** Higher is better; only comparable within one search. */
  readonly score: number;
  readonly updatedAt: string;
}

/** Finds the items that answer a question. AI steps, the Assistant and knowledge.search all go through one. */
export interface KnowledgeRetriever {
  readonly name: string;
  search(
    tx: Tx,
    workspaceId: string,
    query: string,
    opts?: KnowledgeSearchOptions,
  ): Promise<KnowledgeMatch[]>;
}

export const KNOWLEDGE_SEARCH_MAX_RESULTS = 20;
/** How much a title that looks like the query (typos included) adds to the text rank (0 to 1 each). */
const TITLE_SIMILARITY_WEIGHT = 0.5;
const HEADLINE_OPTIONS =
  'StartSel=**, StopSel=**, MaxWords=35, MinWords=12, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "';

const textArray = (values: readonly string[]) =>
  sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

/**
 * The match condition for an item (aliased `i`) against a query: its words (stemmed, English) or a title
 * that looks like it. knowledge_item.list filters with the same rule.
 */
export function knowledgeMatches(query: string) {
  return sql`(i.search @@ websearch_to_tsquery('english'::regconfig, ${query})
    or i.title operator(extensions.%) ${query})`;
}

type Row = {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags: string[];
  status: KnowledgeStatus;
  source_url: string | null;
  updated_at: Date | string;
  score: number;
  snippet: string;
};

/** Full-text search with typo-tolerant titles, best first. */
export async function searchKnowledge(
  tx: Tx,
  workspaceId: string,
  query: string,
  opts: KnowledgeSearchOptions = {},
): Promise<KnowledgeMatch[]> {
  const q = query.trim().slice(0, 500);
  if (!q) return [];
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 5), 1), KNOWLEDGE_SEARCH_MAX_RESULTS);
  const statuses = opts.includeDrafts ? ['published', 'draft'] : ['published'];
  const kinds = opts.kinds?.length ? sql`and i.kind::text = any(${textArray(opts.kinds)})` : sql``;
  // Rank first and headline only the winners: ts_headline reads the whole text of each row it's given.
  const list = await rows<Row>(
    tx,
    sql`with q as (
          select websearch_to_tsquery('english'::regconfig, ${q}) as tsq, ${q}::text as raw
        ),
        top as (
          select i.id, i.kind::text as kind, i.title, i.body, i.tags, i.status::text as status,
            i.source_url, i.updated_at,
            (ts_rank_cd(i.search, q.tsq, 32)
              + ${TITLE_SIMILARITY_WEIGHT}::float8 * extensions.similarity(i.title, q.raw))::float8 as score
          from app.knowledge_items i cross join q
          where i.workspace_id = ${workspaceId}
            and i.status::text = any(${textArray(statuses)})
            ${kinds}
            and (i.search @@ q.tsq or i.title operator(extensions.%) q.raw)
          order by score desc, i.updated_at desc, i.id
          limit ${limit}
        )
        select top.*, ts_headline('english'::regconfig, top.body, q.tsq, ${HEADLINE_OPTIONS}) as snippet
        from top cross join q
        order by top.score desc, top.updated_at desc, top.id`,
  );
  return list.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    tags: r.tags ?? [],
    status: r.status,
    sourceUrl: r.source_url,
    snippet: r.snippet ?? '',
    score: Number(r.score),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export const fullTextKnowledgeRetriever: KnowledgeRetriever = {
  name: 'full_text',
  search: searchKnowledge,
};

/** The retriever in use. M7 swaps meaning-based search in here; callers never change. */
export function knowledgeRetriever(): KnowledgeRetriever {
  return fullTextKnowledgeRetriever;
}
