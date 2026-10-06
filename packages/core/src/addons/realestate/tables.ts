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
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  addonConnections,
  appointments,
  bytea,
  calendars,
  companies,
  customRecords,
  files,
  leads,
  messages,
  people,
  users,
  workspaces,
} from '@hfos/db/schema';
import type { ContingencyKind, ContingencyState } from './contingencies';
import type { MemoryKind } from './memory';
import type { VendorService } from './vendors';
import type { DealRole, DealLinkKind } from './words';

export const addonRealestate = pgSchema('addon_realestate');

/** What a listing feed said about a home or a listing, and where looking it up stands (round five, step 4). */
const mlsColumns = () => ({
  mls: jsonb('mls').$type<Record<string, unknown>>(),
  mlsState: text('mls_state')
    .notNull()
    .default('none')
    .$type<'none' | 'looking' | 'found' | 'not_found' | 'failed'>(),
  mlsCheckedAt: ts('mls_checked_at'),
  mlsFailure: text('mls_failure'),
});

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
    /** Round four: where a value read from a contract or amendment was, once a person confirmed it. */
    quote: text('quote'),
    page: integer('page'),
    readId: uuid('read_id'),
    scan: boolean('scan').notNull().default(false),
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
    /** Round four: waiting on someone outside since when, and the day to chase them. */
    waitingSince: ts('waiting_since'),
    chaseAt: ts('chase_at'),
    /** Round four: when its alert first said at risk, and when that went to the alert people. */
    atRiskSince: ts('at_risk_since'),
    escalatedAt: ts('escalated_at'),
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
    /** Who said it waits (round four); none for the built-in order. */
    addedBy: userRef('added_by'),
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
    // Round five: the profile as a saved search on the listing feed.
    searchOn: boolean('search_on').notNull().default(true),
    searchCheckedAt: ts('search_checked_at'),
    searchCardOn: date('search_card_on', { mode: 'string' }),
    searchFailure: text('search_failure'),
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
    source: text('source').notNull().$type<'agent' | 'client' | 'mls' | 'our_listing'>(),
    link: text('link'),
    pastedText: text('pasted_text'),
    /** Whether the listing's words were pasted: what phones keep instead of the words (round six). */
    hasPastedText: boolean('has_pasted_text').generatedAlwaysAs(sql`pasted_text is not null`),
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
    // Round five, step 4: what the listing feed says about it, as it said it.
    ...mlsColumns(),
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
    // Round five, step 4: comps from the feed, asked for, found, or why not.
    compsState: text('comps_state')
      .notNull()
      .default('none')
      .$type<'none' | 'finding' | 'found' | 'none_found' | 'failed'>(),
    compsAsked: jsonb('comps_asked').$type<Record<string, unknown>>(),
    compsFoundAt: ts('comps_found_at'),
    compsFailure: text('comps_failure'),
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
    // Round five, step 4: a comp from the feed, by its MLS number, with what the MLS asks to be shown with it.
    mlsNumber: text('mls_number'),
    mls: jsonb('mls').$type<Record<string, unknown>>(),
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
    /** One of a buyer's homes; a listing's offers are on the listing itself (round three). */
    homeId: uuid('home_id'),
    number: integer('number').notNull(),
    /** On a listing: who the buyers are. */
    buyerNames: text('buyer_names'),
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
    // Round three: what a seller weighs.
    downPaymentPct: numeric('down_payment_pct', { precision: 5, scale: 2 }),
    homeSaleContingency: boolean('home_sale_contingency'),
    escalationCapCents: cents('escalation_cap_cents'),
    escalationStepCents: cents('escalation_step_cents'),
    possession: text('possession'),
    buyerAgentFeeBp: integer('buyer_agent_fee_bp'),
    buyerAgentFeeCents: cents('buyer_agent_fee_cents'),
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
    /** Its photos, core files on the deal, taken at the inspection (round six, board 85). */
    photoFileIds: uuid('photo_file_ids').array().notNull().default([]),
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

// ---------- round three: the listing ----------

