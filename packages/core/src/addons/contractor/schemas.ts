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
import { JOB_STATUSES as VISIT_STAGES } from '../../schemas/job';
import { WATCH, WATCH_LEVELS } from './budget-watch';
import { ITEM_KINDS } from './checklists';
import { REPORT_LIMITS } from './daily-report';
import { DRAFT_LIMITS } from './estimate-draft';
import { COST_KINDS } from './estimating';
import { DEFAULT_MATERIALS_ALERT_HOURS, MATERIAL_STATES } from './materials';
import { NOTE_LIMITS, TRANSCRIPT_STATES } from './notes';
import { JOB_KINDS, JOB_STATUSES, PHASE_STATUSES } from './progress';
import { PROFIT_GROUPS, PROFIT_PERIODS } from './job-costing';
import { TIME_KINDS, TIME_SOURCES } from './time';
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
  crewName: 60,
  /** Crews a business keeps at once, not counting archived ones. */
  crews: 50,
  /** People and subcontractors in one crew, each. */
  crewMembers: 30,
  /** Items on one work order's checklist, and in the business's starter checklist. */
  checklist: 40,
  itemLabel: 200,
  instructions: 4000,
  bring: 2000,
  /** Subcontractors on one visit. */
  subs: 20,
  subNote: 500,
  /** Visits one day's dispatch answers. */
  dispatch: 300,
  /** Materials on one job. */
  materials: 300,
  materialName: 200,
  unitLabel: 30,
  supplier: 120,
  materialNote: 500,
  /** The most of one material: a million of it. */
  quantity: 1_000_000,
  /** The longest before a visit its missing materials are told: two weeks. */
  alertHours: 336,
  /** Stretches of time one job's list answers, the newest first. */
  timeEntries: 500,
  /** Other costs on one job. */
  otherCosts: 200,
  otherCostName: 200,
  otherCostNote: 500,
  /** Jobs the profit page counts at once. */
  profitJobs: 2000,
} as const;

export const Trade = z.enum(TRADES);
export const JobKind = z.enum(JOB_KINDS);
export const JobStatus = z.enum(JOB_STATUSES);
export const PhaseStatus = z.enum(PHASE_STATUSES);
export const ItemKind = z.enum(ITEM_KINDS);
/** Where a visit stands, as its crew sets it in Calendar or on the phone (core's). */
export const VisitStage = z.enum(VISIT_STAGES);
export type VisitStage = z.infer<typeof VisitStage>;

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
const itemLabel = z
  .string()
  .trim()
  .min(1, 'Say what to check.')
  .max(LIMITS.itemLabel, `Keep an item under ${LIMITS.itemLabel} characters.`);
const crewName = z
  .string()
  .trim()
  .min(1, 'Name the crew.')
  .max(LIMITS.crewName, `Keep a crew’s name under ${LIMITS.crewName} characters.`);
const reason = z
  .string()
  .trim()
  .max(LIMITS.reason, `Keep the reason under ${LIMITS.reason} characters.`);
const percent = z.int().min(0, 'From 0 to 100.').max(100, 'From 0 to 100.');
const cents = z.int().min(0, 'Not below $0.').max(LIMITS.cents, 'That’s more than $100 million.');
const hours = z
  .number()
  .min(0, 'Not below 0 hours.')
  .max(LIMITS.hours)
  .refine((h) => Math.round(h * 100) === h * 100, { error: 'Two decimal places at most.' });

export const InWorkspace = z.object({ workspaceId: uuid });

// ---------- settings ----------

/** An item a new work order's checklist starts with. */
export const ChecklistStarter = z.object({
  label: itemLabel,
  kind: ItemKind.default('check'),
  /** The job can't be marked Done while it's left (the owner's decision 8). */
  required: z.boolean().default(false),
});

/**
 * The business's settings (the owner's decision 1): the trades it does, the phases a new project starts with, the
 * checklist a new visit's work order starts with, and how long before a visit it's told what materials are still
 * missing for it (0: never).
 */
