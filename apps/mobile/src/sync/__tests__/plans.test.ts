import { DatabaseSync } from 'node:sqlite';

import type { Table } from '@powersync/common';

import {
  COMPANY_PEOPLE_SQL,
  PERSON_CONVERSATIONS_SQL,
  TAGS_OF_SQL,
  TIMELINE_FOR,
} from '@/customers/queries';
import { CALLS_SQL, CONVERSATIONS_SQL, MESSAGES_SQL, NOTES_SQL } from '@/inbox/queries';

import { AppSchema } from '../app-schema';

/**
 * Which way the phone's database goes to answer a screen (the speed audit, Nov 2026).
 *
 * The phone keeps each synced row as JSON in `ps_data__<table>`, shows it through a view named after the table, and
 * indexes the JSON by expression: `workspace` on every table, and the few in `EXTRA_INDEXES`. Its SQLite has no
 * statistics, so between two indexes that both fit it guesses, and it guessed "every row of the business" for a
 * conversation's messages. Nothing fails when it guesses wrong: the screen is only slow, and slower with every month
 * of history.
 *
 * Here the copy is built the way PowerSync builds it, on real SQLite (Node's own), and each query is asked for its
 * plan. A query that reads "this conversation's" or "this customer's" rows must go by that index, never by the
 * business's.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ELSEWHERE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PERSON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/** The phone's copy as PowerSync lays it out: a JSON row per id, a view of its columns, and the schema's indexes. */
function phoneCopy(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const table of AppSchema.tables as Table[]) {
    if (table.localOnly || table.insertOnly) continue;
    const cast = (column: string) => {
      const type = table.columns.find((c) => c.name === column)?.type ?? 'TEXT';
      return `CAST(json_extract(data, '$.${column}') as ${type})`;
    };
    const data = `"ps_data__${table.name}"`;
    db.exec(`CREATE TABLE ${data} (id TEXT PRIMARY KEY NOT NULL, data TEXT) WITHOUT ROWID`);
    db.exec(
      `CREATE VIEW "${table.name}" ("id", ${table.columns.map((c) => `"${c.name}"`).join(', ')})
       AS SELECT id, ${table.columns.map((c) => cast(c.name)).join(', ')} FROM ${data}`,
    );
    for (const index of table.indexes)
      db.exec(
        `CREATE INDEX "ps_data__${table.name}__${index.name}" ON ${data}
         (${index.columns.map((c) => `${cast(c.name)}${c.ascending === false ? ' DESC' : ''}`).join(', ')})`,
      );
  }
  return db;
}

let db: DatabaseSync;
beforeAll(() => {
  db = phoneCopy();
});
afterAll(() => db.close());

type Param = string | number | null;

/** The steps of a query's plan that read `table`. */
function planOf(table: string, sql: string, params: Param[]): string[] {
  const steps = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
  return steps.map((s) => s.detail).filter((d) => d.includes(`ps_data__${table}`));
}

function put(table: string, id: string, row: Record<string, unknown>): void {
  db.prepare(`INSERT INTO "ps_data__${table}" (id, data) VALUES (?, ?)`).run(
    id,
    JSON.stringify(row),
  );
}

/** Goes by the index named, and by no other of the table's. */
function expectIndex(table: string, index: string, sql: string, params: Param[]): void {
  const plan = planOf(table, sql, params);
  expect(plan.join('\n')).toContain(`ps_data__${table}__${index} `);
  expect(plan.filter((step) => /\bSCAN\b/.test(step))).toEqual([]);
  expect(plan.filter((step) => step.includes(`ps_data__${table}__workspace`))).toEqual([]);
}

describe('opening a conversation', () => {
  const lanes = JSON.stringify([CONV]);

  it('reads its messages by the conversation, never every message of the business', () => {
    expectIndex('messages', 'conversation', MESSAGES_SQL, [WS, lanes]);
    // Every lane of a customer ("All lines") too.
    expectIndex('messages', 'conversation', MESSAGES_SQL, [WS, JSON.stringify([CONV, OTHER])]);
  });

  it('reads its calls the same way', () => {
    expectIndex('calls', 'conversation', CALLS_SQL, [WS, lanes]);
  });

  it('still answers with this business’s rows only, oldest first', () => {
    const message = (conversation: string, workspace: string, at: string) => ({
      workspace_id: workspace,
      conversation_id: conversation,
      channel: 'sms',
      direction: 'inbound',
      status: 'received',
      body_text: at,
      occurred_at: at,
    });
    put('messages', 'm2', message(CONV, WS, '2026-11-02T10:00:00.000Z'));
    put('messages', 'm1', message(CONV, WS, '2026-11-01T10:00:00.000Z'));
    put('messages', 'm3', message(OTHER, WS, '2026-11-03T10:00:00.000Z'));
    // Another business kept on this phone: never in this one's thread, whatever its conversation says.
    put('messages', 'm4', message(CONV, ELSEWHERE, '2026-11-04T10:00:00.000Z'));
    const ids = (params: Param[]) =>
      (db.prepare(MESSAGES_SQL).all(...params) as { id: string }[]).map((m) => m.id);
    expect(ids([WS, lanes])).toEqual(['m1', 'm2']);
    expect(ids([WS, JSON.stringify([CONV, OTHER])])).toEqual(['m1', 'm2', 'm3']);
    expect(ids([ELSEWHERE, lanes])).toEqual(['m4']);

    const call = (workspace: string, at: string) => ({
      workspace_id: workspace,
      conversation_id: CONV,
      direction: 'inbound',
      status: 'completed',
      started_at: at,
    });
    put('calls', 'k2', call(WS, '2026-11-02T09:00:00.000Z'));
    put('calls', 'k1', call(WS, '2026-11-01T09:00:00.000Z'));
    put('calls', 'k3', call(ELSEWHERE, '2026-11-03T09:00:00.000Z'));
    const calls = db.prepare(CALLS_SQL).all(WS, lanes) as { id: string }[];
    expect(calls.map((k) => k.id)).toEqual(['k1', 'k2']);
  });
});

