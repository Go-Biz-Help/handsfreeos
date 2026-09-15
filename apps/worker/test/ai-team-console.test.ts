/**
 * The builder's test console (M7 step 7), POST /v1/ai-team/test, on the real database with the scripted model:
 * it needs ai_team.manage; it streams the reply, the look-ups and the checks in the web adapter's event contract
 * (apps/web/src/lib/ai-team/test-stream.ts); a booking is only described, and nothing is sent, booked or stored
 * but the test run and its tokens; it tests the builder's unsaved settings; an emergency gets the safety text;
 * and at the AI limit it refuses with 429.
 */
import { createTokenVerifier, EMERGENCY_SAFETY_TEXT, parseTeammateConfig } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, signInTestUser, testDbs, testEnv } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { jobs } from '../src/scheduled';
import {
  admin,
  appointmentsOf,
  newCustomer,
  teammateRequests,
  teammateWorld,
  textsTo,
  type TeammateWorld,
} from './ai-team-world';

const env = testEnv();
let w: TeammateWorld;
let app: FastifyInstance;
let ownerToken: string;
let memberToken: string;

type Event = Record<string, unknown> & { type: string };

beforeAll(async () => {
  w = await teammateWorld('tmconsole', {
    preset: 'appointment_coordinator',
    calendar: 'Tune-ups',
    status: 'automatic',
  });
  app = await buildHttpServer({
    ...w.s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    // Its use-budget route, so the share it uses up is counted against the same daily limit.
    testRoutes: { jobs },
  });
  const member = await createTestUser('tmconsole-member', { fullName: 'Marco Member' });
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${w.workspaceId}, ${member.id}, 'member')`,
  );
  [ownerToken, memberToken] = await Promise.all([signInTestUser(w.owner), signInTestUser(member)]);
});
afterAll(async () => {
  await app.close();
  await w.app.close();
  await closeTestDbs();
});

function test(
  token: string | null,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/ai-team/test',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: {
      workspaceId: w.workspaceId,
      personId: null,
      channel: 'sms',
      at: null,
      config: null,
      ...body,
    },
  });
}

const eventsOf = (res: LightMyRequestResponse): Event[] =>
  res.body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Event);

const says = (text: string) => ({ messages: [{ from: 'customer', text }] });

describe('the test console', () => {
  it('needs someone who manages the AI teammate', async () => {
    expect((await test(null, says('Hi'))).statusCode).toBe(401);
    const res = await test(memberToken, says('Hi'));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('streams a booking it only describes, and sends, books and stores nothing but the test run', async () => {
    const c = await newCustomer(w, 'Ken');
    const res = await test(ownerToken, {
      personId: c.id,
      ...says('Can you book me in for Thursday?'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const events = eventsOf(res);
    expect(events[0]).toMatchObject({ type: 'started', runId: expect.any(String) });
    const types = new Set(events.map((e) => e.type));
    for (const t of ['context', 'knowledge', 'tool', 'would', 'delta', 'check', 'done'])
      expect(types).toContain(t);
    expect(events.find((e) => e.type === 'context')).toMatchObject({ title: 'Read who Ken is' });
    expect(events.find((e) => e.type === 'tool')).toMatchObject({ name: 'find_times' });
    expect(events.find((e) => e.type === 'would')).toMatchObject({
      kind: 'book',
      summary: expect.stringMatching(/^booked Thu/),
    });
    expect(events.find((e) => e.type === 'check')).toMatchObject({ ok: true, rewritten: false });
    const done = events[events.length - 1]!;
    expect(done).toMatchObject({ type: 'done', outcome: 'replied', draft: false });
    expect(done['reply']).toMatch(/You're booked for Thu/);

    // Nothing happened for real.
    expect(await appointmentsOf(c.id)).toHaveLength(0);
    expect(textsTo(w, c.phone)).toHaveLength(0);
    const convs = await rows(
      admin(),
      sql`select 1 from app.conversations where person_id = ${c.id}`,
    );
    expect(convs).toHaveLength(0);
    const runId = String(events[0]!['runId']);
    const [r] = await rows<{
      status: string;
      outcome: string;
      is_test: boolean;
      triggered_by: string;
      conversation_id: string | null;
      input_tokens: number;
    }>(
      admin(),
      sql`select status, outcome, is_test, triggered_by, conversation_id, input_tokens
          from app.ai_teammate_runs where id = ${runId}`,
    );
    expect(r).toMatchObject({
      status: 'done',
      outcome: 'replied',
      is_test: true,
      triggered_by: 'test',
      conversation_id: null,
    });
    expect(r!.input_tokens).toBeGreaterThan(0);
    const calls = await rows(
      admin(),
      sql`select 1 from app.ai_teammate_tool_calls where run_id = ${runId}`,
    );
    expect(calls).toHaveLength(0);
  });

  it('tests the builder’s unsaved settings, and says what’s wrong with unreadable ones', async () => {
    const [saved] = await rows<{ config: unknown }>(
      admin(),
      sql`select config from app.ai_teammates where id = ${w.teammateId}`,
    );
    const config = parseTeammateConfig(saved!.config);
    const draft = { ...config, identity: { ...config.identity, name: 'Rex' } };
    const res = await test(ownerToken, { config: draft, ...says('Are you a robot?') });
    const done = eventsOf(res).pop()!;
    expect(done['reply']).toContain("I'm Rex, an AI assistant");

    const bad = await test(ownerToken, {
      config: { ...config, limits: { ...config.limits, dailySharePercent: 1 } },
      ...says('Hi'),
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toContain('config.limits.dailySharePercent');
  });

  it('answers an emergency with the safety text, never asking the model', async () => {
    const asked = teammateRequests(w).length;
    const res = await test(ownerToken, says('I smell gas in my kitchen'));
    const events = eventsOf(res);
    expect(events.find((e) => e.type === 'would')).toMatchObject({ kind: 'hand_off' });
    expect(events[events.length - 1]).toMatchObject({
      type: 'done',
      outcome: 'handed_off',
      reply: EMERGENCY_SAFETY_TEXT.gas,
    });
    expect(teammateRequests(w)).toHaveLength(asked);
  });

  // Last: the share stays used up for the rest of the business's day.
  it('refuses with 429 once the teammate has used its share of the AI limit', async () => {
    const used = await app.inject({
      method: 'POST',
      url: '/test/ai-team/use-budget',
      payload: { workspaceId: w.workspaceId },
    });
    expect(used.statusCode, used.body).toBe(200);
    const res = await test(ownerToken, says('Hi'));
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { rule: 'ai_limit' } });
  });
});
