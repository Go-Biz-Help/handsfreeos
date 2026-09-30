/**
 * Real Estate Agent's own tables, in its schema `addon_realestate` (supabase/migrations/20261013002600): the
 * Drizzle mirror its server code reads and writes through. Server-only. Each follows the deal it's about through
 * its record column, so row security keeps a private deal's rows to the people who see the deal
 * (private.addon_table_policies); test/addons/realestate-tables.test.ts holds the mirror to the live columns.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  appointments,
  customRecords,
  files,
  leads,
  messages,
  people,
  users,
  workspaces,
} from '@hfos/db/schema';
import type { DealRole, DealLinkKind } from './words';

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
    /** Facts about the deal or its home some duties depend on (catalog DEAL_FACTS). */
    facts: text('facts')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** The published duty list it follows; null is the catalog's own. */
    templateSetId: uuid('template_set_id'),
    catalogVersion: integer('catalog_version').notNull().default(1),
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
    role: text('role').notNull().$type<DealRole>(),
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

/** Each key date or term as it was entered, never changed; confirmed, superseded or set aside once. */
export const termEntries = addonRealestate.table(
  'term_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    key: text('key').notNull(),
    valueDate: date('value_date', { mode: 'string' }),
    valueTime: text('value_time'),
    valueCents: cents('value_cents'),
    valueText: text('value_text'),
    source: text('source').notNull(),
    sourceRef: text('source_ref'),
    documentId: uuid('document_id'),
    note: text('note'),
    enteredBy: userRef('entered_by'),
    enteredAt: ts('entered_at').notNull().defaultNow(),
    confirmedBy: userRef('confirmed_by'),
    confirmedAt: ts('confirmed_at'),
    supersededBy: uuid('superseded_by'),
    supersededAt: ts('superseded_at'),
    rejectedBy: userRef('rejected_by'),
    rejectedAt: ts('rejected_at'),
    rejectedReason: text('rejected_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** A business's published duty list, one row per version. */
export const templateSets = addonRealestate.table(
  'template_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    version: integer('version').notNull(),
    catalogVersion: integer('catalog_version').notNull(),
    note: text('note'),
    publishedBy: userRef('published_by'),
    publishedAt: ts('published_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.version), unique().on(t.workspaceId, t.id)],
);

/** Each duty of a published version, resolved. Never changes. */
export const templateItems = addonRealestate.table(
  'template_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    templateSetId: uuid('template_set_id').notNull(),
    dutyKey: text('duty_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    unique().on(t.templateSetId, t.dutyKey),
    foreignKey({
      columns: [t.workspaceId, t.templateSetId],
      foreignColumns: [templateSets.workspaceId, templateSets.id],
    }).onDelete('cascade'),
  ],
);

/** The editor's unpublished changes to a catalog row. */
export const templateOverrides = addonRealestate.table(
  'template_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dutyKey: text('duty_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    patch: jsonb('patch').$type<Record<string, unknown>>().notNull().default({}),
    updatedBy: userRef('updated_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.dutyKey)],
);

/** The business's own duties, before they're published. */
export const customTemplates = addonRealestate.table(
  'custom_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dutyKey: text('duty_key').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    archivedAt: ts('archived_at'),
    updatedBy: userRef('updated_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.dutyKey)],
);

/** Each duty on a deal, with when it's due and the trace that says why. */
export const duties = addonRealestate.table(
  'duties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    dutyKey: text('duty_key').notNull(),
    pass: integer('pass').notNull().default(1),
    title: text('title').notNull(),
    tracker: text('tracker').notNull(),
    status: text('status').notNull(),
    materiality: text('materiality').notNull(),
    automation: text('automation').notNull(),
    accountableRole: text('accountable_role').notNull(),
    accountableUserId: userRef('accountable_user_id'),
    performers: text('performers')
      .array()
      .notNull()
      .default(sql`'{}'`),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    startedBy: text('started_by').notNull(),
    startedAt: ts('started_at').notNull(),
    dueState: text('due_state').notNull(),
    dueAt: ts('due_at'),
    dueDate: date('due_date', { mode: 'string' }),
    dueTime: text('due_time'),
    dueTrace: jsonb('due_trace')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dueWarnings: jsonb('due_warnings')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    needsDates: text('needs_dates')
      .array()
      .notNull()
      .default(sql`'{}'`),
    dueOverrideAt: ts('due_override_at'),
    dueOverrideReason: text('due_override_reason'),
    blocker: text('blocker'),
    blockerOwner: text('blocker_owner'),
    blockerImpact: text('blocker_impact'),
    blockerReviewAt: ts('blocker_review_at'),
    waitingOn: text('waiting_on'),
    finishedAt: ts('finished_at'),
    finishedBy: userRef('finished_by'),
    finishReason: text('finish_reason'),
    exception: boolean('exception').notNull().default(false),
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedBy: userRef('acknowledged_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.dealRecordId, t.dutyKey, t.pass),
    unique().on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** What a duty waits on. */
export const dutyLinks = addonRealestate.table(
  'duty_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    dutyId: uuid('duty_id').notNull(),
    dependsOnId: uuid('depends_on_id').notNull(),
    kind: text('kind').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.dutyId, t.dependsOnId),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** A file on the deal as the add-on knows it: its kind, version and status. */
export const documents = addonRealestate.table(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    lineageId: uuid('lineage_id').notNull(),
    version: integer('version').notNull().default(1),
    supersedesId: uuid('supersedes_id'),
    status: text('status').notNull().default('draft'),
    controlling: boolean('controlling').notNull().default(false),
    signedAt: ts('signed_at'),
    signedBy: userRef('signed_by'),
    voidedAt: ts('voided_at'),
    voidedBy: userRef('voided_by'),
    voidReason: text('void_reason'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.lineageId, t.version),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** Proof added to a duty; taken back only with a reason, and kept. */
export const dutyEvidence = addonRealestate.table(
  'duty_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    dutyId: uuid('duty_id').notNull(),
    kind: text('kind').notNull(),
    documentId: uuid('document_id'),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    body: text('body'),
    addedBy: userRef('added_by'),
    addedAt: ts('added_at').notNull().defaultNow(),
    withdrawnAt: ts('withdrawn_at'),
    withdrawnBy: userRef('withdrawn_by'),
    withdrawnReason: text('withdrawn_reason'),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** Every change to a duty, as it happened. Append-only. */
export const dutyLog = addonRealestate.table(
  'duty_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    dutyId: uuid('duty_id').notNull(),
    at: ts('at').notNull().defaultNow(),
    actorType: text('actor_type').notNull().$type<'person' | 'system' | 'ai'>(),
    actorUserId: userRef('actor_user_id'),
    what: text('what').notNull(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    note: text('note'),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** A client update: drafted from the deal's facts, edited by the agent, checked, and sent. */
export const drafts = addonRealestate.table(
  'drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    kind: text('kind').notNull().default('status_update').$type<'status_update'>(),
    milestone: text('milestone')
      .notNull()
      .$type<'under_contract' | 'inspection_done' | 'clear_to_close' | 'closed' | 'asked'>(),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    subject: text('subject'),
    body: text('body'),
    status: text('status')
      .notNull()
      .default('drafting')
      .$type<'drafting' | 'ready' | 'sent' | 'discarded' | 'failed'>(),
    failure: text('failure'),
    facts: jsonb('facts').$type<Record<string, unknown>>(),
    model: text('model'),
    requestedBy: userRef('requested_by'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    editedBy: userRef('edited_by'),
    editedAt: ts('edited_at'),
    flagsAcknowledgedBy: userRef('flags_acknowledged_by'),
    flagsAcknowledgedAt: ts('flags_acknowledged_at'),
    flagsAcknowledgedReason: text('flags_acknowledged_reason'),
    sentMessageId: uuid('sent_message_id').references(() => messages.id, { onDelete: 'set null' }),
    sentBy: userRef('sent_by'),
    sentAt: ts('sent_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** Each fair-housing check of a draft, as it was. Append-only. */
export const fairHousingChecks = addonRealestate.table(
  'fair_housing_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    draftId: uuid('draft_id').notNull(),
    source: text('source').notNull().$type<'words' | 'model'>(),
    version: text('version').notNull(),
    status: text('status').notNull().$type<'passed' | 'flagged' | 'unavailable'>(),
    flags: jsonb('flags')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    textHash: text('text_hash').notNull(),
    checkedAt: ts('checked_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.draftId],
      foreignColumns: [drafts.workspaceId, drafts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** Every table, for the mirror's test. */
export const REALESTATE_TABLES = {
  deals,
  dealRoles,
  dealLinks,
  dealHistory,
  termEntries,
  templateSets,
  templateItems,
  templateOverrides,
  customTemplates,
  duties,
  dutyLinks,
  documents,
  dutyEvidence,
  dutyLog,
  drafts,
  fairHousingChecks,
} as const;
