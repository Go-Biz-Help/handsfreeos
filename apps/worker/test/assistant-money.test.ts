/**
 * The Assistant's money answers (M9, step 13), against the scripted stand-in model and the real queries and
 * commands underneath it.
 *
 * What it holds to:
 * - **Every figure comes back from a real query.** The card the panel draws is built by the worker from rows,
 *   never from the model's own arithmetic, so each answer here is checked against the money that was written.
 * - **Reading money is allowed for anyone who may see it; moving it is not.** A member gets the read tools and
 *   the narrower answer the member rule leaves them, and is told in a sentence — not a stack trace — when they
 *   ask for something only an owner or admin can do.
 * - **Nothing goes out, and nothing is recorded, until the person says yes on the card.**
 */
import { randomUUID } from 'node:crypto';
import {
  createTokenVerifier,
  estimateCreate,
  executeCommand,
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  organizationCreate,
  personCreate,
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
let ownerToken: string;
let memberToken: string;
let workspaceId: string;
let mariaId: string;
let app: FastifyInstance;
/** A sent invoice nobody has paid, a paid one, and a draft estimate waiting to go out. */
let owedInvoiceId: string;
let draftEstimateId: string;

const run = <T>(cmd: Parameters<typeof executeCommand>[1], input: unknown, u: TestUser) =>
  executeCommand(api(), cmd, input, actor(u), meta()).then((r) => r.output as T);

const line = (name: string, cents: number) => ({
  productId: null,
  name,
  description: null,
  quantity: 1,
  unitLabel: 'each',
  unitPriceCents: cents,
  taxable: false,
  discountCents: 0,
});

async function ask(
  token: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<AssistantEvent[]> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/assistant/messages',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId, text, ...extra },
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
const moneyCard = (events: AssistantEvent[]) =>
  cardsOf(events).find((c) => c.type === 'money') as
    (Extract<AssistantEvent, { type: 'card' }>['card'] & { type: 'money' }) | undefined;
const confirmOf = (events: AssistantEvent[]) => {
  const card = cardsOf(events).find((c) => c.type === 'confirm');
  return card?.type === 'confirm' ? card : undefined;
};
const decide = (token: string, id: string, action: 'confirm' | 'cancel') =>
  app.inject({
    method: 'POST',
    url: `/v1/assistant/tool-calls/${id}/${action}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId },
  });

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('money-assistant-owner'),
    createTestUser('money-assistant-member'),
  ]);
  await consentToAssistant(owner, member);
  const org = await run<{ workspaceId: string }>(
    organizationCreate,
    { businessName: 'Lone Star Assistant HVAC', timezone: 'America/Chicago' },
    owner,
  );
  workspaceId = org.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${member.id}, 'member')`,
  );
  mariaId = (
    await run<{ personId: string }>(
      personCreate,
      {
        workspaceId,
        firstName: 'Maria',
        lastName: 'Lopez',
        email: `maria-${randomUUID().slice(0, 8)}@example.test`,
      },
      owner,
    )
  ).personId;

  // What she owes: one invoice sent and unpaid.
  const owed = await run<{ invoiceId: string }>(
    invoiceCreate,
    {
      workspaceId,
      personId: mariaId,
      title: 'AC replacement',
      lines: [line('3-ton AC system', 640_000)],
    },
    owner,
  );
  owedInvoiceId = owed.invoiceId;
  await run(invoiceSend, { workspaceId, invoiceId: owedInvoiceId, channels: [] }, owner);

  // What has come in: a second invoice, paid in cash.
  const paid = await run<{ invoiceId: string }>(
    invoiceCreate,
    { workspaceId, personId: mariaId, title: 'Tune-up', lines: [line('AC tune-up', 18_000)] },
    owner,
  );
  await run(invoiceSend, { workspaceId, invoiceId: paid.invoiceId, channels: [] }, owner);
  await run(
    invoiceRecordCashPayment,
    { workspaceId, invoiceId: paid.invoiceId, amountCents: 18_000, method: 'cash' },
    owner,
  );

  // And an estimate still a draft, for the Assistant to offer to send.
  draftEstimateId = (
    await run<{ estimateId: string }>(
      estimateCreate,
      {
        workspaceId,
        personId: mariaId,
        title: 'New ductwork',
        lines: [line('Ductwork', 420_000)],
      },
      owner,
    )
  ).estimateId;

  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
  const s = testServices();
  const httpDb = testDbs().worker.db;
  app = await buildHttpServer({
    ...s,
    httpDb,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    assistant: {
      provider: scriptedAssistant(),
      tools: createToolExecutor(httpDb),
      dailyTokens: 5_000_000,
    },
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('the Assistant reading money', () => {
  it('answers “what are we owed?” with the figure and the invoices behind it', async () => {
    const events = await ask(ownerToken, 'What are we owed?');
    const card = moneyCard(events);
    expect(card).toMatchObject({ title: 'What you are owed', value: '$6,400' });
    expect(card?.items?.[0]).toMatchObject({ title: expect.stringContaining('Maria Lopez') });
    expect(card?.href).toBe(`/app/w/${workspaceId}/money`);
    expect(textOf(events)).toMatch(/You are owed \$6,400 across one invoice/);
  });

  it('answers “what did we collect?” from the payments that actually landed', async () => {
    const events = await ask(ownerToken, 'What did we collect this month?');
    expect(moneyCard(events)).toMatchObject({ value: '$180', title: /^Collected in the last/ });
    expect(textOf(events)).toMatch(/\$180 has come in from one payment/);
  });

  it('answers “which estimates are waiting?” with nothing out, because a draft has not gone anywhere', async () => {
    const events = await ask(ownerToken, 'Which estimates are waiting?');
    expect(textOf(events)).toMatch(/Every estimate has been answered/);
    expect(moneyCard(events)).toMatchObject({ value: '$0' });
  });

  it('answers one customer’s balance on their own page', async () => {
    const events = await ask(ownerToken, 'Does she owe us anything?', {
      page: { type: 'person', id: mariaId },
    });
    expect(moneyCard(events)).toMatchObject({ title: 'Maria Lopez', value: '$6,400' });
    expect(textOf(events)).toMatch(
      /Maria Lopez owes \$6,400 across one invoice, and has paid \$180/,
    );
  });
});

describe('the Assistant moving money', () => {
  it('drafts the estimate as a card, sends nothing until Confirm, and then sends it once', async () => {
    const events = await ask(ownerToken, `Send the estimate ${draftEstimateId}`);
    const card = confirmOf(events);
    expect(card).toMatchObject({ tool: 'send_estimate', confirmLabel: 'Send it' });
    expect(card?.fields).toContainEqual({ label: 'Total', value: '$4,200' });
    // The one thing a person must know before they press it.
    expect(card?.warnings.map((w) => w.kind)).toContain('freezes');
    const before = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.estimates where id = ${draftEstimateId}`,
    );
    expect(before[0]!.status).toBe('draft');

    const answer = await decide(ownerToken, card!.toolCallId, 'confirm');
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({
      status: 'confirmed',
      outcome: expect.stringMatching(/^Sent /),
    });
    const after = await rows<{ status: string; number: string | null }>(
      admin(),
      sql`select status::text as status, number from app.estimates where id = ${draftEstimateId}`,
    );
    expect(after[0]!.status).toBe('sent');
    expect(after[0]!.number).toBeTruthy();
  });

  it('writes down cash only after Confirm, and says what is still owed', async () => {
    const events = await ask(ownerToken, `Record $1,400 cash on ${owedInvoiceId}`);
    const card = confirmOf(events);
    expect(card).toMatchObject({ tool: 'record_payment', confirmLabel: 'Record it' });
    expect(card?.fields).toContainEqual({ label: 'Amount', value: '$1,400' });
    expect(card?.warnings.map((w) => w.kind)).toContain('not_a_charge');
    expect(
      await rows(admin(), sql`select id from app.payments where invoice_id = ${owedInvoiceId}`),
    ).toHaveLength(0);

    const answer = await decide(ownerToken, card!.toolCallId, 'confirm');
    expect(answer.json()).toMatchObject({
      status: 'confirmed',
      outcome: 'Recorded $1,400 — $5,000 still owed',
    });
    const [payment] = await rows<{ amount_cents: number; method: string }>(
      admin(),
      sql`select amount_cents::float8 as amount_cents, method::text as method
          from app.payments where invoice_id = ${owedInvoiceId}`,
    );
    expect(payment).toMatchObject({ amount_cents: 140_000, method: 'cash' });
  });

  it('cancels instead, and nothing happens', async () => {
    const events = await ask(ownerToken, `Record $50 cash on ${owedInvoiceId}`);
    const card = confirmOf(events)!;
    expect((await decide(ownerToken, card.toolCallId, 'cancel')).statusCode).toBe(200);
    expect(
      await rows(
        admin(),
        sql`select id from app.payments where invoice_id = ${owedInvoiceId} and amount_cents = 5000`,
      ),
    ).toHaveLength(0);
  });
});

describe('a member', () => {
  it('reads the money on their own jobs, and nothing else', async () => {
    const events = await ask(memberToken, 'What are we owed?');
    // Nothing is theirs: no lead of theirs, no visit they worked. The figure is honest rather than refused.
    expect(textOf(events)).toMatch(/Nothing is outstanding|You are owed \$0/);
    expect(moneyCard(events)).toMatchObject({ value: '$0' });
  });

  it('is refused the buttons that move money, in a sentence rather than a stack trace', async () => {
    const events = await ask(memberToken, `Record $100 cash on ${owedInvoiceId}`);
    expect(confirmOf(events)).toBeUndefined();
    expect(textOf(events)).toMatch(
      /That can’t be recorded: That is not something you can do here\./,
    );
    expect(textOf(events)).not.toMatch(/Error|stack|forbidden/i);
    const sent = await ask(memberToken, `Send the estimate ${draftEstimateId}`);
    expect(confirmOf(sent)).toBeUndefined();
    expect(textOf(sent)).toMatch(
      /That estimate can’t be sent: That is not something you can do here\./,
    );
  });
});
