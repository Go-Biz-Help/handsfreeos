'use client';
import type { CalendarConfig } from '@hfos/core';
import { CircleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Label } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AppointmentDetail } from '@/lib/api/types';
import { firstName } from './appt';
import { CustomerPicker, type PickedCustomer } from './customer-picker';
import { TellField, useTextingReady } from './tell-field';

/**
 * Add a customer to a session or group appointment: who, how many seats, and Tell (a confirmation by text or
 * email; the reminders follow the calendar's settings either way).
 */
export function AddAttendeeDialog({
  workspaceId,
  appt,
  config,
  onClose,
  onDone,
}: {
  workspaceId: string;
  appt: AppointmentDetail;
  config: CalendarConfig | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [person, setPerson] = useState<PickedCustomer | null>(null);
  const [contact, setContact] = useState<{ id: string; phone: boolean; email: boolean } | null>(
    null,
  );
  const [seats, setSeats] = useState(1);
  const [tell, setTell] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textingReady = useTextingReady(workspaceId, true);
  const left = Math.max(0, appt.capacity - appt.seatsTaken);
  const personId = person?.id ?? null;

  // How the picked customer can be reached, for the line under Tell.
  useEffect(() => {
    if (!personId) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/person.get', { body: { workspaceId, personId } })
      .then(unwrap)
      .then((out) => {
        if (!cancelled)
          setContact({
            id: out.person.id,
            phone: !!out.person.phoneE164,
            email: !!out.person.email,
          });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, personId]);
  const reach = contact && contact.id === personId ? contact : null;

  async function add() {
    if (!person) return;
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/appointment.add_attendee', {
          body: { workspaceId, appointmentId: appt.id, personId: person.id, seats, notify: tell },
        }),
      );
      toast.success(`Added ${person.fullName}.`);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Add someone"
        description={`${appt.title} · ${left} ${left === 1 ? 'seat' : 'seats'} left`}
      >
        <div className="mt-3.5 flex flex-col gap-2.5" data-testid="add-attendee-dialog">
          <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2.5">
            <div className="min-w-0">
              <Label htmlFor="add-customer">Customer</Label>
              <CustomerPicker
                id="add-customer"
                workspaceId={workspaceId}
                value={person}
                onChange={(p) => {
                  setPerson(p);
                  setError(null);
                }}
              />
            </div>
            <Field label="Seats" htmlFor="add-seats" className="min-w-0">
              <Select
                id="add-seats"
                value={String(seats)}
                disabled={left <= 1}
                onChange={(e) => {
                  setSeats(Number(e.target.value));
                  setError(null);
                }}
              >
                {Array.from({ length: Math.max(1, Math.min(left, 20)) }, (_, i) => i + 1).map(
                  (n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ),
                )}
              </Select>
            </Field>
          </div>
          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-menu bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text"
            >
              <CircleAlert className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
              <span>{error}</span>
            </div>
          ) : null}
          {person ? (
            <TellField
              name={firstName(person.fullName)}
              notifications={config?.notifications ?? null}
              reach={reach ? { phone: reach.phone, email: reach.email, textingReady } : null}
              checked={tell}
              onChange={setTell}
              testId="add-attendee-tell"
            />
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!person || left < 1}
            onClick={() => void add()}
            data-testid="add-attendee-save"
          >
            Add
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
