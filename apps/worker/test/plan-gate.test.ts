/**
 * The worker's half of the owner's decision of 2026-11-22: a business with no plan or trial can't text, email, call
 * or use AI, whoever asks. message.send refuses first (packages/core/test/plan-gate.test.ts); here, what was queued
 * while it had a plan doesn't go once the plan has ended, and its AI doesn't run.
 */
import { randomUUID } from 'node:crypto';
import { ScriptedProvider } from '@hfos/ai';
import {
  executeCommand,
  messageSend,
  organizationCreate,
  personCreate,
  phoneUpdateSettings,
  PLAN_REFUSALS,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { events, messages } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { askStructured } from '../src/ai/ask';
import { aiBudget } from '../src/ai/budget';
import { onMessageQueued } from '../src/handlers/telephony';
import { testServices, type TestServices } from './helpers';

const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const admin = () => testDbs().admin.db;
const uniq = () => randomUUID().slice(0, 8);
const nextPhone = () =>
  `+1832${String(2000000 + ((Date.now() + Math.floor(Math.random() * 1e6)) % 7999999)).padStart(7, '0')}`;
const run = <T>(cmd: Parameters<typeof executeCommand>[1], input: unknown) =>
  executeCommand(testDbs().api.db, cmd, input, actor(owner), meta()).then((r) => r.output as T);

let owner: TestUser;
let scope: { workspaceId: string; organizationId: string };
let mariaId: string;
let s: TestServices;

/** Sets whether the business was made while a paid spot was on sale, and whether it holds a plan (a trial here). */
async function plan(needs: boolean, held: boolean) {
  await admin().execute(
    sql`update app.organizations set needs_plan = ${needs} where id = ${scope.organizationId}`,
  );
  await admin().execute(
    held
      ? sql`insert into app.workspace_plans (workspace_id, organization_id, plan, status, price_cents, trial_ends_at,
                                             current_period_end)
            values (${scope.workspaceId}, ${scope.organizationId}, 'monthly', 'active', 9700,
                    now() + interval '14 days', now() + interval '1 month')
            on conflict (workspace_id) do update set status = 'active', canceled_at = null`
      : sql`update app.workspace_plans set status = 'canceled', canceled_at = now()
            where workspace_id = ${scope.workspaceId}`,
  );
}

/** The worker's message.queued handler for one message, in its own transaction, as the outbox runs it. */
async function sendQueued(messageId: string) {
  await asWorker(testDbs().worker.db, scope, async (tx) => {
    const [event] = await tx
      .select()
      .from(events)
      .where(and(eq(events.entityId, messageId), eq(events.eventType, 'message.queued')));
    await onMessageQueued({ ...s, tx, event: event!, scope, attempt: 1, maxAttempts: 5 });
  });
}

const messageRow = async (id: string) =>
  (await admin().select().from(messages).where(eq(messages.id, id)))[0]!;

beforeAll(async () => {
  s = testServices();
  owner = await createTestUser('plangate-worker-owner');
  const org = await run<{ organizationId: string; workspaceId: string }>(organizationCreate, {
    businessName: 'Plan Gate Plumbing',
  });
  scope = { workspaceId: org.workspaceId, organizationId: org.organizationId };
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, auth_token_enc, status)
        values (${scope.workspaceId}, 'fake', ${`ACpgw${uniq()}`}, ${s.sealer.seal('fake-token')}, 'active')
        returning id`,
  );
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${scope.workspaceId}, ${account!.id}, ${`PNpgw${uniq()}`}, ${nextPhone()}, 'toll_free', 'active')
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${scope.workspaceId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved',
                ${`HHpgw${uniq()}`}, now())`,
  );
  await run(phoneUpdateSettings, {
    workspaceId: scope.workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });
  mariaId = (
    await run<{ personId: string }>(personCreate, {
      workspaceId: scope.workspaceId,
      firstName: 'Maria',
      lastName: 'Lopez',
      phone: '(713) 555-0174',
    })
  ).personId;
});
afterAll(closeTestDbs);

describe('what was queued while the business had a plan', () => {
  it('doesn’t go once the plan has ended: the email and the text fail and say why', async () => {
    await plan(true, true);
    const mail = await run<{ messageId: string }>(messageSend, {
      workspaceId: scope.workspaceId,
      channel: 'email',
      toEmail: `maria-${uniq()}@example.com`,
      subject: 'Your visit',
      body: 'See you Monday at 8.',
    });
    const sms = await run<{ messageId: string }>(messageSend, {
      workspaceId: scope.workspaceId,
      personId: mariaId,
      body: 'Your tech is on the way.',
    });
    await plan(true, false);

    const emailSend = vi.spyOn(s.email.transport, 'send');
    const textSend = vi.spyOn(s.telephony, 'sendMessage');
    try {
      await sendQueued(mail.messageId);
      await sendQueued(sms.messageId);
      expect(emailSend).not.toHaveBeenCalled();
      expect(textSend).not.toHaveBeenCalled();
    } finally {
      emailSend.mockRestore();
      textSend.mockRestore();
    }
    expect(await messageRow(mail.messageId)).toMatchObject({
      status: 'failed',
      errorCode: 'needs_plan',
      errorMessage: PLAN_REFUSALS.email,
    });
    expect(await messageRow(sms.messageId)).toMatchObject({
      status: 'failed',
      errorCode: 'needs_plan',
      errorMessage: PLAN_REFUSALS.text,
    });
  });

  it('goes as usual while it holds one', async () => {
    await plan(true, true);
    const mail = await run<{ messageId: string }>(messageSend, {
      workspaceId: scope.workspaceId,
      channel: 'email',
      toEmail: `maria-${uniq()}@example.com`,
      subject: 'Your visit',
      body: 'See you Monday at 8.',
    });
    const sms = await run<{ messageId: string }>(messageSend, {
      workspaceId: scope.workspaceId,
      personId: mariaId,
      body: 'Running ten minutes late.',
    });
    await sendQueued(mail.messageId);
    await sendQueued(sms.messageId);
    for (const id of [mail.messageId, sms.messageId])
      expect(await messageRow(id)).toMatchObject({ errorCode: null });
  });
});

describe('its AI', () => {
  const Answer = z.object({ answer: z.string() });
  const scripted = new ScriptedProvider([{ when: /hello/, json: () => ({ answer: 'Hi there' }) }]);
  const ctx = () => ({ db: s.db, ai: { provider: scripted }, log: s.log, wallet: s.wallet });
  const ask = () =>
    askStructured(ctx(), scope, {
      system: 'Answer briefly.',
      messages: [{ role: 'user', content: 'hello' }],
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      zod: Answer,
      usage: { source: 'builder', userId: owner.id },
    });

  it('doesn’t run with no plan, and says where to pick one', async () => {
    await plan(true, false);
    expect(await aiBudget.noRoom(s.db, scope)).toEqual({
      code: 'wallet_empty',
      message: PLAN_REFUSALS.ai,
    });
    await expect(ask()).rejects.toMatchObject({ code: 'wallet_empty', message: PLAN_REFUSALS.ai });
  });

  it('runs on a free trial, and for a business never asked to pay', async () => {
    await plan(true, true);
    expect(await aiBudget.noRoom(s.db, scope)).toBeNull();
    expect((await ask()).value).toEqual({ answer: 'Hi there' });
    await plan(false, false);
    expect(await aiBudget.noRoom(s.db, scope)).toBeNull();
  });
});
