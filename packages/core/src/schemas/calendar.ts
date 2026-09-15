/**
 * Milestone 5 schemas: calendars, catalogs (services, resources, territories, the booking site), hours and
 * time off, appointments, sessions, series, waitlists and the booking page's system commands. Browser-safe.
 */
import { z } from 'zod';
import { CalendarConfig, LocationKind, WeeklyHours } from '../calendar/config';
import { RecurrenceRule } from '../calendar/engine/recurrence';
import { isLocalDate } from '../calendar/engine/zoned';
import { IMPACT_DECISIONS } from '../calendar/impact';
import { PRESET_KEYS } from '../calendar/presets';
import { displayName, isoDateTime, timezone, uuid } from './common';
import { optionalEmail, phoneInput, UserRef } from './crm';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a color like #2d69d8.');
const linkName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
    'Use letters, numbers and dashes (not at the start or end).',
  );
const localDate = z.string().refine(isLocalDate, { error: 'Use a date like 2026-10-01.' });
const description = z.string().trim().max(2000).nullable().optional();
const lengthMinutes = z.int().min(5, 'At least 5 minutes.').max(720, 'At most 12 hours.');
const bufferMinutes = z.int().min(0).max(240, 'At most 4 hours.');
const reason = z.string().trim().max(500).nullable().optional();
const notesText = z.string().trim().max(5000).nullable().optional();
const title = z.string().trim().min(1, 'Enter a title.').max(200);
const clientId = z.string().trim().min(1).max(64);
const partySize = z.int().min(1).max(100).default(1);

export const CalendarStatusValue = z.enum(['draft', 'active', 'paused', 'archived']);
export const AppointmentStatusValue = z.enum(['scheduled', 'completed', 'cancelled', 'no_show']);
export const AppointmentSourceValue = z.enum([
  'staff',
  'assistant',
  'booking_page',
  'series',
  'ai_teammate',
]);
export const AttendeeStatusValue = z.enum(['booked', 'cancelled', 'no_show', 'attended']);
export const ResourceKindValue = z.enum([
  'room',
  'equipment',
  'vehicle',
  'property',
  'chair',
  'other',
]);
/** Calendar hours live in the calendar's settings; people, resources and services have their own. */
export const HoursOwnerKind = z.enum(['user', 'resource', 'service']);

/** Where one appointment happens. */
export const AppointmentLocation = z.object({
  kind: LocationKind.nullable().default(null),
  address: z.string().trim().max(300).nullable().default(null),
  meetingUrl: z.url().max(500).nullable().default(null),
  postalCode: z.string().trim().max(20).nullable().default(null),
});
export type AppointmentLocation = z.infer<typeof AppointmentLocation>;

/** Answers to a calendar's intake questions, by question id. */
export const IntakeAnswers = z.record(
  z.string().max(40),
  z.union([
    z.string().max(2000),
    z.number(),
    z.boolean(),
    z.array(z.string().max(100)).max(30),
    z.null(),
  ]),
);

// ---- Rules output ----

export const CalendarIssueOut = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  fields: z.array(z.string()).readonly(),
  fixes: z
    .array(
      z.object({ id: z.string(), label: z.string(), patch: z.record(z.string(), z.unknown()) }),
    )
    .readonly(),
});
export const CalendarLabelsOut = z.object({
  primary: z.string(),
  tags: z.array(z.string()).readonly(),
});
export const CalendarImpactOut = z.object({
  key: z.string(),
  code: z.string(),
  message: z.string(),
  count: z.int(),
  userId: uuid.optional(),
  resourceId: uuid.optional(),
  appointmentIds: z.array(uuid).optional(),
  decisions: z.array(z.enum(IMPACT_DECISIONS)),
});
const ImpactDecisions = z.record(z.string().max(80), z.enum(IMPACT_DECISIONS)).default(() => ({}));

// ---- Calendars ----

