'use client';
import {
  COMPOSE_CHANNELS,
  COMPOSE_WORDS as W,
  composeDefault,
  type ComposeChannel,
} from '@hfos/core';
import { Mail, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { RecordPicker, type PickedRecord } from '@/components/crm/record-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FieldError, Label } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * New message: pick anyone (or add them on the spot), then a text or an email. It opens their conversation on that
 * channel, starting it when they have none, so someone who has never written can be written to (the owner,
 * 2026-11-22). The phone app's sheet says the same words (core's `inbox/compose.ts`).
 */
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
  const [channel, setChannel] = useState<ComposeChannel>('sms');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const person = picked?.kind === 'person' ? picked : null;
  /** Where each would go, as the search showed it: HandsFreeOS has the last word when it opens. */
  const to = { sms: person?.phone || null, email: person?.email || null };

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setPicked(null);
      setChannel('sms');
      setError(null);
    }
  }

  async function start() {
    if (!person || !to[channel]) return;
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/conversation.open', {
          body: { workspaceId, personId: person.id, channel },
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
      <DialogContent title={W.title} description={W.description}>
        <Label htmlFor="new-message-to">{W.to}</Label>
        <RecordPicker
          id="new-message-to"
          workspaceId={workspaceId}
          value={picked}
          onChange={(r) => {
            setPicked(r);
            setError(null);
            // A text when they have a number, else an email.
            if (r?.kind === 'person')
              setChannel(composeDefault({ phoneE164: r.phone ?? null, email: r.email ?? null }));
          }}
          autoFocus
        />
        {picked && !person ? <FieldError>{W.personOnly}</FieldError> : null}
        {person ? (
          <div className="mt-4" data-testid="new-message-how">
            <Label>{W.how}</Label>
            <Segmented
              fill
              ariaLabel={W.how}
              value={channel}
              onChange={(next) => {
                setChannel(next);
                setError(null);
              }}
              options={COMPOSE_CHANNELS.map((c) => ({
                value: c,
                label: W.channel[c],
                testId: `new-message-${c}`,
              }))}
            />
            {to[channel] ? (
              <p
                className="mt-1.5 truncate text-[13px] text-text-3"
                data-testid="new-message-goes-to"
              >
                {to[channel]}
              </p>
            ) : (
              <p className="mt-1.5 text-[13px] text-text-2" data-testid="new-message-missing">
                {W.missing(channel, person.name)}
              </p>
            )}
          </div>
        ) : null}
        {error ? <FieldError>{error}</FieldError> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void start()}
            loading={busy}
            disabled={!person || !to[channel]}
            data-testid="new-message-start"
          >
            {channel === 'email' && person ? (
              <Mail className="h-4 w-4" strokeWidth={1.5} />
            ) : (
              <MessageCircle className="h-4 w-4" strokeWidth={1.5} />
            )}
            {W.open}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
