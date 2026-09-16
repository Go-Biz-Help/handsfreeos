'use client';
/**
 * Copy link: a customer's own link for an estimate, an invoice or a plan — the one they were sent — onto the
 * clipboard, so the business can paste it wherever it already talks to them.
 *
 * Only the worker can mint one (it holds the key; the API may not), so the link comes from
 * `POST /v1/money/link`. **Safari and iOS forget the tap once anything has been awaited**, and refuse a clipboard
 * write after it, so the button never waits on the network inside the tap:
 * - the link is fetched as the page opens, and a tap writes it straight away;
 * - a tap before it has arrived hands the clipboard a promise of it (`ClipboardItem`), which Safari accepts
 *   inside the tap and fills in when the link lands;
 * - and a browser that allows neither shows the link in a dialog to copy from.
 */
import { Link2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/button';
import { CopyField } from '@/components/ui/copy-field';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ApiError } from '@/lib/api/errors';
import { moneyLink, type MoneyLinkKind } from '@/lib/api/worker';

/** What the link lets whoever has it do: said once, as the link is copied. */
const WHAT_IT_DOES: Readonly<Record<MoneyLinkKind, string>> = {
  estimate: 'Anyone with this link can see and approve this estimate.',
  invoice: 'Anyone with this link can pay this invoice.',
  plan: 'Anyone with this link can put a card on this plan.',
};

const COPIED = 'Link copied';

export function CopyLinkButton({
  workspaceId,
  kind,
  id,
  version,
  variant = 'secondary',
  size = 'md',
  className,
}: {
  workspaceId: string;
  kind: MoneyLinkKind;
  id: string;
  /** The document's link version: when it moves, the link it had is retired and a new one is fetched. */
  version?: number;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  /** The link still on its way, so a tap before it lands can be promised it rather than fetch it twice. */
  const coming = useRef<Promise<string> | null>(null);
  /** The link, shown to copy by hand when the browser won't take it. */
  const [shown, setShown] = useState<string | null>(null);

  const fetchLink = useCallback((): Promise<string> => {
    const next = moneyLink({ workspaceId, kind, id }).then((r) => {
      if (coming.current === next) setUrl(r.url);
      return r.url;
    });
    coming.current = next;
    // A failed fetch is said when someone taps, not on page load; the next tap asks again.
    next.catch(() => {
      if (coming.current === next) coming.current = null;
    });
    return next;
  }, [workspaceId, kind, id]);

  useEffect(() => {
    setUrl(null);
    fetchLink().catch(() => {});
  }, [fetchLink, version]);

  const copied = () => toast.success(COPIED, { description: WHAT_IT_DOES[kind] });
  // The worker's own words when it answered (a voided document, say); ours when it couldn't be reached.
  const refused = (e: unknown) =>
    toast.error(
      e instanceof ApiError && e.status !== 0
        ? e.message
        : 'We couldn’t get the link just now. Try again in a minute.',
    );

  function copy() {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    // Already here: written inside the tap itself.
    if (url) {
      if (!clipboard?.writeText) return setShown(url);
      clipboard.writeText(url).then(copied, () => setShown(url));
      return;
    }
    const link = coming.current ?? fetchLink();
    if (clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const item = new ClipboardItem({
        'text/plain': link.then((u) => new Blob([u], { type: 'text/plain' })),
      });
      clipboard.write([item]).then(copied, () =>
        // The browser said no, or the link never came: show it, or say why there isn't one.
        link.then(setShown, refused),
      );
      return;
    }
    link.then((u) => {
      if (!clipboard?.writeText) return setShown(u);
      clipboard.writeText(u).then(copied, () => setShown(u));
    }, refused);
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={copy}
        data-testid={`${kind}-copy-link`}
      >
        <Link2 className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} strokeWidth={1.5} />
        Copy link
      </Button>
      <Dialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)}>
        <DialogContent title="Copy this link" description={WHAT_IT_DOES[kind]}>
          <div className="mt-4" data-testid="copy-link-dialog">
            <CopyField value={shown ?? ''} label="Copy link" copied={COPIED} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
