/**
 * Phone & texting on and off: a business's own Twilio subaccount made on request (so its Account SID is there
 * before any number is), closed on request only when nothing is in it, and made fresh if turned back on.
 *
 * **Needs the stack up** (`pnpm supabase:start && pnpm db:reset`).
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createTokenVerifier,
  executeCommand,
  numberImportStart,
  organizationCreate,
  phoneNumberBuy,
  telephonyDisable,
  telephonyEnable,
  type HfosError,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { events, telephonyAccounts } from '@hfos/db/schema';
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
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { loadAccount } from '../src/telephony/accounts';
import { testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-phone-switch-${process.pid}`;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let owner: TestUser;
let member: TestUser;
let s: TestServices;
let app: FastifyInstance;

async function business(name: string): Promise<string> {
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: name },
    actor(owner),
    meta(),
  );
  return output.workspaceId;
}

/** Runs this business's outbox and jobs until nothing wants to run now. */
async function drain(workspaceId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const table of ['outbox', 'scheduled_jobs'])
      await rows(
        admin(),
        sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
            where status = 'pending' and workspace_id = ${workspaceId}`,
      );
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const ev = await processOnce({ ...d, handlers });
    const ran = await processJobs({ ...d, jobs });
    if (ev.retried + ev.failed + ran.retried + ran.failed > 0)
      throw new Error(
        `worker work failed: ${JSON.stringify(
          await rows(
            admin(),
            sql`select kind, last_error from app.scheduled_jobs
                where workspace_id = ${workspaceId} and last_error is not null`,
          ),
        )}`,
      );
    if (ev.claimed === 0 && ran.claimed - ran.rescheduled === 0) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
    await sleep(50);
  }
}

const accountOf = async (workspaceId: string) =>
  (
    await admin()
      .select()
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, workspaceId))
  )[0];

const shown = async (workspaceId: string, who: TestUser = owner) =>
  app.inject({
    method: 'POST',
    url: '/v1/telephony/account',
    headers: {
      authorization: `Bearer ${await signInTestUser(who)}`,
      'content-type': 'application/json',
    },
    payload: { workspaceId },
  });

const turnOn = (workspaceId: string) =>
  executeCommand(api(), telephonyEnable, { workspaceId }, actor(owner), meta());
const turnOff = (workspaceId: string) =>
  executeCommand(api(), telephonyDisable, { workspaceId }, actor(owner), meta());

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('switch-owner'),
    createTestUser('switch-member'),
  ]);
  s = testServices({});
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('phone & texting on', () => {
  it('makes the business its own Twilio account now, before any number, and shows its Account SID', async () => {
    const ws = await business('Switch On Plumbing');
    const before = await shown(ws);
    expect(before.json()).toEqual({
      state: 'off',
      accountSid: null,
      parentAccountSid: s.telephony.masterAccountSid,
      lastError: null,
    });

    await turnOn(ws);
    await drain(ws);
    const account = await accountOf(ws);
    expect(account?.status).toBe('active');
    expect(account?.accountSid).toMatch(/^AC/);
    // Everything the first number would have made: texting, and browser calls.
    expect(account?.messagingServiceSid).toBeTruthy();
    expect(account?.twimlAppSid).toBeTruthy();
    expect((await shown(ws)).json()).toEqual({
      state: 'on',
      accountSid: account!.accountSid,
      parentAccountSid: s.telephony.masterAccountSid,
      lastError: null,
    });
    const said = await admin().select().from(events).where(eq(events.workspaceId, ws));
    expect(said.map((e) => e.eventType)).toContain('telephony.account_changed');
  });

  it('is only for those who manage the business’s numbers', async () => {
    const ws = await business('Switch Members');
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${ws}, ${member.id}, 'member')`,
    );
    await expect(
      executeCommand(api(), telephonyEnable, { workspaceId: ws }, actor(member), meta()),
    ).rejects.toMatchObject({ status: 403 });
    expect((await shown(ws, member)).statusCode).toBe(403);
  });
});

describe('phone & texting off', () => {
  it('is refused while a number is in the account, and never releases it', async () => {
    const ws = await business('Switch Has A Number');
    await executeCommand(
      api(),
      phoneNumberBuy,
      {
        workspaceId: ws,
        e164: `+1713555${String(1000 + Math.floor(Math.random() * 8999))}`,
        numberType: 'local',
      },
      actor(owner),
      meta(),
    );
    await drain(ws);
    await expect(turnOff(ws)).rejects.toMatchObject({
      rule: 'telephony_in_use',
    } satisfies Partial<HfosError>);
    await drain(ws);
    expect((await accountOf(ws))?.status).toBe('active');
    expect(s.telephony.closedAccounts).not.toContain((await accountOf(ws))!.accountSid);
  });

  it('closes the account for good when it is empty, and turning back on makes a new one', async () => {
    const ws = await business('Switch Empty');
    await turnOn(ws);
    await drain(ws);
    const first = (await accountOf(ws))!.accountSid!;

    await turnOff(ws);
    await drain(ws);
    const closed = await accountOf(ws);
    expect(closed?.status).toBe('closed');
    expect(s.telephony.closedAccounts).toContain(first);
    // Nothing that could open or act in it is kept.
    expect(closed?.authTokenEnc).toBeNull();
    expect(closed?.apiKeySecretEnc).toBeNull();
    expect(closed?.messagingServiceSid).toBeNull();
    expect(
      await asWorker(s.db, { workspaceId: ws }, (tx) => loadAccount(tx, ws, s.sealer)),
    ).toBeNull();
    expect((await shown(ws)).json()).toMatchObject({ state: 'off', accountSid: null });

    await turnOn(ws);
    await drain(ws);
    const again = await accountOf(ws);
    expect(again?.status).toBe('active');
    expect(again?.accountSid).toMatch(/^AC/);
    expect(again?.accountSid).not.toBe(first);
    expect(again?.messagingServiceSid).toBeTruthy();
  });

  it('buying a number after turning off makes a fresh account rather than using the closed one', async () => {
    const ws = await business('Switch Buy After Off');
    await turnOn(ws);
    await drain(ws);
    const first = (await accountOf(ws))!.accountSid!;
    await turnOff(ws);
    await drain(ws);
    await executeCommand(
      api(),
      phoneNumberBuy,
      {
        workspaceId: ws,
        e164: `+1713556${String(1000 + Math.floor(Math.random() * 8999))}`,
        numberType: 'local',
      },
      actor(owner),
      meta(),
    );
    await drain(ws);
    const account = await accountOf(ws);
    expect(account?.status).toBe('active');
    expect(account?.accountSid).not.toBe(first);
  });

  it('asks again just before closing: a transfer started in between keeps it on, and says why', async () => {
    const ws = await business('Switch Race');
    await turnOn(ws);
    await drain(ws);
    // Pressed off with nothing in the account…
    await turnOff(ws);
    // …and before the worker gets to it, a number starts on its way here.
    await executeCommand(
      api(),
      numberImportStart,
      {
        workspaceId: ws,
        e164: `+1256555${String(1000 + Math.floor(Math.random() * 8999))}`,
        source: 'highlevel',
      },
      actor(owner),
      meta(),
    );
    await drain(ws);
    const account = await accountOf(ws);
    expect(account?.status).toBe('active');
    expect(s.telephony.closedAccounts).not.toContain(account!.accountSid);
    expect(account?.lastError).toMatch(/left on.*on its way here/);
    expect((await shown(ws)).json()).toMatchObject({ state: 'on', lastError: account!.lastError });
  });
});
