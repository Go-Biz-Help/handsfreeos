import { randomUUID } from 'node:crypto';
import { AiProviderError, ScriptedProvider, type AiProvider } from '@hfos/ai';
import { executeCommand, organizationCreate, type HumanActor } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiAskError, askStructured, THINKING_ROOM } from '../src/ai/ask';
import { aiBudget, chargeAssistantRun, recordAiUsage, recordAndChargeAi } from '../src/ai/budget';
import { setAiLimit, testServices } from './helpers';

/** The one daily AI limit per business, which it sets itself in dollars, and askStructured, which every AI call outside the Assistant uses. */

const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const admin = () => testDbs().admin.db;
const worker = () => testDbs().worker.db;
const log = testServices().log;
// Shadow: the charge is written for real, and nothing here is about what it decides.
const wallet = () => ({ db: worker(), log, mode: 'shadow' as const });

let owner: TestUser;
let scope: { workspaceId: string; organizationId: string };

beforeAll(async () => {
  owner = await createTestUser('ai-budget-owner');
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Budget Test HVAC' },
    actor(owner),
    { correlationId: randomUUID(), channel: 'test' },
  );
  scope = { workspaceId: output.workspaceId, organizationId: output.organizationId };
});
afterAll(closeTestDbs);

const usageRows = async () =>
  (
    await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_usage where workspace_id = ${scope.workspaceId} and source = 'builder'`,
    )
  )[0]!.n;

/** What the business was charged for one entity's AI, in cents (negative is spend). */
const chargedFor = async (entityId: string) =>
  (
    await rows<{ subject: string; amount_cents: number | string }>(
      admin(),
      sql`select subject, amount_cents from app.usage_ledger
          where workspace_id = ${scope.workspaceId} and entity_id = ${entityId}`,
    )
  ).map((r) => ({ subject: r.subject, cents: Number(r.amount_cents) }));

describe('one daily AI limit per business, in dollars', () => {
  it('counts the Assistant’s runs and every other AI call, today only, priced as it’s charged', async () => {
    expect(await aiBudget.today(worker(), scope)).toEqual({
      limitCents: 1000,
      spentCents: 0,
      teammateCents: 0,
    });
    const [thread] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.assistant_threads (workspace_id, user_id, title)
          values (${scope.workspaceId}, ${owner.id}, 'Budget') returning id`,
    );
    // Ask HandsFreeOS on Claude Opus: 100,000 input tokens at $6 a million is 60¢. The run two days ago doesn't count.
    await rows(
      admin(),
      sql`insert into app.assistant_runs (workspace_id, user_id, thread_id, model, correlation_id, status, ended_at,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at)
          values (${scope.workspaceId}, ${owner.id}, ${thread!.id}, 'claude-opus-5-5', gen_random_uuid(), 'done',
                  now(), 100000, 0, 0, 0, now()),
                 (${scope.workspaceId}, ${owner.id}, ${thread!.id}, 'claude-opus-5-5', gen_random_uuid(), 'done',
                  now() - interval '2 days', 9000000, 0, 0, 0, now() - interval '2 days')`,
    );
    // The card's AI lines: 90¢ + 60¢ + 3¢ + 3¢.
    await asWorker(worker(), scope, (tx) =>
      recordAiUsage(tx, {
        source: 'knowledge',
        userId: owner.id,
        model: 'claude-sonnet-5',
        usage: {
          inputTokens: 300_000,
          outputTokens: 40_000,
          cacheReadTokens: 100_000,
          cacheWriteTokens: 8_000,
        },
      }),
    );
    await rows(
      admin(),
      sql`insert into app.ai_usage (workspace_id, source, model, input_tokens, created_at)
          values (${scope.workspaceId}, 'builder', 'claude-sonnet-5', 7000000, now() - interval '2 days')`,
    );
    const today = await aiBudget.today(worker(), scope);
    expect(today.spentCents).toBeCloseTo(216, 6);
    expect(today.limitCents).toBe(1000);
    expect(await aiBudget.reached(worker(), scope)).toBeNull();
    const [row] = await rows(
      admin(),
      sql`select source::text as source, user_id, model from app.ai_usage
          where workspace_id = ${scope.workspaceId} and created_at > now() - interval '1 hour'`,
    );
    expect(row).toEqual({ source: 'knowledge', user_id: owner.id, model: 'claude-sonnet-5' });
  });

  it('is the business’s own number: under it there’s room, at it the AI says so and where to raise it', async () => {
    const was = await setAiLimit(scope.workspaceId, 200);
    try {
      expect(await aiBudget.reached(worker(), scope)).toBe(
        'This business reached the $2 daily AI limit, so the AI is paused until midnight. An owner or admin can raise the limit in Settings → Usage & balance.',
      );
      await setAiLimit(scope.workspaceId, 5000);
      expect(await aiBudget.reached(worker(), scope)).toBeNull();
    } finally {
      await setAiLimit(scope.workspaceId, was);
    }
  });

  it('keeps the teammate to its share of the limit', async () => {
    const [teammate] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.ai_teammates (workspace_id, name) values (${scope.workspaceId}, 'Budget Ava')
          returning id`,
    );
    const room = (sharePercent: number) =>
      aiBudget.teammateHasRoom(worker(), scope, { teammateId: teammate!.id, sharePercent });
    expect(await room(60)).toBe(true);
    // 200,000 input tokens at $3 a million: 60¢, which is 6% of the $10 limit.
    await rows(
      admin(),
      sql`insert into app.ai_usage (workspace_id, source, teammate_id, model, input_tokens)
          values (${scope.workspaceId}, 'teammate', ${teammate!.id}, 'claude-sonnet-5', 200000)`,
    );
    expect(await room(10)).toBe(true);
    expect(await room(5)).toBe(false);
  });

  it('charges Claude Opus (Ask HandsFreeOS) from its own lines, and other models from the card’s AI lines', async () => {
    const usage = {
      inputTokens: 100_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const deps = { db: worker(), log, wallet: wallet() };
    await recordAndChargeAi(deps, scope, {
      source: 'assistant',
      userId: owner.id,
      model: 'claude-opus-5-5',
      usage,
    });
    await recordAndChargeAi(deps, scope, {
      source: 'knowledge',
      userId: owner.id,
      model: 'claude-sonnet-5',
      usage,
    });
    const charged = await rows<{ subject: string; amount_cents: number | string }>(
      admin(),
      sql`select l.subject, l.amount_cents from app.usage_ledger l
          join app.ai_usage u on u.id = l.entity_id
          where l.workspace_id = ${scope.workspaceId} and l.entity_type = 'ai_usage'
            and u.input_tokens = 100000 and u.source in ('assistant', 'knowledge')`,
    );
    expect(charged.map((r) => ({ subject: r.subject, cents: Number(r.amount_cents) }))).toEqual(
      expect.arrayContaining([
        { subject: 'Ask HandsFreeOS getting ready', cents: -60 },
        { subject: 'AI reading your knowledge', cents: -30 },
      ]),
    );
  });

  it('charges each Ask HandsFreeOS question once, when its run ends, and nothing for one that spent nothing', async () => {
    const runId = randomUUID();
    const usage = {
      inputTokens: 2_300,
      outputTokens: 500,
      cacheReadTokens: 109_000,
      cacheWriteTokens: 13_000,
    };
    await chargeAssistantRun({ wallet: wallet() }, scope, {
      runId,
      model: 'claude-opus-5-5',
      usage,
    });
    // A retry of the same run is the same charge.
    await chargeAssistantRun({ wallet: wallet() }, scope, {
      runId,
      model: 'claude-opus-5-5',
      usage,
    });
    // 1.38¢ + 1.5¢ + 3.27¢ + 9.75¢, rounded once.
    expect(await chargedFor(runId)).toEqual([
      { subject: 'Ask HandsFreeOS answering a question', cents: -16 },
    ]);
    const empty = randomUUID();
    await chargeAssistantRun({ wallet: wallet() }, scope, {
      runId: empty,
      model: 'claude-opus-5-5',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(await chargedFor(empty)).toEqual([]);
  });
});

describe('askStructured', () => {
  const Answer = z.object({ answer: z.string().min(1) });
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  };
  const ask = (text: string) => ({
    system: 'Answer briefly.',
    messages: [{ role: 'user' as const, content: text }],
    schema,
    zod: Answer,
    usage: { source: 'builder' as const, userId: owner.id },
  });
  const scripted = new ScriptedProvider([
    { when: /hello/, json: () => ({ answer: 'Hi there' }) },
    { when: /broken/, json: () => ({ nope: true }) },
  ]);
  const ctx = (provider: AiProvider | null) => ({
    db: worker(),
    ai: { provider },
    log,
    wallet: wallet(),
  });
  const failing = (error: AiProviderError): AiProvider => ({
    id: 'failing',
    model: 'failing',
    stream: async () => {
      throw error;
    },
  });

  it('answers in the schema and records the tokens it spent', async () => {
    const before = await usageRows();
    const out = await askStructured(ctx(scripted), scope, ask('hello'));
    expect(out).toMatchObject({ value: { answer: 'Hi there' }, model: 'scripted' });
    expect(out.usage.inputTokens).toBeGreaterThan(0);
    expect(await usageRows()).toBe(before + 1);
  });

  it('says why there is no answer: no model, the daily AI limit, a provider error or a bad answer', async () => {
    await expect(askStructured(ctx(null), scope, ask('hello'))).rejects.toMatchObject({
      code: 'ai_unavailable',
    });
    const was = await setAiLimit(scope.workspaceId, 0);
    try {
      const overBudget = askStructured(ctx(scripted), scope, ask('hello'));
      await expect(overBudget).rejects.toBeInstanceOf(AiAskError);
      await expect(overBudget).rejects.toMatchObject({
        code: 'budget_reached',
        message: expect.stringMatching(/paused until midnight.*Settings → Usage & balance/),
      });
    } finally {
      await setAiLimit(scope.workspaceId, was);
    }

    const before = await usageRows();
    await expect(
      askStructured(
        ctx(failing(new AiProviderError('Overloaded', 'overloaded', true, 529))),
        scope,
        ask('hello'),
      ),
    ).rejects.toMatchObject({ code: 'provider_error', retryable: true });
    await expect(
      askStructured(
        ctx(failing(new AiProviderError('Bad request', 'bad_request', false, 400))),
        scope,
        ask('hello'),
      ),
    ).rejects.toMatchObject({ code: 'provider_error', retryable: false });
    expect(await usageRows()).toBe(before);

    // A wrong-shaped answer still spent tokens, so they count.
    await expect(askStructured(ctx(scripted), scope, ask('broken'))).rejects.toMatchObject({
      code: 'bad_output',
      retryable: false,
    });
    expect(await usageRows()).toBe(before + 1);
  });

  it('gives the model room to think on top of the answer, so the answer isn’t cut off', async () => {
    const asked: (number | undefined)[] = [];
    const recording: AiProvider = {
      id: 'recording',
      model: scripted.model,
      stream: (request, options) => {
        asked.push(request.maxTokens);
        return scripted.stream(request, options);
      },
    };
    await askStructured(ctx(recording), scope, { ...ask('hello'), maxTokens: 300 });
    await askStructured(ctx(recording), scope, ask('hello'));
    expect(asked).toEqual([300 + THINKING_ROOM, 2048 + THINKING_ROOM]);
  });
});
