/**
 * The knowledge base (knowledge.manage): the business profile, FAQs, articles and facts, CSV import of
 * FAQs, documents from uploaded files (the engine reads their text), the website and its scans, and
 * deciding suggestions. The system (and a workflow's AI step) proposes suggestions and records which items
 * it used. Website, document and customer text is data, never instructions: nothing enters the knowledge
 * base until a person accepts it.
 */
import { and, eq, inArray, ne, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  files,
  knowledgeItems,
  knowledgeProfiles,
  knowledgeScans,
  knowledgeSources,
  knowledgeSuggestions,
  users,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { isUniqueViolation } from '../kernel/pg-errors';
import type { CommandContext } from '../kernel/types';
import { gapKey, KnowledgeItemContent, similarGaps } from '../knowledge/items';
import { emptyKnowledgeProfile, KnowledgeProfile, profileCompleteness } from '../knowledge/profile';
import {
  KnowledgeDocumentAddInput,
  KnowledgeDocumentAddOutput,
  KnowledgeDocumentSaveTextInput,
  KnowledgeDocumentSaveTextOutput,
  KnowledgeImportFaqsInput,
  KnowledgeImportFaqsOutput,
  KnowledgeItemCreateInput,
  KnowledgeItemRefInput,
  KnowledgeItemUpdateInput,
  KnowledgeItemWriteOutput,
  KnowledgeProfileUpdateInput,
  KnowledgeProfileUpdateOutput,
  KnowledgeRecordUseInput,
  KnowledgeRecordUseOutput,
  KnowledgeScanStartInput,
  KnowledgeScanStartOutput,
  KnowledgeSourceSetInput,
  KnowledgeSourceSetOutput,
  KnowledgeSuggestionAcceptInput,
  KnowledgeSuggestionAcceptOutput,
  KnowledgeSuggestionProposeInput,
  KnowledgeSuggestionProposeOutput,
  KnowledgeSuggestionRejectInput,
  KnowledgeSuggestionRejectOutput,
} from '../schemas/knowledge';
import { jsonEqual } from '../workflows/json';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type ItemKind = 'faq' | 'article' | 'fact' | 'document';
interface ItemColumns {
  kind: ItemKind;
  title: string;
  body: string;
  tags: string[];
}

/** An item's content as its columns: an FAQ's question is its title and its answer its body. */
function columnsOf(
  c:
    | { kind: 'faq'; question: string; answer: string; tags: string[] }
    | { kind: 'article' | 'fact' | 'document'; title: string; body: string; tags: string[] },
): ItemColumns {
  return c.kind === 'faq'
    ? { kind: 'faq', title: c.question, body: c.answer, tags: c.tags }
    : { kind: c.kind, title: c.title, body: c.body, tags: c.tags };
}

/** Checks columns against the kind's own limits, reporting problems on `title` and `body` under `prefix`. */
function checkedColumns(cols: ItemColumns, prefix: string): ItemColumns {
  const raw =
    cols.kind === 'faq'
      ? { kind: 'faq', question: cols.title, answer: cols.body, tags: cols.tags }
      : cols.kind === 'document'
        ? { kind: 'document', title: cols.title, body: cols.body, tags: cols.tags, fileId: ZERO }
        : { kind: cols.kind, title: cols.title, body: cols.body, tags: cols.tags };
  const parsed = KnowledgeItemContent.safeParse(raw);
  if (!parsed.success) {
    const field = (k: PropertyKey | undefined) =>
      k === 'question' ? 'title' : k === 'answer' ? 'body' : String(k ?? '');
    throw HfosError.validation(
      parsed.error.issues.map((i) => ({
        path: [prefix, field(i.path[0]), ...i.path.slice(1).map(String)].filter(Boolean).join('.'),
        message: i.message,
      })),
    );
  }
  return columnsOf(parsed.data);
}
const ZERO = '00000000-0000-4000-8000-000000000000';

const REASON_SOURCE = { scan: 'website_scan', gap: 'ai_suggestion', pack: 'agency_pack' } as const;

async function loadItem(ctx: CommandContext, itemId: string) {
  const [item] = await ctx.tx
    .select()
    .from(knowledgeItems)
    .where(
      and(eq(knowledgeItems.id, itemId), eq(knowledgeItems.workspaceId, ctx.scope.workspaceId!)),
    )
    .for('update');
  if (!item) throw HfosError.notFound('Item not found.');
  return item;
}

// ---- The profile ----

export const knowledgeProfileUpdate = defineCommand({
  name: 'knowledge.profile_update',
  description:
    'Save the business profile the AI writes from: what you do, services, area, hours, policies, tone of voice, words to use and avoid, signature, and whether AI may quote prices.',
  risk: 1,
  input: KnowledgeProfileUpdateInput,
  output: KnowledgeProfileUpdateOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['knowledge.profile_updated'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(knowledgeProfiles)
      .where(eq(knowledgeProfiles.workspaceId, ws))
      .for('update');
    const stored = current ? KnowledgeProfile.safeParse(current.profile) : null;
    const before: KnowledgeProfile = {
      ...(stored?.success ? stored.data : emptyKnowledgeProfile()),
      allowPrices: current?.allowPrices ?? false,
    };
    const next = input.profile;
    const updated = (Object.keys(next) as (keyof KnowledgeProfile)[]).filter(
      (k) => !jsonEqual(before[k], next[k]),
    );
    const completeness = profileCompleteness(next);
    if (current && !updated.length) return { profile: next, updated, completeness };
    // The column is what grounding reads; the document keeps the same value so the two never disagree.
    const values = {
      profile: next as unknown as Record<string, unknown>,
      allowPrices: next.allowPrices,
      updatedBy: me,
    };
    await ctx.tx
      .insert(knowledgeProfiles)
      .values({ workspaceId: ws, ...values })
      .onConflictDoUpdate({ target: knowledgeProfiles.workspaceId, set: values });
    const pricesChanged = updated.includes('allowPrices');
    await ctx.emit({
      type: 'knowledge.profile_updated',
      entityType: 'knowledge_profile',
      entityId: ws,
      payload: { fields: updated, allowPrices: next.allowPrices },
      before: pricesChanged ? { allowPrices: before.allowPrices } : null,
      after: {
        changed: updated.join(', ') || 'created',
        ...(pricesChanged ? { allowPrices: next.allowPrices } : {}),
        completeness: `${completeness.filled} of ${completeness.total}`,
      },
    });
    return { profile: next, updated, completeness };
  },
});

// ---- Items ----

export const knowledgeItemCreate = defineCommand({
  name: 'knowledge_item.create',
  description: 'Add an FAQ, article or fact to the knowledge base, as a draft or published.',
  risk: 1,
  input: KnowledgeItemCreateInput,
  output: KnowledgeItemWriteOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['knowledge_item.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const cols = columnsOf(input.content);
    const [row] = await ctx.tx
      .insert(knowledgeItems)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        ...cols,
        status: input.status,
        source: 'manual',
        createdBy: me,
        updatedBy: me,
      })
      .returning({ id: knowledgeItems.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'knowledge_item.created',
      entityType: 'knowledge_item',
      entityId: row.id,
      payload: { itemId: row.id, kind: cols.kind, status: input.status, source: 'manual' },
      after: { title: cols.title, kind: cols.kind, status: input.status },
    });
    return { itemId: row.id, status: input.status, updated: [] };
  },
});

