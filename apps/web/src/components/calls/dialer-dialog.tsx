'use client';
import { formatPhone } from '@hfos/core';
import { CircleAlert, Phone, PhoneOutgoing } from 'lucide-react';
import { Callout } from '@/components/crm/chips';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { useCalls } from '@/lib/calls/call-provider';
import { firstNameOf } from '@/lib/calls/format';

/** "Call Mike Johnson": the number, the caller ID the customer sees, and the microphone note. */
export function DialerDialog() {
  const calls = useCalls();
  const target = calls.dialer;
  if (!target) return null;
  const known = !!target.personId;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) calls.closeDialer();
      }}
    >
      <DialogContent
        title={`Call ${target.name}`}
        className="w-[min(440px,calc(100vw-32px))]"
        description={`The call goes out through this browser, and ${known ? `${firstNameOf(target.name)} sees` : 'they see'} your business number.`}
      >
        <Field label="Number" htmlFor="dialer-number" className="mt-4">
          <Select id="dialer-number" value={target.phone} onChange={() => undefined}>
            <option value={target.phone}>{formatPhone(target.phone)}</option>
          </Select>
        </Field>
        <div className="mb-3 flex items-center gap-2.5 rounded-[10px] bg-card-2 p-3 text-[13px]">
          <PhoneOutgoing className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
          <span>
            Caller ID: <strong>{calls.workspaceName}</strong>
            {calls.callerId ? ` · ${formatPhone(calls.callerId)}` : ''}
          </span>
        </div>
        {calls.readiness === 'blocked' ? (
          <Callout tone="warning" icon={CircleAlert} className="mb-3">
            Your browser blocked the microphone. Allow it in the address bar, then try again.
          </Callout>
        ) : null}
        <p className="text-xs text-text-3">
          Your browser asks to use the microphone the first time you call.
        </p>
        <div className="mt-[18px] flex justify-end gap-2">
          <Button variant="ghost" onClick={calls.closeDialer}>
            Cancel
          </Button>
          <Button
            variant="success"
            data-testid="dialer-call"
            onClick={() => {
              calls.closeDialer();
              void calls.placeCall(target);
            }}
          >
            <Phone className="h-[18px] w-[18px]" strokeWidth={1.75} />
            Call
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
