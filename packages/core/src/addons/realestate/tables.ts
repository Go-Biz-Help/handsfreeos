/**
 * Real Estate Agent's own tables, in its schema `addon_realestate` (supabase/migrations/20261013002600): the
 * Drizzle mirror its server code reads and writes through. Server-only. Each follows the deal it's about through
 * its record column, so row security keeps a private deal's rows to the people who see the deal
 * (private.addon_table_policies); test/addons/realestate-tables.test.ts holds the mirror to the live columns.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { customRecords, leads, users, workspaces } from '@hfos/db/schema';

export const addonRealestate = pgSchema('addon_realestate');

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const workspaceRef = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: 'set null' });
const cents = (name: string) => bigint(name, { mode: 'number' });

/** One per deal record: its side, stage and outcome, the lead it came from, its commission and its health. */
export const deals = addonRealestate.table(
  'deals',
  {
    recordId: uuid('record_id')
      .primaryKey()
      .references(() => customRecords.id, { onDelete: 'cascade' }),
    workspaceId: workspaceRef(),
    /** buyer or listing. */
    side: text('side').notNull().$type<'buyer' | 'listing'>(),
    stage: text('stage').notNull(),
    stageEnteredAt: ts('stage_entered_at').notNull().defaultNow(),
    /** closed, terminated, lost or ended; null while it's open. */
    outcome: text('outcome').$type<'closed' | 'terminated' | 'lost' | 'ended'>(),
    outcomeAt: ts('outcome_at'),
    outcomeReason: text('outcome_reason'),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    commissionRateBp: integer('commission_rate_bp'),
    commissionFlatCents: cents('commission_flat_cents'),
    commissionCreditCents: cents('commission_credit_cents').notNull().default(0),
    commissionSplitBp: integer('commission_split_bp'),
    expectedCommissionCents: cents('expected_commission_cents'),
    finalCommissionCents: cents('final_commission_cents'),
    finalCommissionBy: userRef('final_commission_by'),
    finalCommissionAt: ts('final_commission_at'),
    /** green, yellow or red, as last worked out, with its reasons. */
    health: text('health').notNull().default('green').$type<'green' | 'yellow' | 'red'>(),
    healthReasons: jsonb('health_reasons')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    healthAt: ts('health_at'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.recordId)],
);

/** What each person on a deal does there. The main agent is the record's own (`owner_user_id`). */
export const dealRoles = addonRealestate.table(
  'deal_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<'agent' | 'coordinator' | 'assistant'>(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.dealRecordId, t.userId),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

export const DEAL_LINK_KINDS = [
  'other_side',
  'waits_on_sale',
  'sale_for',
  'backup_of',
  'backed_up_by',
] as const;
export type DealLinkKind = (typeof DEAL_LINK_KINDS)[number];

/** Two deals that belong together, a row each way. */
export const dealLinks = addonRealestate.table(
  'deal_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    otherRecordId: uuid('other_record_id').notNull(),
    kind: text('kind').notNull().$type<DealLinkKind>(),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.dealRecordId, t.otherRecordId, t.kind),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.otherRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** What changed on a deal, as it happened. Append-only. */
export const dealHistory = addonRealestate.table(
  'deal_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    at: ts('at').notNull().defaultNow(),
    actorType: text('actor_type').notNull().$type<'person' | 'system' | 'ai'>(),
    actorUserId: userRef('actor_user_id'),
    what: text('what').notNull(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    note: text('note'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** Every table, for the mirror's test. */
export const REALESTATE_TABLES = { deals, dealRoles, dealLinks, dealHistory } as const;
