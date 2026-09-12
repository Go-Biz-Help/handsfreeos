'use client';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES } from '@hfos/core';
import { Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { RecordType } from '@/lib/api/types';
import { supabaseBrowser } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

const ACCEPT = ATTACHMENT_TYPES.join(',');
const EXT_TYPES: Record<string, string> = {
  heic: 'image/heic',
  heif: 'image/heif',
  csv: 'text/csv',
  txt: 'text/plain',
};

/**
 * Uploads straight to Storage at the path the server reserves, then confirms the file with the API.
 * Returns the file's id (texts attach customer files by id).
 */
export async function uploadFile(
  workspaceId: string,
  recordType: RecordType,
  recordId: string,
  file: File,
): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = file.type || EXT_TYPES[ext] || '';
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(mimeType))
    throw new Error(`${file.name}: that file type is not supported.`);
  if (file.size > ATTACHMENT_MAX_BYTES) throw new Error(`${file.name}: files can be up to 25 MB.`);
  const begun = unwrap(
    await apiBrowser().POST('/v1/commands/file.begin_upload', {
      body: {
        workspaceId,
        recordType,
        recordId,
        name: file.name,
        mimeType: mimeType as (typeof ATTACHMENT_TYPES)[number],
        sizeBytes: file.size,
      },
    }),
  );
  const { error } = await supabaseBrowser()
    .storage.from(begun.bucket)
    .upload(begun.objectPath, file, { contentType: mimeType, upsert: false });
  if (error) throw new Error(`${file.name}: upload failed (${error.message}).`);
  unwrap(
    await apiBrowser().POST('/v1/commands/file.confirm', {
      body: { workspaceId, fileId: begun.fileId },
    }),
  );
  return begun.fileId;
}

export function UploadZone({
  workspaceId,
  recordType,
  recordId,
  compact,
  className,
}: {
  workspaceId: string;
  recordType: RecordType;
  recordId: string;
  compact?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function handle(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    let ok = 0;
    for (const file of list) {
      setBusy(file.name);
      try {
        await uploadFile(workspaceId, recordType, recordId, file);
        ok++;
      } catch (e) {
        toast.error(errorMessage(e));
      }
    }
    setBusy(null);
    if (ok) {
      toast.success(ok === 1 ? `${list[0]!.name} uploaded.` : `${ok} files uploaded.`);
      router.refresh();
    }
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    void handle(e.dataTransfer.files);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'flex flex-col items-center justify-center rounded-card border-[1.5px] border-dashed bg-card text-center text-text-2 transition-colors',
        over ? 'border-accent bg-accent-soft' : 'border-border-strong',
        compact ? 'p-4' : 'p-6',
        className,
      )}
      data-testid="upload-zone"
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        aria-label="Choose files"
        data-testid="file-input"
        onChange={(e) => {
          if (e.target.files) void handle(e.target.files);
          e.target.value = '';
        }}
      />
      <Upload className="h-5 w-5" strokeWidth={1.5} />
      <div className="mt-1.5 text-[13px] font-semibold text-text">
        {compact ? 'Add photo or file' : 'Drop photos or files here'}
      </div>
      {compact ? null : (
        <div className="mt-0.5 text-xs text-text-3">
          JPEG, PNG, HEIC, PDF, Word, Excel or CSV up to 25 MB
        </div>
      )}
      <Button
        variant="secondary"
        size="sm"
        className="mt-2.5"
        loading={!!busy}
        onClick={() => input.current?.click()}
      >
        {busy ? `Uploading ${busy}…` : 'Choose file'}
      </Button>
    </div>
  );
}
