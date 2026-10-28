/**
 * Social Outreach's own tables, in its schema `addon_outreach` (supabase/migrations/20261024000100, 20261026000300
 * for groups and touches, 20261026000400 for friends, 20261027000300 for Facebook's download file, 20261027000900
 * for tidying friends and Facebook's warnings, 20261027001000 for group posts, 20261027001100 for replies, openers
 * and demos, 20261027001200 for the extension on its own, 20261027001300 for the messages it sends,
 * 20261027001500 for live status: the computers, the day and the feed, and 20261027001600 for Waiting for you: the
 * steps it needs the person for, and the bundled push, 20261027001700 for asking the extension, 20261027002000 for
 * the fits among friends and chats, 20261027002100 for stages, 20261027002200 for checking and joining groups, 20261027002810 for countries, 20261027008400 for partners, 20261027009300 for finding partners by search, 20261027009800 for a code from the person's email, and 20261027014100 for finding people by topic):
 * the Drizzle mirror its server code reads and writes through.
 * Server-only.
 * test/addons/outreach-tables.test.ts holds the mirror to the live columns.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
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
import { leads, people, users, workspaces } from '@hfos/db/schema';
import type { TouchKind, TouchStep } from './activity';
import type { AskKind, AskReply, AskResult, AskState, AskTask, AskVia } from './asks';
import type {
  OtherPlatform,
  PostingMode,
  PushMode,
  ReplyMode,
  SendingMode,
  SendKind,
} from './automation';
import type { EngagementKind, HelpfulState } from './helpful';
import type { ChatReadState } from './chat-read';
import type { CheckVerdict } from './checks';
import type {
  Answer,
  ConversationStep,
  FollowUpNext,
  MessageNotes,
  MessageSamples,
} from './conversation';
import type { CountryHow, MutualCountries } from './countries';
import type { GroupCheckState, JoinAnswered, JoinState } from './group-checks';
import type { PitchRead } from './stages';
import type { DemoHow } from './demos';
import type { CheckVia, FindHow } from './finds';
import type { DayState, DayVia, DayWhy, ReportedState, StepKind } from './live';
import type { ProfileCheck } from './profile-check';
import type { ProfileTicks } from './readiness';
import type { ListMark } from './lists';
import type { PartnerFit, PartnerKind, PartnerSearchKind, PartnerStage } from './partners';
import type { DownloadCounts, DownloadList, DownloadMessage } from './download';
import type { FriendState, TidyKind } from './limits';
import type { DraftOpener, OpenerKind } from './openers';
import type { PlaybookDetails } from './playbooks';
import type { PostCheck, PostFound } from './posts';
import type { SendState } from './sends';
import type { NeedState, NeedStep } from './waiting-words';
import type { SetupReached } from './setup';
import type { ReviewFix, TrackingNumbers } from './tracking';
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
    /** What its About page and its rules say (decision 48), and when they were read. */
    about: text('about')
      .array()
      .notNull()
      .default(sql`'{}'`),
    rules: text('rules')
      .array()
      .notNull()
      .default(sql`'{}'`),
    aboutAt: ts('about_at'),
    /** A few of its posts, until the AI reads them. */
    checkLines: text('check_lines')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** What the AI made of it: whether the business's people are there, why, who posts, and the playbook. */
    checkState: text('check_state').$type<GroupCheckState>(),
    checkWhy: text('check_why')
      .array()
      .notNull()
      .default(sql`'{}'`),
    checkWho: text('check_who'),
    checkPlaybookId: uuid('check_playbook_id'),
    checkedAt: ts('checked_at'),
    /** The teammate who worked it first (decision 107), and since when: another's Today leaves it out. */
    ownerUserId: userRef('owner_user_id'),
    ownedAt: ts('owned_at'),
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
    /** On the business's Never contact list, stronger than Don't pitch: by whom and when. */
    neverContact: boolean('never_contact').notNull().default(false),
    neverContactBy: userRef('never_contact_by'),
    neverContactAt: ts('never_contact_at'),
    /** When the extension found no post of theirs to like before a friend request (decision 33): it goes without. */
    warmUpMissedAt: ts('warm_up_missed_at'),
    /**
     * Where they live (decisions 61 and 86): a country's two-letter code, and how it's known (`seen` a "Lives in",
     * `friends` a look, `from` only a "From", `guessed` the AI's guess), or `unknown` when nothing said; null for both
     * until it's worked out.
     */
    country: text('country'),
    countryHow: text('country_how').$type<CountryHow>(),
    countryAt: ts('country_at'),
    /** The country a "From" line names, kept to show. */
    countryFrom: text('country_from'),
    /** A second country a look pointed to, when the facts split. */
    countryAlt: text('country_alt'),
    /** The AI's line after a look. */
    countryWhy: text('country_why'),
    /** A look couldn't tell: only a name to go on, or the AI wasn't sure. */
    countryUnsure: boolean('country_unsure').notNull().default(false),
    countryLookedAt: ts('country_looked_at'),
    /** Where their mutual friends live, as the last look found. */
    countryMutual: jsonb('country_mutual').$type<MutualCountries>(),
    /** Let through whatever the business's country setting says (Unskip): by whom and when. */
    countryThrough: boolean('country_through').notNull().default(false),
    countryThroughBy: userRef('country_through_by'),
    countryThroughAt: ts('country_through_at'),
    /** Skipped whatever the setting says (Skip on the Not sure list): by whom and when. */
    countrySkip: boolean('country_skip').notNull().default(false),
    countrySkipBy: userRef('country_skip_by'),
    countrySkipAt: ts('country_skip_at'),
    /** How many friends their profile last said they have. */
    friendsCount: integer('friends_count'),
    /** How many follow them, as their profile last said, and when it was read. */
    followers: integer('followers'),
    followersAt: ts('followers_at'),
    /** When they were found as a partner (decision 81): never pitched as a customer since, nor are their twins. */
    partnerFoundAt: ts('partner_found_at'),
    /**
     * The lead it put in the pipeline when they wanted a demo (decision 105), or the customer's open lead it found, and
     * when: one lead a profile, once, so `leadAt` stays when the lead is deleted for good.
     */
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    leadAt: ts('lead_at'),
    /** Whoever reached them first (decision 107), and since when: another's Today leaves them out. */
    ownerUserId: userRef('owner_user_id'),
    ownedAt: ts('owned_at'),
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
    /** For a like or comment it made on its own: what the post said, the AI's comment, and why that post. */
    postText: text('post_text'),
    commentText: text('comment_text'),
    why: text('why'),
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
    /** When the person set a request they got aside (Waiting for you's Leave it): it counts while it's since `since`. */
    setAsideAt: ts('set_aside_at'),
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
    /** The AI's read of whether it's time to offer (decision 47), with why. */
    pitch: text('pitch').$type<PitchRead>(),
    pitchWhy: text('pitch_why'),
    /** What their last message answers to the person's last step (../conversation.ts, 20261027006400). */
    reply: text('reply').$type<Answer>(),
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
 * runs the group (an admin or a moderator) is never approached as a customer, only asked to partner (decision 81).
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
    /** The writer is asking, now, for what the business offers (decision 49): pushed, and first on Today. */
    strong: boolean('strong').notNull().default(false),
    /** The hashtag or phrase that found it (decision 92); null for a group's or a feed's post. The first one kept. */
    words: text('words'),
    /** When its likers and commenters were read (decision 92): each good post's people are read once. */
    peopleReadAt: ts('people_read_at'),
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
    /** It finds and asks to join good groups when people left to reach run low (decision 48). */
    joinGroups: boolean('join_groups').notNull().default(true),
    watchPosts: boolean('watch_posts').notNull().default(true),
    posting: text('posting').notNull().default('after_ok').$type<PostingMode>(),
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
    noting: boolean('noting').notNull().default(true),
    readChats: boolean('read_chats').notNull().default(true),
    markPosts: boolean('mark_posts').notNull().default(true),
    pushes: text('pushes').notNull().default('bundled').$type<PushMode>(),
    /** The day's report: a push at the end of their working hours with the day's numbers (../tracking.ts). */
    dayReport: boolean('day_report').notNull().default(true),
    /** A push when someone accepts their friend request, connection or follow (decision 101). Off to start. */
    acceptedPush: boolean('accepted_push').notNull().default(false),
    /** How the AI writes for them (../voice.ts). */
    voiceShorthand: boolean('voice_shorthand').notNull().default(false),
    voiceAcronyms: boolean('voice_acronyms').notNull().default(false),
    voiceEmoji: boolean('voice_emoji').notNull().default(false),
    voiceSplit: boolean('voice_split').notNull().default(true),
    /**
     * Which networks they work, and each other network's own choices (../automation.ts, `NetworksSettings`): read with
     * the defaults filling in what's left out. Facebook's choices are the columns above.
     */
    networks: jsonb('networks').notNull().default({}).$type<Record<string, unknown>>(),
    /** Each other network's training wheels, as Facebook's are the wheels columns above (`NetworkWheelsKept`). */
    networkWheels: jsonb('network_wheels').notNull().default({}).$type<NetworkWheelsKept>(),
    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.userId)],
);