/** Where one of a listing's confirmed facts came from. */
export interface ListingFactSource {
  readonly from: 'seller' | 'pasted' | 'agent' | 'mls';
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
    // Round three, step 11: how many of the business's buyers it was suggested to, and added for.
    matchesSuggested: integer('matches_suggested').notNull().default(0),
    matchesAdded: integer('matches_added').notNull().default(0),
    matchedAt: ts('matched_at'),
    // Round five, step 4: what the listing feed says about it, as it said it.
    ...mlsColumns(),
    // Round five, step 8: how showings work on it.
    showingsOpen: boolean('showings_open').notNull().default(true),
    showingConfirm: text('showing_confirm').notNull().default('seller').$type<'seller' | 'auto'>(),
    showingAccess: text('showing_access'),
    showingAccessHours: smallint('showing_access_hours').notNull().default(1),
    showingFeedbackHours: smallint('showing_feedback_hours').notNull().default(1),
    showingMinutes: smallint('showing_minutes').notNull().default(30),
    showingDays: smallint('showing_days')
      .array()
      .notNull()
      .default(sql`'{0,1,2,3,4,5,6}'`),
    showingFrom: time('showing_from').notNull().default('10:00'),
    showingTo: time('showing_to').notNull().default('18:00'),
    showingThemes: jsonb('showing_themes').$type<Record<string, unknown>>(),
    showingThemesAt: ts('showing_themes_at'),
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

/** A listing's open house: when, who hosts it, and its appointment (round three, step 7). */
export const openHouses = addonRealestate.table(
  'open_houses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    hostUserId: userRef('host_user_id'),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    calendarId: uuid('calendar_id').references(() => calendars.id, { onDelete: 'set null' }),
    state: text('state').notNull().default('planned').$type<'planned' | 'cancelled'>(),
    cancelledAt: ts('cancelled_at'),
    cancelledReason: text('cancelled_reason'),
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

/** Someone who signed in at an open house. */
export const openHouseVisitors = addonRealestate.table(
  'open_house_visitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    openHouseId: uuid('open_house_id').notNull(),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    withAgent: boolean('with_agent').notNull().default(false),
    agentName: text('agent_name'),
    smsConsent: boolean('sms_consent').notNull().default(false),
    signedInAt: ts('signed_in_at').notNull().defaultNow(),
    followedUpAt: ts('followed_up_at'),
    followedUpBy: userRef('followed_up_by'),
    followUpNote: text('follow_up_note'),
  },
  (t) => [
    unique().on(t.openHouseId, t.personId),
    foreignKey({
      columns: [t.workspaceId, t.openHouseId],
      foreignColumns: [openHouses.workspaceId, openHouses.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** The figures for a listing's seller's estimate, each save kept (round three, step 8). */
export const netSheets = addonRealestate.table(
  'net_sheets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    version: integer('version').notNull(),
    payoffCents: cents('payoff_cents').notNull().default(0),
    listingFeeBp: integer('listing_fee_bp'),
    listingFeeCents: cents('listing_fee_cents'),
    titleEscrowCents: cents('title_escrow_cents').notNull().default(0),
    transferTaxBp: integer('transfer_tax_bp').notNull().default(0),
    otherCents: cents('other_cents').notNull().default(0),
    otherNote: text('other_note'),
    note: text('note'),
    savedBy: userRef('saved_by'),
    savedAt: ts('saved_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.dealRecordId, t.version),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** What a seller was shown of their offers, as shown. */
export const offerComparisons = addonRealestate.table(
  'offer_comparisons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    shown: jsonb('shown').$type<Record<string, unknown>>().notNull(),
    sharedBy: userRef('shared_by'),
    sharedAt: ts('shared_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** What a seller said about an offer in their portal, in their words. */
export const offerChoices = addonRealestate.table(
  'offer_choices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    comparisonId: uuid('comparison_id').notNull(),
    offerId: uuid('offer_id').notNull(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    choice: text('choice').notNull().$type<'accept' | 'counter' | 'decline' | 'talk'>(),
    words: text('words'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.comparisonId],
      foreignColumns: [offerComparisons.workspaceId, offerComparisons.id],
    }).onDelete('cascade'),
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

/** A change to a listing's price, asked of the seller to sign off (round three, step 10). */
export const listingPrices = addonRealestate.table(
  'listing_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    fromCents: bigint('from_cents', { mode: 'number' }).notNull(),
    toCents: bigint('to_cents', { mode: 'number' }).notNull(),
    words: text('words').notNull(),
    note: text('note'),
    state: text('state').notNull().default('waiting').$type<'waiting' | 'applied' | 'withdrawn'>(),
    clientTaskId: uuid('client_task_id'),
    signedByPersonId: uuid('signed_by_person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    overrideBy: userRef('override_by'),
    overrideReason: text('override_reason'),
    appliedAt: ts('applied_at'),
    termEntryId: uuid('term_entry_id').references(() => termEntries.id, { onDelete: 'set null' }),
    withdrawnReason: text('withdrawn_reason'),
    proposedBy: userRef('proposed_by'),
    proposedAt: ts('proposed_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.clientTaskId],
      foreignColumns: [clientTasks.workspaceId, clientTasks.id],
    }).onDelete('set null'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** One of our listings suggested on a buyer's deal, with a copy of its public facts (round three, step 11). */
export const listingSuggestions = addonRealestate.table(
  'listing_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    listingDealId: uuid('listing_deal_id'),
    address: text('address').notNull(),
    addressKey: text('address_key').notNull(),
    facts: jsonb('facts').notNull().default({}).$type<Record<string, unknown>>(),
    fit: jsonb('fit')
      .notNull()
      .default([])
      .$type<{ key: string; met: boolean | null; words: string }[]>(),
    mlsNumber: text('mls_number'),
    pageSlug: text('page_slug'),
    state: text('state').notNull().default('new').$type<'new' | 'added' | 'not_a_fit' | 'gone'>(),
    homeId: uuid('home_id'),
    decidedBy: userRef('decided_by'),
    decidedAt: ts('decided_at'),
    decidedReason: text('decided_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.dealRecordId, t.listingDealId),
    foreignKey({
      columns: [t.workspaceId, t.homeId],
      foreignColumns: [homes.workspaceId, homes.id],
    }).onDelete('set null'),
    foreignKey({
      columns: [t.workspaceId, t.listingDealId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('set null'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

// ---------- round four: coordinator and risk ----------

/** One value a contract reading found, waiting for a person, confirmed (with the entry it made) or set aside. */
export interface ContractValue {
  readonly id: string;
  readonly key: string;
  readonly date: string | null;
  readonly time: string | null;
  readonly cents: number | null;
  readonly text: string | null;
  /** A date the contract gives as days after another one, worked out with the business's calendar. */
  readonly worked: {
    readonly days: number;
    readonly business: boolean;
    readonly from: string;
    readonly fromDate: string;
  } | null;
  readonly clause: string | null;
  readonly page: number | null;
  readonly quote: string;
  readonly state: 'waiting' | 'confirmed' | 'rejected';
  readonly entryId: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
}

/** Something a reading saw but couldn't place exactly, for a person to look at. */
export interface ContractUnclear {
  readonly what: string;
  readonly quote: string | null;
  readonly page: number | null;
  readonly clause: string | null;
}

/** One reading of a contract, amendment or addendum (round four, step 2). */
export const contractReads = addonRealestate.table(
  'contract_reads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    documentId: uuid('document_id').notNull(),
    kind: text('kind').notNull().$type<'contract' | 'amendment' | 'addendum'>(),
    state: text('state').notNull().default('reading').$type<'reading' | 'read' | 'failed'>(),
    scan: boolean('scan').notNull().default(false),
    pages: integer('pages'),
    model: text('model'),
    failure: text('failure'),
    found: jsonb('found')
      .$type<ContractValue[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    unclear: jsonb('unclear')
      .$type<ContractUnclear[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dropped: integer('dropped').notNull().default(0),
    requestedBy: userRef('requested_by'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    readAt: ts('read_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** One of a deal's contingencies (round four, step 3): when it ends, and how it ended. */
export const contingencies = addonRealestate.table(
  'contingencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    kind: text('kind').notNull().$type<ContingencyKind>(),
    label: text('label'),
    endKey: text('end_key'),
    endsOn: date('ends_on', { mode: 'string' }),
    source: text('source').notNull().$type<'offer' | 'contract' | 'typed'>(),
    state: text('state').notNull().default('open').$type<ContingencyState>(),
    resolvedAt: ts('resolved_at'),
    resolvedBy: userRef('resolved_by'),
    documentId: uuid('document_id'),
    note: text('note'),
    overrideReason: text('override_reason'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete('set null'),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** Every table, for the test that holds the mirror to the live columns. */
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
  listings,
  listingPhotos,
  sellerQuestionnaires,
  listingDescriptions,
  listingPosts,
  openHouses,
  openHouseVisitors,
  netSheets,
  offerComparisons,
  offerChoices,
  listingPrices,
  listingSuggestions,
  contractReads,
  contingencies,
} as const;

/** A buyer's new match from the listing feed, for the agent to send to the client or set aside (round five). */
export const feedMatches = addonRealestate.table(
  'feed_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    provider: text('provider').notNull(),
    listingKey: text('listing_key').notNull(),
    mlsNumber: text('mls_number').notNull(),
    mls: jsonb('mls').$type<Record<string, unknown>>().notNull(),
    state: text('state').notNull().default('new').$type<'new' | 'sent' | 'dismissed'>(),
    foundAt: ts('found_at').notNull().defaultNow(),
    changedAt: ts('changed_at'),
    decidedBy: userRef('decided_by'),
    decidedAt: ts('decided_at'),
    homeId: uuid('home_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.dealRecordId, t.provider, t.listingKey),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.homeId],
      foreignColumns: [homes.workspaceId, homes.id],
    }),
  ],
);

/** A deal's document sent for signing through DocuSign or Dotloop, and where it stands (round five, step 7). */
export const esignEnvelopes = addonRealestate.table(
  'esign_envelopes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    documentId: uuid('document_id').notNull(),
    provider: text('provider').notNull().$type<'docusign' | 'dotloop'>(),
    connectionId: uuid('connection_id').references(() => addonConnections.id, {
      onDelete: 'set null',
    }),
    externalId: text('external_id'),
    openUrl: text('open_url'),
    state: text('state')
      .notNull()
      .default('preparing')
      .$type<'preparing' | 'draft' | 'sent' | 'completed' | 'declined' | 'voided' | 'failed'>(),
    subject: text('subject').notNull(),
    message: text('message'),
    signers: jsonb('signers')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    failure: text('failure'),
    preparedAt: ts('prepared_at'),
    sentAt: ts('sent_at'),
    completedAt: ts('completed_at'),
    checkedAt: ts('checked_at'),
    signedDocumentId: uuid('signed_document_id'),
    certificateDocumentId: uuid('certificate_document_id'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.provider, t.externalId),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete('cascade'),
  ],
);

/** A showing of one of our listings: asked for on its page, read from ShowingTime's emails, or added by hand. */
export const showings = addonRealestate.table(
  'showings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    source: text('source').notNull().$type<'page' | 'showingtime' | 'agent'>(),
    state: text('state')
      .notNull()
      .default('requested')
      .$type<'requested' | 'confirmed' | 'declined' | 'cancelled' | 'done'>(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    agentName: text('agent_name').notNull(),
    brokerage: text('brokerage'),
    license: text('license'),
    agentEmail: text('agent_email'),
    agentPhone: text('agent_phone'),
    checked: boolean('checked').notNull().default(true),
    externalId: text('external_id'),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    decidedAt: ts('decided_at'),
    decidedBy: userRef('decided_by'),
    decidedByPersonId: uuid('decided_by_person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    decisionNote: text('decision_note'),
    accessSentAt: ts('access_sent_at'),
    feedbackAskedAt: ts('feedback_asked_at'),
    feedbackTokenHash: bytea('feedback_token_hash').unique(),
    feedback: jsonb('feedback').$type<Record<string, unknown>>(),
    feedbackAt: ts('feedback_at'),
    feedbackSource: text('feedback_source').$type<'page' | 'showingtime' | 'agent'>(),
    feedbackSharedAt: ts('feedback_shared_at'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.workspaceId, t.externalId),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

export type LockboxKind = 'sentrilock' | 'supra' | 'combination' | 'keypad' | 'other';

/**
 * A listing's lockbox (round seven): what kind, where, its serial, and its code sealed by the worker. People write
 * a sealed code but their role can't read `code_enc` back; only the worker opens it.
 */
export const lockboxes = addonRealestate.table(
  'lockboxes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    kind: text('kind').notNull().$type<LockboxKind>(),
    place: text('place'),
    serial: text('serial'),
    codeEnc: text('code_enc'),
    codeSetAt: ts('code_set_at'),
    codeSetBy: userRef('code_set_by'),
    removedAt: ts('removed_at'),
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

/** A lockbox opened, read from SentriLock's or Supra's email, with the showing it fits if one was booked. */
export const lockboxOpenings = addonRealestate.table(
  'lockbox_openings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    lockboxId: uuid('lockbox_id').references(() => lockboxes.id, { onDelete: 'set null' }),
    vendor: text('vendor').notNull().$type<'sentrilock' | 'supra'>(),
    openedAt: ts('opened_at').notNull(),
    serial: text('serial'),
    openedBy: text('opened_by'),
    company: text('company'),
    phone: text('phone'),
    showingId: uuid('showing_id').references(() => showings.id, { onDelete: 'set null' }),
    booked: boolean('booked').notNull(),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.workspaceId, t.messageId),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
  ],
);

/** A vendor in the business's directory: a core company, with its services, areas, approval and any disclosure. */
export const vendors = addonRealestate.table(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    services: text('services').array().notNull().$type<VendorService[]>(),
    areas: text('areas')
      .array()
      .notNull()
      .default(sql`'{}'`),
    approved: boolean('approved').notNull().default(false),
    approvedBy: userRef('approved_by'),
    approvedAt: ts('approved_at'),
    disclosure: text('disclosure'),
    note: text('note'),
    archivedAt: ts('archived_at'),
    archivedBy: userRef('archived_by'),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.companyId)],
);

/** A vendor picked on a duty, with their quote and appointment. */
export const dutyVendors = addonRealestate.table(
  'duty_vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    dutyId: uuid('duty_id').notNull(),
    vendorId: uuid('vendor_id').notNull(),
    service: text('service').notNull().$type<VendorService>(),
    quoteCents: bigint('quote_cents', { mode: 'number' }),
    quoteDocumentId: uuid('quote_document_id'),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    pickedBy: userRef('picked_by'),
    pickedAt: ts('picked_at').notNull().defaultNow(),
    removedAt: ts('removed_at'),
    removedBy: userRef('removed_by'),
    removedReason: text('removed_reason'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.dealRecordId],
      foreignColumns: [deals.workspaceId, deals.recordId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.dutyId],
      foreignColumns: [duties.workspaceId, duties.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.vendorId],
      foreignColumns: [vendors.workspaceId, vendors.id],
    }).onDelete('cascade'),
  ],
);

/** What an agent notes at a stop, a showing or an open house (round six, B-07): typed, spoken or photographed. */
export const fieldNotes = addonRealestate.table(
  'field_notes',
  {
    /** Made on the phone. */
    id: uuid('id').primaryKey(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    aboutKind: text('about_kind')
      .notNull()
      .$type<'deal' | 'home' | 'tour_stop' | 'showing' | 'open_house' | 'walkthrough'>(),
    aboutId: uuid('about_id'),
    body: text('body'),
    audioFileId: uuid('audio_file_id').references(() => files.id, { onDelete: 'set null' }),
    transcript: text('transcript'),
    transcriptState: text('transcript_state')
      .notNull()
      .default('none')
      .$type<'none' | 'waiting' | 'done' | 'failed'>(),
    photoFileIds: uuid('photo_file_ids').array().notNull().default([]),
    createdBy: userRef('created_by'),
    notedAt: ts('noted_at').notNull(),
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

/** The final walkthrough (round six, X-24), checked on the phone. */
export const walkthroughs = addonRealestate.table(
  'walkthroughs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    scheduledAt: ts('scheduled_at'),
    state: text('state').notNull().default('planned').$type<'planned' | 'started' | 'done'>(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    clientsAgreedAt: ts('clients_agreed_at'),
    createdBy: userRef('created_by'),
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

/** One thing to check on a walkthrough: a repair agreed, an item that stays or goes, a finding, a room. */
export const walkthroughItems = addonRealestate.table(
  'walkthrough_items',
  {
    id: uuid('id').primaryKey(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    walkthroughId: uuid('walkthrough_id')
      .notNull()
      .references(() => walkthroughs.id, { onDelete: 'cascade' }),
    source: text('source')
      .notNull()
      .$type<'repair' | 'included' | 'excluded' | 'finding' | 'room' | 'added'>(),
    sourceRef: uuid('source_ref'),
    title: text('title').notNull(),
    detail: text('detail'),
    state: text('state')
      .notNull()
      .default('unchecked')
      .$type<'unchecked' | 'ok' | 'not_ok' | 'unsure'>(),
    note: text('note'),
    photoFileIds: uuid('photo_file_ids').array().notNull().default([]),
    checkedBy: userRef('checked_by'),
    checkedAt: ts('checked_at'),
    dutyId: uuid('duty_id'),
    position: integer('position').notNull().default(0),
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

/** A whole transaction exported (round six): the zip, a core file on the deal, and its manifest's fingerprint. */
export const exports = addonRealestate.table(
  'exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    dealRecordId: uuid('deal_record_id').notNull(),
    state: text('state').notNull().default('building').$type<'building' | 'ready' | 'failed'>(),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    manifestSha256: text('manifest_sha256'),
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
    failure: text('failure'),
    requestedBy: userRef('requested_by'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    readyAt: ts('ready_at'),
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

/** Every table above, round five's and six's too, for the test that holds the mirror to the live columns. */
export const REALESTATE_TABLES_ALL = {
  ...REALESTATE_TABLES,
  feedMatches,
  esignEnvelopes,
  showings,
  vendors,
  dutyVendors,
  fieldNotes,
  walkthroughs,
  walkthroughItems,
  exports,
  lockboxes,
  lockboxOpenings,
} as const;
