/**
 * The Calendar's SQL on the phone's copy. Each query joins in what the web's `appointment.list` and
 * `appointment.get` join — the calendar's name and colour, who is going, who it is for and where — so core's
 * `agenda.ts` can turn the rows into the same day the web shows.
 *
 * What the copy can't answer is worked out here or left out on purpose:
 * - **staff and customers** come back as one row each and are folded into their appointment in `use-calendar.ts`,
 *   because SQLite has no array aggregate we can rely on across PowerSync versions;
 * - **held times** (a deposit being paid) are the server's join of a draft booking invoice, so they arrive as the
 *   deposit invoice's own row and are matched by `attendee_id`;
 * - **resources** and **calendar connections** are not on the phone at all (`src/sync/schema.ts`), so the phone
 *   shows no equipment chip and says "From your calendar" rather than naming Google or Outlook.
 */

/** SQLite's `trim`, not Postgres's `btrim` (see `src/money/queries.ts`). */
const userName = (alias: string) => `coalesce(nullif(${alias}.full_name, ''), ${alias}.email)`;
const personName = (alias: string) =>
  `nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`;

/**
 * Every appointment in a window, with its calendar and its service. 90 days back is all the phone keeps
 * (`sync_window`), so the window is only ever narrowing what is already here.
 */
export const APPOINTMENTS_SQL = `
  SELECT a.id, a.title, a.starts_at, a.ends_at, a.status, a.source, a.kind, a.notes, a.location,
    a.capacity, a.seats_taken, a.buffer_before, a.buffer_after, a.calendar_id, a.calendar_revision,
    a.service_id, a.lead_id, a.client_id, a.created_at,
    c.name AS calendar_name, c.color AS calendar_color, c.config AS calendar_config,
    s.name AS service_name, s.price_cents AS service_price_cents
  FROM appointments a
  LEFT JOIN calendars c ON c.id = a.calendar_id
  LEFT JOIN services s ON s.id = a.service_id
  WHERE a.workspace_id = ? AND a.ends_at >= ? AND a.starts_at < ?`;

/** One appointment, the same way. */
export const APPOINTMENT_SQL = `${APPOINTMENTS_SQL.replace('a.ends_at >= ? AND a.starts_at < ?', 'a.id = ?')}`;

/** Who is going, for every appointment in the window: one row each, host first. */
export const APPOINTMENT_STAFF_SQL = `
  SELECT st.appointment_id, st.user_id, st.role, ${userName('u')} AS full_name
  FROM appointment_staff st
  JOIN appointments a ON a.id = st.appointment_id
  LEFT JOIN users u ON u.id = st.user_id
  WHERE st.workspace_id = ? AND a.ends_at >= ? AND a.starts_at < ? AND coalesce(st.active, 1) = 1
  ORDER BY CASE st.role WHEN 'host' THEN 0 ELSE 1 END, full_name`;

/** Who it is for: the seats on every appointment in the window, cancelled ones included so a sheet can say so. */
export const APPOINTMENT_SEATS_SQL = `
  SELECT t.id, t.appointment_id, t.person_id, t.status, t.seats, t.contact_phone_e164, t.contact_email,
    t.sms_ok, t.confirmed_at, t.confirmed_via, t.confirmed_by, t.confirm_asked_at, t.cancelled_at,
    t.source,
    coalesce(${personName('p')}, 'Customer') AS full_name,
    p.phone_e164, p.email AS person_email, p.sms_consent,
    p.address_line1, p.address_line2, p.city, p.state, p.postal_code,
    ${userName('cu')} AS confirmed_by_name
  FROM appointment_attendees t
  JOIN appointments a ON a.id = t.appointment_id
  LEFT JOIN people p ON p.id = t.person_id
  LEFT JOIN users cu ON cu.id = t.confirmed_by
  WHERE t.workspace_id = ? AND a.ends_at >= ? AND a.starts_at < ?
  ORDER BY t.created_at, t.id`;

/** One appointment's seats. */
export const APPOINTMENT_SEATS_ONE_SQL = APPOINTMENT_SEATS_SQL.replace(
  'a.ends_at >= ? AND a.starts_at < ?',
  't.appointment_id = ?',
);

/** One appointment's staff. */
export const APPOINTMENT_STAFF_ONE_SQL = APPOINTMENT_STAFF_SQL.replace(
  'a.ends_at >= ? AND a.starts_at < ?',
  'st.appointment_id = ?',
);

/**
 * A time only held while its deposit is paid: the draft invoice the booking page raised against a seat. The
 * server works out `heldUntil` from the invoice's age (`DEPOSIT_HOLD_MS`), and so does the phone.
 */
