import { randomUUID } from 'node:crypto';
import {
  createTokenVerifier,
  executeCommand,
  organizationCreate,
  pipelineCreate,
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
 * "Describe it, AI drafts" (POST /v1/funnels/draft): only for people who manage the teammate; on a pipeline the
 * business has, the draft uses its stages' names; on none, its own; the tokens counted as funnel use; and nothing
 * saved.
 */

const env = testEnv();
const admin = () => testDbs().admin.db;

const DESCRIPTION =
  'New leads get a text with a link to start. Qualified people book a presentation, and we remind them before.';

let owner: TestUser;
let member: TestUser;
let ownerToken: string;
let memberToken: string;
let ws: string;
let pipelineId: string;
let app: FastifyInstance;

const post = (token: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/funnels/draft',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws, description: DESCRIPTION, ...payload },
  });

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('funnel-draft-owner'),
    createTestUser('funnel-draft-member'),
  ]);
  const actor = {
    type: 'human' as const,
    userId: owner.id,
    email: owner.email,
    claims: owner.claims,
  };
  const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Robbins Recruiting' },
    actor,
    meta(),
  );
  ws = output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  const made = await executeCommand(
    testDbs().api.db,
    pipelineCreate,
    {
      workspaceId: ws,
      name: 'Recruiting',
      stages: [
        { name: 'New lead', kind: 'open' },
        { name: 'Booked a "presentation"', kind: 'open' },
        { name: 'Joined', kind: 'won' },
        { name: 'Out', kind: 'lost' },
      ],
    },
    actor,
    meta(),
  );
  pipelineId = made.output.pipelineId;
  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
  const s = testServices({ ai: { provider: scriptedAi() } });
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

interface Draft {
  name: string;
  stages: {
    name: string;
    kind: string;
    moves: { kind: string; to: string }[];
    messages: unknown[];
  }[];
  entry: { rules: { kind: string }[]; byHand: boolean };
}

describe('drafting a funnel from a description', () => {
  it('is for people who manage the teammate', async () => {
    const res = await post(memberToken, {});
    expect(res.statusCode).toBe(403);
  });

  it('uses the pipeline’s stages, by their names, and counts the tokens as funnel use', async () => {
    const res = await post(ownerToken, { pipelineId });
    expect(res.statusCode).toBe(200);
    const { draft } = res.json() as { draft: Draft };
    expect(draft.stages.map((s) => [s.name, s.kind])).toEqual([
      ['New lead', 'open'],
      ['Booked a "presentation"', 'open'],
      ['Joined', 'won'],
      ['Out', 'lost'],
    ]);
    expect(draft.stages[0]!.moves).toContainEqual(
      expect.objectContaining({ kind: 'event', to: 'Booked a "presentation"' }),
    );
    expect(draft.stages[0]!.messages).toHaveLength(1);
    expect(draft.entry).toMatchObject({ rules: [{ kind: 'new_lead' }], byHand: true });
    const [used] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_usage where workspace_id = ${ws}
            and source = 'funnel' and user_id = ${owner.id}`,
    );
    expect(used?.n).toBe(1);
    // Nothing is saved: funnel.create keeps it.
    const [funnels] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.funnels where workspace_id = ${ws}`,
    );
    expect(funnels?.n).toBe(0);
  });

  it('names its own stages without a pipeline', async () => {
    const res = await post(ownerToken, {});
    expect(res.statusCode).toBe(200);
    const { draft } = res.json() as { draft: Draft };
    expect(draft.stages.map((s) => s.kind)).toEqual(['open', 'open', 'won', 'lost']);
  });

  it('says so when the description is too short, or the pipeline isn’t there', async () => {
    const short = await post(ownerToken, { description: 'Text them.' });
    expect(short.statusCode).toBe(400);
    const gone = await post(ownerToken, { pipelineId: randomUUID() });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.message).toMatch(/pipeline isn’t there/);
  });
});
