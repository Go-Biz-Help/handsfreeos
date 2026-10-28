/**
 * Document templates (docs/documents.md): start one, add the PDF it's made from, save what the editor placed on it
 * (the whole definition against a base revision), rename, duplicate, archive and restore. documents.manage, which
 * owners and admins have.
 *
 * A template is the business's own working copy: nothing it changes reaches a document already sent, which keeps
 * the copy it went out with.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { documents, documentTemplates, files } from '@hfos/db/schema';
import { HfosError } from '../errors';
import {
  blankDocumentDefinition,
  DocumentDefinition,
  type DocumentDefinition as DocumentDefinitionT,
} from '../documents/definition';
import { documentTemplateIssues } from '../documents/check';
import { loadTemplate } from '../documents/load';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  DocumentTemplateBeginUploadInput,
  DocumentTemplateBeginUploadOutput,
  DocumentTemplateCreateInput,
  DocumentTemplateCreateOutput,
  DocumentTemplateDuplicateInput,
  DocumentTemplateOkOutput,
  DocumentTemplateRefInput,
  DocumentTemplateRenameInput,
  DocumentTemplateSaveInput,
  DocumentTemplateSaveOutput,
  DocumentTemplateSetSourceInput,
  DocumentTemplateSetSourceOutput,
} from '../schemas/document';
import { jsonEqual } from '../workflows/json';
import { storedFilePath } from './file';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const asJson = (d: DocumentDefinitionT) => d as unknown as Record<string, unknown>;

export function templateRevisionConflict(revision: number): HfosError {
  return new HfosError(
    'conflict',
    409,
    'Someone saved this template in the meantime. Reload to see their changes.',
    { revision },
    'revision_conflict',
  );
}

const archivedTemplate = (name: string) =>
  HfosError.conflict(
    `“${name}” is archived, so it can’t change. Restore it first, or make a new template.`,
    'document_template_archived',
  );

/** A name not yet taken among the business's templates: "Lease", then "Lease (copy)", "Lease (copy 2)". */
async function freeName(
  tx: Parameters<typeof loadTemplate>[0],
  workspaceId: string,
  wanted: string,
): Promise<string> {
  const taken = new Set(
    (
      await tx
        .select({ name: documentTemplates.name })
        .from(documentTemplates)
        .where(eq(documentTemplates.workspaceId, workspaceId))
    ).map((r) => r.name.toLowerCase()),
  );
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 1; n < 100; n++) {
    const next = `${wanted.slice(0, 100)} (copy${n === 1 ? '' : ` ${n}`})`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  return `${wanted.slice(0, 100)} (${randomUUID().slice(0, 6)})`;
}

/** How many documents made from a template are still out for signing. */
async function documentsOut(
  tx: Parameters<typeof loadTemplate>[0],
  templateId: string,
): Promise<number> {
  const [r] = await tx
    .select({ n: dsql<number>`count(*)::int` })
    .from(documents)
    .where(and(eq(documents.templateId, templateId), eq(documents.status, 'out')));
  return r?.n ?? 0;
}

export const documentTemplateCreate = defineCommand({
  name: 'document_template.create',
  description:
    'Start a document template: a name, one customer to sign, and nothing placed yet. Add its PDF next (document_template.begin_upload), then place the fields.',
  risk: 1,
  input: DocumentTemplateCreateInput,
  output: DocumentTemplateCreateOutput,
  permission: 'documents.manage',
  scope: inWorkspace,
  emits: ['document_template.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    const definition = blankDocumentDefinition();
    const [row] = await ctx.tx
      .insert(documentTemplates)
      .values({
        workspaceId: ws,
        name: input.name,
        definition: asJson(definition),
        definitionVersion: definition.version,
        revision: 1,
        createdBy: me,
      })
      .returning({ id: documentTemplates.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'document_template.created',
      entityType: 'document_template',
      entityId: row.id,
      payload: { name: input.name },
      after: { name: input.name },
    });
    return { templateId: row.id, revision: 1 };
  },
});

export const documentTemplateBeginUpload = defineCommand({
  name: 'document_template.begin_upload',
  description:
    'Reserve a place for the PDF a document template is made from (25 MB at most). Upload it to the returned path, confirm it with file.confirm, then document_template.set_source with its pages.',
  risk: 1,
  input: DocumentTemplateBeginUploadInput,
  output: DocumentTemplateBeginUploadOutput,
  permission: 'documents.manage',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    const { row } = await loadTemplate(ctx.tx, ws, input.templateId);
    if (row.archivedAt) throw archivedTemplate(row.name);
    const fileId = randomUUID();
    // The file belongs to the template, not to a customer: its record is the template.
    const objectPath = storedFilePath(ws, 'document', row.id, fileId, input.name);
    const [f] = await ctx.tx
      .insert(files)
      .values({
        id: fileId,
        workspaceId: ws,
        recordType: 'document',
        recordId: row.id,
        bucket: 'attachments',
        objectPath,
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        createdBy: me,
      })
      .returning({ id: files.id });
    if (!f) throw HfosError.forbidden();
    return { fileId, bucket: 'attachments', objectPath };
  },
});

