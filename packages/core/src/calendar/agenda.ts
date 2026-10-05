/**
 * The calendar as a person reads it: a day and a week as a list, and one appointment's lines — what it is, who it is
 * for, where, who is going, what state it is in, and whether it is booked at all.
 *
 * Shared by the web's agenda (`components/calendar/agenda.tsx`, `appt.ts` and `upcoming-card.tsx`) and the phone's
 * Calendar tab, so the same moment reads the same on both. Pure and browser-safe: it takes plain values, never an
 * API type or a database row, and each side maps its own rows into `AgendaAppointment`.
 *
 * **Two ways an appointment can be "Not booked yet"**, and they say almost the same thing on purpose:
 * - a **held** time, waiting on the deposit that books it (Milestone 5) — it gives itself back if nobody pays;
 * - a time **asked for from a phone with no signal** (Milestone 10) — nobody else's calendar has it yet, so somebody
 *   could take it first.
 *
 * Either way nobody has told the customer the time is theirs, so no one should ring to confirm it.
 */
import { firstName } from '../inbox/list';
import {
  fmtDateLong,
  fmtDateShort,
  fmtLength,
  fmtRange,
  fmtTime,
  localDayOf,
  minutesBetween,
} from './when';

export { firstName };

// ---- What an appointment looks like, whoever is reading it ----

export type AppointmentStatus = 'scheduled' | 'cancelled' | 'completed' | 'no_show';

/** Where a booking came from (`app.appointment_source`). */
export type AppointmentSource =
  'staff' | 'booking_page' | 'ai_teammate' | 'api' | 'import' | 'workflow';

export interface AgendaPerson {
  readonly id: string;
  readonly name: string;
}

export interface AgendaStaff {
  readonly userId: string;
  readonly fullName: string;
}

export interface AgendaAppointment {
  readonly id: string;
  readonly title: string;
  /** ISO instants. */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: AppointmentStatus;
  readonly source: AppointmentSource | string;
  readonly calendarName: string;
  readonly calendarColor: string;
  /** The customers still on it (cancelled seats are already out). */
  readonly customers: readonly AgendaPerson[];
  readonly staff: readonly AgendaStaff[];
  readonly resources: readonly { readonly name: string; readonly quantity?: number }[];
  readonly address: string | null;
  readonly capacity: number;
  readonly seatsTaken: number;
  /** A time held while the customer pays the deposit that books it; null when it isn't one. */
  readonly heldUntil?: string | null;
  /**
   * A time this phone asked for that HandsFreeOS hasn't confirmed yet (M10): it is on this phone alone, so it is
   * shown like a held time rather than as a booking.
   */
  readonly requested?: boolean;
  /**
   * The private record it belongs to (a deal's showing, round six): only that record's people have it, everyone else
   * sees busy. Its name and what kind of record it is ("deal").
   */
  readonly privateTo?: { readonly name: string; readonly kind: string } | null;
}

/** "Alvarez listing · private to the deal": under a private record's appointment, for its people. */
export const privateToLine = (p: { readonly name: string; readonly kind: string }): string =>
  `${p.name} · private to the ${p.kind.toLowerCase()}`;

/** The seats still on an appointment: everyone who hasn't cancelled off it. */
export const bookedSeatsOf = <T extends { readonly status: string }>(
  attendees: readonly T[],
): readonly T[] => attendees.filter((x) => x.status !== 'cancelled');

/** What a booking reserves, in words: "1 Red light bed", "2 × Truck". */
export const reservedText = (quantity: number, name: string): string =>
  quantity === 1 ? `1 ${name}` : `${quantity} × ${name}`;

