/**
 * Records kept to the people on them (Real Estate step 4). A fixture add-on's private kind of record (a deal), and
 * who sees one and everything hanging off it: its main person, someone on its team, an owner, an admin, a member not
 * on it, a member given the kind's See-every permission, HandsFreeOS support with and without being let in, and a
 * stranger. Across the record itself, its timeline, tasks, files and their stored objects, Home cards,
 * relationships, and an add-on table that follows it. Then who may change who is on it.
 */
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';
import { readSyncConfig } from './sync-config';

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join('');
const ADDON = `fx${letters(8)}`;
const SEE_ALL = `${ADDON}.all_deals`;

let owner: TestUser;
let admin: TestUser;
let agent: TestUser;
let teammate: TestUser;
let member: TestUser;
let broker: TestUser;
let support: TestUser;
let stranger: TestUser;
let ws: string;
let org: string;
let kind: string;
let deal: string;
let open: string;
let person: string;
let task: string;
let file: string;
let objectPath: string;

const worker = () => asService({ workspaceId: ws, organizationId: org });

/** Which of these ids the person reads from the table, through RLS. */
async function sees(u: TestUser, table: string, ids: readonly string[]): Promise<string[]> {
  const found = await as(u)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`select id from ${sql.raw(table)} where id = any(array[${sql.join(
        ids.map((i) => sql`${i}::uuid`),
        sql`, `,
      )}])`,
    ),
  );
  return found.map((r) => r.id).sort();
}

const sorted = (...ids: string[]) => [...ids].sort();
/** The id of the one row a statement returned. */
const one = async (found: Promise<{ id: string }[]>): Promise<string> => (await found)[0]!.id;

beforeAll(async () => {
  [owner, admin, agent, teammate, member, broker, support, stranger] = await Promise.all([
    createTestUser('private-owner'),
    createTestUser('private-admin'),
    createTestUser('private-agent'),
    createTestUser('private-teammate'),
    createTestUser('private-member'),
    createTestUser('private-broker'),
    createTestUser('private-support'),
    createTestUser('private-stranger'),
  ]);
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(
    owner,
    'Hill Country',
    'Hill Country Realty',
  ));
  await bootstrapOrganization(stranger, 'Elsewhere', 'Elsewhere Realty');
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: ws, userId: admin.id, role: 'admin' },
    { workspaceId: ws, userId: agent.id, role: 'member' },
    { workspaceId: ws, userId: teammate.id, role: 'member' },
    { workspaceId: ws, userId: member.id, role: 'member' },
    { workspaceId: ws, userId: broker.id, role: 'member' },
  ]);
  await rows(
    dbs.admin.db,
    sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify([
      { key: `${ADDON}.use`, defaultRoles: ['admin', 'member'], requires: [] },
      { key: SEE_ALL, defaultRoles: ['admin'], requires: [`${ADDON}.use`] },
    ])}::jsonb)`,
  );
  // The add-on on, as the commands and the worker leave it.
  await as(owner)((tx) =>
    rows(tx, sql`select * from private.addon_move(${ws}, ${ADDON}, 'installing', '1.0.0', 1, 1)`),
  );
  await worker()((tx) =>
    rows(
      tx,
      sql`update app.addon_installations set state = 'enabled' where workspace_id = ${ws} and addon_id = ${ADDON}`,
    ),
  );
  // The broker is a member given See every deal, per person.
  await rows(
    dbs.admin.db,
    sql`insert into app.member_permission_overrides (workspace_id, user_id, permission, allowed)
        values (${ws}, ${broker.id}, ${SEE_ALL}, true)`,
  );
  await rows(
    dbs.admin.db,
    sql`insert into platform.staff (user_id, role, status) values (${support.id}, 'agent', 'active')`,
  );

  // The worker seeds the private kind, as reconcile does.
  kind = await one(
    worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission,
            kept_to_team, see_all_permission)
          values (${ws}, ${`${ADDON}_deal`}, 'Deal', 'Deals', ${ADDON}, ${`${ADDON}.use`}, true, ${SEE_ALL})
          returning id`,
      ),
    ),
  );
  // The agent opens a deal and puts a teammate on it; everything hangs off it.
  deal = await one(
    as(agent)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_records (workspace_id, type_id, name, created_by, team_user_ids)
          values (${ws}, ${kind}, 'Smith purchase', ${agent.id}, array[${teammate.id}]::uuid[])
          returning id`,
      ),
    ),
  );
  person = await one(
    rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Ann', 'Smith') returning id`,
    ),
  );
  open = await one(
    as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_record_types (workspace_id, key, singular, plural, created_by)
          values (${ws}, 'pet', 'Pet', 'Pets', ${owner.id}) returning id`,
      ),
    ),
  );
  open = await one(
    as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_records (workspace_id, type_id, name, created_by)
          values (${ws}, ${open}, 'Biscuit', ${owner.id}) returning id`,
      ),
    ),
  );
  task = await one(
    as(agent)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.tasks (workspace_id, title, custom_record_id, created_by, assignee_user_id)
          values (${ws}, 'Order the appraisal', ${deal}, ${agent.id}, ${teammate.id}) returning id`,
      ),
    ),
  );
  objectPath = `${ws}/custom_record/${deal}/${letters(6)}/contract.pdf`;
  file = await one(
    as(agent)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, status, created_by)
          values (${ws}, 'custom_record', ${deal}, ${objectPath}, 'contract.pdf', 'pending', ${agent.id})
          returning id`,
      ),
    ),
  );
  await worker()((tx) => rows(tx, sql`update app.files set status = 'ready' where id = ${file}`));
});
afterAll(closeAll);

