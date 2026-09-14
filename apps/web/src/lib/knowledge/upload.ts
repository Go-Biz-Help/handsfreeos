'use client';
import { KNOWLEDGE_DOCUMENT_MAX_BYTES, type KNOWLEDGE_DOCUMENT_TYPES } from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { supabaseBrowser } from '@/lib/supabase/client';

type DocumentType = (typeof KNOWLEDGE_DOCUMENT_TYPES)[number];

/** What the file picker offers: PDFs and text files, Markdown included. */
export const DOCUMENT_ACCEPT =
  '.pdf,.txt,.md,.markdown,.csv,application/pdf,text/plain,text/markdown,text/csv';

const BY_EXTENSION: Readonly<Record<string, DocumentType>> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/plain',
  markdown: 'text/plain',
  csv: 'text/csv',
};

/**
 * The type a file goes up as: a PDF, a CSV, or any other text (Markdown included) as text/plain, since the
 * storage bucket takes no text/markdown. Null when it's none of those.
 */
export function documentType(file: Pick<File, 'name' | 'type'>): DocumentType | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const known = BY_EXTENSION[ext];
  if (known) return known;
  if (file.type === 'application/pdf') return 'application/pdf';
  if (file.type === 'text/csv') return 'text/csv';
  if (file.type.startsWith('text/')) return 'text/plain';
  return null;
}

/**
 * Adds a PDF or text file to the knowledge base: reserves it (knowledge_document.begin_upload), uploads it
 * straight to Storage, confirms it, and asks for its text (knowledge_document.add). The worker then reads the
 * text into a draft document item. Returns the file's id.
 */
export async function uploadKnowledgeDocument(workspaceId: string, file: File): Promise<string> {
  const mimeType = documentType(file);
  if (!mimeType) throw new Error(`${file.name}: upload a PDF or a text file.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  if (file.size > KNOWLEDGE_DOCUMENT_MAX_BYTES)
    throw new Error(`${file.name}: files can be up to 5 MB.`);
  const api = apiBrowser();
  const begun = unwrap(
    await api.POST('/v1/commands/knowledge_document.begin_upload', {
      body: { workspaceId, name: file.name, mimeType, sizeBytes: file.size },
    }),
  );
  // Storage reads a file's own type (a .md file says text/markdown, which the bucket refuses), not the
  // contentType option, so the file goes up relabelled with the type chosen above.
  const body = file.type === mimeType ? file : new File([file], file.name, { type: mimeType });
  const { error } = await supabaseBrowser()
    .storage.from(begun.bucket)
    .upload(begun.objectPath, body, { contentType: mimeType, upsert: false });
  if (error) throw new Error(`${file.name}: the upload failed (${error.message}).`);
  unwrap(
    await api.POST('/v1/commands/file.confirm', { body: { workspaceId, fileId: begun.fileId } }),
  );
  unwrap(
    await api.POST('/v1/commands/knowledge_document.add', {
      body: { workspaceId, fileId: begun.fileId },
    }),
  );
  return begun.fileId;
}