export const CalendarCreateInput = z.object({
  workspaceId: uuid,
  name: displayName,
  /** The answer to "How do you want this calendar to work?"; it only prefills settings. */
  preset: z.enum(PRESET_KEYS).default('scratch'),
  teammates: z
    .array(uuid)
    .max(50)
    .default(() => []),
  services: z
    .array(uuid)
    .max(50)
    .default(() => []),
  resources: z
    .array(uuid)
    .max(20)
    .default(() => []),
  description,
  color: hexColor.optional(),
  /** null or missing: the workspace's zone. */
  timezone: timezone.nullable().optional(),
});
export const CalendarCreateOutput = z.object({
  calendarId: uuid,
  slug: z.string(),
  revision: z.int(),
  labels: CalendarLabelsOut,
  issues: z.array(CalendarIssueOut),
});

export const CalendarSaveInput = z.object({
  workspaceId: uuid,
  calendarId: uuid,
  /** The revision the draft was edited from; a newer save in between is a 409 revision_conflict. */
  baseRevision: z.int().min(1),
  draft: CalendarConfig,
  name: displayName.optional(),
  description,
  color: hexColor.optional(),
  timezone: timezone.nullable().optional(),
  /** Answers to the impact review, by impact key ('member:<id>', 'resource:<id>', 'seats'). */
  impactDecisions: ImpactDecisions,
});
export const CalendarSaveOutput = z.object({
  calendarId: uuid,
  revision: z.int(),
  labels: CalendarLabelsOut,
  issues: z.array(CalendarIssueOut),
  diff: z.array(z.string()),
  actions: z.object({
    reassigned: z.array(uuid),
    cancelled: z.array(uuid),
    /** Kept by decision, or because nobody else was free to take them. */
    kept: z.array(uuid),
  }),
});
export const CalendarRestoreRevisionInput = z.object({
  workspaceId: uuid,
  calendarId: uuid,
  revision: z.int().min(1),
  baseRevision: z.int().min(1),
  impactDecisions: ImpactDecisions,
});
export const CalendarSetStatusInput = z.object({
  workspaceId: uuid,
  calendarId: uuid,
  status: CalendarStatusValue,
});
export const CalendarSetStatusOutput = z.object({
  calendarId: uuid,
  status: CalendarStatusValue,
  issues: z.array(CalendarIssueOut),
});
export const CalendarSetSlugInput = z.object({
  workspaceId: uuid,
  calendarId: uuid,
  slug: linkName,
});
export const CalendarSetSlugOutput = z.object({
  calendarId: uuid,
  slug: z.string(),
  previousSlug: z.string(),
});

export const CalendarSummary = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  color: z.string(),
  slug: z.string(),
  status: CalendarStatusValue,
  public: z.boolean(),
  labels: CalendarLabelsOut,
  revision: z.int(),
  /** The zone it books in (its own, else the workspace's). */
  timezone: z.string(),
  ownerUserId: uuid.nullable(),
  memberIds: z.array(uuid),
  /** /book/<site>/<calendar>, or null until the workspace has a booking site. */
  bookingPath: z.string().nullable(),
  /** /book/c/<id>: works forever, whatever the names. */
  permanentPath: z.string(),
  /** Scheduled appointments in the next 7 days. */
  upcomingCount: z.int(),
  updatedAt: isoDateTime,
});
export type CalendarSummary = z.infer<typeof CalendarSummary>;

export const CalendarListInput = z.object({
  workspaceId: uuid,
  includeArchived: z.boolean().default(false),
});
export const CalendarListOutput = z.object({
  items: z.array(CalendarSummary),
  site: z.object({ id: uuid, slug: z.string(), enabled: z.boolean() }).nullable(),
});

export const CalendarRevisionOut = z.object({
  revision: z.int(),
  labels: z.array(z.string()),
  diff: z.array(z.string()),
  changedBy: UserRef,
  createdAt: isoDateTime,
});
export const CalendarGetInput = z.object({ workspaceId: uuid, calendarId: uuid });
export const CalendarGetOutput = z.object({
  calendar: CalendarSummary.extend({
    config: CalendarConfig,
    /** The calendar's own zone; null follows the workspace. */
    ownTimezone: z.string().nullable(),
    /** Conflicts in the saved settings, computed now. */
    issues: z.array(CalendarIssueOut),
  }),
  /** Newest first, at most 50. */
  revisions: z.array(CalendarRevisionOut),
});

// ---- Availability ----