export const knowledgeItemUpdate = defineCommand({
  name: 'knowledge_item.update',
  description:
    'Change an item’s text, title or question, tags, or kind (an FAQ, article or fact; a document stays a document).',
  risk: 1,
  input: KnowledgeItemUpdateInput,
  output: KnowledgeItemWriteOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['knowledge_item.updated'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const item = await loadItem(ctx, input.itemId);
    if ((item.kind === 'document') !== (input.content.kind === 'document'))
      throw HfosError.validation([
        {
          path: 'content.kind',
          message:
            item.kind === 'document'
              ? 'A document stays a document.'
              : 'Documents come from uploaded files.',
        },
      ]);
    const cols = columnsOf(input.content);
    const patch: Partial<ItemColumns> = {};
    if (cols.kind !== item.kind) patch.kind = cols.kind;
    if (cols.title !== item.title) patch.title = cols.title;
    if (cols.body !== item.body) patch.body = cols.body;
    if (!jsonEqual(cols.tags, item.tags)) patch.tags = cols.tags;
    const updated = Object.keys(patch);
    if (!updated.length) return { itemId: item.id, status: item.status, updated };
    await ctx.tx
      .update(knowledgeItems)
      .set({ ...patch, updatedBy: me })
      .where(eq(knowledgeItems.id, item.id));
    await ctx.emit({
      type: 'knowledge_item.updated',
      entityType: 'knowledge_item',
      entityId: item.id,
      payload: { itemId: item.id, fields: updated },
      before: {
        title: item.title,
        ...(patch.kind ? { kind: item.kind } : {}),
        ...(patch.tags ? { tags: item.tags.join(', ') } : {}),
      },
      after: {
        title: cols.title,
        ...(patch.kind ? { kind: cols.kind } : {}),
        ...(patch.tags ? { tags: cols.tags.join(', ') } : {}),
        ...(patch.body !== undefined ? { text: 'changed' } : {}),
      },
    });
    return { itemId: item.id, status: item.status, updated };
  },
});

