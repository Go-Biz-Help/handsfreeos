/**
 * Milestone 6 schemas: the knowledge base (profile, items, documents, the website and its scans,
 * suggestions, search) and the agency's knowledge packs. Browser-safe.
 */
import { z } from 'zod';
import {
  KNOWLEDGE_KINDS,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_STATUSES,
  KNOWLEDGE_SUGGESTION_REASONS,
  KnowledgeArticle,
  KnowledgeDocument,
  KnowledgeFact,
  KnowledgeFaq,
} from '../knowledge/items';
import { KnowledgeProfile } from '../knowledge/profile';
import { displayName, isoDateTime, uuid } from './common';

const limit = z.int().min(1).max(100).default(50);
const cursor = z.string().max(400).optional();
const tagList = z.array(z.string().trim().min(1).max(40)).max(20);

export const KnowledgeKindValue = z.enum(KNOWLEDGE_KINDS);
export const KnowledgeStatusValue = z.enum(KNOWLEDGE_STATUSES);
export const KnowledgeSourceValue = z.enum(KNOWLEDGE_SOURCES);
export const KnowledgeReasonValue = z.enum(KNOWLEDGE_SUGGESTION_REASONS);
export const KnowledgeSuggestionStatusValue = z.enum(['pending', 'accepted', 'rejected']);
export const KnowledgeScanStatusValue = z.enum([
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
]);

/** What a person writes: an FAQ, an article or a fact (documents come from uploaded files). */
export const KnowledgeWritableContent = z.discriminatedUnion('kind', [
  KnowledgeFaq,
  KnowledgeArticle,
  KnowledgeFact,
]);
export type KnowledgeWritableContent = z.infer<typeof KnowledgeWritableContent>;
/** An edit: as above, or a document's title, text and tags (its file stays). */
export const KnowledgeEditableContent = z.discriminatedUnion('kind', [
  KnowledgeFaq,
  KnowledgeArticle,
  KnowledgeFact,
  KnowledgeDocument.omit({ fileId: true }),
]);
export type KnowledgeEditableContent = z.infer<typeof KnowledgeEditableContent>;

const UserOut = z.object({ id: uuid, fullName: z.string() });

// ---- Outputs ----

