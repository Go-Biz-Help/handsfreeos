/**
 * An add-on's connections by sign-in (round five, 20261021000500), over the made-up feed add-on's `signin` service
 * (packages/core/test/addons/connection-fixture.ts).
 *
 * - With the stand-ins: the sign-in page is the worker's own; the callback connects nothing and hands a seal to the
 *   app; only the person who pressed Connect finishes it, and anybody else ends it.
 * - Cancelled at the service, nothing is kept. A server without HandsFreeOS's app at the service says so.
 * - With the service itself (scripted): the code is swapped with the PKCE verifier, the tokens kept sealed, renewed
 *   before they lapse, and a renewal turned down asks for the sign-in again.
 */
import { randomUUID } from 'node:crypto';
import {
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
import { connectionFor, type AddonConnection } from '../src/addons/connections';
import { addonScope } from '../src/addons/context';
import { addonWorkerModuleIssues } from '../src/addons/index';
import { signedInTokens } from '../src/addons/sign-ins';
import type { AddonWorkerModule } from '../src/addons/types';
import { buildHttpServer } from '../src/http/server';
import { workerMeta } from '../src/services';
import { refuseNextRefresh, signinCalls, signinStub } from './addon-fixture-oauth';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const module: AddonWorkerModule = {
  manifest: fxconn,
  connectors: {
    listing_data: {
      acme: async () => ({ label: 'acme', accountRef: null }),
      other: async () => ({ label: 'other', accountRef: null }),
    },
  },
  webhooks: { listing_data: { acme: { parse: () => [], handle: async () => 'ignored' } } },
  oauth: { listing_data: { signin: signinStub } },
};

let s: TestServices;
let fakeApp: FastifyInstance;
let realApp: FastifyInstance;
let bareApp: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let ownerToken: string;
let memberToken: string;
let ws: string;
let org: string;

const server = async (fake: boolean, keys: Record<string, Record<string, string>> = {}) => {
  const env = testEnv();
  return buildHttpServer({
    ...s,
    addonConnect: { fake, platformKeys: keys },
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    addonConnections: { catalog: [fxconn], modules: [module] },
  });
};
const post = (app: FastifyInstance, url: string, token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });
const start = (app: FastifyInstance, token: string) =>
  post(app, '/v1/addons/connections/sign-in', token, {
    workspaceId: ws,
    addonId: ADDON,
    connector: 'listing_data',
    provider: 'signin',
  });
const path = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

/** Through the stand-in's page and the callback: the seal the app gets after the `#`. */
async function signIn(app: FastifyInstance, token: string, decision: 'allow' | 'deny') {
  const begun = await start(app, token);
  expect(begun.statusCode).toBe(200);
  const page = await app.inject({ method: 'GET', url: path(begun.json().url) });
  expect(page.body).toContain('Sign in to Sign-in Feed');
  const authorize = new URL(begun.json().url);
  const approve = await app.inject({
    method: 'GET',
    url: `/oauth/fake/addon/approve?${new URLSearchParams({
      state: authorize.searchParams.get('state')!,
      redirect_uri: authorize.searchParams.get('redirect_uri')!,
      decision,
    }).toString()}`,
  });
  expect(approve.statusCode).toBe(302);
  const callback = await app.inject({
    method: 'GET',
    url: path(approve.headers.location as string),
  });
  expect(callback.statusCode).toBe(302);
  const finish = new URL(callback.headers.location as string);
  expect(finish.pathname).toBe('/app/oauth/finish');
  expect(finish.searchParams.get('door')).toBe('addon');
  return decodeURIComponent(finish.hash.slice(1));
}
const finish = (app: FastifyInstance, token: string, handoff: string) =>
  post(app, '/v1/addons/connections/finish', token, { handoff });
const live = () =>
  rows<{ id: string; status: string; auth: string; label: string | null; state: boolean }>(
    admin(),
    sql`select id, status, auth, label, oauth_state_hash is not null as state from app.addon_connections
        where workspace_id = ${ws} and provider = 'signin' and status <> 'disconnected'
        order by created_at`,
  );
const ctx = (fake: boolean) =>
  addonScope(
    {
      ...s,
      addonConnect: {
        fake,
        platformKeys: { [`${ADDON}.signin`]: { clientId: 'c', clientSecret: 'x' } },
      },
    },
    fxconn,
    { workspaceId: ws, organizationId: org },
    1,
    workerMeta(),
  );

