'use client';
import {
  BIN_WORDS,
  binContentsTotal,
  binDeleteBox,
  binDeletedWords,
  type BinKind,
} from '@hfos/core';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { BinPreviewItem } from '@/lib/api/types';

/** The most the API takes at once: a page of a list. A longer selection goes a page at a time. */
const AT_ONCE = 100;
const pages = <T,>(list: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(list.length / AT_ONCE) }, (_, i) =>
    list.slice(i * AT_ONCE, (i + 1) * AT_ONCE),
  );

async function preview(workspaceId: string, kind: BinKind, ids: readonly string[]) {
  const found: BinPreviewItem[] = [];
  for (const part of pages(ids))
    found.push(
      ...unwrap(
        await apiBrowser().POST('/v1/queries/bin.preview', {
          body: { workspaceId, kind, ids: part },
        }),
      ).items,
    );
  return found;
}

/** One page of them into the bin, through their kind's own command. */
async function putPage(
  workspaceId: string,
  kind: Exclude<BinKind, 'appointment'>,
  ids: string[],
): Promise<unknown> {
  const api = apiBrowser();
  switch (kind) {
    case 'person':
      return unwrap(
        await api.POST('/v1/commands/person.delete', { body: { workspaceId, personIds: ids } }),
      );
    case 'conversation':
      return unwrap(
        await api.POST('/v1/commands/conversation.delete', {
          body: { workspaceId, conversationIds: ids },
        }),
      );
    case 'lead':
      return unwrap(
        await api.POST('/v1/commands/lead.delete', { body: { workspaceId, leadIds: ids } }),
      );
    case 'company':
      return unwrap(
        await api.POST('/v1/commands/company.delete', { body: { workspaceId, companyIds: ids } }),
      );
    case 'custom_record':
      return unwrap(
        await api.POST('/v1/commands/custom_record.delete', {
          body: { workspaceId, customRecordIds: ids },
        }),
      );
  }
}

async function putInBin(
  workspaceId: string,
  kind: BinKind,
  ids: readonly string[],
  tell: boolean,
): Promise<void> {
  if (kind === 'appointment') {
    for (const appointmentId of ids)
      unwrap(
        await apiBrowser().POST('/v1/commands/appointment.delete', {
          body: { workspaceId, appointmentId, notify: tell },
        }),
      );
    return;
  }
  for (const part of pages(ids)) await putPage(workspaceId, kind, part);
}

/**
 * "Delete … for good?" for customers, conversations, a booking, a lead, a company or a record (the Deleted bin,
 * 20261027000400 and 20261027000800). It asks first what goes with them (bin.preview) and says so, names any that
 * can't go yet and why, and deletes the rest. A booking still to come is cancelled first, telling the customer
 * unless that's unticked, as Cancel does.
 */
export function DeleteDialog({
  workspaceId,
  kind,
  ids,
  names: given,
  open,
  onOpenChange,
  onDeleted,
  tellLabel = null,
}: {
  workspaceId: string;
  kind: BinKind;
  ids: readonly string[];
  /** Their names (a conversation's customer), for the title while it asks what goes with them. */
  names: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What went in the bin. */
  onDeleted: (ids: string[]) => void;
  /** A booking: the tick box's words for telling its customers (calendar/cancel-dialog.tsx's `tellLabelOf`). */
  tellLabel?: string | null;
}) {
  const [items, setItems] = useState<BinPreviewItem[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tell, setTell] = useState(true);
  const key = ids.join(',');

  useEffect(() => {
    if (!open || ids.length === 0) return;
    let stale = false;
    setItems(null);
    setFailed(null);
    setTell(true);
    preview(workspaceId, kind, ids).then(
      (found) => !stale && setItems(found),
      (e: unknown) => !stale && setFailed(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
    // `key` stands for `ids`, which callers make afresh on every render.
  }, [open, workspaceId, kind, key]);

  const blocked = items?.filter((i) => i.rule) ?? [];
  const going = items?.filter((i) => !i.rule) ?? [];
  const names =
    items === null ? given : (going.length > 0 ? going : items).map((i) => i.name ?? '');
  const box = binDeleteBox(kind, names, binContentsTotal(going.map((i) => i.contents)));
  const upcoming = kind === 'appointment' && (going[0]?.contents.upcoming ?? 0) > 0;
  const several = ids.length > 1;

  async function confirm() {
    setBusy(true);
    try {
      const done = going.map((i) => i.id);
      const told = upcoming && tell && !!tellLabel;
      await putInBin(workspaceId, kind, done, told);
      toast.success(
        told
          ? BIN_WORDS.cancelledTold
          : binDeletedWords(
              kind,
              going.map((i) => i.name ?? ''),
            ),
      );
      onOpenChange(false);
      onDeleted(done);
    } catch (e) {
      toast.error(errorMessage(e));
      // Something changed since it was asked (a plan started billing, someone else deleted one): ask again.
      preview(workspaceId, kind, ids).then(setItems, () => undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={box.title}>
        <div className="mt-2 flex flex-col gap-2" data-testid="delete-dialog">
          {failed ? (
            <p className="text-[13px] text-danger-text" role="alert">
              {failed}
            </p>
          ) : items === null ? (
            <p className="text-[13px] text-text-3" aria-busy>
              {BIN_WORDS.checking(several)}
            </p>
          ) : (
            <>
              {going.length > 0
                ? box.lines.map((line) => (
                    <p key={line} className="text-[13px] text-text-2">
                      {line}
                    </p>
                  ))
                : null}
              {blocked.length > 0 ? (
                <Callout data-testid="delete-blocked">
                  <div className="flex flex-col gap-1">
                    {several ? <strong>{BIN_WORDS.blocked(blocked.length)}</strong> : null}
                    {blocked.map((b) => (
                      <span key={b.id}>{b.message}</span>
                    ))}
                  </div>
                </Callout>
              ) : null}
              {upcoming && tellLabel ? (
                <div className="mt-1">
                  <Checkbox
                    label={<span className="font-medium">{tellLabel}</span>}
                    checked={tell}
                    onChange={(e) => setTell(e.target.checked)}
                    data-testid="delete-tell"
                  />
                  <p className="ml-7 mt-0.5 text-xs text-text-3">
                    {tell
                      ? 'They hear that it’s cancelled, with the business’s number to pick a new time.'
                      : 'Nobody is told. Tell them yourself.'}
                  </p>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {BIN_WORDS.keep(several)}
          </Button>
          {going.length > 0 ? (
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void confirm()}
              data-testid="delete-confirm"
            >
              {blocked.length > 0 ? BIN_WORDS.submitRest(going.length) : BIN_WORDS.submit}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