describe('a private record', () => {
  it('is its maker’s, and seen only by the people on it and those who see every one', async () => {
    const [row] = await rows<{ owner_user_id: string; kept_to_team: boolean }>(
      dbs.admin.db,
      sql`select owner_user_id, kept_to_team from app.custom_records where id = ${deal}`,
    );
    expect(row).toEqual({ owner_user_id: agent.id, kept_to_team: true });
    for (const u of [agent, teammate, owner, admin, broker])
      expect(await sees(u, 'app.custom_records', [deal, open])).toEqual(sorted(deal, open));
    expect(await sees(member, 'app.custom_records', [deal, open])).toEqual([open]);
    expect(await sees(stranger, 'app.custom_records', [deal, open])).toEqual([]);
  });

  it('takes its timeline, tasks, files and stored objects with it', async () => {
    const [line] = await rows<{ id: string; sealed: boolean }>(
      dbs.admin.db,
      sql`select id, sealed from app.activities where custom_record_id = ${deal} limit 1`,
    );
    const lineIds = line ? [line.id] : [];
    await worker()((tx) =>
      rows(
        tx,
        sql`insert into app.activities (workspace_id, kind, subtype, custom_record_id, person_id, actor_type, body)
            values (${ws}, 'system', 'related', ${deal}, ${person}, 'system', 'Ann Smith is a client')`,
      ),
    );
    const both = await rows<{ id: string; sealed: boolean }>(
      dbs.admin.db,
      sql`select id, sealed from app.activities where custom_record_id = ${deal} and person_id = ${person}`,
    );
    expect(both.every((b) => b.sealed)).toBe(true);
    const lines = [...lineIds, ...both.map((b) => b.id)];

    for (const u of [agent, teammate, owner])
      expect(await sees(u, 'app.activities', lines)).toEqual(sorted(...lines));
    expect(await sees(member, 'app.activities', lines)).toEqual([]);
    expect(await sees(member, 'app.tasks', [task])).toEqual([]);
    expect(await sees(teammate, 'app.tasks', [task])).toEqual([task]);
    expect(await sees(member, 'app.files', [file])).toEqual([]);
    expect(await sees(agent, 'app.files', [file])).toEqual([file]);

    const storage = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ ok: boolean }>(
          tx,
          sql`select private.storage_read_allowed('attachments', ${objectPath}) as ok`,
        ),
      ).then((r) => r[0]!.ok);
    expect(await storage(agent)).toBe(true);
    expect(await storage(member)).toBe(false);
  });

  it('keeps a Home card about its task to the people on it', async () => {
    const item = await one(
      worker()((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, title, fingerprint)
            values (${ws}, 'overdue_task', 'task', ${task}, 'Order the appraisal', ${`t:${task}`}) returning id`,
        ),
      ),
    );
    const [card] = await rows<{ custom_record_id: string; sealed: boolean }>(
      dbs.admin.db,
      sql`select custom_record_id, sealed from app.attention_items where id = ${item}`,
    );
    expect(card).toEqual({ custom_record_id: deal, sealed: true });
    expect(await sees(agent, 'app.attention_items', [item])).toEqual([item]);
    expect(await sees(member, 'app.attention_items', [item])).toEqual([]);
  });

  it('shows a relationship only when both ends can be seen', async () => {
    const type = await one(
      worker()((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.relationship_types (workspace_id, a_end, a_label, b_end, b_record_type_id, b_label,
              addon_id, addon_key)
            values (${ws}, 'person', 'Client', 'custom_record', ${kind}, 'Deal', ${ADDON}, ${`${ADDON}_client`})
            returning id`,
        ),
      ),
    );
    const pair = await one(
      as(agent)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id, created_by)
            values (${ws}, ${type}, ${person}, ${deal}, ${agent.id}) returning id`,
        ),
      ),
    );
    expect(await sees(agent, 'app.relationships', [pair])).toEqual([pair]);
    expect(await sees(member, 'app.relationships', [pair])).toEqual([]);
    const refused = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id, created_by)
              values (${ws}, ${type}, ${person}, ${deal}, ${member.id})`,
        ),
      ),
    );
    expect(refused.code).toBe('42501');
  });

  it('gives its task only to someone on it', async () => {
    const e = await expectPgError(() =>
      as(agent)((tx) =>
        rows(tx, sql`update app.tasks set assignee_user_id = ${member.id} where id = ${task}`),
      ),
    );
    expect(e.detail).toBe('task_assignee_not_on_record');
  });
});

