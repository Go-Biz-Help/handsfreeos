'use client';
/**
 * Delete a coached call for good (`salescoach.call.delete`), for owners and whoever an owner gives
 * `salescoach.delete`. It asks first, then goes back to the list.
 */
import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { salescoachHref } from './home';

export function DeleteCall({
  workspaceId,
  coachedCallId,
  compact,
}: {
  workspaceId: string;
  coachedCallId: string;
  /** An icon on a row of the list, rather than a button on the call's page. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/salescoach.call.delete', {
          body: { workspaceId, coachedCallId },
        }),
      );
      setOpen(false);
      router.push(salescoachHref(workspaceId, 'calls'));
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {compact ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={W.calls.delete}
          title={W.calls.delete}
          data-testid="coached-delete"
          className="flex h-9 w-9 flex-none items-center justify-center rounded-control text-text-3 hover:bg-card-2 hover:text-danger-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="coached-delete"
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          {W.calls.delete}
        </Button>
      )}
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent title={W.calls.deleteTitle} description={W.calls.deleteAbout}>
          {error ? (
            <p role="alert" className="mt-3 text-[13px] text-danger-text">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary" size="sm" disabled={busy}>
                {W.calls.cancel}
              </Button>
            </DialogClose>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
              data-testid="coached-delete-confirm"
            >
              {busy ? W.calls.deleting : W.calls.deleteConfirm}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