export const CalendarAvailabilityInput = z.object({
  workspaceId: uuid,
  calendarId: uuid,
  from: isoDateTime,
  to: isoDateTime,
  serviceId: uuid.nullable().optional(),
  durationMinutes: lengthMinutes.optional(),
  partySize,
  postalCode: z.string().trim().max(20).nullable().optional(),
  chosenUserId: uuid.nullable().optional(),
  locationKind: LocationKind.nullable().optional(),
});
export const SlotOut = z.object({
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  userIds: z.array(uuid),
  seatsLeft: z.int(),
  /** Joining this existing session or group time. */
  sessionId: uuid.nullable(),
});
export type SlotOut = z.infer<typeof SlotOut>;
export const CalendarAvailabilityOutput = z.object({
  calendarId: uuid,
  timezone: z.string(),
  serviceId: uuid.nullable(),
  durationMinutes: z.int(),
  slots: z.array(SlotOut),
});

// ---- Catalogs ----

const ServiceResourceInput = z.object({
  resourceId: uuid,
  quantity: z.int().min(1).max(100).default(1),
});
const serviceDurations = z
  .array(lengthMinutes)
  .min(1, 'Add a length.')
  .max(6, 'At most 6 lengths.');

export const ServiceCreateInput = z.object({
  workspaceId: uuid,
  name: displayName,
  description,
  durations: serviceDurations.default(() => [60]),
  /** One of the lengths; the first when missing. */
  defaultDuration: lengthMinutes.optional(),
  bufferBefore: bufferMinutes.default(0),
  bufferAfter: bufferMinutes.default(0),
  color: hexColor.optional(),
  priceCents: z.int().min(0).max(100_000_000).nullable().optional(),
  locationKinds: z
    .array(LocationKind)
    .max(4)
    .default(() => []),
  /** Who does it; empty means everyone. */
  staffUserIds: z
    .array(uuid)
    .max(50)
    .default(() => []),
  resources: z
    .array(ServiceResourceInput)
    .max(20)
    .default(() => []),
  /** Service hours (an extra layer); null means none. */
  hours: WeeklyHours.nullable().default(null),
});
export const ServiceCreateOutput = z.object({ serviceId: uuid });
export const ServiceUpdateInput = z.object({
  workspaceId: uuid,
  serviceId: uuid,
  name: displayName.optional(),
  description,
  durations: serviceDurations.optional(),
  defaultDuration: lengthMinutes.optional(),
  bufferBefore: bufferMinutes.optional(),
  bufferAfter: bufferMinutes.optional(),
  color: hexColor.optional(),
  priceCents: z.int().min(0).max(100_000_000).nullable().optional(),
  locationKinds: z.array(LocationKind).max(4).optional(),
  staffUserIds: z.array(uuid).max(50).optional(),
  resources: z.array(ServiceResourceInput).max(20).optional(),
  hours: WeeklyHours.nullable().optional(),
});
export const ServiceUpdateOutput = z.object({ serviceId: uuid, updated: z.array(z.string()) });
export const ServiceArchiveInput = z.object({ workspaceId: uuid, serviceId: uuid });
export const ServiceArchiveOutput = z.object({
  serviceId: uuid,
  /** Calendars still offering it (their settings now show a conflict to fix). */
  calendars: z.array(z.object({ id: uuid, name: z.string() })),
});

export const ResourceCreateInput = z.object({
  workspaceId: uuid,
  name: displayName,
  kind: ResourceKindValue.default('other'),
  quantity: z.int().min(1).max(100).default(1),
  location: z.string().trim().max(300).nullable().optional(),
  hours: WeeklyHours.nullable().default(null),
});
export const ResourceCreateOutput = z.object({ resourceId: uuid });
export const ResourceUpdateInput = z.object({
  workspaceId: uuid,
  resourceId: uuid,
  name: displayName.optional(),
  kind: ResourceKindValue.optional(),
  quantity: z.int().min(1).max(100).optional(),
  location: z.string().trim().max(300).nullable().optional(),
  hours: WeeklyHours.nullable().optional(),
});
export const ResourceUpdateOutput = z.object({ resourceId: uuid, updated: z.array(z.string()) });
export const ResourceArchiveInput = z.object({ workspaceId: uuid, resourceId: uuid });
export const ResourceArchiveOutput = z.object({
  resourceId: uuid,
  calendars: z.array(z.object({ id: uuid, name: z.string() })),
});

