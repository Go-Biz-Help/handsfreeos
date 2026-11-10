/**
 * Contractor Operations' shapes (docs/contractor.md): what its operations take and answer, and the limits on what's
 * kept. Browser-safe: the web, the phone and the worker read them.
 */
import { z } from 'zod';
import { JOB_KINDS, JOB_STATUSES, PHASE_STATUSES } from './progress';
import { TRADES } from './trades';

export const uuid = z.uuid();

export const LIMITS = {
  jobName: 200,
  address: 200,
  details: 4000,
  reason: 300,
  phaseName: 80,
  /** Phases on one project. */
  phases: 30,
  /** People on one job's team, besides its lead. */
  team: 20,
  /** Jobs one list answers at once. */
  list: 300,
  /** The most a price or a budget line may be: $100 million. */
  cents: 10_000_000_000,
  hours: 100_000,
} as const;

export const Trade = z.enum(TRADES);
export const JobKind = z.enum(JOB_KINDS);
export const JobStatus = z.enum(JOB_STATUSES);
export const PhaseStatus = z.enum(PHASE_STATUSES);

/** A day, `YYYY-MM-DD`: deadlines are days in the business's time zone. */
export const Day = z.iso.date();

const name = z
  .string()
  .trim()
  .min(1, 'Name the job.')
  .max(LIMITS.jobName, `Keep the name under ${LIMITS.jobName} characters.`);
const address = z
  .string()
  .trim()
  .min(1, 'Type the property’s address.')
  .max(LIMITS.address, `Keep the address under ${LIMITS.address} characters.`);
const details = z
  .string()
  .trim()
  .max(LIMITS.details, `Keep it under ${LIMITS.details.toLocaleString('en-US')} characters.`);
const phaseName = z
  .string()
  .trim()
  .min(1, 'Name the phase.')
  .max(LIMITS.phaseName, `Keep a phase’s name under ${LIMITS.phaseName} characters.`);
const percent = z.int().min(0, 'From 0 to 100.').max(100, 'From 0 to 100.');
const cents = z.int().min(0, 'Not below $0.').max(LIMITS.cents, 'That’s more than $100 million.');
const hours = z
  .number()
  .min(0, 'Not below 0 hours.')
  .max(LIMITS.hours)
  .refine((h) => Math.round(h * 100) === h * 100, { error: 'Two decimal places at most.' });

export const InWorkspace = z.object({ workspaceId: uuid });

// ---------- settings ----------

/** The business's settings (the owner's decision 1): the trades it does, and the phases a new project starts with. */
export const ContractorSettingsSchema = z.object({
  trades: z.array(Trade).max(TRADES.length).default([]),
  phases: z.array(phaseName).max(LIMITS.phases).default([]),
});
export type ContractorSettings = z.infer<typeof ContractorSettingsSchema>;

// ---------- jobs ----------

export const JobOpenInput = z.object({
  workspaceId: uuid,
  name,
  /** A service call (the default) or a project, which starts with phases. */
  kind: JobKind.default('service'),
  /** The customer it's for. */
  customerPersonId: uuid.nullable().optional(),
  /** One of the business's properties, or a new address (not both). */
  propertyId: uuid.nullable().optional(),
  newPropertyAddress: address.optional(),
  trade: Trade.nullable().optional(),
  /** Who runs it: the person starting it when left out. */
  leadUserId: uuid.nullable().optional(),
  startsOn: Day.nullable().optional(),
  dueOn: Day.nullable().optional(),
  details: details.optional(),
  /** A project's phases, in order: its starter phases when left out. */
  phases: z.array(phaseName).max(LIMITS.phases).optional(),
});
export const JobOpenOutput = z.object({
  jobId: uuid,
  name: z.string(),
  propertyId: uuid.nullable(),
  phases: z.int(),
});

export const JobUpdateInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  name: name.optional(),
  trade: Trade.nullable().optional(),
  startsOn: Day.nullable().optional(),
  dueOn: Day.nullable().optional(),
  details: details.nullable().optional(),
  leadUserId: uuid.nullable().optional(),
  /** null takes the customer off. */
  customerPersonId: uuid.nullable().optional(),
  /** null takes the property off; a new address makes one. */
  propertyId: uuid.nullable().optional(),
  newPropertyAddress: address.optional(),
});
export const JobChangeOutput = z.object({ jobId: uuid, changed: z.boolean() });

export const JobSetStatusInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  status: JobStatus,
  /** Why it's on hold or cancelled. */
  reason: z.string().trim().max(LIMITS.reason).optional(),
});
export const JobSetStatusOutput = z.object({
  jobId: uuid,
  status: JobStatus,
  changed: z.boolean(),
});

export const JobSetPercentInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  percentDone: percent,
});
export const JobSetPercentOutput = z.object({ jobId: uuid, percentDone: z.int() });

export const JobTeamInput = z.object({ workspaceId: uuid, jobId: uuid, userId: uuid });

export const JobMakeProjectInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  /** Its phases, in order: the starter phases when left out. */
  phases: z.array(phaseName).min(1).max(LIMITS.phases).optional(),
});
export const JobMakeProjectOutput = z.object({ jobId: uuid, phases: z.int() });

export const JobSetMoneyInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  /** Each left out stays as it is; null clears it. */
  priceCents: cents.nullable().optional(),
  laborCents: cents.nullable().optional(),
  materialsCents: cents.nullable().optional(),
  otherCents: cents.nullable().optional(),
  laborHours: hours.nullable().optional(),
});

