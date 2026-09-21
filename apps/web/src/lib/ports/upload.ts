'use client';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { supabaseBrowser } from '@/lib/supabase/client';

/** What the picker offers. Carriers want the signed authorisation as a PDF, and take a scan or photo of a bill. */
export const PORT_DOCUMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';

const ALLOWED = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const MAX_BYTES = 10 * 1024 * 1024;

const BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

/** A browser that will not name a file's type is common enough that the extension has to be the fallback. */
function typeOf(file: Pick<File, 'name' | 'type'>): string | null {
  if (ALLOWED.has(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXTENSION[ext] ?? null;
}

/**
 * One of a port's papers, all the way up (M17).
 *
 * The same three steps every other upload here takes — reserve, upload straight to Storage, confirm — and
 * then a fourth that says which paper it is. Deliberately not one call with the bytes in it: the file never
 * passes through our API at all, which is why a 10 MB scan of a phone bill is not a problem.
 */
export async function uploadPortDocument(
  workspaceId: string,
  portId: string,
  document: 'loa' | 'bill',
  file: File,
): Promise<string> {
  const mimeType = typeOf(file);
  if (!mimeType) throw new Error(`${file.name}: upload a PDF, or a photo of it.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  if (file.size > MAX_BYTES) throw new Error(`${file.name}: files can be up to 10 MB.`);
  const api = apiBrowser();
  const begun = unwrap(
    await api.POST('/v1/commands/number_port.begin_upload', {
      body: { workspaceId, portId, document, name: file.name, mimeType, sizeBytes: file.size },
    }),
  );
  const body = file.type === mimeType ? file : new File([file], file.name, { type: mimeType });
  const { error } = await supabaseBrowser()
    .storage.from(begun.bucket)
    .upload(begun.objectPath, body, { contentType: mimeType, upsert: false });
  if (error) throw new Error(`${file.name}: the upload failed (${error.message}).`);
  unwrap(
    await api.POST('/v1/commands/file.confirm', { body: { workspaceId, fileId: begun.fileId } }),
  );
  unwrap(
    await api.POST('/v1/commands/number_port.attach_document', {
      body: { workspaceId, portId, document, fileId: begun.fileId },
    }),
  );
  return begun.fileId;
}
