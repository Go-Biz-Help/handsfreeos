import { isNotBookedYet, statusOf } from '@hfos/core';

import type { OutboxRow } from '@/changes/outbox';

import { personIdsIn, withOwnChanges, type ChangeNames } from '../outbox';
import type { PhoneAppointment, SeatRow } from '../use-calendar';

/**
 * The Calendar on the phone: a time asked for here standing in for HandsFreeOS's row until it answers, and the moves,
 * cancellations, statuses and confirmations made here showing at once on the rows they change.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SEAT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MIKE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CAL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CLIENT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const MARCO = {
  id: '22222222-2222-4222-8222-222222222222',
  fullName: 'Marco Villanueva',
  email: 'm@x.test',
};
const T0 = Date.parse('2026-09-22T13:50:00.000Z');

const names: ChangeNames = {
  person: (id) =>
    id === MIKE ? { name: 'Mike Johnson', address: '4120 Oak Hollow Dr, Houston, TX' } : null,
  calendar: (id) => (id === CAL ? { name: 'Service calls', color: '#2563eb' } : null),
};

let seq = 0;
function row(
  name: string,
  input: Record<string, unknown>,
  extra: Partial<OutboxRow> = {},
): OutboxRow {
  seq += 1;
  return {
    id: `change-${seq}`,
    command_id: `cmd-${seq}`,
    name,
    workspace_id: WS,
    input: JSON.stringify({ workspaceId: WS, ...input }),
    made_at: new Date(T0 + seq * 1000).toISOString(),
    depends_on: '[]',
    track: 'queue',
    state: 'waiting',
    reason: null,
    disposition: null,
    rule: null,
    answer: null,
    attempts: 0,
    revision: 0,
    confirmed_at: null,
    seq,
    queued_at: new Date(T0).toISOString(),
    settled_at: new Date(T0).toISOString(),
    sent_at: null,
    ...extra,
  };
}

const seat = (over: Partial<SeatRow> = {}): SeatRow =>
  ({
    id: SEAT,
    appointment_id: APPT,
    person_id: MIKE,
    status: 'booked',
    seats: 1,
    full_name: 'Mike Johnson',
    contact_phone_e164: '+17135550174',
    contact_email: null,
    phone_e164: '+17135550174',
    person_email: null,
    sms_ok: 1,
    sms_consent: 1,
    confirmed_at: null,
    confirmed_via: null,
    confirmed_by: null,
    confirmed_by_name: null,
    confirm_asked_at: null,
    cancelled_at: null,
    source: 'staff',
    address_line1: null,
    address_line2: null,
    city: null,
    state: null,
    postal_code: null,
    ...over,
  }) as SeatRow;

const appointment = (over: Partial<PhoneAppointment> = {}): PhoneAppointment =>
  ({
    id: APPT,
    title: 'AC repair',
    startsAt: '2026-09-22T14:00:00.000Z',
    endsAt: '2026-09-22T15:30:00.000Z',
    status: 'scheduled',
    source: 'staff',
    calendarName: 'Service calls',
    calendarColor: '#2563eb',
    customers: [{ id: MIKE, name: 'Mike Johnson' }],
    staff: [{ userId: MARCO.id, fullName: MARCO.fullName }],
    resources: [],
    address: '4120 Oak Hollow Dr, Houston, TX',
    capacity: 1,
    seatsTaken: 1,
    heldUntil: null,
    calendarId: CAL,
    serviceName: null,
    priceCents: null,
    notes: null,
    kind: 'booking',
    bufferBefore: 0,
    bufferAfter: 0,
    seats: [seat()],
    config: null,
    clientId: null,
    change: null,
    ...over,
  }) as PhoneAppointment;

const ask = (over: Record<string, unknown> = {}) =>
  row('appointment.create', {
    calendarId: CAL,
    startsAt: '2026-09-24T18:00:00.000Z',
    durationMinutes: 90,
    personId: MIKE,
    partySize: 1,
    title: 'AC repair · back to fit the part',
    userIds: [MARCO.id],
    clientId: CLIENT,
    notify: true,
    ...over,
  });

describe('a time asked for from this phone', () => {
  it('stands in for HandsFreeOS’s row, as "Not booked yet", with who it is for and where', () => {
    const [made, ...rest] = withOwnChanges([], [ask()], WS, MARCO, names);
    expect(rest).toEqual([]);
    expect(made).toMatchObject({
      id: CLIENT,
      title: 'AC repair · back to fit the part',
      startsAt: '2026-09-24T18:00:00.000Z',
      endsAt: '2026-09-24T19:30:00.000Z',
      requested: true,
      calendarName: 'Service calls',
      address: '4120 Oak Hollow Dr, Houston, TX',
    });
    expect(made!.customers).toEqual([{ id: MIKE, name: 'Mike Johnson' }]);
    expect(made!.staff).toEqual([{ userId: MARCO.id, fullName: MARCO.fullName }]);
    expect(isNotBookedYet(made!, T0)).toBe(true);
    expect(statusOf(made!, T0).label).toBe('Not booked yet');
    expect(made!.change).toMatchObject({ name: 'appointment.create', state: 'waiting' });
  });

  it('gives way the moment HandsFreeOS’s own row arrives under the same client id', () => {
    const booked = appointment({ id: 'real-id', clientId: CLIENT, requested: false });
    const all = withOwnChanges([booked], [ask()], WS, MARCO, names);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe('real-id');
    expect(all[0]!.requested).toBe(false);
    expect(statusOf(all[0]!, T0).label).not.toBe('Not booked yet');
  });

  it('stops standing in once the change has gone through, or been refused', () => {
    for (const state of ['sent', 'refused'] as const)
      expect(withOwnChanges([], [ask({}) && { ...ask(), state }], WS, MARCO, names)).toEqual([]);
  });

  it('is left out for another business’s changes', () => {
    expect(withOwnChanges([], [{ ...ask(), workspace_id: 'other' }], WS, MARCO, names)).toEqual([]);
  });

  it('names the people its waiting changes are for, so their names can be looked up', () => {
    expect(personIdsIn([ask(), ask(), row('appointment.cancel', { appointmentId: APPT })])).toEqual(
      [MIKE],
    );
  });
});

describe('a change to a visit already on the phone', () => {
  it('moves it, and says it isn’t confirmed at the new time yet', () => {
    const moved = withOwnChanges(
      [appointment()],
      [
        row('appointment.reschedule', {
          appointmentId: APPT,
          startsAt: '2026-09-23T16:00:00.000Z',
          durationMinutes: 60,
        }),
      ],
      WS,
      MARCO,
      names,
    )[0]!;
    expect(moved.startsAt).toBe('2026-09-23T16:00:00.000Z');
    expect(moved.endsAt).toBe('2026-09-23T17:00:00.000Z');
    expect(isNotBookedYet(moved, T0)).toBe(true);
  });

  it('calls it off, and marks it done or a no-show, at once', () => {
    const off = withOwnChanges(
      [appointment()],
      [row('appointment.cancel', { appointmentId: APPT, reason: '', notify: true })],
      WS,
      MARCO,
      names,
    )[0]!;
    expect(off.status).toBe('cancelled');
    expect(statusOf(off, T0)).toEqual({ label: 'Cancelled', tone: 'danger' });

    const done = withOwnChanges(
      [appointment()],
      [row('appointment.set_status', { appointmentId: APPT, status: 'completed' })],
      WS,
      MARCO,
      names,
    )[0]!;
    expect(done.status).toBe('completed');
  });

  it('marks a customer confirmed, in this person’s name, and takes it back', () => {
    const on = withOwnChanges(
      [appointment()],
      [row('attendee.confirm', { attendeeId: SEAT, confirmed: true })],
      WS,
      MARCO,
      names,
    )[0]!;
    expect(on.seats[0]).toMatchObject({
      confirmed_via: 'staff',
      confirmed_by: MARCO.id,
      confirmed_by_name: MARCO.fullName,
    });
    expect(on.seats[0]!.confirmed_at).toBeTruthy();

    const off = withOwnChanges(
      [
        appointment({
          seats: [seat({ confirmed_at: '2026-09-22T12:00:00Z', confirmed_via: 'staff' })],
        }),
      ],
      [row('attendee.confirm', { attendeeId: SEAT, confirmed: false })],
      WS,
      MARCO,
      names,
    )[0]!;
    expect(off.seats[0]!.confirmed_at).toBe(null);
  });

  it('leaves a visit alone when the change names another one', () => {
    const same = withOwnChanges(
      [appointment()],
      [row('appointment.cancel', { appointmentId: 'somebody-else', reason: '' })],
      WS,
      MARCO,
      names,
    )[0]!;
    expect(same.status).toBe('scheduled');
  });
});
