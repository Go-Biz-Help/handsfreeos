/**
 * Social Outreach's own tables, in its schema `addon_outreach` (supabase/migrations/20261024000100, 20261026000300
 * for groups and touches, 20261026000400 for friends, 20261027000300 for Facebook's download file, 20261027000900
 * for tidying friends and Facebook's warnings, 20261027001000 for group posts, 20261027001100 for replies, openers
 * and demos, 20261027001200 for the extension on its own, and 20261027001300 for the messages it sends): the Drizzle mirror its server code reads and writes
 * through.
 * Server-only.
 * test/addons/outreach-tables.test.ts holds the mirror to the live columns.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { people, users, workspaces } from '@hfos/db/schema';
import type { TouchKind, TouchStep } from './activity';
import type { MessageKind, ReplyMode, SendingMode } from './automation';
import type { ChatReadState } from './chat-read';
import type { DemoHow } from './demos';
import type { DownloadCounts, DownloadList, DownloadMessage } from './download';
import type { FriendState, TidyKind } from './limits';
import type { DraftOpener, OpenerKind } from './openers';
import type { PlaybookDetails } from './playbooks';
import type { PostCheck, PostFound } from './posts';
import type { SendState } from './sends';
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
    privacy: text('privacy').$type<'public' | 'private'>(),
    members: integer('members'),
    detail: text('detail'),
    /** When its full list of admins and moderators was read: only then are its members suggested. */
    adminsReadAt: ts('admins_read_at'),
    seenAt: ts('seen_at'),
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
    /** When the extension found no post of theirs to like before a friend request (decision 33): it goes without. */
    warmUpMissedAt: ts('warm_up_missed_at'),
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
    /** Taken by the extension on its own (decision 26), not pressed by the person. */
    auto: boolean('auto').notNull().default(false),
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

/**
 * Someone saved from a group's People tab: the lines under their name and the part of the list they were in. Who
 * runs the group (an admin or a moderator) is never approached.
 */
export const groupPeople = addonOutreach.table(
  'group_people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    groupId: uuid('group_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    runsGroup: boolean('runs_group').notNull().default(false),
    part: text('part'),
    lines: text('lines')
      .array()
      .notNull()
      .default(sql`'{}'`),
    seenAt: ts('seen_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.groupId, t.profileId),
    foreignKey({
      columns: [t.workspaceId, t.groupId],
      foreignColumns: [groups.workspaceId, groups.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.profileId],
      foreignColumns: [profiles.workspaceId, profiles.id],
    }).onDelete('cascade'),
  ],
);

/** Whether a person is in a group, as their Facebook last showed it. */
export const myGroups = addonOutreach.table(
  'my_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').notNull(),
    joined: boolean('joined').notNull(),
    seenAt: ts('seen_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.workspaceId, t.userId, t.groupId),
    foreignKey({
      columns: [t.workspaceId, t.groupId],
      foreignColumns: [groups.workspaceId, groups.id],
    }).onDelete('cascade'),
  ],
);

/**
 * A sent request the extension cancelled, or a friend it unfriended, for the person who ticked them: today's limits
 * count these.
 */
export const friendEnds = addonOutreach.table(
  'friend_ends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    kind: text('kind').notNull().$type<TidyKind>(),
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

/** A warning Facebook showed the person, in its own words: it slows them down for a while (./tidy.ts). */
export const warnings = addonOutreach.table(
  'warnings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().$type<Platform>(),
    words: text('words').array().notNull(),
    url: text('url'),
    at: ts('at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id)],
);

/** A post in one of the business's groups worth a comment from the person, and what the AI made of it (./posts.ts). */
export const posts = addonOutreach.table(
  'posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The group it's in (`groups`; let go when it goes). */
    groupId: uuid('group_id'),
    /** Who wrote it. */
    profileId: uuid('profile_id').notNull(),
    url: text('url').notNull(),
    /** When, as Facebook printed it. */
    posted: text('posted'),
    body: text('body').notNull(),
    comments: integer('comments'),
    reactions: integer('reactions'),
    reasons: text('reasons')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** The playbook whose words it says (let go when it goes). */
    playbookId: uuid('playbook_id'),
    found: text('found').notNull().$type<PostFound>(),
    checkState: text('check_state').notNull().default('waiting').$type<PostCheck>(),
    checkWhy: text('check_why'),
    checkedAt: ts('checked_at'),
    skippedAt: ts('skipped_at'),
    seenAt: ts('seen_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.workspaceId, t.userId, t.url),
    foreignKey({
      columns: [t.workspaceId, t.profileId],
      foreignColumns: [profiles.workspaceId, profiles.id],
    }).onDelete('cascade'),
  ],
);

/**
 * A reply the extension saw (decision 22): the last message in someone's chat is theirs, after a message of the
 * person's it noted. One per message of the person's it answers (`after_at`), so a chat seen again is no news.
 */
export const replies = addonOutreach.table(
  'replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    threadKey: text('thread_key'),
    /** The person's message it answers: their last one noted before it was seen. */
    afterAt: ts('after_at').notNull(),
    seenAt: ts('seen_at').notNull(),
    /** Whether their phone was told: not while they were looking at it. */
    pushed: boolean('pushed').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.workspaceId, t.userId, t.profileId, t.afterAt),
    foreignKey({
      columns: [t.workspaceId, t.profileId],
      foreignColumns: [profiles.workspaceId, profiles.id],
    }).onDelete('cascade'),
  ],
);

