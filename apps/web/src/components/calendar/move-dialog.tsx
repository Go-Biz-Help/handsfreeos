'use client';
import { localInstant, minutesToClock } from '@hfos/core';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Appointment, AppointmentWarning } from '@/lib/api/types';
import {
  dateOf,
  fmtAt,
  fmtLength,
  fmtWhen,
  minutesBetween,
  minutesOf,
  timeOptionsWith,
  zoneLabel,
} from '@/lib/calendar/time';
import { FreshTimes } from './appointment-dialog';
import { customersOf, firstName, freshTimes, namesText } from './appt';

const LENGTHS = [15, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480];

export type MoveTarget =
  | { readonly kind: 'pick' }
  | {
      readonly kind: 'drop';
      /** New start and end instants. */
      readonly start: number;
      readonly end: number;
      /** The new people, when it was dropped in someone else's column. */
      readonly userIds: readonly string[] | null;
    };

/** "Tell Maria" / "Tell the 4 people booked"; null when nobody is booked on it. */
export function tellLabel(a: Pick<Appointment, 'attendees'>): string | null {
  const c = customersOf(a);
  if (!c.length) return null;
  return c.length === 1
    ? `Tell ${firstName(c[0]!.fullName)}`
    : `Tell the ${c.length} people booked`;
}

/**
 * "Move this appointment?" after a drag (or a resize), and Reschedule from the details. Warnings can be
 * booked over with "Move anyway"; another appointment at the same time can't. Tell sends the customer a
 * note about the change.
 */
