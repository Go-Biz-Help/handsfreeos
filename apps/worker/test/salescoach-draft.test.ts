/**
 * AI Sales Coach's playbook to start from (`salescoach.playbook.draft`), through the worker's actions route against
 * the stand-in model: the business's own script tidied into steps, or one built the question-led way from what the
 * business says about itself and the owner's answers, each step with its stage, numbered and held to the limits. And
 * what the builder can already answer (`salescoach.playbook.brief`). Owners and admins only, as they write the
 * playbooks.
 */
import { salescoachAddon } from '@hfos/core/addons/salescoach/manifest';
import { createTokenVerifier, executeCommand, organizationCreate } from '@hfos/core/server';
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
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

let app: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let ws: string;

const act = async (name: string, u: TestUser, input: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/v1/addons/salescoach/actions/${name}`,
    headers: { authorization: `Bearer ${await signInTestUser(u)}` },
    payload: { workspaceId: ws, input },
  });
const draft = (u: TestUser, input: Record<string, unknown>) =>
  act('salescoach.playbook.draft', u, input);

beforeAll(async () => {
  const s = testServices({ ai: { provider: scriptedAi() } });
  [owner, member] = await Promise.all([
    createTestUser('coach-draft-owner'),
    createTestUser('coach-draft-member'),
  ]);
  ws = (
    await executeCommand(
      testDbs().api.db,
      organizationCreate,
      { businessName: 'Coach Draft Co' },
      { type: 'human', userId: owner.id, email: owner.email, claims: owner.claims },
      { correlationId: randomUUID(), channel: 'test' },
    )
  ).output.workspaceId;
  await rows(
    testDbs().admin.db,
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  await rows(
    testDbs().admin.db,
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, 'salescoach', 'enabled', ${salescoachAddon.version})`,
  );
  const env = testEnv();
  app = await buildHttpServer({
    ...s,
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

describe('a playbook to start from', () => {
  it('tidies the business’s own script into numbered steps', async () => {
    const res = await draft(owner, {
      kind: 'first_call',
      script: 'Greet them by name\nAsk what’s going on\nOffer Thursday',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'Our script',
      details: {
        steps: [
          { id: 's1', title: 'Greet them by name' },
          { id: 's2', title: 'Ask what’s going on' },
          { id: 's3', title: 'Offer Thursday' },
        ],
        objections: [{ id: 'o1', objection: 'It’s too expensive' }],
      },
    });
  });

  it('builds one the question-led way when there’s no script, a stage on every step', async () => {
    const res = await draft(owner, { kind: 'estimate' });
    expect(res.statusCode).toBe(200);
    const { name, details } = res.json();
    expect(name).toBe('Going over an estimate');
    expect(details.steps.map((st: { stage: string }) => st.stage)).toEqual([
      'connect',
      'situation',
      'problem',
      'future',
      'consequence',
      'importance',
      'bridge',
      'present',
      'commit',
    ]);
  });

  it('writes the owner’s answers in', async () => {
    const res = await draft(owner, {
      kind: 'aged_lead',
      brief: { offer: 'a new roof', problems: 'leaks every storm' },
    });
    expect(res.statusCode).toBe(200);
    const { name, details } = res.json();
    expect(name).toBe('Older lead');
    expect(details.steps[0].say).toContain('a new roof');
    expect(details.steps[2].say).toContain('leaks every storm');
  });

  it('keeps a pasted script’s steps without stages', async () => {
    const res = await draft(owner, { kind: 'cold_call', script: 'Say hi\nAsk for the owner' });
    expect(res.json().details.steps.map((st: { stage: unknown }) => st.stage)).toEqual([
      null,
      null,
    ]);
  });

  it('is for the people who write the playbooks', async () => {
    expect((await draft(member, { kind: 'first_call' })).statusCode).toBe(403);
  });
});

describe('what the builder already knows', () => {
  it('answers what it can and leaves the rest for the owner', async () => {
    const res = await act('salescoach.playbook.brief', owner, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      brief: {
        offer: expect.any(String),
        buyers: '',
        problems: '',
        result: '',
        why: '',
        nextStep: '',
      },
    });
  });

  it('is for the people who write the playbooks', async () => {
    expect((await act('salescoach.playbook.brief', member, {})).statusCode).toBe(403);
  });
});