describe('the inbox list', () => {
  it('finds each row’s last sender, open lead and waiting draft by their own indexes', () => {
    const steps = (table: string) => planOf(table, CONVERSATIONS_SQL, [WS, PERSON]).join('\n');
    expect(steps('messages')).toContain('ps_data__messages__conversation ');
    expect(steps('leads')).toContain('ps_data__leads__person ');
    expect(steps('ai_teammate_drafts')).toContain('ps_data__ai_teammate_drafts__conversation ');
    for (const table of ['messages', 'leads', 'ai_teammate_drafts'])
      expect(steps(table)).not.toMatch(/\bSCAN\b|__workspace /);
  });
});

describe('a customer’s page', () => {
  it('reads their timeline by the customer, newest first, with no sorting left to do', () => {
    const sql = TIMELINE_FOR('person_id');
    expectIndex('activities', 'person', sql, [WS, PERSON]);
    const all = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(WS, PERSON) as { detail: string }[];
    expect(all.filter((step) => step.detail.includes('TEMP B-TREE'))).toEqual([]);
  });

  it('reads a thread’s notes about them by the customer', () => {
    expectIndex('activities', 'person', NOTES_SQL, [WS, PERSON]);
  });

  it('reads their conversations by the customer', () => {
    expectIndex('conversations', 'person', PERSON_CONVERSATIONS_SQL, [WS, PERSON]);
  });

  it('reads a company’s people by the company', () => {
    expectIndex('people', 'company', COMPANY_PEOPLE_SQL, [PERSON]);
  });

  it('reads one customer’s tags by the customer, never every tag every record wears', () => {
    expectIndex('record_tags', 'record', TAGS_OF_SQL, [WS, PERSON]);
    put('tags', 't-vip', { workspace_id: WS, name: 'VIP', color: 'amber' });
    put('tags', 't-new', { workspace_id: WS, name: 'New', color: 'green' });
    const worn = (workspace: string, tag: string, record: string) => ({
      workspace_id: workspace,
      tag_id: tag,
      record_type: 'person',
      record_id: record,
    });
    put('record_tags', 'rt1', worn(WS, 't-vip', PERSON));
    put('record_tags', 'rt2', worn(WS, 't-new', PERSON));
    put('record_tags', 'rt3', worn(WS, 't-vip', OTHER));
    // Another business kept on this phone: never among this one's, whatever its record says.
    put('record_tags', 'rt4', worn(ELSEWHERE, 't-vip', PERSON));
    const names = (workspace: string, record: string) =>
      (db.prepare(TAGS_OF_SQL).all(workspace, record) as { name: string }[]).map((t) => t.name);
    expect(names(WS, PERSON)).toEqual(['New', 'VIP']);
    expect(names(WS, OTHER)).toEqual(['VIP']);
    // Nobody chosen yet (a conversation with no customer): asked with no id, it finds nothing.
    expect(names(WS, '')).toEqual([]);
  });

  it('leaves a company’s timeline going by the business, which has an index, and not by every row on the phone', () => {
    const plan = planOf('activities', TIMELINE_FOR('company_id'), [WS, PERSON]).join('\n');
    expect(plan).toContain('ps_data__activities__workspace ');
    expect(plan).not.toMatch(/\bSCAN\b/);
  });

  it('still answers with this business’s rows only', () => {
    const activity = (workspace: string, at: string, kind = 'note') => ({
      workspace_id: workspace,
      person_id: PERSON,
      kind,
      body: at,
      occurred_at: at,
      created_at: at,
    });
    put('activities', 'a1', activity(WS, '2026-11-01T10:00:00.000Z'));
    put('activities', 'a2', activity(WS, '2026-11-02T10:00:00.000Z', 'call'));
    put('activities', 'a3', activity(WS, '2026-11-03T10:00:00.000Z'));
    put('activities', 'a4', activity(ELSEWHERE, '2026-11-04T10:00:00.000Z'));
    const ids = (sql: string) =>
      (db.prepare(sql).all(WS, PERSON) as { id: string }[]).map((row) => row.id);
    expect(ids(TIMELINE_FOR('person_id'))).toEqual(['a3', 'a2', 'a1']);
    expect(ids(NOTES_SQL)).toEqual(['a1', 'a3']);

    const conversation = (workspace: string, at: string) => ({
      workspace_id: workspace,
      person_id: PERSON,
      channel: 'sms',
      status: 'open',
      last_message_at: at,
    });
    put('conversations', 'c1', conversation(WS, '2026-11-01T10:00:00.000Z'));
    put('conversations', 'c2', conversation(WS, '2026-11-02T10:00:00.000Z'));
    put('conversations', 'c3', conversation(ELSEWHERE, '2026-11-03T10:00:00.000Z'));
    expect(ids(PERSON_CONVERSATIONS_SQL)).toEqual(['c2', 'c1']);
  });
});
