/**
 * Social Outreach's AI help in the playbook builder (`outreach.playbook.assist`), through the worker's actions route
 * against the stand-in model: words to pick from, lines to add that aren't there already, and questions with only
 * the playbook's own tags. Owners and admins only, as they write the playbooks.
 */
import { createTokenVerifier } from '@hfos/core/server';
import { workspaceMemberships } from '@hfos/db/schema';
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
import { outreachBusiness } from '../../../packages/core/test/addons/outreach-fixture';
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

let app: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let ws: string;

const assist = async (u: TestUser, input: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/addons/outreach/actions/outreach.playbook.assist',
    headers: { authorization: `Bearer ${await signInTestUser(u)}` },
    payload: { workspaceId: ws, input },
  });

const draft = {
  name: 'CRM demos',
  goal: 'demo',
  offer: 'A 20-minute demo',
  signs: ['Business owner'],
  tags: ['Uses a spreadsheet'],
};

beforeAll(async () => {
  const s = testServices({ ai: { provider: scriptedAi(), dailyTokens: 5_000_000 } });
  [owner, member] = await Promise.all([
    createTestUser('outreach-assist-owner'),
    createTestUser('outreach-assist-member'),
  ]);
  ws = await outreachBusiness(owner, 'Outreach Assist Co');
  await testDbs()
    .admin.db.insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
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
}, 120_000);
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('AI help on a playbook', () => {
  it('suggests lines that aren’t there yet, and words to pick from', async () => {
    const signs = await assist(owner, { part: 'signs', mode: 'suggest', draft });
    expect(signs.statusCode).toBe(200);
    expect(signs.json()).toEqual({
      options: [
        'A better signs someone fits',
        'Another signs someone fits',
        'A third signs someone fits',
      ],
      questions: [],
    });

    const offer = await assist(owner, { part: 'offer', mode: 'improve', draft });
    // Words are three to pick from, at most.
    expect(offer.json().options).toHaveLength(3);
  });

  it('suggests questions with only the playbook’s own tags', async () => {
    const res = await assist(owner, { part: 'questions', mode: 'suggest', draft });
    expect(res.json()).toEqual({
      options: [],
      questions: [
        {
          text: 'How do you keep track of your customers now?',
          answers: [
            { label: 'A spreadsheet', tag: 'Uses a spreadsheet', next: 'offer' },
            { label: 'A CRM', tag: null, next: 'continue' },
          ],
        },
      ],
    });
  });

  it('is for owners and admins, who write the playbooks', async () => {
    const res = await assist(member, { part: 'signs', mode: 'suggest', draft });
    expect(res.statusCode).toBe(403);
  });
});
