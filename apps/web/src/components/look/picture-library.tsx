'use client';
/**
 * Your pictures (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 1): the business's library, as Settings →
 * Workspace shows it and as the pickers on forms, booking pages and emails open it.
 *
 * - Several pictures upload at once, picked or dropped. Each goes straight to Storage at the place
 *   `picture.begin_upload` reserved, then to the worker, which makes the web copy; while any is being made, the list
 *   is asked for again every few seconds.
 * - Pressing a picture opens it: its name, what it shows in words (read out to people who can't see it), and Remove.
 *   In a picker (`onPick`), pressing it picks it instead.
 */
import { PICTURE_UPLOAD_AT_ONCE, PICTURE_WORDS as P, type PictureRow } from '@hfos/core';
import { AlertTriangle, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FieldError, Hint } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/client';
import { PICTURE_ACCEPT, pictureActions, pictureSrc } from '@/lib/picture-actions';
import { cn } from '@/lib/utils';

/** While a picture is being made, the list is asked for again this often. */
const POLL_MS = 3_000;

/** The library's pictures, read and kept fresh while any is being made. */
export function usePictures(workspaceId: string) {
  const actions = useMemo(() => pictureActions(workspaceId), [workspaceId]);
  const [pictures, setPictures] = useState<PictureRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setPictures(await actions.list());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [actions]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const waiting = !!pictures?.some((p) => p.status === 'making' || p.status === 'uploading');
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, reload]);
  return { pictures, error, reload, actions, setPictures };
}

