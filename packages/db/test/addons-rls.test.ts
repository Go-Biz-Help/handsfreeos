/**
 * Add-ons in the database itself (0108): what a business has and who may change it, an add-on's permissions
 * existing only while it runs, HandsFreeOS switching one off everywhere, the kinds of records an add-on manages
 * (hidden while it's off), its usage, its own tables getting every tenant rule from one call, and deleting its
 * data for good — keeping names and history lines, and proving nothing is left.
 *
 * Fixture add-on ids start with `fx` (never a real add-on's). The ones whose effects are global (a staff override,
 * a schema of its own) get a fresh id per run, so runs sharing the local database never see each other.
 */
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql, type Tx } from '../src/client';
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

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let outsider: TestUser;
let staffAdmin: TestUser;
let wsA: string;
let orgA: string;
let wsB: string;
let orgB: string;

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join('');
/** A fresh fixture add-on id: two letters of `fx`, then random letters. */
const freshId = () => `fx${letters(8)}`;

const worker = (ws: string, org: string) => asService({ workspaceId: ws, organizationId: org });
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};

const FXPROP_PERMISSIONS = [
  { key: 'fxprop.read', defaultRoles: ['admin', 'member'], requires: [] },
  { key: 'fxprop.write', defaultRoles: ['admin', 'member'], requires: ['fxprop.read'] },
];
const register = (addon: string, permissions: unknown[]) =>
  rows(
    dbs.admin.db,
    sql`select private.register_addon_permissions(${addon}, ${JSON.stringify(permissions)}::jsonb)`,
  );

/** A person's move, through the one door people have. */
const move = (
  u: TestUser,
  ws: string,
  addon: string,
  to: string,
  version = '1.0.0',
  dataVersion = 1,
) =>
  as(u)((tx) =>
    rows<{ state: string; generation: number; previous_state: string | null }>(
      tx,
      sql`select * from private.addon_move(${ws}, ${addon}, ${to}, ${version}, ${dataVersion}, 1)`,
    ),
  ).then((r) => r[0]!);

/** The worker finishing a move that takes time. */
const complete = (ws: string, org: string, addon: string, to: string) =>
  worker(
    ws,
    org,
  )((tx) =>
    rows(
      tx,
      sql`update app.addon_installations set state = ${to} where workspace_id = ${ws} and addon_id = ${addon}`,
    ),
  );

const permissionsOf = (u: TestUser, ws: string) =>
  as(u)((tx) => rows<{ p: string[] }>(tx, sql`select private.my_permissions(${ws}) as p`)).then(
    (r) => r[0]!.p,
  );

/** Installed and on, the way the commands and the worker together leave it. */
async function turnOn(ws: string, org: string, addon: string) {
  await move(owner, ws, addon, 'installing');
  await complete(ws, org, addon, 'enabled');
}

beforeAll(async () => {
  [owner, admin, member, outsider, staffAdmin] = await Promise.all([
    createTestUser('addon-owner'),
    createTestUser('addon-admin'),
    createTestUser('addon-member'),
    createTestUser('addon-outsider'),
    createTestUser('addon-staff'),
  ]);
  const a = await bootstrapOrganization(owner, 'Add-ons Org A', 'Add-ons A');
  wsA = a.wsId;
  orgA = a.orgId;
  const b = await bootstrapOrganization(outsider, 'Add-ons Org B', 'Add-ons B');
  wsB = b.wsId;
  orgB = b.orgId;
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: wsA, userId: admin.id, role: 'admin' },
    { workspaceId: wsA, userId: member.id, role: 'member' },
  ]);
  await rows(
    dbs.admin.db,
    sql`insert into platform.staff (user_id, role, status) values (${staffAdmin.id}, 'admin', 'active')`,
  );
  await register('fxprop', FXPROP_PERMISSIONS);
});
afterAll(closeAll);

