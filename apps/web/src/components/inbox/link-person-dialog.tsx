'use client';
import { SENDER_WORDS } from '@hfos/core';
import { Link as LinkIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { RecordPicker, type PickedRecord } from '@/components/crm/record-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FieldError, Label } from '@/components/ui/field';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * Tie a number or address nobody has linked to a customer who already exists; they gain it. Someone's own mail is
 * never a customer's while it's theirs (M19), so linking it shares it with the team in the same step.
 */
export function LinkPersonDialog({
  workspaceId,
  conversationId,
  number,
  privateMail = false,
  open,
  onOpenChange,
  onLinked,
}: {
  workspaceId: string;
  conversationId: string;
  number: string;
  /** Someone's own mail (M19): linked by sharing it onto the customer. */
  privateMail?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void;
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

  async function link() {
    if (!picked || !isPerson) return;
    setBusy(true);
    setError(null);
    try {
      if (privateMail) {
        unwrap(
          await apiBrowser().POST('/v1/commands/conversation.share', {
            body: { workspaceId, conversationId, personId: picked.id },
          }),
        );
        toast.success(SENDER_WORDS.linkedShared(picked.name));
      } else {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/conversation.link_person', {
            body: { workspaceId, conversationId, personId: picked.id },
          }),
        );
        toast.success(
          out.phoneAdded
            ? `Linked to ${picked.name}, who gained ${number}`
            : `Linked to ${picked.name}`,
        );
      }
      close(false);
      onLinked();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title="Link to an existing customer"
        description={`This conversation and ${number} join their record and timeline.${
          privateMail ? ` ${SENDER_WORDS.sharesToo}` : ''
        }`}
      >
        <Label htmlFor="link-person">Customer</Label>
        <RecordPicker
          id="link-person"
          workspaceId={workspaceId}
          value={picked}
          onChange={(r) => {
            setPicked(r);
            setError(null);
          }}
          autoFocus
        />
        {picked && !isPerson ? <FieldError>Pick a person, not a company.</FieldError> : null}
        {error ? <FieldError>{error}</FieldError> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void link()}
            loading={busy}
            disabled={!isPerson}
            data-testid="link-person-save"
          >
            <LinkIcon className="h-4 w-4" strokeWidth={1.5} />
            Link
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