export const ContractorSettingsSchema = z.object({
  trades: z.array(Trade).max(TRADES.length).default([]),
  phases: z.array(phaseName).max(LIMITS.phases).default([]),
  checklist: z.array(ChecklistStarter).max(LIMITS.checklist).default([]),
  materialsAlertHours: z
    .int()
    .min(0, 'Not below 0 hours.')
    .max(LIMITS.alertHours, 'Two weeks before at most.')
    .default(DEFAULT_MATERIALS_ALERT_HOURS),
  /** Tell the people who may see job costs when a job heads over its budget (part 7). */
  budgetWarnings: z.boolean().default(true),
  /** Write each job's daily report on its own, the evening of a day its crew left notes or photos (part 7). */
  dailyReports: z.boolean().default(true),
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
  /**
   * Done with required checklist items or photos still left on its work orders: why (the owner's decision 8). Only
   * people who may mark a job done that way; the items left are kept as passed over, with this.
   */
  skipReason: reason.optional(),
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

/** How far along a checklist is, and what still holds its job's Done. */
export const ChecklistProgress = z.object({
  total: z.int(),
  done: z.int(),
  requiredLeft: z.int(),
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
      /** Where its crew has it: on the way, started, done. */
      stage: VisitStage,
      /** The crew it was given to. */
      crew: z.string().nullable(),
      /** Its work order's checklist; null while it has no work order yet. */
      checklist: ChecklistProgress.nullable(),
      /** Materials needed on it that aren't all here yet. */
      materialsMissing: z.int(),
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
    /** Mark a job done with required checklist items left, with a reason. */
    skipChecks: z.boolean(),
    /** Change, add and remove the time tracked on jobs. */
    fixTime: z.boolean(),
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
  /** The AI's draft a new estimate was started from (part 7): it's marked used once this is saved. */
  draftId: uuid.optional(),
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

/** A line of an estimate the AI drafted: a builder's line, and whether its cost is the AI's guess. */
export const DraftedLine = z.object({
  productId: uuid.nullable(),
  name: z.string().trim().min(1).max(DRAFT_LIMITS.name),
  description: z.string().max(DRAFT_LIMITS.description).nullable(),
  quantity: z.number().positive().max(100_000),
  unitLabel: z.string().trim().min(1).max(DRAFT_LIMITS.unit),
  unitPriceCents: z.number().int().min(0).max(LIMITS.unitCostCents),
  taxable: z.boolean(),
  kind: CostKind,
  unitCostCents: z.number().int().min(0).max(LIMITS.unitCostCents).nullable(),
  /** On no price list: its cost is the AI's guess, and its price that cost at the business's starting markup. */
  guessed: z.boolean(),
});
/** What the AI drafted: a title, one option or two or three, what it assumed and what it couldn't tell. */
export const EstimateDraftBody = z.object({
  title: z.string().max(DRAFT_LIMITS.title).nullable(),
  options: z
    .array(
      z.object({
        name: z.string().max(60),
        lines: z.array(DraftedLine).min(1).max(DRAFT_LIMITS.lines),
      }),
    )
    .min(1)
    .max(DRAFT_LIMITS.options),
  assumptions: z.array(z.string().max(DRAFT_LIMITS.point)).max(DRAFT_LIMITS.assumptions),
  questions: z.array(z.string().max(DRAFT_LIMITS.point)).max(DRAFT_LIMITS.questions),
});
export type EstimateDraftBody = z.infer<typeof EstimateDraftBody>;

export const DraftState = z.enum(['ready', 'used', 'dismissed']);
/** An estimate the AI drafted for a job (part 7), as a list shows it. */
export const EstimateDraftSummary = z.object({
  id: uuid,
  jobId: uuid,
  state: DraftState,
  title: z.string().nullable(),
  /** What the person asking typed. */
  brief: z.string().nullable(),
  /** Who asked for it; null for someone who has left HandsFreeOS. */
  askedBy: z.string().nullable(),
  createdAt: z.string(),
  notesRead: z.int(),
  photosRead: z.int(),
  /** 1 for one price; 2 or 3 for good, better, best. */
  optionCount: z.int(),
  lines: z.int(),
  /** Lines whose cost is the AI's guess. */
  guessed: z.int(),
  questions: z.int(),
  /** The estimate a person saved from it. */
  estimateId: uuid.nullable(),
});
export const EstimateDraft = EstimateDraftSummary.extend({ draft: EstimateDraftBody });
export type EstimateDraft = z.infer<typeof EstimateDraft>;

export const EstimateBuilderInput = z.object({
  workspaceId: uuid,
  /** Left out, the builder opens empty for `jobId`. */
  estimateId: uuid.optional(),
  jobId: uuid.optional(),
  /** The AI's draft to start a new estimate from (part 7). */
  draftId: uuid.optional(),
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
  /**
   * The AI's draft (part 7): for a new estimate, the one to start from, with every line; for a saved one, the draft
   * it was started from. Null when the AI had no part.
   */
  draft: EstimateDraft.nullable(),
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
export const EstimateFillJobOutput = z
  .object({
    jobId: uuid,
    estimates: z.int(),
    /** How many of its material lines went onto the job's materials now. */
    materials: z.int(),
  })
  .nullable();

// ---------- materials (part 4, the owner's decision 9) ----------

export const MaterialState = z.enum(MATERIAL_STATES);
const materialName = z
  .string()
  .trim()
  .min(1, 'Say what the material is.')
  .max(LIMITS.materialName, `Keep its name under ${LIMITS.materialName} characters.`);
const unitLabel = z
  .string()
  .trim()
  .min(1, 'Say what it’s counted in, such as each, ft or box.')
  .max(LIMITS.unitLabel, `Keep the unit under ${LIMITS.unitLabel} characters.`);
const supplier = z
  .string()
  .trim()
  .max(LIMITS.supplier, `Keep the supplier under ${LIMITS.supplier} characters.`);
const materialNote = z
  .string()
  .trim()
  .max(LIMITS.materialNote, `Keep the note under ${LIMITS.materialNote} characters.`);
/** How much of a material: never below nothing, three decimal places at most. */
const quantity = z
  .number()
  .min(0, 'Not below 0.')
  .max(LIMITS.quantity, 'That’s more than a million.')
  .refine((q) => Math.abs(Math.round(q * 1000) - q * 1000) < 1e-6, {
    error: 'Three decimal places at most.',
  });

/** A material on a job, as everyone who uses the add-on reads it: never with what it costs. */
export const MaterialRow = z.object({
  id: uuid,
  position: z.int(),
  name: z.string(),
  unitLabel: z.string(),
  /** The price list item it is, when it was picked from the price list. */
  productId: uuid.nullable(),
  /** The visit it's for; null when it's for any visit on the job. */
  appointmentId: uuid.nullable(),
  needed: z.number(),
  ordered: z.number(),
  delivered: z.number(),
  used: z.number(),
  wasted: z.number(),
  returned: z.number(),
  /** Worked out (./materials.ts): how much still isn't here, how much is here and unused, and where it stands. */
  short: z.number(),
  left: z.number(),
  state: MaterialState,
  supplier: z.string().nullable(),
  /** The day it's expected. */
  expectedOn: Day.nullable(),
  note: z.string().nullable(),
  /** It came from an estimate the customer approved. */
  fromEstimate: z.boolean(),
  updatedAt: z.string(),
});
export type MaterialRow = z.infer<typeof MaterialRow>;

export const Material = MaterialRow.extend({
  /** What one costs the business. Only for people who may see job costs; null for everyone else, or with none. */
  unitCostCents: z.number().nullable(),
});
export type Material = z.infer<typeof Material>;

export const MaterialListInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  /** Only what's needed on this visit: the materials for it, and the ones for any visit. */
  appointmentId: uuid.optional(),
});
export const MaterialListOutput = z.object({
  jobId: uuid,
  materials: z.array(Material),
  /** How many of them aren't all here yet. */
  missing: z.int(),
  /** false while the job is done, cancelled or archived: its materials are read-only. */
  canChange: z.boolean(),
  /** Only for people who may see job costs (the owner's decision 11); null for everyone else. */
  costing: z
    .object({
      /** What everything the job needs costs. */
      plannedCents: z.number(),
      /** What the job has taken so far costs. */
      takenCents: z.number(),
      /** Materials with no cost yet, so both run low. */
      uncosted: z.int(),
    })
    .nullable(),
});

export const MaterialAddInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  /** Left out with a price list item, it's the item's name. */
  name: materialName.optional(),
  /** What it's counted in. Left out, the price list item's unit, else "each". */
  unitLabel: unitLabel.optional(),
  /** The price list item it is. Its cost is filled in from Costs. */
  productId: uuid.optional(),
  /** The visit it's for. Left out: any visit on the job. */
  appointmentId: uuid.optional(),
  needed: quantity.default(1),
  ordered: quantity.default(0),
  delivered: quantity.default(0),
  supplier: supplier.optional(),
  expectedOn: Day.optional(),
  note: materialNote.optional(),
  /** What one costs, in cents. Only people who may see job costs can give it. */
  unitCostCents: unitCost.optional(),
});
export const MaterialAddOutput = z.object({ materialId: uuid, jobId: uuid, name: z.string() });

export const MaterialUpdateInput = z.object({
  workspaceId: uuid,
  materialId: uuid,
  name: materialName.optional(),
  unitLabel: unitLabel.optional(),
  /** null: for any visit on the job. */
  appointmentId: uuid.nullable().optional(),
  needed: quantity.optional(),
  ordered: quantity.optional(),
  delivered: quantity.optional(),
  used: quantity.optional(),
  wasted: quantity.optional(),
  returned: quantity.optional(),
  supplier: supplier.nullable().optional(),
  expectedOn: Day.nullable().optional(),
  note: materialNote.nullable().optional(),
});
export const MaterialChangeOutput = z.object({
  materialId: uuid,
  jobId: uuid,
  changed: z.boolean(),
  /** Where it stands now; null once it's removed. */
  state: MaterialState.nullable(),
});

export const MaterialRefInput = z.object({ workspaceId: uuid, materialId: uuid });

/** How much more of a material: up or down, to three decimal places. */
const quantityMore = z
  .number()
  .min(-LIMITS.quantity, 'That’s more than a million.')
  .max(LIMITS.quantity, 'That’s more than a million.')
  .refine((q) => Math.abs(Math.round(q * 1000) - q * 1000) < 1e-6, {
    error: 'Three decimal places at most.',
  });
/**
 * Counting on the job (part 6): how much more was used, wasted or sent back since the last count, so two people
 * counting the same material both add up, and a count made with no signal lands right whenever it arrives.
 */
export const MaterialCountInput = z
  .object({
    workspaceId: uuid,
    materialId: uuid,
    /** How much more was used. Below 0 takes some back, never under nothing. */
    used: quantityMore.optional(),
    wasted: quantityMore.optional(),
    returned: quantityMore.optional(),
  })
  .refine((v) => !!v.used || !!v.wasted || !!v.returned, {
    error: 'Say how much more was used, wasted or sent back.',
    path: ['used'],
  });
export const MaterialCountOutput = MaterialChangeOutput.extend({
  /** The totals now. */
  used: z.number(),
  wasted: z.number(),
  returned: z.number(),
});

export const MaterialSetCostInput = MaterialRefInput.extend({
  /** What one costs the business, in cents; null takes the cost off. */
  unitCostCents: unitCost.nullable(),
});
export const MaterialSetCostOutput = z.object({
  materialId: uuid,
  jobId: uuid,
  changed: z.boolean(),
});

/** The worker: a material added by someone who can't see costs gets its price list item's cost. */
export const MaterialStampCostInput = MaterialRefInput;
export const MaterialStampCostOutput = z
  .object({ materialId: uuid, stamped: z.boolean() })
  .nullable();

// ---------- crews (part 3, the owner's decision 7) ----------

/** A subcontractor: a contact who doesn't sign in. */
const Sub = z.object({
  personId: uuid,
  name: z.string(),
  /** The company they're at, when Contacts knows it. */
  company: z.string().nullable(),
  /** They have a mobile number on file, so they can be texted the job's details. */
  canText: z.boolean(),
});

export const CrewSaveInput = z.object({
  workspaceId: uuid,
  /** Left out: a new crew, which needs a name. */
  crewId: uuid.optional(),
  name: crewName.optional(),
  /** The people on the business's team in it. Left out keeps them as they are; given, it's the whole list. */
  userIds: z.array(uuid).max(LIMITS.crewMembers).optional(),
  /** Its subcontractors, as contacts. Left out keeps them as they are; given, it's the whole list. */
  subPersonIds: z.array(uuid).max(LIMITS.crewMembers).optional(),
});
export const CrewSaveOutput = z.object({ crewId: uuid, name: z.string(), created: z.boolean() });

export const CrewArchiveInput = z.object({
  workspaceId: uuid,
  crewId: uuid,
  /** false brings an archived crew back. */
  archived: z.boolean().default(true),
});
export const CrewArchiveOutput = z.object({ crewId: uuid, archived: z.boolean() });

export const CrewListInput = z.object({
  workspaceId: uuid,
  includeArchived: z.boolean().default(false),
});
export const Crew = z.object({
  id: uuid,
  name: z.string(),
  archived: z.boolean(),
  people: z.array(Person),
  subs: z.array(Sub),
});
export const CrewListOutput = z.object({ crews: z.array(Crew) });

// ---------- a visit's work order (part 3, the owner's decision 8) ----------

const instructions = z
  .string()
  .trim()
  .max(
    LIMITS.instructions,
    `Keep it under ${LIMITS.instructions.toLocaleString('en-US')} characters.`,
  );
const bring = z
  .string()
  .trim()
  .max(LIMITS.bring, `Keep it under ${LIMITS.bring.toLocaleString('en-US')} characters.`);

export const WorkOrderStartInput = z.object({ workspaceId: uuid, appointmentId: uuid });
/** null (the worker only): the visit isn't on a job, so it has no work order. */
export const WorkOrderStartOutput = z
  .object({
    appointmentId: uuid,
    jobId: uuid,
    /** false: it had one already. */
    started: z.boolean(),
    items: z.int(),
  })
  .nullable();

export const WorkOrderUpdateInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  /** Each left out stays as it is; null or empty clears it. */
  instructions: instructions.nullable().optional(),
  bring: bring.nullable().optional(),
});
export const WorkOrderChangeOutput = z.object({ appointmentId: uuid, changed: z.boolean() });

