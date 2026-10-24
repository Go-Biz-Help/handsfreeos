/**
 * One booking the way its customer messages need it, read as it is now: the attendee and appointment, the
 * calendar's settings, the business's name and number, the first names of who comes, where it is, the
 * policies it was booked under, and its change-or-cancel link (manageUrlFor) with the calendar file.
 */
import { and, eq } from 'drizzle-orm';
import {
  formatPhone,
  loadCalendar,
  parseConfig,
  userNames,
  type CalendarConfig,
  type LoadedCalendar,
} from '@hfos/core/server';
import type { Tx } from '@hfos/db/client';
import {
  appointmentAttendees,
  appointments,
  appointmentStaff,
  bookingSites,
  calendarRevisions,
  people,
  phoneNumbers,
  workspaces,
} from '@hfos/db/schema';
import type { WorkerServices } from '../services';
import { publicOrigin } from '../hosting/origin';
import { joinUrlFor, manageUrlFor } from './links';
import type { Business, Policies, Visit } from './messages';

export type AttendeeRow = typeof appointmentAttendees.$inferSelect;
export type AppointmentRow = typeof appointments.$inferSelect;
export type SmsConsent = 'unknown' | 'opted_in' | 'opted_out';

/** A one-on-one booking (not a group time or a session seat): the only kind a customer confirms (M8). */
export const oneOnOne = (appt: Pick<AppointmentRow, 'kind' | 'capacity'>): boolean =>
  appt.kind === 'booking' && appt.capacity === 1;

export interface LoadedBooking {
  readonly attendee: AttendeeRow;
  readonly appt: AppointmentRow;
  readonly calendar: LoadedCalendar;
  readonly person: {
    readonly firstName: string;
    readonly lastName: string;
    readonly smsConsent: SmsConsent;
  };
  readonly business: Business;
  readonly visit: Visit;
  readonly policies: Policies;
  readonly manageUrl: string | null;
  readonly icsUrl: string | null;
  /** Who works it, the host first. */
  readonly staffIds: readonly string[];
}

type LinkServices = Pick<WorkerServices, 'webUrl' | 'publicUrl' | 'bookingLinks'>;

/** A person's first name for customers; never an email address. */
export function firstNameOf(full: string | undefined): string | null {
  const name = (full ?? '').trim();
  if (!name || name.includes('@') || name === 'Someone') return null;
  return name.split(/\s+/)[0]!;
}

const zip5 = (v: string | null | undefined): string => (v ?? '').replace(/\D/g, '').slice(0, 5);

type StoredLocation = {
  kind?: string | null;
  address?: string | null;
  meetingUrl?: string | null;
  postalCode?: string | null;
  record?: boolean;
};

/** The street address, with the customer's ZIP when the address doesn't carry it. */
function addressOf(l: StoredLocation): string | null {
  const address = (l.address ?? '').trim();
  const zip = l.kind === 'customer_address' ? zip5(l.postalCode) : '';
  return [address, zip && !address.includes(zip) ? zip : ''].filter(Boolean).join(', ') || null;
}

/** The business as customers know it: the booking site's name, its active number, its booking page. */
export async function businessOf(
  tx: Tx,
  s: LinkServices,
  workspaceId: string,
  calendar: LoadedCalendar | null,
): Promise<Business> {
  const [site] = await tx
    .select({ slug: bookingSites.slug, name: bookingSites.name, enabled: bookingSites.enabled })
    .from(bookingSites)
    .where(eq(bookingSites.workspaceId, workspaceId));
  const [w] = await tx
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const [number] = await tx
    .select({ e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.status, 'active')))
    .limit(1);
  const bookable =
    !!site?.enabled && !!calendar && calendar.status === 'active' && calendar.config.public;
  // Their own domain once one is serving (M17), so the "book again" link at the bottom of a confirmation is
  // on the same name as the page the customer booked from.
  const origin = await publicOrigin(tx, workspaceId, s.webUrl);
  return {
    name: site?.name || w?.name || 'The business',
    phone: number?.e164 ?? null,
    phoneDisplay: number ? formatPhone(number.e164) : null,
    bookingUrl:
      bookable && site && calendar ? `${origin}/book/${site.slug}/${calendar.slug}` : null,
  };
}