/** A network's training wheels as kept in `automation.network_wheels`: when they started, OKs, edits, when done. */
export interface NetworkWheelKept {
  readonly from: string | null;
  readonly ok: number;
  readonly edits: readonly boolean[];
  readonly doneAt: string | null;
}
/** Another network's profile in Get ready, kept on the person's setup row (`setup.network_profiles`). */
export interface NetworkProfileKept {
  readonly ticks?: ProfileTicks;
  readonly check?: ProfileCheck | null;
}
export type NetworkProfilesKept = Partial<Record<OtherPlatform, NetworkProfileKept>>;

export type NetworkWheelsKept = Partial<Record<OtherPlatform, NetworkWheelKept>>;

/**
 * A message the extension drafted to send for one person (./sends.ts, decisions 26 and 27), or a comment on a good post
 * (decision 92): the words that go and the AI's own, and where it stands. One open (waiting or OK'd) a person, profile
 * and kind at a time.
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
    kind: text('kind').notNull().$type<SendKind>(),
    chatId: uuid('chat_id'),
    threadKey: text('thread_key'),
    text: text('text').notNull(),
    drafted: text('drafted').notNull(),
    opener: jsonb('opener').$type<DraftOpener>(),
    state: text('state').notNull().default('waiting').$type<SendState>(),
    why: text('why'),
    /** A reply handed over to the person (Replies (b) or (c)): it waits for an OK of its own, never Approve all. */
    handedOver: boolean('handed_over').notNull().default(false),
    /** Why a reply needs the person (`replyNeedsYou`): it waits for an OK of its own too. */
    needsYou: text('needs_you'),
    /** Who it's to and their profile's link, kept by triggers from `profiles` for phones (20261027001800). */
    name: text('name'),
    profileUrl: text('profile_url'),
    /** The main offer's version it went with (../conversation.ts): what's sent after keeps the first one's. */
    offerVersion: integer('offer_version'),
    /** A comment's post (decision 92): set for kind `comment`, and only for it. */
    postId: uuid('post_id'),
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

