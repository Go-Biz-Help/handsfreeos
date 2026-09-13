/**
 * The calendar settings document (`CalendarConfig`, version 1). One universal calendar: these modules alone
 * decide how it behaves. Browser-safe, so the builder validates with the same schema the server saves with.
 *
 * Mirrors kept by the save command: `public` → calendars.public, `team.members` → calendar_members,
 * `services.items` → calendar_services, `resources.required` → calendar_resources, and `schedule.hours`
 * → the calendar's row in `schedules` (owner_kind 'calendar').
 */
import { z } from 'zod';
import { isClock, isLocalDate, parseClock } from './engine/zoned';

export const CALENDAR_CONFIG_VERSION = 1;

const id = z.uuid();
const clock = z.string().refine(isClock, { error: 'Use a time like 09:00.' });
const localDate = z.string().refine(isLocalDate, { error: 'Use a date like 2026-10-01.' });
const length = z.int().min(5, 'At least 5 minutes.').max(720, 'At most 12 hours.');
const bufferMinutes = z.int().min(0).max(240, 'At most 4 hours.');
const uniqueBy =
  <K extends string>(key: K) =>
  (list: readonly Readonly<Record<K, string>>[]): boolean =>
    new Set(list.map((item) => item[key])).size === list.length;

export const WeeklyHours = z
  .array(
    z
      .object({ day: z.int().min(0).max(6), start: clock, end: clock })
      .refine((h) => parseClock(h.start) < parseClock(h.end), {
        error: 'End after the start.',
        path: ['end'],
      }),
  )
  .max(50);
export type WeeklyHours = z.infer<typeof WeeklyHours>;

export const AssignmentMode = z.enum([
  'fixed',
  'customer_choice',
  'round_robin',
  'weighted',
  'first_available',
  'collective',
  /** No staff: resources and hours alone decide what's bookable. */
  'none',
]);
export type AssignmentMode = z.infer<typeof AssignmentMode>;

export const LocationKind = z.enum(['customer_address', 'business', 'virtual', 'phone']);
export type LocationKind = z.infer<typeof LocationKind>;

export const IntakeKind = z.enum([
  'short_text',
  'long_text',
  'select',
  'multi_select',
  'checkbox',
  'number',
  'date',
]);

export const TeamMember = z.object({
  userId: id,
  /** Share for weighted round robin. */
  weight: z.int().min(1).max(100).default(1),
  /** First available asks the highest number first; ties go in list order. */
  priority: z.int().min(0).max(100).default(0),
  /** Collective: must attend. When nobody is marked, everyone must. */
  required: z.boolean().default(false),
});
export type TeamMember = z.infer<typeof TeamMember>;

const Team = z.object({
  members: z
    .array(TeamMember)
    .max(50, 'At most 50 people.')
    .refine(uniqueBy('userId'), { error: 'Each person can be added once.' })
    .default(() => []),
  assignment: AssignmentMode.default('fixed'),
  crewSize: z.int().min(1).max(10).default(1),
});

/** Per-service settings on this calendar; anything left out comes from the service or the calendar. */
export const ServiceOverrides = z.object({
  minutes: z.array(length).min(1).max(6).optional(),
  bufferBefore: bufferMinutes.optional(),
  bufferAfter: bufferMinutes.optional(),
  seats: z.int().min(1).max(500).optional(),
  maxPartySize: z.int().min(1).max(500).optional(),
  /** Only these people do this service here. */
  userIds: z.array(id).max(50).optional(),
});
export type ServiceOverrides = z.infer<typeof ServiceOverrides>;

const Services = z.object({
  mode: z.enum(['none', 'one', 'choice']).default('none'),
  items: z
    .array(z.object({ serviceId: id, overrides: ServiceOverrides.prefault({}) }))
    .max(50)
    .refine(uniqueBy('serviceId'), { error: 'Each service can be added once.' })
    .default(() => []),
});

const Durations = z.object({
  minutes: z
    .array(length)
    .min(1, 'Add a length.')
    .max(6, 'At most 6 lengths.')
    .default(() => [60]),
  customerChooses: z.boolean().default(false),
  /** Start times every this many minutes. */
  step: z.int().min(5).max(240).multipleOf(5).default(30),
});

const Capacity = z.object({
  seats: z.int().min(1).max(500).default(1),
  maxPartySize: z.int().min(1).max(500).default(1),
  showSeatsLeft: z.boolean().default(true),
});

