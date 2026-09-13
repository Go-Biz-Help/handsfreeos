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
export const channel = app.enum('channel', ['sms', 'email']);
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

export const tables = {
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
