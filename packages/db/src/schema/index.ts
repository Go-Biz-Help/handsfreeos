/**
 * Drizzle mirror of the `app` schema. The SQL in supabase/migrations is the source of truth;
 * test/parity.test.ts asserts these definitions match the live database column for column.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  customType,
  date,
  doublePrecision,
  jsonb,
  integer,
  numeric,
  pgSchema,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const app = pgSchema('app');

export const memberRole = app.enum('member_role', ['owner', 'admin', 'member']);
export const orgRole = app.enum('org_role', ['owner', 'admin']);
export const actorType = app.enum('actor_type', [
  'human',
  'system',
  'workflow',
  'assistant',
  'ai_employee',
  'api',
  'integration',
]);
export const outboxStatus = app.enum('outbox_status', ['pending', 'done', 'failed']);

export type MemberRole = (typeof memberRole.enumValues)[number];
export type OrgRole = (typeof orgRole.enumValues)[number];
export type ActorType = (typeof actorType.enumValues)[number];

export const citext = customType<{ data: string }>({ dataType: () => 'extensions.citext' });
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});
export const inet = customType<{ data: string }>({ dataType: () => 'inet' });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().defaultRandom();
const timestamps = () => ({
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
type Json = Record<string, unknown>;

export const organizations = app.table('organizations', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdBy: uuid('created_by'),
  ...timestamps(),
});

export const workspaces = app.table('workspaces', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  timezone: text('timezone').notNull().default('America/Chicago'),
  industry: text('industry').notNull().default('home_services'),
  settings: jsonb('settings').$type<Json>().notNull().default({}),
  createdBy: uuid('created_by'),
  /** An owner asked for the business to be deleted (0093): hidden from everybody, and the worker purges it. */
  deletionRequestedAt: ts('deletion_requested_at'),
  deletionRequestedBy: uuid('deletion_requested_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  /** The model its calls think with, picked by support in /admin; null is the worker's VOICE_MODEL. */
  phoneModel: text('phone_model'),
  /** HandsFreeOS's own business (M19): the one workspace that may send and receive on handsfreeos.com. */
  isPlatform: boolean('is_platform').notNull().default(false),
  ...timestamps(),
});

