'use client';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { supabaseBrowser } from '@/lib/supabase/client';
import { openPdf, pageSizes } from './pdf';

/** A short-lived link to a document's file, read as the person signed in (Storage's own rules decide). */
export async function documentFileUrl(
  file: { bucket: string; objectPath: string; name?: string },
  opts: { seconds?: number; download?: boolean } = {},
): Promise<string> {
  const { data, error } = await supabaseBrowser()
    .storage.from(file.bucket)
    .createSignedUrl(
      file.objectPath,
      opts.seconds ?? 3600,
      opts.download ? { download: file.name ?? true } : undefined,
    );
  if (error || !data) throw new Error('The PDF didn’t open. Refresh the page to try again.');
  return data.signedUrl;
}

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * A template's PDF, from the person's computer: read first (a PDF that won't open, or is too long, is turned away
 * before it's uploaded), then uploaded to the place `document_template.begin_upload` keeps for it, confirmed, and
 * its pages read in with `document_template.set_source`.
 */
export async function uploadTemplatePdf(
  workspaceId: string,
  templateId: string,
  file: File,
  baseRevision: number,
): Promise<{ revision: number; removedFields: number; removedEdits: number }> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) throw new Error(`${file.name} isn’t a PDF. Save it as a PDF first, then add it.`);
  if (file.size > MAX_BYTES)
    throw new Error(`${file.name} is over 25 MB. Make it smaller, then add it.`);
  let pages: { width: number; height: number }[];
  try {
    const doc = await openPdf(await file.arrayBuffer());
    pages = await pageSizes(doc);
    void doc.loadingTask.destroy();
  } catch {
    throw new Error(
      `${file.name} didn’t open as a PDF. If it has a password, save a copy without one and add that.`,
    );
  }
  if (!pages.length) throw new Error(`${file.name} has no pages.`);
  if (pages.length > 100)
    throw new Error(`${file.name} has ${pages.length} pages. A template can have up to 100.`);
  const api = apiBrowser();
  const begun = unwrap(
    await api.POST('/v1/commands/document_template.begin_upload', {
      body: {
        workspaceId,
        templateId,
        name: file.name,
        mimeType: 'application/pdf',
        sizeBytes: file.size,
      },
    }),
  );
  const { error } = await supabaseBrowser()
    .storage.from(begun.bucket)
    .upload(begun.objectPath, file, { contentType: 'application/pdf', upsert: false });
  if (error) throw new Error(`${file.name} didn’t upload. Check your connection and try again.`);
  unwrap(
    await api.POST('/v1/commands/file.confirm', { body: { workspaceId, fileId: begun.fileId } }),
  );
  return unwrap(
    await api.POST('/v1/commands/document_template.set_source', {
      body: { workspaceId, templateId, fileId: begun.fileId, pages, baseRevision },
    }),
  );
}