const Schedule = z.object({
  mode: z.enum(['hours', 'sessions']).default('hours'),
  /** The calendar's own hours, an extra layer on top of each person's; null means people's hours alone. */
  hours: WeeklyHours.nullable().default(null),
});

const Location = z.object({
  kind: LocationKind,
  address: z.string().trim().max(300).nullable().default(null),
  meetingUrl: z.url().max(500).nullable().default(null),
});

const Locations = z.object({
  options: z
    .array(Location)
    .max(10)
    .default(() => []),
  customerChooses: z.boolean().default(false),
});

const RequiredResource = z.object({ resourceId: id, quantity: z.int().min(1).max(100).default(1) });
export type RequiredResource = z.infer<typeof RequiredResource>;

const Resources = z.object({
  required: z
    .array(RequiredResource)
    .max(20)
    .refine(uniqueBy('resourceId'), { error: 'Each resource can be added once.' })
    .default(() => []),
});

const Buffers = z.object({
  before: bufferMinutes.default(0),
  after: bufferMinutes.default(0),
  /** Added on both sides of customer-address visits only. */
  travelMinutes: bufferMinutes.default(0),
});

const Territory = z.object({
  routing: z.enum(['off', 'zip']).default('off'),
  /** Empty means every territory in the workspace. */
  territoryIds: z
    .array(id)
    .max(100)
    .default(() => []),
});

const Window = z
  .object({
    minNoticeMinutes: z
      .int()
      .min(0)
      .max(90 * 1440)
      .default(240),
    /** Customers can book through the end of the day this many days from today. */
    maxDaysAhead: z.int().min(1).max(365).default(60),
    dateFrom: localDate.nullable().default(null),
    dateTo: localDate.nullable().default(null),
    dailyLimitPerPerson: z.int().min(1).max(50).nullable().default(null),
  })
  .refine((w) => !w.dateFrom || !w.dateTo || w.dateFrom <= w.dateTo, {
    error: 'The end date comes before the start date.',
    path: ['dateTo'],
  });

const Recurring = z.object({
  staffSeries: z.boolean().default(true),
  customerSeries: z.boolean().default(false),
  maxOccurrences: z.int().min(1).max(52).default(12),
});

const Waitlist = z.object({
  enabled: z.boolean().default(false),
  offerMinutes: z.int().min(5).max(1440).default(60),
});

export const IntakeQuestion = z
  .object({
    id: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1, 'Write the question.').max(200),
    kind: IntakeKind,
    required: z.boolean().default(false),
    options: z
      .array(z.string().trim().min(1).max(100))
      .max(30)
      .default(() => []),
  })
  .refine((q) => (q.kind !== 'select' && q.kind !== 'multi_select') || q.options.length > 0, {
    error: 'Add at least one choice.',
    path: ['options'],
  });

const Intake = z.object({
  questions: z
    .array(IntakeQuestion)
    .max(20, 'At most 20 questions.')
    .refine(uniqueBy('id'), { error: 'Each question needs its own id.' })
    .default(() => []),
});

const Policies = z.object({
  cancel: z
    .object({
      allowed: z.boolean().default(true),
      cutoffHours: z.int().min(0).max(720).default(24),
    })
    .prefault({}),
  reschedule: z
    .object({
      allowed: z.boolean().default(true),
      cutoffHours: z.int().min(0).max(720).default(24),
      maxTimes: z.int().min(0).max(20).default(2),
    })
    .prefault({}),
  policyText: z.string().trim().max(2000).default(''),
});

export const Reminder = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('day_before'), at: clock.default('16:00') }),
  z.object({
    kind: z.literal('before'),
    minutes: z
      .int()
      .min(15)
      .max(7 * 1440),
  }),
]);
export type Reminder = z.infer<typeof Reminder>;

const Notifications = z.object({
  confirmation: z
    .object({ text: z.boolean().default(true), email: z.boolean().default(true) })
    .prefault({}),
  reminders: z
    .array(Reminder)
    .max(5)
    .default(() => [
      { kind: 'day_before' as const, at: '16:00' },
      { kind: 'before' as const, minutes: 120 },
    ]),
  reminderChannels: z
    .object({ text: z.boolean().default(true), email: z.boolean().default(true) })
    .prefault({}),
  staffEmail: z.boolean().default(true),
});