async function setItemStatus(
  ctx: CommandContext,
  itemId: string,
  to: 'published' | 'archived',
): Promise<{ itemId: string; status: typeof to; updated: string[] }> {
  const me = requireHuman(ctx).userId;
  const item = await loadItem(ctx, itemId);
  if (item.status === to) return { itemId: item.id, status: to, updated: [] };
  if (to === 'published' && !item.body.trim())
    throw HfosError.conflict('Add the text before publishing.', 'item_empty');
  await ctx.tx
    .update(knowledgeItems)
    .set({ status: to, updatedBy: me })
    .where(eq(knowledgeItems.id, item.id));
  await ctx.emit({
    type: to === 'published' ? 'knowledge_item.published' : 'knowledge_item.archived',
    entityType: 'knowledge_item',
    entityId: item.id,
    payload: { itemId: item.id, from: item.status, to },
    before: { title: item.title, status: item.status },
    after: { title: item.title, status: to },
  });
  return { itemId: item.id, status: to, updated: ['status'] };
}

export const knowledgeItemPublish = defineCommand({
  name: 'knowledge_item.publish',
  description: 'Publish an item so AI steps and the Assistant can use it.',
  risk: 1,
  input: KnowledgeItemRefInput,
  output: KnowledgeItemWriteOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['knowledge_item.published'],
  async handler(ctx, input) {
    return setItemStatus(ctx, input.itemId, 'published');
  },
});

export const knowledgeItemArchive = defineCommand({
  name: 'knowledge_item.archive',
  description:
    'Archive an item: the AI stops using it. Run logs keep pointing at it; publish it again to bring it back.',
  risk: 1,
  input: KnowledgeItemRefInput,
  output: KnowledgeItemWriteOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['knowledge_item.archived'],
  async handler(ctx, input) {
    return setItemStatus(ctx, input.itemId, 'archived');
  },
});

const questionKey = (q: string) => q.replace(/\s+/g, ' ').trim().toLowerCase();

