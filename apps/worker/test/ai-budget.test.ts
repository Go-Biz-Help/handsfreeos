import { randomUUID } from 'node:crypto';
import { AiProviderError, ScriptedProvider, type AiProvider } from '@hfos/ai';
import { executeCommand, organizationCreate, type HumanActor } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiAskError, askStructured } from '../src/ai/ask';
import { aiBudget, recordAiUsage } from '../src/ai/budget';
import { tokensToday } from '../src/assistant/store';
import { testServices } from './helpers';

/** The one daily AI limit per workspace, and askStructured, which every AI call outside the Assistant uses. */

const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const admin = () => testDbs().admin.db;
const worker = () => testDbs().worker.db;
const log = testServices().log;

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

describe('one daily AI limit per workspace', () => {
  it('counts the Assistant’s runs and every other AI call, today only', async () => {
    expect(await aiBudget.usedToday(worker(), scope)).toBe(0);
    const [thread] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.assistant_threads (workspace_id, user_id, title)
          values (${scope.workspaceId}, ${owner.id}, 'Budget') returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.assistant_runs (workspace_id, user_id, thread_id, model, correlation_id, status, ended_at,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at)
          values (${scope.workspaceId}, ${owner.id}, ${thread!.id}, 'scripted', gen_random_uuid(), 'done', now(),
                  100, 20, 5, 0, now()),
                 (${scope.workspaceId}, ${owner.id}, ${thread!.id}, 'scripted', gen_random_uuid(), 'done',
                  now() - interval '2 days', 9000, 0, 0, 0, now() - interval '2 days')`,
    );
    await asWorker(worker(), scope, (tx) =>
      recordAiUsage(tx, {
        source: 'knowledge',
        userId: owner.id,
        model: 'claude-sonnet-5',
        usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 2 },
      }),
    );
    await rows(
      admin(),
      sql`insert into app.ai_usage (workspace_id, source, model, input_tokens, created_at)
          values (${scope.workspaceId}, 'builder', 'claude-sonnet-5', 7000, now() - interval '2 days')`,
    );
    // 125 from the Assistant today, 352 from the knowledge base today; the older rows don't count.
    expect(await aiBudget.usedToday(worker(), scope)).toBe(477);
    expect(await tokensToday(worker(), scope, 'America/Chicago')).toBe(477);
    const [row] = await rows(
      admin(),
      sql`select source::text as source, user_id, model from app.ai_usage
          where workspace_id = ${scope.workspaceId} and created_at > now() - interval '1 hour'`,
    );
    expect(row).toEqual({ source: 'knowledge', user_id: owner.id, model: 'claude-sonnet-5' });
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
  const ctx = (provider: AiProvider | null, dailyTokens = 5_000_000) => ({
    db: worker(),
    ai: { provider, dailyTokens },
    log,
    // Shadow: the charge is written for real, and nothing here is about what it decides.
    wallet: { db: worker(), log, mode: 'shadow' as const },
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

  it('says why there is no answer: no model, today’s limit, a provider error or a bad answer', async () => {
    await expect(askStructured(ctx(null), scope, ask('hello'))).rejects.toMatchObject({
      code: 'ai_unavailable',
    });
    const used = await aiBudget.usedToday(worker(), scope);
    const overBudget = askStructured(ctx(scripted, used), scope, ask('hello'));
    await expect(overBudget).rejects.toBeInstanceOf(AiAskError);
    await expect(overBudget).rejects.toMatchObject({
      code: 'budget_reached',
      message: expect.stringMatching(/resets at midnight/),
    });

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
});
