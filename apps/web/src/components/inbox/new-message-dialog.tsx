'use client';
import { MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { RecordPicker, type PickedRecord } from '@/components/crm/record-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FieldError, Label } from '@/components/ui/field';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/** Pick a customer, then text them: opens (or creates) their text conversation. */
export function NewMessageDialog({
  workspaceId,
  open,
  onOpenChange,
  onOpened,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpened: (conversationId: string) => void;
}) {
  const [picked, setPicked] = useState<PickedRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPerson = picked?.kind === 'person';

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setPicked(null);
      setError(null);
    }
  }

  async function start() {
    if (!picked || !isPerson) return;
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/conversation.open', {
          body: { workspaceId, personId: picked.id, channel: 'sms' },
        }),
      );
      close(false);
      onOpened(out.conversationId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="New message" description="Pick a customer to text.">
        <Label htmlFor="new-message-to">To</Label>
        <RecordPicker
          id="new-message-to"
          workspaceId={workspaceId}
          value={picked}
          onChange={(r) => {
            setPicked(r);
            setError(null);
          }}
          autoFocus
        />
        {picked && !isPerson ? (
          <FieldError>Pick a person: a text goes to one customer’s phone.</FieldError>
        ) : null}
        {error ? <FieldError>{error}</FieldError> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void start()}
            loading={busy}
            disabled={!isPerson}
            data-testid="new-message-start"
          >
            <MessageCircle className="h-4 w-4" strokeWidth={1.5} />
            Open conversation
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