export const WorkOrderSetCrewInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  /** null takes the crew's name off the visit; the people already on it stay. */
  crewId: uuid.nullable(),
  /** Put the crew on anyway when someone in it is busy, off or outside their hours then. */
  acknowledgeWarnings: z.boolean().default(false),
});
export const WorkOrderSetCrewOutput = z.object({
  appointmentId: uuid,
  crewId: uuid.nullable(),
  /** Everyone on the visit now. */
  userIds: z.array(uuid),
  /** Subcontractors the crew brought that weren't on the visit yet. */
  subsAdded: z.int(),
});

export const WorkOrderItemAddInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  label: itemLabel,
  kind: ItemKind.default('check'),
  required: z.boolean().default(false),
});
export const WorkOrderItemAddOutput = z.object({ itemId: uuid, appointmentId: uuid });

export const WorkOrderItemUpdateInput = z.object({
  workspaceId: uuid,
  itemId: uuid,
  label: itemLabel.optional(),
  kind: ItemKind.optional(),
  required: z.boolean().optional(),
});
export const WorkOrderItemRemoveInput = z.object({ workspaceId: uuid, itemId: uuid });

export const WorkOrderItemSetInput = z.object({
  workspaceId: uuid,
  itemId: uuid,
  done: z.boolean(),
  /** A photo item's photo: one of the job's files. Needed to mark a photo item done. */
  fileId: uuid.nullable().optional(),
});
export const WorkOrderItemOutput = z.object({
  itemId: uuid,
  appointmentId: uuid,
  jobId: uuid,
  done: z.boolean(),
  /** Required items still left on this work order. */
  requiredLeft: z.int(),
});

