/**
 * Drizzle mirror of the `app` schema. The SQL in supabase/migrations is the source of truth;
 * test/parity.test.ts asserts these definitions match the live database column for column.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
  jsonb,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
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
});

// ---------- Milestone 2: CRM core ----------
export const stageKind = app.enum('stage_kind', ['open', 'won', 'lost']);
export const leadStatus = app.enum('lead_status', ['open', 'won', 'lost']);
export const recordType = app.enum('record_type', ['person', 'company', 'lead']);
export const activityKind = app.enum('activity_kind', [
  'note',
  'call',
  'visit',
  'email',
  'sms',
  'system',
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
    sql`lower(coalesce(name, '') || ' ' || coalesce(email::text, '') || ' ' || coalesce(phone_e164, '') || ' ' || coalesce(city, '') || ' ' || coalesce(address_line1, ''))`,
  ),
});

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
    sql`lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email::text, '') || ' ' || coalesce(phone_e164, '') || ' ' || coalesce(city, '') || ' ' || coalesce(address_line1, ''))`,
  ),
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

export const tables = {
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
  leads,
  tasks,
  activities,
  files,
} as const;
