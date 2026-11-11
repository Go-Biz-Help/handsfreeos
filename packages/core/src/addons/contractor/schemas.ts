/**
 * Contractor Operations' shapes (docs/contractor.md): what its operations take and answer, and the limits on what's
 * kept. Browser-safe: the web, the phone and the worker read them.
 */
import { z } from 'zod';
import {
  EstimateGetOutput as CoreEstimateGetOutput,
  EstimateSendInput as CoreEstimateSendInput,
  EstimateStateOutput as CoreEstimateStateOutput,
  MoneyLineInput,
  MoneyTerms,
} from '../../schemas/money';
import { COST_KINDS } from './estimating';
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
  /** The highest a lowest margin can be set: 90%. */
  minMarginBp: 9_000,
  /** The highest a starting markup can be set: 1,000%. */
  markupBp: 100_000,
  /** The most an hour of labor sells for or costs: $1 million. */
  hourCents: 100_000_000,
  /** The most one unit of anything costs: $1 billion, as a line's price. */
  unitCostCents: 100_000_000_000,
  okNote: 500,
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

export const CostKind = z.enum(COST_KINDS);
const unitCost = z
  .int()
  .min(0, 'Not below $0.')
  .max(LIMITS.unitCostCents, 'That’s more than $1 billion.');
const hourCents = z
  .int()
  .min(0, 'Not below $0.')
  .max(LIMITS.hourCents, 'That’s more than $1 million an hour.');