const postalCodes = z
  .array(
    z
      .string()
      .trim()
      .regex(/^\d{5}$/, 'Use 5-digit ZIP codes.'),
  )
  .max(5000);
export const TerritoryCreateInput = z.object({
  workspaceId: uuid,
  name: displayName,
  postalCodes: postalCodes.default(() => []),
  userIds: z
    .array(uuid)
    .max(100)
    .default(() => []),
});
export const TerritoryCreateOutput = z.object({ territoryId: uuid });
export const TerritoryUpdateInput = z.object({
  workspaceId: uuid,
  territoryId: uuid,
  name: displayName.optional(),
  postalCodes: postalCodes.optional(),
  userIds: z.array(uuid).max(100).optional(),
});
export const TerritoryUpdateOutput = z.object({ territoryId: uuid, updated: z.array(z.string()) });
export const TerritoryDeleteInput = z.object({ workspaceId: uuid, territoryId: uuid });
export const TerritoryDeleteOutput = z.object({ territoryId: uuid });

export const BookingSiteUpdateInput = z.object({
  workspaceId: uuid,
  slug: linkName,
  name: displayName,
  intro: z.string().trim().max(2000).nullable().optional(),
  enabled: z.boolean().default(true),
});
export const BookingSiteUpdateOutput = z.object({ siteId: uuid, slug: z.string() });

export const ServiceOut = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  durations: z.array(z.int()),
  defaultDuration: z.int(),
  bufferBefore: z.int(),
  bufferAfter: z.int(),
  color: z.string(),
  priceCents: z.int().nullable(),
  locationKinds: z.array(z.string()),
  staffUserIds: z.array(uuid),
  resources: z.array(z.object({ resourceId: uuid, quantity: z.int() })),
  hours: WeeklyHours.nullable(),
  archivedAt: isoDateTime.nullable(),
});
export const ServiceListInput = z.object({
  workspaceId: uuid,
  includeArchived: z.boolean().default(false),
});
export const ServiceListOutput = z.object({ items: z.array(ServiceOut) });

export const ResourceOut = z.object({
  id: uuid,
  name: z.string(),
  kind: ResourceKindValue,
  quantity: z.int(),
  location: z.string().nullable(),
  hours: WeeklyHours.nullable(),
  archivedAt: isoDateTime.nullable(),
});
export const ResourceListInput = z.object({
  workspaceId: uuid,
  includeArchived: z.boolean().default(false),
});
export const ResourceListOutput = z.object({ items: z.array(ResourceOut) });

export const TerritoryOut = z.object({
  id: uuid,
  name: z.string(),
  postalCodes: z.array(z.string()),
  userIds: z.array(uuid),
});
export const TerritoryListInput = z.object({ workspaceId: uuid });
export const TerritoryListOutput = z.object({ items: z.array(TerritoryOut) });

export const BookingSiteOut = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  intro: z.string().nullable(),
  enabled: z.boolean(),
  path: z.string(),
});
export const BookingSiteGetInput = z.object({ workspaceId: uuid });
export const BookingSiteGetOutput = z.object({ site: BookingSiteOut.nullable() });

// ---- Hours and time off ----

export const ScheduleSetInput = z.object({
  workspaceId: uuid,
  ownerKind: HoursOwnerKind.default('user'),
  /** A person (yourself when missing), resource or service. */
  ownerId: uuid.optional(),
  /** null follows the workspace's zone; missing keeps the current one. */
  timezone: timezone.nullable().optional(),
  weekly: WeeklyHours,
});
export const ScheduleSetOutput = z.object({ scheduleId: uuid });

