/**
 * Social Outreach's own tables, in its schema `addon_outreach` (supabase/migrations/20261024000100, 20261026000300
 * for groups and touches, 20261026000400 for friends, and 20261027000300 for Facebook's download file): the Drizzle
 * mirror its server code reads and writes through. Server-only.
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
import type { ChatReadState } from './chat-read';
import type { DownloadCounts, DownloadList, DownloadMessage } from './download';
import type { FriendState } from './limits';
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
    /** On the business's Don't pitch list: by whom and when. */
    dontPitch: boolean('dont_pitch').notNull().default(false),
    dontPitchBy: userRef('dont_pitch_by'),
    dontPitchAt: ts('dont_pitch_at'),
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

/**
 * Where one person's own Facebook stands with a profile: friends, a friend request either way, one they turned down,
 * or not friends; since when as far as HandsFreeOS knows, and whether they keep that friend.
 */
export const friends = addonOutreach.table(
  'friends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    state: text('state').notNull().$type<FriendState>(),
    since: ts('since').notNull(),
    seenAt: ts('seen_at').notNull(),
    keep: boolean('keep').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.workspaceId, t.userId, t.profileId),
    foreignKey({
      columns: [t.workspaceId, t.profileId],
      foreignColumns: [profiles.workspaceId, profiles.id],
    }).onDelete('cascade'),
  ],
);

/** Each time someone brings in Facebook's download file, in parts: when Facebook made it, and what it held. */
export const imports = addonOutreach.table(
  'imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().$type<Platform>(),
    madeAt: ts('made_at').notNull(),
    /** What the whole file held, once its last part is in. */
    counts: jsonb('counts').$type<DownloadCounts>(),
    finishedAt: ts('finished_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id)],
);

/**
 * Someone in one of the lists in a person's download file, by name: friends since when, a request either way, a
 * friend removed, a request deleted, a follower or someone followed. Linked to the profile saved here by that name.
 */
export const filePeople = addonOutreach.table(
  'file_people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().$type<Platform>(),
    list: text('list').notNull().$type<DownloadList>(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    at: ts('at'),
    profileId: uuid('profile_id'),
    importId: uuid('import_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.userId, t.workspaceId, t.platform, t.list, t.nameKey, t.at).nullsNotDistinct(),
    foreignKey({
      columns: [t.workspaceId, t.profileId],
      foreignColumns: [profiles.workspaceId, profiles.id],
    }).onDelete('set null'),
    foreignKey({
      columns: [t.workspaceId, t.importId],
      foreignColumns: [imports.workspaceId, imports.id],
    }).onDelete('cascade'),
  ],
);

/**
 * A person's one-to-one chat with someone, as their download file said: when it started, the latest message and
 * whose it was, how many, and the latest few messages, which the AI reads for a summary, tags, whether they look
 * like a prospect and a next step (./chat-read.ts). A chat put in Contacts keeps the customer it went to.
 */
export const fileChats = addonOutreach.table(
  'file_chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().$type<Platform>(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    firstAt: ts('first_at').notNull(),
    lastAt: ts('last_at').notNull(),
    messages: integer('messages').notNull(),
    lastFromMe: boolean('last_from_me').notNull(),
    profileId: uuid('profile_id'),
    /** The file it last came in with; none for a chat only read in Messenger. */
    importId: uuid('import_id'),
    recent: jsonb('recent').notNull().default([]).$type<DownloadMessage[]>(),
    readState: text('read_state').notNull().default('none').$type<ChatReadState>(),
    summary: text('summary'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'`),
    prospect: boolean('prospect'),
    nextStep: text('next_step'),
    readAt: ts('read_at'),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    /** The chat's number from its link, once it's been read in Messenger. */
    threadKey: text('thread_key'),
    /** When the extension last read it in Messenger. */
    collectedAt: ts('collected_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.userId, t.workspaceId, t.platform, t.nameKey),
    foreignKey({
      columns: [t.workspaceId, t.profileId],
      foreignColumns: [profiles.workspaceId, profiles.id],
    }).onDelete('set null'),
    foreignKey({
      columns: [t.workspaceId, t.importId],
      foreignColumns: [imports.workspaceId, imports.id],
    }).onDelete('cascade'),
  ],
);

/** Every table above, for the test that holds the mirror to the live columns. */
export const OUTREACH_TABLES = {
  fileChats,
  filePeople,
  friends,
  groups,
  imports,
  playbooks,
  profiles,
  threads,
  touches,
} as const;
