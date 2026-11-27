'use client';
/**
 * Picking a picture from Your pictures (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 2), wherever a page takes
 * one: a picture on a form, a choice's picture, a form's cover and background. The picture shows small beside Change and
 * None; pressing Change opens the library, where a picture can be uploaded and then picked.
 */
import { PICTURE_WORDS as P, pictureIdOfPath, type PictureRef, type PictureRow } from '@hfos/core';
import { ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { pictureSrc } from '@/lib/look';
import { cn } from '@/lib/utils';
import { PictureLibrary } from './picture-library';

/** A picked library picture as a page keeps it: where its copy is, and its size. */
export const pictureRefOf = (p: PictureRow): PictureRef | null =>
  p.status === 'ready' && p.path && p.width && p.height
    ? { path: p.path, width: p.width, height: p.height }
    : null;

export function PicturePicker({
  workspaceId,
  value,
  onChange,
  disabled,
  canUpload,
  label,
  testId = 'picture-picker',
  compact,
}: {
  workspaceId: string;
  value: PictureRef | null;
  /** The picked picture, with its library row (its name and words), or null for none. */
  onChange: (picture: PictureRef | null, row: PictureRow | null) => void;
  disabled?: boolean;
  /** May upload to the library from the picker. */
  canUpload: boolean;
  /** What the picker is for, said to screen readers and on the dialog ("Cover picture"). */
  label: string;
  testId?: string;
  /** A small square, for a choice's picture. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('flex items-center gap-3', compact && 'gap-2')} data-testid={testId}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={value ? `${label}: change it` : `${label}: ${P.pick}`}
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden rounded-control border border-border bg-card-2 text-text-3 hover:border-border-strong focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-60',
          compact ? 'h-9 w-9' : 'h-16 w-24',
        )}
        data-testid={`${testId}-open`}
      >
        {value ? (
          <img src={pictureSrc(value.path)} alt="" className="h-full w-full object-cover" />
        ) : (
          <ImageIcon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        )}
      </button>
      {compact ? null : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => setOpen(true)}
            data-testid={`${testId}-change`}
          >
            {value ? 'Change' : P.pick}
          </Button>
          {value ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onChange(null, null)}
              data-testid={`${testId}-none`}
            >
              {P.none}
            </Button>
          ) : null}
        </div>
      )}
      {open ? (
        <Dialog open onOpenChange={(o) => setOpen(o)}>
          <DialogContent title={label} className="w-[min(720px,calc(100vw-32px))]">
            <div className="max-h-[70vh] overflow-y-auto p-1">
              <PictureLibrary
                workspaceId={workspaceId}
                canChange={canUpload}
                picked={value ? pictureIdOfPath(value.path) : null}
                onPick={(row) => {
                  const ref = pictureRefOf(row);
                  if (!ref) return;
                  onChange(ref, row);
                  setOpen(false);
                }}
              />
            </div>
            {compact && value ? (
              <div className="mt-3 flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onChange(null, null);
                    setOpen(false);
                  }}
                  data-testid={`${testId}-none`}
                >
                  {P.none}
                </Button>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