export const knowledgeItemImportFaqs = defineCommand({
  name: 'knowledge_item.import_faqs',
  description:
    'Import FAQs from a spreadsheet (question, answer, optional tags; up to 500 rows). Questions the knowledge base already has are skipped.',
  risk: 1,
  input: KnowledgeImportFaqsInput,
  output: KnowledgeImportFaqsOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['knowledge_item.imported'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const problems: { path: string; message: string }[] = [];
    const good: { row: number; cols: ItemColumns }[] = [];
    input.rows.forEach((r, i) => {
      const seenTags = new Set<string>();
      const tags = (r.tags ?? [])
        .map((t) => t.trim())
        .filter((t) => t && !seenTags.has(t.toLowerCase()) && seenTags.add(t.toLowerCase()));
      try {
        good.push({
          row: i,
          cols: checkedColumns(
            { kind: 'faq', title: r.question, body: r.answer, tags },
            `rows.${i}`,
          ),
        });
      } catch (e) {
        if (!(e instanceof HfosError)) throw e;
        problems.push(...(e.details as { path: string; message: string }[]));
      }
    });
    if (problems.length)
      throw HfosError.validation(
        problems.map((p) => ({
          ...p,
          path: p.path.replace(/\.title$/, '.question').replace(/\.body$/, '.answer'),
        })),
      );
    const existing = new Set(
      (
        await rows<{ q: string }>(
          ctx.tx,
          sql`select lower(regexp_replace(btrim(title), '\\s+', ' ', 'g')) as q from app.knowledge_items
              where workspace_id = ${ws} and kind = 'faq' and status <> 'archived'`,
        )
      ).map((r) => r.q),
    );
    const skipped: { row: number; question: string }[] = [];
    const fresh: ItemColumns[] = [];
    for (const g of good) {
      const key = questionKey(g.cols.title);
      if (existing.has(key)) skipped.push({ row: g.row, question: g.cols.title });
      else {
        existing.add(key);
        fresh.push(g.cols);
      }
    }
    if (!fresh.length) return { created: 0, skipped, itemIds: [] };
    const inserted = await ctx.tx
      .insert(knowledgeItems)
      .values(
        fresh.map((cols) => ({
          workspaceId: ws,
          ...cols,
          status: input.status,
          source: 'manual' as const,
          createdBy: me,
          updatedBy: me,
        })),
      )
      .returning({ id: knowledgeItems.id });
    await ctx.emit({
      type: 'knowledge_item.imported',
      entityType: 'knowledge_item',
      entityId: null,
      payload: { count: inserted.length, skipped: skipped.length, status: input.status },
      after: { imported: inserted.length, skipped: skipped.length, status: input.status },
    });
    return { created: inserted.length, skipped, itemIds: inserted.map((r) => r.id) };
  },
});

// ---- Documents, the website, scans ----

const TEXT_FILE = /\.(txt|md|markdown|csv)$/i;

export const knowledgeDocumentAdd = defineCommand({
  name: 'knowledge_document.add',
  description:
    'Add an uploaded PDF or text file to the knowledge base. Its text becomes a draft document item to review and publish.',
  risk: 1,
  input: KnowledgeDocumentAddInput,
  output: KnowledgeDocumentAddOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['knowledge_document.added'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [f] = await ctx.tx
      .select({
        id: files.id,
        name: files.name,
        mimeType: files.mimeType,
        status: files.status,
        deletedAt: files.deletedAt,
      })
      .from(files)
      .where(and(eq(files.id, input.fileId), eq(files.workspaceId, ws)));
    if (!f || f.deletedAt) throw HfosError.notFound('File not found.');
    if (f.status !== 'ready')
      throw HfosError.conflict('The file hasn’t finished uploading.', 'file_not_uploaded');
    const type = (f.mimeType ?? '').toLowerCase();
    const pdf = type === 'application/pdf' || /\.pdf$/i.test(f.name);
    const text = type.startsWith('text/') || TEXT_FILE.test(f.name);
    if (!pdf && !text)
      throw new HfosError(
        'validation',
        400,
        'Upload a PDF or a text file.',
        [{ path: 'fileId', message: 'Upload a PDF or a text file.' }],
        'unsupported_file_type',
      );
    const [already] = await ctx.tx
      .select({ id: knowledgeItems.id })
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.fileId, f.id), ne(knowledgeItems.status, 'archived')));
    if (already)
      throw HfosError.conflict('This file is already in the knowledge base.', 'document_exists');
    const title = input.title ?? (f.name.replace(/\.[a-z0-9]{1,8}$/i, '').trim() || f.name);
    await ctx.emit({
      type: 'knowledge_document.added',
      entityType: 'file',
      entityId: f.id,
      payload: {
        fileId: f.id,
        title: title.slice(0, 200),
        mimeType: f.mimeType,
        kind: pdf ? 'pdf' : 'text',
        requestedBy: me,
      },
      after: { file: f.name, title: title.slice(0, 200) },
    });
    return { fileId: f.id, requested: true as const };
  },
});

/** What the audit log says when a document's text is empty or cut short. */
const DOCUMENT_NOTES = {
  no_text: 'No text found: it may be a scanned image',
  too_large: 'Too big to read (over 5 MB)',
  unreadable: 'The file couldn’t be read',
  truncated: 'Only the first 100,000 characters were kept',
} as const;

