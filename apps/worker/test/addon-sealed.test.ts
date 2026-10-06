/**
 * Values an add-on keeps sealed (round seven), over a made-up add-on with a door code: the worker seals what a
 * person types before any command sees it, and shows it again only to someone who may, on a record they can see,
 * keeping each time in the record's history without the value.
 */
import { randomUUID } from 'node:crypto';
import {
  createTokenVerifier,
  defineAddon,
  executeCommand,
  organizationCreate,
  sealedValue,
  type AddonManifest,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addonWorkerModuleIssues } from '../src/addons/index';
import { openSealed, sealFor, SealedMismatch } from '../src/addons/sealed';
import type { AddonWorkerModule } from '../src/addons/types';
import { buildHttpServer } from '../src/http/server';
import { testServices, type TestServices } from './helpers';

const ADDON = 'fxseal';
const fxseal: AddonManifest = defineAddon({
  id: ADDON,
  name: 'Sealed Test',
  summary: 'A made-up add-on that keeps a door code sealed.',
  description: 'A test fixture.',
  category: 'industry',
  version: '1.0.0',
  dataVersion: 1,
  billing: { model: 'free' },
  catalog: { status: 'available', keywords: ['door'] },
  capabilities: [
    {
      id: `${ADDON}.doors`,
      label: 'Doors',
      description: 'Door codes.',
      permission: `${ADDON}.use`,
    },
  ],
  permissions: [
    {
      key: `${ADDON}.use`,
      label: 'Use it',
      description: 'See door codes.',
      defaultRoles: ['admin', 'member'],
    },
    {
      key: `${ADDON}.manage`,
      label: 'Manage it',
      description: 'Set door codes.',
      defaultRoles: ['admin'],
      requires: [`${ADDON}.use`],
    },
  ],
  sealed: [
    { key: 'door_code', label: 'Door code', permission: `${ADDON}.manage`, reveal: `${ADDON}.use` },
  ],
});

/** Where the add-on keeps its sealed codes: one per record and item. */
const kept = new Map<string, string>();
const module: AddonWorkerModule = {
  manifest: fxseal,
  sealed: { door_code: async (_tx, at) => kept.get(`${at.recordId}/${at.itemId}`) ?? null },
};

const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

let app: FastifyInstance;
let s: TestServices;
let owner: TestUser;
let agent: TestUser;
let other: TestUser;
const tokens: Record<string, string> = {};
let ws: string;
let record: string;
const ITEM = randomUUID();

const post = (url: string, who: string | null, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url,
    headers: who ? { authorization: `Bearer ${tokens[who]}` } : {},
    payload,
  });
const seal = (who: string | null, value = '4417') =>
  post('/v1/addons/sealed', who, { workspaceId: ws, addonId: ADDON, key: 'door_code', value });
const reveal = (who: string, body: Record<string, unknown> = {}) =>
  post('/v1/addons/sealed/reveal', who, {
    workspaceId: ws,
    addonId: ADDON,
    key: 'door_code',
    recordId: record,
    itemId: ITEM,
    ...body,
  });

beforeAll(async () => {
  expect(addonWorkerModuleIssues([fxseal], [module])).toEqual([]);
  s = testServices();
  const env = testEnv();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    addonConnections: { catalog: [fxseal], modules: [module] },
  });
  [owner, agent, other] = await Promise.all([
    createTestUser('seal-owner'),
    createTestUser('seal-agent'),
    createTestUser('seal-other'),
  ]);
  ws = (
    await executeCommand(
      testDbs().api.db,
      organizationCreate,
      { businessName: 'Door Realty' },
      human(owner),
      { correlationId: randomUUID(), channel: 'test' },
    )
  ).output.workspaceId;
  for (const u of [agent, other])
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${u.id}, 'member')`,
    );
  await rows(
    admin(),
    sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify(fxseal.permissions)}::jsonb)`,
  );
  // A record kept to its agent: the other member can't see it.
  [record] = (
    await rows<{ id: string }>(
      admin(),
      sql`with kind as (
            insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission,
              kept_to_team, see_all_permission, position)
            values (${ws}, 'fxseal_door', 'Door', 'Doors', ${ADDON}, 'fxseal.manage', true, 'fxseal.manage', 900)
            returning id)
          insert into app.custom_records (workspace_id, type_id, name, owner_user_id)
          select ${ws}, kind.id, '12 Elm St', ${agent.id}::uuid from kind
          returning id`,
    )
  ).map((r) => r.id) as [string];
  [tokens.owner, tokens.agent, tokens.other] = await Promise.all([
    signInTestUser(owner),
    signInTestUser(agent),
    signInTestUser(other),
  ]);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('sealing what a person types', () => {
  it('waits for the add-on to be on, and for someone who may set it', async () => {
    expect((await seal(null)).statusCode).toBe(401);
    const off = await seal('owner');
    expect(off.statusCode).toBe(403);
    expect(off.json().error.rule).toBe('addon_inactive');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${ws}, ${ADDON}, 'enabled', '1.0.0')`,
    );
    expect((await seal('agent')).statusCode).toBe(403);
  });

  it('hands back only the sealed value, which a command takes and the code itself doesn’t', async () => {
    const res = await seal('owner');
    expect(res.statusCode).toBe(200);
    const { sealed } = res.json() as { sealed: string };
    expect(sealed).toMatch(/^sealed:v1\./);
    expect(sealed).not.toContain('4417');
    const field = sealedValue('Door code');
    expect(field.safeParse(sealed).success).toBe(true);
    const plain = field.safeParse('4417');
    expect(plain.success).toBe(false);
    expect(plain.error?.issues[0]?.message).toMatch(/door code has to be locked/);
    kept.set(`${record}/${ITEM}`, sealed);
  });

  it('opens only for the business, add-on and value it was sealed for', () => {
    const sealed = sealFor(s.sealer, { workspaceId: ws, addonId: ADDON, key: 'door_code' }, '9');
    expect(
      openSealed(s.sealer, sealed, { workspaceId: ws, addonId: ADDON, key: 'door_code' }),
    ).toBe('9');
    expect(() =>
      openSealed(s.sealer, sealed, { workspaceId: randomUUID(), addonId: ADDON, key: 'door_code' }),
    ).toThrow(SealedMismatch);
    expect(() =>
      openSealed(s.sealer, sealed, { workspaceId: ws, addonId: ADDON, key: 'gate_code' }),
    ).toThrow(SealedMismatch);
  });
});

describe('showing it again', () => {
  it('shows it to someone who may on a record they see, and keeps that in its history', async () => {
    const res = await reveal('agent');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ value: '4417' });
    const events = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where workspace_id = ${ws} and event_type = 'addon_sealed.viewed'
          and entity_id = ${record}::uuid`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      addonId: ADDON,
      key: 'door_code',
      viewedBy: agent.id,
    });
    expect(JSON.stringify(events)).not.toContain('4417');
  });

  it('isn’t there for someone who can’t see the record', async () => {
    const res = await reveal('other');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/isn’t one you can see/);
  });

  it('says so when nothing is saved, or what’s saved won’t open here', async () => {
    const none = await reveal('agent', { itemId: randomUUID() });
    expect(none.statusCode).toBe(404);
    expect(none.json().error.rule).toBe('addon_sealed_none');
    kept.set(
      `${record}/${ITEM}`,
      sealFor(s.sealer, { workspaceId: randomUUID(), addonId: ADDON, key: 'door_code' }, '1'),
    );
    const elsewhere = await reveal('agent');
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json().error.rule).toBe('addon_sealed_unopened');
  });
});
