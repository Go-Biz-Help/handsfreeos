/**
 * M10 step 6b, the worker's HTTP answers for clients that keep a queue (the phone):
 * - **The Assistant's consent:** a question from someone who hasn't said OK is refused before anything is sent to the
 *   model, in plain words, with disposition "ask" and the command that answers it; after the OK the question goes.
 * - **Every error body carries a disposition,** the same shape as the API's: a refusal as sent is final; the carrier not
 *   answering, a server error, too many at once and a session to refresh are retried; an unknown route is final.
 */
import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_CONSENT_VERSION,
  assistantConsent,
  createTokenVerifier,
  executeCommand,
  organizationCreate,
  type AssistantEvent,
  type HumanActor,
} from '@hfos/core/server';
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
import { scriptedAssistant } from '../src/assistant/scripted';
import { createToolExecutor } from '../src/assistant/tools-write';
import { buildHttpServer } from '../src/http/server';
import { ProviderError } from '../src/telephony/provider';
import { testServices } from './helpers';

const env = testEnv();
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let token: string;
let workspaceId: string;
let app: FastifyInstance;
let searches: 'ok' | 'carrier_down' | 'broken' = 'ok';

beforeAll(async () => {
  owner = await createTestUser('worker-errors-owner');
  workspaceId = (
    await executeCommand(
      testDbs().api.db,
      organizationCreate,
      { businessName: 'Worker Errors HVAC' },
      actor(owner),
      meta(),
    )
  ).output.workspaceId;
  token = await signInTestUser(owner);
  const s = testServices();
  const httpDb = testDbs().worker.db;
  const telephony = {
    ...s.telephony,
    async searchNumbers() {
      if (searches === 'carrier_down')
        throw new ProviderError('Service Unavailable', '20503', false, 503);
      if (searches === 'broken') throw new Error('something unexpected');
      return [];
    },
  };
  app = await buildHttpServer({
    ...s,
    telephony,
    httpDb,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    assistant: {
      provider: scriptedAssistant(),
      tools: createToolExecutor(httpDb),
    },
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

const askAssistant = () =>
  app.inject({
    method: 'POST',
    url: '/v1/assistant/messages',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId, text: 'What needs attention?' },
  });

describe('the Assistant’s consent', () => {
  it('asks for the OK before the first question, then answers', async () => {
    const refused = await askAssistant();
    expect(refused.statusCode).toBe(409);
    expect(refused.headers['content-type']).toMatch(/application\/json/);
    expect(refused.json()).toEqual({
      error: {
        code: 'rule_violation',
        rule: 'assistant_consent_required',
        message:
          'The Assistant sends what you ask about to an AI service to answer you. Say OK once, on the web or your phone, and it won’t ask again.',
        details: { version: ASSISTANT_CONSENT_VERSION, command: 'assistant.consent' },
        disposition: 'ask',
      },
    });
    await executeCommand(
      testDbs().api.db,
      assistantConsent,
      { version: ASSISTANT_CONSENT_VERSION },
      actor(owner),
      meta(),
    );
    const answered = await askAssistant();
    expect(answered.statusCode).toBe(200);
    const events = answered.body
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantEvent);
    expect(events[0]).toMatchObject({ type: 'run' });
  });
});

describe('error bodies', () => {
  const search = (
    headers: Record<string, string> = { authorization: `Bearer ${token}` },
    body: unknown = { workspaceId, numberType: 'local' },
  ) =>
    app.inject({
      method: 'POST',
      url: '/v1/telephony/available-numbers',
      headers,
      payload: body as object,
    });

  it('says what a queue should do with each', async () => {
    const unsigned = await search({});
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().error).toMatchObject({ code: 'unauthenticated', disposition: 'retry' });

    const invalid = await search(undefined, { workspaceId, numberType: 'mobile' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatchObject({ code: 'validation', disposition: 'final' });

    const notJson = await app.inject({
      method: 'POST',
      url: '/v1/telephony/available-numbers',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/xml' },
      payload: '<search/>',
    });
    expect(notJson.statusCode).toBe(415);
    expect(notJson.json().error).toMatchObject({ code: 'validation', disposition: 'final' });

    searches = 'carrier_down';
    const carrier = await search();
    expect(carrier.statusCode).toBe(502);
    expect(carrier.json()).toEqual({
      error: {
        code: 'internal',
        message: 'The phone carrier did not answer. Try again in a minute.',
        disposition: 'retry',
      },
    });

    searches = 'broken';
    const broken = await search();
    expect(broken.statusCode).toBe(500);
    expect(broken.json()).toEqual({
      error: {
        code: 'internal',
        message: 'Something went wrong on our side. Try again in a minute.',
        disposition: 'retry',
      },
    });
    searches = 'ok';

    const nowhere = await app.inject({ method: 'POST', url: '/v1/nothing-here', payload: {} });
    expect(nowhere.statusCode).toBe(404);
    expect(nowhere.json().error).toMatchObject({ code: 'not_found', disposition: 'final' });

    const hook = await app.inject({
      method: 'POST',
      url: `/webhooks/workflows/${'x'.repeat(40)}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(hook.statusCode).toBe(404);
    expect(hook.json().error).toMatchObject({ code: 'not_found', disposition: 'final' });
  });
});