export const TimeOffAddInput = z
  .object({
    workspaceId: uuid,
    ownerKind: HoursOwnerKind.default('user'),
    ownerId: uuid.optional(),
    /** unavailable: time off or a closure; available: extra open time. */
    kind: z.enum(['unavailable', 'available']).default('unavailable'),
    startsAt: isoDateTime.optional(),
    endsAt: isoDateTime.optional(),
    /** All-day, inclusive local dates in the schedule's zone. */
    startDate: localDate.optional(),
    endDate: localDate.optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => (v.startsAt && v.endsAt) || v.startDate, {
    path: ['startsAt'],
    error: 'Pick when.',
  });
export const TimeOffAddOutput = z.object({
  exceptionId: uuid,
  scheduleId: uuid,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
});
export const TimeOffRemoveInput = z.object({ workspaceId: uuid, exceptionId: uuid });
export const TimeOffRemoveOutput = z.object({ exceptionId: uuid });

export const ScheduleTeamInput = z.object({
  workspaceId: uuid,
  from: isoDateTime,
  to: isoDateTime,
  userIds: z.array(uuid).max(100).optional(),
});
const Span = z.object({ startsAt: isoDateTime, endsAt: isoDateTime });
export const CalendarConnectionOut = z.object({
  id: uuid,
  userId: uuid,
  fullName: z.string(),
  provider: z.enum(['google', 'microsoft']),
  status: z.enum(['pending', 'active', 'reauth_required', 'error', 'disconnected']),
  accountEmail: z.string().nullable(),
  scopes: z.array(z.string()),
  busySyncedAt: isoDateTime.nullable(),
  nextSyncAt: isoDateTime.nullable(),
  failures: z.int(),
  lastError: z.string().nullable(),
  connectedAt: isoDateTime.nullable(),
  disconnectedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export const ScheduleTeamOutput = z.object({
  timezone: z.string(),
  people: z.array(
    z.object({
      userId: uuid,
      fullName: z.string(),
      scheduleId: uuid.nullable(),
      timezone: z.string(),
      weekly: WeeklyHours,
      /** No hours saved yet: weekdays 9 to 5 apply. */
      defaultHours: z.boolean(),
      hours: z.array(Span),
      timeOff: z.array(
        Span.extend({
          id: uuid,
          kind: z.enum(['unavailable', 'available']),
          allDay: z.boolean(),
          note: z.string().nullable(),
        }),
      ),
      busy: z.array(Span),
      /** Their Google or Outlook link; null when none, or not yours to see. */
      connection: CalendarConnectionOut.nullable(),
    }),
  ),
});

export const CalendarConnectionListInput = z.object({
  workspaceId: uuid,
  /** Only this person's (anyone's needs calendars.manage; otherwise you see your own). */
  userId: uuid.optional(),
  includeDisconnected: z.boolean().default(false),
});
export const CalendarConnectionListOutput = z.object({ items: z.array(CalendarConnectionOut) });

// ---- Appointments ----

export const AppointmentWarning = z.object({
  code: z.enum(['in_past', 'buffer_clash', 'outside_hours', 'calendar_busy', 'time_off']),
  message: z.string(),
  userId: uuid.nullable(),
  resourceId: uuid.nullable(),
});
export type AppointmentWarning = z.infer<typeof AppointmentWarning>;

export const AppointmentCreateInput = z.object({
  workspaceId: uuid,
  calendarId: uuid,
  startsAt: isoDateTime,
  /** Defaults to the service's (or the calendar's) first length. */
  durationMinutes: lengthMinutes.optional(),
  serviceId: uuid.nullable().optional(),
  /** Who works it; missing lets the calendar choose (round robin, first available…). */
  userIds: z.array(uuid).min(1).max(10).optional(),
  /** The customer. */
  personId: uuid.nullable().optional(),
  partySize,
  title: title.optional(),
  notes: notesText,
  location: AppointmentLocation.optional(),
  leadId: uuid.nullable().optional(),
  /** Book anyway despite buffers, hours, busy times, time off or a time in the past. */
  acknowledgeWarnings: z.boolean().default(false),
  clientId: clientId.optional(),
  /**
   * Tell the customer: a confirmation by text or email ("Tell Mike"). Reminders follow the calendar's
   * settings either way.
   */
  notify: z.boolean().default(true),
});
export const AppointmentCreateOutput = z.object({
  appointmentId: uuid,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  userIds: z.array(uuid),
  warnings: z.array(AppointmentWarning),
  /** The same clientId booked already; nothing new was written. */
  duplicate: z.boolean(),
});
export const AppointmentUpdateInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  title: title.optional(),
  notes: notesText,
  location: AppointmentLocation.optional(),
  leadId: uuid.nullable().optional(),
});
export const AppointmentUpdateOutput = z.object({
  appointmentId: uuid,
  updated: z.array(z.string()),
});
export const AppointmentRescheduleInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  startsAt: isoDateTime,
  durationMinutes: lengthMinutes.optional(),
  acknowledgeWarnings: z.boolean().default(false),
  /** Tell the customer. */
  notify: z.boolean().default(true),
});
export const AppointmentRescheduleOutput = z.object({
  appointmentId: uuid,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  warnings: z.array(AppointmentWarning),
});
export const AppointmentReassignInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  userIds: z.array(uuid).min(1).max(10),
  acknowledgeWarnings: z.boolean().default(false),
  notify: z.boolean().default(true),
});
export const AppointmentReassignOutput = z.object({
  appointmentId: uuid,
  userIds: z.array(uuid),
  warnings: z.array(AppointmentWarning),
});
export const AppointmentCancelInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  reason,
  notify: z.boolean().default(true),
});
export const AppointmentCancelOutput = z.object({
  appointmentId: uuid,
  status: AppointmentStatusValue,
});
export const AppointmentSetStatusInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  status: z.enum(['completed', 'no_show']),
});
export const AppointmentSetStatusOutput = z.object({
  appointmentId: uuid,
  status: AppointmentStatusValue,
});
export const AppointmentAddAttendeeInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  personId: uuid,
  seats: z.int().min(1).max(100).default(1),
  /** Tell them: a confirmation by text or email. */
  notify: z.boolean().default(true),
});
export const AppointmentAddAttendeeOutput = z.object({
  appointmentId: uuid,
  attendeeId: uuid,
  seatsTaken: z.int(),
  capacity: z.int(),
});
export const AppointmentRemoveAttendeeInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  personId: uuid,
  notify: z.boolean().default(true),
});
export const AppointmentRemoveAttendeeOutput = z.object({
  appointmentId: uuid,
  seatsTaken: z.int(),
});

