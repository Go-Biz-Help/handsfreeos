'use client';
import { Download, FileText, Image as ImageIcon, Lock, MoreHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { FileItem } from '@/lib/api/types';
import { BROWSER_IMAGES, fileKindLabel, fileLine, FILE_WORDS, removeFileConfirm } from '@hfos/core';
import { supabaseBrowser } from '@/lib/supabase/client';

/** Short-lived signed URL from the user's own Storage session (RLS decides what they may read). */
async function signedUrl(file: FileItem, download = false): Promise<string> {
  const { data, error } = await supabaseBrowser()
    .storage.from(file.bucket)
    .createSignedUrl(file.objectPath, 300, download ? { download: file.name } : undefined);
  if (error || !data) throw new Error(error?.message ?? 'Could not open the file.');
  return data.signedUrl;
}

function Thumb({ file }: { file: FileItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const renderable = !!file.mimeType && BROWSER_IMAGES.has(file.mimeType);
  useEffect(() => {
    if (!renderable) return;
    let cancelled = false;
    signedUrl(file)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [file, renderable]);
  if (renderable && url)
    return <img src={url} alt={file.name} className="h-[104px] w-full object-cover" />;
  return (
    <div className="flex h-[104px] items-center justify-center gap-1.5 bg-gradient-to-br from-card-3 to-card-2 text-text-3">
      {file.isImage ? (
        <ImageIcon className="h-5 w-5" strokeWidth={1.5} />
      ) : (
        <FileText className="h-5 w-5" strokeWidth={1.5} />
      )}
      <span className="text-xs font-semibold">{fileKindLabel(file.mimeType, file.isImage)}</span>
    </div>
  );
}

export function FileGrid({
  workspaceId,
  files,
  canDelete,
}: {
  workspaceId: string;
  files: FileItem[];
  canDelete: boolean;
}) {
  const router = useRouter();
  async function open(file: FileItem, download: boolean) {
    try {
      const url = await signedUrl(file, download);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  async function remove(file: FileItem) {
    if (!confirm(removeFileConfirm(file.name))) return;
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/file.delete', {
          body: { workspaceId, fileId: file.id },
        }),
      );
      toast.success(FILE_WORDS.removed);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  if (files.length === 0)
    return <EmptyState title={FILE_WORDS.emptyTitle}>{FILE_WORDS.emptyBody}</EmptyState>;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="file-grid">
      {files.map((f) => (
        <div
          key={f.id}
          className="overflow-hidden rounded-menu border border-border bg-card"
          data-testid={`file-tile-${f.id}`}
        >
          <button
            type="button"
            className="block w-full text-left"
            onClick={() => void open(f, false)}
            aria-label={`Open ${f.name}`}
          >
            <Thumb file={f} />
          </button>
          <div className="flex items-start gap-1 p-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold" title={f.name}>
                {f.name}
              </div>
              <div className="truncate text-xs text-text-3">{fileLine(f)}</div>
              {f.locked ? (
                <div
                  className="mt-1 flex items-center gap-1 text-xs font-medium text-success-text"
                  title={FILE_WORDS.lockedDetail}
                  data-testid={`file-locked-${f.id}`}
                >
                  <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden />
                  {FILE_WORDS.locked}
                </div>
              ) : null}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="File actions"
                  className="-mr-1 rounded-control p-1 text-text-3 hover:bg-card-2 hover:text-text"
                >
                  <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => void open(f, true)}>
                  <Download className="h-4 w-4" strokeWidth={1.5} />
                  {FILE_WORDS.download}
                </DropdownMenuItem>
                {canDelete && !f.locked ? (
                  <DropdownMenuItem danger onSelect={() => void remove(f)}>
                    <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                    {FILE_WORDS.remove}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      ))}
    </div>
  );
}