describe('who is on it', () => {
  it('is changed by its main person, or an owner or admin, never by someone else on it', async () => {
    const byTeammate = await expectPgError(() =>
      as(teammate)((tx) =>
        rows(
          tx,
          sql`update app.custom_records set team_user_ids = array[${teammate.id}, ${member.id}]::uuid[]
              where id = ${deal}`,
        ),
      ),
    );
    expect(byTeammate.detail).toBe('record_team_not_yours');
    // The main person can't hand the deal to someone else; an admin can.
    const handOver = await expectPgError(() =>
      as(agent)((tx) =>
        rows(
          tx,
          sql`update app.custom_records set owner_user_id = ${member.id} where id = ${deal}`,
        ),
      ),
    );
    expect(handOver.detail).toBe('record_team_not_yours');
    await as(agent)((tx) =>
      rows(
        tx,
        sql`update app.custom_records set team_user_ids = array[${teammate.id}, ${member.id}]::uuid[]
            where id = ${deal}`,
      ),
    );
    expect(await sees(member, 'app.custom_records', [deal])).toEqual([deal]);
    await as(admin)((tx) =>
      rows(
        tx,
        sql`update app.custom_records set team_user_ids = array[${teammate.id}]::uuid[] where id = ${deal}`,
      ),
    );
    expect(await sees(member, 'app.custom_records', [deal])).toEqual([]);
  });

  it('is only ever people who work in the business', async () => {
    const e = await expectPgError(() =>
      as(agent)((tx) =>
        rows(
          tx,
          sql`update app.custom_records set team_user_ids = array[${teammate.id}, ${stranger.id}]::uuid[]
              where id = ${deal}`,
        ),
      ),
    );
    expect(e.detail).toBe('record_team_outsider');
  });

  it('never changes whether a record is private', async () => {
    const e = await expectPgError(() =>
      worker()((tx) =>
        rows(tx, sql`update app.custom_record_types set kept_to_team = false where id = ${kind}`),
      ),
    );
    expect(e.detail).toBe('private_kind_fixed');
    const person = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.custom_record_types (workspace_id, key, singular, plural, created_by, kept_to_team)
              values (${ws}, 'secret', 'Secret', 'Secrets', ${owner.id}, true)`,
        ),
      ),
    );
    expect(person.code).toBe('42501');
  });
});

describe('HandsFreeOS support', () => {
  it('sees no private record in a look, until someone on it lets them in, and only for as long as that lasts', async () => {
    await rows(
      dbs.admin.db,
      sql`insert into platform.view_as_sessions (staff_user_id, workspace_id, organization_id, reason, expires_at)
          values (${support.id}, ${ws}, ${org}, 'Ticket 2291', now() + interval '1 hour')`,
    );
    expect(await sees(support, 'app.custom_records', [deal, open])).toEqual([open]);
    expect(await sees(support, 'app.tasks', [task])).toEqual([]);

    const request = await one(
      as(support)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`select private.request_support_access(${ws}, 'The closing date looks wrong') as id`,
        ),
      ),
    );
    // Someone not on any private record, and not an owner or admin, can't answer.
    const byMember = await expectPgError(() =>
      as(member)((tx) =>
        rows(tx, sql`select * from private.grant_support_access(${ws}, ${request}::uuid)`),
      ),
    );
    expect(byMember.detail).toBe('support_access_not_yours');

    // The agent lets them in: support now sees what the agent sees, read-only.
    const [grant] = await as(agent)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`select * from private.grant_support_access(${ws}, ${request}::uuid)`,
      ),
    );
    expect(await sees(support, 'app.custom_records', [deal, open])).toEqual(sorted(deal, open));
    expect(await sees(support, 'app.tasks', [task])).toEqual([task]);
    // Read-only: a change reaches nothing.
    const changed = await as(support)((tx) =>
      rows(tx, sql`update app.custom_records set name = 'Changed' where id = ${deal} returning id`),
    );
    expect(changed).toEqual([]);

    // Ended: gone again.
    await as(agent)((tx) =>
      rows(tx, sql`select private.end_support_access(${ws}, ${grant!.id}::uuid)`),
    );
    expect(await sees(support, 'app.custom_records', [deal, open])).toEqual([open]);
  });
});

describe('the phone', () => {
  it('is never sent a sealed row: every stream of what hangs off a record leaves them out', () => {
    const { queries } = readSyncConfig();
    const hanging = queries.filter(
      (q) => !q.cte && ['tasks', 'activities', 'files', 'attention_items'].includes(q.table),
    );
    expect(hanging.length).toBeGreaterThanOrEqual(5);
    for (const q of hanging) expect(q.where, `${q.stream} ${q.table}`).toMatch(/sealed = false/);
    // And nothing sends a private record itself.
    expect(queries.some((q) => q.table === 'custom_records')).toBe(false);
  });

  it('is never sent an add-on’s Home card, nor its alerts (Real Estate step 5)', () => {
    const { queries } = readSyncConfig();
    const cards = queries.filter((q) => !q.cte && q.table === 'attention_items');
    expect(cards.length).toBeGreaterThanOrEqual(2);
    for (const q of cards) expect(q.where, q.stream).toMatch(/kind != 'addon_alert'/);
    expect(queries.some((q) => q.table === 'addon_alerts')).toBe(false);
  });
});
