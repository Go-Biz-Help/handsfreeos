'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';

/** Sends one text from the business number to a phone in your hand, to see it arrive. */
export function TestTextDialog({
  workspaceId,
  businessName,
  defaultPhone,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  businessName: string;
  defaultPhone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [phone, setPhone] = useState(defaultPhone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(acknowledgeQuietHours = false) {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/message.send', {
          body: {
            workspaceId,
            toPhone: phone,
            channel: 'sms',
            body: `This is a test text from ${businessName} on HandsFreeOS. Replies land in the inbox.`,
            acknowledgeQuietHours,
          },
        }),
      );
      toast.success(`Texted a test to ${phone}`);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'quiet_hours' && !acknowledgeQuietHours) {
        setError(`${e.message} Press Send again to send it anyway.`);
        setBusy(false);
        return;
      }
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Text me a test"
        description="One text from the business number. It shows up in the inbox like any other conversation."
      >
        <Field label="Your mobile number" htmlFor="test-phone" error={error} className="mt-3">
          <Input
            id="test-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            autoComplete="tel"
            placeholder="(713) 555-0123"
            data-testid="test-text-phone"
          />
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!phone.trim()}
            onClick={() => void send(!!error?.includes('anyway'))}
            data-testid="test-text-send"
          >
            Send
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