export function MoveDialog({
  workspaceId,
  appt,
  timeZone,
  target,
  people,
  onClose,
  onDone,
}: {
  workspaceId: string;
  appt: Appointment;
  timeZone: string;
  target: MoveTarget;
  people: readonly { userId: string; fullName: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const wasStart = Date.parse(appt.startsAt);
  const wasLength = minutesBetween(appt.startsAt, appt.endsAt);
  const [date, setDate] = useState(dateOf(wasStart, timeZone));
  const [time, setTime] = useState(minutesOf(wasStart, timeZone));
  const [length, setLength] = useState(wasLength);
  const [tell, setTell] = useState(true);
  const [warnings, setWarnings] = useState<AppointmentWarning[] | null>(null);
  /** A 409 resource_full: its message and the nearest open times. Never moved over. */
  const [full, setFull] = useState<{ message: string; times: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ time: boolean; staff: boolean }>({
    time: false,
    staff: false,
  });

  const start =
    target.kind === 'drop' ? target.start : localInstant(date, minutesToClock(time), timeZone);
  const end = target.kind === 'drop' ? target.end : start + length * 60_000;
  const nextStaff = target.kind === 'drop' ? target.userIds : null;
  const staffNow = appt.staff.map((s) => s.userId);
  const timeChanged = start !== wasStart || end !== Date.parse(appt.endsAt);
  const staffChanged = !!nextStaff && nextStaff.join() !== staffNow.join();
  const nameOf = (id: string) =>
    people.find((p) => p.userId === id)?.fullName ??
    appt.staff.find((s) => s.userId === id)?.fullName ??
    'Someone';
  const customers = customersOf(appt);
  const tellText = tellLabel(appt);
  const reset = () => {
    setWarnings(null);
    setError(null);
    setFull(null);
  };

  async function move() {
    setBusy(true);
    setError(null);
    const ack = !!warnings;
    try {
      let stage = done;
      if (timeChanged && !stage.time) {
        unwrap(
          await apiBrowser().POST('/v1/commands/appointment.reschedule', {
            body: {
              workspaceId,
              appointmentId: appt.id,
              startsAt: new Date(start).toISOString(),
              durationMinutes: Math.round((end - start) / 60_000),
              acknowledgeWarnings: ack,
              notify: tell,
            },
          }),
        );
        stage = { ...stage, time: true };
        setDone(stage);
      }
      if (staffChanged && !stage.staff) {
        unwrap(
          await apiBrowser().POST('/v1/commands/appointment.reassign', {
            body: {
              workspaceId,
              appointmentId: appt.id,
              userIds: [...nextStaff!],
              acknowledgeWarnings: ack,
              notify: tell,
            },
          }),
        );
        stage = { ...stage, staff: true };
        setDone(stage);
      }
      toast.success(
        staffChanged
          ? `Moved to ${namesText(nextStaff!.map((u) => firstName(nameOf(u))))}${timeChanged ? `, ${fmtAt(start, timeZone)}` : ''}.`
          : `Moved to ${fmtAt(start, timeZone)}.`,
      );
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'needs_confirmation')
        setWarnings((e.details as { warnings?: AppointmentWarning[] }).warnings ?? []);
      else if (e instanceof ApiError && e.rule === 'resource_full') {
        // No room on the equipment then: a hard stop with other times, never "Move anyway".
        setWarnings(null);
        setFull({ message: e.message, times: freshTimes(e.details) });
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const summary = [
    appt.title,
    customers.length === 1
      ? customers[0]!.fullName
      : customers.length
        ? `${customers.length} customers`
        : null,
    namesText(appt.staff.map((s) => firstName(s.fullName))),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={target.kind === 'drop' ? 'Move this appointment?' : 'Reschedule'}
        description={summary}
        className="w-[min(520px,calc(100vw-24px))]"
      >
        <div data-testid="move-dialog">
          {target.kind === 'pick' ? (
            <div className="mt-3.5 grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2.5">
              <Field label="Date" htmlFor="move-date" className="min-w-0">
                <Input
                  id="move-date"
                  type="date"
                  value={date}
                  onChange={(e) => {
                    if (e.target.value) setDate(e.target.value);
                    reset();
                  }}
                />
              </Field>
              <Field label="Start" htmlFor="move-start" className="min-w-0">
                <Select
                  id="move-start"
                  value={String(time)}
                  onChange={(e) => {
                    setTime(Number(e.target.value));
                    reset();
                  }}
                >
                  {timeOptionsWith(time).map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Length" htmlFor="move-length" className="min-w-0">
                <Select
                  id="move-length"
                  value={String(length)}
                  onChange={(e) => {
                    setLength(Number(e.target.value));
                    reset();
                  }}
                >
                  {[...new Set([wasLength, ...LENGTHS])]
                    .sort((a, b) => a - b)
                    .map((m) => (
                      <option key={m} value={m}>
                        {fmtLength(m)}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
          ) : null}
          <dl className="mt-3.5 grid grid-cols-[48px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[13.5px]">
            <dt className="text-text-3">Was</dt>
            <dd className={timeChanged ? 'text-text-3 line-through' : ''}>
              {fmtWhen(appt.startsAt, appt.endsAt, timeZone)}
            </dd>
            {timeChanged ? (
              <>
                <dt className="text-text-3">Now</dt>
                <dd className="font-semibold" data-testid="move-now">
                  {fmtWhen(start, end, timeZone)}
                </dd>
              </>
            ) : null}
            {staffChanged ? (
              <>
                <dt className="text-text-3">With</dt>
                <dd>
                  <span className="text-text-3 line-through">
                    {namesText(staffNow.map((u) => firstName(nameOf(u))))}
                  </span>{' '}
                  <span className="font-semibold">
                    {namesText(nextStaff!.map((u) => firstName(nameOf(u))))}
                  </span>
                </dd>
              </>
            ) : null}
          </dl>
          <p className="mt-1.5 text-xs text-text-3">Times are {zoneLabel(timeZone)}.</p>
          {warnings?.length ? (
            <div className="mt-3 flex flex-col gap-2" data-testid="move-warnings">
              {warnings.map((w, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3 py-2.5 text-[13px] text-warning-text"
                >
                  <AlertTriangle className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
                  <span>{w.message}</span>
                </div>
              ))}
            </div>
          ) : null}
          {full ? (
            <div className="mt-3 flex flex-col gap-2" data-testid="move-full">
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-menu bg-danger-soft px-3 py-2.5 text-[13px] leading-[1.45] text-danger-text"
              >
                <CircleAlert className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
                <span>{full.message}</span>
              </div>
              {target.kind === 'pick' && full.times.length ? (
                <FreshTimes
                  times={full.times}
                  date={date}
                  timeZone={timeZone}
                  testId="move-fresh-time"
                  onPick={(t) => {
                    setDate(dateOf(t, timeZone));
                    setTime(minutesOf(t, timeZone));
                    reset();
                  }}
                />
              ) : null}
            </div>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2.5 rounded-menu bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text"
            >
              <CircleAlert className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
              <span>{error}</span>
            </div>
          ) : null}
          {tellText ? (
            <div className="mt-3">
              <Checkbox
                label={<span className="font-medium">{tellText}</span>}
                checked={tell}
                onChange={(e) => setTell(e.target.checked)}
                data-testid="move-tell"
              />
              <p className="ml-7 mt-0.5 text-xs text-text-3">
                {tell
                  ? `We let ${customers.length === 1 ? firstName(customers[0]!.fullName) : 'them'} know it moved to ${fmtAt(start, timeZone)}.`
                  : 'Nobody is told. Tell them yourself.'}
              </p>
            </div>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Don’t move
          </Button>
          <Button
            loading={busy}
            disabled={!timeChanged && !staffChanged}
            onClick={() => void move()}
            data-testid="move-confirm"
          >
            {warnings ? 'Move anyway' : 'Move'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
