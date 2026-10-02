/**
 * An add-on's connections to other services (round five, 20261021000100), over a made-up add-on that connects a
 * listing feed: a key the worker tried and sealed, HandsFreeOS's own account turned on by staff, health, letting one
 * go, and what happens to them when the add-on leaves.
 *
 * - Only people with the connector's permission see a connection, and nobody reads a sealed column.
 * - The business's own account is used before HandsFreeOS's; one of its own at a time for a feed.
 * - A refusal needs connecting again; five failures in a row read "not working"; one that works clears both.
 * - Uninstalling wipes the secrets; purging deletes the rows.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manifestIssues } from '../src/addons/manifest';
import { ADDON, fxconn } from './addons/connection-fixture';
import { HfosError } from '../src/errors';
import {
  addonConnectionCommands,
  addonConnectionQueries,
  CONNECTION_FAILURES_BEFORE_ERROR,
  executeCommand,
  executeQuery,
  organizationCreate,
  type HumanActor,
  type SystemActor,
} from '../src/server';

const catalog = [fxconn];
const cmds = addonConnectionCommands(catalog);
const queries = addonConnectionQueries(catalog);

const api = () => testDbs().api.db;
/** The worker's commands run on its own connection, the only one that can act as the system. */
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

let owner: TestUser;
let member: TestUser;
let staff: TestUser;
let ws: string;
let org: string;

const system = (onBehalfOf: string): SystemActor => ({
  type: 'system',
  workspaceId: ws,
  organizationId: org,
  onBehalfOf,
});

/** What the worker saves once a service accepted a key (the secret is already sealed by then). */
const saveKey = (provider: string, label: string, auth: 'key' | 'oauth' = 'key') =>
  executeCommand(
    worker(),
    cmds.save,
    {
      workspaceId: ws,
      addonId: ADDON,
      connector: 'listing_data',
      provider,
      auth,
      label,
      accountRef: `acct-${label}`,
      details: { mlss: ['Unlock MLS'] },
      secretEnc: `v1.test.${randomUUID()}`,
      keyId: 'test',
      connectedBy: owner.id,
    },
    system(owner.id),
    meta(),
  ).then((r) => r.output);

const list = (u: TestUser) =>
  executeQuery(api(), queries.list, { workspaceId: ws, addonId: ADDON }, human(u), meta());
const health = (connectionId: string, result: { ok: boolean; error?: string; refused?: boolean }) =>
  executeCommand(
    worker(),
    cmds.health,
    { workspaceId: ws, connectionId, ...result },
    system(owner.id),
    meta(),
  ).then((r) => r.output);
const disconnect = (u: TestUser, connectionId: string) =>
  executeCommand(api(), cmds.disconnect, { workspaceId: ws, connectionId }, human(u), meta()).then(
    (r) => r.output,
  );
const platform = (u: TestUser, on: boolean) =>
  executeCommand(
    api(),
    cmds.platform,
    { workspaceId: ws, addonId: ADDON, connector: 'listing_data', provider: 'acme', on },
    human(u),
    meta(),
  ).then((r) => r.output);

const row = async (id: string) =>
  (
    await rows<{
      status: string;
      secret_enc: string | null;
      failures: number;
      failing_since: Date | null;
      last_error: string | null;
    }>(
      admin(),
      sql`select status, secret_enc, failures, failing_since, last_error
          from app.addon_connections where id = ${id}`,
    )
  )[0];
const eventsOf = (id: string) =>
  rows<{ event_type: string }>(
    admin(),
    sql`select event_type from app.events where entity_id = ${id} order by created_at`,
  ).then((r) => r.map((e) => e.event_type));

async function refusedWith(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return e instanceof HfosError ? (e.rule ?? e.code) : String(e);
  }
  throw new Error('It was allowed.');
}

/** The database's own refusal code, under the driver's wrapping. */
async function deniedIn(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause;
    return cause?.code ?? (e as { code?: string }).code;
  }
  throw new Error('It was allowed.');
}

