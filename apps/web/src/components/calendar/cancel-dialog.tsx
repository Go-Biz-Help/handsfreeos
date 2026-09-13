'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AppointmentDetail } from '@/lib/api/types';
import { dateOf, fmtDateShort, fmtTime } from '@/lib/calendar/time';
import { firstName } from './appt';

/** "Cancel this appointment?" with a reason and whether to tell the customers. */
export function CancelDialog({
  workspaceId,
  appt,
  timeZone,
  onClose,
  onDone,
}: {
  workspaceId: string;
  appt: AppointmentDetail;
  timeZone: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [tell, setTell] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const booked = appt.attendees.filter((a) => a.status === 'booked');
  const one = booked.length === 1 ? booked[0]! : null;
  const label = one
    ? one.smsOk
      ? `Text ${firstName(one.fullName)} that it’s cancelled`
      : one.contactEmail
        ? `Email ${firstName(one.fullName)} that it’s cancelled`
        : `Tell ${firstName(one.fullName)} that it’s cancelled`
    : booked.length
      ? `Tell the ${booked.length} people who booked`
      : null;

  async function cancel() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/appointment.cancel', {
          body: {
            workspaceId,
            appointmentId: appt.id,
            reason: reason.trim() || null,
            notify: tell && !!label,
          },
        }),
      );
      toast.success(
        tell && label ? 'Cancelled. The customer is being told.' : 'Cancelled. Nobody was told.',
      );
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const when = `${fmtDateShort(dateOf(appt.startsAt, timeZone))}, ${fmtTime(appt.startsAt, timeZone)}`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Cancel this appointment?"
        description={[appt.title, one?.fullName, when].filter(Boolean).join(' · ')}
      >
        <div className="mt-3.5 flex flex-col gap-3" data-testid="cancel-dialog">
          {label ? (
            <div>
              <Checkbox
                label={<span className="font-medium">{label}</span>}
                checked={tell}
                onChange={(e) => setTell(e.target.checked)}
                data-testid="cancel-tell"
              />
              <p className="ml-7 mt-0.5 text-xs text-text-3">
                {tell
                  ? `They hear that the ${appt.title.toLowerCase()} on ${when} is cancelled, with the business’s number to pick a new time.`
                  : 'Nobody is told. Tell them yourself.'}
              </p>
            </div>
          ) : null}
          <Field
            label="Reason (optional)"
            htmlFor="cancel-reason"
            hint="Kept in the history, not sent."
          >
            <Textarea
              id="cancel-reason"
              value={reason}
              maxLength={500}
              className="min-h-[64px]"
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={() => void cancel()}
            data-testid="cancel-confirm"
          >
            Cancel appointment
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
