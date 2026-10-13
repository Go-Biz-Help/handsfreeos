import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  extensionSignInAnswer,
  PushData,
  pushDeviceRegister,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthAdmin } from '../src/account/auth-admin';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { PUSH_JOBS } from '../src/push/index';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

/**
 * Signing in to the browser extension with a prompt (20261027002900), through the worker's public doors on the real
 * database with the stand-in push sender and a stand-in for Supabase's admin key:
 * - **Start** answers the same for an email with or without an account, and pushes only that person's own phones.
 * - **Collect** needs the secret; waits, then hands the sign-in over exactly once after the right number; a wrong
 *   number is refused for good.
 * - **Limits:** too many prompts for one email are refused, whatever address they come from.
 */

const WORKER_ID = `vitest-extension-sign-in-${process.pid}`;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const as = <T = unknown>(u: TestUser, cmd: CommandDef, input: unknown): Promise<T> =>
  executeCommand(api(), cmd, input, actor(u), {
    correlationId: randomUUID(),
    channel: 'test',
  }).then((r) => r.output as T);

let s: TestServices;
let app: FastifyInstance;
let dale: TestUser;
let marco: TestUser;
let daleToken: string;
let marcoToken: string;
const minted: string[] = [];

const authAdmin: AuthAdmin = {
  signOutEverywhere: async () => 'none',
  blockSignIn: async () => undefined,
  mintSignIn: async (email) => {
    minted.push(email);
    return `hashed-token-for-${email}`;
  },
};

const post = (url: string, body: unknown, ip = '203.0.113.90') =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
const json = <T>(res: LightMyRequestResponse) => res.json() as T;

interface Started {
  requestId: string;
  number: number;
  secret: string;
  expiresAt: string;
}
const start = async (email: string, ip?: string) => {
  const res = await post('/public/extension-sign-in/start', { email, browser: 'Chrome' }, ip);
  expect(res.statusCode).toBe(200);
  return json<Started>(res);
};
const collect = async (requestId: string, secret: string) =>
  json<{ status: string; tokenHash?: string }>(
    await post('/public/extension-sign-in/collect', { requestId, secret }),
  );

async function phoneOf(u: TestUser, label: string): Promise<string> {
  const token = `ExponentPushToken[${label}-${randomUUID().slice(0, 12)}]`;
  await as(u, pushDeviceRegister, { platform: 'ios', token, appVersion: '1.0.0' });
  return token;
}

/** The push jobs this suite queued, run now. */
async function sendPushes(): Promise<void> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${WORKER_ID}
        where status = 'pending' and kind = ${PUSH_JOBS.send}
          and dedupe_key like 'push:extension_sign_in:%' and run_at <= now()`,
  );
  await processJobs({ ...s, jobs, workerId: WORKER_ID, batchSize: 50, reservedOnly: true });
}

beforeAll(async () => {
  [dale, marco] = await Promise.all([
    createTestUser('ext-sign-in-dale', { fullName: 'Dale Owner' }),
    createTestUser('ext-sign-in-marco', { fullName: 'Marco Member' }),
  ]);
  s = testServices();
  app = await buildHttpServer({
    ...s,
    authAdmin,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
  daleToken = await phoneOf(dale, 'dale-iphone');
  marcoToken = await phoneOf(marco, 'marco-iphone');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('the extension’s sign-in prompt', () => {
  it('answers alike whether or not the email has an account, and tells only that person’s phones', async () => {
    const nobody = await start(`nobody-${randomUUID()}@hfos.test`);
    const known = await start(dale.email);
    expect(Object.keys(nobody).sort()).toEqual(Object.keys(known).sort());
    expect(nobody.secret).toHaveLength(43);
    await sendPushes();
    const sent = s.push.fake.sent.filter(
      (m) =>
        (m.message.data as { refs?: { signInId?: string } }).refs?.signInId === known.requestId,
    );
    expect(sent.map((m) => m.message.to)).toEqual([daleToken]);
    expect(sent.map((m) => m.message.to)).not.toContain(marcoToken);
    const data = PushData.parse(sent[0]!.message.data);
    expect(data).toMatchObject({
      category: 'extension_sign_in',
      workspaceId: null,
      path: `/app/extension-sign-in/${known.requestId}`,
    });
    // The push never says the number.
    expect(JSON.stringify(sent[0]!.message)).not.toContain(`"${known.number}"`);
  });

  it('hands the sign-in over once, after the right number, to whoever holds the secret', async () => {
    const r = await start(dale.email);
    expect(await collect(r.requestId, r.secret)).toEqual({ status: 'waiting' });
    expect(await collect(r.requestId, 'x'.repeat(43))).toEqual({ status: 'expired' });
    await as(dale, extensionSignInAnswer, { requestId: r.requestId, pick: r.number });
    expect(await collect(r.requestId, r.secret)).toEqual({
      status: 'approved',
      tokenHash: `hashed-token-for-${dale.email}`,
    });
    expect(await collect(r.requestId, r.secret)).toEqual({ status: 'expired' });
    expect(minted.filter((e) => e === dale.email)).toHaveLength(1);
  });

  it('stops for good on one wrong number', async () => {
    const r = await start(dale.email);
    const wrong = r.number === 99 ? 98 : r.number + 1;
    await as(dale, extensionSignInAnswer, { requestId: r.requestId, pick: wrong });
    expect(await collect(r.requestId, r.secret)).toEqual({ status: 'refused' });
    await expect(
      as(dale, extensionSignInAnswer, { requestId: r.requestId, pick: r.number }),
    ).rejects.toMatchObject({ rule: 'sign_in_request_gone' });
  });

  it('limits prompts for one email from anywhere', async () => {
    const email = `limited-${randomUUID()}@hfos.test`;
    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1)
      codes.push(
        (
          await post(
            '/public/extension-sign-in/start',
            { email, browser: 'Chrome' },
            `198.51.100.${i + 1}`,
          )
        ).statusCode,
      );
    expect(codes).toContain(429);
    const refused = await post('/public/extension-sign-in/start', { email }, '198.51.100.99');
    expect(json<{ error: { rule: string } }>(refused).error.rule).toBe('rate_limited');
  });
});
