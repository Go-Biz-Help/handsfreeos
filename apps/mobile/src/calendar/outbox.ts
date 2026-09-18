import type { OutboxRow } from '@/changes/outbox';
import { inputOf, stillStanding } from '@/inbox/outbox';

import type { PhoneAppointment, SeatRow } from './use-calendar';

/**
 * The Calendar's changes on this phone, over the synced rows (the plan's "screens show outbox items over the synced
 * data").
 *
 * A time **asked for** here is the interesting one. `appointment.create` is a fresh-30-minutes change: it goes on its
 * own while it is fresh, and asks "Still send?" after — it is not refused for having no signal, and it is not sent
 * twice. But until HandsFreeOS answers, **nobody else's calendar has it**, so it is shown the way a time held for a
 * deposit is shown: "Not booked yet", with core's `REQUESTED_LINE` under it. Core's `isNotBookedYet` is the one rule
 * for both.
 *
 * A move, a cancellation, a status and a confirmation made here show at once on the row they change, and stop
 * standing in the moment HandsFreeOS's own row arrives (a sent change is dropped by `stillStanding`).
 */

/** What a queued change names, looked up in the copy so a row it stands for can say who and where. */
export interface ChangeNames {
  readonly person: (
    id: string,
  ) => { readonly name: string; readonly address: string | null } | null;
  readonly calendar: (id: string) => { readonly name: string; readonly color: string } | null;
}

/** A time asked for here carries the phone's own `clientId`; HandsFreeOS's row for it comes back under the same one. */

/** The person ids the appointment changes waiting on this phone name, so their names can be looked up. */
export function personIdsIn(rows: readonly OutboxRow[]): readonly string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.name !== 'appointment.create' || !stillStanding(row)) continue;
    const id = str(inputOf(row).personId);
    if (id) ids.add(id);
  }
  return [...ids];
}

export interface CalendarChange {
  /** The outbox row's id, so a screen can open Changes on this phone at it. */
  readonly id: string;
  readonly name: string;
  readonly state: OutboxRow['state'];
  readonly madeAt: string;
  readonly reason: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

const changeOf = (row: OutboxRow): CalendarChange => ({
  id: row.id,
  name: row.name,
  state: row.state,
  madeAt: row.made_at,
  reason: row.reason,
});

/** A time asked for here, as a row of the day, until HandsFreeOS confirms it. */
function requestedAppointment(
  row: OutboxRow,
  input: Record<string, unknown>,
  me: { readonly id: string; readonly fullName: string; readonly email: string },
  names: ChangeNames,
): PhoneAppointment | null {
  const id = str(input.clientId);
  const startsAt = str(input.startsAt);
  if (!id || !startsAt) return null;
  const minutes = num(input.durationMinutes) ?? 60;
  const staffIds = Array.isArray(input.userIds)
    ? (input.userIds as unknown[]).filter((u) => typeof u === 'string')
    : [];
  const seats: readonly SeatRow[] = [];
  const personId = str(input.personId);
  const person = personId ? names.person(personId) : null;
  const calendarId = str(input.calendarId);
  const calendar = calendarId ? names.calendar(calendarId) : null;
  return {
    id,
    title: str(input.title) ?? 'Appointment',
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(),
    status: 'scheduled',
    source: 'staff',
    calendarName: calendar?.name ?? '',
    calendarColor: calendar?.color ?? '#2563eb',
    customers: person && personId ? [{ id: personId, name: person.name }] : [],
    staff: (staffIds as string[]).map((userId) => ({
      userId,
      fullName: userId === me.id ? me.fullName || me.email : 'Someone',
    })),
    resources: [],
    address: locationAddress(input) ?? person?.address ?? null,
    capacity: 1,
    seatsTaken: num(input.partySize) ?? 1,
    heldUntil: null,
    requested: true,
    calendarId,
    serviceName: null,
    priceCents: null,
    notes: str(input.notes),
    kind: 'booking',
    bufferBefore: 0,
    bufferAfter: 0,
    seats,
    config: null,
    clientId: id,
    change: changeOf(row),
  };
}

function locationAddress(input: Record<string, unknown>): string | null {
  const where = input.location;
  if (where && typeof where === 'object') return str((where as { address?: unknown }).address);
  return null;
}

/**
 * The week's appointments as this phone's own changes leave them, in the order they were made: times asked for here
 * added, and moves, cancellations, statuses and confirmations applied to the rows they change.
 */
export function withOwnChanges(
  synced: readonly PhoneAppointment[],
  rows: readonly OutboxRow[],
  workspaceId: string,
  me: { readonly id: string; readonly fullName: string; readonly email: string },
  names: ChangeNames,
): readonly PhoneAppointment[] {
  const byId = new Map(synced.map((a) => [a.id, a]));
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (row.workspace_id !== workspaceId || !stillStanding(row)) continue;
    const input = inputOf(row);
    if (row.name === 'appointment.create') {
      // HandsFreeOS's own row has arrived under this change's client id: that one is the truth now.
      const clientId = str(input.clientId);
      const booked = clientId ? synced.find((a) => a.clientId === clientId) : null;
      if (booked) {
        byId.set(booked.id, { ...byId.get(booked.id)!, change: changeOf(row) });
        continue;
      }
      const made = requestedAppointment(row, input, me, names);
      if (made) byId.set(made.id, made);
      continue;
    }
    const id = str(input.appointmentId);
    const on = id ? byId.get(id) : null;
    if (id && on) {
      if (row.name === 'appointment.reschedule') {
        const startsAt = str(input.startsAt) ?? on.startsAt;
        const minutes =
          num(input.durationMinutes) ??
          Math.round((Date.parse(on.endsAt) - Date.parse(on.startsAt)) / 60_000);
        byId.set(id, {
          ...on,
          startsAt,
          endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(),
          requested: true,
          change: changeOf(row),
        });
      } else if (row.name === 'appointment.cancel') {
        byId.set(id, { ...on, status: 'cancelled', change: changeOf(row) });
      } else if (row.name === 'appointment.set_status') {
        const status = str(input.status);
        if (status === 'completed' || status === 'no_show')
          byId.set(id, { ...on, status, change: changeOf(row) });
      }
      continue;
    }
    if (row.name === 'attendee.confirm') {
      const attendeeId = str(input.attendeeId);
      if (!attendeeId) continue;
      for (const [key, appt] of byId) {
        if (!appt.seats.some((s) => s.id === attendeeId)) continue;
        byId.set(key, {
          ...appt,
          seats: appt.seats.map((s) =>
            s.id === attendeeId
              ? {
                  ...s,
                  confirmed_at: input.confirmed === false ? null : row.made_at,
                  confirmed_via: input.confirmed === false ? null : 'staff',
                  confirmed_by: input.confirmed === false ? null : me.id,
                  confirmed_by_name: input.confirmed === false ? null : me.fullName || me.email,
                }
              : s,
          ),
          change: changeOf(row),
        });
        break;
      }
    }
  }
  return [...byId.values()];
}
