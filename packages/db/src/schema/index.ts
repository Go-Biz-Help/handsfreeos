/**
 * Drizzle mirror of the `app` schema. The SQL in supabase/migrations is the source of truth;
 * test/parity.test.ts asserts these definitions match the live database column for column.
 */
import {
  customType,
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
} as const;
