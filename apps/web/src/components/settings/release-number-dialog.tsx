'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

const digits = (s: string) => s.replace(/[^0-9]/g, '').replace(/^1(?=[0-9]{10}$)/, '');

/** Giving the number back can't be undone, so it takes typing the number. */
export function ReleaseNumberDialog({
  workspaceId,
  phoneNumberId,
  display,
  e164,
  open,
  onOpenChange,
  onReleased,
}: {
  workspaceId: string;
  phoneNumberId: string;
  display: string;
  e164: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReleased: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = digits(typed) === digits(e164);

  async function release() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/phone_number.release', {
          body: { workspaceId, phoneNumberId, confirmE164: typed },
        }),
      );
      toast.success(`${display} is being released`);
      onOpenChange(false);
      setTyped('');
      onReleased();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTyped('');
      }}
    >
      <DialogContent
        title="Release this number?"
        description="Customers who text or call it will reach nobody, and released numbers can’t be recovered."
      >
        <Field label={`Type ${display} to confirm`} htmlFor="release-confirm" className="mt-3">
          <Input
            id="release-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            inputMode="tel"
            autoComplete="off"
            className="font-mono"
            data-testid="release-confirm"
          />
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            disabled={!matches}
            loading={busy}
            onClick={() => void release()}
            data-testid="release-number"
          >
            Release number
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
