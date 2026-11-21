/**
 * About you's interview (docs/outreach.md, decision 186; http/about-you.ts): the answers to its questions and what's in
 * the box go to the worker, and the box comes back as the AI wrote it, keeping what was there and leaving out what was
 * skipped. Nothing is kept: only Save keeps it. Anyone in the business may; someone from elsewhere may not.
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
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

const env = testEnv();
const admin = () => testDbs().admin.db;

let app: FastifyInstance;
let owner: TestUser;
let stranger: TestUser;
let ws: string;
let token: string;

const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

const write = (payload: Record<string, unknown>, as = token) =>
  app.inject({
    method: 'POST',
    url: '/v1/about-you/write',
    headers: { authorization: `Bearer ${as}` },
    payload: { workspaceId: ws, ...payload },
  });

beforeAll(async () => {
  owner = await createTestUser('about-you-owner');
  stranger = await createTestUser('about-you-stranger');
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'About You Roofing' },
    human(owner),
    { correlationId: randomUUID(), channel: 'test' },
  );
  ws = output.workspaceId;
  token = await signInTestUser(owner);
  app = await buildHttpServer({
    ...testServices({ ai: { provider: scriptedAi() } as never }),
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('About you’s interview', () => {
  it('writes the box from the answers, keeping what was there and leaving out what was skipped', async () => {
    const res = await write({
      about: 'Big Braves fan.',
      answers: [
        { key: 'where', said: 'Grew up in Greenville, live in Boise now' },
        { key: 'family', said: '   ' },
        { key: 'fun', said: 'Fly fishing <and> pickleball' },
        { key: 'not-a-question', said: 'ignore me' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      about:
        'Big Braves fan.\n\nGrew up in Greenville, live in Boise now. Fly fishing <and> pickleball.',
    });
    // Counted against the business, as the person's own use; and nothing kept as their About you.
    const [used] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_usage
          where workspace_id = ${ws} and source = 'about_you' and user_id = ${owner.id}`,
    );
    expect(used!.n).toBe(1);
    const kept = await rows(admin(), sql`select 1 from app.user_about where user_id = ${owner.id}`);
    expect(kept).toEqual([]);
  });

  it('asks for an answer first, and is only for people in the business', async () => {
    const none = await write({ answers: [{ key: 'where', said: '' }] });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.rule).toBe('nothing_said');
    const elsewhere = await write(
      { answers: [{ key: 'where', said: 'Boise' }] },
      await signInTestUser(stranger),
    );
    expect(elsewhere.statusCode).toBe(403);
  });
});
