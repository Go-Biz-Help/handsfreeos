import { randomUUID } from 'node:crypto';
import type { AiProvider, AiRequest } from '@hfos/ai';
import {
  createTokenVerifier,
  executeCommand,
  executeQuery,
  MainOfferParts,
  mainOfferGet,
  mainOfferPublish,
  mainOfferSaveDraft,
  OFFER_SCORE_SYSTEM,
  catalogAddon,
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

/**
 * The AI's help with the main offer (docs/main-offer.md): only for people who build it, only while an add-on that
 * uses it is on, counted as main offer AI use; and the score kept for the draft it read.
 */

const env = testEnv();
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let member: TestUser;
let ownerToken: string;
let memberToken: string;
let ws: string;
let app: FastifyInstance;

/** The scripted stand-in, remembering every request. */
function recording(inner: AiProvider) {
  const requests: AiRequest[] = [];
  const provider: AiProvider = {
    id: 'recording',
    model: inner.model,
    stream: (request, options) => {
      requests.push(request);
      return inner.stream(request, options);
    },
  };
  return { provider, requests };
}
const model = recording(scriptedAi());

const post = (url: string, token: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws, ...payload },
  });

const complete = MainOfferParts.parse({
  niche: { bestCustomer: 'A 3-crew roofer', theirWork: 'Roofing' },
  who: { work: 'Roofers', slice: 'with 2 to 3 crews', problem: 'No steady jobs' },
  outcome: { result: '10 to 20 booked inspections a month' },
  timeframe: { typical: '60 days' },
  method: { steps: ['Find the homes', 'Run the ads', 'Book the calls'] },
  guarantee: { promise: 'If you don’t get 10 in 60 days, you don’t pay' },
  price: { amount: '$2,000 a month' },
  proof: ['A 3-crew roofer got 14 inspections in 30 days'],
  line: 'We help roofers with 2 to 3 crews get 10 to 20 booked inspections a month.',
  inAFewWords: { outcome: '10 to 20 booked inspections', guarantee: 'you only pay for results' },
});

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('offer-ai-owner'),
    createTestUser('offer-ai-member'),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Summit Roofing Help' },
    actor(owner),
    meta(),
  );
  ws = output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
  const s = testServices({ ai: { provider: model.provider, dailyTokens: 5_000_000 } });
  app = await buildHttpServer({
    ...s,
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

describe('the main offer’s AI help', () => {
  it('is for people who build the offer, while an add-on that uses it is on', async () => {
    const asked = model.requests.length;
    expect((await post('/v1/main-offer/niche', memberToken, { parts: {} })).statusCode).toBe(403);
    const off = await post('/v1/main-offer/niche', ownerToken, { parts: {} });
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toMatchObject({ rule: 'main_offer_not_in_use' });
    expect(off.json().error.message).toContain('Social Outreach');
    expect(model.requests.length).toBe(asked);
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${ws}, 'outreach', 'enabled', ${catalogAddon('outreach').version})`,
    );
  });

  it('finds a niche from the best customer, once each', async () => {
    const res = await post('/v1/main-offer/niche', ownerToken, { parts: complete });
    expect(res.statusCode).toBe(200);
    expect(res.json().options.map((o: { work: string }) => o.work)).toEqual([
      'Roofing',
      'Roofing owners',
    ]);
    const [used] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_usage where workspace_id = ${ws} and source = 'main_offer'
            and user_id = ${owner.id}`,
    );
    expect(used?.n).toBe(1);
  });

  it('helps with a part, and never makes up proof', async () => {
    const words = await post('/v1/main-offer/assist', ownerToken, {
      path: 'outcome.why',
      mode: 'write',
      parts: complete,
    });
    expect(words.json()).toEqual({
      options: [1, 2, 3].map((n) => `Option ${n} for why the result matters to them`),
      steps: [],
    });
    const method = await post('/v1/main-offer/assist', ownerToken, {
      path: 'method.steps',
      mode: 'improve',
      parts: complete,
    });
    expect(method.json().steps).toEqual([
      ['Look at what they have', 'Make a plan', 'Do the work', 'Check the results'],
      ['Free call', 'Plan', 'Done for you'],
    ]);
    const asked = model.requests.length;
    const proof = await post('/v1/main-offer/assist', ownerToken, {
      path: 'proof',
      mode: 'write',
      parts: { ...complete, proof: [] },
    });
    expect(proof.statusCode).toBe(422);
    expect(proof.json().error).toMatchObject({ rule: 'main_offer_no_proof' });
    expect(model.requests.length).toBe(asked);
  });

  it('scores the draft as it’s kept, for that draft only, and lets it go live', async () => {
    const nothing = await post('/v1/main-offer/score', ownerToken, { revision: 0 });
    expect(nothing.json().error).toMatchObject({ rule: 'main_offer_no_draft' });
    // A placeholder left in the price holds it under the bar.
    const draft = { ...complete, price: { amount: '[price] a month' } };
    const { output } = await executeCommand(
      api(),
      mainOfferSaveDraft,
      { workspaceId: ws, revision: 0, parts: draft },
      actor(owner),
      meta(),
    );
    const stale = await post('/v1/main-offer/score', ownerToken, { revision: 0 });
    expect(stale.json().error).toMatchObject({ rule: 'main_offer_draft_moved' });

    const res = await post('/v1/main-offer/score', ownerToken, { revision: output.revision });
    expect(res.statusCode).toBe(200);
    const { saved, score } = res.json();
    expect(saved).toBe(true);
    expect(score.parts.price.score).toBe(6);
    expect(score.parts.who.score).toBe(8);
    expect(score.weakest).toBe('price');
    const request = model.requests.at(-1)!;
    expect(request.system).toBe(OFFER_SCORE_SYSTEM);
    expect(request.messages[0]!.content).toContain('Price: [price] a month');

    const kept = await executeQuery(api(), mainOfferGet, { workspaceId: ws }, actor(owner), meta());
    expect(kept.draft?.score?.parts.price.score).toBe(6);
    const live = await executeCommand(
      api(),
      mainOfferPublish,
      { workspaceId: ws, revision: output.revision, anyway: 'Price comes after the first call' },
      actor(owner),
      meta(),
    );
    expect(live.output).toEqual({ version: 1 });
  });
});