export function PictureLibrary({
  workspaceId,
  canChange,
  onPick,
  picked,
}: {
  workspaceId: string;
  /** May add, rename and remove (whoever may change the business, its forms, calendars or channels). */
  canChange: boolean;
  /** In a picker: pressing a ready picture picks it. */
  onPick?: (picture: PictureRow) => void;
  /** The picture picked now, outlined. */
  picked?: string | null;
}) {
  const { pictures, error, reload, actions, setPictures } = usePictures(workspaceId);
  const [uploading, setUploading] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<PictureRow | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function upload(list: FileList | File[] | null) {
    const files = [...(list ?? [])].slice(0, PICTURE_UPLOAD_AT_ONCE);
    if (!files.length || !canChange) return;
    setProblem(null);
    setUploading((n) => n + files.length);
    const problems: string[] = [];
    await Promise.all(
      files.map(async (f) => {
        try {
          const made = await actions.upload(f);
          setPictures((now) => [made, ...(now ?? []).filter((p) => p.id !== made.id)]);
        } catch (e) {
          problems.push(errorMessage(e));
        } finally {
          setUploading((n) => n - 1);
        }
      }),
    );
    if (problems.length) setProblem(problems.join(' '));
    await reload();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    void upload(e.dataTransfer.files);
  }

  const shown = pictures ?? [];
  return (
    <div
      onDragOver={(e) => {
        if (!canChange) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn('rounded-card', over && 'ring-[3px] ring-ring')}
      data-testid="picture-library"
    >
      {canChange ? (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <input
            ref={file}
            type="file"
            accept={PICTURE_ACCEPT}
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = '';
            }}
            data-testid="picture-upload-input"
          />
          <Button
            variant="secondary"
            onClick={() => file.current?.click()}
            loading={uploading > 0}
            data-testid="picture-upload"
          >
            <ImagePlus className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            {P.upload}
          </Button>
          <Hint className="mt-0 min-w-0 flex-1">{P.uploadHint}</Hint>
        </div>
      ) : null}
      <FieldError>{problem ?? error}</FieldError>
      {pictures === null && !error ? (
        <div className="flex h-24 items-center justify-center text-text-3">
          <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading your pictures" />
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-card border border-dashed border-border-strong p-6 text-center text-[13px] text-text-3">
          {P.empty}
        </p>
      ) : (
        <ul
          className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2.5"
          data-testid="picture-grid"
        >
          {shown.map((p) => (
            <li key={p.id}>
              <PictureTile
                picture={p}
                picked={picked === p.id}
                onPress={() => {
                  if (onPick && p.status === 'ready') onPick(p);
                  else if (canChange || p.status === 'ready') setOpen(p);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <PictureDialog
          picture={open}
          canChange={canChange}
          onClose={() => setOpen(null)}
          onSave={async (patch) => {
            const next = await actions.update(open.id, patch);
            setPictures((now) => (now ?? []).map((p) => (p.id === next.id ? next : p)));
            toast.success(P.saved);
            setOpen(null);
          }}
          onRemove={async () => {
            await actions.remove(open.id);
            setPictures((now) => (now ?? []).filter((p) => p.id !== open.id));
            toast.success(P.removed);
            setOpen(null);
          }}
        />
      ) : null}
    </div>
  );
}

function PictureTile({
  picture: p,
  picked,
  onPress,
}: {
  picture: PictureRow;
  picked: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className={cn(
        'group relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-control border bg-card-2 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        picked ? 'border-accent ring-2 ring-accent' : 'border-border hover:border-border-strong',
      )}
      aria-label={p.status === 'ready' ? p.words || p.name : `${p.name}: ${p.status}`}
      aria-pressed={picked || undefined}
      data-testid="picture-tile"
      data-status={p.status}
    >
      {p.status === 'ready' && p.path ? (
        // Storage's public address: plain <img>, nothing for an image optimizer to keep.
        <img
          src={pictureSrc(p.path)}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : p.status === 'failed' ? (
        <span className="flex flex-col items-center gap-1 px-2 text-center text-[11.5px] text-danger-text">
          <AlertTriangle className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          {P.failed}
        </span>
      ) : (
        <span className="flex flex-col items-center gap-1 px-2 text-center text-[11.5px] text-text-3">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {P.making}
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 truncate bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] px-1.5 py-0.5 text-[11px] text-text-2">
        {p.name}
      </span>
    </button>
  );
}

function PictureDialog({
  picture,
  canChange,
  onClose,
  onSave,
  onRemove,
}: {
  picture: PictureRow;
  canChange: boolean;
  onClose: () => void;
  onSave: (patch: { name?: string; words?: string }) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [name, setName] = useState(picture.name);
  const [words, setWords] = useState(picture.words);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(kind: 'save' | 'remove', act: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await act();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent title={picture.name} className="w-[min(560px,calc(100vw-32px))]">
        <div className="mt-3 space-y-3" data-testid="picture-dialog">
          {picture.status === 'ready' && picture.path ? (
            <img
              src={pictureSrc(picture.path)}
              alt={picture.words}
              className="max-h-[320px] w-full rounded-control bg-card-2 object-contain"
            />
          ) : picture.problem ? (
            <p role="alert" className="text-[13px] text-danger-text">
              {picture.problem}
            </p>
          ) : null}
          {picture.width && picture.height ? (
            <Hint className="mt-0">
              {picture.width} × {picture.height} pixels
            </Hint>
          ) : null}
          {canChange ? (
            <>
              <label className="block text-[13px] font-medium" htmlFor="picture-name">
                Name
              </label>
              <Input
                id="picture-name"
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                data-testid="picture-name"
              />
              <label className="block text-[13px] font-medium" htmlFor="picture-words">
                {P.words}
              </label>
              <Textarea
                id="picture-words"
                value={words}
                maxLength={300}
                rows={2}
                className="min-h-[64px]"
                placeholder="Our crew on a roof in Austin"
                onChange={(e) => setWords(e.target.value)}
                data-testid="picture-words"
              />
              <Hint className="mt-0">{P.wordsHint}</Hint>
            </>
          ) : picture.words ? (
            <p className="text-[13px] text-text-2">{picture.words}</p>
          ) : null}
          <FieldError>{error}</FieldError>
          {canChange ? (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <Button
                variant="ghost"
                onClick={() => void run('remove', onRemove)}
                loading={busy === 'remove'}
                data-testid="picture-remove"
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                {P.remove}
              </Button>
              {picture.status !== 'failed' ? (
                <Button
                  onClick={() =>
                    void run('save', () =>
                      onSave({
                        ...(name.trim() !== picture.name ? { name: name.trim() } : {}),
                        ...(words.trim() !== picture.words ? { words: words.trim() } : {}),
                      }),
                    )
                  }
                  disabled={
                    !name.trim() || (name.trim() === picture.name && words.trim() === picture.words)
                  }
                  loading={busy === 'save'}
                  data-testid="picture-save"
                >
                  Save
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
