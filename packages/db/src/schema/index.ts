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
  jsonb,
  integer,
  numeric,
  pgSchema,
  primaryKey,
  real,
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
/** 'knowledge': a file in the knowledge base (its record is the workspace itself); tags never use it. */
export const recordType = app.enum('record_type', ['person', 'company', 'lead', 'knowledge']);
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
    sql`lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email::text, '') || ' ' || coalesce(phone_e164, '') || ' ' || coalesce(city, '') || ' ' || coalesce(address_line1, ''))`,
  ),
  // Milestone 3
  smsConsent: smsConsent('sms_consent').notNull().default('unknown'),
  smsConsentAt: ts('sms_consent_at'),
  smsConsentSource: text('sms_consent_source'),
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
  // Milestone 7: answers to the qualifying questions, each question's text copied in (core's shape).
  qualification: jsonb('qualification').$type<Json>().notNull().default({}),
  // Milestone 8: kept by a trigger on activities (0040); nobody writes them directly.
  /** The latest real contact, either way: a text, email, chat, connected call, voicemail or visit. */
  lastContactAt: ts('last_contact_at'),
  /** The business's first reach-out once the lead existed; set once. */
  firstResponseAt: ts('first_response_at'),
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
  'undelivered',
  'failed',
  'received',
  'bounced',
  'complained',
]);
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
export const callAnsweredVia = app.enum('call_answered_via', ['browser', 'forwarding']);
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
export type EmailDomainStatus = (typeof emailDomainStatus.enumValues)[number];
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

/** Milestone 7: who answers a conversation (declared here because `conversations` uses it). */
export const conversationHandler = app.enum('conversation_handler', ['none', 'ai', 'person']);
export type ConversationHandler = (typeof conversationHandler.enumValues)[number];

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
   * cancellation, limit, budget, error, draft_expired, loop, other.
   */
  handoffReason: text('handoff_reason'),
  handoffNote: text('handoff_note'),
  takenOverBy: userRef('taken_over_by'),
  /** The newest customer message the teammate has answered. */
  aiAnsweredThrough: ts('ai_answered_through'),
  aiDisclosedAt: ts('ai_disclosed_at'),
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
  ...timestamps(),
});

/** A workspace's own sending domain and the DNS records Postmark wants for it. */
export const emailDomains = app.table('email_domains', {
  id: id(),
  workspaceId: workspaceRef(),
  domain: text('domain').notNull().unique(),
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
  /** reply, approval. */
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
  createdBy: userRef('created_by'),
  ...timestamps(),
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
});

/**
 * A bill. Frozen on send like an estimate. amount_paid_cents, amount_refunded_cents and paid_at are rolled up
 * from the payments and refunds that succeeded (0047) and never written by hand; balance_cents is generated.
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
  /** total - paid + refunded, generated by the database. */
  balanceCents: cents('balance_cents').generatedAlwaysAs(
    sql`total_cents - amount_paid_cents + amount_refunded_cents`,
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
  /** The person who recorded a cash or cheque payment. */
  recordedBy: userRef('recorded_by'),
  /** Written before the provider is called; a unique index behind it makes charging twice impossible. */
  idempotencyKey: text('idempotency_key'),
  ...timestamps(),
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

export const tables = {
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
  leads,
  tasks,
  activities,
  files,
  telephonyAccounts,
  phoneNumbers,
  telephonyRegistrations,
  conversations,
  messages,
  calls,
  optOuts,
  webhookDeliveries,
  scheduledJobs,
} as const;
