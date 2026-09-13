/**
 * Engine inputs and outputs. Everything is already-expanded instants (epoch milliseconds): the database turns
 * schedules into windows (`private.expand_schedule`), so the engine only does interval math.
 */
import type { CatalogService, CatalogTerritory } from '../catalogs';
import type { CalendarConfig, LocationKind } from '../config';
import type { Interval } from './intervals';

/** An existing appointment someone (or something) is on. */
export interface Booking {
  /** The appointment itself. */
  readonly during: Interval;
  /** The appointment with its buffers and travel. */
  readonly blocked: Interval;
  /** Counts toward this calendar's daily limit when it matches `SlotInput.calendarId`. */
  readonly calendarId?: string | null;
}

export interface StaffInput {
  readonly userId: string;
  /** Their open hours (weekly hours plus extra-hours exceptions), time off already removed or listed in busy. */
  readonly windows: readonly Interval[];
  /** Google or Outlook busy times and time off. Treated like appointments without buffers. */
  readonly busy: readonly Interval[];
  readonly bookings: readonly Booking[];
}

export interface ResourceBooking extends Booking {
  readonly quantity: number;
}

export interface ResourceInput {
  readonly resourceId: string;
  readonly quantity: number;
  /** Resource hours; null means always open. */
  readonly windows: readonly Interval[] | null;
  readonly bookings: readonly ResourceBooking[];
}

/** A published session (sessions mode) or an existing group appointment people can join (hours mode). */
export interface SessionInput {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly capacity: number;
  readonly seatsTaken: number;
  readonly userIds: readonly string[];
  readonly serviceId?: string | null;
}

export interface SlotInput {
  readonly config: CalendarConfig;
  readonly calendarId?: string | null;
  /** The calendar's zone: local days for notice, date ranges and daily limits. */
  readonly timeZone: string;
  readonly now: number;
  /** Start times from `from` (inclusive) to `to` (exclusive); at most 62 days apart. */
  readonly from: number;
  readonly to: number;
  /** The service being booked, when the calendar has services. */
  readonly service?: CatalogService | null;
  /** Defaults to the first bookable length. */
  readonly durationMinutes?: number;
  readonly partySize?: number;
  /** Where the visit happens; defaults to the calendar's first location. Travel applies to customer_address. */
  readonly locationKind?: LocationKind | null;
  /** The customer's ZIP for ZIP routing; without one, routing is not applied (staff booking). */
  readonly postalCode?: string | null;
  /** Customer's choice: the person they picked. */
  readonly chosenUserId?: string | null;
  /** The calendar-hours layer; null or missing means no layer. */
  readonly calendarWindows?: readonly Interval[] | null;
  /** The service-hours layer; null or missing means no layer. */
  readonly serviceWindows?: readonly Interval[] | null;
  readonly staff: readonly StaffInput[];
  readonly resources?: readonly ResourceInput[];
  readonly sessions?: readonly SessionInput[];
  /** The workspace's territories (the calendar's selection is applied here). */
  readonly territories?: readonly CatalogTerritory[];
}

export interface Slot {
  readonly start: number;
  readonly end: number;
  /** People free for it, in team order. For collective, everyone who would attend. */
  readonly userIds: readonly string[];
  /** Seats open before this booking. */
  readonly seatsLeft: number;
  /** Joining an existing session or group appointment. */
  readonly sessionId: string | null;
}

/** Round-robin fairness per person (calendar_assignment_state). */
export interface MemberAssignmentState {
  readonly assignedCount: number;
  readonly lastAssignedAt: number | null;
  /** Smooth weighted round-robin credit. */
  readonly credit: number;
}

export type AssignmentState = Readonly<Record<string, MemberAssignmentState>>;

export interface AssignmentOptions {
  /** When the assignment happens; defaults to now. */
  readonly now?: number;
  /** Customer's choice. */
  readonly chosenUserId?: string | null;
  /** Series continuity: the first occurrence's people, kept when free. */
  readonly preferUserIds?: readonly string[];
}

export interface Assignment {
  readonly userIds: string[];
  readonly nextState: AssignmentState;
}
