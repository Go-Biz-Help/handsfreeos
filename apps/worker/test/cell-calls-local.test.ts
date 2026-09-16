/**
 * M10 step 6b: the fake carrier on your own computer. With callbacks on (as `pnpm dev` runs it), the calls the worker
 * places play out against its own TwiML over real HTTP: the verification call answers and presses 1, and a call
 * through the cell answers, presses 1, reaches the customer, talks, hangs up and leaves a recording whose words come
 * back. That is what makes "Call" work end to end locally, with nothing mocked. A call cancelled while the cell rings
 * (step 7) stops where it is: the customer is never dialed.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import {
  bridgeStatusOf,
  callCancelConnect,
  callConnectMe,
  createTokenVerifier,
  executeCommand,
  organizationCreate,
  personCreate,
  phoneNumberBuy,
  userPhoneStartVerification,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { calls, userPhones } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { createFakeTelephony, FAKE_TRANSCRIPT } from '../src/telephony/fake';
import { testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-cell-local-${process.pid}`;
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

let dale: TestUser;
let workspaceId: string;
let mikeId: string;
let s: TestServices;
let app: FastifyInstance;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Drains this workspace's work (and brings the transcript job forward) until `done` holds. */
async function until(done: () => Promise<boolean>, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now() where kind = 'call.transcript' and workspace_id = ${workspaceId} and status = 'pending'`,
    );
    for (const table of ['outbox', 'webhook_deliveries', 'scheduled_jobs'])
      await rows(
        admin(),
        sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
            where status = 'pending' and workspace_id = ${workspaceId}`,
      );
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    await processOnce({ ...d, handlers });
    await processDeliveries({ ...d, processors });
    await processJobs({ ...d, jobs });
    if (await done()) return;
    await sleep(250);
  }
  throw new Error('the local call did not play out in time');
}

beforeAll(async () => {
  dale = await createTestUser('cell-local-dale', { fullName: 'Dale Owner' });
  workspaceId = (
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Local Calls HVAC' },
      actor(dale),
      meta(),
    )
  ).output.workspaceId;
  mikeId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId, firstName: 'Mike', lastName: 'Johnson', phone: '(713) 555-0142' },
      actor(dale),
      meta(),
    )
  ).output.personId;
  const port = await freePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  s = {
    ...testServices(),
    publicUrl,
    telephony: createFakeTelephony({
      approvalMs: 0,
      callbacks: true,
      log: pino({ level: 'silent' }),
    }),
  };
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
  await app.listen({ port, host: '127.0.0.1' });
  const businessNumber = `+1833${String(100 + Math.floor(Math.random() * 899))}${String(1001 + Math.floor(Math.random() * 8998))}`;
  await executeCommand(
    api(),
    phoneNumberBuy,
    { workspaceId, e164: businessNumber, numberType: 'toll_free' },
    actor(dale),
    meta(),
  );
  await until(async () => {
    const [n] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.phone_numbers where workspace_id = ${workspaceId}`,
    );
    return n?.status === 'active';
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('calls through a cell on the fake carrier, played out', () => {
  it('verifies a cell, then connects a customer, records the call and brings back its words', async () => {
    const { userPhoneId } = (
      await executeCommand(
        api(),
        userPhoneStartVerification,
        { workspaceId, phone: '(512) 555-0142' },
        actor(dale),
        meta(),
      )
    ).output;
    await until(async () => {
      const [row] = await admin().select().from(userPhones).where(eq(userPhones.id, userPhoneId));
      return !!row?.verifiedAt;
    });

    const { callId } = (
      await executeCommand(
        api(),
        callConnectMe,
        { workspaceId, personId: mikeId },
        actor(dale),
        meta(),
      )
    ).output;
    await until(async () => {
      const [c] = await admin().select().from(calls).where(eq(calls.id, callId));
      return c?.transcriptStatus === 'completed';
    });
    const [c] = await admin().select().from(calls).where(eq(calls.id, callId));
    expect(c).toMatchObject({
      status: 'completed',
      answeredVia: 'bridge',
      answeredByUserId: dale.id,
      answeredNumber: '+17135550142',
      isVoicemail: false,
      recordingObjectPath: `${workspaceId}/calls/${callId}/recording.wav`,
      transcript: `Dale: ${FAKE_TRANSCRIPT[0].text}\nMike: ${FAKE_TRANSCRIPT[1].text}\nDale: ${FAKE_TRANSCRIPT[2].text}`,
    });
    expect(bridgeStatusOf(c!)).toBe('ended');
    expect(c!.activityId).toBeTruthy();
  }, 60_000);

  it('stops a call cancelled while the cell rings: the customer is never dialed', async () => {
    const { callId } = (
      await executeCommand(
        api(),
        callConnectMe,
        { workspaceId, personId: mikeId },
        actor(dale),
        meta(),
      )
    ).output;
    let sid: string | null = null;
    await until(async () => {
      const [c] = await admin().select().from(calls).where(eq(calls.id, callId));
      sid = c?.providerSid ?? null;
      return !!sid;
    });
    await executeCommand(api(), callCancelConnect, { workspaceId, callId }, actor(dale), meta());
    await until(async () => s.telephony.ended.includes(sid!));
    // Long enough for a call that kept going to have dialed the customer.
    await sleep(3_000);
    await until(async () => true);
    const [c] = await admin().select().from(calls).where(eq(calls.id, callId));
    expect(c).toMatchObject({ status: 'canceled', answeredByUserId: null, answeredNumber: null });
    expect(bridgeStatusOf(c!)).toBe('cancelled');
  }, 60_000);
});