export const knowledgeDocumentSaveText = defineCommand({
  name: 'knowledge_document.save_text',
  description:
    'System: save the text read from an uploaded document as a draft document item, for a person to review and publish.',
  risk: 1,
  input: KnowledgeDocumentSaveTextInput,
  output: KnowledgeDocumentSaveTextOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['knowledge_item.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [f] = await ctx.tx
      .select({ id: files.id, deletedAt: files.deletedAt })
      .from(files)
      .where(and(eq(files.id, input.fileId), eq(files.workspaceId, ws)));
    if (!f || f.deletedAt) throw HfosError.notFound('File not found.');
    // A retry after the item was made finds it instead of adding a second one.
    const [already] = await ctx.tx
      .select({ id: knowledgeItems.id })
      .from(knowledgeItems)
      .where(
        and(
          eq(knowledgeItems.workspaceId, ws),
          eq(knowledgeItems.fileId, f.id),
          ne(knowledgeItems.status, 'archived'),
        ),
      );
    if (already) return { itemId: already.id, created: false };
    // The person who added the file, while they're still in the workspace.
    const asked = ctx.actor.type === 'system' ? (ctx.actor.onBehalfOf ?? null) : null;
    const [by] = asked
      ? await ctx.tx.select({ id: users.id }).from(users).where(eq(users.id, asked))
      : [];
    const [row] = await ctx.tx
      .insert(knowledgeItems)
      .values({
        workspaceId: ws,
        kind: 'document',
        title: input.title,
        body: input.text,
        status: 'draft',
        source: 'manual',
        fileId: f.id,
        createdBy: by?.id ?? null,
        updatedBy: by?.id ?? null,
      })
      .returning({ id: knowledgeItems.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'knowledge_item.created',
      entityType: 'knowledge_item',
      entityId: row.id,
      payload: {
        itemId: row.id,
        kind: 'document',
        status: 'draft',
        source: 'manual',
        fileId: f.id,
        chars: input.text.length,
        note: input.note,
      },
      after: {
        title: input.title,
        kind: 'document',
        status: 'draft',
        ...(input.note ? { note: DOCUMENT_NOTES[input.note] } : {}),
      },
    });
    return { itemId: row.id, created: true };
  },
});

const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|\d{1,3}(\.\d{1,3}){3}|\[.*\])$/i;

/** A website address as stored: https only, host lowercased, no credentials, query or fragment. */
export function normalizeSiteUrl(raw: string): string {
  const bad = (message: string) =>
    new HfosError('validation', 400, message, [{ path: 'url', message }], 'website_url_invalid');
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad('Enter a website address like https://example.com.');
  }
  if (u.protocol !== 'https:') throw bad('Use the https:// address of the website.');
  if (u.username || u.password) throw bad('Leave the user name and password out of the address.');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || PRIVATE_HOST.test(host))
    throw bad('Enter the business’s public website address.');
  const path = u.pathname === '/' ? '/' : u.pathname.replace(/\/+$/, '');
  return `https://${host}${u.port ? `:${u.port}` : ''}${path}`;
}

export const knowledgeSourceSet = defineCommand({
  name: 'knowledge_source.set',
  description:
    'Set the business’s website address for “Scan our website” (https only; one website per business).',
  risk: 1,
  input: KnowledgeSourceSetInput,
  output: KnowledgeSourceSetOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['knowledge_source.set'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const url = normalizeSiteUrl(input.url);
    const [current] = await ctx.tx
      .select({ id: knowledgeSources.id, url: knowledgeSources.url })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.workspaceId, ws));
    if (current?.url === url) return { sourceId: current.id, url };
    const [row] = await ctx.tx
      .insert(knowledgeSources)
      .values({ workspaceId: ws, url, createdBy: me })
      .onConflictDoUpdate({ target: knowledgeSources.workspaceId, set: { url } })
      .returning({ id: knowledgeSources.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'knowledge_source.set',
      entityType: 'knowledge_source',
      entityId: row.id,
      payload: { sourceId: row.id, url },
      before: current ? { url: current.url } : null,
      after: { url },
    });
    return { sourceId: row.id, url };
  },
});