/** Each place the extension runs for a person (./live.ts): only the most recently used one works. */
export const computers = addonOutreach.table(
  'computers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    installId: uuid('install_id').notNull(),
    name: text('name').notNull(),
    version: text('version'),
    lastSeenAt: ts('last_seen_at').notNull(),
    activeAt: ts('active_at'),
    state: text('state').notNull().default('idle').$type<ReportedState>(),
    line: text('line'),
    lineAt: ts('line_at'),
    /** The step before the first day under way, whose progress the line is; null for any other work. */
    doing: text('doing').$type<ListMark>(),
    /** The networks Chrome lets it on, as it last said; null from a build that doesn't say (./reports.ts). */
    allowed: text('allowed').array().$type<Platform[]>(),
    nextAt: ts('next_at'),
    toldAt: ts('told_at'),
    /**
     * When it first worked on a build that finds people by topic (decision 92, ./ops/live.ts `foundByTopicSince`): the
     * old search pick carries on only with writers warmed up before then.
     */
    foundByTopicAt: ts('found_by_topic_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.userId, t.installId)],
);

/**
 * The person's day on one network: started or stopped, why, from where and when (./live.ts). Each network's is its
 * own (`platform`, unique with the person), so a stop or a warning on one leaves the others going.
 */
export const days = addonOutreach.table(
  'days',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().default('facebook').$type<Platform>(),
    day: date('day', { mode: 'string' }).notNull(),
    state: text('state').notNull().$type<DayState>(),
    why: text('why').$type<DayWhy>(),
    via: text('via').notNull().$type<DayVia>(),
    changedAt: ts('changed_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  // One a person and network (`days_user_platform_idx`).
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.userId, t.platform)],
);