export const locations = app.table('locations', {
  id: id(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  address: jsonb('address').$type<Json>().notNull().default({}),
  timezone: text('timezone'),
  ...timestamps(),
});

export const teams = app.table('teams', {
  id: id(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  ...timestamps(),
});

export const users = app.table('users', {
  id: uuid('id').primaryKey(),
  email: citext('email').notNull().unique(),
  fullName: text('full_name').notNull().default(''),
  avatarUrl: text('avatar_url'),
  settings: jsonb('settings').$type<Json>().notNull().default({}),
  ...timestamps(),
  // Milestone 10 (0056): where the person belongs directly, kept by triggers on the memberships for the phone's sync.
  memberWorkspaceIds: uuid('member_workspace_ids')
    .array()
    .notNull()
    .default(sql`'{}'`),
  memberOrganizationIds: uuid('member_organization_ids')
    .array()
    .notNull()
    .default(sql`'{}'`),
  /** Milestone 10 (0059): when the person deleted their account; the profile is scrubbed and their records stay. */
  deletedAt: ts('deleted_at'),
});

export const organizationMemberships = app.table('organization_memberships', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: orgRole('role').notNull(),
  ...timestamps(),
});

export const workspaceMemberships = app.table('workspace_memberships', {
  id: id(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: memberRole('role').notNull().default('member'),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  ...timestamps(),
});

export const rolePermissions = app.table(
  'role_permissions',
  {
    role: text('role').notNull(),
    permission: text('permission').notNull(),
    /** The add-on this permission belongs to (0108); null for core's. Exists for people only while it runs. */
    addonId: text('addon_id'),
  },
  (t) => [primaryKey({ columns: [t.role, t.permission] })],
);

export const invitations = app.table('invitations', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  email: citext('email').notNull(),
  role: memberRole('role').notNull().default('member'),
  tokenHash: bytea('token_hash').unique(),
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  sentAt: ts('sent_at'),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
  revokedAt: ts('revoked_at'),
  revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

export const events = app.table('events', {
  id: id(),
  organizationId: uuid('organization_id').references(() => organizations.id),
  workspaceId: uuid('workspace_id').references(() => workspaces.id),
  eventType: text('event_type').notNull(),
  actorType: actorType('actor_type').notNull(),
  actorId: uuid('actor_id'),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  payload: jsonb('payload').$type<Json>().notNull().default({}),
  correlationId: uuid('correlation_id').notNull(),
  causationId: uuid('causation_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  /** The add-on that caused it (0108), so history says which, and its details can go when its data does. */
  addonId: text('addon_id'),
  /**
   * Milestone 10: when the change was really made (the phone's moment, corrected for its clock, never later than
   * now). Defaults to the event's own time; null on events recorded before 0054, which happened at created_at.
   */
  occurredAt: ts('occurred_at').defaultNow(),
});

export const outbox = app.table('outbox', {
  eventId: uuid('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id'),
  workspaceId: uuid('workspace_id'),
  eventType: text('event_type').notNull(),
  status: outboxStatus('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  lockedAt: ts('locked_at'),
  lockedBy: text('locked_by'),
  lastError: text('last_error'),
  ...timestamps(),
});

export const auditLogs = app.table('audit_logs', {
  id: id(),
  eventId: uuid('event_id')
    .notNull()
    .unique()
    .references(() => events.id),
  organizationId: uuid('organization_id').references(() => organizations.id),
  workspaceId: uuid('workspace_id').references(() => workspaces.id),
  actorType: actorType('actor_type').notNull(),
  actorId: uuid('actor_id'),
  actorRole: text('actor_role'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  before: jsonb('before').$type<Json | null>(),
  after: jsonb('after').$type<Json | null>(),
  reason: text('reason'),
  channel: text('channel').notNull().default('web'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  correlationId: uuid('correlation_id').notNull(),
  causationId: uuid('causation_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  /** The add-on whose command this was (0108). */
  addonId: text('addon_id'),
});

// ---------- Milestone 2: CRM core ----------
export const stageKind = app.enum('stage_kind', ['open', 'won', 'lost']);
export const leadStatus = app.enum('lead_status', ['open', 'won', 'lost']);
/** 'knowledge': a file in the knowledge base (its record is the workspace itself); tags never use it. */
export const recordType = app.enum('record_type', [
  'person',
  'company',
  'lead',
  /** A file that belongs to the business itself, not a customer: a knowledge document (0028). */
  'knowledge',
  /** The signed authorisation and the bill for moving a number to us — record_id is the port (0081). */
  'port',
  /** A record of a kind the business made up: a pet, a vehicle, a property (0100). Tags never use it. */
  'custom_record',
]);
export const activityKind = app.enum('activity_kind', [
  'note',
  'call',
  'visit',
  'email',
  'sms',
  'system',
  'chat',
]);
export const fileStatus = app.enum('file_status', ['pending', 'ready']);
export const importKind = app.enum('import_kind', ['people', 'companies']);
export const importStatus = app.enum('import_status', [
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
]);

export type StageKind = (typeof stageKind.enumValues)[number];
export type LeadStatus = (typeof leadStatus.enumValues)[number];
export type RecordType = (typeof recordType.enumValues)[number];
export type ActivityKind = (typeof activityKind.enumValues)[number];
export type ImportStatus = (typeof importStatus.enumValues)[number];

const workspaceRef = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: 'set null' });
/**
 * Milestone 10 (0055): when each column last changed, by the moment the person made the change
 * ({column: ISO time}). Written by the update commands in the same statement as the change; no trigger.
 */
const fieldTimes = () => jsonb('field_times').$type<Record<string, string>>().notNull().default({});
/**
 * Milestone 10 (0056): whether a row is inside a phone's window of recent history. Kept by triggers and the
 * worker's nightly sweep (private.sync_window_sweep); nobody writes it by hand, and writing it isn't an edit.
 */
const syncWindow = () => boolean('sync_window').notNull().default(true);
/**
 * Milestone 10 (0056) and Milestone 17 (0083): the members who may see this row, kept by triggers so a
 * member's phone syncs exactly what RLS lets them read. On money it is the lead's assignee or active staff on
 * the booking, and empty means owner business. On the inbox it is the thread's assignee and the people its
 * number rings, and **empty means the business has not narrowed its inbox at all** — the opposite default,
 * said in both migrations, because each table's wide policy is what reads the empty case.
 */
const memberViewerIds = () =>
  uuid('member_viewer_ids')
    .array()
    .notNull()
    .default(sql`'{}'`);
const addressColumns = () => ({
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  state: text('state'),
  postalCode: text('postal_code'),
  country: text('country').notNull().default('US'),
});

export const imports = app.table('imports', {
  id: id(),
  workspaceId: workspaceRef(),
  kind: importKind('kind').notNull(),
  fileName: text('file_name').notNull(),
  objectPath: text('object_path').notNull().unique(),
  mapping: jsonb('mapping').$type<Json>().notNull().default({}),
  options: jsonb('options').$type<Json>().notNull().default({}),
  status: importStatus('status').notNull().default('pending'),
  totalRows: integer('total_rows').notNull().default(0),
  processedRows: integer('processed_rows').notNull().default(0),
  createdCount: integer('created_count').notNull().default(0),
  updatedCount: integer('updated_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  lastError: text('last_error'),
  heartbeatAt: ts('heartbeat_at'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const importErrors = app.table('import_errors', {
  id: id(),
  importId: uuid('import_id')
    .notNull()
    .references(() => imports.id, { onDelete: 'cascade' }),
  workspaceId: workspaceRef(),
  rowNumber: integer('row_number').notNull(),
  message: text('message').notNull(),
  raw: jsonb('raw').$type<Json>(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const pipelines = app.table('pipelines', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const pipelineStages = app.table('pipeline_stages', {
  id: id(),
  workspaceId: workspaceRef(),
  pipelineId: uuid('pipeline_id')
    .notNull()
    .references(() => pipelines.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: stageKind('kind').notNull().default('open'),
  position: integer('position').notNull(),
  ...timestamps(),
});

export const companies = app.table('companies', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  email: citext('email'),
  phone: text('phone'),
  phoneE164: text('phone_e164'),
  website: text('website'),
  ...addressColumns(),
  notes: text('notes'),
  source: text('source'),
  ownerUserId: userRef('owner_user_id'),
  importId: uuid('import_id').references(() => imports.id, { onDelete: 'set null' }),
  importRow: integer('import_row'),
  archivedAt: ts('archived_at'),
  archivedBy: userRef('archived_by'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  searchText: text('search_text').generatedAlwaysAs(
    sql`lower(coalesce(name, '') || ' ' || coalesce(email::text, '') || ' ' || coalesce(phone_e164, '') || ' ' || coalesce(city, '') || ' ' || coalesce(address_line1, '') || ' ' || private.other_contacts_text(other_emails, other_phones, other_addresses))`,
  ),
  // Milestone 10
  fieldTimes: fieldTimes(),
  // Milestone 15: the fields this business invented, keyed by custom_fields.id.
  custom: jsonb('custom').$type<Json>().notNull().default({}),
  /** A company made with no signal that looked like this one (0059): "Possible duplicate of …". */
  possibleDuplicateOf: uuid('possible_duplicate_of').references((): AnyPgColumn => companies.id, {
    onDelete: 'set null',
  }),
  /** The emails, numbers and addresses besides the main ones (0103): see crm/contact-points. */
  otherEmails: jsonb('other_emails').$type<object[]>().notNull().default([]),
  otherPhones: jsonb('other_phones').$type<object[]>().notNull().default([]),
  otherAddresses: jsonb('other_addresses').$type<object[]>().notNull().default([]),
  /** Everyone on the company besides the owner (0104), in the order they were added. */
  teamUserIds: uuid('team_user_ids')
    .array()
    .notNull()
    .default(sql`'{}'`),
});

/** Milestone 3: whether a person agreed to texts (declared here because `people` uses it). */
export const smsConsent = app.enum('sms_consent', ['unknown', 'opted_in', 'opted_out']);

export const people = app.table('people', {
  id: id(),
  workspaceId: workspaceRef(),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  email: citext('email'),
  phone: text('phone'),
  phoneE164: text('phone_e164'),
  phoneAlt: text('phone_alt'),
  ...addressColumns(),
  notes: text('notes'),
  source: text('source'),
  ownerUserId: userRef('owner_user_id'),
  importId: uuid('import_id').references(() => imports.id, { onDelete: 'set null' }),
  importRow: integer('import_row'),
  archivedAt: ts('archived_at'),
  archivedBy: userRef('archived_by'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  searchText: text('search_text').generatedAlwaysAs(
    sql`lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email::text, '') || ' ' || coalesce(phone_e164, '') || ' ' || coalesce(city, '') || ' ' || coalesce(address_line1, '') || ' ' || private.other_contacts_text(other_emails, other_phones, other_addresses))`,
  ),
  // Milestone 3
  smsConsent: smsConsent('sms_consent').notNull().default('unknown'),
  smsConsentAt: ts('sms_consent_at'),
  smsConsentSource: text('sms_consent_source'),
  /** The separate, optional box for offers (20261013002300). STOP on `smsConsent` still stops everything. */
  offersConsent: smsConsent('offers_consent').notNull().default('unknown'),
  offersConsentAt: ts('offers_consent_at'),
  offersConsentSource: text('offers_consent_source'),
  /** AI outbound calls: written consent to calls (campaign calls need it), and where it is. */
  callConsent: smsConsent('call_consent').notNull().default('unknown'),
  callConsentAt: ts('call_consent_at'),
  callConsentSource: text('call_consent_source'),
  // Milestone 10
  fieldTimes: fieldTimes(),
  /** A customer made with no signal that looked like this one (0059): "Possible duplicate of …". */
  possibleDuplicateOf: uuid('possible_duplicate_of').references((): AnyPgColumn => people.id, {
    onDelete: 'set null',
  }),
  // Milestone 15: the fields this business invented, keyed by custom_fields.id.
  custom: jsonb('custom').$type<Json>().notNull().default({}),
  /** The emails, numbers and addresses besides the main ones (0103): see crm/contact-points. */
  otherEmails: jsonb('other_emails').$type<object[]>().notNull().default([]),
  otherPhones: jsonb('other_phones').$type<object[]>().notNull().default([]),
  otherAddresses: jsonb('other_addresses').$type<object[]>().notNull().default([]),
  /** Everyone on the customer besides the owner (0104), in the order they were added. */
  teamUserIds: uuid('team_user_ids')
    .array()
    .notNull()
    .default(sql`'{}'`),
  /** A duplicate merged into another record (person.merge): archived, and pointing at the one kept. */
  mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => people.id, {
    onDelete: 'set null',
  }),
  mergedAt: ts('merged_at'),
});

export const tags = app.table('tags', {
  id: id(),
  workspaceId: workspaceRef(),
  name: citext('name').notNull(),
  color: text('color').notNull().default('#2d69d8'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const recordTags = app.table(
  'record_tags',
  {
    workspaceId: workspaceRef(),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    recordType: recordType('record_type').notNull(),
    recordId: uuid('record_id').notNull(),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tagId, t.recordType, t.recordId] })],
);

/** Milestone 10: when a tag last came off a record, at the moment the change was made (0063, a trigger's). */
export const recordTagRemovals = app.table(
  'record_tag_removals',
  {
    workspaceId: workspaceRef(),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    recordType: recordType('record_type').notNull(),
    recordId: uuid('record_id').notNull(),
    removedAt: ts('removed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tagId, t.recordType, t.recordId] })],
);

export const leads = app.table('leads', {
  id: id(),
  workspaceId: workspaceRef(),
  pipelineId: uuid('pipeline_id')
    .notNull()
    .references(() => pipelines.id, { onDelete: 'restrict' }),
  stageId: uuid('stage_id')
    .notNull()
    .references(() => pipelineStages.id, { onDelete: 'restrict' }),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'restrict' }),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  valueCents: bigint('value_cents', { mode: 'number' }).notNull().default(0),
  source: text('source'),
  assigneeUserId: userRef('assignee_user_id'),
  expectedCloseOn: date('expected_close_on'),
  nextAction: text('next_action'),
  nextActionAt: ts('next_action_at'),
  status: leadStatus('status').notNull().default('open'),
  wonAt: ts('won_at'),
  lostAt: ts('lost_at'),
  lostReason: text('lost_reason'),
  position: bigint('position', { mode: 'number' }).notNull().default(0),
  stageEnteredAt: ts('stage_entered_at').notNull().defaultNow(),
  archivedAt: ts('archived_at'),
  archivedBy: userRef('archived_by'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  searchText: text('search_text').generatedAlwaysAs(sql`lower(coalesce(title, ''))`),
  // Milestone 7: answers to the qualifying questions, each question's text copied in (core's shape).
  qualification: jsonb('qualification').$type<Json>().notNull().default({}),
  // Milestone 8: kept by a trigger on activities (0040); nobody writes them directly.
  /** The latest real contact, either way: a text, email, chat, connected call, voicemail or visit. */
  lastContactAt: ts('last_contact_at'),
  /** The business's first reach-out once the lead existed; set once. */
  firstResponseAt: ts('first_response_at'),
  // Milestone 10
  fieldTimes: fieldTimes(),
  // Milestone 15: the fields this business invented, keyed by custom_fields.id.
  custom: jsonb('custom').$type<Json>().notNull().default({}),
});

export const tasks = app.table('tasks', {
  id: id(),
  workspaceId: workspaceRef(),
  title: text('title').notNull(),
  notes: text('notes'),
  dueAt: ts('due_at'),
  allDay: boolean('all_day').notNull().default(true),
  assigneeUserId: userRef('assignee_user_id'),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  doneAt: ts('done_at'),
  doneBy: userRef('done_by'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  // Milestone 10
  fieldTimes: fieldTimes(),
  /** Open, or done within the last 90 days: what a phone keeps. */
  syncWindow: syncWindow(),
  /** The pet, vehicle or property it is about (0101). */
  customRecordId: uuid('custom_record_id').references((): AnyPgColumn => customRecords.id, {
    onDelete: 'set null',
  }),
});

export const activities = app.table('activities', {
  id: id(),
  workspaceId: workspaceRef(),
  kind: activityKind('kind').notNull(),
  subtype: text('subtype'),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  body: text('body'),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
  authorUserId: userRef('author_user_id'),
  actorType: actorType('actor_type').notNull().default('human'),
  eventId: uuid('event_id')
    .unique()
    .references(() => events.id, { onDelete: 'restrict' }),
  meta: jsonb('meta').$type<Json>().notNull().default({}),
  ...timestamps(),
  // Milestone 10
  syncWindow: syncWindow(),
  /** A record of a kind the business made up, whose timeline this is on too (0101). */
  customRecordId: uuid('custom_record_id').references((): AnyPgColumn => customRecords.id, {
    onDelete: 'set null',
  }),
});

export const files = app.table('files', {
  id: id(),
  workspaceId: workspaceRef(),
  recordType: recordType('record_type').notNull(),
  recordId: uuid('record_id').notNull(),
  bucket: text('bucket').notNull().default('attachments'),
  objectPath: text('object_path').notNull().unique(),
  name: text('name').notNull(),
  mimeType: text('mime_type'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  status: fileStatus('status').notNull().default('pending'),
  createdBy: userRef('created_by'),
  deletedAt: ts('deleted_at'),
  deletedBy: userRef('deleted_by'),
  ...timestamps(),
});

// ---------- Milestone 3: communication ----------
export const telephonyProvider = app.enum('telephony_provider', ['twilio', 'fake']);
export const telephonyAccountStatus = app.enum('telephony_account_status', [
  'provisioning',
  'active',
  'suspended',
  'closed',
]);
export const phoneNumberType = app.enum('phone_number_type', ['local', 'toll_free']);
export const phoneNumberStatus = app.enum('phone_number_status', [
  'provisioning',
  /** On its way to us from another carrier: claimed and visible, not yet able to send (M17). */
  'porting',
  'active',
  'failed',
  'releasing',
  'released',
]);
export const registrationKind = app.enum('registration_kind', [
  'toll_free_verification',
  'a2p_customer_profile',
  'a2p_trust_product',
  'a2p_brand',
  'a2p_campaign',
]);
export const registrationStatus = app.enum('registration_status', [
  'draft',
  'submitted',
  'in_review',
  'approved',
  'rejected',
  'failed',
]);
export const channel = app.enum('channel', ['sms', 'email', 'chat']);
export const conversationStatus = app.enum('conversation_status', ['open', 'snoozed', 'closed']);
export const direction = app.enum('direction', ['inbound', 'outbound']);
export const messageStatus = app.enum('message_status', [
  'queued',
  'sending',
  'sent',
  'delivered',
  /** RCS says when the customer opened it (0102). Only ever follows `delivered`. */
  'read',
  'undelivered',
  'failed',
  'received',
  'bounced',
  'complained',
]);
/** How a text actually went, or came in (0102): SMS, a picture message, or RCS. */
export const textTransport = app.enum('text_transport', ['sms', 'mms', 'rcs']);
export type TextTransport = (typeof textTransport.enumValues)[number];
/** A business's RCS sender, from asking to connect it to letting it go (0102). */
export const rcsSenderStatus = app.enum('rcs_sender_status', [
  'connecting',
  'in_review',
  'active',
  'offline',
  'failed',
  'disconnecting',
  'disconnected',
]);
export type RcsSenderStatus = (typeof rcsSenderStatus.enumValues)[number];
export const callStatus = app.enum('call_status', [
  'initiated',
  'ringing',
  'in_progress',
  'completed',
  'no_answer',
  'busy',
  'failed',
  'canceled',
]);
/** bridge (Milestone 10): placed through the person's own cell, which HandsFreeOS rang first. */
export const callAnsweredVia = app.enum('call_answered_via', [
  'browser',
  'forwarding',
  'bridge',
  'ai',
]);
export const optOutSource = app.enum('opt_out_source', ['keyword', 'manual', 'carrier_error']);
export const deliveryStatus = app.enum('delivery_status', ['pending', 'done', 'failed', 'ignored']);
export const jobStatus = app.enum('job_status', ['pending', 'done', 'failed', 'cancelled']);

export type Channel = (typeof channel.enumValues)[number];
export type ConversationStatus = (typeof conversationStatus.enumValues)[number];
export type Direction = (typeof direction.enumValues)[number];
export type MessageStatus = (typeof messageStatus.enumValues)[number];
export type CallStatus = (typeof callStatus.enumValues)[number];
export type PhoneNumberStatus = (typeof phoneNumberStatus.enumValues)[number];
export type RegistrationKind = (typeof registrationKind.enumValues)[number];
export type RegistrationStatus = (typeof registrationStatus.enumValues)[number];
export type SmsConsent = (typeof smsConsent.enumValues)[number];

// Milestone 3: email (0012)
export const emailDomainStatus = app.enum('email_domain_status', ['pending', 'verified', 'failed']);
export const mailboxProvider = app.enum('mailbox_provider', ['microsoft', 'google']);
export const mailboxStatus = app.enum('mailbox_status', [
  'pending',
  'active',
  'reauth_required',
  'error',
  'disconnected',
]);
export const suppressionReason = app.enum('suppression_reason', [
  'hard_bounce',
  'spam_complaint',
  'manual',
]);
/** Whether a domain's mail arrives in HandsFreeOS (M19): people ask (pending), the worker says on or lapsed. */
export const emailReceivingStatus = app.enum('email_receiving_status', [
  'off',
  'pending',
  'on',
  'lapsed',
]);
export type EmailDomainStatus = (typeof emailDomainStatus.enumValues)[number];
export type EmailReceivingStatus = (typeof emailReceivingStatus.enumValues)[number];
export type MailboxProvider = (typeof mailboxProvider.enumValues)[number];
export type MailboxStatus = (typeof mailboxStatus.enumValues)[number];
export type SuppressionReason = (typeof suppressionReason.enumValues)[number];

// Milestone 4: the Assistant (0014)
export const assistantRole = app.enum('assistant_role', ['user', 'assistant']);
export const assistantRunStatus = app.enum('assistant_run_status', [
  'running',
  'done',
  'failed',
  'cancelled',
]);
export const assistantAutonomy = app.enum('assistant_autonomy', ['auto', 'confirm']);
export const assistantToolStatus = app.enum('assistant_tool_status', [
  'done',
  'failed',
  'awaiting_confirmation',
  'confirmed',
  'cancelled',
  'expired',
]);
export type AssistantToolStatus = (typeof assistantToolStatus.enumValues)[number];

/** A forwarding phone that rings with the browsers when a customer calls. */
export interface ForwardingPhone {
  readonly e164: string;
  readonly label: string;
  readonly enabled: boolean;
}
export interface PhoneRouting {
  readonly forwarding: readonly ForwardingPhone[];
  readonly ringSeconds: number;
  readonly voicemailEnabled: boolean;
  readonly voicemailGreeting: string | null;
  /** Milestone 10: what forwarding phones show when a customer calls (missing: the customer's number). */
  readonly forwardedCallerId?: 'customer' | 'business';
}
/** A stored copy of an MMS photo, a recording or an email attachment in the `telephony` bucket. */
export interface MediaRef {
  readonly bucket: string;
  readonly objectPath: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly name: string;
  /** A customer file (app.files) sent as an outbound attachment. */
  readonly fileId?: string;
}

/**
 * One button on a rich text (0103). `reply` sends its title back as the customer's answer; `link` opens a web
 * page; `call` rings a number. `id` is what Twilio hands back when it is tapped (`ButtonPayload`), made from the
 * message's own id so a tap always finds the message it came from.
 */
export interface RichButtonRef {
  readonly type: 'reply' | 'link' | 'call';
  readonly title: string;
  readonly id: string;
  readonly url?: string;
  readonly phone?: string;
}

/** One card of a carousel (0103): its picture, its words and one or two buttons. */
export interface RichCardRef {
  readonly title: string | null;
  readonly body: string;
  readonly media: MediaRef;
  readonly buttons: readonly RichButtonRef[];
}

/**
 * What a rich text carried (0103), stored on `messages.rich`. The message's own words are its body; this is what
 * rides with them:
 *
 * - `buttons`: suggested replies and action buttons under the words (and the photo, when it has one);
 * - `card`: the words under a title, with the photo on top and up to four buttons;
 * - `carousel`: two to ten cards side by side, each with its own picture, words and buttons.
 *
 * `smsText` is what a phone without RCS got instead: the same words with the choices listed, which is also what
 * counts its segments.
 */
export interface RichText {
  readonly kind: 'buttons' | 'card' | 'carousel';
  readonly title: string | null;
  readonly buttons: readonly RichButtonRef[];
  readonly cards: readonly RichCardRef[];
  readonly smsText: string;
}

/**
 * Which button a customer's reply came from (0103): a tap on RCS, or — on a phone that got the list as a text —
 * the number they texted back. The reply's own words stay the button's title, so everything that reads a
 * message's text reads it as what they chose.
 */
export interface ButtonReply {
  readonly type: 'reply' | 'link' | 'call';
  readonly title: string;
  /** The button's id, when it was one of ours. */
  readonly id: string | null;
  /** The message whose button it was, when that could be told. */
  readonly messageId: string | null;
  /** A tap on RCS, or their choice texted back — its number or its name — to the list a plain text showed. */
  readonly via: 'tap' | 'text';
}

/**
 * How a failed text stood before it was tried again in quiet hours (message.retry), kept on `messages.failed_attempt`
 * while the retry waits for them to end, so cancelling the retry puts it back as it was.
 */
export interface FailedAttempt {
  readonly status: 'failed' | 'undelivered';
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly occurredAt: string;
}

export const telephonyAccounts = app.table('telephony_accounts', {
  id: id(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: telephonyProvider('provider').notNull(),
  accountSid: text('account_sid').unique(),
  authTokenEnc: text('auth_token_enc'),
  apiKeySid: text('api_key_sid'),
  apiKeySecretEnc: text('api_key_secret_enc'),
  twimlAppSid: text('twiml_app_sid'),
  messagingServiceSid: text('messaging_service_sid'),
  keyId: text('key_id'),
  webhookBaseUrl: text('webhook_base_url'),
  status: telephonyAccountStatus('status').notNull().default('provisioning'),
  lastError: text('last_error'),
  ...timestamps(),
});

export const phoneNumbers = app.table('phone_numbers', {
  id: id(),
  workspaceId: workspaceRef(),
  accountId: uuid('account_id').references(() => telephonyAccounts.id, { onDelete: 'set null' }),
  providerSid: text('provider_sid').unique(),
  e164: text('e164').notNull(),
  numberType: phoneNumberType('number_type').notNull(),
  label: text('label'),
  capabilities: jsonb('capabilities').$type<Json>().notNull().default({}),
  status: phoneNumberStatus('status').notNull().default('provisioning'),
  /**
   * The number a new conversation sends from, and what Settings shows first. Exactly one per workspace among
   * live numbers, kept by `private.phone_numbers_keep_default()` — never write it expecting to be the only
   * one, the trigger stands the others down.
   */
  isDefault: boolean('is_default').notNull().default(false),
  routing: jsonb('routing')
    .$type<PhoneRouting>()
    .notNull()
    .default({ forwarding: [], ringSeconds: 20, voicemailEnabled: true, voicemailGreeting: null }),
  lastError: text('last_error'),
  purchasedAt: ts('purchased_at'),
  releasedAt: ts('released_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const telephonyRegistrations = app.table('telephony_registrations', {
  id: id(),
  workspaceId: workspaceRef(),
  accountId: uuid('account_id').references(() => telephonyAccounts.id, { onDelete: 'set null' }),
  phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id, {
    onDelete: 'set null',
  }),
  kind: registrationKind('kind').notNull(),
  status: registrationStatus('status').notNull().default('draft'),
  dependsOnId: uuid('depends_on_id'),
  providerSid: text('provider_sid'),
  providerStatus: text('provider_status'),
  submission: jsonb('submission').$type<Json>().notNull().default({}),
  rejectionReason: text('rejection_reason'),
  submittedAt: ts('submitted_at'),
  approvedAt: ts('approved_at'),
  nextPollAt: ts('next_poll_at'),
  pollCount: integer('poll_count').notNull().default(0),
  /** The submitted_at of the details the carrier last received; a different submitted_at is not sent yet. */
  carrierSubmittedAt: ts('carrier_submitted_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/**
 * The texting registration as the business fills it in (20261013002200): the wizard's answers, one row per
 * business, until it is sent. `registration.submit` deletes it.
 */
export const registrationDrafts = app.table('registration_drafts', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  answers: jsonb('answers').$type<Json>().notNull().default({}),
  updatedBy: userRef('updated_by'),
  ...timestamps(),
});

/**
 * Milestone 17: moving a number a business already owns to us (0080).
 *
 * Deliberately **not** `app.port_state` and **not** `app.migration_port_requests` — that pair belongs to the
 * CRM-migration wizard and has `migration_id not null`. The status list here is shaped like
 * `registration_status`, because this is the same machine: paperwork goes out, the carrier takes its time, a
 * job polls, an answer comes back.
 */
export const numberPortKind = app.enum('number_port_kind', ['full', 'hosted_messaging']);
export type NumberPortKind = (typeof numberPortKind.enumValues)[number];
export const numberPortStatus = app.enum('number_port_status', [
  'draft',
  'submitted',
  'carrier_review',
  'scheduled',
  'complete',
  'rejected',
  'cancelled',
  'failed',
]);
export type NumberPortStatus = (typeof numberPortStatus.enumValues)[number];

export const numberPorts = app.table('number_ports', {
  id: id(),
  workspaceId: workspaceRef(),
  accountId: uuid('account_id').references(() => telephonyAccounts.id, { onDelete: 'set null' }),
  e164: text('e164').notNull(),
  kind: numberPortKind('kind').notNull(),
  status: numberPortStatus('status').notNull().default('draft'),
  phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id, {
    onDelete: 'set null',
  }),
  /**
   * The losing carrier's account number, PIN, authorising name and service address. **Their credentials, not
   * ours to spread**: this table is absent from the `powersync` publication on purpose, nothing logs it, and
   * no output schema returns it — `NumberPortOut` says which fields are filled, never what they say.
   */
  submission: jsonb('submission').$type<Json>().notNull().default({}),
  /** Which papers are in, and where they sit in the `telephony` bucket. Never what they say. */
  documents: jsonb('documents').$type<Json>().notNull().default({}),
  providerSid: text('provider_sid'),
  providerStatus: text('provider_status'),
  rejectionReason: text('rejection_reason'),
  lastError: text('last_error'),
  nextPollAt: ts('next_poll_at'),
  pollCount: integer('poll_count').notNull().default(0),
  /** The day the carrier commits to. A business plans its week around this one, so it is a date, not a time. */
  scheduledFor: date('scheduled_for'),
  submittedAt: ts('submitted_at'),
  carrierSubmittedAt: ts('carrier_submitted_at'),
  completedAt: ts('completed_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/**
 * Bringing a number that already lives in Twilio (20261010000900): from the business's own Twilio account, or
 * from GoHighLevel / LeadConnector, whose LC Phone numbers are Twilio numbers in HighLevel's account. The number
 * moves account to account inside Twilio — no port, no new number — and the worker watches the workspace's
 * subaccount for it. **Separate from carrier registration**: an import finishes when the number works here,
 * whether or not texting has been approved yet.
 */
export const numberImportSource = app.enum('number_import_source', ['twilio', 'highlevel']);
export type NumberImportSource = (typeof numberImportSource.enumValues)[number];
export const numberImportStatus = app.enum('number_import_status', [
  'waiting',
  'complete',
  'failed',
  'cancelled',
]);
export type NumberImportStatus = (typeof numberImportStatus.enumValues)[number];
export const twilioConnectionStatus = app.enum('twilio_connection_status', [
  'active',
  'broken',
  'disconnected',
]);

/**
 * A Twilio account a business connected so HandsFreeOS can list its numbers. The organization's, because one
 * account often holds numbers for several of its businesses; seen by its owners and admins only. The secret is
 * sealed by the worker and no person can select it.
 */
export const twilioConnections = app.table('twilio_connections', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  accountSid: text('account_sid').notNull(),
  friendlyName: text('friendly_name'),
  /** The API key (SK…) they gave us, or null for the account's own auth token. */
  apiKeySid: text('api_key_sid'),
  secretEnc: text('secret_enc'),
  keyId: text('key_id'),
  status: twilioConnectionStatus('status').notNull().default('active'),
  lastError: text('last_error'),
  checkedAt: ts('checked_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const numberImports = app.table('number_imports', {
  id: id(),
  workspaceId: workspaceRef(),
  e164: text('e164').notNull(),
  source: numberImportSource('source').notNull(),
  status: numberImportStatus('status').notNull().default('waiting'),
  connectionId: uuid('connection_id').references(() => twilioConnections.id, {
    onDelete: 'set null',
  }),
  /** The account holding the number today, and its id there: what the transfer request names. */
  sourceAccountSid: text('source_account_sid'),
  sourceNumberSid: text('source_number_sid'),
  /** Who hosts it, by the carrier lookup. A Twilio carrier is what says it can move account to account. */
  carrierName: text('carrier_name'),
  hostedInTwilio: boolean('hosted_in_twilio'),
  lookedUpAt: ts('looked_up_at'),
  accountId: uuid('account_id').references(() => telephonyAccounts.id, { onDelete: 'set null' }),
  /** The workspace's own subaccount: where the owner asks for the number to be sent. */
  destinationAccountSid: text('destination_account_sid'),
  providerSid: text('provider_sid'),
  phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id, {
    onDelete: 'set null',
  }),
  numberType: phoneNumberType('number_type'),
  lastError: text('last_error'),
  nextPollAt: ts('next_poll_at'),
  pollCount: integer('poll_count').notNull().default(0),
  lastCheckedAt: ts('last_checked_at'),
  completedAt: ts('completed_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/**
 * A business's RCS sender (0103). Made and approved at Twilio, in the business's own subaccount; connected here,
 * which puts it on the business's messaging service so every text goes RCS first. A person connects it, pauses
 * it and lets it go; everything Twilio says is the worker's to write (`private.guard_rcs_sender_update`).
 */
export const rcsSenders = app.table('rcs_senders', {
  id: id(),
  workspaceId: workspaceRef(),
  accountId: uuid('account_id').references(() => telephonyAccounts.id, { onDelete: 'set null' }),
  /** The sender's id at Twilio without `rcs:` in front: `lonestar_hvac_agent`. */
  senderId: text('sender_id').notNull(),
  status: rcsSenderStatus('status').notNull().default('connecting'),
  /** Off keeps the sender and sends every text as SMS or MMS until it is back on. */
  enabled: boolean('enabled').notNull().default(true),
  /** Where a customer's first RCS message starts its thread; null is the default number. */
  phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id, {
    onDelete: 'set null',
  }),
  providerSid: text('provider_sid'),
  providerStatus: text('provider_status'),
  displayName: text('display_name'),
  inService: boolean('in_service').notNull().default(false),
  lastError: text('last_error'),
  checkedAt: ts('checked_at'),
  nextPollAt: ts('next_poll_at'),
  pollCount: integer('poll_count').notNull().default(0),
  connectedAt: ts('connected_at'),
  disconnectedAt: ts('disconnected_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** Milestone 7: who answers a conversation (declared here because `conversations` uses it). */
export const conversationHandler = app.enum('conversation_handler', ['none', 'ai', 'person']);
export type ConversationHandler = (typeof conversationHandler.enumValues)[number];

/** M19: where a thread lives. Only Inbox threads wake the AI teammate, workflows, push and the timeline. */
export const conversationFolder = app.enum('conversation_folder', ['inbox', 'other', 'spam']);
export type ConversationFolder = (typeof conversationFolder.enumValues)[number];

export const conversations = app.table('conversations', {
  id: id(),
  workspaceId: workspaceRef(),
  channel: channel('channel').notNull(),
  counterpart: text('counterpart').notNull(),
  phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id, {
    onDelete: 'set null',
  }),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  status: conversationStatus('status').notNull().default('open'),
  assigneeUserId: userRef('assignee_user_id'),
  snoozedUntil: ts('snoozed_until'),
  unreadCount: integer('unread_count').notNull().default(0),
  lastMessageAt: ts('last_message_at'),
  lastInboundAt: ts('last_inbound_at'),
  lastOutboundAt: ts('last_outbound_at'),
  lastPreview: text('last_preview'),
  lastDirection: direction('last_direction'),
  awaitingReplySince: ts('awaiting_reply_since'),
  closedAt: ts('closed_at'),
  closedBy: userRef('closed_by'),
  /** Out of the inbox, keeping its status: restoring brings back the open, snoozed or closed thread as it was. */
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  emailAddressId: uuid('email_address_id').references(() => emailAddresses.id, {
    onDelete: 'set null',
  }),
  /** Reply-To carries it as the mailbox hash, so a reply finds its conversation. */
  emailReplyToken: text('email_reply_token').unique(),
  // Milestone 7: who answers it, and when it needs a person.
  handledBy: conversationHandler('handled_by').notNull().default('none'),
  aiTeammateId: uuid('ai_teammate_id').references((): AnyPgColumn => aiTeammates.id),
  /** Raised whenever it changes hands; a run started under an older epoch is superseded. */
  aiEpoch: integer('ai_epoch').notNull().default(0),
  needsPersonSince: ts('needs_person_since'),
  /**
   * asked_for_person, frustrated, cant_answer, sensitive, emergency, legal, complaint, refund,
   * cancellation, limit, budget, wallet, error, draft_expired, loop, other.
   */
  handoffReason: text('handoff_reason'),
  handoffNote: text('handoff_note'),
  takenOverBy: userRef('taken_over_by'),
  /** The newest customer message the teammate has answered. */
  aiAnsweredThrough: ts('ai_answered_through'),
  aiDisclosedAt: ts('ai_disclosed_at'),
  // Milestone 10
  /** When it was last opened, closed or snoozed, or its snooze moved, at the moment the change was made (0063). */
  statusChangedAt: ts('status_changed_at'),
  /**
   * The members who may see this while the business narrows its inbox (0083). Empty means narrowing is off
   * and everyone with the inbox sees everything. Kept by triggers; a value sent by a caller is replaced.
   */
  memberViewerIds: memberViewerIds(),
  // Milestone 18
  /** The language the customer writes in, as the AI teammate last said ("es"); null until it knows. */
  language: text('language'),
  /** M19: the Inbox, Other mail or Spam. Set when the thread starts; only people move it. */
  folder: conversationFolder('folder').notNull().default('inbox'),
  /** M19: the one person who may read it (their own address's mail); null is the team's. Never linked to a customer. */
  privateTo: uuid('private_to'),
});

/** M19: where new mail from a sender goes, as a person chose when they moved one of that sender's threads. */
export const emailSenderRules = app.table('email_sender_rules', {
  id: id(),
  workspaceId: workspaceRef(),
  /** One rule per sender in a business (email_sender_rules_one_per_sender). */
  address: text('address').notNull(),
  folder: conversationFolder('folder').notNull(),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const messages = app.table('messages', {
  id: id(),
  workspaceId: workspaceRef(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  channel: channel('channel').notNull(),
  direction: direction('direction').notNull(),
  status: messageStatus('status').notNull(),
  fromAddress: text('from_address'),
  toAddresses: text('to_addresses')
    .array()
    .notNull()
    .default(sql`'{}'`),
  ccAddresses: text('cc_addresses')
    .array()
    .notNull()
    .default(sql`'{}'`),
  subject: text('subject'),
  bodyText: text('body_text'),
  bodyHtml: text('body_html'),
  media: jsonb('media').$type<MediaRef[]>().notNull().default([]),
  provider: text('provider'),
  providerMessageId: text('provider_message_id'),
  dedupeKey: text('dedupe_key'),
  messageIdHeader: text('message_id_header'),
  inReplyToHeader: text('in_reply_to_header'),
  referencesHeaders: text('references_headers')
    .array()
    .notNull()
    .default(sql`'{}'`),
  providerThreadId: text('provider_thread_id'),
  segments: integer('segments'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  sentBy: userRef('sent_by'),
  clientId: text('client_id'),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
  sentAt: ts('sent_at'),
  deliveredAt: ts('delivered_at'),
  activityId: uuid('activity_id').references(() => activities.id, { onDelete: 'set null' }),
  ...timestamps(),
  emailAddressId: uuid('email_address_id').references(() => emailAddresses.id, {
    onDelete: 'set null',
  }),
  mailboxConnectionId: uuid('mailbox_connection_id').references(() => mailboxConnections.id, {
    onDelete: 'set null',
  }),
  // Milestone 7: the teammate that wrote it (never changes; sent_by is then null), its run and draft,
  // and the person whose OK sent it.
  sentByTeammateId: uuid('sent_by_teammate_id').references((): AnyPgColumn => aiTeammates.id),
  aiRunId: uuid('ai_run_id').references((): AnyPgColumn => aiTeammateRuns.id, {
    onDelete: 'set null',
  }),
  aiDraftId: uuid('ai_draft_id').references((): AnyPgColumn => aiTeammateDrafts.id, {
    onDelete: 'set null',
  }),
  approvedBy: userRef('approved_by'),
  // Milestone 10
  syncWindow: syncWindow(),
  /**
   * The members who may see this while the business narrows its inbox (0083). Empty means narrowing is off
   * and everyone with the inbox sees everything. Kept by triggers; a value sent by a caller is replaced.
   */
  memberViewerIds: memberViewerIds(),
  // RCS (0103): how it went, when it was read, what it carried and which button a reply came from.
  transport: textTransport('transport'),
  readAt: ts('read_at'),
  rich: jsonb('rich').$type<RichText>(),
  buttonReply: jsonb('button_reply').$type<ButtonReply>(),
  contentSid: text('content_sid'),
  /** Email campaigns: the campaign email this is, so the sender adds the unsubscribe headers. */
  campaignRecipientId: uuid('campaign_recipient_id').references(
    (): AnyPgColumn => campaignRecipients.id,
    { onDelete: 'set null' },
  ),
  /** A failed text tried again in quiet hours, while it waits: how the attempt that failed stood. */
  failedAttempt: jsonb('failed_attempt').$type<FailedAttempt>(),
  /**
   * Whether it went (was handed to the sender) at least once. False only for a text held from the start until it
   * first goes; cancelled, or refused when quiet hours ended, it never did. The timeline entry and the
   * conversation's preview follow this, with or without a customer.
   */
  went: boolean('went').notNull().default(true),
  /** M19: its thread's private_to, kept by triggers so the policy reads the row alone. */
  privateTo: uuid('private_to'),
});

export const calls = app.table('calls', {
  id: id(),
  workspaceId: workspaceRef(),
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'set null',
  }),
  phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id, {
    onDelete: 'set null',
  }),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  direction: direction('direction').notNull(),
  fromE164: text('from_e164'),
  toE164: text('to_e164'),
  providerSid: text('provider_sid').unique(),
  status: callStatus('status').notNull().default('initiated'),
  answeredVia: callAnsweredVia('answered_via'),
  answeredByUserId: userRef('answered_by_user_id'),
  answeredNumber: text('answered_number'),
  placedBy: userRef('placed_by'),
  startedAt: ts('started_at').notNull().defaultNow(),
  answeredAt: ts('answered_at'),
  endedAt: ts('ended_at'),
  durationSeconds: integer('duration_seconds'),
  isVoicemail: boolean('is_voicemail').notNull().default(false),
  recordingSid: text('recording_sid'),
  recordingObjectPath: text('recording_object_path'),
  recordingSeconds: integer('recording_seconds'),
  transcript: text('transcript'),
  transcriptStatus: text('transcript_status'),
  activityId: uuid('activity_id').references(() => activities.id, { onDelete: 'set null' }),
  ...timestamps(),
  // Milestone 10
  syncWindow: syncWindow(),
  /**
   * The members who may see this while the business narrows its inbox (0083). Empty means narrowing is off
   * and everyone with the inbox sees everything. Kept by triggers; a value sent by a caller is replaced.
   */
  memberViewerIds: memberViewerIds(),
});

export const optOuts = app.table('opt_outs', {
  id: id(),
  workspaceId: workspaceRef(),
  counterpartE164: text('counterpart_e164').notNull(),
  phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id, {
    onDelete: 'set null',
  }),
  optedOut: boolean('opted_out').notNull().default(true),
  source: optOutSource('source').notNull(),
  lastKeyword: text('last_keyword'),
  optedOutAt: ts('opted_out_at'),
  optedInAt: ts('opted_in_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const webhookDeliveries = app.table('webhook_deliveries', {
  id: id(),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'cascade',
  }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  accountRef: text('account_ref'),
  url: text('url'),
  params: jsonb('params').$type<Json>().notNull().default({}),
  signatureValid: boolean('signature_valid').notNull().default(false),
  status: deliveryStatus('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  lockedAt: ts('locked_at'),
  lockedBy: text('locked_by'),
  lastError: text('last_error'),
  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  /** The add-on it is for (0108): set aside, not processed, while that add-on is off. */
  addonId: text('addon_id'),
  ...timestamps(),
});

export const scheduledJobs = app.table('scheduled_jobs', {
  id: id(),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'cascade',
  }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key'),
  runAt: ts('run_at').notNull(),
  payload: jsonb('payload').$type<Json>().notNull().default({}),
  status: jobStatus('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lockedAt: ts('locked_at'),
  lockedBy: text('locked_by'),
  lastError: text('last_error'),
  finishedAt: ts('finished_at'),
  /**
   * The add-on that queued it and its generation then (0108): cancelled, not run, when the add-on is off or was
   * installed again since.
   */
  addonId: text('addon_id'),
  addonGeneration: integer('addon_generation'),
  ...timestamps(),
});

/** A workspace's own sending domain and the DNS records Postmark wants for it. */
export const emailDomains = app.table('email_domains', {
  id: id(),
  workspaceId: workspaceRef(),
  /** One verified claim per name, and one receiving (M19): partial unique indexes in the migration. */
  domain: text('domain').notNull(),
  providerDomainId: text('provider_domain_id'),
  dkimHost: text('dkim_host'),
  dkimValue: text('dkim_value'),
  returnPathHost: text('return_path_host'),
  returnPathValue: text('return_path_value'),
  status: emailDomainStatus('status').notNull().default('pending'),
  dkimVerifiedAt: ts('dkim_verified_at'),
  returnPathVerifiedAt: ts('return_path_verified_at'),
  lastCheckedAt: ts('last_checked_at'),
  lastError: text('last_error'),
  /** Whether its mail arrives here (M19), and what the worker last saw of its MX. */
  receiving: emailReceivingStatus('receiving').notNull().default('off'),
  mxVerifiedAt: ts('mx_verified_at'),
  mxCheckedAt: ts('mx_checked_at'),
  /** The Postmark server that receives it; null for handsfreeos.com, which the support server receives. */
  inboundServerId: text('inbound_server_id'),
  /** Why Postmark wouldn't receive its mail, the last time it was asked (M19). */
  receivingError: text('receiving_error'),
  /** Published at _hfos-verify.<domain>: which business set the name up, and when the worker found it (M19). */
  ownershipToken: text('ownership_token')
    .notNull()
    .default(sql`encode(extensions.gen_random_bytes(16), 'hex')`),
  ownershipProvedAt: ts('ownership_proved_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** A sending address: on the shared subdomain (no domain) or on a verified workspace domain. */
export const emailAddresses = app.table('email_addresses', {
  id: id(),
  workspaceId: workspaceRef(),
  emailDomainId: uuid('email_domain_id').references(() => emailDomains.id, {
    onDelete: 'cascade',
  }),
  localPart: text('local_part').notNull(),
  address: text('address').notNull().unique(),
  displayName: text('display_name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  verifiedAt: ts('verified_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  /** M19: the person whose own address this is; only they send from it, and its mail is theirs alone. */
  ownerUserId: uuid('owner_user_id'),
});

/** An Outlook or Gmail mailbox; tokens and sign-in secrets are sealed by the worker. */
export const mailboxConnections = app.table('mailbox_connections', {
  id: id(),
  workspaceId: workspaceRef(),
  provider: mailboxProvider('provider').notNull(),
  accountEmail: text('account_email'),
  displayName: text('display_name'),
  userId: userRef('user_id'),
  shared: boolean('shared').notNull().default(false),
  scopes: text('scopes')
    .array()
    .notNull()
    .default(sql`'{}'`),
  status: mailboxStatus('status').notNull().default('pending'),
  oauthStateHash: text('oauth_state_hash').unique(),
  oauthStateExpiresAt: ts('oauth_state_expires_at'),
  pkceVerifierEnc: text('pkce_verifier_enc'),
  tokenEnc: text('token_enc'),
  tokenKeyId: text('token_key_id'),
  tokenExpiresAt: ts('token_expires_at'),
  syncCursor: jsonb('sync_cursor').$type<Json>().notNull().default({}),
  subscriptionId: text('subscription_id').unique(),
  subscriptionExpiresAt: ts('subscription_expires_at'),
  subscriptionClientStateHash: text('subscription_client_state_hash'),
  nextSyncAt: ts('next_sync_at'),
  lastSyncedAt: ts('last_synced_at'),
  lastError: text('last_error'),
  connectedAt: ts('connected_at'),
  disconnectedAt: ts('disconnected_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const emailSuppressions = app.table('email_suppressions', {
  id: id(),
  workspaceId: workspaceRef(),
  address: text('address').notNull(),
  reason: suppressionReason('reason').notNull(),
  origin: text('origin'),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  providerRef: text('provider_ref'),
  releasedAt: ts('released_at'),
  releasedBy: userRef('released_by'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** Mail from someone we don't know, kept whole until it is claimed or dismissed. */
export const emailInboundUnmatched = app.table('email_inbound_unmatched', {
  id: id(),
  workspaceId: workspaceRef(),
  emailAddressId: uuid('email_address_id').references(() => emailAddresses.id, {
    onDelete: 'set null',
  }),
  deliveryId: uuid('delivery_id').references(() => webhookDeliveries.id, {
    onDelete: 'set null',
  }),
  fromAddress: text('from_address').notNull(),
  fromName: text('from_name'),
  toAddresses: text('to_addresses')
    .array()
    .notNull()
    .default(sql`'{}'`),
  ccAddresses: text('cc_addresses')
    .array()
    .notNull()
    .default(sql`'{}'`),
  subject: text('subject'),
  snippet: text('snippet'),
  bodyText: text('body_text'),
  bodyHtml: text('body_html'),
  media: jsonb('media').$type<MediaRef[]>().notNull().default([]),
  messageIdHeader: text('message_id_header'),
  inReplyToHeader: text('in_reply_to_header'),
  referencesHeaders: text('references_headers')
    .array()
    .notNull()
    .default(sql`'{}'`),
  receivedAt: ts('received_at').notNull().defaultNow(),
  resolvedPersonId: uuid('resolved_person_id').references(() => people.id, {
    onDelete: 'set null',
  }),
  resolvedMessageId: uuid('resolved_message_id').references(() => messages.id, {
    onDelete: 'set null',
  }),
  resolvedAt: ts('resolved_at'),
  resolvedBy: userRef('resolved_by'),
  dismissedAt: ts('dismissed_at'),
  dismissedBy: userRef('dismissed_by'),
  ...timestamps(),
});

/** The person a chat belongs to: chats are private, and go when the person does. */
const ownerRef = () =>
  uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

export const assistantThreads = app.table('assistant_threads', {
  id: id(),
  workspaceId: workspaceRef(),
  userId: ownerRef(),
  title: text('title').notNull().default('New chat'),
  lastMessageAt: ts('last_message_at').notNull().defaultNow(),
  archivedAt: ts('archived_at'),
  ...timestamps(),
});

export const assistantRuns = app.table('assistant_runs', {
  id: id(),
  workspaceId: workspaceRef(),
  userId: ownerRef(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => assistantThreads.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  status: assistantRunStatus('status').notNull().default('running'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  toolRounds: integer('tool_rounds').notNull().default(0),
  correlationId: uuid('correlation_id').notNull(),
  error: text('error'),
  startedAt: ts('started_at').notNull().defaultNow(),
  endedAt: ts('ended_at'),
  ...timestamps(),
});

export const assistantMessages = app.table('assistant_messages', {
  id: id(),
  workspaceId: workspaceRef(),
  userId: ownerRef(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => assistantThreads.id, { onDelete: 'cascade' }),
  role: assistantRole('role').notNull(),
  text: text('text').notNull().default(''),
  cards: jsonb('cards').$type<Json[]>().notNull().default([]),
  context: jsonb('context').$type<Json>().notNull().default({}),
  runId: uuid('run_id').references(() => assistantRuns.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const assistantToolCalls = app.table('assistant_tool_calls', {
  id: id(),
  workspaceId: workspaceRef(),
  userId: ownerRef(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => assistantThreads.id, { onDelete: 'cascade' }),
  runId: uuid('run_id')
    .notNull()
    .references(() => assistantRuns.id, { onDelete: 'cascade' }),
  providerCallId: text('provider_call_id'),
  tool: text('tool').notNull(),
  arguments: jsonb('arguments').$type<Json>().notNull().default({}),
  autonomy: assistantAutonomy('autonomy').notNull(),
  status: assistantToolStatus('status').notNull(),
  result: jsonb('result').$type<Json | Json[]>(),
  error: text('error'),
  command: text('command'),
  correlationId: uuid('correlation_id'),
  confirmedAt: ts('confirmed_at'),
  ...timestamps(),
});

// ---------- Milestone 5: the calendar (0015-0017) ----------
export const scheduleOwnerKind = app.enum('schedule_owner_kind', [
  'user',
  'resource',
  'service',
  'calendar',
]);
export const scheduleExceptionKind = app.enum('schedule_exception_kind', [
  'unavailable',
  'available',
]);
export const resourceKind = app.enum('resource_kind', [
  'room',
  'equipment',
  'vehicle',
  'property',
  'chair',
  'other',
]);
export const calendarStatus = app.enum('calendar_status', [
  'draft',
  'active',
  'paused',
  'archived',
]);
export const appointmentKind = app.enum('appointment_kind', ['booking', 'session']);
export const appointmentStatus = app.enum('appointment_status', [
  'scheduled',
  'completed',
  'cancelled',
  'no_show',
]);
export const appointmentSource = app.enum('appointment_source', [
  'staff',
  'assistant',
  'booking_page',
  'series',
  'ai_teammate',
]);
export const appointmentStaffRole = app.enum('appointment_staff_role', ['host', 'crew']);
export const attendeeStatus = app.enum('attendee_status', [
  'booked',
  'cancelled',
  'no_show',
  'attended',
]);
export const waitlistStatus = app.enum('waitlist_status', [
  'waiting',
  'offered',
  'booked',
  'expired',
  'removed',
]);
export const calendarProvider = app.enum('calendar_provider', ['google', 'microsoft']);
export const calendarConnectionStatus = app.enum('calendar_connection_status', [
  'pending',
  'active',
  'reauth_required',
  'error',
  'disconnected',
]);
export type ScheduleOwnerKind = (typeof scheduleOwnerKind.enumValues)[number];
export type ResourceKind = (typeof resourceKind.enumValues)[number];
export type CalendarStatus = (typeof calendarStatus.enumValues)[number];
export type AppointmentStatus = (typeof appointmentStatus.enumValues)[number];
export type AppointmentSource = (typeof appointmentSource.enumValues)[number];
export type AttendeeStatus = (typeof attendeeStatus.enumValues)[number];
export type WaitlistStatus = (typeof waitlistStatus.enumValues)[number];
export type CalendarProvider = (typeof calendarProvider.enumValues)[number];
export type CalendarConnectionStatus = (typeof calendarConnectionStatus.enumValues)[number];

/** A Postgres tstzrange in its text form, e.g. ["2026-10-06 14:00:00+00","2026-10-06 15:00:00+00"). */
export const tstzrange = customType<{ data: string }>({ dataType: () => 'tstzrange' });

/** One weekly window: day 0 = Sunday … 6 = Saturday, wall-clock "HH:MM" in the schedule's zone (end up to "24:00"). */
export interface WeeklyWindow {
  readonly day: number;
  readonly start: string;
  readonly end: string;
}

const calendarLink = () =>
  uuid('calendar_id')
    .notNull()
    .references(() => calendars.id, { onDelete: 'cascade' });
/** Triggers fill these from the appointment; 'empty' lets callers leave them out. */
const emptyRange = (name: string) =>
  tstzrange(name)
    .notNull()
    .default(sql`'empty'::tstzrange`);

export const resources = app.table('resources', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  kind: resourceKind('kind').notNull().default('other'),
  quantity: integer('quantity').notNull().default(1),
  location: text('location'),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const services = app.table('services', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  description: text('description'),
  durations: integer('durations')
    .array()
    .notNull()
    .default(sql`'{60}'`),
  defaultDuration: integer('default_duration').notNull().default(60),
  bufferBefore: integer('buffer_before').notNull().default(0),
  bufferAfter: integer('buffer_after').notNull().default(0),
  color: text('color').notNull().default('#2d69d8'),
  /** Shown on the booking page only; charging arrives with payments (Milestone 9). */
  priceCents: integer('price_cents'),
  /** customer_address, business, virtual, phone. */
  locationKinds: text('location_kinds')
    .array()
    .notNull()
    .default(sql`'{}'`),
  /** Maintenance: due again this many months after a visit; null when it doesn't repeat (0095). */
  repeatMonths: smallint('repeat_months'),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** Who does a service; none listed means everyone. */
export const serviceStaff = app.table(
  'service_staff',
  {
    workspaceId: workspaceRef(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    userId: ownerRef(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.userId] })],
);

export const serviceResources = app.table(
  'service_resources',
  {
    workspaceId: workspaceRef(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resources.id),
    quantity: integer('quantity').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.resourceId] })],
);

export const territories = app.table('territories', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  /** Five-digit ZIP codes. */
  postalCodes: text('postal_codes')
    .array()
    .notNull()
    .default(sql`'{}'`),
  createdBy: userRef('created_by'),
  ...timestamps(),
  // M18: zip, radius (miles from a point) or polygon (corners drawn on the map).
  kind: text('kind').notNull().default('zip'),
  centerAddress: text('center_address'),
  centerLat: doublePrecision('center_lat'),
  centerLng: doublePrecision('center_lng'),
  radiusMiles: numeric('radius_miles', { precision: 6, scale: 2 }),
  /** [[lat, lng], …]. */
  polygon: jsonb('polygon').$type<[number, number][]>(),
});

/** M18: an address the worker looked up once (hashed) and where it is. The worker's only. */
export const geocodes = app.table('geocodes', {
  queryHash: text('query_hash').primaryKey(),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  postalCode: text('postal_code'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const territoryMembers = app.table(
  'territory_members',
  {
    workspaceId: workspaceRef(),
    territoryId: uuid('territory_id')
      .notNull()
      .references(() => territories.id, { onDelete: 'cascade' }),
    userId: ownerRef(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.territoryId, t.userId] })],
);

/** The public home /book/<slug>; the slug is unique across HandsFreeOS whatever the capitals. */
export const bookingSites = app.table('booking_sites', {
  id: id(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  slug: citext('slug').notNull().unique(),
  name: text('name').notNull(),
  intro: text('intro'),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** Milestone 17 (0087): the statuses a business's own domain moves through, the email domain's plus one. */
export const brandedDomainStatus = app.enum('branded_domain_status', [
  'pending',
  /** The records are in DNS and the host is looking; a certificate is not issued yet. */
  'verifying',
  'verified',
  'failed',
]);
export type BrandedDomainStatus = (typeof brandedDomainStatus.enumValues)[number];

/**
 * A business's own domain on the pages its customers see (0087): `go.lonestarhvac.com` rather than
 * `handsfreeos.com` for its forms, payment links, estimates, invoices and booking page. One per booking site,
 * which is already the business's public identity, and made switched off when there is none yet (0107).
 * Everything the host said about it is the worker's — `private.guard_branded_domain_update()`.
 */
export const brandedDomains = app.table('branded_domains', {
  id: id(),
  workspaceId: workspaceRef(),
  siteId: uuid('site_id')
    .notNull()
    .unique()
    .references(() => bookingSites.id, { onDelete: 'cascade' }),
  // Unique only among verified rows: a claim still waiting on DNS squats nothing.
  domain: text('domain').notNull(),
  status: brandedDomainStatus('status').notNull().default('pending'),
  verificationHost: text('verification_host'),
  verificationValue: text('verification_value'),
  cnameHost: text('cname_host'),
  cnameValue: text('cname_value'),
  certificateReady: boolean('certificate_ready').notNull().default(false),
  verifiedAt: ts('verified_at'),
  lastCheckedAt: ts('last_checked_at'),
  lastError: text('last_error'),
  nextCheckAt: ts('next_check_at'),
  /**
   * What the business publishes at `_hfos-verify.<domain>` to prove the name is its own, not just pointed at
   * us. Minted by the database on insert; a row may be verified only once the worker has found it.
   */
  ownershipToken: text('ownership_token')
    .notNull()
    .default(sql`encode(extensions.gen_random_bytes(16), 'hex')`),
  ownershipProvedAt: ts('ownership_proved_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** The permanent identity of a calendar; how it behaves lives in `config` (core's CalendarConfig). */
export const calendars = app.table('calendars', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color').notNull().default('#2d69d8'),
  slug: text('slug').notNull(),
  status: calendarStatus('status').notNull().default('draft'),
  public: boolean('public').notNull().default(false),
  config: jsonb('config').$type<Json>().notNull().default({}),
  configVersion: integer('config_version').notNull().default(1),
  revision: integer('revision').notNull().default(1),
  /** Inferred from the config; descriptive only. */
  labels: text('labels')
    .array()
    .notNull()
    .default(sql`'{}'`),
  ownerUserId: userRef('owner_user_id'),
  /** null: the workspace's zone. */
  timezone: text('timezone'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const calendarRevisions = app.table('calendar_revisions', {
  id: id(),
  workspaceId: workspaceRef(),
  calendarId: calendarLink(),
  revision: integer('revision').notNull(),
  config: jsonb('config').$type<Json>().notNull(),
  configVersion: integer('config_version').notNull(),
  labels: text('labels')
    .array()
    .notNull()
    .default(sql`'{}'`),
  diffSummary: jsonb('diff_summary').$type<Json[]>().notNull().default([]),
  changedBy: userRef('changed_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Slugs a calendar used before (written by trigger when the slug changes). */
export const calendarSlugs = app.table('calendar_slugs', {
  id: id(),
  workspaceId: workspaceRef(),
  calendarId: calendarLink(),
  slug: text('slug').notNull(),
  retiredAt: ts('retired_at').notNull().defaultNow(),
});

export const calendarMembers = app.table(
  'calendar_members',
  {
    workspaceId: workspaceRef(),
    calendarId: calendarLink(),
    userId: ownerRef(),
    weight: integer('weight').notNull().default(1),
    priority: integer('priority').notNull().default(0),
    required: boolean('required').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.calendarId, t.userId] })],
);

export const calendarServices = app.table(
  'calendar_services',
  {
    workspaceId: workspaceRef(),
    calendarId: calendarLink(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id),
    position: integer('position').notNull().default(0),
    overrides: jsonb('overrides').$type<Json>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.calendarId, t.serviceId] })],
);

export const calendarResources = app.table(
  'calendar_resources',
  {
    workspaceId: workspaceRef(),
    calendarId: calendarLink(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resources.id),
    quantity: integer('quantity').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.calendarId, t.resourceId] })],
);

export const calendarAssignmentState = app.table(
  'calendar_assignment_state',
  {
    workspaceId: workspaceRef(),
    calendarId: calendarLink(),
    userId: ownerRef(),
    assignedCount: integer('assigned_count').notNull().default(0),
    lastAssignedAt: ts('last_assigned_at'),
    wrrCredit: integer('wrr_credit').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.calendarId, t.userId] })],
);

/** Weekly hours for a person, resource, service or calendar (one per owner per workspace). */
export const schedules = app.table('schedules', {
  id: id(),
  workspaceId: workspaceRef(),
  ownerKind: scheduleOwnerKind('owner_kind').notNull(),
  ownerId: uuid('owner_id').notNull(),
  /** null: the workspace's zone. */
  timezone: text('timezone'),
  weekly: jsonb('weekly').$type<WeeklyWindow[]>().notNull().default([]),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const scheduleExceptions = app.table('schedule_exceptions', {
  id: id(),
  workspaceId: workspaceRef(),
  scheduleId: uuid('schedule_id')
    .notNull()
    .references(() => schedules.id, { onDelete: 'cascade' }),
  kind: scheduleExceptionKind('kind').notNull().default('unavailable'),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  allDay: boolean('all_day').notNull().default(false),
  note: text('note'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

export const appointmentSeries = app.table('appointment_series', {
  id: id(),
  workspaceId: workspaceRef(),
  calendarId: uuid('calendar_id')
    .notNull()
    .references(() => calendars.id),
  rule: jsonb('rule').$type<Json>().notNull(),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** Bookings, sessions, events and series occurrences alike. */
export const appointments = app.table('appointments', {
  id: id(),
  workspaceId: workspaceRef(),
  calendarId: uuid('calendar_id')
    .notNull()
    .references(() => calendars.id),
  /** The calendar revision whose terms this appointment keeps. */
  calendarRevision: integer('calendar_revision').notNull(),
  serviceId: uuid('service_id').references(() => services.id),
  kind: appointmentKind('kind').notNull().default('booking'),
  title: text('title').notNull(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  /** Minutes, travel included. */
  bufferBefore: integer('buffer_before').notNull().default(0),
  bufferAfter: integer('buffer_after').notNull().default(0),
  capacity: integer('capacity').notNull().default(1),
  seatsTaken: integer('seats_taken').notNull().default(0),
  status: appointmentStatus('status').notNull().default('scheduled'),
  location: jsonb('location').$type<Json>().notNull().default({}),
  seriesId: uuid('series_id').references(() => appointmentSeries.id, { onDelete: 'set null' }),
  occurrence: integer('occurrence'),
  ownerUserId: userRef('owner_user_id'),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  /** 'booking_page' is the worker's alone. */
  source: appointmentSource('source').notNull().default('staff'),
  notes: text('notes'),
  /** Idempotency key, unique per workspace. */
  clientId: text('client_id'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  // Milestone 10
  fieldTimes: fieldTimes(),
  syncWindow: syncWindow(),
  /** When its start last moved, at the moment the change was made (0063, a trigger's). */
  rescheduledAt: ts('rescheduled_at'),
  /** M18: the job this visit is part of (every booked visit starts one). */
  jobId: uuid('job_id').references((): AnyPgColumn => jobs.id, { onDelete: 'set null' }),
  /** The pet, vehicle or property the visit is for (0101). */
  customRecordId: uuid('custom_record_id').references((): AnyPgColumn => customRecords.id, {
    onDelete: 'set null',
  }),
});

/** M18: the work a customer waits on — one visit or several — with a status they hear about. */
export const jobs = app.table('jobs', {
  id: id(),
  workspaceId: workspaceRef(),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  /** scheduled, on_the_way, in_progress, waiting_on_parts, done, cancelled. */
  status: text('status').notNull().default('scheduled'),
  customerNote: text('customer_note'),
  statusChangedAt: ts('status_changed_at'),
  statusChangedBy: userRef('status_changed_by'),
  etaAt: ts('eta_at'),
  open: boolean('open').generatedAlwaysAs(sql`status not in ('done', 'cancelled')`),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** Staff on an appointment; `during`, `blocked` and `active` follow the appointment (trigger). */
export const appointmentStaff = app.table(
  'appointment_staff',
  {
    workspaceId: workspaceRef(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    userId: ownerRef(),
    role: appointmentStaffRole('role').notNull().default('host'),
    during: emptyRange('during'),
    blocked: emptyRange('blocked'),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    // Milestone 10: the appointment's, copied by trigger.
    syncWindow: syncWindow(),
  },
  (t) => [primaryKey({ columns: [t.appointmentId, t.userId] })],
);

export const appointmentResources = app.table(
  'appointment_resources',
  {
    workspaceId: workspaceRef(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resources.id),
    quantity: integer('quantity').notNull().default(1),
    during: emptyRange('during'),
    blocked: emptyRange('blocked'),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.appointmentId, t.resourceId] })],
);

export const appointmentAttendees = app.table('appointment_attendees', {
  id: id(),
  workspaceId: workspaceRef(),
  appointmentId: uuid('appointment_id')
    .notNull()
    .references(() => appointments.id, { onDelete: 'cascade' }),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id),
  status: attendeeStatus('status').notNull().default('booked'),
  seats: integer('seats').notNull().default(1),
  intake: jsonb('intake').$type<Json>().notNull().default({}),
  contactPhoneE164: text('contact_phone_e164'),
  contactEmail: text('contact_email'),
  smsOk: boolean('sms_ok').notNull().default(false),
  /** Part of the signed manage link; raising it retires links already sent. */
  manageVersion: integer('manage_version').notNull().default(1),
  source: appointmentSource('source').notNull().default('staff'),
  /** The worker's: which confirmations and reminders went out. */
  reminderState: jsonb('reminder_state').$type<Json>().notNull().default({}),
  rescheduleCount: integer('reschedule_count').notNull().default(0),
  cancelledAt: ts('cancelled_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  /** 8 random base62 characters, unique and not secret: the start of the change-or-cancel link (/m/...). */
  publicRef: text('public_ref')
    .notNull()
    .default(sql`private.new_public_ref()`),
  // Milestone 8 (0041): cleared when the start changes or a cancelled seat is taken again.
  confirmedAt: ts('confirmed_at'),
  /** sms, link, staff, ai. People may write only a staff mark in their own name (a guard trigger). */
  confirmedVia: text('confirmed_via'),
  /** The person, for a staff mark. */
  confirmedBy: userRef('confirmed_by'),
  /** When HandsFreeOS last asked; the worker's. */
  confirmAskedAt: ts('confirm_asked_at'),
  // Milestone 10: the appointment's, copied by trigger.
  syncWindow: syncWindow(),
});

/** M18: more services on one visit, each with its time and price as they read when added. */
export const appointmentServices = app.table('appointment_services', {
  id: id(),
  workspaceId: workspaceRef(),
  appointmentId: uuid('appointment_id')
    .notNull()
    .references(() => appointments.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id')
    .notNull()
    .references(() => services.id),
  name: text('name').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  priceCents: integer('price_cents'),
  /** staff, ai_teammate. */
  source: text('source').notNull().default('staff'),
  createdBy: userRef('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const waitlistEntries = app.table('waitlist_entries', {
  id: id(),
  workspaceId: workspaceRef(),
  calendarId: uuid('calendar_id')
    .notNull()
    .references(() => calendars.id),
  /** A full session, or null with a wanted window for a 1:1 opening. */
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'cascade' }),
  wantedFrom: ts('wanted_from'),
  wantedTo: ts('wanted_to'),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id),
  seats: integer('seats').notNull().default(1),
  status: waitlistStatus('status').notNull().default('waiting'),
  offerExpiresAt: ts('offer_expires_at'),
  position: integer('position').notNull().default(0),
  contactPhoneE164: text('contact_phone_e164'),
  contactEmail: text('contact_email'),
  smsOk: boolean('sms_ok').notNull().default(false),
  source: appointmentSource('source').notNull().default('staff'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  /** 8 random base62 characters, unique and not secret: the start of a waitlist offer link (/w/...). */
  publicRef: text('public_ref')
    .notNull()
    .default(sql`private.new_public_ref()`),
  /** What the worker offered: the freed time, its length, service and kind of place (0019). */
  offer: jsonb('offer').$type<Json>(),
});

/** Write-through state for an appointment in one person's own calendar (the worker's). */
export const appointmentCalendarEvents = app.table('appointment_calendar_events', {
  id: id(),
  workspaceId: workspaceRef(),
  appointmentId: uuid('appointment_id')
    .notNull()
    .references(() => appointments.id, { onDelete: 'cascade' }),
  userId: ownerRef(),
  connectionId: uuid('connection_id').references(() => calendarConnections.id, {
    onDelete: 'set null',
  }),
  providerEventId: text('provider_event_id'),
  syncedAt: ts('synced_at'),
  error: text('error'),
  ...timestamps(),
});

/** A person's Google or Outlook calendar; tokens are sealed by the worker and never readable by people. */
export const calendarConnections = app.table('calendar_connections', {
  id: id(),
  workspaceId: workspaceRef(),
  userId: ownerRef(),
  provider: calendarProvider('provider').notNull(),
  status: calendarConnectionStatus('status').notNull().default('pending'),
  accountEmail: text('account_email'),
  scopes: text('scopes')
    .array()
    .notNull()
    .default(sql`'{}'`),
  oauthStateHash: text('oauth_state_hash').unique(),
  oauthStateExpiresAt: ts('oauth_state_expires_at'),
  pkceVerifierEnc: text('pkce_verifier_enc'),
  tokenEnc: text('token_enc'),
  tokenKeyId: text('token_key_id'),
  tokenExpiresAt: ts('token_expires_at'),
  busySyncedAt: ts('busy_synced_at'),
  nextSyncAt: ts('next_sync_at'),
  failures: integer('failures').notNull().default(0),
  lastError: text('last_error'),
  connectedAt: ts('connected_at'),
  disconnectedAt: ts('disconnected_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** Busy times read from a person's calendar: times only, never titles. */
export const calendarBusyBlocks = app.table('calendar_busy_blocks', {
  id: id(),
  workspaceId: workspaceRef(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => calendarConnections.id, { onDelete: 'cascade' }),
  userId: ownerRef(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ---------- Milestone 6: workflows, agency templates, AI usage and the knowledge base (0021-0025) ----------
export const workflowStatus = app.enum('workflow_status', [
  'draft',
  'active',
  'paused',
  'archived',
]);
export const workflowTriggerKind = app.enum('workflow_trigger_kind', [
  'event',
  'schedule',
  'date',
  'webhook',
  'manual',
]);
export const workflowReentry = app.enum('workflow_reentry', ['once', 'after_exit', 'always']);
/** running, waiting, awaiting_approval and held are "active" (the re-entry and dispatcher indexes). */
export const workflowRunStatus = app.enum('workflow_run_status', [
  'running',
  'waiting',
  'awaiting_approval',
  'held',
  'completed',
  'stopped',
  'failed',
]);
export const workflowTestMode = app.enum('workflow_test_mode', ['simulate', 'send_to_me']);
export const workflowStepStatus = app.enum('workflow_step_status', [
  'running',
  'done',
  'skipped',
  'waiting',
  'failed',
  'dead',
]);
export const workflowApprovalStatus = app.enum('workflow_approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
]);
export const templateInstallStatus = app.enum('template_install_status', [
  'pending',
  'installed',
  'failed',
]);
export const aiUsageSource = app.enum('ai_usage_source', [
  'workflow',
  'builder',
  'knowledge',
  'teammate',
  'automations',
]);
export const knowledgeItemKind = app.enum('knowledge_item_kind', [
  'faq',
  'article',
  'fact',
  'document',
]);
export const knowledgeItemStatus = app.enum('knowledge_item_status', [
  'draft',
  'published',
  'archived',
]);
export const knowledgeItemSource = app.enum('knowledge_item_source', [
  'manual',
  'website_scan',
  'ai_suggestion',
  'agency_pack',
]);
export const knowledgeScanStatus = app.enum('knowledge_scan_status', [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
]);
export const knowledgeSuggestionReason = app.enum('knowledge_suggestion_reason', [
  'scan',
  'gap',
  'pack',
]);
export const knowledgeSuggestionStatus = app.enum('knowledge_suggestion_status', [
  'pending',
  'accepted',
  'rejected',
]);
export type WorkflowStatus = (typeof workflowStatus.enumValues)[number];
export type WorkflowTriggerKind = (typeof workflowTriggerKind.enumValues)[number];
export type WorkflowReentry = (typeof workflowReentry.enumValues)[number];
export type WorkflowRunStatus = (typeof workflowRunStatus.enumValues)[number];
export type WorkflowTestMode = (typeof workflowTestMode.enumValues)[number];
export type WorkflowStepStatus = (typeof workflowStepStatus.enumValues)[number];
export type WorkflowApprovalStatus = (typeof workflowApprovalStatus.enumValues)[number];
export type TemplateInstallStatus = (typeof templateInstallStatus.enumValues)[number];
export type AiUsageSource = (typeof aiUsageSource.enumValues)[number];
export type KnowledgeItemKind = (typeof knowledgeItemKind.enumValues)[number];
export type KnowledgeItemStatus = (typeof knowledgeItemStatus.enumValues)[number];
export type KnowledgeItemSource = (typeof knowledgeItemSource.enumValues)[number];
export type KnowledgeScanStatus = (typeof knowledgeScanStatus.enumValues)[number];
export type KnowledgeSuggestionReason = (typeof knowledgeSuggestionReason.enumValues)[number];
export type KnowledgeSuggestionStatus = (typeof knowledgeSuggestionStatus.enumValues)[number];

/** A Postgres tsvector. The knowledge search document is generated by the database, never written. */
export const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const workflowLink = () =>
  uuid('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' });
const organizationRef = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });
const uuidArray = (name: string) =>
  uuid(name)
    .array()
    .notNull()
    .default(sql`'{}'`);
const textArray = (name: string) =>
  text(name)
    .array()
    .notNull()
    .default(sql`'{}'`);

/** A workflow: its one draft (core's WorkflowDefinition) that all three editors change. */
export const workflows = app.table('workflows', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  description: text('description'),
  status: workflowStatus('status').notNull().default('draft'),
  definition: jsonb('definition').$type<Json>().notNull().default({}),
  definitionVersion: integer('definition_version').notNull().default(1),
  revision: integer('revision').notNull().default(1),
  /** The draft revision the last passing test ran; publishing needs it to equal `revision`. Worker-only. */
  testedRevision: integer('tested_revision'),
  activeVersionId: uuid('active_version_id').references((): AnyPgColumn => workflowVersions.id),
  /** The dispatcher's index: the published version's trigger once there is one, the draft's before. */
  triggerKind: workflowTriggerKind('trigger_kind').notNull().default('manual'),
  triggerEvent: text('trigger_event'),
  calendarIds: uuidArray('calendar_ids'),
  allCalendars: boolean('all_calendars').notNull().default(false),
  reentry: workflowReentry('reentry').notNull().default('after_exit'),
  /** Reserved; M6 never stores canvas positions. */
  layout: jsonb('layout').$type<Json>().notNull().default({}),
  templateId: uuid('template_id').references(() => workflowTemplates.id, { onDelete: 'set null' }),
  templateVersion: integer('template_version'),
  installedRevision: integer('installed_revision'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** What a publish froze. Append-only: a trigger refuses updates and deletes. */
export const workflowVersions = app.table('workflow_versions', {
  id: id(),
  workspaceId: workspaceRef(),
  workflowId: workflowLink(),
  version: integer('version').notNull(),
  definition: jsonb('definition').$type<Json>().notNull(),
  definitionVersion: integer('definition_version').notNull(),
  revision: integer('revision').notNull(),
  /** No foreign key: runs are pruned, versions never change. */
  testRunId: uuid('test_run_id'),
  /** editor, assistant, template. */
  source: text('source').notNull().default('editor'),
  diffSummary: jsonb('diff_summary').$type<Json[]>().notNull().default([]),
  publishedBy: userRef('published_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** One customer (or none) going through one version; a test runs a snapshot of the draft instead. */
export const workflowRuns = app.table('workflow_runs', {
  id: id(),
  workspaceId: workspaceRef(),
  workflowId: workflowLink(),
  versionId: uuid('version_id').references(() => workflowVersions.id),
  testRevision: integer('test_revision'),
  testDefinition: jsonb('test_definition').$type<Json>(),
  status: workflowRunStatus('status').notNull().default('running'),
  isTest: boolean('is_test').notNull().default(false),
  testMode: workflowTestMode('test_mode'),
  startedBy: userRef('started_by'),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'set null',
  }),
  triggerEventId: uuid('trigger_event_id').references(() => events.id),
  /** Unique per workflow: one run per trigger. */
  dedupeKey: text('dedupe_key').notNull(),
  /** "Again after they finish": unique among a workflow's active, non-test runs. */
  enrolKey: text('enrol_key'),
  /** "Once ever": unique per workflow forever; always null for tests. */
  onceKey: text('once_key'),
  context: jsonb('context').$type<Json>().notNull().default({}),
  /** The step id the run is on; its step key is `${cursor}#${visits[cursor]}`. */
  cursor: text('cursor'),
  visits: jsonb('visits').$type<Record<string, number>>().notNull().default({}),
  stepCount: integer('step_count').notNull().default(0),
  waitingFor: text('waiting_for')
    .array()
    .notNull()
    .default(sql`'{}'`),
  stopOn: text('stop_on')
    .array()
    .notNull()
    .default(sql`'{}'`),
  originRunId: uuid('origin_run_id').references((): AnyPgColumn => workflowRuns.id, {
    onDelete: 'set null',
  }),
  /** 0-3. */
  depth: integer('depth').notNull().default(0),
  endReason: text('end_reason'),
  startedAt: ts('started_at').notNull().defaultNow(),
  /** Set exactly when the status is completed, stopped or failed. */
  endedAt: ts('ended_at'),
  ...timestamps(),
});

/** The durable step log: each step of each run once, under (run_id, step_key "stepId#visit"). */
export const workflowRunSteps = app.table('workflow_run_steps', {
  id: id(),
  workspaceId: workspaceRef(),
  runId: uuid('run_id')
    .notNull()
    .references(() => workflowRuns.id, { onDelete: 'cascade' }),
  stepKey: text('step_key').notNull(),
  status: workflowStepStatus('status').notNull().default('running'),
  attempt: integer('attempt').notNull().default(1),
  input: jsonb('input').$type<Json>(),
  output: jsonb('output').$type<Json>(),
  error: jsonb('error').$type<Json>(),
  eventIds: uuidArray('event_ids'),
  nextStepKey: text('next_step_key'),
  tokens: integer('tokens').notNull().default(0),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
  ...timestamps(),
});

/** A run waiting for a person's OK; decided once. */
export const workflowApprovals = app.table('workflow_approvals', {
  id: id(),
  workspaceId: workspaceRef(),
  workflowId: workflowLink(),
  runId: uuid('run_id')
    .notNull()
    .references(() => workflowRuns.id, { onDelete: 'cascade' }),
  stepKey: text('step_key').notNull(),
  status: workflowApprovalStatus('status').notNull().default('pending'),
  /** Named approvers; none named means the owners and admins. */
  approvers: uuidArray('approvers'),
  preview: jsonb('preview').$type<Json>().notNull().default({}),
  edits: jsonb('edits').$type<Json>(),
  reason: text('reason'),
  decidedBy: userRef('decided_by'),
  decidedAt: ts('decided_at'),
  /** web, email, assistant, system. */
  via: text('via'),
  expiresAt: ts('expires_at'),
  ...timestamps(),
});

/** Where a scheduled workflow's next occurrence stands (the worker's). */
export const workflowSchedules = app.table('workflow_schedules', {
  id: id(),
  workspaceId: workspaceRef(),
  workflowId: uuid('workflow_id')
    .notNull()
    .unique()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => workflowVersions.id),
  nextRunAt: ts('next_run_at'),
  lastRunAt: ts('last_run_at'),
  lastOccurrenceAt: ts('last_occurrence_at'),
  pageCursor: text('page_cursor'),
  ...timestamps(),
});

/** An inbound webhook URL; the HMAC secret is sealed by the worker and never readable by people. */
export const workflowWebhooks = app.table('workflow_webhooks', {
  id: id(),
  workspaceId: workspaceRef(),
  workflowId: uuid('workflow_id')
    .notNull()
    .unique()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  secretEnc: text('secret_enc').notNull(),
  keyId: text('key_id').notNull(),
  lastReceivedAt: ts('last_received_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** The AI builder's patch ops, stored until someone applies them to the draft. */
export const workflowProposals = app.table('workflow_proposals', {
  id: id(),
  workspaceId: workspaceRef(),
  /** null: a proposal for a new workflow. */
  workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'cascade' }),
  baseRevision: integer('base_revision'),
  prompt: text('prompt').notNull(),
  ops: jsonb('ops').$type<Json[]>().notNull().default([]),
  summary: text('summary'),
  unsupported: jsonb('unsupported').$type<string[]>().notNull().default([]),
  appliedAt: ts('applied_at'),
  createdBy: userRef('created_by'),
  expiresAt: ts('expires_at')
    .notNull()
    .default(sql`now() + interval '7 days'`),
  ...timestamps(),
});

/** An agency's workflow template: a draft with {"$ph": "key"} placeholders (organization level). */
export const workflowTemplates = app.table('workflow_templates', {
  id: id(),
  organizationId: organizationRef(),
  name: text('name').notNull(),
  description: text('description'),
  definition: jsonb('definition').$type<Json>().notNull().default({}),
  definitionVersion: integer('definition_version').notNull().default(1),
  revision: integer('revision').notNull().default(1),
  latestVersion: integer('latest_version'),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** A published template version. Append-only. */
export const workflowTemplateVersions = app.table('workflow_template_versions', {
  id: id(),
  organizationId: organizationRef(),
  templateId: uuid('template_id')
    .notNull()
    .references(() => workflowTemplates.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  definition: jsonb('definition').$type<Json>().notNull(),
  definitionVersion: integer('definition_version').notNull(),
  diffSummary: jsonb('diff_summary').$type<Json[]>().notNull().default([]),
  publishedBy: userRef('published_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** One template pushed to one business, with its placeholder mapping. */
export const workflowTemplateInstalls = app.table('workflow_template_installs', {
  id: id(),
  organizationId: organizationRef(),
  templateId: uuid('template_id')
    .notNull()
    .references(() => workflowTemplates.id, { onDelete: 'cascade' }),
  workspaceId: workspaceRef(),
  workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
  installedVersion: integer('installed_version'),
  mapping: jsonb('mapping').$type<Json>().notNull().default({}),
  status: templateInstallStatus('status').notNull().default('pending'),
  lastError: text('last_error'),
  pushedBy: userRef('pushed_by'),
  pushedAt: ts('pushed_at'),
  installedAt: ts('installed_at'),
  ...timestamps(),
});

/** AI tokens spent outside the Assistant, counted in the same daily limit. */
export const aiUsage = app.table('ai_usage', {
  id: id(),
  workspaceId: workspaceRef(),
  source: aiUsageSource('source').notNull(),
  userId: userRef('user_id'),
  workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
  runId: uuid('run_id').references(() => workflowRuns.id, { onDelete: 'set null' }),
  stepKey: text('step_key'),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
  // Milestone 7: the teammate (for its share of the daily limit) and the run it paid for.
  teammateId: uuid('teammate_id').references((): AnyPgColumn => aiTeammates.id, {
    onDelete: 'set null',
  }),
  teammateRunId: uuid('teammate_run_id').references((): AnyPgColumn => aiTeammateRuns.id, {
    onDelete: 'set null',
  }),
});

/** A business's profile for the AI (core's KnowledgeProfile), one per workspace. */
export const knowledgeProfiles = app.table('knowledge_profiles', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  profile: jsonb('profile').$type<Json>().notNull().default({}),
  allowPrices: boolean('allow_prices').notNull().default(false),
  updatedBy: userRef('updated_by'),
  ...timestamps(),
});

/** An FAQ (title = question, body = answer), article, fact or document. */
export const knowledgeItems = app.table('knowledge_items', {
  id: id(),
  workspaceId: workspaceRef(),
  kind: knowledgeItemKind('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  tags: text('tags')
    .array()
    .notNull()
    .default(sql`'{}'`),
  status: knowledgeItemStatus('status').notNull().default('draft'),
  source: knowledgeItemSource('source').notNull().default('manual'),
  sourceUrl: text('source_url'),
  fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
  useCount: integer('use_count').notNull().default(0),
  lastUsedAt: ts('last_used_at'),
  createdBy: userRef('created_by'),
  updatedBy: userRef('updated_by'),
  ...timestamps(),
  /** Weighted English search document: title A, tags B, body C. */
  search: tsvector('search').generatedAlwaysAs(
    sql`private.knowledge_search_vector(title, tags, body)`,
  ),
});

/** What the business is running right now (M18): the AI teammate shares the ones live today. */
export const offers = app.table('offers', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  details: text('details').notNull().default(''),
  /** Local dates in the business's zone, both inclusive; null is open-ended. */
  startsOn: date('starts_on'),
  endsOn: date('ends_on'),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/**
 * Fixed words HandsFreeOS sends (a hand-off line, the emergency safety steps) in another language (M18), once
 * per English text and language. The worker's only.
 */
export const fixedTextTranslations = app.table(
  'fixed_text_translations',
  {
    sourceHash: text('source_hash').notNull(),
    language: text('language').notNull(),
    translated: text('translated').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sourceHash, t.language] })],
);

/** The business's website (one per workspace for now). */
export const knowledgeSources = app.table('knowledge_sources', {
  id: id(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  settings: jsonb('settings').$type<Json>().notNull().default({}),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** One scan of the website; one queued or running at a time per source. */
export const knowledgeScans = app.table('knowledge_scans', {
  id: id(),
  workspaceId: workspaceRef(),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
  status: knowledgeScanStatus('status').notNull().default('queued'),
  pages: jsonb('pages').$type<Json[]>().notNull().default([]),
  suggestionCount: integer('suggestion_count').notNull().default(0),
  errors: jsonb('errors').$type<Json[]>().notNull().default([]),
  startedBy: userRef('started_by'),
  /** Automations 4b: the worker's weekly re-read, not a person's Scan. */
  automatic: boolean('automatic').notNull().default(false),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  ...timestamps(),
});

/** A proposed item (from a scan, a gap or a pack) waiting for a person to accept or reject it. */
export const knowledgeSuggestions = app.table('knowledge_suggestions', {
  id: id(),
  workspaceId: workspaceRef(),
  kind: knowledgeItemKind('kind').notNull(),
  proposed: jsonb('proposed').$type<Json>().notNull(),
  reason: knowledgeSuggestionReason('reason').notNull(),
  status: knowledgeSuggestionStatus('status').notNull().default('pending'),
  scanId: uuid('scan_id').references(() => knowledgeScans.id, { onDelete: 'set null' }),
  source: jsonb('source').$type<Json>().notNull().default({}),
  itemId: uuid('item_id').references(() => knowledgeItems.id, { onDelete: 'set null' }),
  /** Unique among a workspace's pending suggestions: similar gaps raise similar_count instead. */
  groupKey: text('group_key'),
  similarCount: integer('similar_count').notNull().default(1),
  decidedBy: userRef('decided_by'),
  decidedAt: ts('decided_at'),
  ...timestamps(),
});

/** An agency's starter pack (organization level), pushed to businesses as suggestions. */
export const knowledgePacks = app.table('knowledge_packs', {
  id: id(),
  organizationId: organizationRef(),
  name: text('name').notNull(),
  description: text('description'),
  items: jsonb('items').$type<Json[]>().notNull().default([]),
  version: integer('version').notNull().default(1),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

// ---------- Milestone 7: the AI teammate and website chat (0030-0034) ----------
export const aiTeammateStatus = app.enum('ai_teammate_status', ['off', 'training', 'automatic']);
export type AiTeammateStatus = (typeof aiTeammateStatus.enumValues)[number];

/**
 * A business's AI teammate: a row, never a user account. `config` is core's TeammateConfig. The counts,
 * training_started_at, automatic_since and automatic_via follow from status changes (a guard trigger) and
 * private.record_teammate_decision; people never write them.
 */
export const aiTeammates = app.table('ai_teammates', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  status: aiTeammateStatus('status').notNull().default('off'),
  config: jsonb('config').$type<Json>().notNull().default({}),
  configVersion: integer('config_version').notNull().default(1),
  revision: integer('revision').notNull().default(1),
  /** Inferred from the config; descriptive only. */
  labels: text('labels')
    .array()
    .notNull()
    .default(sql`'{}'`),
  approvedCount: integer('approved_count').notNull().default(0),
  editedCount: integer('edited_count').notNull().default(0),
  rejectedCount: integer('rejected_count').notNull().default(0),
  trainingStartedAt: ts('training_started_at'),
  automaticSince: ts('automatic_since'),
  /** threshold, override. */
  automaticVia: text('automatic_via'),
  /** Reserved; one live teammate per workspace. */
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** Every save of a teammate's settings. Append-only. */
export const aiTeammateRevisions = app.table('ai_teammate_revisions', {
  id: id(),
  workspaceId: workspaceRef(),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => aiTeammates.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  config: jsonb('config').$type<Json>().notNull(),
  configVersion: integer('config_version').notNull(),
  labels: text('labels')
    .array()
    .notNull()
    .default(sql`'{}'`),
  diffSummary: jsonb('diff_summary').$type<Json[]>().notNull().default([]),
  changedBy: userRef('changed_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** One answer (or one try) in one conversation: the blueprint's "AI Run". One running per conversation. */
export const aiTeammateRuns = app.table('ai_teammate_runs', {
  id: id(),
  workspaceId: workspaceRef(),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => aiTeammates.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'set null',
  }),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  /** The event or job that started it: message.received, lead.created, follow_up, test … */
  triggeredBy: text('triggered_by').notNull(),
  /** running, done, superseded, failed. */
  status: text('status').notNull().default('running'),
  /** replied, drafted, handed_off, no_reply. */
  outcome: text('outcome'),
  isTest: boolean('is_test').notNull().default(false),
  aiEpoch: integer('ai_epoch'),
  /** The customer messages it answered. */
  messageIds: uuidArray('message_ids'),
  replyText: text('reply_text'),
  summary: text('summary'),
  knowledge: jsonb('knowledge').$type<Json[]>().notNull().default([]),
  checks: jsonb('checks').$type<Json[]>().notNull().default([]),
  model: text('model'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  toolSteps: integer('tool_steps').notNull().default(0),
  error: text('error'),
  /** The phone call it answered live (M18 step 5). */
  callId: uuid('call_id').references(() => calls.id, { onDelete: 'set null' }),
  startedAt: ts('started_at').notNull().defaultNow(),
  endedAt: ts('ended_at'),
  ...timestamps(),
});

/** Each tool a run used, once per (run_id, provider_call_id). */
export const aiTeammateToolCalls = app.table('ai_teammate_tool_calls', {
  id: id(),
  workspaceId: workspaceRef(),
  runId: uuid('run_id')
    .notNull()
    .references(() => aiTeammateRuns.id, { onDelete: 'cascade' }),
  providerCallId: text('provider_call_id').notNull(),
  tool: text('tool').notNull(),
  arguments: jsonb('arguments').$type<Json>().notNull().default({}),
  /** running, done, held, simulated, refused, failed. */
  status: text('status').notNull().default('running'),
  result: jsonb('result').$type<Json | Json[]>(),
  error: text('error'),
  command: text('command'),
  ...timestamps(),
});

/** What waits for a person's OK: a reply (training wheels) or an approval (a discount). Decided once. */
export const aiTeammateDrafts = app.table('ai_teammate_drafts', {
  id: id(),
  workspaceId: workspaceRef(),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => aiTeammates.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').references(() => aiTeammateRuns.id, { onDelete: 'set null' }),
  /** null: a first message to a new lead, which starts the conversation once approved. */
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'cascade',
  }),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  /** reply, approval, call. */
  kind: text('kind').notNull(),
  status: workflowApprovalStatus('status').notNull().default('pending'),
  preview: jsonb('preview').$type<Json>().notNull().default({}),
  edits: jsonb('edits').$type<Json>(),
  reason: text('reason'),
  decidedBy: userRef('decided_by'),
  decidedAt: ts('decided_at'),
  /** web, email, assistant, system. */
  via: text('via'),
  expiresAt: ts('expires_at'),
  /** Fixed when the draft is made: the approved message's clientId. */
  clientId: text('client_id').notNull(),
  /** When its held actions and message went out (the worker's), so it goes out once. */
  sentAt: ts('sent_at'),
  /** Its thread's member_viewer_ids (20261012020100), kept by trigger. */
  memberViewerIds: memberViewerIds(),
  ...timestamps(),
});

/** A website chat widget: the snippet's public key and the sites it may show on. */
export const chatWidgets = app.table('chat_widgets', {
  id: id(),
  workspaceId: workspaceRef(),
  /** wk_ + 20 base62 characters, made by private.new_chat_widget_key(). */
  publicKey: text('public_key')
    .notNull()
    .unique()
    .default(sql`private.new_chat_widget_key()`),
  /** 1-10 exact https origins (or loopback http origins for local testing). */
  allowedOrigins: text('allowed_origins').array().notNull(),
  teammateId: uuid('teammate_id').references(() => aiTeammates.id, { onDelete: 'set null' }),
  greeting: text('greeting'),
  launcherLabel: text('launcher_label').notNull().default('Chat with us'),
  accentColor: text('accent_color').notNull().default('#2d69d8'),
  /** right, left. */
  position: text('position').notNull().default('right'),
  awayMessage: text('away_message'),
  askFor: jsonb('ask_for').$type<Json>().notNull().default({}),
  smsConsent: boolean('sms_consent').notNull().default(true),
  dailyCap: integer('daily_cap').notNull().default(200),
  pausedAt: ts('paused_at'),
  /** The install check; the worker's. */
  lastSeenOrigin: text('last_seen_origin'),
  lastSeenAt: ts('last_seen_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** One browser on one widget. People never read the token hashes or ip_hmac. */
export const chatVisitors = app.table('chat_visitors', {
  id: id(),
  workspaceId: workspaceRef(),
  widgetId: uuid('widget_id')
    .notNull()
    .references(() => chatWidgets.id, { onDelete: 'cascade' }),
  tokenHash: bytea('token_hash').notNull().unique(),
  tokenIssuedAt: ts('token_issued_at').notNull().defaultNow(),
  prevTokenHash: bytea('prev_token_hash'),
  prevTokenExpiresAt: ts('prev_token_expires_at'),
  /** Its one conversation: counterpart chat:<visitor id>. */
  conversationId: uuid('conversation_id')
    .unique()
    .references(() => conversations.id, { onDelete: 'set null' }),
  name: text('name'),
  phoneE164: text('phone_e164'),
  email: text('email'),
  /** A matching customer, linked and never edited. */
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  ipHmac: bytea('ip_hmac'),
  lastPagePath: text('last_page_path'),
  lastSeenAt: ts('last_seen_at'),
  turnstilePassedAt: ts('turnstile_passed_at'),
  blockedAt: ts('blocked_at'),
  networkBlockedUntil: ts('network_blocked_until'),
  ...timestamps(),
  // Milestone 18: typed back the code sent to this customer's phone or email; twelve hours from verifiedAt.
  verifiedPersonId: uuid('verified_person_id').references(() => people.id, {
    onDelete: 'set null',
  }),
  verifiedAt: ts('verified_at'),
});

/** A code sent to prove a chat visitor is the customer the chat matched (M18); only its hash is kept. */
export const chatVerificationCodes = app.table('chat_verification_codes', {
  id: id(),
  workspaceId: workspaceRef(),
  visitorId: uuid('visitor_id')
    .notNull()
    .references(() => chatVisitors.id, { onDelete: 'cascade' }),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  codeHash: bytea('code_hash').notNull(),
  channel: text('channel').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** "Typing", for a few seconds; the worker's alone. */
export const chatSignals = app.table(
  'chat_signals',
  {
    workspaceId: workspaceRef(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** typing. */
    kind: text('kind').notNull().default('typing'),
    signaledAt: ts('signaled_at').notNull().defaultNow(),
    expiresAt: ts('expires_at')
      .notNull()
      .default(sql`now() + interval '8 seconds'`),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.kind] })],
);

// ---------- Milestone 8: the Action Center (0039-0043) ----------
export const attentionState = app.enum('attention_state', [
  'open',
  'snoozed',
  'dismissed',
  'handled',
  'resolved',
]);
export type AttentionState = (typeof attentionState.enumValues)[number];

/**
 * One thing that needs attention: one row per (workspace, kind, subject type, subject id), kept by the worker.
 * `kind` is check-constrained to core's ATTENTION_KINDS (a parity test). People change only the state, snooze,
 * dismissal, assignee and handling, and cancel a scheduled automatic action (a guard trigger, 0039).
 */
export const attentionItems = app.table('attention_items', {
  id: id(),
  workspaceId: workspaceRef(),
  kind: text('kind').notNull(),
  /** lead, attendee, approval, conversation, task (core's ATTENTION_SUBJECT_OF). No foreign key. */
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'set null',
  }),
  state: attentionState('state').notNull().default('open'),
  openedAt: ts('opened_at').notNull().defaultNow(),
  /** When the wait behind it began; urgency is worked out from it when the list is read. */
  sinceAt: ts('since_at'),
  urgentFrom: ts('urgent_from'),
  dueAt: ts('due_at'),
  valueCents: bigint('value_cents', { mode: 'number' }),
  /** The typical job value stood in: left out of "$ affected". */
  valueIsEstimate: boolean('value_is_estimate').notNull().default(false),
  /** Counts one lead's value once across items. */
  moneyKey: text('money_key'),
  probability: real('probability').notNull().default(1),
  confidence: real('confidence').notNull().default(1),
  /** The chips that explain the rank. */
  reasons: jsonb('reasons').$type<Json[]>().notNull().default([]),
  title: text('title').notNull(),
  detail: text('detail'),
  /** A digest of the facts behind it: a change brings a dismissed or snoozed item back. */
  fingerprint: text('fingerprint').notNull(),
  assigneeUserId: userRef('assignee_user_id'),
  snoozedUntil: ts('snoozed_until'),
  snoozedAt: ts('snoozed_at'),
  snoozedBy: userRef('snoozed_by'),
  dismissedAt: ts('dismissed_at'),
  dismissedBy: userRef('dismissed_by'),
  dismissReason: text('dismiss_reason'),
  handledAt: ts('handled_at'),
  handledBy: userRef('handled_by'),
  /** person, let_handle (people), auto (HandsFreeOS alone). */
  handledVia: text('handled_via'),
  /** The worker's: a handled item comes back then if its facts still hold. */
  handledUntil: ts('handled_until'),
  /** scheduled, sent, skipped, cancelled. People may only cancel a scheduled one. */
  autoState: text('auto_state'),
  autoScheduledFor: ts('auto_scheduled_for'),
  autoDoneAt: ts('auto_done_at'),
  autoSkipReason: text('auto_skip_reason'),
  autoCancelledBy: userRef('auto_cancelled_by'),
  /** The facts the last urgent email went out for. */
  alertFingerprint: text('alert_fingerprint'),
  alertedAt: ts('alerted_at'),
  resolvedAt: ts('resolved_at'),
  resolution: text('resolution'),
  ...timestamps(),
  /**
   * The members who may see this while the business narrows its inbox (0083). Empty means narrowing is off
   * and everyone with the inbox sees everything. Kept by triggers; a value sent by a caller is replaced.
   */
  memberViewerIds: memberViewerIds(),
});

// ---------- Milestone 9: money (0044-0050) ----------
export const productKind = app.enum('product_kind', ['product', 'service', 'fee']);
export const planInterval = app.enum('plan_interval', ['month', 'quarter', 'year']);
export const estimateStatus = app.enum('estimate_status', [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'void',
]);
export const invoiceStatus = app.enum('invoice_status', [
  'draft',
  'sent',
  'partly_paid',
  'paid',
  'overdue',
  'void',
]);
export const invoicePurpose = app.enum('invoice_purpose', [
  'standard',
  'deposit',
  'balance',
  'setup_fee',
  'subscription',
  'quick',
]);
export const moneyOrigin = app.enum('money_origin', [
  'staff',
  'estimate',
  'booking',
  'subscription',
  'workflow',
  'assistant',
  // Milestone 15: a form asked for it.
  'form',
  // Milestone 18: the AI teammate put it together, and an owner or admin approved it.
  'ai_teammate',
]);
export const paymentProvider = app.enum('payment_provider', [
  'stripe',
  'square',
  'paypal',
  'nmi',
  'authorize_net',
]);
export const paymentEnvironment = app.enum('payment_environment', ['live', 'test']);
export const paymentConnectionStatus = app.enum('payment_connection_status', [
  'pending',
  'active',
  'reauth_required',
  'error',
  'disconnected',
]);
/** Who may bill into an account (0105): everyone who bills, the people it names, or only them and only there. */
export const paymentAccountUse = app.enum('payment_account_use', [
  'everyone',
  'chosen',
  'only_theirs',
]);
export const paymentMethod = app.enum('payment_method', ['card', 'ach', 'cash', 'check', 'other']);
export const paymentStatus = app.enum('payment_status', [
  'requires_payment',
  'processing',
  'succeeded',
  'failed',
]);
export const refundStatus = app.enum('refund_status', ['pending', 'succeeded', 'failed']);
export const subscriptionStatus = app.enum('subscription_status', [
  'draft',
  'active',
  'past_due',
  'paused',
  'cancelled',
  'unmanaged',
]);

export type ProductKind = (typeof productKind.enumValues)[number];
export type PlanInterval = (typeof planInterval.enumValues)[number];
export type EstimateStatus = (typeof estimateStatus.enumValues)[number];
export type InvoiceStatus = (typeof invoiceStatus.enumValues)[number];
export type InvoicePurpose = (typeof invoicePurpose.enumValues)[number];
export type MoneyOrigin = (typeof moneyOrigin.enumValues)[number];
export type PaymentProvider = (typeof paymentProvider.enumValues)[number];
export type PaymentEnvironment = (typeof paymentEnvironment.enumValues)[number];
export type PaymentConnectionStatus = (typeof paymentConnectionStatus.enumValues)[number];
export type PaymentMethod = (typeof paymentMethod.enumValues)[number];
export type PaymentStatus = (typeof paymentStatus.enumValues)[number];
export type RefundStatus = (typeof refundStatus.enumValues)[number];
export type SubscriptionStatus = (typeof subscriptionStatus.enumValues)[number];

/** USD only in Milestone 9; the column is there so the day a second currency arrives is not a back-fill. */
const currency = () => char('currency', { length: 3 }).notNull().default('USD');
/** Cents, as bigint: a document total outgrows an int long before a business does. */
const cents = (name: string) => bigint(name, { mode: 'number' });

/** One sellable thing: a part, work done, or a charge. Archived, never deleted. */
export const products = app.table('products', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  description: text('description'),
  sku: text('sku'),
  kind: productKind('kind').notNull().default('product'),
  unitPriceCents: cents('unit_price_cents').notNull().default(0),
  unitLabel: text('unit_label').notNull().default('each'),
  taxable: boolean('taxable').notNull().default(true),
  /** The bookable service this is the price of: one product per service. */
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** What a maintenance plan costs and what it includes; a subscription takes a copy when it is sold. */
export const plans = app.table('plans', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  description: text('description'),
  priceCents: cents('price_cents').notNull().default(0),
  interval: planInterval('interval').notNull().default('month'),
  intervalCount: integer('interval_count').notNull().default(1),
  taxable: boolean('taxable').notNull().default(true),
  /** The "what you get" lines the plan page prints. */
  includes: jsonb('includes').$type<string[]>().notNull().default([]),
  /** Maintenance (0095): the service the plan covers, and how often its members are due. */
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
  visitEveryMonths: smallint('visit_every_months'),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** Per business and kind. Sending locks this row and takes the next number in the same transaction. */
export const documentCounters = app.table(
  'document_counters',
  {
    workspaceId: workspaceRef(),
    /** estimate, invoice. */
    kind: text('kind').notNull(),
    nextNumber: bigint('next_number', { mode: 'number' }).notNull().default(1),
    prefix: text('prefix').notNull().default(''),
    pad: integer('pad').notNull().default(4),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.kind] })],
);

/**
 * A quote. Frozen once sent: number, tax, totals and lines are that document's for life, and changing one
 * means voiding and reissuing (a guard trigger, 0045). What the customer did on /e/<token> — opening it, and
 * pressing Accept with their typed name — is the worker's; a person may record a yes given on the phone as
 * 'staff', in their own name.
 */
export const estimates = app.table('estimates', {
  id: id(),
  workspaceId: workspaceRef(),
  /** 8 random characters, not secret: /e/<public_ref><code>, the code an HMAC over link_version. */
  publicRef: text('public_ref').notNull(),
  linkVersion: integer('link_version').notNull().default(1),
  /** Taken from the counter when it is sent, and kept for life, void or not. */
  number: text('number'),
  status: estimateStatus('status').notNull().default('draft'),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  assigneeUserId: userRef('assignee_user_id'),
  title: text('title'),
  notes: text('notes'),
  subtotalCents: cents('subtotal_cents').notNull().default(0),
  discountCents: cents('discount_cents').notNull().default(0),
  /** Set when the discount was asked for as a percentage ("10% off"). */
  discountPercentBp: integer('discount_percent_bp'),
  taxableBaseCents: cents('taxable_base_cents').notNull().default(0),
  taxCents: cents('tax_cents').notNull().default(0),
  totalCents: cents('total_cents').notNull().default(0),
  /** One rate per business, snapshotted here with the name it is shown under. */
  taxRateBp: integer('tax_rate_bp').notNull().default(0),
  taxLabel: text('tax_label'),
  currency: currency(),
  /** What is asked for up front if they accept: a share of the total or an amount, never both. */
  depositPercentBp: integer('deposit_percent_bp'),
  depositCents: cents('deposit_cents'),
  expiresOn: date('expires_on'),
  sentAt: ts('sent_at'),
  firstViewedAt: ts('first_viewed_at'),
  lastViewedAt: ts('last_viewed_at'),
  acceptedAt: ts('accepted_at'),
  /** link (the customer pressed Accept) or staff (a person recorded a yes given on the phone). */
  acceptedVia: text('accepted_via'),
  acceptedBy: userRef('accepted_by'),
  acceptedName: text('accepted_name'),
  /** The exact wording shown above the Accept button, and a hash of what was accepted. */
  acceptedWording: text('accepted_wording'),
  acceptedHash: text('accepted_hash'),
  declinedAt: ts('declined_at'),
  declinedReason: text('declined_reason'),
  voidedAt: ts('voided_at'),
  voidedBy: userRef('voided_by'),
  voidReason: text('void_reason'),
  /**
   * The worker's: which nudges have gone out, and whether this quote came from another CRM and is therefore
   * never chased from here (`imported: 'quiet'`). Invoices have carried the same since M9.
   */
  reminderState: jsonb('reminder_state').$type<Json>().notNull().default({}),
  createdBy: userRef('created_by'),
  ...timestamps(),
  // Milestone 10
  syncWindow: syncWindow(),
  memberViewerIds: memberViewerIds(),
});

/** What a product said at the moment it was added: repricing the catalogue never reprices a document. */
export const estimateLines = app.table('estimate_lines', {
  id: id(),
  workspaceId: workspaceRef(),
  estimateId: uuid('estimate_id')
    .notNull()
    .references(() => estimates.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  quantity: numeric('quantity', { precision: 12, scale: 3 })
    .notNull()
    .default(sql`1`),
  unitLabel: text('unit_label').notNull().default('each'),
  unitPriceCents: cents('unit_price_cents').notNull().default(0),
  taxable: boolean('taxable').notNull().default(true),
  /** This line's share of the document discount, allocated pro rata before tax. */
  discountCents: cents('discount_cents').notNull().default(0),
  amountCents: cents('amount_cents').notNull().default(0),
  ...timestamps(),
  // Milestone 10: the estimate's, copied by trigger.
  syncWindow: syncWindow(),
  memberViewerIds: memberViewerIds(),
});

/**
 * A bill. Frozen on send like an estimate. amount_paid_cents, amount_refunded_cents and paid_at are rolled up
 * from the payments and refunds that succeeded (0047, 0053) and never written by hand; balance_cents is
 * generated. A refund gives money back and never puts it back on the bill: paid stays paid.
 */
export const invoices = app.table('invoices', {
  id: id(),
  workspaceId: workspaceRef(),
  publicRef: text('public_ref').notNull(),
  linkVersion: integer('link_version').notNull().default(1),
  number: text('number'),
  status: invoiceStatus('status').notNull().default('draft'),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  assigneeUserId: userRef('assignee_user_id'),
  title: text('title'),
  notes: text('notes'),
  estimateId: uuid('estimate_id').references(() => estimates.id, { onDelete: 'set null' }),
  /** The booking this is for: the seat, so a deposit and a balance both point at one visit. */
  attendeeId: uuid('attendee_id').references(() => appointmentAttendees.id, {
    onDelete: 'set null',
  }),
  subscriptionId: uuid('subscription_id').references((): AnyPgColumn => subscriptions.id, {
    onDelete: 'set null',
  }),
  purpose: invoicePurpose('purpose').notNull().default('standard'),
  origin: moneyOrigin('origin').notNull().default('staff'),
  /** The account it is paid into: a business can have several connected at once. */
  connectionId: uuid('connection_id').references((): AnyPgColumn => paymentConnections.id, {
    onDelete: 'set null',
  }),
  subtotalCents: cents('subtotal_cents').notNull().default(0),
  discountCents: cents('discount_cents').notNull().default(0),
  discountPercentBp: integer('discount_percent_bp'),
  taxableBaseCents: cents('taxable_base_cents').notNull().default(0),
  taxCents: cents('tax_cents').notNull().default(0),
  totalCents: cents('total_cents').notNull().default(0),
  taxRateBp: integer('tax_rate_bp').notNull().default(0),
  taxLabel: text('tax_label'),
  currency: currency(),
  dueOn: date('due_on'),
  terms: text('terms'),
  amountPaidCents: cents('amount_paid_cents').notNull().default(0),
  amountRefundedCents: cents('amount_refunded_cents').notNull().default(0),
  /**
   * What is still owed, generated by the database (0053): total − paid. A refund only uses up an overpayment
   * — a credit still shows as a negative balance — and never reopens what was owed. Core's `balanceCents`.
   */
  balanceCents: cents('balance_cents').generatedAlwaysAs(
    sql`greatest(total_cents - amount_paid_cents, least(0, total_cents - amount_paid_cents + amount_refunded_cents))`,
  ),
  sentAt: ts('sent_at'),
  firstViewedAt: ts('first_viewed_at'),
  lastViewedAt: ts('last_viewed_at'),
  paidAt: ts('paid_at'),
  /** Which reminders have gone out, before and after the due date: the worker's. */
  reminderState: jsonb('reminder_state').$type<Json>().notNull().default({}),
  voidedAt: ts('voided_at'),
  voidedBy: userRef('voided_by'),
  voidReason: text('void_reason'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  // Milestone 10
  syncWindow: syncWindow(),
  memberViewerIds: memberViewerIds(),
});

export const invoiceLines = app.table('invoice_lines', {
  id: id(),
  workspaceId: workspaceRef(),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  quantity: numeric('quantity', { precision: 12, scale: 3 })
    .notNull()
    .default(sql`1`),
  unitLabel: text('unit_label').notNull().default('each'),
  unitPriceCents: cents('unit_price_cents').notNull().default(0),
  taxable: boolean('taxable').notNull().default(true),
  discountCents: cents('discount_cents').notNull().default(0),
  amountCents: cents('amount_cents').notNull().default(0),
  ...timestamps(),
  // Milestone 10: the invoice's, copied by trigger.
  syncWindow: syncWindow(),
  memberViewerIds: memberViewerIds(),
});

/**
 * One account a business has connected. People never read token_enc, token_key_id, pkce_verifier_enc or the
 * sign-in state: those columns are not granted to `authenticated` at all (0046).
 */
export const paymentConnections = app.table('payment_connections', {
  id: id(),
  workspaceId: workspaceRef(),
  provider: paymentProvider('provider').notNull(),
  environment: paymentEnvironment('environment').notNull().default('live'),
  status: paymentConnectionStatus('status').notNull().default('pending'),
  /** The provider's own id for the account, and (Square) the location money is taken at. */
  externalAccountId: text('external_account_id'),
  locationId: text('location_id'),
  label: text('label'),
  displayName: text('display_name'),
  isDefault: boolean('is_default').notNull().default(false),
  capabilities: jsonb('capabilities').$type<Json>().notNull().default({}),
  scopes: text('scopes')
    .array()
    .notNull()
    .default(sql`'{}'`),
  oauthStateHash: text('oauth_state_hash'),
  oauthStateExpiresAt: ts('oauth_state_expires_at'),
  pkceVerifierEnc: text('pkce_verifier_enc'),
  tokenEnc: text('token_enc'),
  tokenKeyId: text('token_key_id'),
  tokenExpiresAt: ts('token_expires_at'),
  /** Square's token expires in 30 days, so a refresh runs weekly with an hourly re-arm. */
  nextRefreshAt: ts('next_refresh_at'),
  failures: integer('failures').notNull().default(0),
  lastError: text('last_error'),
  /** person, revoked, deauthorized, failed, replaced. */
  disconnectedReason: text('disconnected_reason'),
  connectedAt: ts('connected_at'),
  disconnectedAt: ts('disconnected_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  /** Who may bill into it (0105), and the people it is kept to (empty exactly when it is open to everyone). */
  usedBy: paymentAccountUse('used_by').notNull().default('everyone'),
  userIds: uuid('user_ids')
    .array()
    .notNull()
    .default(sql`'{}'`),
});

/** Status only moves forward, so a late webhook can never un-pay an invoice (a guard trigger, 0047). */
export const payments = app.table('payments', {
  id: id(),
  workspaceId: workspaceRef(),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  amountCents: cents('amount_cents').notNull(),
  currency: currency(),
  method: paymentMethod('method').notNull(),
  /** Null for cash, a cheque or anything else taken off the system. */
  provider: paymentProvider('provider'),
  connectionId: uuid('connection_id').references(() => paymentConnections.id, {
    onDelete: 'set null',
  }),
  providerPaymentId: text('provider_payment_id'),
  /** The provider's own word for where it is, kept beside ours. */
  providerStatus: text('provider_status'),
  status: paymentStatus('status').notNull().default('requires_payment'),
  failureCode: text('failure_code'),
  feeCents: cents('fee_cents'),
  netCents: cents('net_cents'),
  receivedAt: ts('received_at'),
  /** What the card was ("Visa", "4242"), where the provider said. Never the number, and null for anything else. */
  cardBrand: text('card_brand'),
  cardLast4: text('card_last4'),
  /** The person who recorded a cash or cheque payment. */
  recordedBy: userRef('recorded_by'),
  /** Written before the provider is called; a unique index behind it makes charging twice impossible. */
  idempotencyKey: text('idempotency_key'),
  ...timestamps(),
  // Milestone 10: the invoice's, copied by trigger.
  syncWindow: syncWindow(),
  memberViewerIds: memberViewerIds(),
});

export const refunds = app.table('refunds', {
  id: id(),
  workspaceId: workspaceRef(),
  paymentId: uuid('payment_id')
    .notNull()
    .references(() => payments.id, { onDelete: 'cascade' }),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  amountCents: cents('amount_cents').notNull(),
  currency: currency(),
  reason: text('reason'),
  provider: paymentProvider('provider'),
  connectionId: uuid('connection_id').references(() => paymentConnections.id, {
    onDelete: 'set null',
  }),
  providerRefundId: text('provider_refund_id'),
  providerStatus: text('provider_status'),
  status: refundStatus('status').notNull().default('pending'),
  failureCode: text('failure_code'),
  refundedAt: ts('refunded_at'),
  requestedBy: userRef('requested_by'),
  idempotencyKey: text('idempotency_key'),
  ...timestamps(),
  // Milestone 10: the invoice's, copied by trigger.
  syncWindow: syncWindow(),
  memberViewerIds: memberViewerIds(),
});

/** Our mirror of a plan billing at the provider. 'unmanaged' is one whose account was disconnected. */
export const subscriptions = app.table('subscriptions', {
  id: id(),
  workspaceId: workspaceRef(),
  publicRef: text('public_ref').notNull(),
  payVersion: integer('pay_version').notNull().default(1),
  planId: uuid('plan_id').references(() => plans.id, { onDelete: 'set null' }),
  /** The plan as it was sold: repricing the catalogue never reprices a customer. */
  planName: text('plan_name').notNull(),
  priceCents: cents('price_cents').notNull().default(0),
  currency: currency(),
  interval: planInterval('interval').notNull().default('month'),
  intervalCount: integer('interval_count').notNull().default(1),
  taxable: boolean('taxable').notNull().default(true),
  includes: jsonb('includes').$type<string[]>().notNull().default([]),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  connectionId: uuid('connection_id').references(() => paymentConnections.id, {
    onDelete: 'set null',
  }),
  provider: paymentProvider('provider'),
  externalSubscriptionId: text('external_subscription_id'),
  /** The provider's customer and the token for the card it bills. Never a number, and the worker's alone. */
  customerRef: text('customer_ref'),
  methodToken: text('method_token'),
  cardBrand: text('card_brand'),
  cardLast4: text('card_last4'),
  cardExpiryMonth: smallint('card_expiry_month'),
  cardExpiryYear: smallint('card_expiry_year'),
  /** Set while the plan waits on the customer to put a card on it; cleared the moment one lands. */
  cardRequestedAt: ts('card_requested_at'),
  status: subscriptionStatus('status').notNull().default('draft'),
  startedOn: date('started_on'),
  currentPeriodStart: date('current_period_start'),
  currentPeriodEnd: date('current_period_end'),
  nextBillingOn: date('next_billing_on'),
  pausedAt: ts('paused_at'),
  cancelledAt: ts('cancelled_at'),
  cancelReason: text('cancel_reason'),
  endedOn: date('ended_on'),
  /** How many cycles in a row the card has failed; the provider's own retries happen underneath this. */
  failedCycles: integer('failed_cycles').notNull().default(0),
  lastError: text('last_error'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

// ---------- Milestone 10: the phone ----------
export const commandOutcome = app.enum('command_outcome', ['applied', 'refused']);
export type CommandOutcome = (typeof commandOutcome.enumValues)[number];

/**
 * A command the phone sent, claimed by its id as the first statement of its transaction so a repeat gets the first
 * answer back (0054). Unique per person and command id. The answer is stored at the end of the same transaction (a
 * constraint trigger refuses to commit one without it), or with a final refusal in a short transaction of its own.
 * Only the person reads their receipts; a daily job removes those older than 90 days.
 */
export const commandReceipts = app.table('command_receipts', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** The id the person's device gave the command. */
  commandId: uuid('command_id').notNull(),
  /** Null for a command about the person's own account. */
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  /** The command's name, e.g. "person.update". */
  command: text('command').notNull(),
  /** A hash of the input: the same id with a different input is refused. */
  inputHash: text('input_hash').notNull(),
  outcome: commandOutcome('outcome').notNull(),
  /** The command's output, or the refusal's body. */
  answer: jsonb('answer').$type<unknown>(),
  /** When the person made the change, corrected for their phone's clock. */
  occurredAt: ts('occurred_at').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
});

/**
 * Each person's effective role in each business they can open, agency roles flattened in (0056): exactly
 * private.effective_workspace_role(). Kept by triggers on the memberships; the gate every business sync stream
 * checks. People read their own rows.
 */
export const workspaceAccess = app.table(
  'workspace_access',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: workspaceRef(),
    role: memberRole('role').notNull(),
    /**
     * Whether this person sees every thread in this business (0083). True for everyone until the business
     * narrows its inbox, and true for owners and admins always. Kept by a trigger; what `business_v1`'s
     * `inbox` sync parameter reads, so it is one of the rows the database keeps equal to RLS.
     */
    seesWholeInbox: boolean('sees_whole_inbox').notNull().default(true),
    /**
     * Everything this person may do in this business (0106): their role's permissions with the business's settings
     * for the role and for them applied, private.user_permissions(). What private.has_permission() reads.
     */
    permissions: text('permissions')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** Whether they manage money here (money.manage): what the `managed` sync parameter reads. */
    managesMoney: boolean('manages_money').notNull().default(false),
    /** Whether they may see money here (money.read): what the `reads_money` sync parameter reads. */
    readsMoney: boolean('reads_money').notNull().default(false),
    /** Whether they may use the inbox here (inbox.use): what the `uses_inbox` sync parameter reads. */
    usesInbox: boolean('uses_inbox').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);
/** The permissions an owner may turn on or off for a role or a person (0106), and what each stands on. */
export const customizablePermissions = app.table('customizable_permissions', {
  permission: text('permission').primaryKey(),
  requires: text('requires')
    .array()
    .notNull()
    .default(sql`'{}'`),
  /** The add-on this permission belongs to (0108); null for core's. */
  addonId: text('addon_id'),
});

/** A business's own answer for one role and one permission (0106), in place of the default. Never for owners. */
export const rolePermissionOverrides = app.table(
  'role_permission_overrides',
  {
    workspaceId: workspaceRef(),
    role: memberRole('role').notNull(),
    permission: text('permission')
      .notNull()
      .references(() => customizablePermissions.permission, { onDelete: 'cascade' }),
    allowed: boolean('allowed').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.role, t.permission] })],
);

/** A business's own answer for one person and one permission (0106), in place of their role's. */
export const memberPermissionOverrides = app.table(
  'member_permission_overrides',
  {
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: text('permission')
      .notNull()
      .references(() => customizablePermissions.permission, { onDelete: 'cascade' }),
    allowed: boolean('allowed').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.permission] })],
);

export const pushPlatform = app.enum('push_platform', ['ios', 'android']);
export type PushPlatform = (typeof pushPlatform.enumValues)[number];

/**
 * One app install a person signed in on (0058). A token is live for one person at a time: signing in as someone else
 * takes it over (private.release_push_token). People turn their own off as 'person' or 'signed_out'; the worker
 * turns off the ones Expo says are gone ('not_registered'). Turned off, never deleted.
 */
export const pushDevices = app.table('push_devices', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  platform: pushPlatform('platform').notNull(),
  /** ExponentPushToken[…]. */
  expoPushToken: text('expo_push_token').notNull(),
  appVersion: text('app_version').notNull(),
  deviceName: text('device_name'),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  disabledAt: ts('disabled_at'),
  /** person, signed_out, not_registered, replaced. */
  disabledReason: text('disabled_reason'),
  ...timestamps(),
});

/**
 * A person's own cell (0059), which "Call" rings to connect them to a customer. HandsFreeOS verifies it with a call;
 * the verification columns are the worker's. One verified cell per person.
 */
export const userPhones = app.table('user_phones', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  e164: text('e164').notNull(),
  verifiedAt: ts('verified_at'),
  verificationCount: integer('verification_count').notNull().default(0),
  lastVerificationAt: ts('last_verification_at'),
  ...timestamps(),
});

// ---------- Milestone 11: moving a business here from another CRM (0064-0066) ----------
export const migrationSource = app.enum('migration_source', [
  'gohighlevel',
  'hubspot',
  'salesforce',
  'jobber',
  'housecall_pro',
  'servicetitan',
  'follow_up_boss',
]);
export const migrationInstallKind = app.enum('migration_install_kind', ['agency', 'location']);
/**
 * How a source was connected (0069). `oauth` is a sign-in the person approved, and the source said what it
 * granted. `private_token` is a token the business made in its own sub-account and pasted here: it reaches
 * one sub-account, it never says what it may read, and it cannot be refreshed.
 */
export const migrationAuthKind = app.enum('migration_auth_kind', ['oauth', 'private_token']);
export const migrationConnectionStatus = app.enum('migration_connection_status', [
  'pending',
  'active',
  'reauth_required',
  'error',
  'disconnected',
]);
export const migrationStatus = app.enum('migration_status', [
  'draft',
  'connected',
  'scanning',
  'scanned',
  'ready',
  'importing',
  'paused',
  'verifying',
  'imported',
  'transition',
  'finalizing',
  'completed',
  'needs_attention',
  'failed',
  'cancelling',
  'cancelled',
  'rolling_back',
  'rolled_back',
]);
export const migrationScopeStatus = app.enum('migration_scope_status', [
  'discovered',
  'skipped',
  'mapped',
  'scanning',
  'scanned',
  'ready',
  'importing',
  'paused',
  'verifying',
  'imported',
  'transition',
  'completed',
  'needs_attention',
  'failed',
  'rolling_back',
  'rolled_back',
]);
export const migrationCountQuality = app.enum('migration_count_quality', [
  'complete',
  'estimated',
  'permission_limited',
  'not_enumerable',
  'unknown',
]);
export const migrationCapability = app.enum('migration_capability', [
  'ready',
  'needs_review',
  'action_required',
  'port_required',
  'not_available',
  'not_supported',
  'not_imported',
  'not_in_release',
]);
export const migrationFindingSeverity = app.enum('migration_finding_severity', [
  'info',
  'review',
  'action',
  'blocking',
]);
export const migrationJobState = app.enum('migration_job_state', [
  'pending',
  'leased',
  'done',
  'retry',
  'quarantined',
  'failed',
  'cancelled',
]);
export const migrationJobKind = app.enum('migration_job_kind', [
  'discover',
  'scan',
  'fetch',
  'normalize',
  'import',
  'media',
  'link',
  'verify',
  'reconcile',
  'rollback',
]);
export const migrationItemState = app.enum('migration_item_state', [
  'discovered',
  'staged',
  'normalized',
  'matched',
  'imported',
  'verified',
  'skipped',
  'waiting',
  'needs_review',
  'failed',
  'rolled_back',
]);
export const migrationErrorKind = app.enum('migration_error_kind', [
  'transient',
  'permission',
  'mapping',
  'dependency',
  'conflict',
  'source_gone',
  'policy',
  'target',
]);
export const migrationMediaState = app.enum('migration_media_state', [
  'pending',
  'copying',
  'stored',
  'missing',
  'failed',
  'skipped',
]);
export const mergeResolution = app.enum('merge_resolution', [
  'pending',
  'merged',
  'separate',
  'remapped',
  'dismissed',
]);
export const migrationCheckKind = app.enum('migration_check_kind', [
  'counts',
  'identity',
  'references',
  'fields',
  'history',
  'media',
  'financial',
  'structure',
  'transition',
  'rollback',
]);
export const migrationCheckResult = app.enum('migration_check_result', [
  'passed',
  'warned',
  'failed',
  'skipped',
]);
export const reconnectKind = app.enum('reconnect_kind', [
  'payments',
  'calendar',
  'mailbox',
  'social',
  'messaging',
  'accounting',
  'meetings',
  'reviews',
  'dns',
  'other',
]);
export const reconnectState = app.enum('reconnect_state', [
  'todo',
  'in_progress',
  'done',
  'not_needed',
  'blocked',
]);
export const portState = app.enum('port_state', [
  'not_started',
  'information_required',
  'documents_required',
  'ready_to_submit',
  'submitted',
  'carrier_review',
  'scheduled',
  'complete',
  'rejected',
  'cancelled',
  'needs_attention',
]);

export type MigrationSource = (typeof migrationSource.enumValues)[number];
export type MigrationStatus = (typeof migrationStatus.enumValues)[number];
export type MigrationScopeStatus = (typeof migrationScopeStatus.enumValues)[number];
export type MigrationCountQuality = (typeof migrationCountQuality.enumValues)[number];
export type MigrationCapability = (typeof migrationCapability.enumValues)[number];
export type MigrationFindingSeverity = (typeof migrationFindingSeverity.enumValues)[number];
export type MigrationJobState = (typeof migrationJobState.enumValues)[number];
export type MigrationJobKind = (typeof migrationJobKind.enumValues)[number];
export type MigrationItemState = (typeof migrationItemState.enumValues)[number];
export type MigrationErrorKind = (typeof migrationErrorKind.enumValues)[number];
export type MigrationMediaState = (typeof migrationMediaState.enumValues)[number];
export type MergeResolution = (typeof mergeResolution.enumValues)[number];
export type MigrationCheckKind = (typeof migrationCheckKind.enumValues)[number];
export type MigrationCheckResult = (typeof migrationCheckResult.enumValues)[number];
export type ReconnectKind = (typeof reconnectKind.enumValues)[number];
export type ReconnectState = (typeof reconnectState.enumValues)[number];
export type PortState = (typeof portState.enumValues)[number];

const orgRef = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

/**
 * One authorized sign-in to the CRM a business is leaving (0064). Tokens and the sign-in's one-time secrets are
 * sealed by the worker and never granted to `authenticated`, exactly like mailboxes, calendars and payment
 * accounts. People rename a source or disconnect it; everything else is the worker's.
 */
export const migrationConnections = app.table('migration_connections', {
  id: id(),
  organizationId: orgRef(),
  /**
   * The business that connected this source, when a business connected its own rather than its agency
   * (0068). Null for an agency's connection. It is what lets that business claim the sub-accounts this
   * sign-in reaches, and nobody else's.
   */
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  sourceSystem: migrationSource('source_system').notNull(),
  installKind: migrationInstallKind('install_kind').notNull().default('location'),
  /** Which door this came in through (0069). A private token is always one sub-account. */
  authKind: migrationAuthKind('auth_kind').notNull().default('oauth'),
  status: migrationConnectionStatus('status').notNull().default('pending'),
  /** The source's own id for the agency or sub-account this reaches. */
  externalAccountId: text('external_account_id'),
  displayName: text('display_name'),
  /**
   * What the sign-in was granted, and what a whole import would have wanted. Both are empty for a private
   * token, which says nothing about its own access: what it can read is found out by asking (0069).
   */
  scopes: text('scopes')
    .array()
    .notNull()
    .default(sql`'{}'`),
  missingScopes: text('missing_scopes')
    .array()
    .notNull()
    .default(sql`'{}'`),
  oauthStateHash: text('oauth_state_hash'),
  oauthStateExpiresAt: ts('oauth_state_expires_at'),
  pkceVerifierEnc: text('pkce_verifier_enc'),
  tokenEnc: text('token_enc'),
  tokenKeyId: text('token_key_id'),
  tokenExpiresAt: ts('token_expires_at'),
  nextRefreshAt: ts('next_refresh_at'),
  adapterVersion: text('adapter_version'),
  failures: integer('failures').notNull().default(0),
  lastError: text('last_error'),
  /** person, revoked, failed, replaced, finalized. */
  disconnectedReason: text('disconnected_reason'),
  connectedAt: ts('connected_at'),
  disconnectedAt: ts('disconnected_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** One move from one source into one or more businesses here (0064). */
export const migrations = app.table('migrations', {
  id: id(),
  organizationId: orgRef(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => migrationConnections.id, { onDelete: 'cascade' }),
  sourceSystem: migrationSource('source_system').notNull(),
  status: migrationStatus('status').notNull().default('draft'),
  name: text('name').notNull(),
  transitionEnabled: boolean('transition_enabled').notNull().default(true),
  /** Chris chose 30 days, extendable, with a reminder at seven left. Null until the first import finishes. */
  transitionEndsAt: ts('transition_ends_at'),
  transitionExtendedCount: integer('transition_extended_count').notNull().default(0),
  includeDeleted: boolean('include_deleted').notNull().default(false),
  totals: jsonb('totals').$type<Json>().notNull().default({}),
  adapterVersion: text('adapter_version'),
  mappingVersion: integer('mapping_version').notNull().default(1),
  lastError: text('last_error'),
  startedAt: ts('started_at'),
  importedAt: ts('imported_at'),
  finalizedAt: ts('finalized_at'),
  cancelledAt: ts('cancelled_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/**
 * One sub-account of the old system and the business here it lands in (0064). Several scopes may share one
 * business: Chris chose that, and the merge rules are what keep one person from arriving twice.
 */
export const migrationScopes = app.table('migration_scopes', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  /** Null until the sub-account is mapped, or when it is skipped. */
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  externalScopeId: text('external_scope_id').notNull(),
  name: text('name').notNull(),
  timezone: text('timezone'),
  descriptor: jsonb('descriptor').$type<Json>().notNull().default({}),
  status: migrationScopeStatus('status').notNull().default('discovered'),
  createsWorkspace: boolean('creates_workspace').notNull().default(false),
  selected: boolean('selected').notNull().default(true),
  totals: jsonb('totals').$type<Json>().notNull().default({}),
  lastError: text('last_error'),
  scannedAt: ts('scanned_at'),
  startedAt: ts('started_at'),
  importedAt: ts('imported_at'),
  ...timestamps(),
});

/** One read-only pass over the source (0064). Safe to run again; each run is its own row. */
export const migrationScans = app.table('migration_scans', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id').references(() => migrationScopes.id, { onDelete: 'cascade' }),
  status: migrationScopeStatus('status').notNull().default('scanning'),
  adapterVersion: text('adapter_version'),
  /** The moment the source was read as of: the first import runs up to it, the catch-up starts from it. */
  watermarkAt: ts('watermark_at'),
  manifest: jsonb('manifest').$type<Json>().notNull().default({}),
  estimatedBytes: bigint('estimated_bytes', { mode: 'number' }).notNull().default(0),
  estimatedMinutes: integer('estimated_minutes'),
  lastError: text('last_error'),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
  requestedBy: userRef('requested_by'),
  ...timestamps(),
});

/** What the scan found, per category and per resource a person may pick through (0064). */
export const migrationInventory = app.table('migration_inventory', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id')
    .notNull()
    .references(() => migrationScopes.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  resourceId: text('resource_id'),
  resourceName: text('resource_name'),
  foundCount: bigint('found_count', { mode: 'number' }).notNull().default(0),
  countQuality: migrationCountQuality('count_quality').notNull().default('unknown'),
  capability: migrationCapability('capability').notNull().default('ready'),
  estimatedBytes: bigint('estimated_bytes', { mode: 'number' }).notNull().default(0),
  dependsOn: text('depends_on')
    .array()
    .notNull()
    .default(sql`'{}'`),
  notes: text('notes'),
  scannedAt: ts('scanned_at').notNull().defaultNow(),
  ...timestamps(),
});

/** What a person chose to bring over, saved as they choose it (0064). */
export const migrationSelections = app.table('migration_selections', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id')
    .notNull()
    .references(() => migrationScopes.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  resourceId: text('resource_id'),
  selected: boolean('selected').notNull().default(true),
  /** True when the engine added this because something chosen needs it; the screen says what asked. */
  autoAdded: boolean('auto_added').notNull().default(false),
  requiredBy: text('required_by')
    .array()
    .notNull()
    .default(sql`'{}'`),
  chosenBy: userRef('chosen_by'),
  ...timestamps(),
});

/** Every place the old system holds something this one cannot hold the same way (0064). */
export const migrationFindings = app.table('migration_findings', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id').references(() => migrationScopes.id, { onDelete: 'cascade' }),
  category: text('category'),
  code: text('code').notNull(),
  capability: migrationCapability('capability').notNull(),
  severity: migrationFindingSeverity('severity').notNull().default('info'),
  sourceCapability: text('source_capability'),
  targetCapability: text('target_capability'),
  summary: text('summary').notNull(),
  whatImports: text('what_imports'),
  whatChanges: text('what_changes'),
  recommendedAction: text('recommended_action'),
  blocksImport: boolean('blocks_import').notNull().default(false),
  affectedCount: bigint('affected_count', { mode: 'number' }).notNull().default(0),
  detail: jsonb('detail').$type<Json>().notNull().default({}),
  adapterVersion: text('adapter_version'),
  mappingVersion: integer('mapping_version').notNull().default(1),
  acknowledgedAt: ts('acknowledged_at'),
  acknowledgedBy: userRef('acknowledged_by'),
  firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  ...timestamps(),
});

/** The payload as the old system gave it, checksummed, so a mapping can be corrected later (0065). */
export const migrationSourceObjects = app.table('migration_source_objects', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id')
    .notNull()
    .references(() => migrationScopes.id, { onDelete: 'cascade' }),
  workspaceId: workspaceRef(),
  sourceObjectType: text('source_object_type').notNull(),
  sourceObjectId: text('source_object_id').notNull(),
  sourceParentObjectId: text('source_parent_object_id'),
  category: text('category').notNull(),
  /** The old system's own times. History keeps its dates. */
  sourceCreatedAt: ts('source_created_at'),
  sourceUpdatedAt: ts('source_updated_at'),
  sourceDeletedAt: ts('source_deleted_at'),
  retrievedAt: ts('retrieved_at').notNull().defaultNow(),
  payload: jsonb('payload').$type<Json>().notNull().default({}),
  payloadChecksum: text('payload_checksum').notNull(),
  payloadVersion: integer('payload_version').notNull().default(1),
  adapterVersion: text('adapter_version'),
  state: migrationItemState('state').notNull().default('staged'),
  expiresAt: ts('expires_at'),
  ...timestamps(),
});

/**
 * One source record, one record here (0065). The unique index on
 * (workspace, system, installation, location, object type, object id) is the idempotency boundary the whole
 * platform rests on: replaying a page, retrying a batch or a catch-up sync months later all land on this row.
 */
export const migrationSourceMappings = app.table('migration_source_mappings', {
  id: id(),
  workspaceId: workspaceRef(),
  organizationId: orgRef(),
  sourceSystem: migrationSource('source_system').notNull(),
  installationId: uuid('installation_id')
    .notNull()
    .references(() => migrationConnections.id, { onDelete: 'cascade' }),
  sourceLocationId: text('source_location_id').notNull(),
  sourceObjectType: text('source_object_type').notNull(),
  sourceObjectId: text('source_object_id').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  /** Whether this migration made the record or joined one already here. Rollback reads only this. */
  createdHere: boolean('created_here').notNull().default(true),
  firstMigrationId: uuid('first_migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  lastMigrationId: uuid('last_migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  canonicalSchemaVersion: integer('canonical_schema_version').notNull().default(1),
  mappingVersion: integer('mapping_version').notNull().default(1),
  sourceChecksum: text('source_checksum'),
  lastSyncedAt: ts('last_synced_at'),
  ...timestamps(),
});

/** Two records that may be one person, with the evidence that said so (0065). Never a name alone. */
export const migrationMergeCandidates = app.table('migration_merge_candidates', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id')
    .notNull()
    .references(() => migrationScopes.id, { onDelete: 'cascade' }),
  workspaceId: workspaceRef(),
  sourceObjectType: text('source_object_type').notNull(),
  sourceObjectId: text('source_object_id').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id'),
  /** Which rung of core's hierarchy matched: phone, email, extra_phone, extra_email, corroborating, conflict. */
  matchRule: text('match_rule').notNull(),
  score: integer('score').notNull().default(0),
  evidence: jsonb('evidence').$type<Json>().notNull().default({}),
  resolution: mergeResolution('resolution').notNull().default('pending'),
  autoResolved: boolean('auto_resolved').notNull().default(false),
  resolvedAt: ts('resolved_at'),
  resolvedBy: userRef('resolved_by'),
  ...timestamps(),
});

/** Everything this migration wrote, so rollback can take back exactly that and nothing else (0065). */
export const migrationChangeJournal = app.table('migration_change_journal', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id')
    .notNull()
    .references(() => migrationScopes.id, { onDelete: 'cascade' }),
  workspaceId: workspaceRef(),
  /** create, update, link, merge. */
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  sourceObjectType: text('source_object_type'),
  sourceObjectId: text('source_object_id'),
  /** {field: {before, after}}. Rollback puts back only what is still the value it wrote. */
  changedFields: jsonb('changed_fields')
    .$type<Record<string, { before: unknown; after: unknown }>>()
    .notNull()
    .default({}),
  revertedAt: ts('reverted_at'),
  /** changed_since, depended_on, external. */
  revertSkippedReason: text('revert_skipped_reason'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** What stopped and whether it can be tried again (0065). Sanitized: no tokens, no URLs, no bodies. */
export const migrationErrors = app.table('migration_errors', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id').references(() => migrationScopes.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  category: text('category'),
  sourceObjectType: text('source_object_type'),
  sourceObjectId: text('source_object_id'),
  kind: migrationErrorKind('kind').notNull(),
  code: text('code').notNull(),
  message: text('message').notNull(),
  retryable: boolean('retryable').notNull().default(true),
  attempts: integer('attempts').notNull().default(1),
  detail: jsonb('detail').$type<Json>().notNull().default({}),
  resolvedAt: ts('resolved_at'),
  firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
});

/** A file copied into storage here, so the history still plays after the old system is cancelled (0065). */
export const migrationMedia = app.table('migration_media', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id')
    .notNull()
    .references(() => migrationScopes.id, { onDelete: 'cascade' }),
  workspaceId: workspaceRef(),
  sourceObjectType: text('source_object_type').notNull(),
  sourceObjectId: text('source_object_id').notNull(),
  /** Where it was. Kept only to ask again while the connection lives; never shown to a person. */
  sourceLocator: text('source_locator').notNull(),
  state: migrationMediaState('state').notNull().default('pending'),
  bucket: text('bucket'),
  objectPath: text('object_path'),
  fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
  fileName: text('file_name'),
  declaredMime: text('declared_mime'),
  detectedMime: text('detected_mime'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  checksum: text('checksum'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  storedAt: ts('stored_at'),
  ...timestamps(),
});

/** A leased batch of work (0065). A worker that dies loses a lease, not a migration. */
export const migrationJobs = app.table('migration_jobs', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id').references(() => migrationScopes.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  kind: migrationJobKind('kind').notNull(),
  category: text('category').notNull(),
  state: migrationJobState('state').notNull().default('pending'),
  /** Lower runs first: the pass number from core's dependency graph. */
  pass: integer('pass').notNull().default(0),
  /**
   * The order this batch was made in. Breaks the tie between batches due at the same moment, so two runs
   * of one migration read in the same order — which decides answers, not just tidiness.
   */
  sequence: bigint('sequence', { mode: 'number' })
    .notNull()
    .default(sql`nextval('app.migration_jobs_sequence_seq')`),
  input: jsonb('input').$type<Json>().notNull().default({}),
  result: jsonb('result').$type<Json>().notNull().default({}),
  runAt: ts('run_at').notNull().defaultNow(),
  leasedBy: text('leased_by'),
  leasedUntil: ts('leased_until'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  finishedAt: ts('finished_at'),
  ...timestamps(),
});

/** Where to start again (0065). Saved only after the rows a page produced are safely stored. */
export const migrationCheckpoints = app.table('migration_checkpoints', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id')
    .notNull()
    .references(() => migrationScopes.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  cursor: jsonb('cursor').$type<Json>().notNull().default({}),
  highWaterAt: ts('high_water_at'),
  overlapSeconds: integer('overlap_seconds').notNull().default(300),
  lastSourceObjectId: text('last_source_object_id'),
  counts: jsonb('counts').$type<Json>().notNull().default({}),
  adapterVersion: text('adapter_version'),
  mappingVersion: integer('mapping_version').notNull().default(1),
  complete: boolean('complete').notNull().default(false),
  ...timestamps(),
});

/** One check that the move worked, kept apart from the others because each asks a different question (0066). */
export const migrationVerifications = app.table('migration_verifications', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id').references(() => migrationScopes.id, { onDelete: 'cascade' }),
  category: text('category'),
  kind: migrationCheckKind('kind').notNull(),
  result: migrationCheckResult('result').notNull().default('skipped'),
  expectedCount: bigint('expected_count', { mode: 'number' }),
  actualCount: bigint('actual_count', { mode: 'number' }),
  discrepancy: bigint('discrepancy', { mode: 'number' }).notNull().default(0),
  tolerance: bigint('tolerance', { mode: 'number' }).notNull().default(0),
  summary: text('summary'),
  samples: jsonb('samples').$type<unknown[]>().notNull().default([]),
  ranAt: ts('ran_at').notNull().defaultNow(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/**
 * Something a person has to go and do — reconnect Stripe, change a DNS record (0066). Not a failure of the
 * import, which is why it lives here and not in the errors.
 */
export const migrationReconnectTasks = app.table('migration_reconnect_tasks', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id').references(() => migrationScopes.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  kind: reconnectKind('kind').notNull(),
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  state: reconnectState('state').notNull().default('todo'),
  instructions: text('instructions'),
  /** Where in HandsFreeOS this is done, so the item is a link and not a treasure hunt. */
  settingsPath: text('settings_path'),
  descriptor: jsonb('descriptor').$type<Json>().notNull().default({}),
  blocksLiveUse: boolean('blocks_live_use').notNull().default(false),
  completedAt: ts('completed_at'),
  completedBy: userRef('completed_by'),
  ...timestamps(),
});

/** Moving a phone number: the carrier's process, tracked (0066). Submitting it is always an explicit act. */
export const migrationPortRequests = app.table('migration_port_requests', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id').references(() => migrationScopes.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  e164: text('e164').notNull(),
  friendlyName: text('friendly_name'),
  capabilities: jsonb('capabilities').$type<Json>().notNull().default({}),
  state: portState('state').notNull().default('not_started'),
  selected: boolean('selected').notNull().default(false),
  externalReference: text('external_reference'),
  carrierStatus: text('carrier_status'),
  documents: jsonb('documents').$type<Json>().notNull().default({}),
  scheduledFor: ts('scheduled_for'),
  submittedAt: ts('submitted_at'),
  completedAt: ts('completed_at'),
  lastError: text('last_error'),
  phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id, {
    onDelete: 'set null',
  }),
  /** The port that actually moves this number, once one is started (0080). The carrier machinery is there. */
  numberPortId: uuid('number_port_id').references(() => numberPorts.id, { onDelete: 'set null' }),
  ...timestamps(),
});

/** How one category keeps up with the old system until cutover (0066). */
export const migrationTransitionCursors = app.table('migration_transition_cursors', {
  id: id(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id')
    .notNull()
    .references(() => migrationScopes.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  /** webhook, poll, both, none — and when it is none the screen says so rather than pretending. */
  mode: text('mode').notNull().default('poll'),
  cursor: jsonb('cursor').$type<Json>().notNull().default({}),
  syncedThroughAt: ts('synced_through_at'),
  lastRunAt: ts('last_run_at'),
  nextRunAt: ts('next_run_at'),
  intervalSeconds: integer('interval_seconds').notNull().default(900),
  lagSeconds: integer('lag_seconds').notNull().default(0),
  drift: bigint('drift', { mode: 'number' }).notNull().default(0),
  failures: integer('failures').notNull().default(0),
  lastError: text('last_error'),
  ...timestamps(),
});

/** A change the old system told us about (0066). Its own row, so a repeat or an out-of-order notice is free. */
export const migrationTransitionEvents = app.table('migration_transition_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id')
    .notNull()
    .references(() => migrationScopes.id, { onDelete: 'cascade' }),
  sourceEventId: text('source_event_id'),
  sourceObjectType: text('source_object_type').notNull(),
  sourceObjectId: text('source_object_id').notNull(),
  category: text('category').notNull(),
  /** created, updated, deleted. */
  action: text('action').notNull(),
  occurredAt: ts('occurred_at'),
  receivedAt: ts('received_at').notNull().defaultNow(),
  state: migrationItemState('state').notNull().default('discovered'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  processedAt: ts('processed_at'),
});

/** A record the old system deleted while we were catching up (0066). Never acted on straight away. */
export const migrationTombstones = app.table('migration_tombstones', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  migrationId: uuid('migration_id')
    .notNull()
    .references(() => migrations.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  scopeId: uuid('scope_id')
    .notNull()
    .references(() => migrationScopes.id, { onDelete: 'cascade' }),
  workspaceId: workspaceRef(),
  sourceObjectType: text('source_object_type').notNull(),
  sourceObjectId: text('source_object_id').notNull(),
  targetType: text('target_type'),
  targetId: uuid('target_id'),
  sourceDeletedAt: ts('source_deleted_at'),
  /** pending, archived, kept, ignored. */
  applied: text('applied').notNull().default('pending'),
  reason: text('reason'),
  createdAt: ts('created_at').notNull().defaultNow(),
  appliedAt: ts('applied_at'),
});

// ---------- Milestone 14: lead intake (0072) ----------
export const intakeKind = app.enum('intake_kind', ['text', 'call', 'email', 'website_form', 'api']);

/**
 * One row per way a lead arrives. A channel a business never touched has no row and takes the defaults
 * (on, opens a lead, in the default pipeline), so nothing is seeded; changing one writes the row.
 */
export const intakeSources = app.table('intake_sources', {
  id: id(),
  workspaceId: workspaceRef(),
  kind: intakeKind('kind').notNull(),
  /** What its customers and leads are filed under, e.g. "Text message". */
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  /** Off: the customer is still made, but no lead opens. */
  createLead: boolean('create_lead').notNull().default(true),
  /** Null: the business's default pipeline and its first open stage. */
  pipelineId: uuid('pipeline_id').references(() => pipelines.id, { onDelete: 'set null' }),
  stageId: uuid('stage_id').references(() => pipelineStages.id, { onDelete: 'set null' }),
  dailyCap: integer('daily_cap').notNull().default(50),
  /** Today's count and the day it belongs to; the worker's. */
  dayCount: integer('day_count').notNull().default(0),
  dayOn: date('day_on'),
  lastIntakeAt: ts('last_intake_at'),
  /** website_form: ik_ + 20 base62 characters, made by private.new_intake_key(). In the page's HTML. */
  publicKey: text('public_key'),
  /** api: the SHA-256 of the key that was shown once. Nobody reads this column but the worker. */
  secretHash: bytea('secret_hash'),
  /** The last four characters of that key, so two of them can be told apart on screen. */
  secretHint: text('secret_hint'),
  /** website_form: the sites it may be posted from. Empty accepts none. */
  allowedOrigins: text('allowed_origins').array().notNull().default([]),
  /** Where a plain HTML form's sender goes afterwards; null answers with JSON. */
  redirectUrl: text('redirect_url'),
  lastUsedAt: ts('last_used_at'),
  archivedAt: ts('archived_at'),
  archivedBy: userRef('archived_by'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** What a form or a connected app sent, and what it opened. A retry finds its row instead of opening again. */
export const intakeSubmissions = app.table('intake_submissions', {
  id: id(),
  workspaceId: workspaceRef(),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => intakeSources.id, { onDelete: 'cascade' }),
  /** The sender's own id for this submission, or one made from what it sent. */
  dedupeKey: text('dedupe_key').notNull(),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  /** opened, matched (they were already here), refused. */
  outcome: text('outcome').notNull(),
  refusedReason: text('refused_reason'),
  payload: jsonb('payload').$type<Json>().notNull().default({}),
  receivedAt: ts('received_at').notNull().defaultNow(),
});

/* ===========================================================================
 * Add-ons (0108): where each add-on stands in each business, what it holds
 * outside HandsFreeOS, what it counts, and HandsFreeOS switching one off
 * everywhere. What an add-on is lives in code (packages/core/src/addons).
 * ======================================================================== */

/** One business and one add-on it ever installed. Only `enabled` runs. */
export const addonInstallations = app.table(
  'addon_installations',
  {
    workspaceId: workspaceRef(),
    addonId: text('addon_id').notNull(),
    /** installing, enabled, disabled, uninstalling, uninstalled, purging, purged. */
    state: text('state').notNull(),
    installedVersion: text('installed_version').notNull(),
    dataVersion: integer('data_version').notNull().default(1),
    settings: jsonb('settings').$type<Json>().notNull().default({}),
    settingsVersion: integer('settings_version').notNull().default(1),
    flags: jsonb('flags').$type<Record<string, boolean>>().notNull().default({}),
    /** One more on every reinstall: work queued for an earlier generation never runs. */
    generation: integer('generation').notNull().default(1),
    installedBy: userRef('installed_by'),
    installedAt: ts('installed_at').notNull().defaultNow(),
    changedBy: userRef('changed_by'),
    changedAt: ts('changed_at').notNull().defaultNow(),
    /** What the worker found when it last checked nothing was left behind (private.addon_verify). */
    verification: jsonb('verification').$type<Json | null>(),
    verifiedAt: ts('verified_at'),
    lastError: text('last_error'),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.addonId] })],
);

/** One person's own settings for one add-on in one business. */
export const addonUserSettings = app.table(
  'addon_user_settings',
  {
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addonId: text('addon_id').notNull(),
    settings: jsonb('settings').$type<Json>().notNull().default({}),
    settingsVersion: integer('settings_version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.addonId] })],
);

/** Someone setting aside an add-on Home suggested (not now, not interested), per business (0108). */
export const addonSuggestionDismissals = app.table(
  'addon_suggestion_dismissals',
  {
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addonId: text('addon_id').notNull(),
    choice: text('choice').notNull(),
    decidedAt: ts('decided_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.addonId] })],
);

/** Something an add-on made at a provider, released when it is uninstalled. */
export const addonResources = app.table('addon_resources', {
  id: id(),
  workspaceId: workspaceRef(),
  addonId: text('addon_id').notNull(),
  generation: integer('generation').notNull(),
  /** `<addon>.<kind>`, as its manifest's `resources` lists it. */
  kind: text('kind').notNull(),
  externalId: text('external_id').notNull(),
  label: text('label'),
  /** active, released, failed. */
  status: text('status').notNull().default('active'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  releasedAt: ts('released_at'),
  ...timestamps(),
});

/** Usage an add-on counted, once per key, only while it ran. Append-only. */
export const addonUsageEvents = app.table('addon_usage_events', {
  id: id(),
  workspaceId: workspaceRef(),
  addonId: text('addon_id').notNull(),
  meter: text('meter').notNull(),
  quantity: numeric('quantity').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/* ===========================================================================
 * platform · HandsFreeOS's own support desk (0070). Not tenant data: these
 * tables are read by staff and by the worker, and by no business at all.
 * ======================================================================== */

export const platform = pgSchema('platform');

export const staffRole = platform.enum('staff_role', ['agent', 'lead', 'admin']);
export const staffStatus = platform.enum('staff_status', ['active', 'suspended']);
export const ticketStatus = platform.enum('ticket_status', [
  'new',
  'open',
  'waiting_on_customer',
  'solved',
  'closed',
]);
export const ticketPriority = platform.enum('ticket_priority', ['low', 'normal', 'high', 'urgent']);
export const ticketChannel = platform.enum('ticket_channel', ['email', 'in_app', 'chat']);
export const ticketAuthor = platform.enum('ticket_author', ['customer', 'staff', 'ai', 'system']);

export type StaffRole = (typeof staffRole.enumValues)[number];
export type TicketStatus = (typeof ticketStatus.enumValues)[number];
export type TicketPriority = (typeof ticketPriority.enumValues)[number];
export type TicketChannel = (typeof ticketChannel.enumValues)[number];

/** The people who answer support. A suspended row keeps their name on old tickets and nothing else. */
/** HandsFreeOS switching an add-on off (or marking it deprecated) for every business (0108). */
export const addonOverrides = platform.table('addon_overrides', {
  addonId: text('addon_id').primaryKey(),
  /** deprecated or unavailable: only ever downwards. */
  status: text('status').notNull(),
  reason: text('reason').notNull(),
  setBy: uuid('set_by').references(() => users.id, { onDelete: 'set null' }),
  setAt: ts('set_at').notNull().defaultNow(),
});

/** A business's vote for a planned add-on (0109): one per business per add-on, cast by an owner or admin. */
export const addonVotes = platform.table(
  'addon_votes',
  {
    addonId: text('addon_id').notNull(),
    workspaceId: workspaceRef(),
    votedBy: userRef('voted_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.addonId, t.workspaceId] })],
);

/** Each planned add-on's votes, kept by a trigger on addon_votes (0109). */
export const addonVoteCounts = platform.table('addon_vote_counts', {
  addonId: text('addon_id').primaryKey(),
  votes: integer('votes').notNull().default(0),
  lastVoteAt: ts('last_vote_at'),
});

/** How each week's vote closed (0109): a winner, or nothing voted for or a tie, waiting for the team. */
export const addonVoteWeeks = platform.table('addon_vote_weeks', {
  id: id(),
  endsAt: ts('ends_at').notNull().unique(),
  /** votes, no_votes or tie. */
  outcome: text('outcome').notNull(),
  addonId: text('addon_id'),
  tied: text('tied').array().notNull().default([]),
  topVotes: integer('top_votes').notNull().default(0),
  decidedAt: ts('decided_at'),
  decidedBy: userRef('decided_by'),
  teamToldAt: ts('team_told_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Every add-on picked to come next (0109): Coming soon until it ships. */
export const addonPicks = platform.table('addon_picks', {
  addonId: text('addon_id').primaryKey(),
  /** votes, team or plan. */
  how: text('how').notNull(),
  weekId: uuid('week_id').references(() => addonVoteWeeks.id, { onDelete: 'set null' }),
  votes: integer('votes').notNull().default(0),
  pickedAt: ts('picked_at').notNull().defaultNow(),
  pickedBy: userRef('picked_by'),
  votersToldAt: ts('voters_told_at'),
  shippedAt: ts('shipped_at'),
  shippedToldAt: ts('shipped_told_at'),
});

/** One person told about one pick (0109), so a retry tells nobody twice. The worker's alone. */
export const addonPickDeliveries = platform.table(
  'addon_pick_deliveries',
  {
    addonId: text('addon_id')
      .notNull()
      .references(() => addonPicks.addonId, { onDelete: 'cascade' }),
    /** picked or shipped. */
    kind: text('kind').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sentAt: ts('sent_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.addonId, t.kind, t.userId] })],
);

/** Home's note about a pick, set aside by one person (0109). */
export const addonNewsSeen = platform.table(
  'addon_news_seen',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addonId: text('addon_id')
      .notNull()
      .references(() => addonPicks.addonId, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    seenAt: ts('seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.addonId, t.kind] })],
);

/**
 * Which AI answers (20261013000900): Claude, or OpenAI while Claude is in trouble. One row, written by the worker's
 * checks and by support's switch in /admin (`private.set_ai_provider_mode`).
 */
export const aiProvider = platform.table('ai_provider', {
  id: boolean('id').primaryKey().default(true),
  /** auto, claude or openai. */
  mode: text('mode').notNull().default('auto'),
  /** claude or openai: who answers while the mode is auto. */
  active: text('active').notNull().default('claude'),
  /** status or errors, while on OpenAI. */
  reason: text('reason'),
  claudeStatus: text('claude_status'),
  goodChecks: integer('good_checks').notNull().default(0),
  checkedAt: ts('checked_at'),
  switchedAt: ts('switched_at'),
  modeSetBy: userRef('mode_set_by'),
  modeSetAt: ts('mode_set_at'),
});

export const staff = platform.table('staff', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: staffRole('role').notNull().default('agent'),
  status: staffStatus('status').notNull().default('active'),
  displayName: text('display_name').notNull().default(''),
  signature: text('signature').notNull().default(''),
  invitedBy: userRef('invited_by'),
  /** The one person who may open any business as its owner. Set at the database's console, never by a request. */
  founder: boolean('founder').notNull().default(false),
  ...timestamps(),
});

export const staffInvitations = platform.table('staff_invitations', {
  id: id(),
  email: citext('email').notNull(),
  role: staffRole('role').notNull().default('agent'),
  tokenHash: bytea('token_hash'),
  invitedBy: userRef('invited_by'),
  sentAt: ts('sent_at'),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  acceptedBy: userRef('accepted_by'),
  revokedAt: ts('revoked_at'),
  revokedBy: userRef('revoked_by'),
  ...timestamps(),
});

export const tickets = platform.table('tickets', {
  id: id(),
  number: bigint('number', { mode: 'number' })
    .notNull()
    .default(sql`nextval('platform.ticket_number_seq')`),
  subject: text('subject').notNull().default(''),
  status: ticketStatus('status').notNull().default('new'),
  priority: ticketPriority('priority').notNull().default('normal'),
  channel: ticketChannel('channel').notNull(),
  requesterEmail: citext('requester_email').notNull(),
  requesterName: text('requester_name').notNull().default(''),
  requesterUserId: userRef('requester_user_id'),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'set null',
  }),
  assigneeUserId: uuid('assignee_user_id').references(() => staff.userId, { onDelete: 'set null' }),
  /** Written by the database on insert; Reply-To carries it. */
  replyToken: text('reply_token'),
  firstResponseAt: ts('first_response_at'),
  resolvedAt: ts('resolved_at'),
  lastCustomerAt: ts('last_customer_at'),
  lastStaffAt: ts('last_staff_at'),
  snoozeUntil: ts('snooze_until'),
  tags: text('tags').array().notNull().default([]),
  mergedInto: uuid('merged_into').references((): AnyPgColumn => tickets.id, {
    onDelete: 'set null',
  }),
  ...timestamps(),
});

export const ticketMessages = platform.table('ticket_messages', {
  id: id(),
  ticketId: uuid('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  author: ticketAuthor('author').notNull(),
  internal: boolean('internal').notNull().default(false),
  authorUserId: userRef('author_user_id'),
  bodyText: text('body_text').notNull().default(''),
  bodyHtml: text('body_html'),
  emailMessageId: text('email_message_id'),
  emailInReplyTo: text('email_in_reply_to'),
  attachments: jsonb('attachments').$type<unknown[]>().notNull().default([]),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** The AI's suggested answer, waiting for a person to edit and send it. Never sent on its own. */
export const ticketDrafts = platform.table('ticket_drafts', {
  ticketId: uuid('ticket_id')
    .primaryKey()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  bodyText: text('body_text').notNull(),
  sources: jsonb('sources').$type<unknown[]>().notNull().default([]),
  model: text('model').notNull().default(''),
  answersMessageId: uuid('answers_message_id').references(() => ticketMessages.id, {
    onDelete: 'cascade',
  }),
  createdAt: ts('created_at').notNull().defaultNow(),
  usedAt: ts('used_at'),
  dismissedAt: ts('dismissed_at'),
});

export const ticketEvents = platform.table('ticket_events', {
  id: id(),
  ticketId: uuid('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  actorUserId: userRef('actor_user_id'),
  data: jsonb('data').$type<Json>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const cannedReplies = platform.table('canned_replies', {
  id: id(),
  title: text('title').notNull(),
  bodyText: text('body_text').notNull(),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** One open look at one business, with a reason and an end. The business sees it in its own audit log. */
export const viewAsSessions = platform.table('view_as_sessions', {
  id: id(),
  staffUserId: uuid('staff_user_id')
    .notNull()
    .references(() => staff.userId, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  /** Why support looked. Null only on the founder's own sessions, which need none. */
  reason: text('reason'),
  startedAt: ts('started_at').notNull().defaultNow(),
  /** A look ends by itself; the founder's session has no end date and lasts until they leave. */
  expiresAt: ts('expires_at'),
  endedAt: ts('ended_at'),
  /** The founder working in the business as its owner, rather than support looking at it. */
  acts: boolean('acts').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ---- The usage rate card (M16) ----
// HandsFreeOS's own price list, in `platform` beside the support desk. Costs are micro-dollars (a millionth of
// a dollar): a text segment is 7900 and cents cannot hold it. What a business is charged is worked out in
// cents by core's `priceEvent`, never here.

export const usageUnit = platform.enum('usage_unit', [
  'month',
  'segment',
  'message',
  'minute',
  'mtok',
  'kchar',
]);
export const usageRounding = platform.enum('usage_rounding', ['none', 'minute', 'six_seconds']);

/** One line of one version of the card. A published line is history: only `effectiveTo` and `notes` change. */
export const usageRates = platform.table('usage_rates', {
  id: id(),
  version: integer('version').notNull(),
  key: text('key').notNull(),
  unit: usageUnit('unit').notNull(),
  costMicros: bigint('cost_micros', { mode: 'number' }).notNull(),
  markupBp: integer('markup_bp').notNull().default(15000),
  minChargeCents: integer('min_charge_cents').notNull().default(0),
  roundUpTo: usageRounding('round_up_to').notNull().default('none'),
  effectiveFrom: ts('effective_from').notNull().defaultNow(),
  /** Null while live. Set the instant a later version takes over. */
  effectiveTo: ts('effective_to'),
  notes: text('notes').notNull().default(''),
  publishedBy: userRef('published_by'),
  ...timestamps(),
});

// ---- The usage wallet (M16) ----
// What a business has spent on texts, calls, numbers and AI, and the card that keeps it in funds. Usage only:
// nothing here is a plan or a subscription, and app.payments is a different thing entirely (that table is the
// business's own customers paying *them*).

export const usageEntryKind = app.enum('usage_entry_kind', [
  'spend',
  'topup',
  'adjustment',
  'credit',
  'refund',
]);
export const usageCostSource = app.enum('usage_cost_source', [
  'rate_card',
  'provider',
  'reconciled',
]);
export const walletRechargeStatus = app.enum('wallet_recharge_status', [
  'pending',
  'succeeded',
  'failed',
  'cancelled',
]);

/**
 * How far a business has been rolled onto the wallet: `off` says nothing at all, `warn` shows the balance and
 * the low-balance notices, `enforce` also stops outgoing texts and calls past the overdraft.
 *
 * A real enum in the database (`app.wallet_stage`, 0083) and now a real one here. It was a `text` column with
 * a TypeScript-only union, which typechecked perfectly and still drifted: `parity.test.ts` walks every enum
 * in both and found 126 in SQL against 125 in Drizzle.
 */
export const walletStage = app.enum('wallet_stage', ['off', 'warn', 'enforce', 'agency']);
export type WalletStage = (typeof walletStage.enumValues)[number];

/**
 * One business's balance and how it keeps it topped up. `balanceCents` is written **only** by
 * private.usage_wallet_apply() and is the one money column in the repo that may go negative: inbound calls and
 * texts arrive whether or not there is money, and the carrier has already billed us by then.
 */
export const usageWallets = app.table('usage_wallets', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  balanceCents: bigint('balance_cents', { mode: 'number' }).notNull().default(0),
  autoTopup: boolean('auto_topup').notNull().default(true),
  floorCents: bigint('floor_cents', { mode: 'number' }).notNull().default(1000),
  topupCents: bigint('topup_cents', { mode: 'number' }).notNull().default(2500),
  overdraftCents: bigint('overdraft_cents', { mode: 'number' }).notNull().default(1000),
  provider: paymentProvider('provider'),
  customerRef: text('customer_ref'),
  methodToken: text('method_token'),
  cardBrand: text('card_brand'),
  cardLast4: text('card_last4'),
  cardExpiryMonth: smallint('card_expiry_month'),
  cardExpiryYear: smallint('card_expiry_year'),
  cardRequestedAt: ts('card_requested_at'),
  rechargesInWindow: integer('recharges_in_window').notNull().default(0),
  windowStartedAt: ts('window_started_at'),
  escalationStep: integer('escalation_step').notNull().default(0),
  lastRechargeAt: ts('last_recharge_at'),
  declinesInRow: integer('declines_in_row').notNull().default(0),
  pausedUntil: ts('paused_until'),
  suspendedAt: ts('suspended_at'),
  suspendedReason: text('suspended_reason'),
  lowWarnedAt: ts('low_warned_at'),
  warnFingerprint: text('warn_fingerprint'),
  /**
   * How far along the wallet this business is: `off` (silent), `warn` (told, nothing stops) or `enforce`
   * (stopped past the overdraft). Off everywhere until staff move it, one business at a time.
   */
  stage: walletStage('stage').notNull().default('off'),
  ...timestamps(),
});

/**
 * Who a number rings (M17). **Empty means everybody with the inbox** — that fallback is what keeps every
 * business that never touches this working exactly as it did, and `private.phone_route()` depends on it.
 */
export const phoneNumberMembers = app.table(
  'phone_number_members',
  {
    phoneNumberId: uuid('phone_number_id')
      .notNull()
      .references(() => phoneNumbers.id, { onDelete: 'cascade' }),
    userId: userRef('user_id').notNull(),
    workspaceId: workspaceRef(),
    createdBy: userRef('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.phoneNumberId, t.userId] })],
);

/** Append-only. Every charge and every top-up, with what it was priced from and what was left after it. */
export const usageLedger = app.table('usage_ledger', {
  id: id(),
  workspaceId: workspaceRef(),
  organizationId: orgRef(),
  kind: usageEntryKind('kind').notNull(),
  /** Signed: negative is spend, positive is money in. Never zero. */
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  balanceAfterCents: bigint('balance_after_cents', { mode: 'number' }).notNull().default(0),
  costCents: bigint('cost_cents', { mode: 'number' }),
  markupBp: integer('markup_bp'),
  rateCardVersion: integer('rate_card_version'),
  rateKey: text('rate_key'),
  quantity: numeric('quantity'),
  unit: usageUnit('unit'),
  costSource: usageCostSource('cost_source'),
  subject: text('subject').notNull().default(''),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  providerRef: text('provider_ref'),
  /** Derived from the provider's own immutable id, so one event is counted once however often it is reported. */
  idempotencyKey: text('idempotency_key').notNull(),
  correctsId: uuid('corrects_id').references((): AnyPgColumn => usageLedger.id, {
    onDelete: 'set null',
  }),
  meta: jsonb('meta').notNull().default({}),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/**
 * The AI's hearing and voice (Deepgram), one use at a time, in exact quantities: a sentence costs a fraction of a
 * cent, so the worker bills these in batches (money/speech-usage.ts) rather than a ledger row each.
 */
export const speechUsage = app.table('speech_usage', {
  id: id(),
  workspaceId: workspaceRef(),
  organizationId: orgRef(),
  rateKey: text('rate_key').notNull(),
  quantity: numeric('quantity').notNull(),
  source: text('source').notNull(),
  ref: text('ref'),
  batchId: uuid('batch_id'),
  chargedAt: ts('charged_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** One charge of the card. Written pending, called by a job, and recorded by a second command. */
export const walletRecharges = app.table('wallet_recharges', {
  id: id(),
  workspaceId: workspaceRef(),
  organizationId: orgRef(),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  status: walletRechargeStatus('status').notNull().default('pending'),
  escalationStep: integer('escalation_step').notNull().default(0),
  requestedBy: userRef('requested_by'),
  provider: paymentProvider('provider'),
  providerPaymentId: text('provider_payment_id'),
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),
  idempotencyKey: text('idempotency_key'),
  ledgerEntryId: uuid('ledger_entry_id').references(() => usageLedger.id, { onDelete: 'set null' }),
  succeededAt: ts('succeeded_at'),
  ...timestamps(),
});

// ---- Forms, surveys and quizzes (M15) ----

export const formMode = app.enum('form_mode', ['form', 'survey', 'quiz']);
export const formStatus = app.enum('form_status', ['draft', 'live', 'closed', 'archived']);
export const formResponseStatus = app.enum('form_response_status', ['in_progress', 'completed']);
export const formSource = app.enum('form_source', ['link', 'embed', 'chat', 'qr', 'app', 'api']);
export const customFieldEntity = app.enum('custom_field_entity', [
  'person',
  'company',
  'lead',
  /** A kind of record the business made up; the field says which (`record_type_id`, 0101). */
  'custom_record',
]);
export const customFieldType = app.enum('custom_field_type', [
  'text',
  'long_text',
  'number',
  'money',
  'date',
  'choice',
  'multi_choice',
  'boolean',
  'phone',
  'email',
  'url',
]);

const formLink = () =>
  uuid('form_id')
    .notNull()
    .references(() => forms.id, { onDelete: 'cascade' });

/** A form, a survey or a quiz: one draft (core's FormDefinition) that every editor changes. */
export const forms = app.table('forms', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  mode: formMode('mode').notNull().default('form'),
  status: formStatus('status').notNull().default('draft'),
  /** The public link, /f/<site>/<slug>; renaming retires the old one into formSlugs. */
  slug: text('slug').notNull(),
  definition: jsonb('definition').$type<Json>().notNull().default({}),
  definitionVersion: integer('definition_version').notNull().default(1),
  revision: integer('revision').notNull().default(1),
  activeVersionId: uuid('active_version_id').references((): AnyPgColumn => formVersions.id),
  /** The sites allowed to frame it; empty means it is not embedded anywhere. */
  embedOrigins: textArray('embed_origins'),
  /** The AI teammate may ask its questions in a conversation instead of sending the link. */
  inChat: boolean('in_chat').notNull().default(false),
  /** Completed responses, kept by a trigger: what "closes after 100 answers" reads. */
  responseCount: integer('response_count').notNull().default(0),
  lastResponseAt: ts('last_response_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  archivedAt: ts('archived_at'),
});

/** What a publish froze. Append-only, and a response keeps its version for life. */
export const formVersions = app.table('form_versions', {
  id: id(),
  workspaceId: workspaceRef(),
  formId: formLink(),
  version: integer('version').notNull(),
  definition: jsonb('definition').$type<Json>().notNull(),
  definitionVersion: integer('definition_version').notNull(),
  revision: integer('revision').notNull(),
  /** editor, assistant, template. */
  source: text('source').notNull().default('editor'),
  diffSummary: jsonb('diff_summary').$type<Json[]>().notNull().default([]),
  /**
   * The version a phone should hold (0085): this form's active one, while the form is live. A stored flag
   * because a sync stream cannot join — the same reason `sync_window` is one. Kept by a trigger.
   */
  isActive: boolean('is_active').notNull().default(false),
  publishedBy: userRef('published_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** A renamed form's old links still land here. */
export const formSlugs = app.table(
  'form_slugs',
  {
    workspaceId: workspaceRef(),
    formId: formLink(),
    slug: text('slug').notNull(),
    retiredAt: ts('retired_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.slug] })],
);

/** One person's answers, on the version they were shown. */
export const formResponses = app.table('form_responses', {
  id: id(),
  workspaceId: workspaceRef(),
  formId: formLink(),
  versionId: uuid('version_id')
    .notNull()
    .references(() => formVersions.id),
  status: formResponseStatus('status').notNull().default('in_progress'),
  source: formSource('source').notNull().default('link'),
  /** Null on an anonymous form, and until a half-finished one says who they are. */
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
  answers: jsonb('answers').$type<Json>().notNull().default({}),
  calculations: jsonb('calculations').$type<Json>().notNull().default({}),
  score: numeric('score'),
  scorePossible: numeric('score_possible'),
  scorePercent: integer('score_percent'),
  passed: boolean('passed'),
  /** Core's r_ id inside the version. */
  resultId: text('result_id'),
  /** Save and resume; the token itself is never stored. Worker-only. */
  resumeTokenHash: bytea('resume_token_hash'),
  resumeExpiresAt: ts('resume_expires_at'),
  visitorHash: bytea('visitor_hash'),
  /** The form asked for one answer per customer when this was sent (0077's unique index). */
  onePerPerson: boolean('one_per_person').notNull().default(false),
  startedAt: ts('started_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
  ...timestamps(),
});

/** The same answers one row per question, which is what a results summary counts. */
export const formAnswers = app.table(
  'form_answers',
  {
    workspaceId: workspaceRef(),
    responseId: uuid('response_id')
      .notNull()
      .references(() => formResponses.id, { onDelete: 'cascade' }),
    formId: formLink(),
    questionId: text('question_id').notNull(),
    /** Copied in as they answered, so rewording the question doesn't rewrite history. */
    questionTitle: text('question_title').notNull(),
    questionType: text('question_type').notNull(),
    value: jsonb('value').notNull().default(null),
    numberValue: numeric('number_value'),
    textValue: text('text_value'),
    choiceIds: textArray('choice_ids'),
    choiceLabels: textArray('choice_labels'),
    answeredAt: ts('answered_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.responseId, t.questionId] })],
);

/** How many looked, started and finished, a day at a time. Nothing in it says who anybody is. */
export const formDays = app.table(
  'form_days',
  {
    workspaceId: workspaceRef(),
    formId: formLink(),
    day: date('day').notNull(),
    views: integer('views').notNull().default(0),
    starts: integer('starts').notNull().default(0),
    completions: integer('completions').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.formId, t.day] })],
);

// ---------- what customers said in public (M16) ----------

export const reviewProvider = app.enum('review_provider', ['google', 'facebook']);
export const reviewConnectionStatus = app.enum('review_connection_status', [
  'pending',
  'connected',
  'needs_attention',
  'disconnected',
]);
/** Facebook has no stars: a recommendation is a yes or a no, and is recorded as what it is. */
export const reviewSentiment = app.enum('review_sentiment', ['positive', 'negative']);

/** The Google Business Profile or Facebook Page the reviews are read from, and replied to. */
export const reviewConnections = app.table('review_connections', {
  id: id(),
  workspaceId: workspaceRef(),
  provider: reviewProvider('provider').notNull(),
  status: reviewConnectionStatus('status').notNull().default('pending'),
  /** The provider's own id for the place: a Google location, a Facebook page. */
  externalAccountId: text('external_account_id'),
  displayName: text('display_name'),
  /** Where people read the reviews. */
  publicUrl: text('public_url'),
  scopes: text('scopes')
    .array()
    .notNull()
    .default(sql`'{}'`),
  oauthStateHash: text('oauth_state_hash'),
  oauthStateExpiresAt: ts('oauth_state_expires_at'),
  pkceVerifierEnc: text('pkce_verifier_enc'),
  tokenEnc: text('token_enc'),
  tokenKeyId: text('token_key_id'),
  tokenExpiresAt: ts('token_expires_at'),
  /** Reading is polled: neither provider reliably says the moment somebody writes one. */
  nextSyncAt: ts('next_sync_at'),
  lastSyncedAt: ts('last_synced_at'),
  syncCursor: jsonb('sync_cursor').$type<Json>().notNull().default({}),
  failures: integer('failures').notNull().default(0),
  lastError: text('last_error'),
  /** person, revoked, failed, replaced. */
  disconnectedReason: text('disconnected_reason'),
  connectedAt: ts('connected_at'),
  disconnectedAt: ts('disconnected_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/** One review, as it stands where people read it. */
export const reviews = app.table('reviews', {
  id: id(),
  workspaceId: workspaceRef(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => reviewConnections.id, { onDelete: 'cascade' }),
  provider: reviewProvider('provider').notNull(),
  externalId: text('external_id').notNull(),
  authorName: text('author_name'),
  authorPhotoUrl: text('author_photo_url'),
  /** Google's stars; null for Facebook, which has none. */
  rating: smallint('rating'),
  /** Facebook's thumb; null for Google, where the stars say it. */
  sentiment: reviewSentiment('sentiment'),
  body: text('body'),
  /** Their time, never ours. */
  postedAt: ts('posted_at').notNull(),
  sourceUpdatedAt: ts('source_updated_at'),
  url: text('url'),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  replyBody: text('reply_body'),
  replyPostedAt: ts('reply_posted_at'),
  replyBy: userRef('reply_by'),
  ...timestamps(),
});

/** A text has no subject line and an email does; everything else about the wording is the same. */
export const templateChannel = app.enum('template_channel', ['sms', 'email']);

/**
 * The wording a business reuses: the quote follow-up, the "on our way", the winter reminder.
 *
 * The same `{{placeholders}}` a workflow step uses, so a template can be dropped into either without
 * being rewritten.
 */
export const messageTemplates = app.table('message_templates', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  channel: templateChannel('channel').notNull().default('sms'),
  /** Email only; the table refuses a subject on a text. */
  subject: text('subject'),
  body: text('body').notNull(),
  /** The business's own grouping, one level deep on purpose. */
  folder: text('folder'),
  /** What gets reached for most rises to the top of the picker. */
  usedCount: integer('used_count').notNull().default(0),
  lastUsedAt: ts('last_used_at'),
  createdBy: userRef('created_by'),
  archivedAt: ts('archived_at'),
  ...timestamps(),
});

/** A field the business invented. The values live on the record, keyed by this id. */
export const customFields = app.table('custom_fields', {
  id: id(),
  workspaceId: workspaceRef(),
  entity: customFieldEntity('entity').notNull(),
  /** The short name used in imports, exports and the API ('gate_code'). */
  key: text('key').notNull(),
  label: text('label').notNull(),
  type: customFieldType('type').notNull().default('text'),
  /** Choice and multi-choice: [{value, label}]. */
  options: jsonb('options').$type<Json[]>().notNull().default([]),
  help: text('help').notNull().default(''),
  position: integer('position').notNull().default(0),
  alwaysShow: boolean('always_show').notNull().default(false),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  /** The kind of record it belongs to, when entity is 'custom_record' (0101); null for everything else. */
  recordTypeId: uuid('record_type_id').references((): AnyPgColumn => customRecordTypes.id),
});

// ---- Relationships (0100, 0101) ----

/** What each end of a relationship may be. */
export const relationshipEnd = app.enum('relationship_end', ['person', 'company', 'custom_record']);
/** How many on each end, read from end A to end B: one_to_many is one A with many Bs. */
export const relationshipCardinality = app.enum('relationship_cardinality', [
  'one_to_one',
  'one_to_many',
  'many_to_one',
  'many_to_many',
]);

export type RelationshipEnd = (typeof relationshipEnd.enumValues)[number];
export type RelationshipCardinality = (typeof relationshipCardinality.enumValues)[number];

/** A kind of record a business makes up for itself: "Pet" and "Pets", "Vehicle", "Property". */
export const customRecordTypes = app.table('custom_record_types', {
  id: id(),
  workspaceId: workspaceRef(),
  /** The short name used in the API and imports ('pet'). Never changes, never reused. */
  key: text('key').notNull(),
  singular: text('singular').notNull(),
  plural: text('plural').notNull(),
  /** What one's name is called on its page ("Name", "Address"). */
  nameLabel: text('name_label').notNull().default('Name'),
  /** One of core's RECORD_ICONS. */
  icon: text('icon').notNull().default('box'),
  position: integer('position').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  /** The add-on that manages this kind (0108): only it makes the kind or decides whether it shows. */
  addonId: text('addon_id'),
  /** The permission its records are written with: the add-on's own. Set exactly when addonId is. */
  writePermission: text('write_permission'),
  ...timestamps(),
});

/** One pet, one vehicle, one property: a name, notes and its kind's fields. */
export const customRecords = app.table('custom_records', {
  id: id(),
  workspaceId: workspaceRef(),
  typeId: uuid('type_id')
    .notNull()
    .references(() => customRecordTypes.id),
  name: text('name').notNull(),
  notes: text('notes'),
  /** Its kind's fields, keyed by custom_fields.id. */
  custom: jsonb('custom').$type<Json>().notNull().default({}),
  fieldTimes: fieldTimes(),
  archivedAt: ts('archived_at'),
  archivedBy: userRef('archived_by'),
  createdBy: userRef('created_by'),
  ...timestamps(),
  searchText: text('search_text').generatedAlwaysAs(
    sql`lower(name || ' ' || coalesce(jsonb_path_query_array(custom, 'strict $.*')::text, ''))`,
  ),
  /** Its add-on's data was permanently deleted (0108): only the name is left, so what pointed at it reads. */
  purgedAt: ts('purged_at'),
});

/** Which two kinds of record relate, what each end is called from the other, and how many on each end. */
export const relationshipTypes = app.table('relationship_types', {
  id: id(),
  workspaceId: workspaceRef(),
  aEnd: relationshipEnd('a_end').notNull(),
  aRecordTypeId: uuid('a_record_type_id').references(() => customRecordTypes.id),
  aLabel: text('a_label').notNull(),
  bEnd: relationshipEnd('b_end').notNull(),
  bRecordTypeId: uuid('b_record_type_id').references(() => customRecordTypes.id),
  bLabel: text('b_label').notNull(),
  cardinality: relationshipCardinality('cardinality').notNull().default('many_to_many'),
  /** The same part on both ends (spouses, siblings): a pair with no direction, lower id on end A. */
  mutual: boolean('mutual').notNull().default(false),
  position: integer('position').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdBy: userRef('created_by'),
  /** The add-on that manages this type (0108), and its key in the add-on's manifest. */
  addonId: text('addon_id'),
  addonKey: text('addon_key'),
  ...timestamps(),
});

/** One pair. Each end is one record, in the column for its kind; a_id and b_id are whichever it is. */
export const relationships = app.table('relationships', {
  id: id(),
  workspaceId: workspaceRef(),
  typeId: uuid('type_id')
    .notNull()
    .references(() => relationshipTypes.id),
  aPersonId: uuid('a_person_id').references(() => people.id, { onDelete: 'cascade' }),
  aCompanyId: uuid('a_company_id').references(() => companies.id, { onDelete: 'cascade' }),
  aCustomRecordId: uuid('a_custom_record_id').references(() => customRecords.id, {
    onDelete: 'cascade',
  }),
  bPersonId: uuid('b_person_id').references(() => people.id, { onDelete: 'cascade' }),
  bCompanyId: uuid('b_company_id').references(() => companies.id, { onDelete: 'cascade' }),
  bCustomRecordId: uuid('b_custom_record_id').references(() => customRecords.id, {
    onDelete: 'cascade',
  }),
  aId: uuid('a_id').generatedAlwaysAs(sql`coalesce(a_person_id, a_company_id, a_custom_record_id)`),
  bId: uuid('b_id').generatedAlwaysAs(sql`coalesce(b_person_id, b_company_id, b_custom_record_id)`),
  note: text('note'),
  createdBy: userRef('created_by'),
  ...timestamps(),
});

/**
 * The founding offers (0091). HandsFreeOS's own capped promotions, so the offers, the applications and the
 * grants sit in `platform`; what a workspace may actually use is a tenant fact and sits in `app` below.
 *
 * The cap is not expressed here and cannot be: it is a trigger that locks the offer's row before it counts,
 * and Drizzle has no way to say that. Nothing in TypeScript should try to check it either — read
 * `foundingCounts` for a number to show somebody, and let the insert be the thing that decides.
 */
export const foundingOfferStatus = platform.enum('founding_offer_status', [
  'draft',
  'open',
  'closed',
]);

/** `reserved` and `active` hold a seat. `revoked` and `expired` do not, which is what frees one at once. */
export const foundingGrantStatus = platform.enum('founding_grant_status', [
  'reserved',
  'active',
  'revoked',
  'expired',
]);

export const foundingApplicationStatus = platform.enum('founding_application_status', [
  'pending',
  'approved',
  'declined',
  'waitlisted',
  'expired',
  'withdrawn',
]);

export const foundingOffers = platform.table('founding_offers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Raising this opens seats. Lowering it below what is already out is refused by the database. */
  seatCap: integer('seat_cap').notNull(),
  priceCents: integer('price_cents').notNull().default(0),
  status: foundingOfferStatus('status').notNull().default('draft'),
  showCounter: boolean('show_counter').notNull().default(true),
  startingCreditCents: integer('starting_credit_cents').notNull().default(0),
  claimDays: integer('claim_days').notNull().default(14),
  graceDays: integer('grace_days').notNull().default(14),
  sort: integer('sort').notNull().default(0),
  blurb: text('blurb').notNull().default(''),
  /** `once` is a founding seat, free or paid once. `monthly` is the plan: no seats, no applications (0092). */
  billing: text('billing').$type<'once' | 'monthly'>().notNull().default('once'),
  /**
   * The offer this one opens after, and how many of that one's seats must be out first — null meaning "when
   * it is full". Opened by a trigger at the seat that crosses the line, only ever from `draft`.
   */
  opensAfterOfferId: text('opens_after_offer_id').references((): AnyPgColumn => foundingOffers.id),
  opensAfterCount: integer('opens_after_count'),
  /** The first time it opened, by hand or by the chain. */
  openedAt: ts('opened_at'),
  ...timestamps(),
});

export const foundingGrants = platform.table('founding_grants', {
  id: id(),
  offerId: text('offer_id')
    .notNull()
    .references(() => foundingOffers.id),
  /** A seat belongs to a business, not a person and not a workspace. */
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** Null until they take the seat up: an approval can arrive before there is an account at all. */
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  status: foundingGrantStatus('status').notNull().default('reserved'),
  applicationId: uuid('application_id'),
  reservedAt: ts('reserved_at').notNull().defaultNow(),
  expiresAt: ts('expires_at'),
  activatedAt: ts('activated_at'),
  revokedAt: ts('revoked_at'),
  revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  /** Ours, never theirs. No tenant policy reaches this table. */
  revokeReason: text('revoke_reason').notNull().default(''),
  grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

export const foundingApplications = platform.table('founding_applications', {
  id: id(),
  offerId: text('offer_id')
    .notNull()
    .references(() => foundingOffers.id),
  businessName: text('business_name').notNull(),
  contactName: text('contact_name').notNull(),
  email: citext('email').notNull(),
  phone: text('phone'),
  website: text('website'),
  industry: text('industry'),
  teamSize: text('team_size'),
  note: text('note').notNull().default(''),
  status: foundingApplicationStatus('status').notNull().default('pending'),
  source: text('source').notNull().default(''),
  reviewedAt: ts('reviewed_at'),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  /** Staff-only, and the reason it can be honest. */
  decisionNote: text('decision_note').notNull().default(''),
  /** The sha256 only, like an invitation's. The link itself is shown once and never stored. */
  claimTokenHash: bytea('claim_token_hash').unique(),
  claimExpiresAt: ts('claim_expires_at'),
  grantId: uuid('grant_id').references(() => foundingGrants.id, { onDelete: 'set null' }),
  ...timestamps(),
});

/** Where one attempt to pay for a seat has got to (0093). `pending` has no Stripe page yet; `open` is waiting. */
export const foundingCheckoutStatus = platform.enum('founding_checkout_status', [
  'pending',
  'open',
  'paid',
  'expired',
  'failed',
]);

/**
 * One attempt to pay for a founding seat (0093). Moved on only through 0093's functions: a person starts one
 * from their claim link, and the worker opens Stripe's page and records the payment. Nothing here writes it.
 */
export const foundingCheckouts = platform.table('founding_checkouts', {
  id: id(),
  grantId: uuid('grant_id')
    .notNull()
    .references(() => foundingGrants.id, { onDelete: 'cascade' }),
  offerId: text('offer_id')
    .notNull()
    .references(() => foundingOffers.id),
  organizationId: orgRef(),
  /** The workspace the seat goes on when the money is in. */
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** The offer's price when the checkout started. */
  amountCents: integer('amount_cents').notNull(),
  status: foundingCheckoutStatus('status').notNull().default('pending'),
  sessionRef: text('session_ref').unique(),
  sessionUrl: text('session_url'),
  sessionExpiresAt: ts('session_expires_at'),
  paymentRef: text('payment_ref'),
  paidCents: integer('paid_cents'),
  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  /** Why it did not go through — or, on a paid one, why the seat did not go active with it. */
  problem: text('problem').notNull().default(''),
  openedAt: ts('opened_at'),
  paidAt: ts('paid_at'),
  closedAt: ts('closed_at'),
  ...timestamps(),
});

export const planKind = app.enum('plan_kind', ['founding_free', 'founding_lifetime', 'monthly']);
export const planStatus = app.enum('plan_status', ['active', 'grace', 'past_due', 'canceled']);

/** What one workspace may use, and why. Every gate in the app reads this row. */
export const workspacePlans = app.table('workspace_plans', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  organizationId: orgRef(),
  plan: planKind('plan').notNull(),
  status: planStatus('status').notNull().default('active'),
  grantId: uuid('grant_id').references(() => foundingGrants.id, { onDelete: 'set null' }),
  priceCents: integer('price_cents').notNull().default(0),
  /** The one date in here a business is shown and warned about. */
  graceEndsAt: ts('grace_ends_at'),
  canceledAt: ts('canceled_at'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  currentPeriodEnd: ts('current_period_end'),
  ...timestamps(),
});

/**
 * Automations' "Thank-you after the job" (0094): which way each customer's thank-you went, one per attendee. A
 * `card` row is what opens Home's "job not thanked" card.
 */
export const thankYous = app.table('thank_yous', {
  id: id(),
  workspaceId: workspaceRef(),
  appointmentId: uuid('appointment_id')
    .notNull()
    .references(() => appointments.id, { onDelete: 'cascade' }),
  attendeeId: uuid('attendee_id')
    .notNull()
    .references(() => appointmentAttendees.id, { onDelete: 'cascade' }),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  completedAt: ts('completed_at').notNull(),
  /** sent, drafted, card or skipped. */
  outcome: text('outcome').notNull(),
  reason: text('reason'),
  ...timestamps(),
});

/** Automations' "Referral mentioned" (0094): somebody a customer said needs the business, and what became of it. */
export const referrals = app.table('referrals', {
  id: id(),
  workspaceId: workspaceRef(),
  referrerPersonId: uuid('referrer_person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'set null',
  }),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  callId: uuid('call_id').references(() => calls.id, { onDelete: 'set null' }),
  referredName: text('referred_name'),
  relation: text('relation'),
  referredPhoneE164: text('referred_phone_e164'),
  referredEmail: text('referred_email'),
  need: text('need'),
  quote: text('quote'),
  /** mentioned, lead_created or dismissed. */
  status: text('status').notNull().default('mentioned'),
  personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  decidedBy: userRef('decided_by'),
  decidedAt: ts('decided_at'),
  thankedAt: ts('thanked_at'),
  ...timestamps(),
});

/** Automations 4a: what someone on the team told a customer they'd do, by when (read from their own words). */
export const promises = app.table('promises', {
  id: id(),
  workspaceId: workspaceRef(),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'set null',
  }),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  callId: uuid('call_id').references(() => calls.id, { onDelete: 'set null' }),
  promisedBy: userRef('promised_by'),
  what: text('what').notNull(),
  /** call, send, visit or other. */
  kind: text('kind').notNull().default('other'),
  dueAt: ts('due_at').notNull(),
  /** open or dismissed. */
  status: text('status').notNull().default('open'),
  dismissedBy: userRef('dismissed_by'),
  dismissedAt: ts('dismissed_at'),
  ...timestamps(),
});

/** 0107: a pass the AI takes over the whole customer list (or the ones with a tag), putting tags on and off. */
export const contactAiSweeps = app.table('contact_ai_sweeps', {
  id: id(),
  workspaceId: workspaceRef(),
  requestedBy: userRef('requested_by'),
  instructions: text('instructions').notNull().default(''),
  /** The tags it may use; empty is every tag the business has. */
  tagIds: uuid('tag_ids')
    .array()
    .notNull()
    .default(sql`'{}'`),
  onlyTagId: uuid('only_tag_id').references(() => tags.id, { onDelete: 'set null' }),
  fixDetails: boolean('fix_details').notNull().default(false),
  /** running, done, cancelled or failed. */
  status: text('status').notNull().default('running'),
  total: integer('total').notNull().default(0),
  reviewed: integer('reviewed').notNull().default(0),
  changed: integer('changed').notNull().default(0),
  tagsAdded: integer('tags_added').notNull().default(0),
  tagsRemoved: integer('tags_removed').notNull().default(0),
  detailsChanged: integer('details_changed').notNull().default(0),
  cursorId: uuid('cursor_id'),
  note: text('note'),
  cancelledBy: userRef('cancelled_by'),
  finishedAt: ts('finished_at'),
  ...timestamps(),
});

/** 0107: every look the AI took at a customer's tags and details, what it said and what was done with it. */
export const contactAiReviews = app.table('contact_ai_reviews', {
  id: id(),
  workspaceId: workspaceRef(),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  /** activity or sweep. */
  trigger: text('trigger').notNull(),
  sweepId: uuid('sweep_id').references(() => contactAiSweeps.id, { onDelete: 'set null' }),
  causeEventId: uuid('cause_event_id'),
  /** changed, unchanged, skipped or failed. */
  outcome: text('outcome').notNull(),
  decision: jsonb('decision').$type<Json>().notNull().default({}),
  applied: jsonb('applied').$type<Json>().notNull().default({}),
  note: text('note'),
  model: text('model'),
  correlationId: uuid('correlation_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Automations 5: one text to a list of customers, written per person by the AI and approved by a person. */
export const campaigns = app.table('campaigns', {
  id: id(),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  goal: text('goal').notNull(),
  audience: jsonb('audience').$type<Json>().notNull().default({}),
  perHour: integer('per_hour').notNull().default(20),
  /** drafting, review, sending, paused, done or cancelled. */
  status: text('status').notNull().default('drafting'),
  createdBy: userRef('created_by'),
  approvedBy: userRef('approved_by'),
  approvedAt: ts('approved_at'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  nextSendAt: ts('next_send_at'),
  /** Promotions: the offer (Knowledge → Offers) this campaign is about, if any. */
  offerId: uuid('offer_id').references(() => offers.id, { onDelete: 'set null' }),
  /** Email campaigns: sms, email or call (never changes); an email campaign's one subject and body. */
  channel: text('channel').notNull().default('sms'),
  emailSubject: text('email_subject'),
  emailBody: text('email_body'),
  emailEdited: boolean('email_edited').notNull().default(false),
  /** AI outbound calls: a call campaign's one opening line ("about our fall tune-up …"), and whether a person changed it. */
  callOpening: text('call_opening'),
  callEdited: boolean('call_edited').notNull().default(false),
  /** Why the worker paused it; null when a person did. */
  pausedReason: text('paused_reason'),
  ...timestamps(),
});

/** Automations 5: one customer in a campaign: their draft, why they were left out, and what became of it. */
export const campaignRecipients = app.table('campaign_recipients', {
  id: id(),
  workspaceId: workspaceRef(),
  campaignId: uuid('campaign_id')
    .notNull()
    .references(() => campaigns.id, { onDelete: 'cascade' }),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  /** drafting, ready, skipped, removed, approved, sent or failed. */
  status: text('status').notNull().default('drafting'),
  skipReason: text('skip_reason'),
  draft: text('draft'),
  edited: boolean('edited').notNull().default(false),
  clientId: text('client_id').notNull(),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  sentAt: ts('sent_at'),
  error: text('error'),
  ...timestamps(),
});

/** AI outbound calls: one call the AI teammate means to place, and how it went. */
export const aiCalls = app.table('ai_calls', {
  id: id(),
  workspaceId: workspaceRef(),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  /** confirm_visit, missed_call, quote or campaign. */
  purpose: text('purpose').notNull(),
  attendeeId: uuid('attendee_id').references(() => appointmentAttendees.id, {
    onDelete: 'cascade',
  }),
  missedCallId: uuid('missed_call_id').references(() => calls.id, { onDelete: 'set null' }),
  estimateId: uuid('estimate_id').references(() => estimates.id, { onDelete: 'cascade' }),
  campaignRecipientId: uuid('campaign_recipient_id').references(() => campaignRecipients.id, {
    onDelete: 'cascade',
  }),
  toE164: text('to_e164').notNull(),
  goal: text('goal').notNull(),
  /** awaiting_approval, queued, calling, done, skipped, cancelled or failed. */
  status: text('status').notNull().default('queued'),
  reason: text('reason'),
  draftId: uuid('draft_id').references(() => aiTeammateDrafts.id, { onDelete: 'set null' }),
  callId: uuid('call_id').references(() => calls.id, { onDelete: 'set null' }),
  /** talked, voicemail, no_answer, busy or failed. */
  outcome: text('outcome'),
  summary: text('summary'),
  dedupeKey: text('dedupe_key').notNull(),
  placedAt: ts('placed_at'),
  finishedAt: ts('finished_at'),
  ...timestamps(),
});

/** Email campaigns: an address that asked for no more campaign email from this business. */
export const emailUnsubscribes = app.table('email_unsubscribes', {
  id: id(),
  workspaceId: workspaceRef(),
  address: text('address').notNull(),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  /** link, one_click or postmark. */
  source: text('source').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Automations 4b: one line of guidance the worker made of corrections to the AI teammate. */
export const teammateLessons = app.table('teammate_lessons', {
  id: id(),
  workspaceId: workspaceRef(),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => aiTeammates.id, { onDelete: 'cascade' }),
  line: text('line').notNull(),
  why: text('why'),
  draftIds: uuid('draft_ids')
    .array()
    .notNull()
    .default(sql`'{}'`),
  /** open, applied or dismissed. */
  status: text('status').notNull().default('open'),
  /** Where it goes against what the AI knows: the words there now and what they'd become (core's LessonConflict). */
  conflict: jsonb('conflict').$type<Json>(),
  decidedBy: userRef('decided_by'),
  decidedAt: ts('decided_at'),
  ...timestamps(),
});

/** Maintenance (0095): one customer's own schedule for a service. `everyMonths` null means never remind them. */
export const serviceSchedules = app.table('service_schedules', {
  id: id(),
  workspaceId: workspaceRef(),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id')
    .notNull()
    .references(() => services.id, { onDelete: 'cascade' }),
  everyMonths: smallint('every_months'),
  updatedBy: userRef('updated_by'),
  ...timestamps(),
});

/** Maintenance (0095): the worker's reminders for one customer, service and due day. */
export const maintenanceReminders = app.table('maintenance_reminders', {
  id: id(),
  workspaceId: workspaceRef(),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id')
    .notNull()
    .references(() => services.id, { onDelete: 'cascade' }),
  dueOn: date('due_on').notNull(),
  lastVisitId: uuid('last_visit_id').references(() => appointments.id, { onDelete: 'set null' }),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
    onDelete: 'set null',
  }),
  sentCount: smallint('sent_count').notNull().default(0),
  firstSentAt: ts('first_sent_at'),
  secondSentAt: ts('second_sent_at'),
  /** reminding, booked, card or stopped. */
  status: text('status').notNull().default('reminding'),
  bookedAppointmentId: uuid('booked_appointment_id').references(() => appointments.id, {
    onDelete: 'set null',
  }),
  cardAt: ts('card_at'),
  reason: text('reason'),
  ...timestamps(),
});

/* ===========================================================================
 * platform · Ideas, the roadmap and What's new (0102). HandsFreeOS's own, so
 * they sit beside the support desk: every business reads the same board, and
 * no tenant policy says who may. The counts are kept by the database.
 * ======================================================================== */

export const ideaStatus = platform.enum('idea_status', [
  'under_review',
  'planned',
  'in_progress',
  'done',
  'not_planned',
]);
export const ideaUpdateKind = platform.enum('idea_update_kind', ['status', 'merged', 'merged_in']);
export const whatsNewKind = platform.enum('whats_new_kind', ['new', 'improved', 'fixed']);

export type IdeaStatus = (typeof ideaStatus.enumValues)[number];
export type WhatsNewKind = (typeof whatsNewKind.enumValues)[number];

/** The parts of HandsFreeOS an idea can be about. Archived ones take no new ideas. */
export const ideaAreas = platform.table('idea_areas', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  sort: integer('sort').notNull().default(0),
  archivedAt: ts('archived_at'),
  ...timestamps(),
});

export const ideas = platform.table('ideas', {
  id: id(),
  number: bigint('number', { mode: 'number' })
    .notNull()
    .default(sql`nextval('platform.idea_number_seq')`),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  areaId: text('area_id')
    .notNull()
    .default('other')
    .references(() => ideaAreas.id),
  status: ideaStatus('status').notNull().default('under_review'),
  authorUserId: userRef('author_user_id'),
  /** The business it was shared from. The team's to know, nobody else's. */
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  /** Kept by the database from the votes; no command writes it. */
  voteCount: integer('vote_count').notNull().default(0),
  commentCount: integer('comment_count').notNull().default(0),
  /** Votes, each halving in weight every week, summed as at `trendAt`. */
  trendScore: doublePrecision('trend_score').notNull().default(0),
  trendAt: ts('trend_at').notNull().defaultNow(),
  mergedInto: uuid('merged_into').references((): AnyPgColumn => ideas.id, {
    onDelete: 'set null',
  }),
  hiddenAt: ts('hidden_at'),
  hiddenBy: userRef('hidden_by'),
  statusChangedAt: ts('status_changed_at'),
  ...timestamps(),
  /** Weighted English search document: title A, details B. */
  search: tsvector('search').generatedAlwaysAs(sql`private.idea_search_vector(title, body)`),
});

export const ideaVotes = platform.table(
  'idea_votes',
  {
    ideaId: uuid('idea_id')
      .notNull()
      .references(() => ideas.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ideaId, t.userId] })],
);

export const ideaFollowers = platform.table(
  'idea_followers',
  {
    ideaId: uuid('idea_id')
      .notNull()
      .references(() => ideas.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    following: boolean('following').notNull().default(true),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.ideaId, t.userId] })],
);

export const ideaComments = platform.table('idea_comments', {
  id: id(),
  ideaId: uuid('idea_id')
    .notNull()
    .references(() => ideas.id, { onDelete: 'cascade' }),
  authorUserId: userRef('author_user_id'),
  /** Decided by the database when it was written: whether its author was on the HandsFreeOS team. */
  fromTeam: boolean('from_team').notNull().default(false),
  body: text('body').notNull(),
  hiddenAt: ts('hidden_at'),
  hiddenBy: userRef('hidden_by'),
  /** When the idea's author was emailed about this answer from the team (the worker's). */
  authorToldAt: ts('author_told_at'),
  ...timestamps(),
});

export const whatsNew = platform.table('whats_new', {
  id: id(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  kind: whatsNewKind('kind').notNull().default('new'),
  areaId: text('area_id').references(() => ideaAreas.id),
  /** Null while it is a draft. */
  publishedAt: ts('published_at'),
  authorUserId: userRef('author_user_id'),
  ...timestamps(),
});

export const whatsNewIdeas = platform.table(
  'whats_new_ideas',
  {
    whatsNewId: uuid('whats_new_id')
      .notNull()
      .references(() => whatsNew.id, { onDelete: 'cascade' }),
    ideaId: uuid('idea_id')
      .notNull()
      .references(() => ideas.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.whatsNewId, t.ideaId] })],
);

export const whatsNewReads = platform.table('whats_new_reads', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  seenAt: ts('seen_at').notNull().defaultNow(),
});

export const ideaUpdates = platform.table('idea_updates', {
  id: id(),
  ideaId: uuid('idea_id')
    .notNull()
    .references(() => ideas.id, { onDelete: 'cascade' }),
  kind: ideaUpdateKind('kind').notNull(),
  fromStatus: ideaStatus('from_status'),
  toStatus: ideaStatus('to_status'),
  note: text('note').notNull().default(''),
  otherIdeaId: uuid('other_idea_id').references(() => ideas.id, { onDelete: 'set null' }),
  whatsNewId: uuid('whats_new_id').references(() => whatsNew.id, { onDelete: 'set null' }),
  notify: boolean('notify').notNull().default(true),
  notifiedAt: ts('notified_at'),
  actorUserId: userRef('actor_user_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Who has been told about which update: the worker's record, so a retry never tells anybody twice. */
export const ideaUpdateDeliveries = platform.table(
  'idea_update_deliveries',
  {
    updateId: uuid('update_id')
      .notNull()
      .references(() => ideaUpdates.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sentAt: ts('sent_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.updateId, t.userId] })],
);

export const tables = {
  ideaAreas,
  ideas,
  ideaVotes,
  ideaFollowers,
  ideaComments,
  whatsNew,
  whatsNewIdeas,
  whatsNewReads,
  ideaUpdates,
  ideaUpdateDeliveries,
  serviceSchedules,
  maintenanceReminders,
  thankYous,
  referrals,
  promises,
  contactAiSweeps,
  contactAiReviews,
  teammateLessons,
  campaigns,
  campaignRecipients,
  emailUnsubscribes,
  aiCalls,
  foundingOffers,
  foundingGrants,
  foundingApplications,
  workspacePlans,
  reviewConnections,
  reviews,
  messageTemplates,
  forms,
  formVersions,
  formSlugs,
  formResponses,
  formAnswers,
  formDays,
  customFields,
  customRecordTypes,
  customRecords,
  relationshipTypes,
  relationships,
  intakeSources,
  intakeSubmissions,
  staff,
  staffInvitations,
  tickets,
  ticketMessages,
  ticketDrafts,
  ticketEvents,
  cannedReplies,
  viewAsSessions,
  usageRates,
  usageWallets,
  usageLedger,
  speechUsage,
  walletRecharges,

  migrationConnections,
  migrations,
  migrationScopes,
  migrationScans,
  migrationInventory,
  migrationSelections,
  migrationFindings,
  migrationSourceObjects,
  migrationSourceMappings,
  migrationMergeCandidates,
  migrationChangeJournal,
  migrationErrors,
  migrationMedia,
  migrationJobs,
  migrationCheckpoints,
  migrationVerifications,
  migrationReconnectTasks,
  migrationPortRequests,
  migrationTransitionCursors,
  migrationTransitionEvents,
  migrationTombstones,
  commandReceipts,
  workspaceAccess,
  customizablePermissions,
  rolePermissionOverrides,
  memberPermissionOverrides,
  pushDevices,
  userPhones,
  products,
  plans,
  documentCounters,
  estimates,
  estimateLines,
  invoices,
  invoiceLines,
  paymentConnections,
  payments,
  refunds,
  subscriptions,
  attentionItems,
  aiTeammates,
  aiTeammateRevisions,
  aiTeammateRuns,
  aiTeammateToolCalls,
  aiTeammateDrafts,
  chatWidgets,
  chatVisitors,
  chatSignals,
  workflows,
  workflowVersions,
  workflowRuns,
  workflowRunSteps,
  workflowApprovals,
  workflowSchedules,
  workflowWebhooks,
  workflowProposals,
  workflowTemplates,
  workflowTemplateVersions,
  workflowTemplateInstalls,
  aiUsage,
  knowledgeProfiles,
  knowledgeItems,
  knowledgeSources,
  knowledgeScans,
  knowledgeSuggestions,
  knowledgePacks,
  resources,
  services,
  serviceStaff,
  serviceResources,
  territories,
  territoryMembers,
  bookingSites,
  brandedDomains,
  calendars,
  calendarRevisions,
  calendarSlugs,
  calendarMembers,
  calendarServices,
  calendarResources,
  calendarAssignmentState,
  schedules,
  scheduleExceptions,
  appointmentSeries,
  appointments,
  appointmentStaff,
  appointmentResources,
  appointmentAttendees,
  waitlistEntries,
  appointmentCalendarEvents,
  calendarConnections,
  calendarBusyBlocks,
  assistantThreads,
  assistantRuns,
  assistantMessages,
  assistantToolCalls,
  emailDomains,
  emailAddresses,
  mailboxConnections,
  emailSuppressions,
  emailInboundUnmatched,
  organizations,
  workspaces,
  locations,
  teams,
  users,
  organizationMemberships,
  workspaceMemberships,
  rolePermissions,
  invitations,
  events,
  outbox,
  auditLogs,
  imports,
  importErrors,
  pipelines,
  pipelineStages,
  companies,
  people,
  tags,
  recordTags,
  recordTagRemovals,
  leads,
  tasks,
  activities,
  files,
  telephonyAccounts,
  phoneNumbers,
  telephonyRegistrations,
  registrationDrafts,
  numberPorts,
  twilioConnections,
  numberImports,
  rcsSenders,
  conversations,
  messages,
  calls,
  optOuts,
  webhookDeliveries,
  scheduledJobs,
  addonInstallations,
  addonUserSettings,
  addonSuggestionDismissals,
  addonResources,
  addonUsageEvents,
  addonOverrides,
  addonVotes,
  addonVoteCounts,
  addonVoteWeeks,
  addonPicks,
  addonPickDeliveries,
  addonNewsSeen,
  aiProvider,
} as const;
