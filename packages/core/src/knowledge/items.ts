/**
 * Knowledge items (FAQs, articles, facts and documents) and suggestions (from website scans, knowledge
 * gaps and agency packs). Nothing enters the knowledge base until a person accepts it. Browser-safe.
 */
import { z } from 'zod';

export const KNOWLEDGE_KINDS = ['faq', 'article', 'fact', 'document'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const KNOWLEDGE_STATUSES = ['draft', 'published', 'archived'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];
export const KNOWLEDGE_SOURCES = [
  'manual',
  'website_scan',
  'ai_suggestion',
  'agency_pack',
] as const;
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];

const text = (max: number, error: string) =>
  z.string().trim().min(1, error).max(max, `Keep it under ${max} characters.`);
const tags = z
  .array(z.string().trim().min(1).max(40))
  .max(20)
  .default(() => []);

export const KnowledgeFaq = z.object({
  kind: z.literal('faq'),
  question: text(300, 'Write the question.'),
  answer: text(5000, 'Write the answer.'),
  tags,
});
export const KnowledgeArticle = z.object({
  kind: z.literal('article'),
  title: text(200, 'Give it a title.'),
  body: text(20000, 'Write the article.'),
  tags,
});
/** A short, precise statement ("Service area: Dallas–Fort Worth"). */
export const KnowledgeFact = z.object({
  kind: z.literal('fact'),
  title: text(200, 'Name the fact.'),
  body: text(2000, 'Write the fact.'),
  tags,
});
/** Text taken from an uploaded PDF or text file. */
export const KnowledgeDocument = z.object({
  kind: z.literal('document'),
  title: text(200, 'Give it a title.'),
  body: z.string().max(200_000),
  fileId: z.uuid(),
  tags,
});

export const KnowledgeItemContent = z.discriminatedUnion('kind', [
  KnowledgeFaq,
  KnowledgeArticle,
  KnowledgeFact,
  KnowledgeDocument,
]);
export type KnowledgeItemContent = z.infer<typeof KnowledgeItemContent>;
export type KnowledgeItemContentInput = z.input<typeof KnowledgeItemContent>;

export const KnowledgeItemMeta = z.object({
  status: z.enum(KNOWLEDGE_STATUSES).default('draft'),
  source: z.enum(KNOWLEDGE_SOURCES).default('manual'),
  sourceUrl: z.url().max(2000).nullable().default(null),
});
export type KnowledgeItemMeta = z.infer<typeof KnowledgeItemMeta>;

/** An item as prompts see it: FAQs read as title = question, body = answer. */
export interface KnowledgeItemForPrompt {
  readonly id: string;
  readonly kind: KnowledgeKind;
  readonly title: string;
  readonly body: string;
  readonly sourceUrl?: string | null;
}

export function itemForPrompt(
  id: string,
  content: KnowledgeItemContent,
  sourceUrl: string | null = null,
): KnowledgeItemForPrompt {
  return content.kind === 'faq'
    ? { id, kind: 'faq', title: content.question, body: content.answer, sourceUrl }
    : { id, kind: content.kind, title: content.title, body: content.body, sourceUrl };
}

// ---- Suggestions ----

export const KNOWLEDGE_SUGGESTION_REASONS = ['scan', 'gap', 'pack'] as const;
export type KnowledgeSuggestionReason = (typeof KNOWLEDGE_SUGGESTION_REASONS)[number];

export const KnowledgeSuggestionDraft = z
  .object({
    reason: z.enum(KNOWLEDGE_SUGGESTION_REASONS),
    /** The item to add; null for a gap, whose answer the owner writes when accepting. */
    proposed: KnowledgeItemContent.nullable().default(null),
    /** Gaps: the customer's question. */
    question: z.string().trim().min(1).max(300).nullable().default(null),
    /** Gaps: similar questions share a key, so the owner answers once. */
    groupKey: z.string().max(200).nullable().default(null),
    /** Scans: the page it came from; packs: which pack and version. */
    sourceRef: z.string().max(2000).nullable().default(null),
  })
  .refine((s) => (s.reason === 'gap' ? s.question !== null : s.proposed !== null), {
    error: 'A gap needs a question; other suggestions need an item.',
  });
export type KnowledgeSuggestionDraft = z.infer<typeof KnowledgeSuggestionDraft>;

const STOP_WORDS = new Set(
  'a an and are can could do does for from have has how i if in is it me my of on or our please the there to we what when where which who will with would you your'.split(
    ' ',
  ),
);

/** A key for grouping similar questions: the meaningful words, lightly stemmed and sorted. */
export function gapKey(question: string): string {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return [...new Set(words)].sort().join(' ').slice(0, 200);
}

/** Whether two gap keys share most of their words (Jaccard ≥ 0.5). */
export function similarGaps(a: string, b: string): boolean {
  const x = new Set(a.split(' ').filter(Boolean));
  const y = new Set(b.split(' ').filter(Boolean));
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= 0.5;
}

/** A gap suggestion ("Customers asked: do you offer financing?") from a question the AI couldn't answer. */
export function suggestionFromGap(
  question: string,
  sourceRef: string | null = null,
): KnowledgeSuggestionDraft {
  let q = question.replace(/\s+/g, ' ').trim().slice(0, 299);
  if (q && !/[?.!]$/.test(q)) q = `${q}?`;
  return KnowledgeSuggestionDraft.parse({
    reason: 'gap',
    question: q.charAt(0).toUpperCase() + q.slice(1),
    groupKey: gapKey(q),
    sourceRef,
  });
}
