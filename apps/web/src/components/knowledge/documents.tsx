'use client';
import { CircleAlert, File, LoaderCircle, TriangleAlert, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { errorMessage } from '@/lib/api/errors';
import type { KnowledgeItem } from '@/lib/api/types';
import { formatDate } from '@/lib/format';
import { uploadKnowledgeDocument, DOCUMENT_ACCEPT } from '@/lib/knowledge/upload';
import { cn } from '@/lib/utils';
import { ItemStatusBadge } from './chips';

/** How often the page checks for a file's text while the worker reads it (live updates usually come first). */
const POLL_MS = 2500;

interface Pending {
  readonly key: string;
  readonly name: string;
  readonly fileId: string | null;
  readonly stage: 'uploading' | 'reading' | 'failed';
  readonly error?: string;
}

/**
 * Documents: upload a PDF or text file; it shows as being read, then its text becomes a draft item to check and
 * publish. A PDF with no text in it (a scan) gets a clear note.
 */
export function Documents({
  workspaceId,
  canManage,
  items,
}: {
  workspaceId: string;
  canManage: boolean;
  items: readonly KnowledgeItem[];
}) {
  const router = useRouter();
  const base = `/app/w/${workspaceId}/knowledge`;
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<readonly Pending[]>([]);
  const known = new Set(items.flatMap((i) => (i.fileId ? [i.fileId] : [])));
  // A file whose draft has arrived is no longer being read.
  const waiting = pending.filter((p) => !(p.fileId && known.has(p.fileId)));
  const reading = waiting.some((p) => p.stage === 'reading');

  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [reading, router]);

  const update = (key: string, patch: Partial<Pending>) =>
    setPending((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  async function handle(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const key = `${file.name}:${file.size}:${Date.now()}`;
      setPending((list) => [...list, { key, name: file.name, fileId: null, stage: 'uploading' }]);
      try {
        const fileId = await uploadKnowledgeDocument(workspaceId, file);
        update(key, { fileId, stage: 'reading' });
      } catch (e) {
        update(key, { stage: 'failed', error: errorMessage(e) });
        toast.error(errorMessage(e));
      }
    }
    router.refresh();
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    void handle(e.dataTransfer.files);
  }

  return (
    <div className="flex max-w-[860px] flex-col gap-3.5" data-testid="documents">
      {canManage ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center justify-center gap-1 rounded-card border-[1.5px] border-dashed bg-card px-4 py-6 text-center text-text-2 transition-colors',
            over ? 'border-accent bg-accent-soft' : 'border-border-strong',
          )}
          data-testid="document-drop"
        >
          <input
            ref={input}
            type="file"
            multiple
            accept={DOCUMENT_ACCEPT}
            className="sr-only"
            aria-label="Choose a PDF or text file"
            data-testid="document-input"
            onChange={(e) => {
              if (e.target.files) void handle(e.target.files);
              e.target.value = '';
            }}
          />
          <Upload className="h-5 w-5" strokeWidth={1.5} />
          <div className="mt-1 text-[13px] font-semibold text-text">
            Drop a PDF or text file here
          </div>
          <div className="text-xs text-text-3">
            Price lists, warranties, maintenance plans. Up to 5 MB. Its text becomes a draft to
            check.
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => input.current?.click()}
          >
            Choose a file
          </Button>
        </div>
      ) : (
        <p className="rounded-[10px] bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2">
          Only owners and admins can add documents. Open any of them to read its text.
        </p>
      )}

      {waiting.length ? (
        <Card className="overflow-hidden" data-testid="documents-pending">
          {waiting.map((p) => (
            <div
              key={p.key}
              className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              data-testid="document-pending"
            >
              <FileTile />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13.5px] font-medium">{p.name}</span>
                <span
                  className={cn(
                    'text-xs',
                    p.stage === 'failed' ? 'text-danger-text' : 'text-text-3',
                  )}
                >
                  {p.stage === 'uploading'
                    ? 'Uploading…'
                    : p.stage === 'reading'
                      ? 'Reading the text…'
                      : (p.error ?? 'It couldn’t be added.')}
                </span>
              </span>
              {p.stage === 'failed' ? (
                <CircleAlert className="h-4 w-4 text-danger-text" strokeWidth={1.75} />
              ) : (
                <LoaderCircle className="h-4 w-4 animate-spin text-text-3" strokeWidth={1.75} />
              )}
            </div>
          ))}
        </Card>
      ) : null}

      <Card className="overflow-hidden" data-testid="documents-list">
        {items.map((i) => {
          const empty = !i.body.trim();
          return (
            <Link
              key={i.id}
              href={`${base}/items/${i.id}`}
              className="flex items-center gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-card-2"
              data-testid={`document-row-${i.id}`}
            >
              <FileTile />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[14px] font-medium">{i.title}</span>
                {empty ? (
                  <span
                    className="flex items-center gap-1.5 text-xs text-warning-text"
                    data-testid="document-no-text"
                  >
                    <TriangleAlert className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                    No text found. A scanned PDF has none: type the key points in yourself.
                  </span>
                ) : (
                  <span className="text-xs text-text-3">
                    {i.body.length.toLocaleString()} characters · added {formatDate(i.createdAt)}
                    {i.status === 'draft' ? ' · check it, then publish' : ''}
                  </span>
                )}
              </span>
              <ItemStatusBadge status={i.status} />
            </Link>
          );
        })}
        {!items.length && !waiting.length ? (
          <div className="px-6 py-9 text-center" data-testid="documents-empty">
            <h3 className="text-[15px] font-semibold">No documents yet</h3>
            <p className="mt-1 text-[13px] text-text-2">
              Add a price list, a warranty or a maintenance plan. The AI only uses a document after
              someone checks its text and publishes it.
            </p>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function FileTile() {
  return (
    <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-warning-soft text-warning-text">
      <File className="h-4 w-4" strokeWidth={1.5} />
    </span>
  );
}