describe('what a business has, and who may change it', () => {
  it('people see their own business’s add-ons and never another’s, and never write them directly', async () => {
    const addon = freshId();
    await turnOn(wsA, orgA, addon);
    const seen = (u: TestUser, ws: string) =>
      as(u)((tx) =>
        rows(tx, sql`select addon_id from app.addon_installations where workspace_id = ${ws}`),
      );
    expect((await seen(member, wsA)).length).toBeGreaterThan(0);
    expect(await seen(outsider, wsA)).toEqual([]);
    expect(
      (
        await failure(() =>
          as(owner)((tx) =>
            rows(
              tx,
              sql`update app.addon_installations set state = 'disabled' where workspace_id = ${wsA}`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('tells nobody outside a business what it runs, even one who sets the worker’s scope themselves', async () => {
    const addon = freshId();
    await turnOn(wsA, orgA, addon);
    const ask = (u: TestUser, spoof: boolean) =>
      as(u)(async (tx) => {
        if (spoof)
          await tx.execute(sql`select set_config('app.system_scope.workspace_id', ${wsA}, true)`);
        const [row] = await rows<{ live: string[]; inUse: boolean }>(
          tx,
          sql`select private.active_addons(${wsA}) as live,
                private.addon_in_use(${wsA}, ${addon}, false) as "inUse"`,
        );
        return row!;
      });
    expect(await ask(member, false)).toMatchObject({ inUse: true });
    expect((await ask(member, false)).live).toContain(addon);
    for (const spoof of [false, true])
      expect(await ask(outsider, spoof)).toEqual({ live: [], inUse: false });
    // The worker's own check is the worker's alone.
    expect(
      (
        await failure(() =>
          as(outsider)((tx) => rows(tx, sql`select private.addon_writable(${wsA}, ${addon})`)),
        )
      ).code,
    ).toBe('42501');
    // The worker, scoped to the business, is answered.
    const [fromWorker] = await worker(
      wsA,
      orgA,
    )((tx) => rows<{ live: string[] }>(tx, sql`select private.active_addons(${wsA}) as live`));
    expect(fromWorker!.live).toContain(addon);
  });

  it('keeps what each person set aside of Home’s suggestions to themselves', async () => {
    const add = (u: TestUser, ws: string, userId: string, addon: string) =>
      as(u)((tx) =>
        rows(
          tx,
          sql`insert into app.addon_suggestion_dismissals (workspace_id, user_id, addon_id, choice)
              values (${ws}, ${userId}, ${addon}, 'not_now')
              on conflict (workspace_id, user_id, addon_id) do update set decided_at = now()`,
        ),
      );
    await add(owner, wsA, owner.id, 'fxprop');
    const theirs = (u: TestUser) =>
      as(u)((tx) =>
        rows(
          tx,
          sql`select addon_id from app.addon_suggestion_dismissals where workspace_id = ${wsA}`,
        ),
      );
    expect(await theirs(owner)).toEqual([{ addon_id: 'fxprop' }]);
    expect(await theirs(member)).toEqual([]);
    expect((await failure(() => add(member, wsA, owner.id, 'fxseo'))).code).toBe('42501');
    expect((await failure(() => add(outsider, wsA, outsider.id, 'fxseo'))).code).toBe('42501');
  });

  it('a member can’t install, an admin can, and only an owner starts deleting an add-on’s data', async () => {
    const addon = freshId();
    expect((await failure(() => move(member, wsA, addon, 'installing'))).detail).toBe(
      'addon_needs_manage',
    );
    expect(await move(admin, wsA, addon, 'installing')).toMatchObject({
      state: 'installing',
      generation: 1,
    });
    await complete(wsA, orgA, addon, 'enabled');
    await move(admin, wsA, addon, 'uninstalling');
    await complete(wsA, orgA, addon, 'uninstalled');
    expect((await failure(() => move(admin, wsA, addon, 'purging'))).detail).toBe(
      'addon_purge_owner_only',
    );
    expect((await move(owner, wsA, addon, 'purging')).state).toBe('purging');
    // Nobody outside the business moves anything in it.
    expect((await failure(() => move(outsider, wsA, freshId(), 'installing'))).code).toBe('42501');
  });

  it('holds everyone to the moves, and a reinstall starts a new generation', async () => {
    const addon = freshId();
    await turnOn(wsA, orgA, addon);
    // Straight from on to deleted is not a move, for a person or for the worker.
    expect((await failure(() => move(owner, wsA, addon, 'purging'))).detail).toBe('addon_bad_move');
    expect((await failure(() => complete(wsA, orgA, addon, 'purged'))).detail).toBe(
      'addon_bad_move',
    );
    // Installing what is already on isn't a move here: the command answers "already" before asking the database.
    expect((await failure(() => move(owner, wsA, addon, 'installing'))).detail).toBe(
      'addon_bad_move',
    );
    // Asking for where it already is changes nothing.
    expect((await move(owner, wsA, addon, 'enabled')).state).toBe('enabled');
    await move(owner, wsA, addon, 'uninstalling');
    await complete(wsA, orgA, addon, 'uninstalled');
    expect(await move(owner, wsA, addon, 'installing', '2.0.0', 3)).toMatchObject({
      state: 'installing',
      generation: 2,
      previous_state: 'uninstalled',
    });
    const [row] = await rows<{ installed_version: string; data_version: number }>(
      dbs.admin.db,
      sql`select installed_version, data_version from app.addon_installations
          where workspace_id = ${wsA} and addon_id = ${addon}`,
    );
    // The code version is the new one; the data keeps the shape it was written in, for the worker to migrate.
    expect(row).toEqual({ installed_version: '2.0.0', data_version: 1 });
    // The worker can't move the generation on its own.
    expect(
      (
        await failure(() =>
          worker(
            wsA,
            orgA,
          )((tx) =>
            rows(
              tx,
              sql`update app.addon_installations set generation = 9 where workspace_id = ${wsA} and addon_id = ${addon}`,
            ),
          ),
        )
      ).detail,
    ).toBe('addon_bad_generation');
  });
});

describe('an add-on’s permissions exist only while it runs', () => {
  it('appear for the roles it names when it turns on, in that business only, and go when it turns off', async () => {
    await move(owner, wsA, 'fxprop', 'installing');
    expect(await permissionsOf(member, wsA)).not.toContain('fxprop.read');
    await complete(wsA, orgA, 'fxprop', 'enabled');
    for (const u of [owner, admin, member]) {
      const p = await permissionsOf(u, wsA);
      expect(p).toEqual(expect.arrayContaining(['fxprop.read', 'fxprop.write']));
    }
    // The other business has never heard of it.
    expect(await permissionsOf(outsider, wsB)).not.toContain('fxprop.read');
    // Row security reads the same stored answer.
    const has = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ ok: boolean }>(tx, sql`select private.has_permission(${wsA}, 'fxprop.write') as ok`),
      ).then((r) => r[0]!.ok);
    expect(await has(member)).toBe(true);

    // A business's own choice for a person survives the add-on going off and coming back.
    await as(owner)((tx) =>
      rows(
        tx,
        sql`insert into app.member_permission_overrides (workspace_id, user_id, permission, allowed, updated_by)
            values (${wsA}, ${member.id}, 'fxprop.write', false, ${owner.id})`,
      ),
    );
    expect(await has(member)).toBe(false);
    await move(owner, wsA, 'fxprop', 'disabled');
    expect(await permissionsOf(member, wsA)).not.toContain('fxprop.read');
    expect(await permissionsOf(owner, wsA)).not.toContain('fxprop.write');
    await move(owner, wsA, 'fxprop', 'enabled');
    expect(await permissionsOf(member, wsA)).toContain('fxprop.read');
    expect(await has(member)).toBe(false);
  });

  it('HandsFreeOS switching an add-on off takes it away everywhere, and only staff can', async () => {
    const addon = freshId();
    await register(addon, [{ key: `${addon}.use`, defaultRoles: ['member'] }]);
    await turnOn(wsA, orgA, addon);
    expect(await permissionsOf(member, wsA)).toContain(`${addon}.use`);
    const setOverride = (u: TestUser, status: string | null) =>
      as(u)((tx) =>
        rows(tx, sql`select private.set_addon_override(${addon}, ${status}, 'Security fix')`),
      );
    expect((await failure(() => setOverride(owner, 'unavailable'))).detail).toBe(
      'addon_override_forbidden',
    );
    await setOverride(staffAdmin, 'unavailable');
    expect(await permissionsOf(member, wsA)).not.toContain(`${addon}.use`);
    const [live] = await as(member)((tx) =>
      rows<{ a: string[] }>(tx, sql`select private.active_addons(${wsA}) as a`),
    );
    expect(live!.a).not.toContain(addon);
    await setOverride(staffAdmin, null);
    expect(await permissionsOf(member, wsA)).toContain(`${addon}.use`);
  });
});

describe('the kinds of records an add-on manages', () => {
  let kindId: string;
  let recordId: string;
  beforeAll(async () => {
    // fxprop is on in A (above, or turned on here if this runs alone).
    await rows(
      dbs.admin.db,
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${wsA}, 'fxprop', 'enabled', '1.0.0')
          on conflict (workspace_id, addon_id) do update set state = 'enabled'`,
    );
    const [k] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission)
            values (${wsA}, ${`fxprop_property_${letters(5)}`}, ${`Property ${letters(5)}`}, 'Properties', 'fxprop', 'fxprop.write')
            returning id`,
      ),
    );
    kindId = k!.id;
    const [r] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_records (workspace_id, type_id, name, created_by)
            values (${wsA}, ${kindId}, '12 Main St', ${owner.id}) returning id`,
      ),
    );
    recordId = r!.id;
  });

  it('only the add-on makes one or decides whether it shows; people may relabel it', async () => {
    expect(
      (
        await failure(() =>
          as(owner)((tx) =>
            rows(
              tx,
              sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission, created_by)
                  values (${wsA}, 'fxprop_fake', 'Fake', 'Fakes', 'fxprop', 'fxprop.write', ${owner.id})`,
            ),
          ),
        )
      ).detail,
    ).toBe('managed_by_addon');
    expect(
      (
        await failure(() =>
          as(owner)((tx) =>
            rows(
              tx,
              sql`update app.custom_record_types set archived_at = now() where id = ${kindId}`,
            ),
          ),
        )
      ).detail,
    ).toBe('managed_by_addon');
    await as(owner)((tx) =>
      rows(tx, sql`update app.custom_record_types set plural = 'Buildings' where id = ${kindId}`),
    );
  });

  it('its records are written with its permission, and hidden while it is off', async () => {
    // The member's own "no" to fxprop.write (above) holds here too.
    const writeAs = (u: TestUser) =>
      as(u)((tx) =>
        rows(
          tx,
          sql`insert into app.custom_records (workspace_id, type_id, name, created_by)
              values (${wsA}, ${kindId}, 'Unit 4B', ${u.id})`,
        ),
      );
    const deniedMember = await rows<{ allowed: boolean }>(
      dbs.admin.db,
      sql`select allowed from app.member_permission_overrides
          where workspace_id = ${wsA} and user_id = ${member.id} and permission = 'fxprop.write'`,
    );
    if (deniedMember.length > 0)
      expect((await failure(() => writeAs(member))).detail).toBe('managed_record_forbidden');
    await writeAs(admin);

    const visible = (u: TestUser) =>
      as(u)((tx) => rows(tx, sql`select id from app.custom_records where id = ${recordId}`)).then(
        (r) => r.length,
      );
    expect(await visible(owner)).toBe(1);
    await move(owner, wsA, 'fxprop', 'disabled');
    expect(await visible(owner)).toBe(0);
    const kinds = await as(owner)((tx) =>
      rows(tx, sql`select id from app.custom_record_types where id = ${kindId}`),
    );
    expect(kinds).toEqual([]);
    expect((await failure(() => writeAs(owner))).detail).toBe('addon_inactive');
    // The worker still sees it: it has to, to hide it, show it again, or delete it for good.
    const seenByWorker = await worker(
      wsA,
      orgA,
    )((tx) => rows(tx, sql`select id from app.custom_records where id = ${recordId}`));
    expect(seenByWorker.length).toBe(1);
    await move(owner, wsA, 'fxprop', 'enabled');
    expect(await visible(owner)).toBe(1);
  });

  it('hides and shows the kind and the types on it together, as archiving a kind always has', async () => {
    const [t] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.relationship_types (workspace_id, a_end, a_label, b_end, b_record_type_id, b_label, addon_id, addon_key)
            values (${wsA}, 'person', 'Tenant', 'custom_record', ${kindId}, ${`Home ${letters(4)}`}, 'fxprop', ${`fxprop_tenant_${letters(5)}`})
            returning id`,
      ),
    );
    const archived = () =>
      rows<{ kind: string | null; type: string | null }>(
        dbs.admin.db,
        sql`select (select archived_at::text from app.custom_record_types where id = ${kindId}) as kind,
                   (select archived_at::text from app.relationship_types where id = ${t!.id}) as type`,
      ).then((r) => r[0]!);
    await worker(
      wsA,
      orgA,
    )((tx) => rows(tx, sql`select private.addon_hide_records(${wsA}, 'fxprop')`));
    const hidden = await archived();
    expect(hidden.kind).not.toBeNull();
    expect(hidden.type).toBe(hidden.kind);
    await worker(
      wsA,
      orgA,
    )((tx) => rows(tx, sql`select private.addon_show_records(${wsA}, 'fxprop')`));
    expect(await archived()).toEqual({ kind: null, type: null });
  });
});

describe('usage', () => {
  it('counts only while the add-on runs, once per key, and only its own meters', async () => {
    const addon = freshId();
    await turnOn(wsA, orgA, addon);
    const count = (key: string, meter = `${addon}.posts`) =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows<{ ok: boolean }>(
          tx,
          sql`select private.record_addon_usage(${wsA}, ${addon}, ${meter}, 1, ${key}) as ok`,
        ),
      ).then((r) => r[0]!.ok);
    expect(await count('post-1')).toBe(true);
    expect(await count('post-1')).toBe(false);
    expect((await failure(() => count('post-2', 'fxother.posts'))).detail).toBe(
      'addon_meter_not_its_own',
    );
    await move(owner, wsA, addon, 'disabled');
    expect((await failure(() => count('post-3'))).detail).toBe('addon_inactive');
  });
});

describe('an add-on’s own tables', () => {
  const addon = freshId();
  const schema = `addon_${addon}`;
  const table = `${schema}.leases`;
  beforeAll(async () => {
    await register(addon, [
      { key: `${addon}.read`, defaultRoles: ['admin', 'member'] },
      { key: `${addon}.write`, defaultRoles: ['admin'], requires: [`${addon}.read`] },
    ]);
    // What the add-on's migration does: its schema, its table, then every tenant rule in one call.
    await retryDeadlock(() =>
      dbs.admin.db.transaction(async (tx: Tx) => {
        await tx.execute(sql`select private.create_addon_schema(${addon})`);
        await tx.execute(
          sql.raw(`create table ${table} (
          id uuid primary key default gen_random_uuid(),
          workspace_id uuid not null references app.workspaces (id) on delete cascade,
          rent_cents bigint not null check (rent_cents >= 0),
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now())`),
        );
        await tx.execute(sql.raw(`create index on ${table} (workspace_id)`));
        await tx.execute(
          sql`select private.addon_table_policies(${table}::regclass, ${`${addon}.read`}, ${`${addon}.write`}, ${`${addon}.write`})`,
        );
      }),
    );
    await turnOn(wsA, orgA, addon);
  });
  afterAll(async () => {
    await retryDeadlock(() =>
      rows(dbs.admin.db, sql.raw(`drop schema if exists ${schema} cascade`)),
    );
  });

  it('keeps each business to its own rows, behind the add-on’s own permissions', async () => {
    const insertAs = (u: TestUser, ws: string, cents: number) =>
      as(u)((tx) =>
        rows(
          tx,
          sql.raw(`insert into ${table} (workspace_id, rent_cents) values ('${ws}', ${cents})`),
        ),
      );
    await insertAs(admin, wsA, 120000);
    // A member may read but not write; the outsider may do neither, in A or by claiming to be A.
    expect((await failure(() => insertAs(member, wsA, 1))).code).toBe('42501');
    expect((await failure(() => insertAs(outsider, wsA, 1))).code).toBe('42501');
    const read = (u: TestUser) =>
      as(u)((tx) => rows(tx, sql.raw(`select rent_cents from ${table}`)));
    expect((await read(member)).length).toBe(1);
    expect(await read(outsider)).toEqual([]);
    // Turned off: nobody reads it, and the worker can read (to export or delete) but not write.
    await move(owner, wsA, addon, 'disabled');
    expect(await read(member)).toEqual([]);
    expect(await read(owner)).toEqual([]);
    const byWorker = worker(wsA, orgA);
    expect((await byWorker((tx) => rows(tx, sql.raw(`select 1 from ${table}`)))).length).toBe(1);
    expect(
      (
        await failure(() =>
          byWorker((tx) =>
            rows(
              tx,
              sql.raw(`insert into ${table} (workspace_id, rent_cents) values ('${wsA}', 5)`),
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    await move(owner, wsA, addon, 'enabled');
    expect((await read(member)).length).toBe(1);
  });

  it('is deleted for good by the purge, which then says so', async () => {
    await move(owner, wsA, addon, 'uninstalling');
    await complete(wsA, orgA, addon, 'uninstalled');
    await move(owner, wsA, addon, 'purging');
    const byWorker = worker(wsA, orgA);
    for (let i = 0; i < 20; i++) {
      const [more] = await byWorker((tx) =>
        rows<{ more: boolean }>(
          tx,
          sql`select private.purge_addon_batch(${wsA}, ${addon}, 1000) as more`,
        ),
      );
      if (!more!.more) break;
    }
    const checks = await byWorker((tx) =>
      rows<{ check_name: string; ok: boolean }>(
        tx,
        sql`select check_name, ok from private.addon_verify(${wsA}, ${addon})`,
      ),
    );
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.check_name)).toContain('no_rows_left');
    const left = await rows(dbs.admin.db, sql.raw(`select 1 from ${table}`));
    expect(left).toEqual([]);
  });
});

describe('permanently deleting an add-on’s data', () => {
  it('keeps names and history lines, drops the details, and leaves core records alone', async () => {
    const addon = freshId();
    await register(addon, [{ key: `${addon}.write`, defaultRoles: ['member'] }]);
    await turnOn(wsA, orgA, addon);
    const byWorker = worker(wsA, orgA);
    const [k] = await byWorker((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission)
            values (${wsA}, ${`${addon}_lease`}, 'Lease', 'Leases', ${addon}, ${`${addon}.write`}) returning id`,
      ),
    );
    const [rec] = await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_records (workspace_id, type_id, name, notes, created_by)
            values (${wsA}, ${k!.id}, 'Lease 12 Main St', 'Rent $1,200, due the 1st', ${member.id}) returning id`,
      ),
    );
    const [person] = await byWorker((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${wsA}, 'Tina') returning id`,
      ),
    );
    const [t] = await byWorker((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.relationship_types (workspace_id, a_end, a_label, b_end, b_record_type_id, b_label, addon_id, addon_key)
            values (${wsA}, 'person', 'Tenant', 'custom_record', ${k!.id}, 'Lease', ${addon}, ${`${addon}_tenant`}) returning id`,
      ),
    );
    await byWorker((tx) =>
      rows(
        tx,
        sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id)
            values (${wsA}, ${t!.id}, ${person!.id}, ${rec!.id})`,
      ),
    );
    const [task] = await byWorker((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.tasks (workspace_id, title, custom_record_id) values (${wsA}, 'Renew lease', ${rec!.id}) returning id`,
      ),
    );
    // History the add-on wrote: an event with details, and its audit row with before and after.
    const [ev] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.events (organization_id, workspace_id, event_type, actor_type, entity_type, entity_id, payload,
            correlation_id, addon_id)
          values (${orgA}, ${wsA}, ${`${addon}.lease.signed`}, 'human', 'custom_record', ${rec!.id},
            ${JSON.stringify({ rentCents: 120000, _addon: { id: addon, version: '1.0.0' } })}::jsonb,
            gen_random_uuid(), ${addon}) returning id`,
    );
    await rows(
      dbs.admin.db,
      sql`insert into app.audit_logs (event_id, organization_id, workspace_id, actor_type, action, entity_type,
            entity_id, before, after, correlation_id, addon_id)
          values (${ev!.id}, ${orgA}, ${wsA}, 'human', ${`${addon}.lease.sign`}, 'custom_record', ${rec!.id},
            '{}'::jsonb, ${JSON.stringify({ rentCents: 120000 })}::jsonb, gen_random_uuid(), ${addon})`,
    );
    // A line of its own on the lease's timeline (Real Estate step 6).
    const [line] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.activities (workspace_id, kind, subtype, custom_record_id, body, actor_type, meta)
          values (${wsA}, 'system', 'addon_line', ${rec!.id}, 'Rent $1,200, due the 1st', 'system',
            ${JSON.stringify({ addon: { id: addon, name: 'Property Management' }, words: 'signed the lease', tone: 'success' })}::jsonb)
          returning id`,
    );
    // History is append-only for everyone else.
    expect(
      (
        await failure(() =>
          rows(dbs.admin.db, sql`update app.events set payload = '{}'::jsonb where id = ${ev!.id}`),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await failure(() =>
          rows(dbs.admin.db, sql`update app.activities set body = null where id = ${line!.id}`),
        )
      ).detail,
    ).toBe('system_activity_immutable');

    // Deleting needs it uninstalled first, and the owner.
    expect((await failure(() => move(owner, wsA, addon, 'purging'))).detail).toBe('addon_bad_move');
    await move(owner, wsA, addon, 'uninstalling');
    // What the worker does as it finishes an uninstall (apps/worker/src/addons): its kinds hidden.
    await byWorker((tx) => rows(tx, sql`select private.addon_hide_records(${wsA}, ${addon})`));
    await complete(wsA, orgA, addon, 'uninstalled');
    await move(owner, wsA, addon, 'purging');
    for (let i = 0; i < 20; i++) {
      const [more] = await byWorker((tx) =>
        rows<{ more: boolean }>(
          tx,
          sql`select private.purge_addon_batch(${wsA}, ${addon}, 1) as more`,
        ),
      );
      if (!more!.more) break;
    }

    const [state] = await rows<{ state: string }>(
      dbs.admin.db,
      sql`select state from app.addon_installations where workspace_id = ${wsA} and addon_id = ${addon}`,
    );
    expect(state!.state).toBe('purged');
    const [tomb] = await rows<{ name: string; notes: string | null; purged: boolean }>(
      dbs.admin.db,
      sql`select name, notes, purged_at is not null as purged from app.custom_records where id = ${rec!.id}`,
    );
    expect(tomb).toEqual({ name: 'Lease 12 Main St', notes: null, purged: true });
    const pairs = await rows(
      dbs.admin.db,
      sql`select 1 from app.relationships where type_id = ${t!.id}`,
    );
    expect(pairs).toEqual([]);
    const [event] = await rows<{ event_type: string; payload: Record<string, unknown> }>(
      dbs.admin.db,
      sql`select event_type, payload from app.events where id = ${ev!.id}`,
    );
    expect(event!.event_type).toBe(`${addon}.lease.signed`);
    expect(event!.payload).toEqual({ _addon: { id: addon, version: '1.0.0' }, _redacted: true });
    const [audit] = await rows<{ action: string; before: unknown; after: unknown }>(
      dbs.admin.db,
      sql`select action, before, after from app.audit_logs where event_id = ${ev!.id}`,
    );
    expect(audit).toEqual({ action: `${addon}.lease.sign`, before: null, after: null });
    // Its timeline line keeps who, when and which add-on, and loses what it said.
    const [keptLine] = await rows<{ body: string | null; meta: Record<string, unknown> }>(
      dbs.admin.db,
      sql`select body, meta from app.activities where id = ${line!.id}`,
    );
    expect(keptLine).toEqual({
      body: null,
      meta: { addon: { id: addon, name: 'Property Management' }, _redacted: true },
    });
    // Core records stay: the customer, and the task, still pointing at the named tombstone.
    const kept = await rows<{ person: number; task: string | null }>(
      dbs.admin.db,
      sql`select (select count(*)::int from app.people where id = ${person!.id}) as person,
                 (select custom_record_id::text from app.tasks where id = ${task!.id}) as task`,
    );
    expect(kept[0]).toEqual({ person: 1, task: rec!.id });
    const checks = await byWorker((tx) =>
      rows<{ check_name: string; ok: boolean }>(
        tx,
        sql`select check_name, ok from private.addon_verify(${wsA}, ${addon})`,
      ),
    );
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    // A person can't bring a deleted record back: gone from sight while the add-on is gone…
    const touched = await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.custom_records set notes = 'back' where id = ${rec!.id} returning id`,
      ),
    );
    expect(touched).toEqual([]);
    // …and refused even once the add-on is installed again and its kinds show.
    await turnOn(wsA, orgA, addon);
    await byWorker((tx) => rows(tx, sql`select private.addon_show_records(${wsA}, ${addon})`));
    expect(
      (
        await failure(() =>
          as(owner)((tx) =>
            rows(tx, sql`update app.custom_records set notes = 'back' where id = ${rec!.id}`),
          ),
        )
      ).detail,
    ).toBe('record_purged');
  });

  it('runs only in the worker, for an add-on marked for it', async () => {
    const addon = freshId();
    await turnOn(wsA, orgA, addon);
    expect(
      (
        await failure(() =>
          worker(
            wsA,
            orgA,
          )((tx) => rows(tx, sql`select private.purge_addon_batch(${wsA}, ${addon}, 10)`)),
        )
      ).detail,
    ).toBe('addon_not_purging');
    expect(
      (
        await failure(() =>
          worker(
            wsB,
            orgB,
          )((tx) => rows(tx, sql`select private.purge_addon_batch(${wsA}, ${addon}, 10)`)),
        )
      ).code,
    ).toBe('42501');
  });
});

