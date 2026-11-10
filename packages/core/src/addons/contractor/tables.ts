/**
 * Contractor Operations' own tables, in its schema `addon_contractor` (supabase/migrations/20261027024000): the
 * Drizzle mirror its server code reads and writes through. Server-only. test/addons/contractor-ops.test.ts holds the
 * mirror to the live columns.
 */
import {
  bigint,
  date,
  integer,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { customRecords, users, workspaces } from '@hfos/db/schema';
import type { JobKind, JobStatus, PhaseStatus } from './progress';
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

export const CONTRACTOR_TABLES = { jobs, phases, team, money } as const;