// ---------- phases ----------

export const PhaseAddInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  name: phaseName,
  startsOn: Day.nullable().optional(),
  dueOn: Day.nullable().optional(),
});
export const PhaseAddOutput = z.object({ phaseId: uuid, jobId: uuid, madeProject: z.boolean() });

export const PhaseUpdateInput = z.object({
  workspaceId: uuid,
  phaseId: uuid,
  name: phaseName.optional(),
  status: PhaseStatus.optional(),
  percentDone: percent.optional(),
  startsOn: Day.nullable().optional(),
  dueOn: Day.nullable().optional(),
});
export const PhaseChangeOutput = z.object({
  phaseId: uuid,
  jobId: uuid,
  jobPercentDone: z.int(),
});

export const PhaseRemoveInput = z.object({ workspaceId: uuid, phaseId: uuid });
export const PhaseReorderInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  phaseIds: z.array(uuid).min(1).max(LIMITS.phases),
});

// ---------- reading ----------

const Person = z.object({ userId: uuid, name: z.string() });
const Customer = z.object({ personId: uuid, name: z.string() });
const Property = z.object({ recordId: uuid, name: z.string() });

export const JobRow = z.object({
  id: uuid,
  name: z.string(),
  kind: JobKind,
  status: JobStatus,
  statusAt: z.string(),
  statusReason: z.string().nullable(),
  trade: Trade.nullable(),
  percentDone: z.int(),
  startsOn: Day.nullable(),
  dueOn: Day.nullable(),
  /** Past its deadline and still open: how many days. */
  daysLate: z.int().nullable(),
  lead: Person.nullable(),
  customer: Customer.nullable(),
  property: Property.nullable(),
  phases: z.object({ count: z.int(), done: z.int() }),
  /** Its next booked visit. */
  nextVisitAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type JobRow = z.infer<typeof JobRow>;

export const JobListInput = z.object({
  workspaceId: uuid,
  /** `mine`: jobs I lead or am on the team of. `late`: open jobs past their deadline. */
  filter: z.enum(['all', 'mine', 'late']).default('all'),
  status: z.array(JobStatus).max(JOB_STATUSES.length).optional(),
  /** Done and cancelled ones too. */
  includeClosed: z.boolean().default(false),
  /** Words in its name, its customer's or its property's. */
  search: z.string().trim().max(100).optional(),
  customerPersonId: uuid.optional(),
  propertyId: uuid.optional(),
});
export const JobListOutput = z.object({ jobs: z.array(JobRow), truncated: z.boolean() });

export const Money = z.object({
  priceCents: z.int().nullable(),
  laborCents: z.int().nullable(),
  materialsCents: z.int().nullable(),
  otherCents: z.int().nullable(),
  laborHours: z.number().nullable(),
  totalCents: z.int().nullable(),
  profitCents: z.int().nullable(),
  marginBp: z.int().nullable(),
});

export const Phase = z.object({
  id: uuid,
  name: z.string(),
  position: z.int(),
  status: PhaseStatus,
  percentDone: z.int(),
  startsOn: Day.nullable(),
  dueOn: Day.nullable(),
  doneAt: z.string().nullable(),
  daysLate: z.int().nullable(),
});

export const JobGetInput = z.object({ workspaceId: uuid, jobId: uuid });
export const JobDetail = JobRow.extend({
  details: z.string().nullable(),
  doneAt: z.string().nullable(),
  archived: z.boolean(),
  team: z.array(Person),
  phaseList: z.array(Phase),
  visits: z.array(
    z.object({
      appointmentId: uuid,
      title: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
      status: z.string(),
    }),
  ),
  /** Only for people who may see job costs and profit (the owner's decision 11); null for everyone else. */
  money: Money.nullable(),
  /** The kind of record a job is here, for core's record page. */
  recordTypeId: uuid,
});

export const OverviewOutput = z.object({
  name: z.string(),
  settings: ContractorSettingsSchema,
  /** What the person asking may do. */
  may: z.object({ manage: z.boolean(), costs: z.boolean(), assign: z.boolean() }),
  counts: z.object({
    open: z.int(),
    late: z.int(),
    onHold: z.int(),
    doneThisMonth: z.int(),
  }),
  /** The business's today, `YYYY-MM-DD`, in its time zone. */
  today: Day,
  /** The kinds of record jobs and properties are here. */
  kinds: z.object({ job: uuid, property: uuid }),
  /** Everyone on the business's team who may use the add-on, for the people pickers. */
  people: z.array(Person),
});

export const PropertyListInput = z.object({
  workspaceId: uuid,
  /** The customer whose properties come first (or alone, with `onlyTheirs`). */
  customerPersonId: uuid.optional(),
  onlyTheirs: z.boolean().default(false),
  search: z.string().trim().max(100).optional(),
});
export const PropertyListOutput = z.object({
  properties: z.array(
    z.object({
      recordId: uuid,
      name: z.string(),
      owners: z.array(Customer),
      jobs: z.int(),
    }),
  ),
});

export const PropertyAddInput = z.object({
  workspaceId: uuid,
  address,
  /** The customer who owns it. */
  ownerPersonId: uuid.nullable().optional(),
});
export const PropertyAddOutput = z.object({ propertyId: uuid, name: z.string() });