/** The feed of the extension's steps, and the day's starts, stops and warnings (./live.ts). */
export const liveSteps = addonOutreach.table(
  'live_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    computerId: uuid('computer_id'),
    clientId: uuid('client_id').notNull().defaultRandom(),
    at: ts('at').notNull(),
    kind: text('kind').notNull().$type<StepKind>(),
    line: text('line').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.workspaceId, t.clientId),
    foreignKey({
      columns: [t.workspaceId, t.computerId],
      foreignColumns: [computers.workspaceId, computers.id],
    }).onDelete('cascade'),
  ],
);

/**
 * A step the extension couldn't do and handed to the person (./waiting.ts): open until they did it, let it go, or the
 * step was noted. One open a person, step and profile or post.
 */
export const needs = addonOutreach.table(
  'needs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    step: text('step').notNull().$type<NeedStep>(),
    profileId: uuid('profile_id').notNull(),
    postId: uuid('post_id'),
    sendId: uuid('send_id'),
    name: text('name').notNull(),
    url: text('url'),
    why: text('why').notNull(),
    state: text('state').notNull().default('open').$type<NeedState>(),
    seenAt: ts('seen_at').notNull(),
    clearedAt: ts('cleared_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.profileId],
      foreignColumns: [profiles.workspaceId, profiles.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.postId],
      foreignColumns: [posts.workspaceId, posts.id],
    }).onDelete('cascade'),
    // The database sets only send_id to null (`on delete set null (send_id)`), as the other column-list keys here.
    foreignKey({
      columns: [t.workspaceId, t.sendId],
      foreignColumns: [sends.workspaceId, sends.id],
    }).onDelete('set null'),
  ],
);

/** When each person last got the bundled push about what waits for them (decision 40). */
export const waitingPushes = addonOutreach.table(
  'waiting_pushes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pushedAt: ts('pushed_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.userId)],
);

/** What a person asked their computer to do from HandsFreeOS (./asks.ts): who took it, how it's going, how it ended. */
export const asks = addonOutreach.table(
  'asks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The network it's asked on (`PLATFORMS`): each network's asks are its own. */
    platform: text('platform').notNull().default('facebook').$type<Platform>(),
    kind: text('kind').notNull().$type<AskKind>(),
    target: text('target').notNull().default(''),
    task: jsonb('task')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<AskTask>(),
    about: text('about'),
    via: text('via').notNull().$type<AskVia>(),
    state: text('state').notNull().default('waiting').$type<AskState>(),
    line: text('line'),
    result: jsonb('result').$type<AskResult>(),
    reply: text('reply').$type<AskReply>(),
    computerId: uuid('computer_id'),
    askedAt: ts('asked_at').notNull(),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    toldAt: ts('told_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    // The database sets only computer_id to null (`on delete set null (computer_id)`).
    foreignKey({
      columns: [t.workspaceId, t.computerId],
      foreignColumns: [computers.workspaceId, computers.id],
    }).onDelete('set null'),
  ],
);

/**
 * A code from the person's email that their computer asked for (an ask in `code`, ./asks.ts): kept for the
 * extension to take once, and never after `expiresAt`. Theirs alone, on the database too (20261027009800).
 */
export const askCodes = addonOutreach.table(
  'ask_codes',
  {
    askId: uuid('ask_id').primaryKey(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    givenAt: ts('given_at').notNull().defaultNow(),
    expiresAt: ts('expires_at')
      .notNull()
      .default(sql`now() + interval '10 minutes'`),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.askId],
      foreignColumns: [asks.workspaceId, asks.id],
    }).onDelete('cascade'),
  ],
);

/**
 * Where one person got to in Social Outreach's setup (./setup.ts, decisions 36 and 45). The extension signing in
 * makes a row too, so `startedAt`, not the row, says they started; their own settings saved do too (`settingsAt`).
 */