export const WorkOrderSubInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  /** The subcontractor, as a contact. */
  personId: uuid,
});
export const WorkOrderSubSetInput = WorkOrderSubInput.extend({
  /** The office marks a subcontractor's work: they don't sign in. */
  done: z.boolean(),
  note: z.string().trim().max(LIMITS.subNote).nullable().optional(),
});

export const WorkOrderTellSubsInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  /** Only these subcontractors; everyone on the visit when left out. */
  personIds: z.array(uuid).min(1).max(LIMITS.subs).optional(),
  /** A line of your own at the end of the text. */
  note: z.string().trim().max(300, 'Keep your note under 300 characters.').optional(),
  /** Send it during the business's quiet hours anyway. */
  acknowledgeQuietHours: z.boolean().default(false),
});
export const WorkOrderTellSubsOutput = z.object({
  appointmentId: uuid,
  told: z.array(z.object({ personId: uuid, name: z.string() })),
  /** Who wasn't texted, and why, in words to show. */
  notTold: z.array(z.object({ personId: uuid, name: z.string(), why: z.string() })),
});

export const WorkOrderGetInput = z.object({ workspaceId: uuid, appointmentId: uuid });
export const ChecklistItem = z.object({
  id: uuid,
  position: z.int(),
  label: z.string(),
  kind: ItemKind,
  required: z.boolean(),
  done: z.boolean(),
  doneAt: z.string().nullable(),
  doneBy: z.string().nullable(),
  /** A photo item's photo. */
  file: z.object({ id: uuid, name: z.string() }).nullable(),
  /** An owner or admin marked the job done without it. */
  skipped: z.object({ by: z.string().nullable(), at: z.string(), reason: z.string() }).nullable(),
});
export const VisitSub = Sub.extend({
  toldAt: z.string().nullable(),
  done: z.boolean(),
  doneAt: z.string().nullable(),
  doneBy: z.string().nullable(),
  note: z.string().nullable(),
});
export const WorkOrder = z.object({
  appointmentId: uuid,
  /** false until its work order is started: nothing is kept for it yet. */
  started: z.boolean(),
  visit: z.object({
    title: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    /** Core's: scheduled, completed, cancelled or no_show. */
    status: z.string(),
    stage: VisitStage,
  }),
  job: z.object({
    id: uuid,
    name: z.string(),
    kind: JobKind,
    status: JobStatus,
    trade: Trade.nullable(),
    details: z.string().nullable(),
    customer: Customer.nullable(),
    property: Property.nullable(),
  }),
  crew: z.object({ id: uuid, name: z.string() }).nullable(),
  /** The people on the business's team going: the visit's own (core's). */
  people: z.array(Person),
  subs: z.array(VisitSub),
  instructions: z.string().nullable(),
  bring: z.string().nullable(),
  items: z.array(ChecklistItem),
  progress: ChecklistProgress,
  /** The job's materials needed on this visit: the ones for it, and the ones for any visit. Never with costs. */
  materials: z.array(MaterialRow),
});