/** How the business estimates: its lowest margin, starting markup, and labor's price and cost per hour. */
export const Estimating = z.object({
  /** Basis points: 2,000 is 20%. An estimate under it waits for an OK (the owner's decision 6). */
  minMarginBp: z.int().min(0, 'From 0% to 90%.').max(LIMITS.minMarginBp, 'From 0% to 90%.'),
  /** What a new line's price starts at over its cost: 5,000 is 50%. */
  markupBp: z.int().min(0, 'From 0% up.').max(LIMITS.markupBp, 'Up to 1,000%.'),
  laborRateCents: hourCents,
  laborCostCents: hourCents,
});
export type Estimating = z.infer<typeof Estimating>;
export const OverviewOutput = z.object({
  name: z.string(),
  settings: ContractorSettingsSchema,
  /** What the person asking may do. */
  may: z.object({
    manage: z.boolean(),
    costs: z.boolean(),
    assign: z.boolean(),
    /** OK an estimate under the lowest margin, and set that margin. */
    approve: z.boolean(),
  }),
  /** How the business estimates; null for anyone who may not see job costs. */
  estimating: Estimating.nullable(),
  /** Estimates someone asked an OK for that hasn't been given; 0 for anyone who can't give one. */
  estimatesWaitingOk: z.int(),
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

// ---------- part 2: costs and estimates ----------

export const EstimatingSaveInput = Estimating.partial().extend({ workspaceId: uuid });
export const EstimatingSaveOutput = Estimating;

/** A price list item with what it costs the business. */
export const ItemCostRow = z.object({
  productId: uuid,
  name: z.string(),
  description: z.string().nullable(),
  /** Core's kind: a product, a service or a fee. */
  productKind: z.enum(['product', 'service', 'fee']),
  unitLabel: z.string(),
  unitPriceCents: z.number(),
  taxable: z.boolean(),
  /** How it's costed, and what one costs; null when nobody has said. */
  kind: CostKind,
  costCents: z.number().nullable(),
  marginBp: z.int().nullable(),
});
export const ItemCostListOutput = z.object({ items: z.array(ItemCostRow) });
export const ItemCostSetInput = z.object({
  workspaceId: uuid,
  productId: uuid,
  /** What one costs the business, in cents; null takes the cost off. */
  costCents: unitCost.nullable(),
  /** Labor (by the hour), a material, or anything else. Left out, a service is labor and the rest material. */
  kind: CostKind.optional(),
});
export const ItemCostSetOutput = z.object({ productId: uuid, changed: z.boolean() });

/** A line in the builder: core's line, with what kind of cost it is and what one unit costs. */
export const EstimateLineInput = MoneyLineInput.extend({
  kind: CostKind.default('material'),
  unitCostCents: unitCost.nullable().default(null),
});
export type EstimateLineInput = z.infer<typeof EstimateLineInput>;

export const EstimateSaveInput = z.object({
  workspaceId: uuid,
  /** Left out, a new estimate is written. */
  estimateId: uuid.optional(),
  /** The revision the builder loaded: someone else's save in between is kept and this one refused. */
  baseRevision: z.int().min(1).optional(),
  /** The job it's for. Its customer is who the estimate is for, unless one is named. */
  jobId: uuid.nullable().optional(),
  personId: uuid.optional(),
  title: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(5_000).nullable().optional(),
  discount: MoneyTerms.optional(),
  deposit: MoneyTerms.optional(),
  expiresOn: Day.nullable().optional(),
  /**
   * One option for one price, or two or three for good, better, best (the owner's decision 5). Each has every one of
   * its lines; an option's name is what the customer reads, and isn't needed for one price.
   */
  options: z
    .array(
      z.object({
        name: z.string().trim().max(60, 'Keep an option’s name under 60 characters.').default(''),
        lines: z.array(EstimateLineInput).min(1, 'Add at least one line.').max(200),
      }),
    )
    .min(1, 'Add at least one line.')
    .max(3, 'Three options at most.'),
});

/** One option, costed. `name` is null for an estimate with one price. */
export const OptionCostingOut = z.object({
  position: z.int(),
  name: z.string().nullable(),
  priceCents: z.number(),
  laborCents: z.number(),
  materialsCents: z.number(),
  otherCents: z.number(),
  costCents: z.number(),
  laborHours: z.number(),
  profitCents: z.number(),
  marginBp: z.int().nullable(),
  uncosted: z.int(),
});

/** Whether an estimate can go out, and what it's waiting on. */
export const MarginCheckOut = z.object({
  options: z.array(OptionCostingOut),
  lowest: z.object({ name: z.string().nullable(), marginBp: z.int().nullable() }).nullable(),
  minMarginBp: z.int(),
  uncosted: z.int(),
  /** Why it waits for an owner's or admin's OK; null when it doesn't. */
  needsOk: z.enum(['margin', 'uncosted']).nullable(),
  /** An OK that still stands: given for the estimate exactly as it is now. */
  ok: z
    .object({ by: z.string().nullable(), at: z.string(), note: z.string().nullable() })
    .nullable(),
  /** Someone asked for the OK. */
  asked: z.object({ by: z.string().nullable(), at: z.string() }).nullable(),
  /** It can be sent now: nothing to OK, or the OK stands. */
  canSend: z.boolean(),
});
export type MarginCheckOut = z.infer<typeof MarginCheckOut>;

export const EstimateSaveOutput = z.object({
  estimateId: uuid,
  revision: z.int(),
  totalCents: z.number(),
  created: z.boolean(),
  check: MarginCheckOut,
});

export const EstimateBuilderInput = z.object({
  workspaceId: uuid,
  /** Left out, the builder opens empty for `jobId`. */
  estimateId: uuid.optional(),
  jobId: uuid.optional(),
});
const PersonLite = z.object({
  id: uuid,
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});
export const EstimateBuilderOutput = z.object({
  /** Core's estimate, whole, as its own page reads it; null for a new one. */
  estimate: CoreEstimateGetOutput.shape.estimate.nullable(),
  /** What each line costs, by option (1 for one price) and the line's place in it. */
  costs: z.array(
    z.object({
      option: z.int(),
      line: z.int(),
      kind: CostKind,
      unitCostCents: z.number().nullable(),
    }),
  ),
  job: z.object({ id: uuid, name: z.string() }).nullable(),
  /** Who a new estimate is for: the job's customer. */
  person: PersonLite.nullable(),
  check: MarginCheckOut.nullable(),
  estimating: Estimating,
  may: z.object({ approve: z.boolean(), bill: z.boolean() }),
});

export const EstimateRefInput = z.object({ workspaceId: uuid, estimateId: uuid });
export const EstimateOkInput = EstimateRefInput.extend({
  note: z.string().trim().max(LIMITS.okNote).optional(),
});
export const EstimateOkOutput = z.object({ estimateId: uuid, changed: z.boolean() });
export const EstimateSendInput = CoreEstimateSendInput;
export const EstimateSendOutput = CoreEstimateStateOutput;

export const EstimateListInput = z.object({
  workspaceId: uuid,
  jobId: uuid.optional(),
  /** Only drafts someone asked an OK for that hasn't been given. */
  waitingOk: z.boolean().default(false),
});
export const EstimateListOutput = z.object({
  estimates: z.array(
    z.object({
      id: uuid,
      number: z.string().nullable(),
      status: z.string(),
      title: z.string().nullable(),
      customer: z.string(),
      totalCents: z.number(),
      /** 0 for one price; 2 or 3 for good, better, best. */
      optionCount: z.int(),
      /** The option they picked, once approved. */
      optionName: z.string().nullable(),
      job: z.object({ id: uuid, name: z.string() }).nullable(),
      asked: z.object({ by: z.string().nullable(), at: z.string() }).nullable(),
      /** An OK given for it exactly as it is now. */
      okStands: z.boolean(),
      createdAt: z.string(),
    }),
  ),
});

/** The worker: an approved estimate fills its job's price and budget. */
export const EstimateFillJobInput = z.object({ workspaceId: uuid, estimateId: uuid });
export const EstimateFillJobOutput = z.object({ jobId: uuid, estimates: z.int() }).nullable();