/** "Priya and Marco", "Priya, Marco and Dale". */
export function namesText(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The neighbourhood part of an address: "5107 Evergreen St, Bellaire, TX 77401" → "Bellaire". */
export function areaOf(address: string | null | undefined): string | null {
  const parts = (address ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2]!;
  return parts[parts.length - 1] ?? null;
}

// ---- A time nobody has been promised ----

/**
 * A time only **held** while a customer pays the deposit that books it.
 *
 * It is a real appointment on a real slot, so it looks like a booking to anyone reading the calendar — but nobody
 * has told the customer it is theirs, and if the deposit doesn't land it gives itself back within fifteen minutes.
 * So every screen that shows one has to say so, or somebody rings to confirm a visit that isn't booked, or works
 * around a slot that is about to free itself.
 */
export interface Hold {
  /** When the hold runs out, as an instant. */
  readonly until: number;
  /** Whole minutes left, never below zero. */
  readonly minutesLeft: number;
  /** It ran out and the time hasn't been given back yet: treat it as gone, not as booked. */
  readonly over: boolean;
}

export function holdOf(
  a: { readonly status: string; readonly heldUntil?: string | null },
  now: number | null,
): Hold | null {
  // Only a live booking can be held: once it is cancelled or done, the hold is history.
  if (!a.heldUntil || a.status !== 'scheduled') return null;
  const until = Date.parse(a.heldUntil);
  if (Number.isNaN(until)) return null;
  const left = until - (now ?? Date.now());
  return { until, minutesLeft: Math.max(0, Math.ceil(left / 60_000)), over: left <= 0 };
}

/**
 * What a held time is, in words anybody can act on: it isn't booked, it's waiting on money, and here is when it
 * goes. Deliberately never says "hold" on its own — nobody has to know what one is.
 */
export function holdWords(h: Hold, timeZone: string): string {
  if (h.over) return 'Waiting on a deposit. The time is up, so this slot is going back.';
  const left =
    h.minutesLeft <= 1 ? 'under a minute left' : `${h.minutesLeft} minutes left to pay it`;
  return `Waiting on a deposit. Held until ${fmtTime(h.until, timeZone)} · ${left}.`;
}

/** The badge both kinds of unbooked time wear. */
export const NOT_BOOKED_YET = 'Not booked yet';

/** The same, where there is room for the reason: the web's time grid puts it on a block 40 minutes or taller. */
export const HELD_CHIP_LONG = 'Not booked · waiting on a deposit';

/** Under a time asked for from a phone that had no signal, on the day's list (M10's canvas). */
export const REQUESTED_LINE = `${NOT_BOOKED_YET} · We’ll confirm this time when you’re back online`;

/** And the sentence that explains it, once, where there is room for one. */
export const REQUESTED_NOTE =
  'A time asked for with no signal isn’t on anyone else’s calendar yet, so someone could book it first. If that ' +
  'happens, this says so and asks you to pick another time.';

/** Whether this appointment is a time nobody has been promised — held for a deposit, or asked for and unconfirmed. */
export function isNotBookedYet(a: AgendaAppointment, now: number | null): boolean {
  return a.requested === true || holdOf(a, now) !== null;
}

// ---- The badge at the top of a row or a sheet ----

/** How a status reads, and how loudly. The tones are the kit's badge variants on both apps. */
export type StatusTone = 'accent' | 'ok' | 'gray' | 'danger' | 'pending';

export interface StatusWord {
  readonly label: string;
  readonly tone: StatusTone;
}

export function statusOf(a: AgendaAppointment, now: number | null): StatusWord {
  if (a.status === 'cancelled') return { label: 'Cancelled', tone: 'danger' };
  if (a.status === 'completed') return { label: 'Completed', tone: 'ok' };
  if (a.status === 'no_show') return { label: 'No-show', tone: 'gray' };
  // Ahead of "Happening now": a time nobody has paid for isn't happening, whatever the clock says.
  if (isNotBookedYet(a, now)) return { label: NOT_BOOKED_YET, tone: 'pending' };
  if (now !== null && Date.parse(a.startsAt) <= now && Date.parse(a.endsAt) > now)
    return { label: 'Happening now', tone: 'pending' };
  return { label: 'Scheduled', tone: 'accent' };
}

export const isPast = (a: { readonly endsAt: string }, now: number | null) =>
  now !== null && Date.parse(a.endsAt) <= now;

// ---- One row of the day ----

/** A small mark beside a row: what was reserved, how many seats, and where the booking came from. */
export type ChipKind = 'resource' | 'seats' | 'source';

export interface AgendaChip {
  readonly kind: ChipKind;
  readonly label: string;
}

/** "Booked online", "Booked by AI", or nothing for a booking someone here made. */
export function sourceLabel(source: string): string | null {
  if (source === 'ai_teammate') return 'Booked by AI';
  if (source === 'booking_page') return 'Booked online';
  return null;
}

/** "3/8 seats". */
export const seatsLabel = (seatsTaken: number, capacity: number): string =>
  `${seatsTaken}/${capacity} seats`;

export function appointmentChips(a: AgendaAppointment): readonly AgendaChip[] {
  const chips: AgendaChip[] = a.resources.map((r) => ({
    kind: 'resource',
    label: r.quantity && r.quantity !== 1 ? reservedText(r.quantity, r.name) : r.name,
  }));
  if (a.capacity > 1) chips.push({ kind: 'seats', label: seatsLabel(a.seatsTaken, a.capacity) });
  const source = sourceLabel(a.source);
  if (source) chips.push({ kind: 'source', label: source });
  return chips;
}

/**
 * The line under an appointment's title on the day: who it is for and roughly where — "Mike Johnson · Oak Hollow Dr",
 * "3 customers · Bellaire". With nobody on it, the calendar's own name, unless that is already the title.
 */
export function subtitleOf(a: AgendaAppointment): string {
  const who =
    a.customers.length === 1
      ? a.customers[0]!.name
      : a.customers.length
        ? `${a.customers.length} customers`
        : null;
  const line = [who, areaOf(a.address)].filter(Boolean).join(' · ');
  return line || (a.calendarName !== a.title ? a.calendarName : '');
}

/** The staff line where there are no faces to show: "Priya and Marco". */
export const staffLine = (a: AgendaAppointment): string =>
  namesText(a.staff.map((s) => firstName(s.fullName)));

/** "8:00 AM" and "1 h 30 min", the two halves of a row's time column. */
export interface RowTime {
  readonly at: string;
  readonly length: string;
}

export function rowTimeOf(a: AgendaAppointment, timeZone: string): RowTime {
  return {
    at: fmtTime(a.startsAt, timeZone),
    length: fmtLength(minutesBetween(a.startsAt, a.endsAt)),
  };
}

// ---- The day itself ----

/** Busy time from somebody's own Google or Outlook calendar, which blocks bookings but says nothing about what. */
export interface BusyBlock {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly provider: 'google' | 'microsoft' | null;
}

export const BUSY_TITLE = 'Busy';

/** "From Google Calendar", "From Outlook", "From your calendar". */
export function busyFrom(provider: 'google' | 'microsoft' | null): string {
  if (provider === 'google') return 'From Google Calendar';
  if (provider === 'microsoft') return 'From Outlook';
  return 'From your calendar';
}

export type AgendaRow =
  | { readonly kind: 'appt'; readonly at: number; readonly appt: AgendaAppointment }
  | { readonly kind: 'busy'; readonly at: number; readonly end: number; readonly busy: BusyBlock }
  | { readonly kind: 'now'; readonly at: number };

export interface AgendaInput {
  readonly date: string;
  readonly today: string;
  readonly timeZone: string;
  readonly appointments: readonly AgendaAppointment[];
  /** Only shown for Just me, as on the web: it is one person's own calendar. */
  readonly busy?: readonly BusyBlock[];
  readonly mine: boolean;
  readonly myUserId: string | null;
  readonly now: number | null;
}

/** The appointments on the chosen day, in time order, after Everyone or Just me. */
export function appointmentsOnDay(i: AgendaInput): readonly AgendaAppointment[] {
  return i.appointments
    .filter((a) => !i.mine || a.staff.some((s) => s.userId === i.myUserId))
    .filter((a) => localDayOf(a.startsAt, i.timeZone) === i.date)
    .slice()
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** The days of the week strip that have anything on them, after Everyone or Just me. */
export function daysWithAppointments(i: AgendaInput): ReadonlySet<string> {
  return new Set(
    i.appointments
      .filter((a) => !i.mine || a.staff.some((s) => s.userId === i.myUserId))
      .map((a) => localDayOf(a.startsAt, i.timeZone)),
  );
}

/**
 * The day as a list: its appointments, this person's busy time when they're looking at their own, and the red "now"
 * line in its place. Exactly the order the web's agenda builds, so the two lists match row for row.
 */
export function agendaRows(i: AgendaInput): readonly AgendaRow[] {
  const onDay = appointmentsOnDay(i);
  const rows: AgendaRow[] = onDay.map((a) => ({
    kind: 'appt',
    at: Date.parse(a.startsAt),
    appt: a,
  }));
  if (i.mine)
    for (const b of i.busy ?? [])
      if (localDayOf(b.startsAt, i.timeZone) === i.date)
        rows.push({ kind: 'busy', at: Date.parse(b.startsAt), end: Date.parse(b.endsAt), busy: b });
  rows.sort((a, b) => a.at - b.at);
  if (i.now !== null && i.date === i.today && onDay.length) {
    const at = i.now;
    const n = rows.findIndex((r) => r.at > at);
    rows.splice(n === -1 ? rows.length : n, 0, { kind: 'now', at });
  }
  return rows;
}

/** "Today · Tuesday, September 22", or "Thursday, September 24" on any other day. */
export function dayHeading(date: string, today: string): string {
  return `${date === today ? 'Today · ' : ''}${fmtDateLong(date)}`;
}

/**
 * The phone's heading, where a long date would wrap: "Today · Tue, Sep 22", "Thu, Sep 24 · Just me" (M10's canvas).
 * Today never carries "· Just me" as well — three parts is one too many on a 390 px screen.
 */
export function dayHeadingShort(date: string, today: string, mine: boolean): string {
  if (date === today) return `Today · ${fmtDateShort(date)}`;
  return `${fmtDateShort(date)}${mine ? ' · Just me' : ''}`;
}

/** "6 appointments", "1 appointment", "" for none. */
export function appointmentCount(n: number): string {
  return n ? `${n} ${n === 1 ? 'appointment' : 'appointments'}` : '';
}

/** "Now · 8:20 AM". */
export const nowLabel = (at: number, timeZone: string): string => `Now · ${fmtTime(at, timeZone)}`;

export interface EmptyWords {
  readonly title: string;
  readonly body: string;
  readonly action: string;
}

/** A day with nothing on it, where there is only room for the fact: a week list's heading. */
export const NOTHING_BOOKED = 'Nothing booked';

/** Nothing on this day, as the web's agenda says it. */
export function agendaEmptyWords(mine: boolean): EmptyWords {
  return {
    title: mine ? `${NOTHING_BOOKED} for you` : NOTHING_BOOKED,
    body: 'Open times can still be booked online.',
    action: 'New appointment',
  };
}

/** A customer's or lead's "Upcoming appointments" card. */
export const UPCOMING_TITLE = 'Upcoming appointments';
export const UPCOMING_EMPTY = 'Nothing booked.';

/** The one-line detail under an appointment on that card: "9:00 AM–12:00 PM · Marco · Truck 2". */
export function upcomingDetail(a: AgendaAppointment, timeZone: string): string {
  return [fmtRange(a.startsAt, a.endsAt, timeZone), staffLine(a), ...a.resources.map((r) => r.name)]
    .filter(Boolean)
    .join(' · ');
}