beforeAll(async () => {
  expect(addonWorkerModuleIssues([fxconn], [module])).toEqual([]);
  s = testServices();
  [fakeApp, realApp, bareApp] = await Promise.all([
    server(true),
    server(false, { [`${ADDON}.signin`]: { clientId: 'c', clientSecret: 'x' } }),
    server(false),
  ]);
  [owner, member] = await Promise.all([
    createTestUser('wsign-owner'),
    createTestUser('wsign-member'),
  ]);
  const made = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Sign-in Realty' },
    human(owner),
    meta(),
  );
  ws = made.output.workspaceId;
  org = made.output.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'admin')`,
  );
  await rows(
    admin(),
    sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify(fxconn.permissions)}::jsonb)`,
  );
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, ${ADDON}, 'enabled', '1.0.0')`,
  );
  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
}, 120_000);
afterAll(async () => {
  await Promise.all([fakeApp?.close(), realApp?.close(), bareApp?.close()]);
  await closeTestDbs();
});

describe('signing in to a service for an add-on', () => {
  it('is finished only by the person who pressed Connect', async () => {
    const handoff = await signIn(fakeApp, ownerToken, 'allow');
    // Forwarded to somebody else: nothing is connected, and the sign-in ends.
    const theirs = await finish(fakeApp, memberToken, handoff);
    expect(theirs.json().page.title).toBe('This sign-in was started by someone else');
    expect(await live()).toEqual([]);
    // Too late for the owner now too.
    expect((await finish(fakeApp, ownerToken, handoff)).json().page.title).toBe(
      'This sign-in link has expired',
    );
  });

  it('connects the account once the person who started it finishes', async () => {
    const handoff = await signIn(fakeApp, ownerToken, 'allow');
    const done = await finish(fakeApp, ownerToken, handoff);
    expect(done.json()).toEqual({
      next: `http://localhost:3000/app/w/${ws}/addons/${ADDON}/connections?connected=signin`,
    });
    expect(await live()).toEqual([
      expect.objectContaining({
        status: 'active',
        auth: 'oauth',
        label: 'Stand-in Sign-in Feed account',
        state: false,
      }),
    ]);
    // Only the worker can open what was kept.
    const [kept] = await rows<{ secret_enc: string }>(
      admin(),
      sql`select secret_enc from app.addon_connections
          where workspace_id = ${ws} and provider = 'signin' and status = 'active'`,
    );
    expect(kept!.secret_enc).toMatch(/^v1\./);
  });

  it('keeps nothing when it’s cancelled at the service, and the account in use stays', async () => {
    const handoff = await signIn(fakeApp, ownerToken, 'deny');
    expect((await finish(fakeApp, ownerToken, handoff)).json()).toEqual({
      next: `http://localhost:3000/app/w/${ws}/addons/${ADDON}/connections?signin=cancelled`,
    });
    expect(await live()).toEqual([expect.objectContaining({ status: 'active', state: false })]);
  });

  it('says when this server has no app at the service', async () => {
    const res = await start(bareApp, ownerToken);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({
      rule: 'addon_sign_in_not_set_up',
      message: expect.stringMatching(/Ask HandsFreeOS support/),
    });
  });

  it('swaps the code with the service itself, using its PKCE verifier', async () => {
    const begun = await start(realApp, ownerToken);
    const authorize = new URL(begun.json().url);
    expect(authorize.host).toBe('signin.example');
    expect(authorize.searchParams.get('client_id')).toBe('c');
    const callback = await realApp.inject({
      method: 'GET',
      url: `/oauth/addon/callback?${new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'good' }).toString()}`,
    });
    const handoff = decodeURIComponent(new URL(callback.headers.location as string).hash.slice(1));
    expect((await finish(realApp, ownerToken, handoff)).json().next).toMatch(/connected=signin$/);
    expect(signinCalls.at(-1)).toBe('exchange good 43');
    expect(await live()).toEqual([
      expect.objectContaining({ status: 'active', label: 'feed@signin.example' }),
    ]);
  });

  it('renews tokens before they lapse, and asks for the sign-in again when that’s turned down', async () => {
    const c = (await connectionFor(ctx(false), 'listing_data')) as AddonConnection | null;
    // The feed's own accounts come first by key; this one is the only connection here.
    expect(c?.provider).toBe('signin');
    const tokens = await signedInTokens(ctx(false), c!, signinStub);
    expect(signinCalls.at(-1)).toBe('refresh real-refresh');
    expect(tokens).toMatchObject({ accessToken: 'renewed-access', refreshToken: 'real-refresh' });
    // Renewed: an hour to go, so it isn't renewed again.
    const again = (await connectionFor(ctx(false), 'listing_data'))!;
    const before = signinCalls.length;
    await signedInTokens(ctx(false), again, signinStub);
    expect(signinCalls).toHaveLength(before);
    // Lapsing, and turned down: sign in again.
    await rows(
      admin(),
      sql`update app.addon_connections set token_expires_at = now() where id = ${again.id}`,
    );
    refuseNextRefresh();
    await expect(signedInTokens(ctx(false), again, signinStub)).rejects.toThrow(/Sign in again/);
    refuseNextRefresh(false);
    expect(await live()).toEqual([expect.objectContaining({ status: 'reauth_required' })]);
  });
});
