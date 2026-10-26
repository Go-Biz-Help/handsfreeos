import { randomUUID } from 'node:crypto';
import {
  assistantThreadGet,
  assistantTools,
  createTokenVerifier,
  executeCommand,
  executeQuery,
  leadCreate,
  organizationCreate,
  personCreate,
  reconcile,
  type AssistantEvent,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
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
import { consentToAssistant } from './assistant-consent';
import type { AiProvider, AiRequest } from '@hfos/ai';
import { SPOKEN } from '../src/assistant/prompt';
import { scriptedAssistant } from '../src/assistant/scripted';
import { createToolExecutor, executorFor } from '../src/assistant/tools-write';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

const env = testEnv();
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let ownerToken: string;
let memberToken: string;
let workspaceId: string;
let organizationId: string;
let mikeId: string;
let leadId: string;
let app: FastifyInstance;

async function build(
  assistant: 'scripted' | null,
  dailyTokens = 5_000_000,
  provider: AiProvider = scriptedAssistant(),
): Promise<FastifyInstance> {
  const s = testServices();
  const httpDb = testDbs().worker.db;
  return buildHttpServer({
    ...s,
    httpDb,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    assistant: assistant ? { provider, tools: createToolExecutor(httpDb), dailyTokens } : null,
  });
}

/** Asks one question and returns the server-sent events it streamed. */
async function ask(
  token: string,
  text: string,
  extra: Record<string, unknown> = {},
  server: FastifyInstance = app,
): Promise<AssistantEvent[]> {
  const res = await server.inject({
    method: 'POST',
    url: '/v1/assistant/messages',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId, text, ...extra },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  return res.body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantEvent);
}
const cardsOf = (events: AssistantEvent[]) =>
  events.flatMap((e) => (e.type === 'card' ? [e.card] : []));
const textOf = (events: AssistantEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
const decide = (
  token: string,
  id: string,
  action: 'confirm' | 'cancel' | 'undo',
  body: Record<string, unknown> = {},
) =>
  app.inject({
    method: 'POST',
    url: `/v1/assistant/tool-calls/${id}/${action}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId, ...body },
  });
const toolCall = async (id: string) =>
  (
    await rows<{ status: string; result: Record<string, unknown> | null }>(
      admin(),
      sql`select status, result from app.assistant_tool_calls where id = ${id}`,
    )
  )[0]!;

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('assistant-owner'),
    createTestUser('assistant-member'),
    createTestUser('assistant-outsider'),
  ]);
  await consentToAssistant(owner, member, outsider);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Assistant Test HVAC' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${member.id}, 'member')`,
  );
  mikeId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId, firstName: 'Mike', lastName: 'Johnson', phone: '(713) 555-0142' },
      actor(owner),
      meta(),
    )
  ).output.personId;
  leadId = (
    await executeCommand(
      api(),
      leadCreate,
      { workspaceId, title: 'Roof replacement', personId: mikeId, valueCents: 1_250_000 },
      actor(owner),
      meta(),
    )
  ).output.leadId;
  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
  app = await build('scripted');
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('the Assistant', () => {
  it('has an executor for every tool it can offer', () => {
    expect(assistantTools.map((t) => t.name).filter((n) => !executorFor(n))).toEqual([]);
  });

  it('writes its answer to be heard when the question was asked out loud', async () => {
    const contexts: string[] = [];
    const inner = scriptedAssistant();
    const listening = await build('scripted', 5_000_000, {
      ...inner,
      stream: (request, options) => {
        contexts.push(request.context ?? '');
        return inner.stream(request, options);
      },
    });
    try {
      await ask(ownerToken, 'What needs attention?', { spoken: true }, listening);
      expect(contexts.at(-1)).toContain(SPOKEN);
      await ask(ownerToken, 'What needs attention?', {}, listening);
      expect(contexts.at(-1)).not.toContain(SPOKEN);
    } finally {
      await listening.close();
    }
  });

  it('answers a question with a card built from real records', async () => {
    // The worker files the Action Center's items as things happen; here, the way it does it.
    await asWorker(testDbs().worker.db, { workspaceId, organizationId }, (tx) =>
      reconcile(tx, workspaceId, 'all', new Date()),
    );
    const events = await ask(ownerToken, 'What needs attention?');
    expect(events[0]).toMatchObject({ type: 'run' });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(events.some((e) => e.type === 'step' && e.status === 'done')).toBe(true);
    const attention = cardsOf(events).find((c) => c.type === 'attention');
    // The new lead has no next action, so it needs one.
    expect(
      attention?.type === 'attention' && attention.items.map((i) => [i.title, i.kind]),
    ).toContainEqual(['Mike Johnson · Roof replacement', 'missing_next_action']);
  });

  it('adds a task on its own, as the person, through the Assistant, with Undo', async () => {
    const events = await ask(ownerToken, 'Create a task to call Mike back tomorrow');
    expect(textOf(events)).toMatch(/on your list/);
    const done = cardsOf(events).find((c) => c.type === 'done');
    expect(done).toMatchObject({ type: 'done', kind: 'task', title: 'Call Mike back' });
    const callId = done!.type === 'done' ? done!.toolCallId : '';
    const [audit] = await rows<{ actor_id: string; channel: string }>(
      admin(),
      sql`select actor_id, channel from app.audit_logs where workspace_id = ${workspaceId} and action = 'task.create'
          order by created_at desc limit 1`,
    );
    expect(audit).toEqual({ actor_id: owner.id, channel: 'assistant' });
    const taskId = (await toolCall(callId)).result!['taskId'] as string;

    const undo = await decide(ownerToken, callId, 'undo');
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toMatchObject({
      status: 'done',
      undone: true,
      outcome: expect.stringMatching(/gone/),
    });
    expect(await rows(admin(), sql`select id from app.tasks where id = ${taskId}`)).toHaveLength(0);
    expect((await decide(ownerToken, callId, 'undo')).statusCode).toBe(409);
  });

  it('never texts without a number, and says why on the card', async () => {
    const events = await ask(ownerToken, 'Text him that Priya can come by at 4', {
      page: { type: 'person', id: mikeId },
    });
    const card = cardsOf(events).find((c) => c.type === 'confirm');
    expect(card).toMatchObject({ tool: 'send_text', confirmLabel: '', editable: false });
    expect(card?.type === 'confirm' && card.warnings[0]?.kind).toBe('blocked');
    expect(
      await rows(admin(), sql`select id from app.messages where workspace_id = ${workspaceId}`),
    ).toHaveLength(0);
  });

  it('moves a lead only after Confirm, once, and lets Cancel stop the next one', async () => {
    const page = { type: 'lead', id: leadId };
    const first = await ask(ownerToken, 'Move it to Contacted', { page });
    const card = cardsOf(first).find((c) => c.type === 'confirm');
    expect(card).toMatchObject({
      tool: 'move_lead',
      stageTo: 'Contacted',
      confirmLabel: 'Move lead',
    });
    const stageOf = async () =>
      (
        await rows<{ name: string }>(
          admin(),
          sql`select s.name from app.leads l join app.pipeline_stages s on s.id = l.stage_id where l.id = ${leadId}`,
        )
      )[0]!.name;
    expect(await stageOf()).not.toBe('Contacted');

    const id = card!.type === 'confirm' ? card!.toolCallId : '';
    const ok = await decide(ownerToken, id, 'confirm');
    expect(ok.json()).toMatchObject({ status: 'confirmed', outcome: 'Moved to Contacted' });
    expect(await stageOf()).toBe('Contacted');
    expect((await decide(ownerToken, id, 'confirm')).statusCode).toBe(409);
    const [audit] = await rows<{ actor_id: string; channel: string }>(
      admin(),
      sql`select actor_id, channel from app.audit_logs where workspace_id = ${workspaceId} and action = 'lead.move_stage'
          order by created_at desc limit 1`,
    );
    expect(audit).toEqual({ actor_id: owner.id, channel: 'assistant' });

    const second = await ask(ownerToken, 'Move it to Estimate sent', { page });
    const next = cardsOf(second).find((c) => c.type === 'confirm');
    const nextId = next!.type === 'confirm' ? next!.toolCallId : '';
    expect((await decide(ownerToken, nextId, 'cancel')).json()).toMatchObject({
      status: 'cancelled',
    });
    expect(await stageOf()).toBe('Contacted');
  });

  it('lets a card lapse when the person asks something else in the same chat', async () => {
    const first = await ask(ownerToken, 'Move it to Won', { page: { type: 'lead', id: leadId } });
    const threadId = first[0]!.type === 'run' ? first[0]!.threadId : '';
    const card = cardsOf(first).find((c) => c.type === 'confirm');
    const id = card!.type === 'confirm' ? card!.toolCallId : '';
    await ask(ownerToken, 'What needs attention?', { threadId });
    expect((await toolCall(id)).status).toBe('expired');
    expect((await decide(ownerToken, id, 'confirm')).statusCode).toBe(409);

    // The chat is saved: both questions, both answers, and the cards.
    const saved = await executeQuery(
      api(),
      assistantThreadGet,
      { workspaceId, threadId },
      actor(owner),
      meta(),
    );
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(saved.toolCalls.find((c) => c.id === id)?.status).toBe('expired');
  });

  it('keeps chats to their person, and outsiders out', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/assistant/messages',
      headers: { authorization: `Bearer ${await signInTestUser(outsider)}` },
      payload: { workspaceId, text: 'What needs attention?' },
    });
    expect(res.statusCode).toBe(403);
    const mine = await ask(memberToken, 'What needs attention?');
    const threadId = mine[0]!.type === 'run' ? mine[0]!.threadId : '';
    await expect(
      executeQuery(api(), assistantThreadGet, { workspaceId, threadId }, actor(owner), meta()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('answers one question at a time per person', async () => {
    const [thread] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.assistant_threads where user_id = ${member.id} limit 1`,
    );
    await rows(
      admin(),
      sql`insert into app.assistant_runs (workspace_id, user_id, thread_id, model, correlation_id)
          values (${workspaceId}, ${member.id}, ${thread!.id}, 'scripted', gen_random_uuid())`,
    );
    const events = await ask(memberToken, 'What needs attention?');
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'already_running' })]);
    await rows(
      admin(),
      sql`update app.assistant_runs set status = 'done' where user_id = ${member.id} and status = 'running'`,
    );
  });

  it('stops at the daily limit and says when it resets', async () => {
    const tiny = await build('scripted', 1);
    try {
      const events = await ask(ownerToken, 'What needs attention?', {}, tiny);
      expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'budget_reached' })]);
    } finally {
      await tiny.close();
    }
  });

  it('reads ahead when the panel opens, exactly what the next question sends, once in a while', async () => {
    const warmed: AiRequest[] = [];
    const asked: AiRequest[] = [];
    const inner = scriptedAssistant();
    const reading = await build('scripted', 5_000_000, {
      ...inner,
      stream: (request, options) => {
        asked.push(request);
        return inner.stream(request, options);
      },
      warm: async (request) => {
        warmed.push(request);
        return { inputTokens: 12, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 25_000 };
      },
    });
    const warm = () =>
      reading.inject({
        method: 'POST',
        url: '/v1/assistant/warm',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });
    try {
      expect((await warm()).json()).toEqual({ warmed: true });
      // What it read keeps for five minutes, so the panel opening again soon reads nothing.
      expect((await warm()).json()).toEqual({ warmed: false });
      expect(warmed).toHaveLength(1);
      await ask(ownerToken, 'What needs attention?', {}, reading);
      // The cache is found only when everything before the question is the same.
      expect(warmed[0]).toMatchObject({
        system: asked[0]!.system,
        lasting: asked[0]!.lasting,
        tools: asked[0]!.tools,
      });
      // Its tokens count toward the day's limit, as the Assistant's.
      expect(
        await rows(
          admin(),
          sql`select source::text, cache_write_tokens from app.ai_usage
              where workspace_id = ${workspaceId} and user_id = ${owner.id} and source = 'assistant'`,
        ),
      ).toEqual([{ source: 'assistant', cache_write_tokens: 25_000 }]);
    } finally {
      await reading.close();
    }
  });

  it('reads nothing ahead without their OK to use the AI', async () => {
    const newcomer = await createTestUser('assistant-newcomer');
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${newcomer.id}, 'member')`,
    );
    let warms = 0;
    const reading = await build('scripted', 5_000_000, {
      ...scriptedAssistant(),
      warm: async () => {
        warms += 1;
        return { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1 };
      },
    });
    try {
      const res = await reading.inject({
        method: 'POST',
        url: '/v1/assistant/warm',
        headers: { authorization: `Bearer ${await signInTestUser(newcomer)}` },
        payload: { workspaceId },
      });
      expect(res.json()).toEqual({ warmed: false });
      expect(warms).toBe(0);
    } finally {
      await reading.close();
    }
  });

  it('says it is not set up when no model is configured', async () => {
    const none = await build(null);
    try {
      const res = await none.inject({
        method: 'POST',
        url: '/v1/assistant/messages',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId, text: 'Hello' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: { rule: 'assistant_not_configured' } });
    } finally {
      await none.close();
    }
  });
});
