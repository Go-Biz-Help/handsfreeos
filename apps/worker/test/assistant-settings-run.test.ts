import { randomUUID } from 'node:crypto';
import {
  createTokenVerifier,
  executeCommand,
  executeQuery,
  organizationCreate,
  registry,
  type AssistantCard,
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
import { scriptedAssistant } from '../src/assistant/scripted';
import { createToolExecutor } from '../src/assistant/tools-write';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

/**
 * The whole way through, against the scripted stand-in model (M12, step six): the question that started the
 * milestone — "how do I create a calendar" — is answered by offering to do it, the calendar is drafted as a card
 * that changes nothing, Confirm makes it, and the audit log shows it as the person's own doing through the
 * Assistant. Then the two other shapes: reading a setting back, and handing over what only a person can do.
 */

const CHI = 'America/Chicago';
const env = testEnv();
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let ownerToken: string;
let workspaceId: string;
let app: FastifyInstance;

async function ask(text: string): Promise<AssistantEvent[]> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/assistant/messages',
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { workspaceId, text },
  });
  expect(res.statusCode).toBe(200);
  return res.body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantEvent);
}
const cardsOf = (events: AssistantEvent[]) =>
  events.flatMap((e) => (e.type === 'card' ? [e.card] : []));
const textOf = (events: AssistantEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
function cardOf<T extends AssistantCard['type']>(
  events: AssistantEvent[],
  type: T,
): Extract<AssistantCard, { type: T }> {
  const card = cardsOf(events).find((c) => c.type === type);
  if (!card) throw new Error(`No ${type} card. The answer: ${textOf(events)}`);
  return card as Extract<AssistantCard, { type: T }>;
}
const confirm = (id: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/assistant/tool-calls/${id}/confirm`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { workspaceId },
  });
const calendars = async () =>
  (await executeQuery(
    api(),
    registry.query('calendar.list')!,
    { workspaceId },
    actor(owner),
    meta(),
  )) as { items: { id: string; name: string }[] };

beforeAll(async () => {
  owner = await createTestUser('aset-run-dale', { fullName: 'Dale Owner' });
  await consentToAssistant(owner);
  const org = (await executeCommand(
    api(),
    organizationCreate,
    { businessName: `Run HVAC ${randomUUID().slice(0, 8)}`, timezone: CHI },
    actor(owner),
    meta(),
  )) as { output: { workspaceId: string } };
  workspaceId = org.output.workspaceId;
  ownerToken = await signInTestUser(owner);
  const httpDb = testDbs().worker.db;
  app = await buildHttpServer({
    ...testServices(),
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
}, 90_000);

afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('“How do I create a calendar?”', () => {
  it('offers to do it, drafts it as a card, and makes it only on Confirm', async () => {
    const asked = await ask('How do I create a calendar?');
    expect(textOf(asked)).toContain('set one up for you');

    const before = (await calendars()).items.length;
    const drafted = await ask('Create a calendar called Duct cleaning');
    const card = cardOf(drafted, 'confirm');
    expect(card.tool).toBe('manage_calendar');
    expect(card.title).toBe('Set up Duct cleaning');
    expect(card.confirmLabel).toBe('Set it up');
    // The answer must not claim it is done while it waits.
    expect(textOf(drafted)).toMatch(/Confirm/);
    expect((await calendars()).items.length).toBe(before);

    const done = await confirm(card.toolCallId);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'confirmed' });
    const made = (await calendars()).items.find((c) => c.name === 'Duct cleaning');
    expect(made).toBeTruthy();

    // It ran as the person, through the Assistant, the same as a click on the screen would.
    const audit = await rows<{ actor_id: string; channel: string }>(
      admin(),
      sql`select actor_id, channel from app.audit_logs
          where workspace_id = ${workspaceId} and action = 'calendar.create' order by created_at desc limit 1`,
    );
    expect(audit[0]).toMatchObject({ actor_id: owner.id, channel: 'assistant' });
  });
});

describe('reading a setting back, and what only a person can do', () => {
  it('answers quiet hours from the real settings', async () => {
    const events = await ask('What are my quiet hours?');
    const answer = textOf(events);
    // Texting isn't set up in a fresh business, and the answer says so rather than inventing hours.
    expect(answer.length).toBeGreaterThan(0);
    expect(answer).toMatch(/quiet hours|isn’t set up/i);
  });

  it('hands Stripe back with the steps, and offers what it can still do', async () => {
    const events = await ask('How do I connect Stripe?');
    expect(textOf(events)).toContain('yours to do');
    const card = cardOf(events, 'list');
    expect(card.title).toBe('Connect Stripe or Square');
    expect(card.aside).toBe('Settings → Payments');
    expect(card.items[0]!.href).toBe(`/app/w/${workspaceId}/settings/payments`);
    expect(card.items.map((i) => i.title).join(' ')).toContain('Sign in');
  });
});
