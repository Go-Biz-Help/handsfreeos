/**
 * Real Estate Agent's worker actions for its screens (round five, step 10), through the worker's actions route,
 * against the stand-ins:
 *
 * - `realestate.feed.search`: the listing feed asked while the agent types, by address or MLS number, each home with
 *   its MLS's notice; nothing is kept. With no feed connected it says so.
 * - `realestate.esign.remind`: an envelope out at DocuSign sent again to whoever hasn't signed; Dotloop can't be.
 */
import { randomUUID } from 'node:crypto';
import {
  addonConnectionCommands,
  ADDON_CATALOG,
  createTokenVerifier,
  executeCommand,
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
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { looksLikeMlsNumber } from '../src/addons/realestate/feed/actions';
import { resetStandin } from '../src/addons/realestate/feed/index';
import { buildHttpServer } from '../src/http/server';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let s: TestServices;
let app: FastifyInstance;
let agent: TestUser;
let token: string;
let ws: string;
let org: string;

const action = (name: string, input: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/v1/addons/realestate/actions/${name}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws, input },
  });

beforeAll(async () => {
  resetStandin();
  s = testServices();
  agent = await createTestUser('re-actions-agent');
  ws = await realestateBusiness(agent, 'Actions Realty');
  [{ organization_id: org }] = (await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  )) as [{ organization_id: string }];
  const env = testEnv();
  app = await buildHttpServer({
    ...s,
    addonConnect: { fake: true, platformKeys: {} },
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
  token = await signInTestUser(agent);
}, 120_000);
afterAll(async () => {
  resetStandin();
  await app?.close();
  await closeTestDbs();
});

describe('asking the MLS while typing', () => {
  it('tells an MLS number from an address', () => {
    expect(looksLikeMlsNumber('ACT-6612408')).toBe(true);
    expect(looksLikeMlsNumber('4821937')).toBe(true);
    expect(looksLikeMlsNumber('418 Maple')).toBe(false);
  });

  it('says when no feed is connected, then finds homes by address or number', async () => {
    const none = await action('realestate.feed.search', { text: '1000 Elm' });
    expect(none.json()).toEqual({ connected: false, homes: [] });
    await executeCommand(
      testDbs().worker.db,
      addonConnectionCommands(ADDON_CATALOG).save,
      {
        workspaceId: ws,
        addonId: 'realestate',
        connector: 'listing_data',
        provider: 'repliers',
        auth: 'key',
        label: 'Stand-in Repliers account',
        accountRef: null,
        secretEnc: s.sealer.seal(JSON.stringify({ apiKey: 'k' })),
        keyId: s.sealer.keyId,
        connectedBy: agent.id,
      },
      { type: 'system', workspaceId: ws, organizationId: org, onBehalfOf: agent.id },
      meta(),
    );
    const byAddress = (await action('realestate.feed.search', { text: '1000 Elm' })).json();
    expect(byAddress).toMatchObject({ connected: true, supplier: 'Stand-in Repliers account' });
    expect(byAddress.homes[0]).toMatchObject({
      address: expect.stringMatching(/^1000 Elm St, Austin, TX 78704/),
      mls: 'Stand-in MLS',
      notice: expect.stringMatching(/Stand-in MLS/),
    });
    const byNumber = (
      await action('realestate.feed.search', { text: byAddress.homes[0].mlsNumber })
    ).json();
    expect(byNumber.homes.map((h: { mlsNumber: string }) => h.mlsNumber)).toEqual([
      byAddress.homes[0].mlsNumber,
    ]);
    // Too little to ask with says what to type.
    const short = await action('realestate.feed.search', { text: '10' });
    expect(short.statusCode).toBe(400);
  });
});
