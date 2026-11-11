/**
 * Contractor Operations' own tables, in its schema `addon_contractor` (supabase/migrations/20261027024000, 024200,
 * 024300, 024400 and 024500): the Drizzle mirror its server code reads and writes through. Server-only.
 * test/addons/contractor-ops.test.ts holds the mirror to the live columns.
 */
import {
  bigint,
  boolean,
  date,
  integer,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  appointments,
  customRecords,
  estimates as coreEstimates,
  files,
  people,
  products,
  users,
  workspaces,
} from '@hfos/db/schema';
import type { ItemKind } from './checklists';
import type { CostKind } from './estimating';
import type { JobKind, JobStatus, PhaseStatus } from './progress';
import type { TimeKind, TimeSource } from './time';
import type { Trade } from './trades';

export const addonContractor = pgSchema('addon_contractor');

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const day = (name: string) => date(name, { mode: 'string' });
const workspaceRef = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: 'set null' });

/** A job: the rest of what the add-on knows about one record of its `contractor_job` kind. */
export const jobs = addonContractor.table('jobs', {
  recordId: uuid('record_id')
    .primaryKey()
    .references(() => customRecords.id, { onDelete: 'cascade' }),
  workspaceId: workspaceRef(),
  kind: text('kind').notNull().$type<JobKind>().default('service'),
  status: text('status').notNull().$type<JobStatus>().default('new'),
  statusAt: ts('status_at').notNull().defaultNow(),
  statusBy: userRef('status_by'),
  statusReason: text('status_reason'),
  trade: text('trade').$type<Trade>(),
  details: text('details'),
  startsOn: day('starts_on'),
  dueOn: day('due_on'),
  doneAt: ts('done_at'),
  percentDone: integer('percent_done').notNull().default(0),
  leadUserId: userRef('lead_user_id'),
  createdBy: userRef('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** A project's phases, in order. */
export const phases = addonContractor.table('phases', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: workspaceRef(),
  recordId: uuid('record_id').notNull(),
  position: integer('position').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().$type<PhaseStatus>().default('not_started'),
  percentDone: integer('percent_done').notNull().default(0),
  startsOn: day('starts_on'),
  dueOn: day('due_on'),
  doneAt: ts('done_at'),
  createdBy: userRef('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** The people working a job besides its lead. */
export const team = addonContractor.table(
  'team',
  {
    workspaceId: workspaceRef(),
    recordId: uuid('record_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedBy: userRef('added_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.recordId, t.userId] })],
);

/** A job's price and budget: only people with `contractor.costs` read or write it. */
export const money = addonContractor.table('money', {
  recordId: uuid('record_id').primaryKey(),
  workspaceId: workspaceRef(),
  priceCents: bigint('price_cents', { mode: 'number' }),
  laborCents: bigint('labor_cents', { mode: 'number' }),
  materialsCents: bigint('materials_cents', { mode: 'number' }),
  otherCents: bigint('other_cents', { mode: 'number' }),
  laborHours: numeric('labor_hours', { precision: 9, scale: 2, mode: 'number' }),
  updatedBy: userRef('updated_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** How the business estimates: its lowest margin, starting markup and labor's price and cost per hour. */
export const estimating = addonContractor.table('estimating', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  minMarginBp: integer('min_margin_bp').notNull().default(2000),
  markupBp: integer('markup_bp').notNull().default(5000),
  laborRateCents: bigint('labor_rate_cents', { mode: 'number' }).notNull().default(0),
  laborCostCents: bigint('labor_cost_cents', { mode: 'number' }).notNull().default(0),
  updatedBy: userRef('updated_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** What one of a price list item costs the business: only people with `contractor.costs` read or write it. */
export const itemCosts = addonContractor.table('item_costs', {
  productId: uuid('product_id')
    .primaryKey()
    .references(() => products.id, { onDelete: 'cascade' }),
  workspaceId: workspaceRef(),
  kind: text('kind').notNull().$type<CostKind>().default('material'),
  costCents: bigint('cost_cents', { mode: 'number' }).notNull(),
  updatedBy: userRef('updated_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** An estimate the builder wrote: the job it's for, and who asked for an OK. No amounts. */
export const estimates = addonContractor.table('estimates', {
  estimateId: uuid('estimate_id')
    .primaryKey()
    .references(() => coreEstimates.id, { onDelete: 'cascade' }),
  workspaceId: workspaceRef(),
  recordId: uuid('record_id'),
  askedAt: ts('asked_at'),
  askedBy: userRef('asked_by'),
  createdBy: userRef('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** What each line of an estimate costs, by option and line position: costs only. */
export const estimateCosts = addonContractor.table(
  'estimate_costs',
  {
    estimateId: uuid('estimate_id').notNull(),
    workspaceId: workspaceRef(),
    optionPosition: integer('option_position').notNull(),
    linePosition: integer('line_position').notNull(),
    kind: text('kind').notNull().$type<CostKind>(),
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.estimateId, t.optionPosition, t.linePosition] })],
);

/** An owner's or admin's OK to send an estimate as it stood at `revision`. */
export const estimateOks = addonContractor.table('estimate_oks', {
  estimateId: uuid('estimate_id').primaryKey(),
  workspaceId: workspaceRef(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  okBy: userRef('ok_by'),
  okAt: ts('ok_at').notNull().defaultNow(),
  note: text('note'),
});

/** A crew: a named group of team members and subcontractors (the owner's decision 7). */
export const crews = addonContractor.table('crews', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Who's in a crew: someone on the team (`userId`) or a subcontractor, who is a contact (`personId`). */
export const crewMembers = addonContractor.table('crew_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: workspaceRef(),
  crewId: uuid('crew_id').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'cascade' }),
  addedBy: userRef('added_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** A visit's work order: one per appointment on a job. */
export const workOrders = addonContractor.table('work_orders', {
  appointmentId: uuid('appointment_id')
    .primaryKey()
    .references(() => appointments.id, { onDelete: 'cascade' }),
  workspaceId: workspaceRef(),
  recordId: uuid('record_id').notNull(),
  crewId: uuid('crew_id'),
  instructions: text('instructions'),
  bring: text('bring'),
  createdBy: userRef('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** A work order's checklist: boxes to tick and photos to add, some required before the job is Done. */
export const workOrderItems = addonContractor.table('work_order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: workspaceRef(),
  appointmentId: uuid('appointment_id').notNull(),
  recordId: uuid('record_id').notNull(),
  position: integer('position').notNull(),
  label: text('label').notNull(),
  kind: text('kind').notNull().$type<ItemKind>().default('check'),
  required: boolean('required').notNull().default(false),
  doneAt: ts('done_at'),
  doneBy: userRef('done_by'),
  fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
  skippedAt: ts('skipped_at'),
  skippedBy: userRef('skipped_by'),
  skipReason: text('skip_reason'),
  createdBy: userRef('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** The subcontractors on a visit: when they were told, and when the office marked their work done. */
export const workOrderSubs = addonContractor.table('work_order_subs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: workspaceRef(),
  appointmentId: uuid('appointment_id').notNull(),
  recordId: uuid('record_id').notNull(),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  toldAt: ts('told_at'),
  toldBy: userRef('told_by'),
  doneAt: ts('done_at'),
  doneBy: userRef('done_by'),
  note: text('note'),
  addedBy: userRef('added_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** How much of something, to three decimal places as core's estimate lines count. */
const amount = (name: string) =>
  numeric(name, { precision: 12, scale: 3, mode: 'number' }).notNull().default(0);

/** A material on a job (the owner's decision 9): what's needed, ordered, delivered, used, wasted and returned. */
export const materials = addonContractor.table('materials', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: workspaceRef(),
  recordId: uuid('record_id').notNull(),
  position: integer('position').notNull(),
  name: text('name').notNull(),
  unitLabel: text('unit_label').notNull().default('each'),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  /** The visit it's needed for; null: any visit on the job. */
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
  needed: amount('needed'),
  ordered: amount('ordered'),
  delivered: amount('delivered'),
  used: amount('used'),
  wasted: amount('wasted'),
  returned: amount('returned'),
  supplier: text('supplier'),
  expectedOn: day('expected_on'),
  note: text('note'),
  /** The approved estimate's line it came from. */
  estimateId: uuid('estimate_id').references(() => coreEstimates.id, { onDelete: 'set null' }),
  estimateLine: integer('estimate_line'),
  createdBy: userRef('created_by'),
  updatedBy: userRef('updated_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** What one unit of a material costs the business: read only by people who may see job costs (decision 11). */
export const materialCosts = addonContractor.table('material_costs', {
  materialId: uuid('material_id').primaryKey(),
  workspaceId: workspaceRef(),
  recordId: uuid('record_id').notNull(),
  unitCostCents: bigint('unit_cost_cents', { mode: 'number' }).notNull(),
  updatedBy: userRef('updated_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** One stretch of one person's time on a job (the owner's decision 10): travel, work or a break. */
export const timeEntries = addonContractor.table('time_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: workspaceRef(),
  recordId: uuid('record_id').notNull(),
  /** The visit it was on; kept on the job when the visit is deleted for good. */
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  kind: text('kind').$type<TimeKind>().notNull(),
  startedAt: ts('started_at').notNull(),
  /** Null while it's running. */
  endedAt: ts('ended_at'),
  source: text('source').$type<TimeSource>().notNull().default('status'),
  /** Left running past the limit and stopped on its own. */
  autoStopped: boolean('auto_stopped').notNull().default(false),
  fixedBy: userRef('fixed_by'),
  fixedAt: ts('fixed_at'),
  fixReason: text('fix_reason'),
  createdBy: userRef('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** What an hour of a stretch cost the business then: read only by people who may see job costs (decision 11). */
export const timeCosts = addonContractor.table('time_costs', {
  entryId: uuid('entry_id').primaryKey(),
  workspaceId: workspaceRef(),
  recordId: uuid('record_id').notNull(),
  rateCents: bigint('rate_cents', { mode: 'number' }).notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** What an hour of each person costs the business. */
export const laborRates = addonContractor.table(
  'labor_rates',
  {
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    costCents: bigint('cost_cents', { mode: 'number' }).notNull(),
    updatedBy: userRef('updated_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

/** What else a job cost: a permit, a dump fee, a subcontractor's bill. */
export const otherCosts = addonContractor.table('other_costs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: workspaceRef(),
  recordId: uuid('record_id').notNull(),
  name: text('name').notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  spentOn: day('spent_on').notNull(),
  note: text('note'),
  createdBy: userRef('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const CONTRACTOR_TABLES = {
  jobs,
  phases,
  team,
  money,
  estimating,
  itemCosts,
  estimates,
  estimateCosts,
  estimateOks,
  crews,
  crewMembers,
  workOrders,
  workOrderItems,
  workOrderSubs,
  materials,
  materialCosts,
  timeEntries,
  timeCosts,
  laborRates,
  otherCosts,
} as const;
