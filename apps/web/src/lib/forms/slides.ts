'use client';
/**
 * A live poll's slides from the person's computer (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 4): read first,
 * so a PDF that won't open or has too many pages is turned away before it's uploaded, then uploaded to the place
 * `form.begin_slides_upload` keeps for it and confirmed. The editor puts it on the poll's draft with
 * `set_form {slides}`, like any edit.
 */
import { MAX_SLIDES, SLIDE_WORDS, SLIDES_MAX_BYTES, type PollSlides } from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { openPdf } from '@/lib/documents/pdf';
import { supabaseBrowser } from '@/lib/supabase/client';

export async function uploadSlides(
  workspaceId: string,
  formId: string,
  file: File,
): Promise<PollSlides> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) throw new Error(`${file.name} isn’t a PDF. ${SLIDE_WORDS.notPdf}`);
  if (file.size > SLIDES_MAX_BYTES)
    throw new Error(
      `${file.name} is over 25 MB. Save the PDF smaller (fewer or smaller pictures), then add it.`,
    );
  let pages: number;
  try {
    const doc = await openPdf(await file.arrayBuffer());
    pages = doc.numPages;
    void doc.loadingTask.destroy();
  } catch {
    throw new Error(`${file.name}: ${SLIDE_WORDS.unreadable}`);
  }
  if (!pages) throw new Error(`${file.name} has no pages.`);
  if (pages > MAX_SLIDES) throw new Error(SLIDE_WORDS.tooMany(pages));
  const api = apiBrowser();
  const begun = unwrap(
    await api.POST('/v1/commands/form.begin_slides_upload', {
      body: {
        workspaceId,
        formId,
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
  return { fileId: begun.fileId, name: file.name.slice(0, 200), pages };
}