export const setup = addonOutreach.table(
  'setup',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reached: text('reached').$type<SetupReached>(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    bannerHiddenAt: ts('banner_hidden_at'),
    extensionAt: ts('extension_at'),
    /** The last time they saved their own settings: an owner or admin saving them for them never sets it. */
    settingsAt: ts('settings_at'),
    /** Get ready (../readiness.ts): calls booked a month, when they last saw the math, and the profile items ticked. */
    callsGoal: smallint('calls_goal'),
    numbersAt: ts('numbers_at'),
    profile: jsonb('profile').$type<ProfileTicks>().notNull().default({}),
    /** The AI's latest check of their own Facebook profile (../profile-check.ts): never what the page said. */
    profileCheck: jsonb('profile_check').$type<ProfileCheck>(),
    /** Each other network's profile in Get ready, as the two above are Facebook's: its ticks and the AI's check. */
    networkProfiles: jsonb('network_profiles').$type<NetworkProfilesKept>().notNull().default({}),
    /** When they OK'd how their messages read (Get ready's Your messages), the offer's version then, and the samples. */
    messagesAt: ts('messages_at'),
    messagesVersion: integer('messages_version'),
    messageSamples: jsonb('message_samples').$type<MessageSamples>(),
    /** What they told the AI of each part of their messages (decision 87): the samples and real messages follow it. */
    messageNotes: jsonb('message_notes').$type<Partial<MessageNotes>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.userId)],
);

/**
 * The AI's read of someone the person already knows on Facebook (decision 46): a friend, or someone they've chatted
 * with. What their pages said waits in `lines` until the AI reads it, then goes. Each person's own.
 */
