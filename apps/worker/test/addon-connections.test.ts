/**
 * An add-on's connections from the worker (round five, 20261021000100), over the made-up feed add-on
 * (packages/core/test/addons/connection-fixture.ts): the route that tries a pasted key and seals it, and what an
 * add-on's worker half uses to find its account and say whether it worked.
 *
 * - Only a person with the connector's permission, in a business where the add-on is on, can connect it.
 * - A key the service turns down, or a service that doesn't answer, keeps nothing; the words say what to do.
 * - A key that works is kept sealed and never sent back; the add-on opens it only when it needs it.
 * - The business's own account comes before HandsFreeOS's, whose key lives only in the worker's environment.
 */
import { randomUUID } from 'node:crypto';
import {
  addonConnectionCommands,
  createTokenVerifier,
  executeCommand,
  organizationCreate,
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
import { ADDON, fxconn } from '../../../packages/core/test/addons/connection-fixture';
import {
  ConnectionRefused,
  connectionFor,
  connectionWorked,
  type ConnectionTester,
} from '../src/addons/connections';
import { addonScope } from '../src/addons/context';
import type { AddonWorkerModule } from '../src/addons/types';
import { addonWorkerModuleIssues } from '../src/addons/index';
import { buildHttpServer } from '../src/http/server';
import { workerMeta } from '../src/services';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

/** What the stand-in services were asked, and how they answer. */
const tried: { provider: string; fields: Record<string, string>; fake: boolean }[] = [];
const tester =
  (provider: string): ConnectionTester =>
  async (fields, ctx) => {
    tried.push({ provider, fields: { ...fields }, fake: ctx.fake });
    const key = Object.values(fields)[0] ?? '';
    if (key.includes('wrong')) throw new ConnectionRefused('Acme says that key isn’t right.');
    if (key.includes('down')) throw new Error('ECONNRESET');
    return {
      label: `acct for ${provider}`,
      accountRef: `ref-${provider}`,
      details: { mlss: ['Unlock'] },
    };
  };
const module: AddonWorkerModule = {
  manifest: fxconn,
  connectors: { listing_data: { acme: tester('acme'), other: tester('other') } },
};

let app: FastifyInstance;
let s: TestServices;
let owner: TestUser;
let member: TestUser;
let ownerToken: string;
let memberToken: string;
let ws: string;
let org: string;

const connect = (
  token: string | null,
  body: Partial<{ provider: string; fields: Record<string, string>; workspaceId: string }> = {},
) =>
  app.inject({
    method: 'POST',
    url: '/v1/addons/connections/key',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: {
      workspaceId: ws,
      addonId: ADDON,
      connector: 'listing_data',
      provider: 'acme',
      fields: { apiKey: 'good-key' },
      ...body,
    },
  });

const scopeCtx = () =>
  addonScope(
    { ...s, addonConnect: { fake: true, platformKeys: { [`${ADDON}.acme`]: { apiKey: 'ours' } } } },
    fxconn,
    { workspaceId: ws, organizationId: org },
    1,
    workerMeta(),
  );

beforeAll(async () => {
  expect(addonWorkerModuleIssues([fxconn], [module])).toEqual([]);
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
    addonConnections: { catalog: [fxconn], modules: [module] },
  });
  [owner, member] = await Promise.all([
    createTestUser('wconn-owner'),
    createTestUser('wconn-member'),
  ]);
  const made = await executeCommand(
    testDbs().api.db,
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
  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('connecting by key', () => {
  it('waits for the add-on to be on, and for someone who may manage it', async () => {
    expect((await connect(null)).statusCode).toBe(401);
    const off = await connect(ownerToken);
    expect(off.statusCode).toBe(403);
    expect(off.json().error.rule).toBe('addon_inactive');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${ws}, ${ADDON}, 'enabled', '1.0.0')`,
    );
    expect((await connect(memberToken)).statusCode).toBe(403);
    expect(tried).toEqual([]);
  });

  it('refuses a service it doesn’t connect to by key, and a key left blank', async () => {
    const unknown = await connect(ownerToken, { provider: 'nobody' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.rule).toBe('addon_connector_unknown');
    const signin = await connect(ownerToken, { provider: 'signin' });
    expect(signin.json().error.rule).toBe('addon_connector_auth');
    const blank = await connect(ownerToken, { fields: { apiKey: '  ' } });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error).toMatchObject({ rule: 'addon_connection_fields' });
    expect(blank.json().error.message).toContain('API key');
    expect(tried).toEqual([]);
  });

  it('keeps nothing when the service turns the key down or doesn’t answer', async () => {
    const wrong = await connect(ownerToken, { fields: { apiKey: 'wrong-key' } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toMatchObject({
      rule: 'addon_connection_refused',
      message: 'Acme says that key isn’t right.',
    });
    const down = await connect(ownerToken, { fields: { apiKey: 'down-key' } });
    expect(down.statusCode).toBe(502);
    expect(down.json().error.rule).toBe('addon_connection_unreachable');
    expect(down.json().error.message).toContain('Acme Listings');
    const [kept] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.addon_connections where workspace_id = ${ws}`,
    );
    expect(kept!.n).toBe(0);
    // Stand-ins only, here: nothing left the worker.
    expect(tried.every((t) => t.fake)).toBe(true);
  });

  it('seals a key that works, never sends it back, and the add-on opens it when it needs it', async () => {
    const ok = await connect(ownerToken, { fields: { apiKey: 'good-key', extra: 'ignored' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain('good-key');
    const body = ok.json() as { connectionId: string; label: string };
    expect(body.label).toBe('acct for acme');
    // Only the fields the service asks for were tried, and kept.
    expect(tried.at(-1)!.fields).toEqual({ apiKey: 'good-key' });

    const [row] = await rows<{ secret_enc: string; account_ref: string; connected_by: string }>(
      admin(),
      sql`select secret_enc, account_ref, connected_by from app.addon_connections where id = ${body.connectionId}`,
    );
    expect(row!.secret_enc).toMatch(/^v1\./);
    expect(row!.secret_enc).not.toContain('good-key');
    expect(row).toMatchObject({ account_ref: 'ref-acme', connected_by: owner.id });

    const found = await connectionFor(scopeCtx(), 'listing_data');
    expect(found).toMatchObject({
      id: body.connectionId,
      provider: 'acme',
      auth: 'key',
      secret: { apiKey: 'good-key' },
      failing: false,
    });
  });

  it('uses HandsFreeOS’s own account when the business has none, from the worker’s environment', async () => {
    const own = (await connectionFor(scopeCtx(), 'listing_data'))!;
    // The owner lets it go, through the API.
    await executeCommand(
      testDbs().api.db,
      addonConnectionCommands([fxconn]).disconnect,
      { workspaceId: ws, connectionId: own.id },
      human(owner),
      meta(),
    );
    expect(await connectionFor(scopeCtx(), 'listing_data')).toBeNull();
    await rows(
      admin(),
      sql`insert into app.addon_connections (workspace_id, addon_id, connector, provider, auth, permission, connected_at)
          values (${ws}, ${ADDON}, 'listing_data', 'acme', 'platform', ${`${ADDON}.manage`}, now())`,
    );
    expect(await connectionFor(scopeCtx(), 'listing_data')).toMatchObject({
      auth: 'platform',
      secret: { apiKey: 'ours' },
    });
    // A worker without HandsFreeOS's key (a local stack) acts as if there were no account.
    const bare = addonScope(s, fxconn, { workspaceId: ws, organizationId: org }, 1, workerMeta());
    expect(await connectionFor(bare, 'listing_data')).toBeNull();
  });

  it('records whether a call worked, and a refusal asks for the key again', async () => {
    const ok = await connect(ownerToken, { provider: 'other', fields: { token: 'good-token' } });
    expect(ok.statusCode).toBe(200);
    const ctx = scopeCtx();
    const c = (await connectionFor(ctx, 'listing_data'))!;
    expect(c.provider).toBe('other');
    await connectionWorked(ctx, c, { ok: false, error: 'The key was turned down.', refused: true });
    const status = async () =>
      (
        await rows<{ status: string; last_error: string | null }>(
          admin(),
          sql`select status, last_error from app.addon_connections where id = ${c.id}`,
        )
      )[0];
    expect(await status()).toEqual({
      status: 'reauth_required',
      last_error: 'The key was turned down.',
    });
    // Needing its key again, it isn't used: HandsFreeOS's own account is, meanwhile.
    expect((await connectionFor(ctx, 'listing_data'))!.auth).toBe('platform');
    await connectionWorked(ctx, c, { ok: true });
    expect(await status()).toEqual({ status: 'active', last_error: null });
  });
});