export const knowledgeScanStart = defineCommand({
  name: 'knowledge_scan.start',
  description:
    'Scan the business’s website: the engine reads its pages and proposes facts, FAQs and articles to accept. One scan at a time.',
  risk: 1,
  input: KnowledgeScanStartInput,
  output: KnowledgeScanStartOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['knowledge_scan.requested'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = input.workspaceId;
    const [source] = await ctx.tx
      .select({ id: knowledgeSources.id, url: knowledgeSources.url })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.workspaceId, ws));
    if (!source) throw HfosError.conflict('Add the website address first.', 'no_website');
    const running = () => HfosError.conflict('A scan is already running.', 'scan_running');
    const [live] = await ctx.tx
      .select({ id: knowledgeScans.id })
      .from(knowledgeScans)
      .where(
        and(
          eq(knowledgeScans.sourceId, source.id),
          inArray(knowledgeScans.status, ['queued', 'running']),
        ),
      );
    if (live) throw running();
    let scanId: string;
    try {
      const [row] = await ctx.tx
        .insert(knowledgeScans)
        .values({ workspaceId: ws, sourceId: source.id, startedBy: me })
        .returning({ id: knowledgeScans.id });
      if (!row) throw HfosError.forbidden();
      scanId = row.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw running();
      throw e;
    }
    await ctx.emit({
      type: 'knowledge_scan.requested',
      entityType: 'knowledge_scan',
      entityId: scanId,
      payload: { scanId, sourceId: source.id, url: source.url, requestedBy: me },
      after: { url: source.url },
    });
    return { scanId, sourceId: source.id, url: source.url };
  },
});

// ---- Suggestions ----

type SuggestionRow = typeof knowledgeSuggestions.$inferSelect;
const proposedOf = (s: SuggestionRow) => {
  const p = (s.proposed ?? {}) as { title?: unknown; body?: unknown; tags?: unknown };
  return {
    title: typeof p.title === 'string' ? p.title : '',
    body: typeof p.body === 'string' ? p.body : '',
    tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : [],
  };
};

export const knowledgeSuggestionAccept = defineCommand({
  name: 'knowledge_suggestion.accept',
  description:
    'Accept a suggestion (from a website scan, a question the AI couldn’t answer, or an agency pack), with any edits. It becomes an item, or updates the item a rescan changed.',
  risk: 1,
  input: KnowledgeSuggestionAcceptInput,
  output: KnowledgeSuggestionAcceptOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['knowledge_suggestion.accepted', 'knowledge_item.created', 'knowledge_item.updated'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [s] = await ctx.tx
      .select()
      .from(knowledgeSuggestions)
      .where(
        and(
          eq(knowledgeSuggestions.id, input.suggestionId),
          eq(knowledgeSuggestions.workspaceId, ws),
        ),
      );
    // Not locked: FOR UPDATE would also apply the update policy, which hides a decided suggestion. The claim
    // below matches only a pending row, and losing it rolls the whole accept back.
    if (!s) throw HfosError.notFound('Suggestion not found.');
    const decided = () =>
      HfosError.conflict('This suggestion was already decided.', 'suggestion_decided');
    if (s.status !== 'pending') throw decided();
    const proposed = proposedOf(s);
    const edits = input.edits ?? {};
    const cols = checkedColumns(
      {
        kind: edits.kind ?? (s.kind === 'document' ? 'article' : s.kind),
        title: edits.title ?? proposed.title,
        body: edits.body ?? proposed.body,
        tags: edits.tags ?? proposed.tags,
      },
      'edits',
    );
    const source = (s.source ?? {}) as Record<string, unknown>;
    const sourceUrl =
      s.reason === 'scan' && typeof source.url === 'string' && /^https?:\/\//i.test(source.url)
        ? source.url.slice(0, 2000)
        : null;
    const [target] = s.itemId
      ? await ctx.tx
          .select()
          .from(knowledgeItems)
          .where(and(eq(knowledgeItems.id, s.itemId), eq(knowledgeItems.workspaceId, ws)))
          .for('update')
      : [];
    let itemId: string;
    if (target) {
      itemId = target.id;
      await ctx.tx
        .update(knowledgeItems)
        .set({
          ...cols,
          status: input.status,
          ...(sourceUrl ? { sourceUrl } : {}),
          updatedBy: me,
        })
        .where(eq(knowledgeItems.id, target.id));
      await ctx.emit({
        type: 'knowledge_item.updated',
        entityType: 'knowledge_item',
        entityId: target.id,
        payload: {
          itemId: target.id,
          fields: ['kind', 'title', 'body', 'tags', 'status'],
          suggestionId: s.id,
        },
        before: { title: target.title, status: target.status },
        after: { title: cols.title, status: input.status, text: 'changed' },
      });
    } else {
      const [row] = await ctx.tx
        .insert(knowledgeItems)
        .values({
          workspaceId: ws,
          ...cols,
          status: input.status,
          source: REASON_SOURCE[s.reason],
          sourceUrl,
          createdBy: me,
          updatedBy: me,
        })
        .returning({ id: knowledgeItems.id });
      if (!row) throw HfosError.forbidden();
      itemId = row.id;
      await ctx.emit({
        type: 'knowledge_item.created',
        entityType: 'knowledge_item',
        entityId: row.id,
        payload: {
          itemId: row.id,
          kind: cols.kind,
          status: input.status,
          source: REASON_SOURCE[s.reason],
          suggestionId: s.id,
        },
        after: { title: cols.title, kind: cols.kind, status: input.status },
      });
    }
    const [claimed] = await ctx.tx
      .update(knowledgeSuggestions)
      .set({ status: 'accepted', itemId, decidedBy: me, decidedAt: dsql`now()` })
      .where(and(eq(knowledgeSuggestions.id, s.id), eq(knowledgeSuggestions.status, 'pending')))
      .returning({ id: knowledgeSuggestions.id });
    if (!claimed) throw decided();
    await ctx.emit({
      type: 'knowledge_suggestion.accepted',
      entityType: 'knowledge_suggestion',
      entityId: s.id,
      payload: {
        suggestionId: s.id,
        itemId,
        reason: s.reason,
        created: !target,
        edited: input.edits !== undefined,
      },
      after: { title: cols.title, kind: cols.kind, from: s.reason },
    });
    return { suggestionId: s.id, itemId, created: !target };
  },
});