export const checks = addonOutreach.table(
  'checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    lines: text('lines')
      .array()
      .notNull()
      .default(sql`'{}'`),
    verdict: text('verdict').notNull().default('waiting').$type<CheckVerdict>(),
    /** The playbook they fit (let go when it goes). */
    playbookId: uuid('playbook_id'),
    why: text('why')
      .array()
      .notNull()
      .default(sql`'{}'`),
    about: text('about'),
    nextStep: text('next_step'),
    lookedAt: ts('looked_at').notNull(),
    checkedAt: ts('checked_at'),
    /** Check everyone again was pressed since: read again next, whenever it was last checked. */
    again: boolean('again').notNull().default(false),
    /** Their mutual friends the look read (decision 86), matched to profiles kept; let go with the lines. */
    mutualIds: uuid('mutual_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** How many mutual friends the look's page listed, matched or not; null when it wasn't read. */
    mutualRead: integer('mutual_read'),
    /** Of someone the person knows, or someone found by topic (decision 92): the server sets it at each look. */
    via: text('via').notNull().default('known').$type<CheckVia>(),
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

/**
 * The AI's partner check of someone with the business's customers' attention (decision 81, ../partners.ts): a group's
 * admin, someone with a following, or a business with the same customers. What their profile said waits in `lines`
 * until the AI reads it, then goes; a good or maybe is on the Partners list, its stage kept as each is reached. Each
 * person's own.
 */
export const partners = addonOutreach.table(
  'partners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    kind: text('kind').notNull().$type<PartnerKind>(),
    lines: text('lines')
      .array()
      .notNull()
      .default(sql`'{}'`),
    fit: text('fit').notNull().default('waiting').$type<PartnerFit>(),
    /** The partner playbook their audience is (let go when it goes). */
    playbookId: uuid('playbook_id'),
    audience: text('audience'),
    audienceSize: integer('audience_size'),
    why: text('why')
      .array()
      .notNull()
      .default(sql`'{}'`),
    nextStep: text('next_step'),
    stage: text('stage').$type<PartnerStage>(),
    foundAt: ts('found_at'),
    warmedAt: ts('warmed_at'),
    askedAt: ts('asked_at'),
    interestedAt: ts('interested_at'),
    callAt: ts('call_at'),
    partnerAt: ts('partner_at'),
    notNowAt: ts('not_now_at'),
    /** Reaching them (20261027008500): follow-ups since the ask and when the last went, the details, their answer. */
    followUps: smallint('follow_ups').notNull().default(0),
    followedAt: ts('followed_at'),
    detailsAt: ts('details_at'),
    answer: text('answer').$type<Answer>(),
    answeredAt: ts('answered_at'),
    lookedAt: ts('looked_at').notNull(),
    checkedAt: ts('checked_at'),
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

/**
 * Someone a partner search found (stage 4 of the partners plan, 20261027009300), for the person whose computer
 * searched, until the AI has answered for them: the kind it looked for, its words, and when. Each person's own.
 */
export const partnerLeads = addonOutreach.table(
  'partner_leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    platform: text('platform').notNull().$type<Platform>(),
    kind: text('kind').notNull().$type<PartnerSearchKind>(),
    words: text('words').notNull(),
    foundAt: ts('found_at').notNull(),
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

/**
 * Someone the person's computer found by topic (decision 92, ./finds.ts): a good post's writer, liker or commenter, an
 * Alignable search's result or a group's member, with the post or group, the words and place it was found with, and
 * what a commenter said until the AI's check reads it. Each person's own, one row a person and profile.
 */
export const finds = addonOutreach.table(
  'finds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    platform: text('platform').notNull().$type<Platform>(),
    how: text('how').notNull().$type<FindHow>(),
    /** The post they wrote, liked or commented on (let go when it goes). */
    postId: uuid('post_id'),
    /** The group they're in, or the post was in (let go when it goes). */
    groupId: uuid('group_id'),
    words: text('words'),
    place: text('place'),
    /** What a commenter said, and when it was kept: emptied once the AI's check reads it, or 14 days after. */
    said: text('said'),
    saidAt: ts('said_at'),
    foundAt: ts('found_at').notNull(),
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

/** Each word a person's computer searched a network with for a kind of partner: when last, and how many it found. */
export const partnerSearches = addonOutreach.table(
  'partner_searches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().$type<Platform>(),
    kind: text('kind').notNull().$type<PartnerSearchKind>(),
    words: text('words').notNull(),
    searchedAt: ts('searched_at').notNull(),
    found: integer('found').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.workspaceId, t.userId, t.platform, t.kind, t.words),
  ],
);

/**
 * What a person or the AI said about where someone stands beyond what's worked out (decision 47): ready to pitch or not
 * a fit, and when the pitch went. Each person's own.
 */
export const stages = addonOutreach.table(
  'stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    mark: text('mark').$type<'ready' | 'lost'>(),
    markedBy: text('marked_by').$type<'person' | 'ai'>(),
    why: text('why'),
    markedAt: ts('marked_at'),
    pitchedAt: ts('pitched_at'),
    /** When they first said yes: a positive reply (../conversation.ts), counted on Results. */
    positiveAt: ts('positive_at'),
    /** Later (decision 100): off this person's Today until then, their replies aside. Null is not on Later. */
    laterUntil: ts('later_until'),
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

/**
 * Where each person's conversation with someone is (../conversation.ts, decisions 65 to 67): the last step sent, the
 * follow-ups since and when the next is due, their latest answer, and the main offer's version they were first pitched
 * with. A no stops it. Each person's own.
 */
export const followUps = addonOutreach.table(
  'follow_ups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    step: text('step').notNull().$type<ConversationStep>(),
    stepAt: ts('step_at').notNull(),
    sent: smallint('sent').notNull().default(0),
    lastAt: ts('last_at').notNull(),
    next: text('next').$type<FollowUpNext>(),
    dueAt: ts('due_at'),
    answer: text('answer').$type<Answer>(),
    answeredAt: ts('answered_at'),
    offerVersion: integer('offer_version'),
    stoppedAt: ts('stopped_at'),
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

/**
 * Each person's week's review (../tracking.ts, decision 70): what to fix first, in the video's order, the week's
 * numbers, and the words the AI wrote from them, or the numbers' own. One a person a week, each person's own.
 */
export const reviews = addonOutreach.table(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The Monday the week began, in the business's time zone. */
    week: date('week', { mode: 'string' }).notNull(),
    fix: text('fix').notNull().$type<ReviewFix>(),
    numbers: jsonb('numbers').notNull().$type<TrackingNumbers>(),
    target: integer('target'),
    headline: text('headline').notNull(),
    why: text('why').notNull(),
    steps: jsonb('steps').notNull().$type<string[]>(),
    by: text('by').notNull().$type<'ai' | 'rules'>(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.userId, t.week)],
);

/** Each person's asks to join a group (decision 31), with the AI's answers to its questions. Each person's own. */
export const joins = addonOutreach.table(
  'joins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').notNull(),
    state: text('state').notNull().$type<JoinState>(),
    answers: jsonb('answers').notNull().default([]).$type<JoinAnswered[]>(),
    why: text('why'),
    askedAt: ts('asked_at').notNull(),
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
 * The helpful posts the AI drafts for a person to put up in their groups (decision 50): the group, what it's about,
 * the words, and where it stands. Each person's own.
 */
export const helpful = addonOutreach.table(
  'helpful',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The network it goes up on: on Facebook in a group, on LinkedIn on the person's own feed. */
    platform: text('platform').notNull().default('facebook').$type<Platform>(),
    groupId: uuid('group_id'),
    playbookId: uuid('playbook_id'),
    state: text('state').notNull().$type<HelpfulState>(),
    /** The person's posting choice when it was drafted. */
    how: text('how').notNull().$type<PostingMode>(),
    topic: text('topic'),
    body: text('body'),
    postUrl: text('post_url'),
    whyNot: text('why_not'),
    askedAt: ts('asked_at').notNull(),
    draftedAt: ts('drafted_at'),
    approvedAt: ts('approved_at'),
    postedAt: ts('posted_at'),
    endedAt: ts('ended_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.groupId],
      foreignColumns: [groups.workspaceId, groups.id],
    }).onDelete('cascade'),
  ],
);

/** Who reacted to or commented on one of the person's helpful posts: warm leads (decision 50). Each person's own. */
export const engagements = addonOutreach.table(
  'engagements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Null for one seen on the network itself (Alignable's notifications), off any helpful post.
    helpfulId: uuid('helpful_id'),
    profileId: uuid('profile_id').notNull(),
    kind: text('kind').notNull().$type<EngagementKind>(),
    comment: text('comment'),
    seenAt: ts('seen_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.workspaceId, t.id),
    unique().on(t.workspaceId, t.userId, t.helpfulId, t.profileId, t.kind),
    foreignKey({
      columns: [t.workspaceId, t.helpfulId],
      foreignColumns: [helpful.workspaceId, helpful.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.profileId],
      foreignColumns: [profiles.workspaceId, profiles.id],
    }).onDelete('cascade'),
  ],
);

/**
 * When the person's own lists were last saved to their end, before their day (../lists.ts): their friends, the friend
 * requests they've got and the ones they've sent; and when the first Tidy up and good-fits check after that were done.
 * Each person's own: one row a person.
 */
export const listSaves = addonOutreach.table(
  'list_saves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    friendsAt: ts('friends_at'),
    requestsAt: ts('requests_at'),
    sentAt: ts('sent_at'),
    groupsAt: ts('groups_at'),
    groupChecksAt: ts('group_checks_at'),
    tidyAt: ts('tidy_at'),
    checksAt: ts('checks_at'),
    /**
     * Each other network's lists, as the columns above are Facebook's: when each was saved to its end or done, as
     * ISO moments under the network and the column's name (`{ "linkedin": { "friendsAt": "…" } }`).
     */
    networkSaves: jsonb('network_saves')
      .notNull()
      .default({})
      .$type<Partial<Record<OtherPlatform, Partial<Record<string, string>>>>>(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.userId)],
);

/**
 * When each person started on each network: their first step there (decision 96). A network's daily limits are half
 * for their first 2 weeks after it. Written with that first step, and moved only to an earlier one noted later.
 */
export const networkStarts = addonOutreach.table(
  'network_starts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().$type<Platform>(),
    firstAt: ts('first_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.userId, t.platform)],
);

/** Every table above, for the test that holds the mirror to the live columns. */
export const OUTREACH_TABLES = {
  asks,
  automation,
  checks,
  computers,
  days,
  engagements,
  fileChats,
  filePeople,
  finds,
  friendEnds,
  friends,
  groupPeople,
  groups,
  helpful,
  myGroups,
  imports,
  joins,
  demos,
  listSaves,
  liveSteps,
  needs,
  networkStarts,
  openerUses,
  partnerLeads,
  partnerSearches,
  partners,
  playbooks,
  posts,
  profiles,
  replies,
  sends,
  setup,
  stages,
  threads,
  touches,
  waitingPushes,
  warnings,
} as const;
