/**
 * Reading templates and documents for the commands, the queries and the worker. Server-only.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import {
  documents,
  documentSigners,
  documentTemplates,
  documentValues,
  files,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import { DocumentValue, parseDocumentDefinition, type DocumentDefinition } from './definition';

export type DocumentTemplateRow = typeof documentTemplates.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentSignerRow = typeof documentSigners.$inferSelect;

export const templateGone = () =>
  HfosError.notFound(
    'That template isn’t there anymore. It may have been deleted. Refresh and pick another.',
  );
export const documentGone = () =>
  HfosError.notFound(
    'That document isn’t there anymore, or it’s about a customer you can’t see. Refresh and try again.',
  );

export async function loadTemplate(
  tx: Tx,
  workspaceId: string,
  templateId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<{ row: DocumentTemplateRow; definition: DocumentDefinition }> {
  const q = tx
    .select()
    .from(documentTemplates)
    .where(
      and(eq(documentTemplates.id, templateId), eq(documentTemplates.workspaceId, workspaceId)),
    );
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  if (!row) throw templateGone();
  return { row, definition: parseDocumentDefinition(row.definition) };
}

export async function loadDocument(
  tx: Tx,
  workspaceId: string,
  documentId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<{ row: DocumentRow; definition: DocumentDefinition }> {
  const q = tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)));
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  if (!row) throw documentGone();
  return { row, definition: parseDocumentDefinition(row.definition) };
}

/** A document's signers and copies, in signing order. */
export async function signersOf(tx: Tx, documentId: string): Promise<DocumentSignerRow[]> {
  return tx
    .select()
    .from(documentSigners)
    .where(eq(documentSigners.documentId, documentId))
    .orderBy(
      asc(documentSigners.position),
      asc(documentSigners.createdAt),
      asc(documentSigners.id),
    );
}

/** Everything filled in on a document so far, by field: the team's before it went, and each signer's. */
export async function valuesOf(
  tx: Tx,
  documentId: string,
): Promise<{ values: Record<string, DocumentValue>; by: Record<string, string | null> }> {
  const list = await tx
    .select({
      fieldId: documentValues.fieldId,
      value: documentValues.value,
      signerId: documentValues.signerId,
    })
    .from(documentValues)
    .where(eq(documentValues.documentId, documentId));
  const values: Record<string, DocumentValue> = {};
  const by: Record<string, string | null> = {};
  for (const v of list) {
    const parsed = DocumentValue.safeParse(v.value);
    if (!parsed.success) continue;
    values[v.fieldId] = parsed.data;
    by[v.fieldId] = v.signerId;
  }
  return { values, by };
}

/** A stored file's place, for a signed link. Null when it's gone. */
export async function fileOf(
  tx: Tx,
  workspaceId: string,
  fileId: string | null,
): Promise<{
  id: string;
  name: string;
  bucket: string;
  objectPath: string;
  status: string;
} | null> {
  if (!fileId) return null;
  const [f] = await tx
    .select({
      id: files.id,
      name: files.name,
      bucket: files.bucket,
      objectPath: files.objectPath,
      status: files.status,
      deletedAt: files.deletedAt,
    })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.workspaceId, workspaceId)));
  if (!f || f.deletedAt) return null;
  return { id: f.id, name: f.name, bucket: f.bucket, objectPath: f.objectPath, status: f.status };
}

/** Whose turn it is: the signers at the lowest position still to sign; everyone still to sign, all at once. */
export function signersUp(signers: readonly DocumentSignerRow[]): DocumentSignerRow[] {
  const left = signers.filter((s) => s.kind === 'signer' && s.status !== 'signed');
  if (!left.length) return [];
  const first = Math.min(...left.map((s) => s.position));
  return left.filter((s) => s.position === first);
}