// ---------- dispatch (part 3) ----------

export const DispatchInput = z.object({
  workspaceId: uuid,
  /** The day to show, in the business's time zone: today when left out. */
  day: Day.optional(),
});
export const DispatchVisit = z.object({
  appointmentId: uuid,
  title: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  stage: VisitStage,
  job: z.object({ id: uuid, name: z.string(), status: JobStatus }),
  customer: z.string().nullable(),
  property: z.string().nullable(),
  crew: z.string().nullable(),
  /** Who's on it; empty when nobody is yet. */
  userIds: z.array(uuid),
  subs: z.object({ total: z.int(), done: z.int() }),
  /** null while it has no work order yet. */
  checklist: ChecklistProgress.nullable(),
  /** Materials needed on it that aren't all here yet. */
  materialsMissing: z.int(),
});
export const DispatchOutput = z.object({
  day: Day,
  today: Day,
  timeZone: z.string(),
  /** The day's visits on jobs, earliest first; cancelled ones left out. */
  visits: z.array(DispatchVisit),
  /** Everyone on one of them, by name. */
  people: z.array(Person),
  /** Open jobs with nothing booked from today on. */
  needsVisit: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      status: JobStatus,
      customer: Customer.nullable(),
      property: z.string().nullable(),
      dueOn: Day.nullable(),
      daysLate: z.int().nullable(),
    }),
  ),
  truncated: z.boolean(),
});

// ---------- time (part 5) ----------

export const TimeKind = z.enum(TIME_KINDS);
export const TimeSource = z.enum(TIME_SOURCES);
/** A moment, as ISO text with its offset or Z. */
const moment = z.iso.datetime({ offset: true });
const fixReason = z
  .string()
  .trim()
  .min(1, 'Say why, so the next person knows.')
  .max(LIMITS.reason, `Keep the reason under ${LIMITS.reason} characters.`);

/** One stretch of one person's time on a job. Never with what it cost. */
export const TimeEntry = z.object({
  id: uuid,
  /** Null for someone who has left HandsFreeOS. */
  userId: uuid.nullable(),
  name: z.string(),
  /** The visit it was on; null once that visit is deleted for good. */
  appointmentId: uuid.nullable(),
  kind: TimeKind,
  startedAt: z.string(),
  /** Null while it's running. */
  endedAt: z.string().nullable(),
  /** How long it is, up to now while it's running. */
  seconds: z.int(),
  source: TimeSource,
  /** Left running too long and stopped on its own: worth a look. */
  autoStopped: z.boolean(),
  fixed: z.object({ by: z.string().nullable(), at: z.string(), reason: z.string() }).nullable(),
});
export const TimeListInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  /** Only one visit's time. */
  appointmentId: uuid.optional(),
});
export const TimeListOutput = z.object({
  jobId: uuid,
  /** The newest first. */
  entries: z.array(TimeEntry),
  totals: z.object({
    workSeconds: z.int(),
    travelSeconds: z.int(),
    breakSeconds: z.int(),
    /** Work and travel: the time that's labor. */
    paidSeconds: z.int(),
    running: z.int(),
  }),
  /** What the person asking is doing right now on this job (or this visit), if they're on the clock. */
  mine: z.object({ entryId: uuid, appointmentId: uuid.nullable(), kind: TimeKind }).nullable(),
  may: z.object({ fix: z.boolean() }),
  truncated: z.boolean(),
});

/** The worker: a visit's status moved, so its people's clocks start or stop. */
export const TimeFollowStatusInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  /** Core's status for the visit now: on_the_way, in_progress, waiting_on_parts, done, scheduled, cancelled. */
  status: z.string().max(40),
  /** When the button was really pressed. */
  at: moment,
  /** Who pressed it: their clock starts when nobody is on the visit. */
  byUserId: uuid.nullable().optional(),
});
export const TimeFollowStatusOutput = z
  .object({ jobId: uuid, appointmentId: uuid, started: z.int(), stopped: z.int() })
  .nullable();

export const TimeSetBreakInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  /** true: take a break; false: back to work. */
  onBreak: z.boolean(),
  /** Someone else's break, for people who may fix time. Left out: the person asking. */
  userId: uuid.optional(),
});
export const TimeSetBreakOutput = z.object({
  jobId: uuid,
  appointmentId: uuid,
  userId: uuid,
  name: z.string(),
  onBreak: z.boolean(),
  changed: z.boolean(),
});

export const TimeFixInput = z.object({
  workspaceId: uuid,
  entryId: uuid,
  startedAt: moment.optional(),
  endedAt: moment.optional(),
  kind: TimeKind.optional(),
  reason: fixReason,
});
export const TimeAddInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  /** The visit it was on, if it was on one. */
  appointmentId: uuid.optional(),
  userId: uuid,
  kind: TimeKind.default('work'),
  startedAt: moment,
  endedAt: moment,
  reason: fixReason,
});
export const TimeRemoveInput = z.object({ workspaceId: uuid, entryId: uuid, reason: fixReason });
export const TimeChangeOutput = z.object({
  entryId: uuid,
  jobId: uuid,
  name: z.string(),
  changed: z.boolean(),
});

/** The worker: time with no cost yet gets what an hour of that person costs now. */
export const TimeStampCostsInput = z.object({
  workspaceId: uuid,
  jobId: uuid.optional(),
  userId: uuid.optional(),
});
export const TimeStampCostsOutput = z.object({ stamped: z.int() });

/** The worker: a visit's time left running past the limit is stopped there. */
export const TimeStopOverrunInput = z.object({ workspaceId: uuid, appointmentId: uuid });
export const TimeStopOverrunOutput = z.object({
  jobId: uuid.nullable(),
  job: z.string().nullable(),
  /** Whose time was stopped now. */
  stopped: z.array(z.string()),
  /** Everyone with a stretch on the visit that was stopped this way and still waits for a look. */
  flagged: z.array(z.string()),
  /** When to look again: the moment the next one still running reaches the limit. */
  nextAt: z.string().nullable(),
});

