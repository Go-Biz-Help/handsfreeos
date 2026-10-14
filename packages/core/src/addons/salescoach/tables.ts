/**
 * Sales Coach's own tables, in its schema `addon_salescoach` (supabase/migrations/20261027003600): the Drizzle mirror
 * its server code reads and writes through. Server-only. test/addons/salescoach.test.ts holds the mirror to the
 * live columns.
 */
import { boolean, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { calls as coreCalls, people, users, workspaces } from '@hfos/db/schema';
import type { AfterCall, CallLine, CardKind } from './coach';
import type { PlaybookDetails, PlaybookKind } from './playbooks';

export const addonSalescoach = pgSchema('addon_salescoach');

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const workspaceRef = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: 'set null' });

export type CoachedCallState = 'live' | 'writing' | 'done' | 'failed' | 'stopped';

/** The scripts, objection answers and talking points the coach says from. */
export const playbooks = addonSalescoach.table(
  'playbooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    name: text('name').notNull(),
    kind: text('kind').notNull().$type<PlaybookKind>().default('any'),
    isDefault: boolean('is_default').notNull().default(false),
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

/** The add-on's notes on one of core's calls: what was said, and the write-up after. */
export const coachedCalls = addonSalescoach.table(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    callId: uuid('call_id')
      .notNull()
      .references(() => coreCalls.id, { onDelete: 'cascade' }),
    userId: userRef('user_id'),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    playbookId: uuid('playbook_id'),
    playbookName: text('playbook_name'),
    state: text('state').notNull().$type<CoachedCallState>().default('live'),
    step: text('step'),
    lines: jsonb('lines').notNull().$type<CallLine[]>().default([]),
    result: jsonb('result').$type<AfterCall>(),
    failure: text('failure'),
    startedAt: ts('started_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.callId)],
);

/** What the coach showed the rep during a call. */
export const cards = addonSalescoach.table(
  'cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    coachedCallId: uuid('coached_call_id').notNull(),
    userId: userRef('user_id'),
    kind: text('kind').notNull().$type<CardKind>(),
    title: text('title').notNull(),
    say: text('say').notNull(),
    heard: text('heard').notNull().default(''),
    objectionId: text('objection_id'),
    dismissedAt: ts('dismissed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id)],
);

export const SALESCOACH_TABLES = { playbooks, calls: coachedCalls, cards } as const;