export const BOOKING_DEPOSITS_SQL = `
  SELECT i.id, i.attendee_id, i.status, i.created_at, i.total_cents
  FROM invoices i
  JOIN appointment_attendees t ON t.id = i.attendee_id
  JOIN appointments a ON a.id = t.appointment_id
  WHERE i.workspace_id = ? AND i.origin = 'booking' AND i.status = 'draft'
    AND a.ends_at >= ? AND a.starts_at < ?`;

/** This person's own busy time from their Google or Outlook calendar, in the window. */
export const BUSY_SQL = `
  SELECT id, starts_at, ends_at FROM calendar_busy_blocks
  WHERE workspace_id = ? AND user_id = ? AND ends_at >= ? AND starts_at < ?
  ORDER BY starts_at`;

/** The business's calendars, for the New appointment sheet. */
export const CALENDARS_SQL = `
  SELECT id, name, color, config, revision, timezone, status
  FROM calendars WHERE workspace_id = ? AND status = 'active'
  ORDER BY name`;

/** Who may be put on an appointment: the members of a calendar, with their names. */
export const CALENDAR_MEMBERS_SQL = `
  SELECT m.calendar_id, m.user_id, ${userName('u')} AS full_name
  FROM calendar_members m
  LEFT JOIN users u ON u.id = m.user_id
  WHERE m.workspace_id = ?
  ORDER BY full_name`;

/** The services a calendar offers, in the order it lists them. */
export const CALENDAR_SERVICES_SQL = `
  SELECT cs.calendar_id, cs.service_id, cs.position, s.name, s.default_duration, s.durations,
    s.price_cents, s.location_kinds
  FROM calendar_services cs
  JOIN services s ON s.id = cs.service_id
  WHERE cs.workspace_id = ? AND s.archived_at IS NULL
  ORDER BY cs.position, s.name`;

/** The money on one visit: every invoice raised against its seats. */
export const VISIT_INVOICES_SQL = `
  SELECT i.id, i.number, i.status, i.origin, i.purpose, i.title, i.total_cents, i.amount_paid_cents,
    i.amount_refunded_cents, i.due_on, i.paid_at, i.voided_at, i.first_viewed_at, i.attendee_id
  FROM invoices i
  JOIN appointment_attendees t ON t.id = i.attendee_id
  WHERE i.workspace_id = ? AND t.appointment_id = ?
  ORDER BY i.created_at`;

/** The Calendar's changes on this phone: bookings, moves, cancellations, statuses and confirmations. */
export const CALENDAR_OUTBOX_SQL = `
  SELECT * FROM outbox
  WHERE workspace_id = ? AND (name LIKE 'appointment.%' OR name = 'attendee.confirm')
    AND (state != 'sent' OR sent_at >= ?)
  ORDER BY seq`;

/**
 * The people a change waiting on this phone names, so a time asked for here can say whose visit it is before
 * HandsFreeOS has a row for it. The `?`s are built from how many ids there are, never from their values.
 */
export const peopleByIdSql = (count: number): string => `
  SELECT id, coalesce(nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), ''), 'Customer')
    AS full_name,
    address_line1, address_line2, city, state, postal_code
  FROM people WHERE workspace_id = ? AND id IN (${Array(count).fill('?').join(', ')})`;

/**
 * The customers a visit can be asked for, newest first, with what the phone matches a search against (`search_text`
 * is a generated column, so it never reaches the phone — `compute.ts` works the same string out here).
 */
export const PEOPLE_SQL = `
  SELECT id, first_name, last_name, email, phone_e164, city, address_line1, address_line2, state, postal_code,
    other_emails, other_phones, other_addresses
  FROM people WHERE workspace_id = ? AND archived_at IS NULL
  ORDER BY last_name, first_name`;

/** The business: its time zone and settings. */
export const WORKSPACE_SQL = 'SELECT name, timezone, settings FROM workspaces WHERE id = ?';

/** M18: the open job a visit is part of (done and cancelled jobs leave the phone). */
export const VISIT_JOB_SQL = `
  SELECT j.id, j.title, j.status, j.customer_note, j.eta_at
  FROM jobs j
  JOIN appointments a ON a.job_id = j.id
  WHERE a.workspace_id = ? AND a.id = ?`;

/** Job changes waiting on this phone, newest last. */
export const JOB_OUTBOX_SQL = `
  SELECT * FROM outbox
  WHERE workspace_id = ? AND name = 'job.set_status' AND state != 'sent'
  ORDER BY seq`;