// ---------- what an hour of each person costs (part 5) ----------

export const LaborRateListInput = z.object({ workspaceId: uuid });
export const LaborRateListOutput = z.object({
  /** Everyone who may use the add-on, with what an hour of them costs; null when nobody has said. */
  people: z.array(z.object({ userId: uuid, name: z.string(), costCents: z.number().nullable() })),
  /** What an hour of labor costs when a person has no cost of their own (Estimating); 0 when that isn't set. */
  fallbackCents: z.number(),
  canChange: z.boolean(),
});
export const LaborRateSetInput = z.object({
  workspaceId: uuid,
  userId: uuid,
  /** What an hour of them costs the business; null takes it off. */
  costCents: hourCents.nullable(),
});
export const LaborRateSetOutput = z.object({
  userId: uuid,
  name: z.string(),
  changed: z.boolean(),
});

// ---------- what else a job cost, and job costing (part 5) ----------

const otherCostName = z
  .string()
  .trim()
  .min(1, 'Say what it was for.')
  .max(LIMITS.otherCostName, `Keep it under ${LIMITS.otherCostName} characters.`);
export const OtherCost = z.object({
  id: uuid,
  name: z.string(),
  amountCents: z.number(),
  spentOn: Day,
  note: z.string().nullable(),
});
export const OtherCostAddInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  name: otherCostName,
  amountCents: cents,
  /** The day it was spent: today when left out. */
  spentOn: Day.optional(),
  note: z
    .string()
    .trim()
    .max(LIMITS.otherCostNote, `Keep the note under ${LIMITS.otherCostNote} characters.`)
    .optional(),
});
export const OtherCostRemoveInput = z.object({ workspaceId: uuid, costId: uuid });
export const OtherCostOutput = z.object({ costId: uuid, jobId: uuid, name: z.string() });

const CostLine = z.object({
  budgetCents: z.number().nullable(),
  actualCents: z.number(),
  headingCents: z.number(),
});
export const WatchLevel = z.enum(WATCH_LEVELS);
export const JobCostingInput = z.object({ workspaceId: uuid, jobId: uuid });
export const JobCostingOutput = z.object({
  jobId: uuid,
  name: z.string(),
  status: JobStatus,
  percentDone: z.int(),
  labor: CostLine,
  materials: CostLine,
  other: CostLine,
  total: CostLine,
  hours: z.object({ budget: z.number().nullable(), actual: z.number(), heading: z.number() }),
  priceCents: z.number().nullable(),
  profit: z.object({
    plannedCents: z.number().nullable(),
    plannedMarginBp: z.number().nullable(),
    soFarCents: z.number().nullable(),
    headingCents: z.number().nullable(),
    headingMarginBp: z.number().nullable(),
  }),
  /** How far over its planned cost it's heading; null when no cost was planned. */
  overCents: z.number().nullable(),
  finished: z.boolean(),
  uncostedHours: z.number(),
  uncostedMaterials: z.int(),
  /** The business's lowest margin: a job heading under it is worth a look. */
  minMarginBp: z.int(),
  underMargin: z.boolean(),
  /** Labor by person: their hours on the job and what they cost. */
  people: z.array(
    z.object({
      userId: uuid.nullable(),
      name: z.string(),
      hours: z.number(),
      costCents: z.number(),
    }),
  ),
  otherCosts: z.array(OtherCost),
  /** A done job's costs can still be put right; an archived job's can't. */
  canChange: z.boolean(),
  /**
   * Where its budget stands now (part 7): within plan, heading over, heading under the lowest margin, or heading for
   * a loss; and what the AI said is driving it, once it has.
   */
  watch: z.object({
    level: WatchLevel,
    overPercent: z.number().nullable(),
    why: z.string().nullable(),
    suggestions: z.array(z.string()),
    /** When the people who may see job costs were last told. */
    warnedAt: z.string().nullable(),
  }),
});

export const ProfitGroup = z.enum(PROFIT_GROUPS);
export const ProfitPeriod = z.enum(PROFIT_PERIODS);
export const ProfitInput = z.object({
  workspaceId: uuid,
  /** Jobs done this month, last month, this quarter, this year or ever; or the open jobs, at what they head for. */
  period: ProfitPeriod.default('month'),
  by: ProfitGroup.default('job'),
});
const ProfitRow = z.object({
  /** The job's id, the customer's, the crew's, or the trade; null for jobs with none. */
  key: z.string().nullable(),
  name: z.string().nullable(),
  jobs: z.int(),
  priceCents: z.number(),
  costCents: z.number(),
  profitCents: z.number(),
  marginBp: z.number().nullable(),
  laborHours: z.number(),
});
export const ProfitOutput = z.object({
  period: ProfitPeriod,
  by: ProfitGroup,
  /** The days the period covers, in the business's time zone; null for all time and for open jobs. */
  from: Day.nullable(),
  to: Day.nullable(),
  total: ProfitRow,
  rows: z.array(ProfitRow),
  minMarginBp: z.int(),
  truncated: z.boolean(),
});

// ---------- notes from the field (part 6) ----------

export const TranscriptState = z.enum(TRANSCRIPT_STATES);
const noteBody = z
  .string()
  .trim()
  .min(1, 'Write the note first.')
  .max(NOTE_LIMITS.body, 'Keep a note to 4,000 characters.');

