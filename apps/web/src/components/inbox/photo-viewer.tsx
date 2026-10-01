'use client';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { THREAD_WORDS } from '@hfos/core';
import { Download, X } from 'lucide-react';
import { toast } from 'sonner';
import { supabaseBrowser } from '@/lib/supabase/client';

/**
 * A photo from a message, full size over the thread, as the phone's Messages app shows one: dark all round, the
 * photo fitted to the window, its name and a download at the top. Escape, the close button or a click off the
 * photo goes back to the thread, so nothing opens a new tab.
 */
export function PhotoViewer({
  url,
  bucket,
  objectPath,
  name,
  onClose,
}: {
  url: string;
  bucket: string;
  objectPath: string;
  name: string;
  onClose: () => void;
}) {
  async function download() {
    // A link of its own that tells the browser to save the file, so the download leaves the thread where it is.
    const { data } = await supabaseBrowser()
      .storage.from(bucket)
      .createSignedUrl(objectPath, 60, { download: name });
    if (data?.signedUrl) window.location.assign(data.signedUrl);
    else toast.error(THREAD_WORDS.photoWontDownload);
  }
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/95 data-[state=open]:animate-in data-[state=open]:fade-in" />
      <DialogPrimitive.Content
        data-testid="photo-viewer"
        className="fixed inset-0 z-50 flex flex-col focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in"
      >
        <div className="flex flex-none items-center gap-2 px-4 py-3 text-white">
          <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-medium">
            {name}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{name}</DialogPrimitive.Description>
          <button
            type="button"
            onClick={() => void download()}
            aria-label={`${THREAD_WORDS.downloadPhoto} ${name}`}
            title={THREAD_WORDS.downloadPhoto}
            className="flex h-9 w-9 items-center justify-center rounded-control text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          >
            <Download className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </button>
          <DialogPrimitive.Close
            aria-label={THREAD_WORDS.closePhoto}
            title={THREAD_WORDS.closePhoto}
            className="flex h-9 w-9 items-center justify-center rounded-control text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          >
            <X className="h-5 w-5" strokeWidth={1.5} />
          </DialogPrimitive.Close>
        </div>
        {/* The space round the photo is the backdrop: a click there closes, as a click outside any dialog does. */}
        <div
          role="presentation"
          onClick={(e) => e.target === e.currentTarget && onClose()}
          className="flex min-h-0 flex-1 items-center justify-center px-4 pb-6 max-md:px-0"
        >
          {/* A signed Storage link: plain <img>, nothing for an image optimizer to cache. */}
          <img src={url} alt={name} className="max-h-full max-w-full select-none object-contain" />
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
