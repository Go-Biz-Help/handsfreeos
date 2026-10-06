/**
 * Social Outreach's own tables, in its schema `addon_outreach` (supabase/migrations/20261024000100, and
 * 20261026000300 for groups and touches): the Drizzle mirror its server code reads and writes through. Server-only.
 * test/addons/outreach-tables.test.ts holds the mirror to the live columns.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { people, users, workspaces } from '@hfos/db/schema';
import type { TouchKind, TouchStep } from './activity';
import type { PlaybookDetails } from './playbooks';
import type { Friendship, Platform, SavedMessage } from './saves';

export const addonOutreach = pgSchema('addon_outreach');

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const workspaceRef = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });
const personRef = () =>
  uuid('person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: 'set null' });

/** What a business is after on social media, who it's for, how it sounds and which of its tags to use. */
export const playbooks = addonOutreach.table(
  'playbooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    name: text('name').notNull(),
    template: text('template'),
    details: jsonb('details').notNull().$type<PlaybookDetails>(),
    createdBy: userRef('created_by'),
    updatedBy: userRef('updated_by'),
    archivedAt: ts('archived_at'),
    archivedBy: userRef('archived_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id)],
);

/** A group on a social network that someone was found in. */
export const groups = addonOutreach.table(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    platform: text('platform').notNull().$type<Platform>(),
    platformId: text('platform_id'),
    slug: text('slug'),
    url: text('url').notNull(),
    name: text('name'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id)],
);

/**
 * Someone's profile on a social network, as the extension last saw it: a customer's, or someone the person reached
 * out to who isn't one yet (no `personId`).
 */
export const profiles = addonOutreach.table(
  'profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().$type<Platform>(),
    platformId: text('platform_id'),
    username: text('username'),
    url: text('url').notNull(),
    name: text('name').notNull(),
    intro: text('intro')
      .array()
      .notNull()
      .default(sql`'{}'`),
    friendship: text('friendship').notNull().default('unknown').$type<Friendship>(),
    mutualFriends: integer('mutual_friends'),
    /** The group they were first found in (`groups`; let go when it goes). */
    groupId: uuid('group_id'),
    savedBy: userRef('saved_by'),
    lastSeenBy: userRef('last_seen_by'),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id)],
);

/** A chat with a customer, with its most recent messages. */
export const threads = addonOutreach.table(
  'threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    personId: personRef(),
    platform: text('platform').notNull().$type<Platform>(),
    threadKey: text('thread_key').notNull(),
    ownerUserId: userRef('owner_user_id'),
    encrypted: boolean('encrypted').notNull().default(false),
    url: text('url').notNull(),
    name: text('name').notNull(),
    messages: jsonb('messages')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<SavedMessage[]>(),
    savedMessages: integer('saved_messages').notNull().default(0),
    lastSavedBy: userRef('last_saved_by'),
    lastSavedAt: ts('last_saved_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id)],
);

/**
 * A step someone took on a social network themselves, as the extension noted it: a friend request, a like, a comment
 * or a message, to a profile, with the group they were found in.
 */
export const touches = addonOutreach.table(
  'touches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    profileId: uuid('profile_id').notNull(),
    userId: userRef('user_id'),
    kind: text('kind').notNull().$type<TouchKind>(),
    /** A message's place: a chat started, or a follow-up (`TouchStep`). */
    step: text('step').$type<TouchStep>(),
    /** The group they were found in, when the page said (`groups`; let go when it goes). */
    groupId: uuid('group_id'),
    postUrl: text('post_url'),
    threadKey: text('thread_key'),
    at: ts('at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.profileId],
      foreignColumns: [profiles.workspaceId, profiles.id],
    }).onDelete('cascade'),
  ],
);

/** Every table above, for the test that holds the mirror to the live columns. */
export const OUTREACH_TABLES = { groups, playbooks, profiles, threads, touches } as const;