export const knowledgeSuggestionReject = defineCommand({
  name: 'knowledge_suggestion.reject',
  description: 'Reject a suggestion. Nothing is added to the knowledge base.',
  risk: 1,
  input: KnowledgeSuggestionRejectInput,
  output: KnowledgeSuggestionRejectOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['knowledge_suggestion.rejected'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [s] = await ctx.tx
      .select()
      .from(knowledgeSuggestions)
      .where(
        and(
          eq(knowledgeSuggestions.id, input.suggestionId),
          eq(knowledgeSuggestions.workspaceId, ws),
        ),
      );
    if (!s) throw HfosError.notFound('Suggestion not found.');
    const decided = () =>
      HfosError.conflict('This suggestion was already decided.', 'suggestion_decided');
    if (s.status !== 'pending') throw decided();
    const [claimed] = await ctx.tx
      .update(knowledgeSuggestions)
      .set({ status: 'rejected', decidedBy: me, decidedAt: dsql`now()` })
      .where(and(eq(knowledgeSuggestions.id, s.id), eq(knowledgeSuggestions.status, 'pending')))
      .returning({ id: knowledgeSuggestions.id });
    if (!claimed) throw decided();
    await ctx.emit({
      type: 'knowledge_suggestion.rejected',
      entityType: 'knowledge_suggestion',
      entityId: s.id,
      payload: { suggestionId: s.id, reason: s.reason, note: input.reason ?? null },
      after: {
        title: proposedOf(s).title,
        from: s.reason,
        ...(input.reason ? { note: input.reason } : {}),
      },
    });
    return { suggestionId: s.id, status: 'rejected' as const };
  },
});

// ---- System (and a workflow's AI step) ----

