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
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  appointments,
  calendars,
  customRecords,
  files,
  leads,
  messages,
  people,
  users,
  workspaces,
} from '@hfos/db/schema';
import type { MemoryKind } from './memory';
import type { DealRole, DealLinkKind } from './words';

export const addonRealestate = pgSchema('addon_realestate');

/** Who did something, as the add-on's history says: a person, HandsFreeOS, the AI, or the client in their portal. */
export type HistoryActor = 'person' | 'system' | 'ai' | 'client';

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
    /** How far the AI has read the client's words for buyer memory (round two). */
    memoryReadThrough: ts('memory_read_through'),
    /** How many of the AI's suggestions fair housing rules left out: a count, never the words. */
    memoryProtectedDropped: integer('memory_protected_dropped').notNull().default(0),
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
    actorType: text('actor_type').notNull().$type<HistoryActor>(),
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
    /** The offer or counter it is (round two). */
    offerVersionId: uuid('offer_version_id'),
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
    /** One of the add-on's own rows the proof is (kind `record`): a home, a tour, an offer (round two). */
    refKind: text('ref_kind'),
    refId: uuid('ref_id'),
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
    actorType: text('actor_type').notNull().$type<HistoryActor>(),
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
    /** A client update's words, a CMA's summary (round two), or a listing's description (round three). */
    draftId: uuid('draft_id'),
    cmaId: uuid('cma_id'),
    descriptionId: uuid('description_id'),
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

