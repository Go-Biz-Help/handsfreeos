/**
 * Social Outreach's AI help in the playbook builder (`outreach.playbook.assist`), through the worker's actions route
 * against the stand-in model: words to pick from, lines to add that aren't there already, and questions with only
 * the playbook's own tags. Owners and admins only, as they write the playbooks. And whether a playbook's niche fits
 * the business's main offer (`outreach.playbook.niche_fit`): nothing to check against until one is live.
 */
import { createTokenVerifier, MainOfferParts } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
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

const nicheFit = async (u: TestUser, input: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/addons/outreach/actions/outreach.playbook.niche_fit',
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

describe('whether a niche fits the main offer', () => {
  it('has nothing to check against until the main offer is live, then says inside or a second offer', async () => {
    const roofers = {
      niche: 'Roofers with 2 to 3 crews',
      problem: 'No steady jobs between storms',
    };
    const none = await nicheFit(owner, roofers);
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ fit: 'no_offer' });

    const parts = MainOfferParts.parse({
      who: { work: 'Roofers', slice: 'with 2 to 3 crews', problem: 'No steady jobs' },
      line: 'We help roofers with 2 to 3 crews get 10 to 20 booked inspections a month.',
      inAFewWords: {
        outcome: '10 to 20 booked inspections',
        guarantee: 'you only pay for results',
      },
    });
    await rows(
      testDbs().admin.db,
      sql`with v as (
            insert into app.main_offer_versions (workspace_id, version, parts, line, score)
            values (${ws}, 1, ${JSON.stringify(parts)}::jsonb, ${parts.line}, '{}'::jsonb) returning version)
          insert into app.main_offers (workspace_id, live_version) select ${ws}, version from v`,
    );

    expect((await nicheFit(owner, roofers)).json()).toEqual({
      fit: 'inside',
      why: 'roofers is in the offer’s who.',
    });
    // The model's long dash never reaches the screen.
    expect((await nicheFit(owner, { niche: 'Dentists in Ohio' })).json()).toEqual({
      fit: 'second_offer',
      why: 'They’d need another outcome, and price.',
    });
  });

  it('is for owners and admins, and needs a niche', async () => {
    expect((await nicheFit(member, { niche: 'Roofers' })).statusCode).toBe(403);
    expect((await nicheFit(owner, { niche: ' ' })).statusCode).toBe(400);
  });
});
