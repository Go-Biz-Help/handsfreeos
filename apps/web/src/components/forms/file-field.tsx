'use client';
/**
 * A file question as the person answering sees it (core's forms/uploads.ts): a box to add their design, a photo of
 * what they want, or a document, from the phone's camera roll or a computer, with each file's progress and an X to
 * take it back. Each file is uploaded as soon as it's picked, onto this answer sheet only, and goes to the business
 * when the form is sent. The editor's preview shows the box without taking anything.
 */
import {
  isAnswerFiles,
  uploadAcceptAttr,
  uploadLimitBytes,
  uploadMaxFiles,
  uploadRefusal,
  uploadTakesWords,
  uploadTypeOf,
  type AnswerFile,
  type AnswerValue,
  type Question,
} from '@hfos/core';
import { FileText, ImagePlus, Loader2, Paperclip, X } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { PublicFormContext } from './booking-picker';

/** A file on its way up, or one that couldn't be added (its words stay until it's dismissed). */
interface Sending {
  readonly key: string;
  readonly name: string;
  readonly percent: number;
  readonly error: string | null;
}

const sizeWords = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function FileField({
  question,
  value,
  onChange,
  inputId,
}: {
  question: Question;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
  /** The file box's id, so the question's label lands on it. */
  inputId: string;
}) {
  const page = useContext(PublicFormContext);
  const upload = page?.upload ?? null;
  const files: readonly AnswerFile[] = isAnswerFiles(value) ? value : [];
  const [sending, setSending] = useState<readonly Sending[]>([]);
  const [dragging, setDragging] = useState(false);
  /** Pictures of the photos picked here, by file id, so a customer sees which one they're taking back. */
  const [previews, setPreviews] = useState<Readonly<Record<string, string>>>({});
  // Several files finish one after another before the page draws again: each adds to the latest list, not to the
  // one the page last drew.
  const latest = useRef<readonly AnswerFile[]>(files);
  useEffect(() => {
    latest.current = files;
  }, [files]);
  // The pictures are let go of when the box goes away (one taken back is let go of where it's removed).
  const shown = useRef(previews);
  useEffect(() => {
    shown.current = previews;
  }, [previews]);
  useEffect(
    () => () => {
      for (const url of Object.values(shown.current)) URL.revokeObjectURL(url);
    },
    [],
  );

  const most = uploadMaxFiles(question);
  const room = Math.max(0, most - files.length - sending.filter((s) => !s.error).length);
  const imagesOnly = (question.config as { accept?: string }).accept === 'image';

  function add(picked: readonly File[]) {
    if (!upload) return;
    for (const [i, file] of picked.entries()) {
      const key = `${Date.now()}-${i}-${file.name}`;
      const type = uploadTypeOf(file.name, file.type);
      const refusal =
        i >= room
          ? {
              message:
                most === 1
                  ? 'This question takes one file. Take the other back to add this one.'
                  : `This question takes up to ${most} files.`,
            }
          : uploadRefusal(question, { name: file.name, mimeType: type, sizeBytes: file.size });
      if (refusal) {
        setSending((s) => [...s, { key, name: file.name, percent: 0, error: refusal.message }]);
        continue;
      }
      setSending((s) => [...s, { key, name: file.name, percent: 0, error: null }]);
      upload(question.id, file, (percent) =>
        setSending((s) => s.map((x) => (x.key === key ? { ...x, percent } : x))),
      )
        .then((done) => {
          setSending((s) => s.filter((x) => x.key !== key));
          if (type.startsWith('image/') && type !== 'image/heic' && type !== 'image/heif')
            setPreviews((p) => ({ ...p, [done.fileId]: URL.createObjectURL(file) }));
          latest.current = [...latest.current, done];
          onChange(latest.current as AnswerValue);
        })
        .catch((e: unknown) =>
          setSending((s) =>
            s.map((x) =>
              x.key === key
                ? {
                    ...x,
                    error:
                      e instanceof ApiError
                        ? e.message
                        : 'Your file didn’t finish uploading. Try again in a moment.',
                    percent: 0,
                  }
                : x,
            ),
          ),
        );
    }
  }

  function takeBack(fileId: string) {
    const url = previews[fileId];
    if (url) URL.revokeObjectURL(url);
    latest.current = latest.current.filter((f) => f.fileId !== fileId);
    onChange((latest.current.length ? latest.current : null) as AnswerValue);
  }

  const Icon = imagesOnly ? ImagePlus : Paperclip;
  const limitMb = Math.round(uploadLimitBytes(question) / 1024 / 1024);

  return (
    <div className="space-y-2" data-testid={`file-question-${question.id}`}>
      <label
        className={cn(
          'flex cursor-pointer flex-col items-center gap-1 rounded-control border border-dashed px-3 py-5 text-center transition-colors',
          dragging ? 'border-accent bg-accent/5' : 'border-border-strong hover:bg-card-2',
          (!upload || room === 0) && 'cursor-default opacity-60 hover:bg-transparent',
        )}
        onDragOver={(e) => {
          if (!upload || room === 0) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!upload || room === 0) return;
          e.preventDefault();
          setDragging(false);
          add(Array.from(e.dataTransfer.files));
        }}
      >
        <Icon className="h-5 w-5 text-text-2" strokeWidth={1.75} aria-hidden="true" />
        <span className="text-[14px] font-medium text-accent-text">
          {!upload
            ? 'Files are added on the live form'
            : room === 0
              ? most === 1
                ? 'File added'
                : `${most} files added`
              : imagesOnly
                ? most === 1
                  ? 'Add a photo'
                  : 'Add photos'
                : most === 1
                  ? 'Add a file'
                  : 'Add files'}
        </span>
        <span className="text-[12px] text-text-3">
          {uploadTakesWords(question)}, up to {limitMb} MB
          {most > 1 ? ` each, ${most} at most` : ''}
        </span>
        <input
          id={inputId}
          type="file"
          className="sr-only"
          accept={uploadAcceptAttr(question)}
          multiple={most > 1}
          disabled={!upload || room === 0}
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            // The same file can be picked again after it's taken back.
            e.target.value = '';
          }}
          data-testid={`file-input-${question.id}`}
        />
      </label>

      {files.length || sending.length ? (
        <ul className="space-y-1.5" aria-live="polite">
          {files.map((f) => (
            <li
              key={f.fileId}
              className="flex items-center gap-2.5 rounded-control border border-border px-2.5 py-2"
              data-testid="file-added"
            >
              {previews[f.fileId] ? (
                // A local picture of the photo they picked: nothing is fetched.
                <img
                  src={previews[f.fileId]}
                  alt=""
                  className="h-9 w-9 shrink-0 rounded-[6px] object-cover"
                />
              ) : (
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-card-2">
                  <FileText className="h-4 w-4 text-text-2" strokeWidth={1.75} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-text">{f.name}</span>
                <span className="block text-[12px] text-text-3">{sizeWords(f.bytes)}</span>
              </span>
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-text-3 transition-colors hover:bg-card-2 hover:text-text"
                aria-label={`Take back ${f.name}`}
                onClick={() => takeBack(f.fileId)}
              >
                <X className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </li>
          ))}
          {sending.map((s) => (
            <li
              key={s.key}
              className={cn(
                'flex items-center gap-2.5 rounded-control border px-2.5 py-2',
                s.error ? 'border-danger bg-danger-soft' : 'border-border',
              )}
              data-testid={s.error ? 'file-refused' : 'file-sending'}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-card-2">
                {s.error ? (
                  <FileText className="h-4 w-4 text-danger-text" strokeWidth={1.75} />
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-text-2" strokeWidth={1.75} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-text">{s.name}</span>
                {s.error ? (
                  <span role="alert" className="block text-[12px] text-danger-text">
                    {s.error}
                  </span>
                ) : (
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-card-2">
                    <span
                      className="block h-full rounded-full bg-accent transition-[width]"
                      style={{ width: `${Math.max(4, s.percent)}%` }}
                    />
                  </span>
                )}
              </span>
              {s.error ? (
                <button
                  type="button"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-text-3 transition-colors hover:bg-card-2 hover:text-text"
                  aria-label={`Dismiss ${s.name}`}
                  onClick={() => setSending((list) => list.filter((x) => x.key !== s.key))}
                >
                  <X className="h-4 w-4" strokeWidth={1.75} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