export const NoteAddInput = z
  .object({
    workspaceId: uuid,
    jobId: uuid,
    /** The note's own id, made by the phone, so one sent twice is added once. Left out, it gets one. */
    id: uuid.optional(),
    /** The visit it was taken on. */
    appointmentId: uuid.optional(),
    body: noteBody.optional(),
    /** A recording, already one of the job's files. Its words follow on their own. */
    audioFileId: uuid.optional(),
    /** Photos, already among the job's files. */
    photoFileIds: z
      .array(uuid)
      .max(NOTE_LIMITS.photos, `Up to ${NOTE_LIMITS.photos} photos on a note.`)
      .default([]),
  })
  .refine((v) => !!v.body || !!v.audioFileId || v.photoFileIds.length > 0, {
    error: 'Write a note, record one or add a photo.',
    path: ['body'],
  });
export const NoteAddOutput = z.object({
  noteId: uuid,
  jobId: uuid,
  appointmentId: uuid.nullable(),
});
export const NoteRefInput = z.object({ workspaceId: uuid, noteId: uuid });
export const NoteRemoveOutput = z.object({ noteId: uuid, jobId: uuid, removed: z.boolean() });

/** The worker's: a recording's words, or that they couldn't be made. */
export const NoteTranscribedInput = z.object({
  workspaceId: uuid,
  noteId: uuid,
  transcript: z.string().max(NOTE_LIMITS.transcript).nullable(),
});
export const NoteTranscribedOutput = z
  .object({ noteId: uuid, jobId: uuid, changed: z.boolean() })
  .nullable();

export const Note = z.object({
  id: uuid,
  /** The visit it was taken on; null for the job itself, or once that visit is deleted for good. */
  appointmentId: uuid.nullable(),
  body: z.string().nullable(),
  /** A voice note: its recording (null once the file is gone), and its words once they come. */
  audio: z
    .object({
      fileId: uuid.nullable(),
      transcript: z.string().nullable(),
      state: TranscriptState,
    })
    .nullable(),
  /** Its photos' files, in the order they were taken. */
  photoFileIds: z.array(uuid),
  /** Who left it; null for someone who has left HandsFreeOS. */
  by: Person.nullable(),
  /** When it was taken. */
  notedAt: z.string(),
});
export type Note = z.infer<typeof Note>;

export const NoteListInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  /** Only the notes taken on one visit. */
  appointmentId: uuid.optional(),
});
export const NoteListOutput = z.object({
  jobId: uuid,
  /** The newest first. */
  notes: z.array(Note),
  /** The names of the files the notes point at (recordings and photos), for a link to each. */
  files: z.array(z.object({ id: uuid, name: z.string() })),
  may: z.object({
    /** Take off anyone's note, not only one's own. */
    removeAny: z.boolean(),
  }),
  truncated: z.boolean(),
});

// ---------- the AI helpers (part 7) ----------

/** What a person types when asking for a draft: the work wanted, and measurements. */
const brief = z
  .string()
  .trim()
  .max(DRAFT_LIMITS.brief, 'Keep it under 4,000 characters.')
  .nullable()
  .optional();

/** The worker: everything the AI reads to draft an estimate for a job. */
export const EstimateDraftSourceInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  brief,
  /** One price, or good, better and best. */
  options: z.union([z.literal(1), z.literal(3)]).default(1),
});
export const EstimateDraftSourceOutput = z.object({
  job: z.object({
    name: z.string(),
    kind: z.string(),
    trade: z.string().nullable(),
    details: z.string().nullable(),
    property: z.string().nullable(),
  }),
  brief: z.string().nullable(),
  notes: z.array(
    z.object({ by: z.string().nullable(), when: z.string(), text: z.string(), photos: z.int() }),
  ),
  /** The newest photos on the job's notes, for the AI to look at. */
  photoFileIds: z.array(uuid),
  items: z.array(
    z.object({
      productId: uuid,
      name: z.string(),
      description: z.string().nullable(),
      unitLabel: z.string(),
      unitPriceCents: z.number(),
      taxable: z.boolean(),
      kind: CostKind,
      costCents: z.number().nullable(),
    }),
  ),
  estimating: z.object({
    markupBp: z.int(),
    laborRateCents: z.number(),
    laborCostCents: z.number(),
  }),
  options: z.union([z.literal(1), z.literal(3)]),
});

/** The worker: the AI's draft, checked, kept beside the job for a person to open. */
export const EstimateDraftKeepInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  brief,
  draft: EstimateDraftBody,
  notesRead: z.int().min(0).max(1000).default(0),
  photosRead: z.int().min(0).max(100).default(0),
});
export const EstimateDraftKeepOutput = z.object({
  draftId: uuid,
  jobId: uuid,
  optionCount: z.int(),
  lines: z.int(),
  guessed: z.int(),
  questions: z.int(),
});

export const EstimateDraftListInput = z.object({ workspaceId: uuid, jobId: uuid });
export const EstimateDraftListOutput = z.object({
  jobId: uuid,
  /** The ones still waiting for someone, the newest first. */
  drafts: z.array(EstimateDraftSummary),
});
export const EstimateDraftDismissInput = z.object({ workspaceId: uuid, draftId: uuid });
export const EstimateDraftDismissOutput = z.object({
  draftId: uuid,
  jobId: uuid,
  changed: z.boolean(),
});

/** The worker: looks at where a job's budget stands, and answers whether people should be told. */
export const BudgetCheckInput = z.object({ workspaceId: uuid, jobId: uuid });
export const BudgetCheckOutput = z
  .object({
    jobId: uuid,
    level: WatchLevel,
    /** It got worse: the people who may see job costs are told, with these words. */
    alert: z.object({ title: z.string(), detail: z.string() }).nullable(),
    /** Back within its plan, finished, or warnings are off: any alert is cleared. */
    clear: z.boolean(),
    /** What to ask the AI about it, when it's news. */
    ask: z.string().nullable(),
  })
  .nullable();