export const documentTemplateSetSource = defineCommand({
  name: 'document_template.set_source',
  description:
    'Make an uploaded PDF the one a document template is made from, with each page’s size. Fields on pages the new PDF doesn’t have come off, and so do word changes made on another PDF.',
  risk: 1,
  input: DocumentTemplateSetSourceInput,
  output: DocumentTemplateSetSourceOutput,
  permission: 'documents.manage',
  scope: inWorkspace,
  emits: ['document_template.saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await loadTemplate(ctx.tx, ws, input.templateId, { forUpdate: true });
    if (current.row.archivedAt) throw archivedTemplate(current.row.name);
    if (current.row.revision !== input.baseRevision)
      throw templateRevisionConflict(current.row.revision);
    const [f] = await ctx.tx
      .select({
        id: files.id,
        name: files.name,
        recordType: files.recordType,
        recordId: files.recordId,
        status: files.status,
        mimeType: files.mimeType,
        deletedAt: files.deletedAt,
      })
      .from(files)
      .where(and(eq(files.id, input.fileId), eq(files.workspaceId, ws)));
    if (!f || f.deletedAt || f.recordType !== 'document' || f.recordId !== current.row.id)
      throw HfosError.notFound('That PDF isn’t there anymore. Upload it again.');
    if (f.status !== 'ready')
      throw HfosError.rule(
        'file_not_uploaded',
        409,
        `${f.name} hasn’t finished uploading. Wait for it to finish, or upload it again.`,
      );
    const pages = input.pages;
    const samePdf = current.row.sourceFileId === f.id;
    const fields = current.definition.fields.filter((x) => x.page < pages.length);
    // Word changes cover words of one PDF: another PDF's words are somewhere else.
    const edits = samePdf ? current.definition.edits.filter((x) => x.page < pages.length) : [];
    const next = DocumentDefinition.parse({
      ...current.definition,
      pages,
      fields,
      edits,
      presets: {},
    });
    const revision = current.row.revision + 1;
    await ctx.tx
      .update(documentTemplates)
      .set({
        sourceFileId: f.id,
        definition: asJson(next),
        definitionVersion: next.version,
        revision,
      })
      .where(eq(documentTemplates.id, current.row.id));
    const removedFields = current.definition.fields.length - fields.length;
    const removedEdits = current.definition.edits.length - edits.length;
    await ctx.emit({
      type: 'document_template.saved',
      entityType: 'document_template',
      entityId: current.row.id,
      payload: { revision, pdf: f.name, pages: pages.length, removedFields, removedEdits },
      before: { revision: current.row.revision },
      after: { revision, pdf: f.name, pages: pages.length },
    });
    return { templateId: current.row.id, revision, removedFields, removedEdits };
  },
});

export const documentTemplateSave = defineCommand({
  name: 'document_template.save',
  description:
    'Save a document template’s whole definition: who signs and in what order, the fields placed on its pages for each of them, the words typed over, and its settings (order, a code first, reminders, expiry, the note). Its pages come from its PDF and stay as they are. Pass the revision it was read at.',
  risk: 1,
  input: DocumentTemplateSaveInput,
  output: DocumentTemplateSaveOutput,
  permission: 'documents.manage',
  scope: inWorkspace,
  emits: ['document_template.saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await loadTemplate(ctx.tx, ws, input.templateId, { forUpdate: true });
    if (current.row.archivedAt) throw archivedTemplate(current.row.name);
    if (current.row.revision !== input.baseRevision)
      throw templateRevisionConflict(current.row.revision);
    const parsed = DocumentDefinition.safeParse({
      ...input.definition,
      pages: current.definition.pages,
      presets: {},
    });
    if (!parsed.success)
      throw HfosError.validation(
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        parsed.error.issues[0]?.message ?? 'Some of the template needs attention.',
      );
    const next = parsed.data;
    const issues = documentTemplateIssues(next, !!current.row.sourceFileId);
    if (jsonEqual(next, current.definition))
      return { templateId: current.row.id, revision: current.row.revision, changed: false, issues };
    const revision = current.row.revision + 1;
    await ctx.tx
      .update(documentTemplates)
      .set({ definition: asJson(next), definitionVersion: next.version, revision })
      .where(eq(documentTemplates.id, current.row.id));
    await ctx.emit({
      type: 'document_template.saved',
      entityType: 'document_template',
      entityId: current.row.id,
      payload: {
        revision,
        roles: next.roles.map((r) => r.label),
        fields: next.fields.length,
        edits: next.edits.length,
      },
      before: {
        revision: current.row.revision,
        fields: current.definition.fields.length,
        edits: current.definition.edits.length,
      },
      after: { revision, fields: next.fields.length, edits: next.edits.length },
    });
    return { templateId: current.row.id, revision, changed: true, issues };
  },
});

