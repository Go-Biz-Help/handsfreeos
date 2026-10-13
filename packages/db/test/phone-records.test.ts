/**
 * What a phone may keep of an add-on (Real Estate round six, 20261022000100): the keys each person holds, the seals
 * on a private record and everything hanging off it, and the add-on's own rows copied for phones. A fixture add-on
 * with a private kind (a deal) and a table that follows it; an owner, the deal's agent and teammate, a member not on
 * it, a member given See every deal, and a stranger. Every change ends with the mismatch functions empty: the
 * stored keys and seals say what the permissions and records say.
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
  retryDeadlock,
} from './harness';

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join('');
const ADDON = `fx${letters(8)}`;
const USE = `${ADDON}.use`;
const SEE_ALL = `${ADDON}.all_deals`;
const admin$ = dbs.admin.db;

let owner: TestUser;
let agent: TestUser;
let teammate: TestUser;
let member: TestUser;
let broker: TestUser;
let stranger: TestUser;
let ws: string;
let org: string;
let kind: string;
let deal: string;
let task: string;
let thread: string;

const worker = () => asService({ workspaceId: ws, organizationId: org });
const one = async (found: Promise<{ id: string }[]>): Promise<string> => (await found)[0]!.id;
const sortedIds = (...users: TestUser[]) => users.map((u) => u.id).sort();

async function keysOf(u: TestUser): Promise<string[]> {
  const found = await rows<{ k: string }>(
    admin$,
    sql`select kind || ' ' || key as k from app.sync_keys where user_id = ${u.id} and workspace_id = ${ws}`,
  );
  return found.map((r) => r.k).sort();
}

async function inStep(): Promise<void> {
  expect(await rows(admin$, sql`select * from private.sync_key_mismatches(${ws})`)).toEqual([]);
  expect(await rows(admin$, sql`select * from private.sync_seal_mismatches(${ws})`)).toEqual([]);
  expect(await rows(admin$, sql`select * from private.addon_phone_mismatches(${ws})`)).toEqual([]);
}

const setPerPerson = (on: boolean) =>
  rows(
    admin$,
    sql`update app.workspaces
        set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('inbox',
              coalesce(settings -> 'inbox', '{}'::jsonb) || jsonb_build_object('perPerson', ${on}::boolean))
        where id = ${ws}`,
  );

beforeAll(async () => {
  [owner, agent, teammate, member, broker, stranger] = await Promise.all([
    createTestUser('phone-owner'),
    createTestUser('phone-agent'),
    createTestUser('phone-teammate'),
    createTestUser('phone-member'),
    createTestUser('phone-broker'),
    createTestUser('phone-stranger'),
  ]);
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(
    owner,
    'Hill Country',
    'Hill Country Realty',
  ));
  await bootstrapOrganization(stranger, 'Elsewhere', 'Elsewhere Realty');
  await admin$.insert(workspaceMemberships).values([
    { workspaceId: ws, userId: agent.id, role: 'member' },
    { workspaceId: ws, userId: teammate.id, role: 'member' },
    { workspaceId: ws, userId: member.id, role: 'member' },
    { workspaceId: ws, userId: broker.id, role: 'member' },
  ]);
  await rows(
    admin$,
    sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify([
      { key: USE, defaultRoles: ['admin', 'member'], requires: [] },
      { key: SEE_ALL, defaultRoles: ['admin'], requires: [USE] },
    ])}::jsonb)`,
  );
  await as(owner)((tx) =>
    rows(tx, sql`select * from private.addon_move(${ws}, ${ADDON}, 'installing', '1.0.0', 1, 1)`),
  );
  await worker()((tx) =>
    rows(
      tx,
      sql`update app.addon_installations set state = 'enabled' where workspace_id = ${ws} and addon_id = ${ADDON}`,
    ),
  );
  await rows(
    admin$,
    sql`insert into app.member_permission_overrides (workspace_id, user_id, permission, allowed)
        values (${ws}, ${broker.id}, ${SEE_ALL}, true)`,
  );

  // The add-on's own table, as its migration makes it, following a deal; and what phones keep of it.
  await retryDeadlock(() => rows(admin$, sql`select private.create_addon_schema(${ADDON})`));
  await retryDeadlock(() =>
    rows(
      admin$,
      sql.raw(`create table addon_${ADDON}.items (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid not null references app.workspaces (id) on delete cascade,
      deal_id uuid references app.custom_records (id) on delete cascade,
      title text not null,
      private_note text,
      updated_at timestamptz not null default now())`),
    ),
  );
  await retryDeadlock(() =>
    rows(
      admin$,
      sql`select private.addon_table_policies(${`addon_${ADDON}.items`}::regclass, ${USE}, ${USE}, ${USE}, 'deal_id')`,
    ),
  );

  kind = await one(
    worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission,
            kept_to_team, see_all_permission)
          values (${ws}, ${`${ADDON}_deal`}, 'Deal', 'Deals', ${ADDON}, ${USE}, true, ${SEE_ALL})
          returning id`,
      ),
    ),
  );
  deal = await one(
    as(agent)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_records (workspace_id, type_id, name, created_by, team_user_ids)
          values (${ws}, ${kind}, 'Smith purchase', ${agent.id}, array[${teammate.id}]::uuid[]) returning id`,
      ),
    ),
  );
  task = await one(
    as(agent)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.tasks (workspace_id, title, custom_record_id, created_by)
          values (${ws}, 'Order the appraisal', ${deal}, ${agent.id}) returning id`,
      ),
    ),
  );
  const person = await one(
    rows<{ id: string }>(
      admin$,
      sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Ann', 'Smith') returning id`,
    ),
  );
  thread = await one(
    worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, status, custom_record_id)
          values (${ws}, 'portal', ${`portal:${person}:${deal}`}, ${person}, 'open', ${deal}) returning id`,
      ),
    ),
  );
  await worker()((tx) =>
    rows(
      tx,
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
          values (${ws}, ${thread}, 'portal', 'inbound', 'received', 'Is the roof something we should push on?')`,
    ),
  );
});
afterAll(closeAll);

describe('before an add-on asks phones to keep anything', () => {
  it('nobody holds a key and nothing is sealed for phones', async () => {
    expect(await keysOf(owner)).toEqual([]);
    const [r] = await rows<{ seal_scope: string | null; seal_viewer_ids: string[] }>(
      admin$,
      sql`select seal_scope, seal_viewer_ids from app.custom_records where id = ${deal}`,
    );
    expect(r).toEqual({ seal_scope: null, seal_viewer_ids: [] });
    await inStep();
  });
});

describe('once it does', () => {
  beforeAll(async () => {
    await rows(admin$, sql`select private.addon_phone_addon(${ADDON}, ${USE})`);
    await rows(
      admin$,
      sql`select private.addon_phone_table(${`addon_${ADDON}.items`}::regclass, 'deal_id', array['title'], 'all')`,
    );
  });

  it('gives each person keys from what they may do', async () => {
    expect(await keysOf(owner)).toEqual([`all ${ws}:${SEE_ALL}`, `use ${ws}:${USE}`].sort());
    expect(await keysOf(agent)).toEqual([`use ${ws}:${USE}`]);
    expect(await keysOf(member)).toEqual([`use ${ws}:${USE}`]);
    expect(await keysOf(broker)).toEqual([`all ${ws}:${SEE_ALL}`, `use ${ws}:${USE}`].sort());
    expect(await keysOf(stranger)).toEqual([]);
    await inStep();
  });

  it('seals the deal to its people, and its task and portal thread with it', async () => {
    const [r] = await rows<{
      seal_scope: string;
      seal_open: boolean;
      seal_viewer_ids: string[];
      seal_all: string;
    }>(
      admin$,
      sql`select seal_scope, seal_open, seal_viewer_ids, seal_all from app.custom_records where id = ${deal}`,
    );
    expect(r).toEqual({
      seal_scope: `${ws}:${USE}`,
      seal_open: false,
      seal_viewer_ids: sortedIds(agent, teammate),
      seal_all: `${ws}:${SEE_ALL}`,
    });
    const [t] = await rows<{ seal_scope: string; seal_viewer_ids: string[] }>(
      admin$,
      sql`select seal_scope, seal_viewer_ids from app.tasks where id = ${task}`,
    );
    expect(t).toEqual({ seal_scope: `${ws}:${USE}`, seal_viewer_ids: sortedIds(agent, teammate) });
    const msgs = await rows<{ seal_viewer_ids: string[] }>(
      admin$,
      sql`select seal_viewer_ids from app.messages where conversation_id = ${thread}`,
    );
    expect(msgs).toEqual([{ seal_viewer_ids: sortedIds(agent, teammate) }]);
    await inStep();
  });

  it('copies only the declared columns of the add-on’s rows, with the deal’s seals', async () => {
    await worker()((tx) =>
      rows(
        tx,
        sql`insert into ${sql.raw(`addon_${ADDON}.items`)} (workspace_id, deal_id, title, private_note)
            values (${ws}, ${deal}, 'Binder to the lender', 'not for phones')`,
      ),
    );
    const found = await rows<{
      data: Record<string, unknown>;
      seal_viewer_ids: string[];
      seal_all: string;
    }>(
      admin$,
      sql`select data, seal_viewer_ids, seal_all from app.addon_phone_rows where addon_id = ${ADDON}`,
    );
    expect(found).toEqual([
      {
        data: { title: 'Binder to the lender' },
        seal_viewer_ids: sortedIds(agent, teammate),
        seal_all: `${ws}:${SEE_ALL}`,
      },
    ]);
    await inStep();
  });

  it('moves every seal when someone joins the deal', async () => {
    await as(agent)((tx) =>
      rows(
        tx,
        sql`update app.custom_records set team_user_ids = array[${teammate.id}, ${member.id}]::uuid[] where id = ${deal}`,
      ),
    );
    const want = sortedIds(agent, teammate, member);
    const [t] = await rows<{ seal_viewer_ids: string[] }>(
      admin$,
      sql`select seal_viewer_ids from app.tasks where id = ${task}`,
    );
    expect(t!.seal_viewer_ids).toEqual(want);
    const [p] = await rows<{ seal_viewer_ids: string[] }>(
      admin$,
      sql`select seal_viewer_ids from app.addon_phone_rows where addon_id = ${ADDON}`,
    );
    expect(p!.seal_viewer_ids).toEqual(want);
    await inStep();
  });

  it('narrows a portal thread further when the business narrows its inbox', async () => {
    await setPerPerson(true);
    const [c] = await rows<{ seal_viewer_ids: string[]; member_viewer_ids: string[] }>(
      admin$,
      sql`select seal_viewer_ids, member_viewer_ids from app.conversations where id = ${thread}`,
    );
    expect(c!.seal_viewer_ids.every((u) => c!.member_viewer_ids.includes(u))).toBe(true);
    await inStep();
    await setPerPerson(false);
    await inStep();
  });

  it('seals an add-on’s Home card by its permission and audience', async () => {
    const alert = await one(
      worker()((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.addon_alerts (workspace_id, addon_id, key, severity, title, href, permission)
              values (${ws}, ${ADDON}, 'everyone', 'attention', 'For everyone', ${`/a/${ADDON}`}, ${USE}) returning id`,
        ),
      ),
    );
    const card = await one(
      worker()((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, title, fingerprint)
              values (${ws}, 'addon_alert', 'addon_alert', ${alert}, 'For everyone', ${`a:${alert}`}) returning id`,
        ),
      ),
    );
    const [open] = await rows<{ seal_scope: string; seal_open: boolean }>(
      admin$,
      sql`select seal_scope, seal_open from app.attention_items where id = ${card}`,
    );
    expect(open).toEqual({ seal_scope: `${ws}:${USE}`, seal_open: true });
    await worker()((tx) =>
      rows(
        tx,
        sql`update app.addon_alerts set audience_user_ids = array[${broker.id}]::uuid[] where id = ${alert}`,
      ),
    );
    const [aimed] = await rows<{ seal_open: boolean; seal_viewer_ids: string[] }>(
      admin$,
      sql`select seal_open, seal_viewer_ids from app.attention_items where id = ${card}`,
    );
    expect(aimed).toEqual({ seal_open: false, seal_viewer_ids: [broker.id] });
    // Under another of its permissions: exactly who holds that one.
    await worker()((tx) =>
      rows(
        tx,
        sql`update app.addon_alerts set audience_user_ids = '{}', permission = ${SEE_ALL} where id = ${alert}`,
      ),
    );
    const [holders] = await rows<{ seal_open: boolean; seal_viewer_ids: string[] }>(
      admin$,
      sql`select seal_open, seal_viewer_ids from app.attention_items where id = ${card}`,
    );
    expect(holders).toEqual({ seal_open: false, seal_viewer_ids: sortedIds(owner, broker) });
    await inStep();
  });

  it('takes a deal off phones when its add-on narrows the window', async () => {
    await worker()((tx) =>
      rows(tx, sql`select private.record_phone_window(${ws}, ${deal}, false)`),
    );
    const found = await rows<{ sync_window: boolean }>(
      admin$,
      sql`select sync_window from app.addon_phone_rows where addon_id = ${ADDON}`,
    );
    expect(found).toEqual([{ sync_window: false }]);
    await worker()((tx) => rows(tx, sql`select private.record_phone_window(${ws}, ${deal}, true)`));
    await inStep();
  });

  it('drops a deleted row from what phones keep', async () => {
    await worker()((tx) =>
      rows(tx, sql`delete from ${sql.raw(`addon_${ADDON}.items`)} where workspace_id = ${ws}`),
    );
    expect(
      await rows(admin$, sql`select id from app.addon_phone_rows where addon_id = ${ADDON}`),
    ).toEqual([]);
    await inStep();
  });

  it('takes every key away while the add-on is off, and gives them back', async () => {
    await as(owner)((tx) =>
      rows(tx, sql`select * from private.addon_move(${ws}, ${ADDON}, 'disabled', '1.0.0', 1, 1)`),
    );
    for (const u of [owner, agent, member, broker]) expect(await keysOf(u)).toEqual([]);
    await as(owner)((tx) =>
      rows(tx, sql`select * from private.addon_move(${ws}, ${ADDON}, 'enabled', '1.0.0', 1, 1)`),
    );
    expect(await keysOf(agent)).toEqual([`use ${ws}:${USE}`]);
    await inStep();
  });

  it('seals a deal’s links with it, and a link between two deals to the people on both (20261022000700)', async () => {
    const client = await one(
      rows<{ id: string }>(
        admin$,
        sql`insert into app.relationship_types (workspace_id, a_end, a_label, b_end, b_record_type_id, b_label,
              addon_id, addon_key)
            values (${ws}, 'person', 'Client', 'custom_record', ${kind}, 'Deals', ${ADDON}, ${`${ADDON}_client`})
            returning id`,
      ),
    );
    const linked = await one(
      rows<{ id: string }>(
        admin$,
        sql`insert into app.relationship_types (workspace_id, a_end, a_record_type_id, a_label, b_end,
              b_record_type_id, b_label, addon_id, addon_key)
            values (${ws}, 'custom_record', ${kind}, 'Sale', 'custom_record', ${kind}, 'Purchase', ${ADDON},
              ${`${ADDON}_linked`})
            returning id`,
      ),
    );
    const [kindSeal] = await rows<{ seal_scope: string }>(
      admin$,
      sql`select seal_scope from app.relationship_types where id = ${client}`,
    );
    expect(kindSeal!.seal_scope).toBe(`${ws}:${USE}`);
    const person = await one(
      rows<{ id: string }>(
        admin$,
        sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Ben', 'Smith') returning id`,
      ),
    );
    // The broker's own sale, with only the agent on it beside them.
    const sale = await one(
      as(broker)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.custom_records (workspace_id, type_id, name, created_by, team_user_ids)
              values (${ws}, ${kind}, 'Smith sale', ${broker.id}, array[${agent.id}]::uuid[]) returning id`,
        ),
      ),
    );
    const toClient = await one(
      rows<{ id: string }>(
        admin$,
        sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id)
            values (${ws}, ${client}, ${person}, ${deal}) returning id`,
      ),
    );
    const between = await one(
      rows<{ id: string }>(
        admin$,
        sql`insert into app.relationships (workspace_id, type_id, a_custom_record_id, b_custom_record_id)
            values (${ws}, ${linked}, ${sale}, ${deal}) returning id`,
      ),
    );
    const seals = (id: string) =>
      rows<{
        seal_open: boolean;
        seal_viewer_ids: string[];
        seal_all: string | null;
        sync_window: boolean;
      }>(
        admin$,
        sql`select seal_open, seal_viewer_ids, seal_all, sync_window from app.relationships where id = ${id}`,
      ).then((r) => r[0]!);
    const team = (
      await rows<{ ids: string[] }>(
        admin$,
        sql`select seal_viewer_ids as ids from app.custom_records where id = ${deal}`,
      )
    )[0]!.ids;
    expect(await seals(toClient)).toEqual({
      seal_open: false,
      seal_viewer_ids: team,
      seal_all: `${ws}:${SEE_ALL}`,
      sync_window: true,
    });
    // Only the agent is on both deals.
    expect(await seals(between)).toMatchObject({
      seal_viewer_ids: [agent.id],
      seal_all: `${ws}:${SEE_ALL}`,
    });
    await inStep();

    // The deal's team and window move; its links follow.
    await as(agent)((tx) =>
      rows(tx, sql`update app.custom_records set team_user_ids = '{}' where id = ${deal}`),
    );
    expect((await seals(toClient)).seal_viewer_ids).toEqual([agent.id]);
    await worker()((tx) =>
      rows(tx, sql`select private.record_phone_window(${ws}, ${deal}, false)`),
    );
    expect((await seals(toClient)).sync_window).toBe(false);
    expect((await seals(between)).sync_window).toBe(false);
    await worker()((tx) => rows(tx, sql`select private.record_phone_window(${ws}, ${deal}, true)`));
    await inStep();
  });

  it('keeps a person’s own rows to their phone alone, and only those it keeps (20261027001800)', async () => {
    const notes = `addon_${ADDON}.notes`;
    await retryDeadlock(() =>
      rows(
        admin$,
        sql.raw(`create table ${notes} (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references app.workspaces (id) on delete cascade,
        user_id uuid,
        state text not null,
        body text not null,
        updated_at timestamptz not null default now())`),
      ),
    );
    await retryDeadlock(() =>
      rows(
        admin$,
        sql`select private.addon_table_policies(${notes}::regclass, ${USE}, ${USE}, ${USE}, null)`,
      ),
    );
    const note = (who: TestUser | null, state: string, body: string) =>
      one(
        rows<{ id: string }>(
          admin$,
          sql.raw(`insert into ${notes} (workspace_id, user_id, state, body)
            values ('${ws}', ${who ? `'${who.id}'` : 'null'}, '${state}', '${body}') returning id`),
        ),
      );
    const agents = await note(agent, 'waiting', 'Call the lender');
    const owners = await note(owner, 'waiting', 'Sign the listing');
    const done = await note(agent, 'done', 'Order the appraisal');
    const nobodys = await note(null, 'waiting', 'Nobody’s');

    // No row of a person's own is ever written open to the business, not even for a moment on the first copy.
    const guard = `fx_no_open_${letters(8)}`;
    await retryDeadlock(() =>
      rows(
        admin$,
        sql.raw(`create function public.${guard}() returns trigger language plpgsql as $f$
        begin
          if new.addon_id = '${ADDON}' and new.source = 'notes' and new.seal_open then
            raise exception 'a person''s own row was written open';
          end if;
          return new;
        end $f$`),
      ),
    );
    await retryDeadlock(() =>
      rows(
        admin$,
        sql.raw(`create trigger ${guard} after insert or update on app.addon_phone_rows
        for each row execute function public.${guard}()`),
      ),
    );
    try {
      await rows(
        admin$,
        sql`select private.addon_phone_own_table(${notes}::regclass, 'user_id',
              array['user_id', 'state', 'body'], 'state', array['waiting'])`,
      );
      const kept = () =>
        rows<{ id: string; seal_open: boolean; seal_viewer_ids: string[]; record_id: null }>(
          admin$,
          sql`select id, seal_open, seal_viewer_ids, record_id from app.addon_phone_rows
              where workspace_id = ${ws} and addon_id = ${ADDON} and source = 'notes' order by id`,
        );
      expect(await kept()).toEqual(
        [
          { id: `notes:${agents}`, seal_open: false, seal_viewer_ids: [agent.id], record_id: null },
          { id: `notes:${owners}`, seal_open: false, seal_viewer_ids: [owner.id], record_id: null },
        ].sort((a, b) => (a.id < b.id ? -1 : 1)),
      );
      // Registering it again the usual way keeps whose each is and what it keeps.
      await rows(
        admin$,
        sql`select private.addon_phone_table(${notes}::regclass, null, array['user_id', 'state', 'body'])`,
      );
      const [registered] = await rows(
        admin$,
        sql`select owner_column, keep_column, keep_values from app.addon_phone_tables
            where addon_id = ${ADDON} and source = 'notes'`,
      );
      expect(registered).toEqual({
        owner_column: 'user_id',
        keep_column: 'state',
        keep_values: ['waiting'],
      });
      expect((await kept()).map((r) => r.id).sort()).toEqual(
        [`notes:${agents}`, `notes:${owners}`].sort(),
      );
      expect((await kept()).map((r) => r.id)).not.toContain(`notes:${done}`);
      expect((await kept()).map((r) => r.id)).not.toContain(`notes:${nobodys}`);

      // Row security: each reads their own, the owner of the business included, and nobody another's.
      const read = (u: TestUser) =>
        as(u)((tx) =>
          rows<{ id: string }>(
            tx,
            sql`select id from app.addon_phone_rows where workspace_id = ${ws} and source = 'notes'`,
          ),
        );
      expect((await read(agent)).map((r) => r.id)).toEqual([`notes:${agents}`]);
      expect((await read(owner)).map((r) => r.id)).toEqual([`notes:${owners}`]);
      expect(await read(member)).toEqual([]);

      // Done, it leaves; waiting again, it's back; given to someone else, it goes to them.
      await rows(admin$, sql.raw(`update ${notes} set state = 'done' where id = '${agents}'`));
      expect((await kept()).map((r) => r.id)).toEqual([`notes:${owners}`]);
      await rows(admin$, sql.raw(`update ${notes} set state = 'waiting' where id = '${agents}'`));
      await rows(
        admin$,
        sql.raw(`update ${notes} set user_id = '${member.id}' where id = '${agents}'`),
      );
      expect((await kept()).find((r) => r.id === `notes:${agents}`)?.seal_viewer_ids).toEqual([
        member.id,
      ]);
      await inStep();
    } finally {
      await retryDeadlock(() =>
        rows(admin$, sql.raw(`drop trigger ${guard} on app.addon_phone_rows`)),
      );
      await retryDeadlock(() => rows(admin$, sql.raw(`drop function public.${guard}()`)));
    }
  });

  it('lets nobody signed in run the helpers that write or list phone rows (20261027001800)', async () => {
    const forged = JSON.stringify([
      {
        id: crypto.randomUUID(),
        workspace_id: ws,
        user_id: agent.id,
        state: 'waiting',
        body: 'forged',
      },
    ]);
    const calls = [
      sql`select private.addon_phone_upsert(${ADDON}, 'notes', null, 'team', ${forged}::jsonb)`,
      sql`select * from private.addon_phone_own_seal(${ws}, ${ADDON}, ${agent.id})`,
      sql`select * from private.addon_phone_seal(${ws}, ${ADDON}, ${deal}, 'team')`,
      sql`select private.addon_phone_reseal(${deal})`,
      sql`select private.addon_phone_settings_row(${ws}, ${ADDON})`,
      sql`select * from private.addon_phone_table_mismatches(${ws})`,
      sql`select * from private.addon_phone_mismatches(${ws})`,
      sql`select private.addon_phone_kept(t, '{}'::jsonb) from app.addon_phone_tables t limit 1`,
    ];
    for (const who of [stranger, agent, owner]) {
      for (const call of calls) {
        const refused = await expectPgError(() => as(who)((tx) => rows(tx, call)));
        expect(refused.code).toBe('42501');
      }
    }
    await inStep();
  });

  it('keeps only the settings an add-on names, open to its key (20261022000800)', async () => {
    await worker()((tx) =>
      rows(
        tx,
        sql`update app.addon_installations
            set settings = '{"closedDays": {"2026-12-24": "Christmas Eve"}, "alertEmail": "broker@hfos.test"}'::jsonb
            where workspace_id = ${ws} and addon_id = ${ADDON}`,
      ),
    );
    const row = () =>
      rows<{ data: unknown; seal_scope: string; seal_open: boolean }>(
        admin$,
        sql`select data, seal_scope, seal_open from app.addon_phone_rows
            where id = ${`_settings:${ADDON}:${ws}`}`,
      );
    expect(await row()).toEqual([]);
    await rows(admin$, sql`select private.addon_phone_settings(${ADDON}, array['closedDays'])`);
    expect(await row()).toEqual([
      {
        data: { closedDays: { '2026-12-24': 'Christmas Eve' } },
        seal_scope: `${ws}:${USE}`,
        seal_open: true,
      },
    ]);
    await worker()((tx) =>
      rows(
        tx,
        sql`update app.addon_installations set settings = settings || '{"closedDays": {}}'::jsonb
            where workspace_id = ${ws} and addon_id = ${ADDON}`,
      ),
    );
    expect((await row())[0]!.data).toEqual({ closedDays: {} });
    await inStep();
    const refused = await expectPgError(() =>
      rows(admin$, sql`select private.addon_phone_settings(${ADDON}, array['apiToken'])`),
    );
    expect(refused.message).toContain('looks like a secret');
  });
});
