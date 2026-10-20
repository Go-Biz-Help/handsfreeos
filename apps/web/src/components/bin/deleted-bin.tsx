'use client';
import {
  BIN_WORDS,
  binDay,
  binItemDetail,
  binItemWhen,
  binKindLabel,
  binRestoredWords,
} from '@hfos/core';
import { Trash2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { BinList, BinListItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';

/** How long a search result's item stays ringed, as a setting found by settings search does. */
const RING_MS = 4000;
/** A search result's item further down the bin is looked for this many pages at most. */
const LOOK_PAGES = 10;

/** "Delete now" on one thing, or "Empty the bin" on all of it. */
type Asking = { kind: 'one'; item: BinListItem } | { kind: 'all' };

/**
 * Settings → Deleted bin (20261027000400, 20261027000800): customers, conversations, bookings, leads, companies and
 * records deleted for good, newest first, each waiting its 30 days. Bring one back, delete it now, or empty the
 * whole bin. Whatever is being emptied says so and can't come back.
 */
export function DeletedBin({
  workspaceId,
  timeZone,
  initial,
}: {
  workspaceId: string;
  timeZone: string;
  initial: BinList;
}) {
  const [items, setItems] = useState<BinListItem[]>(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const waiting = items.filter((i) => !i.emptying);

  /**
   * A search result's item (`?item=<id>`): read further down the bin until it shows, then brought into view and
   * ringed for a few seconds. It follows the address, so a result opened while the bin is open rings too; the page
   * renders per request, so this needs no Suspense boundary.
   */
  const itemId = useSearchParams().get('item');
  const [ringed, setRinged] = useState<string | null>(null);
  // What's shown now, where the look further down starts.
  const shownNow = useRef({ items, cursor });
  useEffect(() => {
    shownNow.current = { items, cursor };
  }, [items, cursor]);
  useEffect(() => {
    if (!itemId) return;
    let cancelled = false;
    void (async () => {
      const had = shownNow.current.items;
      let shown = had;
      let next = shownNow.current.cursor;
      for (let page = 0; !shown.some((i) => i.id === itemId) && next && page < LOOK_PAGES; page++) {
        try {
          const out = unwrap(
            await apiBrowser().POST('/v1/queries/bin.list', {
              body: { workspaceId, cursor: next, limit: 50 },
            }),
          );
          shown = [...shown, ...out.items];
          next = out.nextCursor;
        } catch {
          return;
        }
      }
      if (cancelled) return;
      if (shown !== had) {
        setItems(shown);
        setCursor(next);
      }
      if (shown.some((i) => i.id === itemId)) setRinged(itemId);
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId, workspaceId]);
  useEffect(() => {
    if (!ringed) return;
    document
      .querySelector(`[data-bin-item="${CSS.escape(ringed)}"]`)
      ?.scrollIntoView({ block: 'center' });
    const timer = window.setTimeout(() => setRinged(null), RING_MS);
    return () => window.clearTimeout(timer);
  }, [ringed]);

  async function loadMore() {
    if (!cursor) return;
    setBusy('more');
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/bin.list', {
          body: { workspaceId, cursor, limit: 50 },
        }),
      );
      setItems((was) => [...was, ...out.items]);
      setCursor(out.nextCursor);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function restore(item: BinListItem) {
    setBusy(item.id);
    try {
      const back = unwrap(
        await apiBrowser().POST('/v1/commands/bin.restore', {
          body: { workspaceId, binItemId: item.id },
        }),
      );
      toast.success(binRestoredWords(back));
      setItems((was) => was.filter((i) => i.id !== item.id));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function empty(ask: Asking) {
    setBusy('empty');
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/bin.empty', {
          body:
            ask.kind === 'all'
              ? { workspaceId, all: true }
              : { workspaceId, binItemIds: [ask.item.id] },
        }),
      );
      if (ask.kind === 'all') toast.success(BIN_WORDS.emptyStarted(out.emptying));
      setItems((was) =>
        was.map((i) => (ask.kind === 'all' || i.id === ask.item.id ? { ...i, emptying: true } : i)),
      );
      setAsking(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl" data-testid="deleted-bin">
      <Card className="p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold">{BIN_WORDS.title}</h3>
            <p className="mt-1 text-[13px] text-text-2">{BIN_WORDS.about}</p>
          </div>
          {waiting.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              className="text-danger-text hover:text-danger-text"
              onClick={() => setAsking({ kind: 'all' })}
              data-testid="bin-empty-all"
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.5} />
              {BIN_WORDS.emptyAll}
            </Button>
          ) : null}
        </div>
        {items.length === 0 ? (
          <EmptyState title={BIN_WORDS.emptyTitle} className="py-8">
            {BIN_WORDS.emptyBody}
          </EmptyState>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-border border-t border-border">
            {items.map((item) => {
              const detail = binItemDetail(item, timeZone);
              return (
                <li
                  key={item.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 py-3 transition-colors',
                    ringed === item.id &&
                      '-mx-3 rounded-[10px] bg-accent-soft px-3 ring-2 ring-accent',
                  )}
                  data-testid={`bin-item-${item.recordId}`}
                  data-bin-item={item.id}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{item.name}</span>
                      <Badge variant="gray">{binKindLabel(item)}</Badge>
                    </div>
                    {detail ? (
                      <div className="mt-0.5 truncate text-[13px] text-text-2">{detail}</div>
                    ) : null}
                    <div className="mt-0.5 text-xs text-text-3">{binItemWhen(item, timeZone)}</div>
                  </div>
                  {item.emptying ? null : (
                    <div className="flex flex-none gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busy === item.id}
                        onClick={() => void restore(item)}
                        data-testid="bin-restore"
                      >
                        {BIN_WORDS.restore}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger-text hover:text-danger-text"
                        onClick={() => setAsking({ kind: 'one', item })}
                        data-testid="bin-delete-now"
                      >
                        {BIN_WORDS.deleteNow}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {cursor ? (
          <div className="flex justify-center border-t border-border pt-3">
            <Button
              variant="ghost"
              size="sm"
              loading={busy === 'more'}
              onClick={() => void loadMore()}
            >
              Show more
            </Button>
          </div>
        ) : null}
      </Card>

      <Dialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        {asking ? (
          <DialogContent
            title={
              asking.kind === 'all'
                ? BIN_WORDS.emptyAllTitle
                : BIN_WORDS.deleteNowTitle(asking.item.name)
            }
            description={
              asking.kind === 'all'
                ? BIN_WORDS.emptyAllBody
                : BIN_WORDS.deleteNowBody(binDay(asking.item.purgeAfter, timeZone))
            }
          >
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsking(null)}>
                {BIN_WORDS.keep(asking.kind === 'all')}
              </Button>
              <Button
                variant="danger"
                loading={busy === 'empty'}
                onClick={() => void empty(asking)}
                data-testid="bin-empty-confirm"
              >
                {asking.kind === 'all' ? BIN_WORDS.emptyAll : BIN_WORDS.deleteNow}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