export const documentTemplateRename = defineCommand({
  name: 'document_template.rename',
  description: 'Rename a document template. Documents already sent keep their own names.',
  risk: 1,
  input: DocumentTemplateRenameInput,
  output: DocumentTemplateOkOutput,
  permission: 'documents.manage',
  scope: inWorkspace,
  emits: ['document_template.renamed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const { row } = await loadTemplate(ctx.tx, ws, input.templateId, { forUpdate: true });
    if (row.name === input.name) return { templateId: row.id, changed: false };
    await ctx.tx
      .update(documentTemplates)
      .set({ name: input.name })
      .where(eq(documentTemplates.id, row.id));
    await ctx.emit({
      type: 'document_template.renamed',
      entityType: 'document_template',
      entityId: row.id,
      payload: { from: row.name, to: input.name },
      before: { name: row.name },
      after: { name: input.name },
    });
    return { templateId: row.id, changed: true };
  },
});

export const documentTemplateArchive = defineCommand({
  name: 'document_template.archive',
  description:
    'Archive a document template: it’s no longer offered when sending. Documents already out stay out, and it can be restored.',
  risk: 1,
  input: DocumentTemplateRefInput,
  output: DocumentTemplateOkOutput,
  permission: 'documents.manage',
  scope: inWorkspace,
  emits: ['document_template.archived'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const { row } = await loadTemplate(ctx.tx, ws, input.templateId, { forUpdate: true });
    if (row.archivedAt) return { templateId: row.id, changed: false };
    await ctx.tx
      .update(documentTemplates)
      .set({ archivedAt: new Date() })
      .where(eq(documentTemplates.id, row.id));
    await ctx.emit({
      type: 'document_template.archived',
      entityType: 'document_template',
      entityId: row.id,
      payload: { name: row.name, documentsOut: await documentsOut(ctx.tx, row.id) },
      before: { archived: false },
      after: { archived: true },
    });
    return { templateId: row.id, changed: true };
  },
});

export const documentTemplateRestore = defineCommand({
  name: 'document_template.restore',
  description: 'Bring an archived document template back, ready to send again.',
  risk: 1,
  input: DocumentTemplateRefInput,
  output: DocumentTemplateOkOutput,
  permission: 'documents.manage',
  scope: inWorkspace,
  emits: ['document_template.restored'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const { row } = await loadTemplate(ctx.tx, ws, input.templateId, { forUpdate: true });
    if (!row.archivedAt) return { templateId: row.id, changed: false };
    await ctx.tx
      .update(documentTemplates)
      .set({ archivedAt: null })
      .where(eq(documentTemplates.id, row.id));
    await ctx.emit({
      type: 'document_template.restored',
      entityType: 'document_template',
      entityId: row.id,
      payload: { name: row.name },
      before: { archived: true },
      after: { archived: false },
    });
    return { templateId: row.id, changed: true };
  },
});

export const documentTemplateDuplicate = defineCommand({
  name: 'document_template.duplicate',
  description:
    'Copy a document template, its PDF, fields, word changes and settings included, under a new name.',
  risk: 1,
  input: DocumentTemplateDuplicateInput,
  output: DocumentTemplateCreateOutput,
  permission: 'documents.manage',
  scope: inWorkspace,
  emits: ['document_template.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    const source = await loadTemplate(ctx.tx, ws, input.templateId);
    const name = await freeName(ctx.tx, ws, input.name ?? source.row.name);
    const id = randomUUID();
    // It reads the same PDF: a template's PDF is only ever replaced, never changed in place.
    await ctx.tx.insert(documentTemplates).values({
      id,
      workspaceId: ws,
      name,
      definition: asJson(source.definition),
      definitionVersion: source.definition.version,
      revision: 1,
      sourceFileId: source.row.sourceFileId,
      createdBy: me,
    });
    await ctx.emit({
      type: 'document_template.created',
      entityType: 'document_template',
      entityId: id,
      payload: { name, from: source.row.id },
      after: { name },
    });
    return { templateId: id, revision: 1 };
  },
});

export const documentTemplateCommands = [
  documentTemplateCreate,
  documentTemplateBeginUpload,
  documentTemplateSetSource,
  documentTemplateSave,
  documentTemplateRename,
  documentTemplateArchive,
  documentTemplateRestore,
  documentTemplateDuplicate,
] as const;