/** What the buyer wants, one per buyer deal (round two). */
export const buyerProfiles = addonRealestate.table(
  'buyer_profiles',
  {
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    budgetMinCents: cents('budget_min_cents'),
    budgetMaxCents: cents('budget_max_cents'),
    areas: text('areas')
      .array()
      .notNull()
      .default(sql`'{}'`),
    homeTypes: text('home_types')
      .array()
      .notNull()
      .default(sql`'{}'`),
    bedsMin: integer('beds_min'),
    bathsMin: numeric('baths_min', { precision: 3, scale: 1 }),
    sqftMin: integer('sqft_min'),
    moveBy: date('move_by', { mode: 'string' }),
    mustHaves: text('must_haves')
      .array()
      .notNull()
      .default(sql`'{}'`),
    dealBreakers: text('deal_breakers')
      .array()
      .notNull()
      .default(sql`'{}'`),
    version: integer('version').notNull().default(1),
    updatedBy: userRef('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.dealRecordId] }),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** Each save of a buyer's profile, as it was. Append-only. */
export const buyerProfileVersions = addonRealestate.table(
  'buyer_profile_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    version: integer('version').notNull(),
    profile: jsonb('profile').$type<Record<string, unknown>>().notNull(),
    actorType: text('actor_type').notNull().$type<HistoryActor>(),
    savedBy: userRef('saved_by'),
    savedAt: ts('saved_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.dealRecordId, t.version),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** A home on a buyer deal, with its facts and where each came from (round two). */
export const homes = addonRealestate.table(
  'homes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    address: text('address').notNull(),
    addressKey: text('address_key').notNull(),
    source: text('source').notNull().$type<'agent' | 'client' | 'mls'>(),
    link: text('link'),
    pastedText: text('pasted_text'),
    facts: jsonb('facts')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    factSources: jsonb('fact_sources')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    factsState: text('facts_state')
      .notNull()
      .default('none')
      .$type<'none' | 'filling' | 'suggested' | 'confirmed' | 'failed'>(),
    factsModel: text('facts_model'),
    factsFailure: text('facts_failure'),
    factsConfirmedBy: userRef('facts_confirmed_by'),
    factsConfirmedAt: ts('facts_confirmed_at'),
    status: text('status')
      .notNull()
      .default('saved')
      .$type<'saved' | 'shortlisted' | 'toured' | 'offered' | 'passed' | 'removed'>(),
    statusNote: text('status_note'),
    addedBy: userRef('added_by'),
    addedByPersonId: uuid('added_by_person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
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

/** Each client's own save or pass on a home. */
export const homeReactions = addonRealestate.table(
  'home_reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    homeId: uuid('home_id').notNull(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    reaction: text('reaction').notNull().$type<'saved' | 'passed'>(),
    note: text('note'),
    reactedAt: ts('reacted_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.homeId, t.personId),
    foreignKey({
      columns: [t.workspaceId, t.homeId],
      foreignColumns: [homes.workspaceId, homes.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** One thing the buyer said, with the words it came from; suggested by the AI, decided by a person (round two). */
export const memoryItems = addonRealestate.table(
  'memory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    kind: text('kind').notNull().$type<MemoryKind>(),
    words: text('words').notNull(),
    quote: text('quote'),
    sourceKind: text('source_kind').notNull().$type<'message' | 'call' | 'note' | 'typed'>(),
    sourceId: uuid('source_id'),
    status: text('status').notNull().$type<'suggested' | 'confirmed' | 'rejected' | 'retired'>(),
    suggestedBy: text('suggested_by').notNull().$type<'ai' | 'person'>(),
    createdBy: userRef('created_by'),
    decidedBy: userRef('decided_by'),
    decidedAt: ts('decided_at'),
    decidedNote: text('decided_note'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** A tour: one appointment on the calendar, with the homes in order (round two, step 8). */
export const tours = addonRealestate.table(
  'tours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    calendarId: uuid('calendar_id').references(() => calendars.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('planned').$type<'planned' | 'done' | 'canceled'>(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    agentUserId: userRef('agent_user_id'),
    agreementDocumentId: uuid('agreement_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    exceptionReason: text('exception_reason'),
    exceptionBy: userRef('exception_by'),
    exceptionAt: ts('exception_at'),
    note: text('note'),
    canceledReason: text('canceled_reason'),
    canceledAt: ts('canceled_at'),
    createdBy: userRef('created_by'),
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

/** A home on a tour, in its place, and whether it was seen. */
export const tourStops = addonRealestate.table(
  'tour_stops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    tourId: uuid('tour_id').notNull(),
    homeId: uuid('home_id').notNull(),
    position: integer('position').notNull(),
    status: text('status').notNull().default('planned').$type<'planned' | 'visited' | 'skipped'>(),
    visitedAt: ts('visited_at'),
    note: text('note'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.tourId, t.homeId),
    foreignKey({
      columns: [t.workspaceId, t.tourId],
      foreignColumns: [tours.workspaceId, tours.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.homeId],
      foreignColumns: [homes.workspaceId, homes.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** What a client thought of a home they saw on a tour. */
export const tourFeedback = addonRealestate.table(
  'tour_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    tourId: uuid('tour_id').notNull(),
    stopId: uuid('stop_id').notNull(),
    homeId: uuid('home_id').notNull(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    recordedBy: userRef('recorded_by'),
    interest: text('interest').notNull().$type<'love' | 'maybe' | 'no'>(),
    rating: smallint('rating'),
    words: text('words'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.stopId, t.personId),
    foreignKey({
      columns: [t.workspaceId, t.stopId],
      foreignColumns: [tourStops.workspaceId, tourStops.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.tourId],
      foreignColumns: [tours.workspaceId, tours.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.homeId],
      foreignColumns: [homes.workspaceId, homes.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** A look at what a home is worth next to homes sold nearby (round two, step 9). */
export const cmas = addonRealestate.table(
  'cmas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    homeId: uuid('home_id'),
    subjectAddress: text('subject_address').notNull(),
    subjectBeds: integer('subject_beds'),
    subjectBaths: numeric('subject_baths', { precision: 3, scale: 1 }),
    subjectSqft: integer('subject_sqft'),
    subjectListPriceCents: cents('subject_list_price_cents'),
    subjectYearBuilt: integer('subject_year_built'),
    number: integer('number').notNull(),
    status: text('status').notNull().default('draft').$type<'draft' | 'final' | 'shared'>(),
    method: integer('method').notNull().default(1),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    lowCents: cents('low_cents'),
    likelyCents: cents('likely_cents'),
    highCents: cents('high_cents'),
    perSqftCents: cents('per_sqft_cents'),
    summary: text('summary'),
    summaryState: text('summary_state')
      .notNull()
      .default('none')
      .$type<'none' | 'drafting' | 'ready' | 'failed'>(),
    summaryModel: text('summary_model'),
    summaryFailure: text('summary_failure'),
    summaryEditedBy: userRef('summary_edited_by'),
    summaryEditedAt: ts('summary_edited_at'),
    flagsAcknowledgedBy: userRef('flags_acknowledged_by'),
    flagsAcknowledgedAt: ts('flags_acknowledged_at'),
    flagsAcknowledgedReason: text('flags_acknowledged_reason'),
    finalizedBy: userRef('finalized_by'),
    finalizedAt: ts('finalized_at'),
    sharedBy: userRef('shared_by'),
    sharedAt: ts('shared_at'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.dealRecordId, t.number),
    foreignKey({
      columns: [t.workspaceId, t.homeId],
      foreignColumns: [homes.workspaceId, homes.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** A home a CMA compares with: its price, sale, size and the agent's adjustments. */
export const cmaComps = addonRealestate.table(
  'cma_comps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    cmaId: uuid('cma_id').notNull(),
    address: text('address').notNull(),
    priceCents: cents('price_cents').notNull(),
    status: text('status').notNull().default('sold').$type<'sold' | 'pending' | 'active'>(),
    soldOn: date('sold_on', { mode: 'string' }),
    beds: integer('beds'),
    baths: numeric('baths', { precision: 3, scale: 1 }),
    sqft: integer('sqft'),
    yearBuilt: integer('year_built'),
    distanceMiles: numeric('distance_miles', { precision: 5, scale: 2 }),
    adjustments: jsonb('adjustments')
      .$type<{ label: string; cents: number }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    used: boolean('used').notNull().default(true),
    note: text('note'),
    source: text('source').notNull().default('agent').$type<'agent' | 'mls'>(),
    position: integer('position').notNull(),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.cmaId],
      foreignColumns: [cmas.workspaceId, cmas.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** An offer on one of a buyer's homes: who it's with and where it stands (round two, step 10). */
export const offers = addonRealestate.table(
  'offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    homeId: uuid('home_id').notNull(),
    number: integer('number').notNull(),
    status: text('status')
      .notNull()
      .default('waiting_them')
      .$type<'waiting_them' | 'waiting_us' | 'accepted' | 'declined' | 'expired' | 'withdrawn'>(),
    theirAgentName: text('their_agent_name'),
    theirBrokerage: text('their_brokerage'),
    theirEmail: text('their_email'),
    theirPhone: text('their_phone'),
    acceptedVersionId: uuid('accepted_version_id'),
    endedAt: ts('ended_at'),
    endedReason: text('ended_reason'),
    sharedVersionId: uuid('shared_version_id'),
    sharedBy: userRef('shared_by'),
    sharedAt: ts('shared_at'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.dealRecordId, t.number),
    foreignKey({
      columns: [t.workspaceId, t.homeId],
      foreignColumns: [homes.workspaceId, homes.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** An offer or counter as it was sent: never changed. */
export const offerVersions = addonRealestate.table(
  'offer_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    offerId: uuid('offer_id').notNull(),
    number: integer('number').notNull(),
    side: text('side').notNull().$type<'us' | 'them'>(),
    at: ts('at').notNull().defaultNow(),
    priceCents: cents('price_cents').notNull(),
    emdCents: cents('emd_cents'),
    emdDays: integer('emd_days'),
    sellerCreditCents: cents('seller_credit_cents').notNull().default(0),
    inspectionDays: integer('inspection_days'),
    loanType: text('loan_type').$type<'conventional' | 'fha' | 'va' | 'usda' | 'cash' | 'other'>(),
    financingDays: integer('financing_days'),
    appraisalContingency: boolean('appraisal_contingency'),
    closingDate: date('closing_date', { mode: 'string' }),
    otherTerms: text('other_terms'),
    respondBy: ts('respond_by'),
    note: text('note'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.offerId, t.number),
    foreignKey({
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offers.workspaceId, offers.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** A buyer deal's lender and loan (round two, step 11). */
export const financing = addonRealestate.table(
  'financing',
  {
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    lenderName: text('lender_name'),
    officerName: text('officer_name'),
    officerEmail: text('officer_email'),
    officerPhone: text('officer_phone'),
    loanType: text('loan_type').$type<'conventional' | 'fha' | 'va' | 'usda' | 'cash' | 'other'>(),
    loanAmountCents: cents('loan_amount_cents'),
    updatedBy: userRef('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.dealRecordId] }),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** One step of the loan, and its proof once done. */
export const financingSteps = addonRealestate.table(
  'financing_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    step: text('step')
      .notNull()
      .$type<
        | 'preapproval'
        | 'application'
        | 'rate_lock'
        | 'appraisal'
        | 'conditional_approval'
        | 'clear_to_close'
        | 'closing_disclosure'
        | 'funding'
      >(),
    status: text('status')
      .notNull()
      .default('not_started')
      .$type<'not_started' | 'in_progress' | 'done'>(),
    startedOn: date('started_on', { mode: 'string' }),
    expectedOn: date('expected_on', { mode: 'string' }),
    doneOn: date('done_on', { mode: 'string' }),
    amountCents: cents('amount_cents'),
    rate: numeric('rate', { precision: 6, scale: 3 }),
    expiresOn: date('expires_on', { mode: 'string' }),
    note: text('note'),
    proofKind: text('proof_kind').$type<'document' | 'file' | 'message'>(),
    proofId: uuid('proof_id'),
    doneBy: userRef('done_by'),
    doneAt: ts('done_at'),
    updatedBy: userRef('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.dealRecordId, t.step),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** An inspection: its inspector, when, and its report. */
export const inspections = addonRealestate.table(
  'inspections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    kind: text('kind').notNull(),
    inspector: text('inspector'),
    scheduledAt: ts('scheduled_at'),
    reportExpectedOn: date('report_expected_on', { mode: 'string' }),
    status: text('status')
      .notNull()
      .default('scheduled')
      .$type<'scheduled' | 'report_in' | 'canceled'>(),
    reportDocumentId: uuid('report_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    reportInOn: date('report_in_on', { mode: 'string' }),
    pages: integer('pages'),
    note: text('note'),
    createdBy: userRef('created_by'),
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

/** What an inspection found, and what the client wants done about it. */
export const inspectionFindings = addonRealestate.table(
  'inspection_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    inspectionId: uuid('inspection_id').notNull(),
    title: text('title').notNull(),
    location: text('location'),
    severity: text('severity').notNull().$type<'safety' | 'repair' | 'minor'>(),
    estimateCents: cents('estimate_cents'),
    clientPriority: text('client_priority').$type<'must_fix' | 'would_like' | 'skip'>(),
    ask: text('ask')
      .notNull()
      .default('not_asked')
      .$type<'repair' | 'replace' | 'credit' | 'not_asked'>(),
    creditCents: cents('credit_cents'),
    position: integer('position').notNull(),
    note: text('note'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.inspectionId],
      foreignColumns: [inspections.workspaceId, inspections.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** Each version of the repair request, and the seller's answers: never changed. */
export const repairRequests = addonRealestate.table(
  'repair_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    number: integer('number').notNull(),
    side: text('side').notNull().$type<'us' | 'them'>(),
    at: ts('at').notNull().defaultNow(),
    words: text('words').notNull(),
    items: jsonb('items')
      .$type<{ findingId: string; title: string; ask: string; creditCents: number | null }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    creditCents: cents('credit_cents').notNull().default(0),
    respondBy: ts('respond_by'),
    outcome: text('outcome').$type<'agreed' | 'countered' | 'refused'>(),
    note: text('note'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.dealRecordId, t.number),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** Something the client does themselves, in their portal (round two, step 12). */
export const clientTasks = addonRealestate.table(
  'client_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    kind: text('kind').notNull().$type<'upload' | 'sign_off' | 'do' | 'questionnaire'>(),
    title: text('title').notNull(),
    detail: text('detail'),
    signOffWords: text('sign_off_words'),
    forPersonId: uuid('for_person_id').references(() => people.id, { onDelete: 'cascade' }),
    dueOn: date('due_on', { mode: 'string' }),
    documentKind: text('document_kind'),
    status: text('status').notNull().default('open').$type<'open' | 'done' | 'canceled'>(),
    doneAt: ts('done_at'),
    canceledReason: text('canceled_reason'),
    refKind: text('ref_kind').$type<'listing_description' | 'listing_price'>(),
    refId: uuid('ref_id'),
    createdBy: userRef('created_by'),
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

/** A client's own part of a task: their upload, or the exact words they signed off on. */
export const clientTaskCompletions = addonRealestate.table(
  'client_task_completions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    taskId: uuid('task_id').notNull(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    signedWords: text('signed_words'),
    recordedBy: userRef('recorded_by'),
    note: text('note'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.taskId, t.personId),
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [clientTasks.workspaceId, clientTasks.id],
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
  buyerProfiles,
  buyerProfileVersions,
  homes,
  homeReactions,
  memoryItems,
  tours,
  tourStops,
  tourFeedback,
  cmas,
  cmaComps,
  offers,
  offerVersions,
  financing,
  financingSteps,
  inspections,
  inspectionFindings,
  repairRequests,
  clientTasks,
  clientTaskCompletions,
} as const;

// ---------- round three: the listing ----------

/** Where one of a listing's confirmed facts came from. */
export interface ListingFactSource {
  readonly from: 'seller' | 'pasted' | 'agent';
  /** The pasted words it was found in. */
  readonly quote?: string;
}

/** A listing deal's listing: its facts, the MLS, its public page (round three, step 3). */
export const listings = addonRealestate.table(
  'listings',
  {
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    facts: jsonb('facts')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    factSources: jsonb('fact_sources')
      .$type<Record<string, ListingFactSource>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    factsConfirmedBy: userRef('facts_confirmed_by'),
    factsConfirmedAt: ts('facts_confirmed_at'),
    pastedText: text('pasted_text'),
    pastedState: text('pasted_state')
      .notNull()
      .default('none')
      .$type<'none' | 'filling' | 'read' | 'failed'>(),
    pastedFacts: jsonb('pasted_facts')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    pastedSources: jsonb('pasted_sources')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    pastedModel: text('pasted_model'),
    pastedFailure: text('pasted_failure'),
    highlights: text('highlights'),
    mlsNumber: text('mls_number'),
    mlsLiveOn: date('mls_live_on', { mode: 'string' }),
    mlsMarkedBy: userRef('mls_marked_by'),
    mlsMarkedAt: ts('mls_marked_at'),
    slug: text('slug'),
    pageState: text('page_state').notNull().default('none').$type<'none' | 'published' | 'down'>(),
    pagePublishedBy: userRef('page_published_by'),
    pagePublishedAt: ts('page_published_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.dealRecordId] }),
    unique().on(t.workspaceId, t.slug),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** A listing's photos, in order: on the public page and the flyer, or kept for the agent and the seller. */
export const listingPhotos = addonRealestate.table(
  'listing_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    caption: text('caption'),
    public: boolean('public').notNull().default(true),
    addedBy: userRef('added_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.dealRecordId, t.fileId),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** The seller's answers about their home, saved as they go and sent once. */
export const sellerQuestionnaires = addonRealestate.table(
  'seller_questionnaires',
  {
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    answers: jsonb('answers')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    state: text('state').notNull().default('draft').$type<'draft' | 'submitted'>(),
    savedByPersonId: uuid('saved_by_person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    savedAt: ts('saved_at'),
    submittedByPersonId: uuid('submitted_by_person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    submittedAt: ts('submitted_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.dealRecordId] }),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** A listing's description, each version as written: the AI's draft or a person's words (round three, step 4). */
export const listingDescriptions = addonRealestate.table(
  'listing_descriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    version: integer('version').notNull(),
    words: text('words'),
    source: text('source').notNull().$type<'ai' | 'person'>(),
    state: text('state')
      .notNull()
      .default('drafting')
      .$type<'drafting' | 'ready' | 'failed' | 'sent' | 'signed' | 'replaced'>(),
    model: text('model'),
    failure: text('failure'),
    flagsAcknowledgedBy: userRef('flags_acknowledged_by'),
    flagsAcknowledgedAt: ts('flags_acknowledged_at'),
    flagsAcknowledgedReason: text('flags_acknowledged_reason'),
    clientTaskId: uuid('client_task_id'),
    sentBy: userRef('sent_by'),
    sentAt: ts('sent_at'),
    signedAt: ts('signed_at'),
    signedByPersonId: uuid('signed_by_person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    overrideBy: userRef('override_by'),
    overrideReason: text('override_reason'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.dealRecordId, t.version),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** Both fair housing checks of a post's words as they are now. */
export interface PostChecks {
  readonly hash?: string;
  readonly words?: { readonly version: string; readonly flags: readonly unknown[] };
  readonly model?: {
    readonly version: string;
    readonly status: 'passed' | 'flagged' | 'unavailable';
    readonly flags: readonly unknown[];
  };
}

/** A draft of one of a listing's social posts, in its batch (round three, step 6). */
export const listingPosts = addonRealestate.table(
  'listing_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    batch: integer('batch').notNull(),
    position: smallint('position').notNull(),
    words: text('words'),
    state: text('state')
      .notNull()
      .default('drafting')
      .$type<'drafting' | 'ready' | 'failed' | 'replaced'>(),
    model: text('model'),
    failure: text('failure'),
    checks: jsonb('checks')
      .$type<PostChecks>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    editedBy: userRef('edited_by'),
    editedAt: ts('edited_at'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.dealRecordId, t.batch, t.position),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);