describe('every add-on table follows the rules', () => {
  it('has row security, the worker bound to its tenant, a cascading business key and a frozen tenant column', async () => {
    const broken = await rows<{ t: string; problem: string }>(
      dbs.admin.db,
      sql`with t as (
            select c.oid, c.oid::regclass::text as t, c.relrowsecurity
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname ~ '^addon_[a-z]{2,16}$' and c.relkind in ('r', 'p'))
          select t, 'no row security' as problem from t where not relrowsecurity
          union all
          select t, 'no worker policy bound to its tenant' from t where not exists (
            select 1 from pg_policy p where p.polrelid = t.oid and p.polroles @> array['service_actor'::regrole::oid]
              and pg_get_expr(p.polqual, p.polrelid) like '%system_scope_workspace()%')
          union all
          select t, 'no cascading key to app.workspaces' from t where not exists (
            select 1 from pg_constraint k where k.conrelid = t.oid and k.contype = 'f'
              and k.confrelid = 'app.workspaces'::regclass and k.confdeltype = 'c')
          union all
          select t, 'tenant column not frozen' from t where not exists (
            select 1 from pg_trigger g where g.tgrelid = t.oid
              and g.tgfoid = 'private.forbid_tenant_column_change'::regproc)`,
    );
    expect(broken).toEqual([]);
  });

  it('core never holds a key into an add-on, and an add-on’s keys cascade or let go', async () => {
    const intoAddons = await rows(
      dbs.admin.db,
      sql`select k.conname from pg_constraint k
          join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
          join pg_class r on r.oid = k.confrelid join pg_namespace rn on rn.oid = r.relnamespace
          where k.contype = 'f' and n.nspname in ('app', 'platform') and rn.nspname ~ '^addon_'`,
    );
    expect(intoAddons).toEqual([]);
    const holding = await rows(
      dbs.admin.db,
      sql`select k.conname from pg_constraint k
          join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
          where k.contype = 'f' and n.nspname ~ '^addon_' and k.confdeltype not in ('c', 'n')`,
    );
    expect(holding).toEqual([]);
  });
});