beforeAll(async () => {
  expect(manifestIssues(fxconn)).toEqual([]);
  [owner, member, staff] = await Promise.all([
    createTestUser('conn-owner'),
    createTestUser('conn-member'),
    createTestUser('conn-staff'),
  ]);
  const made = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Feed Realty' },
    human(owner),
    meta(),
  );
  ws = made.output.workspaceId;
  org = made.output.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  await rows(
    admin(),
    sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify(fxconn.permissions)}::jsonb)`,
  );
  await rows(
    admin(),
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
}, 60_000);
afterAll(closeTestDbs);

describe('an add-on’s connections', () => {
  it('keeps nothing while the add-on is off in the business', async () => {
    expect(await refusedWith(saveKey('acme', 'data@feed.test'))).toBe('addon_inactive');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${ws}, ${ADDON}, 'enabled', '1.0.0')`,
    );
  });

  it('refuses a service or a way of connecting the manifest doesn’t name', async () => {
    expect(await refusedWith(saveKey('nobody', 'x'))).toBe('addon_connector_unknown');
    expect(await refusedWith(saveKey('signin', 'x', 'key'))).toBe('addon_connector_auth');
    expect(await refusedWith(saveKey('acme', 'x', 'oauth'))).toBe('addon_connector_auth');
  });

  it('keeps a tried key for the people who manage it, never its sealed columns', async () => {
    const { connectionId } = await saveKey('acme', 'data@feed.test');
    expect(await eventsOf(connectionId)).toEqual(['addon_connection.connected']);

    const mine = await list(owner);
    const [feed] = mine.connectors;
    expect(feed).toMatchObject({ key: 'listing_data', label: 'Listing data', canManage: true });
    expect(feed!.providers.map((p) => p.id)).toEqual(['acme', 'other', 'signin']);
    expect(feed!.providers[0]!.fields).toEqual([
      { key: 'apiKey', label: 'API key', secret: true, hint: null, optional: false },
    ]);
    expect(feed!.connections).toEqual([
      expect.objectContaining({
        id: connectionId,
        provider: 'acme',
        providerLabel: 'Acme Listings',
        auth: 'key',
        status: 'active',
        label: 'data@feed.test',
        details: { mlss: ['Unlock MLS'] },
        connectedByName: expect.any(String),
        inUse: true,
      }),
    ]);
    expect(JSON.stringify(mine)).not.toContain('v1.test.');

    // A member who may use the add-on but not manage it sees what it connects to, not the accounts.
    const theirs = await list(member);
    expect(theirs.connectors[0]).toMatchObject({ canManage: false, connections: [] });

    // Nobody reads a sealed column or writes a row, even the owner.
    expect(
      await deniedIn(
        asUser(api(), owner.claims, (tx) =>
          rows(tx, sql`select secret_enc from app.addon_connections where id = ${connectionId}`),
        ),
      ),
    ).toBe('42501');
    expect(
      await deniedIn(
        asUser(api(), owner.claims, (tx) =>
          rows(tx, sql`update app.addon_connections set label = 'x' where id = ${connectionId}`),
        ),
      ),
    ).toBe('42501');

    // Anyone who uses the add-on may know whether the feed works, and nothing more.
    const live = await asUser(api(), member.claims, (tx) =>
      rows<{ provider: string; status: string }>(
        tx,
        sql`select provider, status from private.addon_connection_live(${ws}::uuid, ${ADDON}, 'listing_data')`,
      ),
    );
    expect(live).toEqual([expect.objectContaining({ provider: 'acme', status: 'active' })]);
  });

  it('uses the business’s own account before HandsFreeOS’s, which only staff turn on or off', async () => {
    expect(await refusedWith(platform(owner, true))).toMatch(/^(forbidden|not_found)$/);
    const on = await platform(staff, true);
    expect(on.changed).toBe(true);
    expect((await platform(staff, true)).changed).toBe(false);

    const [feed] = (await list(owner)).connectors;
    expect(feed!.connections.map((c) => [c.auth, c.inUse])).toEqual([
      ['key', true],
      ['platform', false],
    ]);
    expect(feed!.connections[1]!.label).toBe('HandsFreeOS’s Acme Listings account');
    // The business can't turn HandsFreeOS's account off itself.
    expect(await refusedWith(disconnect(owner, on.connectionId!))).toBe(
      'addon_connection_platform_is_ours',
    );
  });

  it('keeps one of the business’s own accounts at a time, and HandsFreeOS’s beside it', async () => {
    const before = (await list(owner)).connectors[0]!.connections.find((c) => c.auth === 'key')!;
    // The same service again replaces it in place.
    const again = await saveKey('acme', 'new@feed.test');
    expect(again.connectionId).toBe(before.id);
    // Another service lets the first go, wiping its key.
    const other = await saveKey('other', 'token holder');
    expect((await row(before.id))!).toMatchObject({ status: 'disconnected', secret_enc: null });
    const [feed] = (await list(owner)).connectors;
    expect(feed!.connections.map((c) => [c.provider, c.auth, c.inUse])).toEqual([
      ['other', 'key', true],
      ['acme', 'platform', false],
    ]);
    expect(other.connectionId).not.toBe(before.id);
  });

  it('gives a connection its own address only for the add-on it belongs to', async () => {
    const id = (await list(owner)).connectors[0]!.connections[0]!.id;
    const open = (addon: string) =>
      executeCommand(
        worker(),
        cmds.webhook,
        { workspaceId: ws, connectionId: id, tokenHash: 'ab'.repeat(32), secretEnc: null },
        { ...system(owner.id), addon: { id: addon, name: addon, version: '1.0.0' } },
        meta(),
      );
    // The kernel refuses an add-on that isn't on here; one that is can't reach another's connection.
    expect(await refusedWith(open('fxother'))).toBe('addon_inactive');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${ws}, 'fxother', 'enabled', '1.0.0')`,
    );
    expect(await refusedWith(open('fxother'))).toBe('not_found');
    expect((await open(ADDON)).output).toEqual({ connectionId: id });
    const [row] = await rows<{ hash: string }>(
      admin(),
      sql`select encode(webhook_token_hash, 'hex') as hash from app.addon_connections where id = ${id}`,
    );
    expect(row!.hash).toBe('ab'.repeat(32));
  });

  it('counts failures, needs connecting again after a refusal, and clears when it works', async () => {
    const id = (await list(owner)).connectors[0]!.connections[0]!.id;
    expect((await health(id, { ok: false, error: 'It timed out.' })).status).toBe('active');
    expect(await row(id)).toMatchObject({ failures: 1, last_error: 'It timed out.' });
    expect((await row(id))!.failing_since).not.toBeNull();

    // A refusal is a key that no longer works: connect it again, don't wait.
    expect(
      (await health(id, { ok: false, error: 'The key was turned down.', refused: true })).status,
    ).toBe('reauth_required');
    expect((await health(id, { ok: true })).status).toBe('active');
    expect(await row(id)).toMatchObject({ failures: 0, failing_since: null, last_error: null });

    for (let i = 1; i < CONNECTION_FAILURES_BEFORE_ERROR; i++)
      expect((await health(id, { ok: false, error: 'No answer.' })).status).toBe('active');
    expect((await health(id, { ok: false, error: 'No answer.' })).status).toBe('error');
    expect((await health(id, { ok: true })).status).toBe('active');

    // Only the moves between working and not are events.
    expect((await eventsOf(id)).filter((t) => t !== 'addon_connection.connected')).toEqual([
      'addon_connection.failing',
      'addon_connection.working',
      'addon_connection.failing',
      'addon_connection.working',
    ]);
  });

  it('lets a person who manages it let it go, wiping its key', async () => {
    const id = (await list(owner)).connectors[0]!.connections[0]!.id;
    expect(await refusedWith(disconnect(member, id))).toBe('addon_connection_not_found');
    expect(await disconnect(owner, id)).toEqual({ connectionId: id, changed: true });
    expect(await disconnect(owner, id)).toEqual({ connectionId: id, changed: false });
    expect(await row(id)).toMatchObject({ status: 'disconnected', secret_enc: null });
    expect(await eventsOf(id)).toContain('addon_connection.disconnected');
    // Health for one that's gone changes nothing.
    expect((await health(id, { ok: true })).status).toBe('disconnected');
    // HandsFreeOS's own account is what's used now.
    const [feed] = (await list(owner)).connectors;
    expect(feed!.connections.map((c) => [c.auth, c.inUse])).toEqual([['platform', true]]);
  });

  it('wipes every key when the add-on is uninstalled, and deletes them when its data is', async () => {
    const { connectionId } = await saveKey('acme', 'back@feed.test');
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'uninstalled' where workspace_id = ${ws} and addon_id = ${ADDON}`,
    );
    expect(await row(connectionId)).toMatchObject({ status: 'disconnected', secret_enc: null });
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'purging' where workspace_id = ${ws} and addon_id = ${ADDON}`,
    );
    const left = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.addon_connections where workspace_id = ${ws} and addon_id = ${ADDON}`,
    );
    expect(left[0]!.n).toBe(0);
  });
});