/** The worker: what the AI said is driving a job over its budget, and what the business could do. */
export const BudgetAdviseInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  why: z.string().trim().min(1).max(WATCH.why),
  suggestions: z.array(z.string().trim().min(1).max(WATCH.suggestion)).max(WATCH.suggestions),
});
export const BudgetAdviseOutput = z.object({ jobId: uuid, kept: z.boolean() });

const reportPoints = z
  .array(z.string().trim().max(REPORT_LIMITS.point))
  .max(REPORT_LIMITS.points, 'Eight lines at most in each part.');
/** A report's words. */
export const ReportBody = z.object({
  summary: z
    .string()
    .trim()
    .min(1, 'Write a summary of the day.')
    .max(REPORT_LIMITS.summary, 'Keep the summary under 900 characters.'),
  done: reportPoints.default([]),
  issues: reportPoints.default([]),
  materials: reportPoints.default([]),
  next: reportPoints.default([]),
  /** The update for the customer; null when there's none. */
  forCustomer: z
    .string()
    .trim()
    .max(REPORT_LIMITS.forCustomer, 'Keep the customer’s update under 1,200 characters.')
    .nullable()
    .default(null),
});

/** A job's daily report (part 7). */
export const DailyReport = z.object({
  id: uuid,
  /** The business's own day, `YYYY-MM-DD`. */
  day: Day,
  summary: z.string(),
  done: z.array(z.string()),
  issues: z.array(z.string()),
  materials: z.array(z.string()),
  next: z.array(z.string()),
  forCustomer: z.string().nullable(),
  /** Who was on the clock that day, and for how many hours. */
  crew: z.array(z.object({ name: z.string(), hours: z.number() })),
  /** The day's photos' files. */
  photoFileIds: z.array(uuid),
  notesRead: z.int(),
  photosRead: z.int(),
  writtenAt: z.string(),
  /** Who pressed Write; null when it was written on its own. */
  askedBy: z.string().nullable(),
  /** A person changed its words. */
  edited: z.object({ by: z.string().nullable(), at: z.string() }).nullable(),
  /** The customer's update, once someone sent it. */
  sent: z
    .object({ by: z.string().nullable(), at: z.string(), channel: z.enum(['email', 'sms']) })
    .nullable(),
});
export type DailyReport = z.infer<typeof DailyReport>;

export const ReportListInput = z.object({ workspaceId: uuid, jobId: uuid });
export const ReportListOutput = z.object({
  jobId: uuid,
  /** The newest day first. */
  reports: z.array(DailyReport),
  /** The names of the photos' files, for a link to each. */
  files: z.array(z.object({ id: uuid, name: z.string() })),
  /** The business's today. */
  today: Day,
  /** Reports are written on their own each evening (the business's setting). */
  onItsOwn: z.boolean(),
  /** Who a customer's update goes to, and how they can be reached; null when the job has no customer. */
  customer: z.object({ name: z.string(), email: z.boolean(), sms: z.boolean() }).nullable(),
  /** The job isn't archived: a report can be written, changed and sent. */
  canChange: z.boolean(),
  truncated: z.boolean(),
});

/** The worker: everything the AI reads to write one day's report. */
export const ReportSourceInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  /** The business's today when left out. */
  day: Day.optional(),
});
export const ReportSourceOutput = z.object({
  jobId: uuid,
  day: Day,
  job: z.object({
    name: z.string(),
    kind: z.string(),
    trade: z.string().nullable(),
    percentDone: z.int(),
    customerFirstName: z.string().nullable(),
  }),
  business: z.string(),
  dayWords: z.string(),
  notes: z.array(
    z.object({
      by: z.string().nullable(),
      at: z.string(),
      visit: z.string().nullable(),
      text: z.string(),
      photos: z.int(),
    }),
  ),
  ticked: z.array(z.string()),
  crew: z.array(z.object({ name: z.string(), hours: z.number() })),
  visits: z.array(z.object({ title: z.string(), status: z.string() })),
  /** The day's photos, the oldest first: the report keeps them all, and the AI looks at the first few. */
  photoFileIds: z.array(uuid),
  /** Notes whose words are still on their way. */
  waitingWords: z.int(),
  /** The report already kept for the day, when there is one. */
  existing: z.object({ id: uuid, edited: z.boolean() }).nullable(),
  /** The business has reports written on their own. */
  onItsOwn: z.boolean(),
});

/** The worker: a day's report, written. */
export const ReportKeepInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  day: Day,
  body: ReportBody,
  crew: z
    .array(z.object({ name: z.string().max(200), hours: z.number().min(0).max(1000) }))
    .max(50)
    .default([]),
  photoFileIds: z.array(uuid).max(60).default([]),
  notesRead: z.int().min(0).max(1000).default(0),
  photosRead: z.int().min(0).max(100).default(0),
  /** Write over one a person changed (they asked for it). */
  replace: z.boolean().default(false),
});
export const ReportKeepOutput = z.object({
  reportId: uuid.nullable(),
  jobId: uuid,
  day: Day,
  /** False when a person had changed the day's report, so it was left as theirs. */
  kept: z.boolean(),
});

export const ReportUpdateInput = ReportBody.extend({ workspaceId: uuid, reportId: uuid });
export const ReportChangeOutput = z.object({ reportId: uuid, jobId: uuid, day: Day });

export const ReportSendInput = z.object({
  workspaceId: uuid,
  reportId: uuid,
  channel: z.enum(['email', 'sms']),
  /** What to send, when it isn't the report's own update for the customer as it stands. */
  body: z
    .string()
    .trim()
    .min(1, 'Write the update first.')
    .max(REPORT_LIMITS.forCustomer, 'Keep the customer’s update under 1,200 characters.')
    .optional(),
  /** The person said to text during quiet hours. */
  acknowledgeQuietHours: z.boolean().default(false),
});
export const ReportSendOutput = ReportChangeOutput.extend({
  channel: z.enum(['email', 'sms']),
  customer: z.string(),
});