/** The policies a booking keeps: its revision's, or today's when that revision is gone or unreadable. */
async function policiesOf(
  tx: Tx,
  calendar: LoadedCalendar,
  revision: number,
): Promise<CalendarConfig['policies']> {
  if (revision === calendar.revision) return calendar.config.policies;
  const [r] = await tx
    .select({ config: calendarRevisions.config })
    .from(calendarRevisions)
    .where(
      and(eq(calendarRevisions.calendarId, calendar.id), eq(calendarRevisions.revision, revision)),
    );
  if (!r) return calendar.config.policies;
  try {
    return parseConfig(r.config).policies;
  } catch {
    return calendar.config.policies;
  }
}

/** The first names of who works an appointment, the host first. */
export async function staffOf(
  tx: Tx,
  appointmentId: string,
): Promise<{ ids: string[]; firstNames: string[] }> {
  const staff = await tx
    .select({ userId: appointmentStaff.userId, role: appointmentStaff.role })
    .from(appointmentStaff)
    .where(eq(appointmentStaff.appointmentId, appointmentId));
  staff.sort((a, b) =>
    a.role === b.role ? a.userId.localeCompare(b.userId) : a.role === 'host' ? -1 : 1,
  );
  const ids = staff.map((x) => x.userId);
  const names = await userNames(tx, ids);
  return {
    ids,
    firstNames: ids.map((id) => firstNameOf(names.get(id))).filter((n): n is string => !!n),
  };
}

/**
 * One booking as its messages need it, or null when it is gone. `forCustomer`: the messages go to the customer, so
 * an online session's link is their own Join link (`/j/…`), which says when they joined, rather than the meeting's
 * own address. A teammate's copy keeps the meeting's address: their opening it isn't the customer joining.
 */
export async function loadBooking(
  tx: Tx,
  s: LinkServices,
  attendeeId: string,
  opts: { readonly forCustomer?: boolean } = {},
): Promise<LoadedBooking | null> {
  const [row] = await tx
    .select({
      a: appointmentAttendees,
      p: appointments,
      firstName: people.firstName,
      lastName: people.lastName,
      smsConsent: people.smsConsent,
    })
    .from(appointmentAttendees)
    .innerJoin(appointments, eq(appointments.id, appointmentAttendees.appointmentId))
    .innerJoin(people, eq(people.id, appointmentAttendees.personId))
    .where(eq(appointmentAttendees.id, attendeeId));
  if (!row) return null;
  const ws = row.p.workspaceId;
  const calendar = await loadCalendar(tx, ws, row.p.calendarId);
  const business = await businessOf(tx, s, ws, calendar);
  const staff = await staffOf(tx, row.p.id);
  const location = (row.p.location ?? {}) as StoredLocation;
  const visit: Visit = {
    title: row.p.title,
    startsAt: row.p.startsAt.getTime(),
    endsAt: row.p.endsAt.getTime(),
    timeZone: calendar.timeZone,
    kind: row.p.kind,
    seats: row.a.seats,
    locationKind: location.kind ?? null,
    address: addressOf(location),
    meetingUrl:
      location.kind === 'virtual' && location.meetingUrl && opts.forCustomer
        ? ((await joinUrlFor(tx, s.bookingLinks, row.a.id)) ?? location.meetingUrl)
        : (location.meetingUrl ?? null),
    recorded: location.record === true,
    staff: staff.firstNames,
  };
  const manageUrl = await manageUrlFor(tx, s.bookingLinks, row.a.id);
  const token = manageUrl?.split('/m/')[1] ?? null;
  return {
    attendee: row.a,
    appt: row.p,
    calendar,
    person: { firstName: row.firstName, lastName: row.lastName, smsConsent: row.smsConsent },
    business,
    visit,
    policies: await policiesOf(tx, calendar, row.p.calendarRevision),
    manageUrl,
    icsUrl: token ? `${s.publicUrl}/public/manage/${token}/ics` : null,
    staffIds: staff.ids,
  };
}
