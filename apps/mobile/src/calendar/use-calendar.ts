import {
  addDays,
  agendaRows,
  appointmentCount,
  appointmentsOnDay,
  daysWithAppointments,
  DEPOSIT_HOLD_MS,
  localDayOf,
  localInstant,
  NOTHING_BOOKED,
  parseConfig,
  weekOf,
  type AgendaAppointment,
  type AgendaInput,
  type AgendaRow,
  type BusyBlock,
  type CalendarConfig,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import type { OutboxRow } from '@/changes/outbox';
import { personSearchText } from '@/sync/compute';
import type { PeopleRow } from '@/sync/schema';
import { SENT_SHOWN_MS } from '@/changes/rules';
import { useBusiness } from '@/components/shell/business-context';

import { personIdsIn, withOwnChanges, type CalendarChange, type ChangeNames } from './outbox';
import {
  APPOINTMENT_SEATS_ONE_SQL,
  APPOINTMENT_SEATS_SQL,
  APPOINTMENT_SQL,
  APPOINTMENT_STAFF_ONE_SQL,
  APPOINTMENT_STAFF_SQL,
  APPOINTMENTS_SQL,
  BOOKING_DEPOSITS_SQL,
  BUSY_SQL,
  CALENDAR_MEMBERS_SQL,
  CALENDAR_SERVICES_SQL,
  CALENDAR_OUTBOX_SQL,
  CALENDARS_SQL,
  PEOPLE_SQL,
  peopleByIdSql,
  VISIT_INVOICES_SQL,
  WORKSPACE_SQL,
  JOB_OUTBOX_SQL,
  VISIT_JOB_SQL,
} from './queries';

/**
 * The Calendar from the phone's copy: the days around the chosen one, every appointment on them with who it is for,
 * who is going and where, with this phone's own changes over the synced rows — the same day the web's agenda shows
 * for the same person at the same moment (core's `agendaRows`).
 *
 * The whole stretch is read at once, as the web's `/calendar` page does, so moving between days never waits: a week
 * for the day and week views, and the month view's six of them.
 */

export interface SeatRow {
  readonly id: string;
  readonly appointment_id: string;
  readonly person_id: string | null;
  readonly status: string;
  readonly seats: number | null;
  readonly full_name: string;
  readonly contact_phone_e164: string | null;
  readonly contact_email: string | null;
  readonly phone_e164: string | null;
  readonly person_email: string | null;
  readonly sms_ok: number | null;
  readonly sms_consent: number | null;
  readonly confirmed_at: string | null;
  readonly confirmed_via: string | null;
  readonly confirmed_by: string | null;
  readonly confirmed_by_name: string | null;
  readonly confirm_asked_at: string | null;
  readonly cancelled_at: string | null;
  readonly source: string | null;
  readonly address_line1: string | null;
  readonly address_line2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postal_code: string | null;
}

export interface StaffRow {
  readonly appointment_id: string;
  readonly user_id: string;
  readonly role: string | null;
  readonly full_name: string | null;
}

interface ApptRow {
  readonly id: string;
  readonly title: string | null;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly status: string | null;
  readonly source: string | null;
  readonly kind: string | null;
  readonly notes: string | null;
  readonly location: string | null;
  readonly capacity: number | null;
  readonly seats_taken: number | null;
  readonly buffer_before: number | null;
  readonly buffer_after: number | null;
  readonly calendar_id: string | null;
  readonly calendar_name: string | null;
  readonly calendar_color: string | null;
  readonly calendar_config: string | null;
  readonly service_id: string | null;
  readonly service_name: string | null;
  readonly service_price_cents: number | null;
  readonly lead_id: string | null;
  readonly client_id: string | null;
  /** A private record's appointment (round six): the record's name and kind, from records_v1. */
  readonly record_name?: string | null;
  readonly record_kind?: string | null;
}

/** An appointment as the phone's screens read it: core's shape, plus what only this app needs. */
export interface PhoneAppointment extends AgendaAppointment {
  readonly calendarId: string | null;
  readonly serviceName: string | null;
  readonly priceCents: number | null;
  readonly notes: string | null;
  readonly kind: string | null;
  readonly bufferBefore: number;
  /** Where it happens, as stored (JSON): an online one carries its video link (`meetingOf`). */
  readonly location?: string | null;
  readonly bufferAfter: number;
  readonly seats: readonly SeatRow[];
  readonly config: CalendarConfig | null;
  /** The id the phone that booked it gave the change, when one did (`appointment.create`'s `clientId`). */
  readonly clientId: string | null;
  /** The change on this phone this row came from, when it hasn't reached HandsFreeOS yet. */
  readonly change: CalendarChange | null;
}

/** The address a visit happens at, from `appointments.location` as the commands store it. */
export function addressOf(location: string | null): { address: string | null; kind: string } {
  if (!location) return { address: null, kind: 'customer_address' };
  try {
    const parsed = JSON.parse(location) as { kind?: string; address?: string | null };
    return { address: parsed.address ?? null, kind: parsed.kind ?? 'customer_address' };
  } catch {
    return { address: null, kind: 'customer_address' };
  }
}

const seatAddress = (s: SeatRow): string | null => {
  const parts = [
    s.address_line1,
    s.address_line2,
    s.city,
    [s.state, s.postal_code].filter(Boolean).join(' '),
  ]
    .map((p) => (p ?? '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
};

/** Now, moved on every 30 seconds, so the red line and "Happening now" keep up without re-reading the copy. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** The business's time zone, as the calendar always reads times in it. */
export function useCalendarZone(): string {
  const { business } = useBusiness();
  const { data } = useQuery<{ timezone: string | null }>(WORKSPACE_SQL, [business.id]);
  return data[0]?.timezone || business.timezone;
}

/** The Calendar's own changes on this phone, not through or sent just now. */
export function useCalendarOutbox(): readonly OutboxRow[] {
  const { business } = useBusiness();
  const since = React.useMemo(() => new Date(Date.now() - SENT_SHOWN_MS).toISOString(), []);
  const { data } = useQuery<OutboxRow>(CALENDAR_OUTBOX_SQL, [business.id, since]);
  return data;
}

/**
 * The names a queued change needs: the calendars the business has, and the people its pending bookings name. Both
 * come from the copy, so a time asked for with no signal still says whose visit it is and where.
 */
export function useChangeNames(outbox: readonly OutboxRow[]): ChangeNames {
  const { business } = useBusiness();
  const calendars = useCalendars();
  const ids = React.useMemo(() => personIdsIn(outbox), [outbox]);
  const { data } = useQuery<{
    id: string;
    full_name: string;
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
  }>(peopleByIdSql(Math.max(ids.length, 1)), [business.id, ...(ids.length ? ids : [''])]);
  return React.useMemo(() => {
    const people = new Map(
      data.map((p) => [
        p.id,
        {
          name: p.full_name,
          address:
            [
              p.address_line1,
              p.address_line2,
              p.city,
              [p.state, p.postal_code].filter(Boolean).join(' '),
            ]
              .map((x) => (x ?? '').trim())
              .filter(Boolean)
              .join(', ') || null,
        },
      ]),
    );
    const cals = new Map(calendars.map((c) => [c.id, { name: c.name, color: c.color }]));
    return { person: (id) => people.get(id) ?? null, calendar: (id) => cals.get(id) ?? null };
  }, [data, calendars]);
}

export interface CalendarRange {
  /** The days it covers: the strip's week, or the month view's six of them. */
  readonly days: readonly string[];
  readonly appointments: readonly PhoneAppointment[];
  readonly busy: readonly BusyBlock[];
  readonly loading: boolean;
}

/**
 * Everything `days` holds — the week behind the strip, or the six weeks of a month. One read for the appointments
 * and one each for who is going, who it is for and the deposits still being paid: the copy is on the phone, so four
 * small queries beat one that SQLite would have to flatten.
 *
 * The copy keeps appointments from 90 days back (the sync window), so stepping the month view further back than that
 * shows the days but not what was on them.
 */
export function useCalendarRange(days: readonly string[], timeZone: string): CalendarRange {
  const { business, me } = useBusiness();
  const [from, to] = React.useMemo(
    () => [
      new Date(localInstant(days[0]!, '00:00', timeZone)).toISOString(),
      new Date(localInstant(addDays(days[days.length - 1]!, 1), '00:00', timeZone)).toISOString(),
    ],
    [days, timeZone],
  );
  const appts = useQuery<ApptRow>(APPOINTMENTS_SQL, [business.id, from, to]);
  const staff = useQuery<StaffRow>(APPOINTMENT_STAFF_SQL, [business.id, from, to]);
  const seats = useQuery<SeatRow>(APPOINTMENT_SEATS_SQL, [business.id, from, to]);
  const deposits = useQuery<{ attendee_id: string; created_at: string }>(BOOKING_DEPOSITS_SQL, [
    business.id,
    from,
    to,
  ]);
  const busy = useQuery<{ starts_at: string; ends_at: string }>(BUSY_SQL, [
    business.id,
    me.user.id,
    from,
    to,
  ]);
  const outbox = useCalendarOutbox();
  const names = useChangeNames(outbox);

  return React.useMemo(() => {
    const byAppointment = group(staff.data, (s) => s.appointment_id);
    const bySeat = group(seats.data, (s) => s.appointment_id);
    // A seat's deposit still being paid holds its whole appointment: the soonest one wins, as the server's does.
    const held = new Map<string, string>();
    for (const d of deposits.data) {
      const seat = seats.data.find((s) => s.id === d.attendee_id);
      if (!seat) continue;
      const until = new Date(Date.parse(d.created_at) + DEPOSIT_HOLD_MS).toISOString();
      const there = held.get(seat.appointment_id);
      if (!there || until < there) held.set(seat.appointment_id, until);
    }
    const synced = appts.data.map((row) =>
      appointmentOf(
        row,
        byAppointment.get(row.id) ?? [],
        bySeat.get(row.id) ?? [],
        held.get(row.id) ?? null,
      ),
    );
    return {
      days,
      appointments: withOwnChanges(synced, outbox, business.id, me.user, names),
      busy: busy.data.map((b) => ({ startsAt: b.starts_at, endsAt: b.ends_at, provider: null })),
      loading: appts.isLoading,
    };
  }, [
    appts.data,
    appts.isLoading,
    staff.data,
    seats.data,
    deposits.data,
    busy.data,
    outbox,
    names,
    days,
    business.id,
    me.user,
    timeZone,
  ]);
}

function group<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** One synced row, plus its staff, its seats and any hold, as core's shape. */
export function appointmentOf(
  row: ApptRow,
  staff: readonly StaffRow[],
  seats: readonly SeatRow[],
  heldUntil: string | null,
): PhoneAppointment {
  const booked = seats.filter((s) => s.status !== 'cancelled');
  const where = addressOf(row.location);
  return {
    id: row.id,
    title: row.title ?? row.service_name ?? row.calendar_name ?? 'Appointment',
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: (row.status ?? 'scheduled') as AgendaAppointment['status'],
    source: row.source ?? 'staff',
    calendarName: row.calendar_name ?? '',
    calendarColor: row.calendar_color ?? '#2563eb',
    customers: booked.map((s) => ({ id: s.person_id ?? s.id, name: s.full_name })),
    staff: staff.map((s) => ({ userId: s.user_id, fullName: s.full_name ?? 'Someone' })),
    // The phone's copy has no appointment_resources, so a visit shows no equipment chip.
    resources: [],
    address: where.address ?? (booked[0] ? seatAddress(booked[0]) : null),
    capacity: row.capacity ?? 1,
    seatsTaken: row.seats_taken ?? booked.length,
    heldUntil,
    calendarId: row.calendar_id,
    serviceName: row.service_name,
    priceCents: row.service_price_cents,
    notes: row.notes,
    kind: row.kind,
    bufferBefore: row.buffer_before ?? 0,
    location: row.location,
    bufferAfter: row.buffer_after ?? 0,
    seats,
    config: row.calendar_config ? safeConfig(row.calendar_config) : null,
    clientId: row.client_id,
    change: null,
    privateTo: row.record_name
      ? { name: row.record_name, kind: row.record_kind ?? 'record' }
      : null,
  };
}

function safeConfig(raw: string): CalendarConfig | null {
  try {
    return parseConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface AgendaDay {
  readonly rows: readonly AgendaRow[];
  readonly onDay: readonly PhoneAppointment[];
  readonly marked: ReadonlySet<string>;
}

/** The chosen day as a list, and which days of the strip have anything on them. */
export function useAgendaDay(
  range: CalendarRange,
  date: string,
  today: string,
  timeZone: string,
  mine: boolean,
  now: number,
): AgendaDay {
  const { me } = useBusiness();
  return React.useMemo(() => {
    const input: AgendaInput = {
      date,
      today,
      timeZone,
      appointments: range.appointments,
      busy: range.busy,
      mine,
      myUserId: me.user.id,
      now,
    };
    return {
      rows: agendaRows(input),
      onDay: appointmentsOnDay(input) as readonly PhoneAppointment[],
      marked: daysWithAppointments(input),
    };
  }, [range.appointments, range.busy, date, today, timeZone, mine, me.user.id, now]);
}

/** A day's heading in the week list: the day it names, and what is on it in words. */
export interface WeekHeading {
  readonly kind: 'day';
  readonly date: string;
  /** "2 appointments", or "Nothing booked" where there are none. */
  readonly countWords: string;
}

/** The week as one list: each day's heading, then that day's rows, so one scroll covers all seven. */
export type WeekRow = WeekHeading | AgendaRow;

export function useAgendaWeek(
  range: CalendarRange,
  date: string,
  today: string,
  timeZone: string,
  mine: boolean,
  now: number,
): readonly WeekRow[] {
  const { me } = useBusiness();
  return React.useMemo(() => {
    const out: WeekRow[] = [];
    // The week around the date, whatever the range holds: a month's range would otherwise make this six of them.
    for (const day of weekOf(date)) {
      const input: AgendaInput = {
        date: day,
        today,
        timeZone,
        appointments: range.appointments,
        busy: range.busy,
        mine,
        myUserId: me.user.id,
        now,
      };
      const count = appointmentsOnDay(input).length;
      out.push({ kind: 'day', date: day, countWords: appointmentCount(count) || NOTHING_BOOKED });
      out.push(...agendaRows(input));
    }
    return out;
  }, [range.appointments, range.busy, date, today, timeZone, mine, me.user.id, now]);
}

/** One day of the month grid: what is booked on it, and whether any of this person's busy time lands there. */
export interface MonthDay {
  readonly date: string;
  readonly today: boolean;
  /** False for the days of the neighbouring months that fill out the first and last weeks. */
  readonly inMonth: boolean;
  readonly appointments: readonly PhoneAppointment[];
  readonly busy: boolean;
}

/**
 * The month as six whole weeks. A cell says how full its day is rather than when things are on it, so it is the
 * day's appointments in time order and a mark for busy time — the same Everyone or Just me the day list follows,
 * and busy time only on Just me, because it is one person's own calendar.
 */
export function useAgendaMonth(
  range: CalendarRange,
  date: string,
  today: string,
  timeZone: string,
  mine: boolean,
  now: number,
): readonly MonthDay[] {
  const { me } = useBusiness();
  return React.useMemo(
    () =>
      range.days.map((day) => ({
        date: day,
        today: day === today,
        inMonth: day.slice(0, 7) === date.slice(0, 7),
        appointments: appointmentsOnDay({
          date: day,
          today,
          timeZone,
          appointments: range.appointments,
          busy: range.busy,
          mine,
          myUserId: me.user.id,
          now,
        }) as readonly PhoneAppointment[],
        busy: mine && range.busy.some((b) => localDayOf(b.startsAt, timeZone) === day),
      })),
    [range.days, range.appointments, range.busy, date, today, timeZone, mine, me.user.id, now],
  );
}

/** One appointment and everything its screen shows, from the copy plus this phone's own changes. */
export function useAppointment(appointmentId: string): {
  readonly appointment: PhoneAppointment | null;
  readonly loading: boolean;
} {
  const { business, me } = useBusiness();
  const appts = useQuery<ApptRow>(APPOINTMENT_SQL, [business.id, appointmentId]);
  const staff = useQuery<StaffRow>(APPOINTMENT_STAFF_ONE_SQL, [business.id, appointmentId]);
  const seats = useQuery<SeatRow>(APPOINTMENT_SEATS_ONE_SQL, [business.id, appointmentId]);
  const outbox = useCalendarOutbox();
  const names = useChangeNames(outbox);
  return React.useMemo(() => {
    const row = appts.data[0];
    const synced = row ? [appointmentOf(row, staff.data, seats.data, null)] : [];
    const all = withOwnChanges(synced, outbox, business.id, me.user, names);
    return {
      appointment: all.find((a) => a.id === appointmentId) ?? null,
      loading: appts.isLoading,
    };
  }, [
    appts.data,
    appts.isLoading,
    staff.data,
    seats.data,
    outbox,
    names,
    appointmentId,
    business.id,
    me.user,
  ]);
}

export interface VisitInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly status: string;
  readonly origin: string;
  readonly purpose: string;
  readonly title: string | null;
  readonly total_cents: number | null;
  readonly amount_paid_cents: number | null;
  readonly amount_refunded_cents: number | null;
  readonly due_on: string | null;
  readonly paid_at: string | null;
  readonly voided_at: string | null;
  readonly first_viewed_at: string | null;
  readonly attendee_id: string | null;
}

/** The money on one visit: whatever of it this person may see (the copy holds nothing else). */
export function useVisitInvoices(appointmentId: string): readonly VisitInvoice[] {
  const { business } = useBusiness();
  const { data } = useQuery<VisitInvoice>(VISIT_INVOICES_SQL, [business.id, appointmentId]);
  return data;
}

export interface CalendarChoice {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly config: CalendarConfig | null;
  readonly revision: number;
}

/** The business's active calendars, for asking for a time. */
export function useCalendars(): readonly CalendarChoice[] {
  const { business } = useBusiness();
  const { data } = useQuery<{
    id: string;
    name: string | null;
    color: string | null;
    config: string | null;
    revision: number | null;
  }>(CALENDARS_SQL, [business.id]);
  return React.useMemo(
    () =>
      data.map((c) => ({
        id: c.id,
        name: c.name ?? 'Calendar',
        color: c.color ?? '#2563eb',
        config: c.config ? safeConfig(c.config) : null,
        revision: c.revision ?? 1,
      })),
    [data],
  );
}

export interface CalendarPerson {
  readonly calendarId: string;
  readonly userId: string;
  readonly fullName: string;
}

export function useCalendarMembers(): readonly CalendarPerson[] {
  const { business } = useBusiness();
  const { data } = useQuery<{ calendar_id: string; user_id: string; full_name: string | null }>(
    CALENDAR_MEMBERS_SQL,
    [business.id],
  );
  return React.useMemo(
    () =>
      data.map((m) => ({
        calendarId: m.calendar_id,
        userId: m.user_id,
        fullName: m.full_name ?? 'Someone',
      })),
    [data],
  );
}

export interface CustomerChoice {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  /** What a search is matched against, the way the database's own `search_text` is built. */
  readonly searchText: string;
}

/** The business's customers, for asking for a time for one of them. */
export function useCustomers(): readonly CustomerChoice[] {
  const { business } = useBusiness();
  const { data } = useQuery<
    Pick<
      PeopleRow,
      | 'id'
      | 'first_name'
      | 'last_name'
      | 'email'
      | 'phone_e164'
      | 'city'
      | 'address_line1'
      | 'address_line2'
      | 'state'
      | 'postal_code'
      | 'other_emails'
      | 'other_phones'
      | 'other_addresses'
    >
  >(PEOPLE_SQL, [business.id]);
  return React.useMemo(
    () =>
      data.map((p) => ({
        id: p.id,
        name:
          [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || (p.email ?? 'Customer'),
        address:
          [
            p.address_line1,
            p.address_line2,
            p.city,
            [p.state, p.postal_code].filter(Boolean).join(' '),
          ]
            .map((x) => (x ?? '').trim())
            .filter(Boolean)
            .join(', ') || null,
        searchText: personSearchText(p),
      })),
    [data],
  );
}

export interface CalendarService {
  readonly calendarId: string;
  readonly serviceId: string;
  readonly name: string;
  readonly defaultDuration: number;
  readonly priceCents: number | null;
}

export function useCalendarServices(): readonly CalendarService[] {
  const { business } = useBusiness();
  const { data } = useQuery<{
    calendar_id: string;
    service_id: string;
    name: string | null;
    default_duration: number | null;
    price_cents: number | null;
  }>(CALENDAR_SERVICES_SQL, [business.id]);
  return React.useMemo(
    () =>
      data.map((s) => ({
        calendarId: s.calendar_id,
        serviceId: s.service_id,
        name: s.name ?? 'Service',
        defaultDuration: s.default_duration ?? 60,
        priceCents: s.price_cents,
      })),
    [data],
  );
}

export interface VisitJob {
  readonly id: string | null;
  readonly title: string | null;
  readonly status: string;
  readonly customerNote: string | null;
  readonly etaAt: string | null;
  /** A change tapped here that hasn't reached HandsFreeOS yet. */
  readonly pending: boolean;
}

/**
 * M18: the job a visit is part of, as the phone's copy has it, with a status tapped here and still waiting for
 * signal shown straight away. Null for a job that's done (done jobs leave the phone) and no change waiting.
 */
export function useVisitJob(appointmentId: string): VisitJob | null {
  const { business } = useBusiness();
  const { data } = useQuery<{
    id: string;
    title: string | null;
    status: string | null;
    customer_note: string | null;
    eta_at: string | null;
  }>(VISIT_JOB_SQL, [business.id, appointmentId]);
  const { data: waiting } = useQuery<OutboxRow>(JOB_OUTBOX_SQL, [business.id]);
  return React.useMemo(() => {
    const row = data[0];
    const mine = waiting
      .map((w) => {
        try {
          return JSON.parse(w.input) as { appointmentId?: string; status?: string };
        } catch {
          return {};
        }
      })
      .filter((i) => i.appointmentId === appointmentId && typeof i.status === 'string');
    const tapped = mine.at(-1)?.status ?? null;
    if (!row && !tapped) return null;
    return {
      id: row?.id ?? null,
      title: row?.title ?? null,
      status: tapped ?? row?.status ?? 'scheduled',
      customerNote: row?.customer_note ?? null,
      etaAt: row?.eta_at ?? null,
      pending: !!tapped,
    };
  }, [data, waiting, appointmentId]);
}
