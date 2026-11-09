/**
 * AI Social Media Content Creator's own tables, in its schema `addon_socialcontent`
 * (supabase/migrations/20261027023800): the Drizzle mirror its server code reads and writes through. Server-only.
 * test/addons/socialcontent-ops.test.ts holds the mirror to the live columns.
 */
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users, workspaces } from '@hfos/db/schema';
import type { ContentNetwork } from './networks';
import type {
  CreatorState,
  IdeaState,
  NicheState,
  PlaybookSection,
  PostKind,
  PostNotes,
  PostWatched,
  Searches,
  WorkAskedFor,
  WorkKind,
  WorkProgress,
  WorkState,
} from './shapes';
import type { StandoutOn, StandoutWait } from './standouts';

export const addonSocialcontent = pgSchema('addon_socialcontent');

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const workspaceRef = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: 'set null' });

/** One row per business: the networks it studies, and whose computer reads them. */
export const settings = addonSocialcontent.table('settings', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  networks: text('networks').array().notNull().$type<ContentNetwork[]>().default(['instagram']),
  readerUserId: userRef('reader_user_id'),
  watchVideos: boolean('watch_videos').notNull().default(false),
  readerSeenAt: ts('reader_seen_at'),
  readerVersion: text('reader_version'),
  updatedBy: userRef('updated_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** What the business's content is about, and niches like it. */
export const niches = addonSocialcontent.table(
  'niches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    name: text('name').notNull(),
    own: boolean('own').notNull().default(false),
    state: text('state').notNull().$type<NicheState>().default('suggested'),
    why: text('why'),
    searches: jsonb('searches').notNull().$type<Searches>().default({}),
    addedBy: userRef('added_by'),
    decidedBy: userRef('decided_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id)],
);

/** People outside the business whose posts it studies. */
export const creators = addonSocialcontent.table(
  'creators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    network: text('network').notNull().$type<ContentNetwork>(),
    handle: text('handle').notNull(),
    name: text('name'),
    link: text('link').notNull(),
    bio: text('bio'),
    followers: integer('followers'),
    lastPostAt: ts('last_post_at'),
    nicheId: uuid('niche_id'),
    state: text('state').notNull().$type<CreatorState>().default('suggested'),
    foundBy: text('found_by').notNull().$type<'search' | 'person'>(),
    addedBy: userRef('added_by'),
    decidedBy: userRef('decided_by'),
    why: text('why'),
    profileReadAt: ts('profile_read_at'),
    postsReadAt: ts('posts_read_at'),
    postsCount: integer('posts_count').notNull().default(0),
    standoutsCount: integer('standouts_count').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.network, t.handle)],
);

/** A studied creator's posts, with their numbers and whether each stands out. */
export const posts = addonSocialcontent.table(
  'posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    creatorId: uuid('creator_id').notNull(),
    postKey: text('post_key').notNull(),
    link: text('link').notNull(),
    postedAt: ts('posted_at').notNull(),
    kind: text('kind').notNull().$type<PostKind>().default('other'),
    caption: text('caption'),
    views: integer('views'),
    likes: integer('likes'),
    comments: integer('comments'),
    shares: integer('shares'),
    seconds: integer('seconds'),
    pinned: boolean('pinned').notNull().default(false),
    viewsTimes: numeric('views_times', { precision: 8, scale: 2, mode: 'number' }),
    engagementTimes: numeric('engagement_times', { precision: 8, scale: 2, mode: 'number' }),
    standout: boolean('standout').notNull().default(false),
    standoutOn: text('standout_on').$type<StandoutOn>(),
    waiting: text('waiting').$type<StandoutWait>(),
    notes: jsonb('notes').$type<PostNotes>(),
    notedAt: ts('noted_at'),
    watched: jsonb('watched').$type<PostWatched>(),
    watchedAt: ts('watched_at'),
    readAt: ts('read_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.creatorId, t.postKey)],
);

/** What the business's reading computer is asked to do. */
export const work = addonSocialcontent.table(
  'work',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    kind: text('kind').notNull().$type<WorkKind>(),
    network: text('network').notNull().$type<ContentNetwork>(),
    nicheId: uuid('niche_id'),
    creatorId: uuid('creator_id'),
    postId: uuid('post_id'),
    since: ts('since'),
    state: text('state').notNull().$type<WorkState>().default('waiting'),
    askedFor: text('asked_for').notNull().$type<WorkAskedFor>(),
    askedBy: userRef('asked_by'),
    takenBy: userRef('taken_by'),
    takenAt: ts('taken_at'),
    finishedAt: ts('finished_at'),
    failure: text('failure'),
    doneCount: integer('done_count'),
    progress: jsonb('progress').$type<WorkProgress>(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id)],
);

/** One per business: the patterns across its noted standouts. */
export const playbook = addonSocialcontent.table('playbook', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  summary: text('summary'),
  sections: jsonb('sections').notNull().$type<PlaybookSection[]>().default([]),
  standouts: integer('standouts').notNull().default(0),
  writtenAt: ts('written_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Posts the AI suggests the business makes. */
export const ideas = addonSocialcontent.table(
  'ideas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    title: text('title').notNull(),
    hook: text('hook'),
    format: text('format'),
    network: text('network').$type<ContentNetwork>(),
    outline: text('outline'),
    why: text('why'),
    basedOn: uuid('based_on').array().notNull().default([]),
    state: text('state').notNull().$type<IdeaState>().default('new'),
    decidedBy: userRef('decided_by'),
    decidedAt: ts('decided_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id)],
);

export const SOCIALCONTENT_TABLES = {
  settings,
  niches,
  creators,
  posts,
  work,
  playbook,
  ideas,
} as const;
