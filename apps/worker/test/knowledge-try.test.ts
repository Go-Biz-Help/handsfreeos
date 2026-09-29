import { randomUUID } from 'node:crypto';
import type { AiProvider, AiRequest } from '@hfos/ai';
import {
  createTokenVerifier,
  executeCommand,
  knowledgeItemCreate,
  knowledgeProfileUpdate,
  organizationCreate,
  type AssistantEvent,
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
import { consentToAssistant } from './assistant-consent';
import { aiBudget } from '../src/ai/budget';
import { scriptedAi } from '../src/ai/scripted';
import { scriptedAssistant } from '../src/assistant/scripted';
import { createToolExecutor } from '../src/assistant/tools-write';
import { buildHttpServer } from '../src/http/server';
import { TRY_PER_MINUTE } from '../src/knowledge/routes';
import { TRY_SYSTEM } from '../src/knowledge/try';
import { testServices, type TestServices } from './helpers';

/** "Try it": the same grounding as AI steps, the items it used, gaps, and the shared daily limit. */

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
let org: string;
let financingId: string;
let draftId: string;
let app: FastifyInstance;

/** A model that remembers every request before the scripted stand-in answers it. */
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

// The stand-in, plus one rule that names items it wasn't offered next to the first one it was.
const model = recording(
  scriptedAi([
    {
      when: /with made-up ids/,
      json: (_q, context) => ({
        answer: 'Yes, with approved credit.',
        usedItemIds: [/<item id="([^"]+)"/.exec(context)?.[1] ?? '', randomUUID(), draftId],
        unanswered: false,
      }),
    },
  ]),
);

async function build(
  ai: TestServices['ai'],
  assistantTokens: number | null = null,
): Promise<FastifyInstance> {
  const s = testServices({ ai });
  const httpDb = testDbs().worker.db;
  return buildHttpServer({
    ...s,
    httpDb,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    assistant:
      assistantTokens === null
        ? null
        : {
            provider: scriptedAssistant(),
            tools: createToolExecutor(httpDb),
            dailyTokens: assistantTokens,
          },
  });
}