export const SessionPublishInput = z.object({
  workspaceId: uuid,
  calendarId: uuid,
  startsAt: isoDateTime,
  durationMinutes: lengthMinutes.optional(),
  serviceId: uuid.nullable().optional(),
  /**
   * Who runs it; missing lets the calendar choose. Leave it out on a calendar that books without staff.
   */
  userIds: z.array(uuid).min(1).max(10).optional(),
  /** Seats; defaults to the calendar's (or the service's). */
  capacity: z.int().min(1).max(1000).optional(),
  title: title.optional(),
  notes: notesText,
  location: AppointmentLocation.optional(),
  acknowledgeWarnings: z.boolean().default(false),
});
export const SessionPublishOutput = z.object({
  appointmentId: uuid,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  capacity: z.int(),
  warnings: z.array(AppointmentWarning),
});

export const SeriesCreateInput = z.object({
  workspaceId: uuid,
  calendarId: uuid,
  /** The first occurrence's local date, in the calendar's zone. */
  firstDate: localDate,
  rule: RecurrenceRule,
  durationMinutes: lengthMinutes.optional(),
  serviceId: uuid.nullable().optional(),
  userIds: z.array(uuid).min(1).max(10).optional(),
  personId: uuid.nullable().optional(),
  partySize,
  title: title.optional(),
  notes: notesText,
  location: AppointmentLocation.optional(),
  /** Sessions-mode calendars publish sessions with this many seats. */
  capacity: z.int().min(1).max(1000).optional(),
});
export const SeriesCreateOutput = z.object({
  seriesId: uuid,
  appointmentIds: z.array(uuid),
  /** Occurrences that did not fit, with the reason. */
  skipped: z.array(
    z.object({
      occurrence: z.int(),
      date: z.string(),
      startsAt: isoDateTime,
      reason: z.string(),
    }),
  ),
});
export const SeriesCancelInput = z.object({
  workspaceId: uuid,
  /** Any occurrence of the series. */
  appointmentId: uuid,
  scope: z.enum(['this', 'following', 'all']),
  reason,
  notify: z.boolean().default(true),
});
export const SeriesCancelOutput = z.object({ seriesId: uuid, cancelled: z.array(uuid) });