/**
 * The opener a first message to someone was drafted with (decision 23), as the person copied it: one per person they
 * reach, the last copied before their first message was noted.
 */
export const openerUses = addonOutreach.table(
  'opener_uses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    /** The playbook it's from (let go when it goes). */
    playbookId: uuid('playbook_id'),
    kind: text('kind').notNull().$type<OpenerKind>(),
    text: text('text').notNull(),
    usedAt: ts('used_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
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

/**
 * A demo someone the person reached booked (decision 24): through the person's demo link, which core's booking kept
 * as its `ref` (`appointment_id`, `person_id`), or marked by the person. One a booking, and one mark a person.
 */
export const demos = addonOutreach.table(
  'demos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    how: text('how').notNull().$type<DemoHow>(),
    appointmentId: uuid('appointment_id'),
    personId: uuid('person_id'),
    at: ts('at').notNull(),
    /** A mark the person took back: kept, and not counted. */
    undoneAt: ts('undone_at'),
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
 * What one person lets the extension do on its own (./automation.ts, decisions 26 to 36), and when. The training
 * wheels' columns, replies, tidying, collecting and joining groups are read as those parts arrive; until a person
 * saves theirs, the defaults stand.
 */
export const automation = addonOutreach.table(
  'automation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sending: text('sending').notNull().default('off').$type<SendingMode>(),
    replies: text('replies').notNull().default('draft').$type<ReplyMode>(),
    tidying: text('tidying').notNull().default('off'),
    warmUp: boolean('warm_up').notNull().default(true),
    confirmRequests: boolean('confirm_requests').notNull().default(true),
    collect: boolean('collect').notNull().default(true),
    joinGroups: boolean('join_groups').notNull().default(false),
    hoursStart: smallint('hours_start').notNull().default(9),
    hoursEnd: smallint('hours_end').notNull().default(17),
    days: smallint('days')
      .array()
      .notNull()
      .default(sql`'{1,2,3,4,5}'`),
    wheelsFrom: ts('wheels_from'),
    wheelsOk: integer('wheels_ok').notNull().default(0),
    wheelsEdits: boolean('wheels_edits')
      .array()
      .notNull()
      .default(sql`'{}'`),
    wheelsDoneAt: ts('wheels_done_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.userId)],
);

/**
 * A message the extension drafted to send for one person (./sends.ts, decisions 26 and 27): the words that go and the
 * AI's own, and where it stands. One open (waiting or OK'd) a person, profile and kind at a time.
 */
export const sends = addonOutreach.table(
  'sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    kind: text('kind').notNull().$type<MessageKind>(),
    chatId: uuid('chat_id'),
    threadKey: text('thread_key'),
    text: text('text').notNull(),
    drafted: text('drafted').notNull(),
    opener: jsonb('opener').$type<DraftOpener>(),
    state: text('state').notNull().default('waiting').$type<SendState>(),
    why: text('why'),
    approvedAt: ts('approved_at'),
    doneAt: ts('done_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
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
export const OUTREACH_TABLES = {
  automation,
  fileChats,
  filePeople,
  friendEnds,
  friends,
  groupPeople,
  groups,
  myGroups,
  imports,
  demos,
  openerUses,
  playbooks,
  posts,
  profiles,
  replies,
  sends,
  threads,
  touches,
  warnings,
} as const;