const tryIt = (server: FastifyInstance, token: string, question: string) =>
  server.inject({
    method: 'POST',
    url: '/v1/knowledge/try',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws, question },
  });

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('kb-try-owner'),
    createTestUser('kb-try-member'),
  ]);
  await consentToAssistant(owner, member);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Try It HVAC' },
    actor(owner),
    meta(),
  );
  ws = output.workspaceId;
  org = output.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  await executeCommand(
    api(),
    knowledgeProfileUpdate,
    {
      workspaceId: ws,
      profile: {
        description: 'Heating and air conditioning for homes in Austin.',
        tone: 'Friendly and plain-spoken',
      },
    },
    actor(owner),
    meta(),
  );
  const create = async (
    content: Parameters<typeof knowledgeItemCreate.handler>[1]['content'],
    status: 'draft' | 'published',
  ) =>
    (
      await executeCommand(
        api(),
        knowledgeItemCreate,
        { workspaceId: ws, content, status },
        actor(owner),
        meta(),
      )
    ).output.itemId;
  financingId = await create(
    {
      kind: 'faq',
      question: 'Do you offer financing?',
      answer: 'Yes, new systems can be financed over 60 months with approved credit.',
      tags: [],
    },
    'published',
  );
  await create(
    {
      kind: 'fact',
      title: 'Service area',
      body: 'We cover Travis and Williamson counties.',
      tags: [],
    },
    'published',
  );
  draftId = await create(
    { kind: 'faq', question: 'Do you offer financing for repairs?', answer: 'Not yet.', tags: [] },
    'draft',
  );
  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
  app = await build({ provider: model.provider, dailyTokens: 5_000_000 });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('Try it', () => {
  it('answers the way AI steps would, and lists the items it used', async () => {
    const res = await tryIt(app, ownerToken, 'Do you offer financing?');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      answer: 'Yes, new systems can be financed over 60 months with approved credit.',
      unanswered: false,
      items: [
        {
          id: financingId,
          kind: 'faq',
          title: 'Do you offer financing?',
          snippet: expect.stringContaining('**financed**'),
        },
      ],
      gap: null,
    });
    const request = model.requests.at(-1)!;
    expect(request.system).toBe(TRY_SYSTEM);
    expect(request.context).toContain('<business_profile>');
    expect(request.context).toContain('Rules for using this knowledge:');
    expect(request.context).toContain(`<item id="${financingId}" kind="faq">`);
    // Only published items reach the AI.
    expect(request.context).not.toContain(draftId);
    expect(request.messages[0]!.content).toBe(
      '<customer_message>\nDo you offer financing?\n</customer_message>\nAnswer the customer’s message above.',
    );
    expect(request.responseFormat?.schema).toMatchObject({
      required: ['answer', 'usedItemIds', 'unanswered'],
    });
    // The tokens are the asker's, as knowledge usage; Try it never counts as a use of the item.
    expect(
      await rows(
        admin(),
        sql`select source::text as source, user_id, model from app.ai_usage where workspace_id = ${ws}`,
      ),
    ).toEqual([{ source: 'knowledge', user_id: owner.id, model: 'scripted' }]);
    expect(
      await rows(
        admin(),
        sql`select use_count, last_used_at from app.knowledge_items where id = ${financingId}`,
      ),
    ).toEqual([{ use_count: 0, last_used_at: null }]);
  });

  it('keeps only the items it was offered, whatever ids the answer names', async () => {
    const res = await tryIt(app, ownerToken, 'Do you offer financing with made-up ids?');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      answer: 'Yes, with approved credit.',
      items: [{ id: financingId }],
    });
    expect(res.json().items).toHaveLength(1);
  });

  it('turns a question it can’t answer into a gap suggestion, and groups repeats', async () => {
    const first = await tryIt(app, ownerToken, 'Do you service swimming pool heaters?');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      unanswered: true,
      items: [],
      gap: { grouped: false },
      answer: expect.stringMatching(/follow up/),
    });
    const suggestionId = first.json().gap.suggestionId as string;
    const again = await tryIt(app, ownerToken, 'Do you service pool heaters');
    expect(again.json()).toMatchObject({ unanswered: true, gap: { suggestionId, grouped: true } });
    const [gap] = await rows(
      admin(),
      sql`select reason::text as reason, status::text as status, proposed ->> 'title' as title, source, similar_count
          from app.knowledge_suggestions where id = ${suggestionId}`,
    );
    expect(gap).toEqual({
      reason: 'gap',
      status: 'pending',
      title: 'Do you service swimming pool heaters?',
      source: { via: 'try_it', question: 'Do you service swimming pool heaters?' },
      similar_count: 2,
    });
  });

  it('is for people who manage the knowledge base, and needs a question', async () => {
    const member = await tryIt(app, memberToken, 'Do you offer financing?');
    expect(member.statusCode).toBe(403);
    const empty = await tryIt(app, ownerToken, '   ');
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: { code: 'validation' } });
  });

  it('says so when no model is set up', async () => {
    const none = await build({ provider: null, dailyTokens: 5_000_000 });
    try {
      const res = await tryIt(none, ownerToken, 'Do you offer financing?');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        error: {
          rule: 'ai_not_configured',
          message:
            'The AI isn’t set up for HandsFreeOS yet, so this can’t run. HandsFreeOS support can switch it on.',
        },
      });
    } finally {
      await none.close();
    }
  });

  it('over today’s limit answers 429, and the Assistant counts the same tokens', async () => {
    const used = await aiBudget.usedToday(testDbs().worker.db, {
      workspaceId: ws,
      organizationId: org,
    });
    expect(used).toBeGreaterThan(0);
    // Every token so far was knowledge usage: none of it is the Assistant's own.
    expect(
      await rows(admin(), sql`select 1 from app.assistant_runs where workspace_id = ${ws}`),
    ).toEqual([]);
    const limited = await build({ provider: model.provider, dailyTokens: used }, used);
    try {
      const res = await tryIt(limited, ownerToken, 'Do you offer financing?');
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({
        error: {
          rule: 'budget_reached',
          message: 'That’s today’s AI limit for this business. It resets at midnight.',
        },
      });
      const asked = await limited.inject({
        method: 'POST',
        url: '/v1/assistant/messages',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId: ws, text: 'What needs attention?' },
      });
      const events = asked.body
        .split('\n\n')
        .filter((chunk) => chunk.startsWith('data: '))
        .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantEvent);
      expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'budget_reached' })]);
    } finally {
      await limited.close();
    }
  });

  it('limits how often one address can ask', async () => {
    const fresh = await build({ provider: model.provider, dailyTokens: 5_000_000 });
    try {
      for (let i = 0; i < TRY_PER_MINUTE; i++)
        expect((await tryIt(fresh, ownerToken, 'Where do you work?')).statusCode).toBe(200);
      const res = await tryIt(fresh, ownerToken, 'Where do you work?');
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: { rule: 'rate_limited' } });
    } finally {
      await fresh.close();
    }
  }, 60_000);
});