const Integrations = z.object({
  checkStaffCalendars: z.boolean().default(true),
  writeEvents: z.boolean().default(true),
});

const Crm = z.object({
  ownership: z.enum(['assigned_staff', 'calendar_owner', 'none']).default('assigned_staff'),
  assignContactOwner: z.boolean().default(false),
  createLead: z.object({ pipelineId: id, stageId: id }).nullable().default(null),
});

const Payments = z.object({ mode: z.enum(['none', 'deposit', 'full']).default('none') });

const Automations = z.object({
  workflowIds: z
    .array(id)
    .max(50)
    .default(() => []),
});

export const CalendarConfig = z.object({
  version: z.literal(CALENDAR_CONFIG_VERSION),
  /** Listed on the booking site and bookable by customers. */
  public: z.boolean().default(false),
  team: Team.prefault({}),
  services: Services.prefault({}),
  durations: Durations.prefault({}),
  capacity: Capacity.prefault({}),
  schedule: Schedule.prefault({}),
  locations: Locations.prefault({}),
  resources: Resources.prefault({}),
  buffers: Buffers.prefault({}),
  territory: Territory.prefault({}),
  window: Window.prefault({}),
  recurring: Recurring.prefault({}),
  waitlist: Waitlist.prefault({}),
  intake: Intake.prefault({}),
  policies: Policies.prefault({}),
  notifications: Notifications.prefault({}),
  integrations: Integrations.prefault({}),
  crm: Crm.prefault({}),
  payments: Payments.prefault({}),
  automations: Automations.prefault({}),
});
export type CalendarConfig = z.infer<typeof CalendarConfig>;
export type CalendarConfigInput = z.input<typeof CalendarConfig>;
export type CalendarModule = Exclude<keyof CalendarConfig, 'version' | 'public'>;

type Patch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: Patch<T[K]> }
    : T;
/** A partial settings document: objects merge, arrays and null replace. */
export type ConfigPatch = Patch<Omit<CalendarConfigInput, 'version'>>;

// ---- Versions ----

export type ConfigUpgrade = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Step n turns a version n document into version n + 1. Version 1 is the first, so there are none yet. */
export const CONFIG_UPGRADES: Readonly<Record<number, ConfigUpgrade>> = {};

export class ConfigVersionError extends Error {
  constructor(readonly version: number) {
    super(`These calendar settings (version ${version}) are newer than this app understands.`);
    this.name = 'ConfigVersionError';
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Runs the pure upgrade steps up to the current version. A document without a version is version 1. */
export function upgradeConfig(
  raw: unknown,
  steps: Readonly<Record<number, ConfigUpgrade>> = CONFIG_UPGRADES,
  target: number = CALENDAR_CONFIG_VERSION,
): Record<string, unknown> {
  let doc: Record<string, unknown> = isPlainObject(raw) ? { ...raw } : {};
  let version = typeof doc.version === 'number' && Number.isInteger(doc.version) ? doc.version : 1;
  if (version > target) throw new ConfigVersionError(version);
  while (version < target) {
    const step = steps[version];
    if (!step) throw new Error(`No upgrade from calendar settings version ${version}.`);
    doc = step(doc);
    version += 1;
  }
  return { ...doc, version };
}

/** Upgrades and validates a stored or submitted document, filling every default. Throws a ZodError when invalid. */
export function parseConfig(raw: unknown): CalendarConfig {
  return CalendarConfig.parse(upgradeConfig(raw));
}

export function defaultConfig(): CalendarConfig {
  return CalendarConfig.parse({ version: CALENDAR_CONFIG_VERSION });
}

// ---- Patching ----

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneJson(v);
    return out as T;
  }
  return value;
}

/** Deep merge without validation: objects merge key by key, arrays and null replace, undefined is ignored. */
export function mergePatch<T>(base: T, patch: unknown): T {
  if (patch === undefined) return cloneJson(base);
  if (!isPlainObject(patch) || !isPlainObject(base)) return cloneJson(patch) as T;
  const out: Record<string, unknown> = { ...(cloneJson(base) as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = mergePatch(base[key], value);
  }
  return out as T;
}

/** Applies a patch and validates the result (new array items get their defaults). Throws a ZodError when invalid. */
export function applyPatch(config: CalendarConfig, patch: ConfigPatch): CalendarConfig {
  return CalendarConfig.parse({ ...mergePatch(config, patch), version: config.version });
}