export const KnowledgeItemOut = z.object({
  id: uuid,
  kind: KnowledgeKindValue,
  /** An FAQ's question; the others' title. */
  title: z.string(),
  /** An FAQ's answer; the others' text. */
  body: z.string(),
  tags: z.array(z.string()),
  status: KnowledgeStatusValue,
  source: KnowledgeSourceValue,
  sourceUrl: z.string().nullable(),
  fileId: uuid.nullable(),
  useCount: z.int(),
  lastUsedAt: isoDateTime.nullable(),
  createdBy: UserOut.nullable(),
  updatedBy: UserOut.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type KnowledgeItemOut = z.infer<typeof KnowledgeItemOut>;

export const KnowledgeMatchOut = z.object({
  id: uuid,
  kind: KnowledgeKindValue,
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  status: KnowledgeStatusValue,
  sourceUrl: z.string().nullable(),
  /** The best passages, matched words wrapped in ** **. */
  snippet: z.string(),
  score: z.number(),
  updatedAt: isoDateTime,
});

export const KnowledgeSuggestionOut = z.object({
  id: uuid,
  kind: KnowledgeKindValue,
  reason: KnowledgeReasonValue,
  status: KnowledgeSuggestionStatusValue,
  /** The item as proposed ({title, body, tags}); a gap's title is the customer's question. */
  proposed: z.object({ title: z.string(), body: z.string(), tags: z.array(z.string()) }),
  source: z.record(z.string(), z.unknown()),
  scanId: uuid.nullable(),
  /** The item a rescan proposes to change, or the item it became. */
  itemId: uuid.nullable(),
  similarCount: z.int(),
  decidedBy: UserOut.nullable(),
  decidedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});

export const KnowledgePackItem = z.object({
  kind: z.enum(['faq', 'article', 'fact']),
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20000),
  tags: tagList.default(() => []),
});
export type KnowledgePackItem = z.infer<typeof KnowledgePackItem>;

// ---- Commands ----

export const KnowledgeProfileUpdateInput = z.object({
  workspaceId: uuid,
  /** The whole profile; its allowPrices is the business's "AI may quote prices" switch. */
  profile: KnowledgeProfile,
});
export const KnowledgeProfileUpdateOutput = z.object({
  profile: KnowledgeProfile,
  updated: z.array(z.string()),
  completeness: z.object({ filled: z.int(), total: z.int() }),
});

export const KnowledgeItemCreateInput = z.object({
  workspaceId: uuid,
  content: KnowledgeWritableContent,
  status: z.enum(['draft', 'published']).default('draft'),
});
export const KnowledgeItemUpdateInput = z.object({
  workspaceId: uuid,
  itemId: uuid,
  content: KnowledgeEditableContent,
});
export const KnowledgeItemRefInput = z.object({ workspaceId: uuid, itemId: uuid });
export const KnowledgeItemWriteOutput = z.object({
  itemId: uuid,
  status: KnowledgeStatusValue,
  updated: z.array(z.string()),
});

export const KnowledgeImportFaqsInput = z.object({
  workspaceId: uuid,
  rows: z
    .array(
      z.object({
        question: z.string().max(1000),
        answer: z.string().max(10000),
        tags: z.array(z.string().max(100)).max(40).optional(),
      }),
    )
    .min(1, 'Add at least one row.')
    .max(500, 'Import at most 500 rows at a time.'),
  status: z.enum(['draft', 'published']).default('draft'),
});
export const KnowledgeImportFaqsOutput = z.object({
  created: z.int(),
  /** Questions the knowledge base (or an earlier row) already has. */
  skipped: z.array(z.object({ row: z.int(), question: z.string() })),
  itemIds: z.array(uuid),
});

export const KnowledgeDocumentAddInput = z.object({
  workspaceId: uuid,
  fileId: uuid,
  title: z.string().trim().min(1).max(200).optional(),
});
export const KnowledgeDocumentAddOutput = z.object({ fileId: uuid, requested: z.literal(true) });

/** What a knowledge document can be: a PDF or a text file (Markdown goes up as text/plain), 5 MB at most. */
export const KNOWLEDGE_DOCUMENT_TYPES = ['application/pdf', 'text/plain', 'text/csv'] as const;
export const KNOWLEDGE_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
export const KnowledgeDocumentBeginUploadInput = z.object({
  workspaceId: uuid,
  name: z.string().trim().min(1).max(200),
  mimeType: z.enum(KNOWLEDGE_DOCUMENT_TYPES, { error: 'Upload a PDF or a text file.' }),
  sizeBytes: z.int().min(1).max(KNOWLEDGE_DOCUMENT_MAX_BYTES, 'Files can be up to 5 MB.'),
});
export const KnowledgeDocumentBeginUploadOutput = z.object({
  fileId: uuid,
  bucket: z.string(),
  objectPath: z.string(),
});

/** Why a document's text is empty or cut short: a scanned PDF, a file too big or broken to read, or text over the limit. */
export const KnowledgeDocumentNote = z.enum(['no_text', 'too_large', 'unreadable', 'truncated']);
export type KnowledgeDocumentNote = z.infer<typeof KnowledgeDocumentNote>;
export const KnowledgeDocumentSaveTextInput = z.object({
  workspaceId: uuid,
  fileId: uuid,
  title: z.string().trim().min(1).max(200),
  /** The text read from the file; empty when there was none to read. */
  text: z.string().max(200_000),
  note: KnowledgeDocumentNote.nullable().default(null),
});
export const KnowledgeDocumentSaveTextOutput = z.object({ itemId: uuid, created: z.boolean() });

export const KnowledgeSourceSetInput = z.object({
  workspaceId: uuid,
  url: z.string().trim().min(1, 'Enter the website address.').max(2000),
});
export const KnowledgeSourceSetOutput = z.object({ sourceId: uuid, url: z.string() });

export const KnowledgeScanStartInput = z.object({ workspaceId: uuid });
export const KnowledgeScanStartOutput = z.object({ scanId: uuid, sourceId: uuid, url: z.string() });

export const KnowledgeSuggestionAcceptInput = z.object({
  workspaceId: uuid,
  suggestionId: uuid,
  /** Changes over what was proposed (a gap needs its answer here). */
  edits: z
    .object({
      kind: z.enum(['faq', 'article', 'fact']).optional(),
      title: z.string().max(300).optional(),
      body: z.string().max(20000).optional(),
      tags: tagList.optional(),
    })
    .optional(),
  status: z.enum(['draft', 'published']).default('published'),
});
export const KnowledgeSuggestionAcceptOutput = z.object({
  suggestionId: uuid,
  itemId: uuid,
  created: z.boolean(),
});
export const KnowledgeSuggestionRejectInput = z.object({
  workspaceId: uuid,
  suggestionId: uuid,
  reason: z.string().trim().max(500).nullable().optional(),
});
export const KnowledgeSuggestionRejectOutput = z.object({
  suggestionId: uuid,
  status: KnowledgeSuggestionStatusValue,
});

const ProposedContent = z.discriminatedUnion('kind', [
  KnowledgeFaq,
  KnowledgeArticle,
  KnowledgeFact,
]);
export const KnowledgeProposal = z.discriminatedUnion('reason', [
  z.object({
    reason: z.literal('gap'),
    /** The customer's question the AI couldn't answer. */
    question: z.string().trim().min(1).max(300),
    /** Defaults to core's gapKey(question). */
    groupKey: z.string().min(1).max(200).optional(),
    /** {runId, stepKey} for an AI step; {threadId} for the Assistant. */
    source: z.record(z.string(), z.string().max(300)).default(() => ({})),
  }),
  z.object({
    reason: z.literal('scan'),
    content: ProposedContent,
    sourceUrl: z.url().max(2000),
    /** The item a rescan proposes to change. */
    itemId: uuid.nullable().default(null),
  }),
  z.object({
    reason: z.literal('pack'),
    content: ProposedContent,
    packId: uuid,
    version: z.int().min(1),
  }),
]);
export type KnowledgeProposal = z.infer<typeof KnowledgeProposal>;

export const KnowledgeSuggestionProposeInput = z.object({
  workspaceId: uuid,
  scanId: uuid.nullable().default(null),
  suggestions: z.array(KnowledgeProposal).min(1).max(200),
});
export const KnowledgeSuggestionProposeOutput = z.object({
  suggestionIds: z.array(uuid),
  created: z.int(),
  /** Gaps that joined a similar pending question instead. */
  grouped: z.int(),
});

export const KnowledgeRecordUseInput = z.object({
  workspaceId: uuid,
  itemIds: z.array(uuid).min(1).max(50),
});
export const KnowledgeRecordUseOutput = z.object({ updated: z.int() });

// ---- Agency packs (organization level) ----

export const KnowledgePackCreateInput = z.object({
  organizationId: uuid,
  name: displayName,
  description: z.string().trim().max(2000).nullable().optional(),
  items: z
    .array(KnowledgePackItem)
    .max(500)
    .default(() => []),
});
export const KnowledgePackUpdateInput = z
  .object({
    organizationId: uuid,
    packId: uuid,
    name: displayName.optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    items: z.array(KnowledgePackItem).max(500).optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.items !== undefined ||
      v.archived !== undefined,
    { error: 'Change something.' },
  );
export const KnowledgePackWriteOutput = z.object({
  packId: uuid,
  version: z.int(),
  updated: z.array(z.string()),
});
export const KnowledgePackPushInput = z.object({
  organizationId: uuid,
  packId: uuid,
  workspaceIds: z.array(uuid).min(1, 'Pick a business.').max(100),
});
export const KnowledgePackPushOutput = z.object({
  packId: uuid,
  version: z.int(),
  workspaceIds: z.array(uuid),
});

// ---- Queries ----

export const KnowledgeProfileGetInput = z.object({ workspaceId: uuid });
export const KnowledgeProfileOutput = z.object({
  profile: KnowledgeProfile,
  completeness: z.object({ filled: z.int(), total: z.int() }),
  updatedBy: UserOut.nullable(),
  updatedAt: isoDateTime.nullable(),
});

export const KnowledgeItemListInput = z.object({
  workspaceId: uuid,
  search: z.string().trim().min(1).max(200).optional(),
  kind: z.array(KnowledgeKindValue).max(4).optional(),
  /** Items with every one of these tags. */
  tags: tagList.optional(),
  /** Draft and published when missing. */
  status: z.array(KnowledgeStatusValue).max(3).optional(),
  limit,
  cursor,
});
export const KnowledgeItemListOutput = z.object({
  items: z.array(KnowledgeItemOut),
  nextCursor: z.string().nullable(),
  counts: z.object({ draft: z.int(), published: z.int(), archived: z.int() }),
});
export const KnowledgeItemGetInput = z.object({ workspaceId: uuid, itemId: uuid });
export const KnowledgeItemGetOutput = z.object({
  item: KnowledgeItemOut.extend({ file: z.object({ id: uuid, name: z.string() }).nullable() }),
});

export const KnowledgeSearchInput = z.object({
  workspaceId: uuid,
  query: z.string().trim().min(1, 'Type a question or words to find.').max(500),
  limit: z.int().min(1).max(20).default(5),
  kinds: z.array(KnowledgeKindValue).max(4).optional(),
  includeDrafts: z.boolean().default(false),
});
export const KnowledgeSearchOutput = z.object({ matches: z.array(KnowledgeMatchOut) });

export const KnowledgeScanGetInput = z.object({
  workspaceId: uuid,
  /** Missing: the newest scan. */
  scanId: uuid.optional(),
});
export const KnowledgeScanGetOutput = z.object({
  source: z.object({ id: uuid, url: z.string(), updatedAt: isoDateTime }).nullable(),
  scan: z
    .object({
      id: uuid,
      status: KnowledgeScanStatusValue,
      pages: z.array(z.record(z.string(), z.unknown())),
      suggestionCount: z.int(),
      pendingSuggestions: z.int(),
      errors: z.array(z.unknown()),
      startedBy: UserOut.nullable(),
      startedAt: isoDateTime.nullable(),
      finishedAt: isoDateTime.nullable(),
      createdAt: isoDateTime,
    })
    .nullable(),
});

export const KnowledgeSuggestionListInput = z.object({
  workspaceId: uuid,
  status: KnowledgeSuggestionStatusValue.default('pending'),
  reason: KnowledgeReasonValue.optional(),
  scanId: uuid.optional(),
  limit,
  cursor,
});
export const KnowledgeSuggestionListOutput = z.object({
  items: z.array(KnowledgeSuggestionOut),
  nextCursor: z.string().nullable(),
});

export const KnowledgePackListInput = z.object({
  organizationId: uuid,
  includeArchived: z.boolean().default(false),
});
export const KnowledgePackListOutput = z.object({
  items: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      description: z.string().nullable(),
      items: z.array(KnowledgePackItem),
      version: z.int(),
      archivedAt: isoDateTime.nullable(),
      createdBy: UserOut.nullable(),
      updatedAt: isoDateTime,
    }),
  ),
});