export const WaitlistAddInput = z
  .object({
    workspaceId: uuid,
    calendarId: uuid,
    /** A full session; or leave it out and give the wanted window for a 1:1 opening. */
    appointmentId: uuid.nullable().optional(),
    wantedFrom: isoDateTime.optional(),
    wantedTo: isoDateTime.optional(),
    personId: uuid,
    seats: z.int().min(1).max(100).default(1),
  })
  .refine((v) => !!v.appointmentId || (!!v.wantedFrom && !!v.wantedTo), {
    path: ['appointmentId'],
    error: 'Pick a session, or the times they want.',
  });
export const WaitlistAddOutput = z.object({ entryId: uuid, position: z.int() });
export const WaitlistRemoveInput = z.object({ workspaceId: uuid, entryId: uuid });
export const WaitlistRemoveOutput = z.object({ entryId: uuid });

// ---- Reading appointments ----

/** A booking's confirmation or one of its reminders, as the worker recorded it (reminder_state). */
export const ReminderEntry = z.object({
  status: z.enum(['scheduled', 'sent', 'skipped']),
  channel: z.enum(['sms', 'email']).nullable(),
  /**
   * Why it was skipped, went by email instead of text, or waits: booked_late, quiet_hours, cancelled,
   * started, reminders_off, opted_out, no_consent, no_phone, texting_not_ready, no_contact.
   */
  reason: z.string().nullable(),
  /** The start it was for: after a reschedule, an entry for the old start no longer applies. */
  startsAt: isoDateTime,
  /** When a scheduled one goes. */
  dueAt: isoDateTime.nullable(),
  /** When this was recorded. */
  at: isoDateTime,
  messageId: uuid.nullable(),
});
export type ReminderEntry = z.infer<typeof ReminderEntry>;
export const ReminderState = z.object({
  confirmation: ReminderEntry.nullable(),
  /** By reminder: 'day_before', or 'before_<minutes>' (the calendar's notification settings). */
  reminders: z.record(z.string(), ReminderEntry),
});
export type ReminderState = z.infer<typeof ReminderState>;

