'use client';
import { FileText, X } from 'lucide-react';
import { toast } from 'sonner';
import { supabaseBrowser } from '@/lib/supabase/client';

/** A file on an email: opens through a short-lived link (made when clicked, so a long thread signs nothing up front). */
export function AttachmentChip({
  file,
  onRemove,
}: {
  file: { bucket?: string; objectPath?: string; name: string };
  /** The composer's tray: take it off the email. */
  onRemove?: () => void;
}) {
  async function open() {
    if (!file.bucket || !file.objectPath) return;
    const { data } = await supabaseBrowser()
      .storage.from(file.bucket)
      .createSignedUrl(file.objectPath, 300);
    if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    else toast.error('That file couldn’t be opened. Try again in a moment.');
  }
  const openable = !!(file.bucket && file.objectPath);
  return (
    <span className="inline-flex h-[34px] max-w-full items-center gap-2 whitespace-nowrap rounded-control border border-border bg-card-2 px-2.5 text-[12.5px] font-medium text-text">
      <FileText className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
      {openable ? (
        <button
          type="button"
          onClick={() => void open()}
          className="min-w-0 truncate hover:underline"
          title={`Open ${file.name}`}
        >
          {file.name}
        </button>
      ) : (
        <span className="min-w-0 truncate">{file.name}</span>
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          title="Remove"
          className="-mr-1 flex h-6 w-6 flex-none items-center justify-center rounded-control text-text-3 hover:bg-card-3 hover:text-text"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
        </button>
      ) : null}
    </span>
  );
}