export const knowledgeSuggestionPropose = defineCommand({
  name: 'knowledge_suggestion.propose',
  description:
    'System: propose suggestions from a website scan, an agency pack, or questions the AI couldn’t answer (gaps). A gap like one already pending raises its count instead of adding another.',
  risk: 1,
  input: KnowledgeSuggestionProposeInput,
  output: KnowledgeSuggestionProposeOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system', 'workflow'],
  emits: ['knowledge_suggestion.proposed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const gaps = input.suggestions.some((s) => s.reason === 'gap')
      ? await rows<{ id: string; group_key: string }>(
          ctx.tx,
          sql`select id, group_key from app.knowledge_suggestions
              where workspace_id = ${ws} and status = 'pending' and reason = 'gap' and group_key is not null
              order by created_at desc limit 1000`,
        )
      : [];
    const ids: string[] = [];
    let created = 0;
    let grouped = 0;
    for (const s of input.suggestions) {
      if (s.reason === 'gap') {
        const key = s.groupKey ?? (gapKey(s.question) || questionKey(s.question).slice(0, 200));
        const similar =
          gaps.find((g) => g.group_key === key) ?? gaps.find((g) => similarGaps(g.group_key, key));
        if (similar) {
          const [bumped] = await ctx.tx
            .update(knowledgeSuggestions)
            .set({ similarCount: dsql`${knowledgeSuggestions.similarCount} + 1` })
            .where(
              and(
                eq(knowledgeSuggestions.id, similar.id),
                eq(knowledgeSuggestions.status, 'pending'),
              ),
            )
            .returning({ id: knowledgeSuggestions.id });
          if (bumped) {
            ids.push(bumped.id);
            grouped += 1;
            continue;
          }
        }
        const [row] = await ctx.tx
          .insert(knowledgeSuggestions)
          .values({
            workspaceId: ws,
            kind: 'faq',
            proposed: { title: s.question, body: '', tags: [] },
            reason: 'gap',
            source: { ...s.source, question: s.question },
            groupKey: key,
          })
          .onConflictDoUpdate({
            target: [knowledgeSuggestions.workspaceId, knowledgeSuggestions.groupKey],
            targetWhere: dsql`status = 'pending' and group_key is not null`,
            set: { similarCount: dsql`${knowledgeSuggestions.similarCount} + 1` },
          })
          .returning({
            id: knowledgeSuggestions.id,
            similarCount: knowledgeSuggestions.similarCount,
          });
        ids.push(row!.id);
        if (row!.similarCount > 1) grouped += 1;
        else {
          created += 1;
          gaps.push({ id: row!.id, group_key: key });
        }
        continue;
      }
      const cols = columnsOf(s.content);
      const [row] = await ctx.tx
        .insert(knowledgeSuggestions)
        .values({
          workspaceId: ws,
          kind: cols.kind,
          proposed: { title: cols.title, body: cols.body, tags: cols.tags },
          reason: s.reason,
          scanId: s.reason === 'scan' ? input.scanId : null,
          source:
            s.reason === 'scan' ? { url: s.sourceUrl } : { packId: s.packId, version: s.version },
          itemId: s.reason === 'scan' ? s.itemId : null,
        })
        .returning({ id: knowledgeSuggestions.id });
      ids.push(row!.id);
      created += 1;
    }
    await ctx.emit({
      type: 'knowledge_suggestion.proposed',
      entityType: 'knowledge_suggestion',
      entityId: ids.length === 1 ? ids[0]! : null,
      payload: {
        suggestionIds: ids,
        created,
        grouped,
        reasons: [...new Set(input.suggestions.map((s) => s.reason))],
        scanId: input.scanId,
      },
      after: { suggestions: created, grouped },
    });
    return { suggestionIds: ids, created, grouped };
  },
});

export const knowledgeItemRecordUse = defineCommand({
  name: 'knowledge_item.record_use',
  description:
    'System: count that an AI step or the Assistant used these items, and when (for “last used”).',
  risk: 0,
  input: KnowledgeRecordUseInput,
  output: KnowledgeRecordUseOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system', 'workflow'],
  emits: ['knowledge_item.used'],
  async handler(ctx, input) {
    const used = await ctx.tx
      .update(knowledgeItems)
      .set({ useCount: dsql`${knowledgeItems.useCount} + 1`, lastUsedAt: dsql`now()` })
      .where(
        and(
          eq(knowledgeItems.workspaceId, ctx.scope.workspaceId!),
          inArray(knowledgeItems.id, [...new Set(input.itemIds)]),
        ),
      )
      .returning({ id: knowledgeItems.id, title: knowledgeItems.title });
    if (!used.length) return { updated: 0 };
    await ctx.emit({
      type: 'knowledge_item.used',
      entityType: 'knowledge_item',
      entityId: used[0]!.id,
      payload: { itemIds: used.map((u) => u.id) },
      after: {
        items: used.length,
        titles: used
          .slice(0, 5)
          .map((u) => u.title)
          .join('; '),
      },
      // One per AI step: kept out of the live-updates broadcast.
      broadcast: false,
    });
    return { updated: used.length };
  },
});