export const AppointmentAttendeeOut = z.object({
  id: uuid,
  personId: uuid,
  fullName: z.string(),
  status: AttendeeStatusValue,
  seats: z.int(),
});
export const AppointmentOut = z.object({
  id: uuid,
  calendar: z.object({ id: uuid, name: z.string(), color: z.string() }),
  service: z.object({ id: uuid, name: z.string() }).nullable(),
  kind: z.enum(['booking', 'session']),
  title: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  bufferBefore: z.int(),
  bufferAfter: z.int(),
  capacity: z.int(),
  seatsTaken: z.int(),
  status: AppointmentStatusValue,
  location: AppointmentLocation,
  seriesId: uuid.nullable(),
  occurrence: z.int().nullable(),
  source: AppointmentSourceValue,
  leadId: uuid.nullable(),
  notes: z.string().nullable(),
  staff: z.array(z.object({ userId: uuid, fullName: z.string(), role: z.enum(['host', 'crew']) })),
  resources: z.array(z.object({ resourceId: uuid, name: z.string(), quantity: z.int() })),
  attendees: z.array(AppointmentAttendeeOut),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type AppointmentOut = z.infer<typeof AppointmentOut>;

export const AppointmentListInput = z.object({
  workspaceId: uuid,
  from: isoDateTime,
  to: isoDateTime,
  userIds: z.array(uuid).max(100).optional(),
  resourceIds: z.array(uuid).max(100).optional(),
  calendarIds: z.array(uuid).max(100).optional(),
  /** Defaults to everything but cancelled. */
  status: z.array(AppointmentStatusValue).max(4).optional(),
  personId: uuid.optional(),
});
export const AppointmentListOutput = z.object({
  timezone: z.string(),
  items: z.array(AppointmentOut),
});
export const AppointmentGetInput = z.object({ workspaceId: uuid, appointmentId: uuid });
export const AppointmentGetOutput = z.object({
  appointment: AppointmentOut.extend({
    calendarRevision: z.int(),
    attendees: z.array(
      AppointmentAttendeeOut.extend({
        contactPhone: z.string().nullable(),
        contactEmail: z.string().nullable(),
        smsOk: z.boolean(),
        intake: z.record(z.string(), z.unknown()),
        source: AppointmentSourceValue,
        rescheduleCount: z.int(),
        cancelledAt: isoDateTime.nullable(),
        /** The confirmation and each reminder: scheduled, sent (by text or email) or skipped, and why. */
        reminders: ReminderState,
      }),
    ),
    series: z.object({ id: uuid, rule: z.record(z.string(), z.unknown()) }).nullable(),
    waitlist: z.array(
      z.object({
        id: uuid,
        personId: uuid,
        fullName: z.string(),
        seats: z.int(),
        status: z.string(),
        position: z.int(),
      }),
    ),
    createdBy: UserRef,
  }),
});

// ---- The booking page (system actor only) ----

export const OnlineCustomer = z
  .object({
    firstName: z.string().trim().max(80).default(''),
    lastName: z.string().trim().max(80).default(''),
    phone: phoneInput,
    email: optionalEmail,
  })
  .refine((c) => (c.firstName + c.lastName).trim().length > 0, {
    path: ['firstName'],
    error: 'Enter your name.',
  })
  .refine((c) => !!c.phone || !!c.email, {
    path: ['phone'],
    error: 'Enter a mobile number or an email.',
  });

export const AppointmentBookOnlineInput = z.object({
  workspaceId: uuid,
  calendarId: uuid,
  startsAt: isoDateTime,
  /** From the slot: joining an existing session or group time. */
  sessionId: uuid.nullable().optional(),
  serviceId: uuid.nullable().optional(),
  durationMinutes: lengthMinutes.optional(),
  partySize,
  locationKind: LocationKind.nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  chosenUserId: uuid.nullable().optional(),
  customer: OnlineCustomer,
  /** The unticked-by-default "Text me about this booking" box. */
  smsConsent: z.boolean().default(false),
  intake: IntakeAnswers.default(() => ({})),
  notes: z.string().trim().max(2000).nullable().optional(),
  /** The page's idempotency key: a retried submit books once. */
  clientId,
});
export const AppointmentBookOnlineOutput = z.object({
  appointmentId: uuid,
  attendeeId: uuid,
  /** Signed into the manage link with the attendee id. */
  manageVersion: z.int(),
  personId: uuid,
  personCreated: z.boolean(),
  leadId: uuid.nullable(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  userIds: z.array(uuid),
  joined: z.boolean(),
  duplicate: z.boolean(),
});
export const AttendeeRescheduleOnlineInput = z.object({
  workspaceId: uuid,
  attendeeId: uuid,
  manageVersion: z.int().min(1),
  startsAt: isoDateTime,
  sessionId: uuid.nullable().optional(),
});
export const AttendeeRescheduleOnlineOutput = z.object({
  appointmentId: uuid,
  attendeeId: uuid,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
});
export const AttendeeCancelOnlineInput = z.object({
  workspaceId: uuid,
  attendeeId: uuid,
  manageVersion: z.int().min(1),
  reason,
});
export const AttendeeCancelOnlineOutput = z.object({
  appointmentId: uuid,
  attendeeId: uuid,
  appointmentCancelled: z.boolean(),
});

/** How a booking was confirmed: a text (C, or YES while asked), the Confirm button, staff, or the AI teammate. */
export const confirmedVia = z.enum(['sms', 'link', 'staff', 'ai']);
/** attendee.confirm: staff mark a booking confirmed for the customer, or (Undo) take back their own mark. */
export const AttendeeConfirmInput = z.object({
  workspaceId: uuid,
  attendeeId: uuid,
  /** false takes back a confirmation someone on the team marked (a customer's own stays). */
  confirmed: z.boolean().default(true),
});
export const AttendeeConfirmOutput = z.object({
  appointmentId: uuid,
  attendeeId: uuid,
  confirmedAt: isoDateTime.nullable(),
  confirmedVia: confirmedVia.nullable(),
  /** False when it was already that way. */
  changed: z.boolean(),
});
/** attendee.confirm_online: the Confirm button on the customer's manage link. */
export const AttendeeConfirmOnlineInput = z.object({
  workspaceId: uuid,
  attendeeId: uuid,
  manageVersion: z.int().min(1),
});
export const AttendeeConfirmOnlineOutput = AttendeeConfirmOutput;
