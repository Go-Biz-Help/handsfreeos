/**
 * Connecting the accounts a business is paid into, end to end on the stand-in provider: signing in through the
 * real routes, several accounts at once (including two of the same provider), the default moving when one goes,
 * Stripe's refusal to attach to an account another platform controls, and Square's 30-day token — renewed,
 * asking for a reconnect when it can't be, and rescued by the hourly re-arm when its own job has died. The same
 * hourly pass clears away sign-ins nobody finished.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  executeCommand,
  invoiceCreate,
  organizationCreate,
  paymentConnectionConnect,
  paymentConnectionDisconnect,
  personCreate,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { paymentConnections } from '@hfos/db/schema';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { accountFor } from '../src/payments/index';
import type { PaymentTokens } from '../src/payments/provider';
import { PAYMENT_JOBS, PAYMENT_PLAN_KEY, refreshJobKey } from '../src/payments/refresh';
import { processDeliveries } from '../src/deliveries';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { systemActor } from '../src/services';
import { finishSignIn, testTokenVerifier } from './finish-sign-in';
import { testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-payments-connections-${process.pid}`;
const token = () => randomUUID().slice(0, 8);
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
let ownerToken: string;
let workspaceId: string;
let organizationId: string;
let s: TestServices;
let app: FastifyInstance;

let stripeAccount: string;
let stripeId: string;
let stripeState: string;
let secondStripeId: string;
let squareAccount: string;
let squareId: string;

const scope = () => ({ workspaceId, organizationId });
const worker = <T>(fn: (tx: Tx) => Promise<T>) => asWorker(testDbs().worker.db, scope(), fn);
const get = (url: string) => app.inject({ method: 'GET', url });
const connection = async (id: string) =>
  (await admin().select().from(paymentConnections).where(eq(paymentConnections.id, id)))[0]!;

async function reserve(): Promise<void> {
  for (const table of ['outbox', 'webhook_deliveries', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${workspaceId}`,
    );
}

/** Runs the outbox, webhook and job loops over this workspace's due work until it is idle. */
async function drain(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await reserve();
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const passes = [
      await processOnce({ ...d, handlers }),
      await processDeliveries({ ...d, processors }),
      await processJobs({ ...d, jobs }),
    ];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select kind as what, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null
            union all select event_type, last_error from app.outbox
              where workspace_id = ${workspaceId} and last_error is not null and status = 'pending'`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

/**
 * Signs in through the real routes: connect, start, the stand-in's Connect (or Cancel), the callback, and the
 * app finishing it as `finishedBy` (the owner who pressed Connect, unless a test says otherwise).
 */
async function connect(
  provider: 'stripe' | 'square',
  account: string,
  opts: {
    decision?: 'allow' | 'deny';
    partial?: boolean;
    held?: boolean;
    label?: string;
    finishedBy?: string;
  } = {},
): Promise<{
  connectionId: string;
  state: string;
  status: number;
  location: string | null;
  body: string;
}> {
  const { output } = await executeCommand(
    api(),
    paymentConnectionConnect,
    {
      workspaceId,
      provider,
      environment: 'test' as const,
      ...(opts.label ? { label: opts.label } : {}),
    },
    actor(owner),
    meta(),
  );
  const start = await get(`/oauth/${provider}/start?state=${encodeURIComponent(output.state)}`);
  expect(start.statusCode).toBe(302);
  const authorize = new URL(String(start.headers.location));
  expect(authorize.pathname).toBe(`/oauth/fake/payments/${provider}/authorize`);
  // No PKCE for these two: Stripe doesn't offer it, and Square's trades away the 30-day refresh token.
  expect(authorize.searchParams.get('code_challenge')).toBeNull();
  const page = await get(`${authorize.pathname}${authorize.search}`);
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('No real account is touched');
  const approve = await get(
    `/oauth/fake/payments/${provider}/approve?${new URLSearchParams({
      state: output.state,
      redirect_uri: authorize.searchParams.get('redirect_uri')!,
      account,
      decision: opts.decision ?? 'allow',
      ...(opts.partial ? { partial: '1' } : {}),
      ...(opts.held ? { held: '1' } : {}),
    })}`,
  );
  expect(approve.statusCode).toBe(302);
  const callback = new URL(String(approve.headers.location));
  const backTo = await finishSignIn(
    app,
    await get(`${callback.pathname}${callback.search}`),
    opts.finishedBy ?? ownerToken,
  );
  await drain();
  return {
    connectionId: output.connectionId,
    state: output.state,
    status: backTo.status,
    location: backTo.location,
    body: backTo.body,
  };
}

const settings = (result: string) =>
  `http://localhost:3000/app/w/${workspaceId}/settings/payments?payments=${result}`;

const refreshJob = (connectionId: string) =>
  rows<{ status: string; run_at: Date }>(
    admin(),
    sql`select status::text as status, run_at from app.scheduled_jobs
        where dedupe_key = ${refreshJobKey(connectionId)} order by created_at desc`,
  );

/** The connection's renewal falls due now instead of in a week: both the schedule and the job move. */
async function refreshNow(connectionId: string): Promise<void> {
  await worker((tx) =>
    tx
      .update(paymentConnections)
      .set({ nextRefreshAt: new Date(Date.now() - 1_000) })
      .where(eq(paymentConnections.id, connectionId)),
  );
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now()
        where dedupe_key = ${refreshJobKey(connectionId)} and status = 'pending'`,
  );
  await drain();
}

/** The server-wide hourly `payments.plan`, run now. */
async function runHourlyPlan(): Promise<void> {
  await rows(
    admin(),
    sql`insert into app.scheduled_jobs (kind, dedupe_key, run_at, payload)
        values (${PAYMENT_JOBS.plan}, ${PAYMENT_PLAN_KEY}, now(), '{}'::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
        do update set run_at = now()`,
  );
  await rows(
    admin(),
    sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${WORKER_ID}
        where dedupe_key = ${PAYMENT_PLAN_KEY} and status = 'pending'`,
  );
  await processJobs({ ...s, workerId: WORKER_ID, batchSize: 50, reservedOnly: true, jobs });
}

beforeAll(async () => {
  owner = await createTestUser('payments-conn-owner');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Payments Connections HVAC' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  stripeAccount = `acct_test_${token()}`;
  squareAccount = `merchant_test_${token()}`;
  ownerToken = await signInTestUser(owner);
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: testTokenVerifier(),
    webOrigins: ['http://localhost:3000'],
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('connecting an account', () => {
  it('signs in through the stand-in Stripe page, seals the token and takes the default', async () => {
    const signed = await connect('stripe', stripeAccount, { label: 'Main account' });
    stripeId = signed.connectionId;
    stripeState = signed.state;
    expect(signed.location).toBe(settings('connected'));
    const c = await connection(stripeId);
    expect(c).toMatchObject({
      status: 'active',
      provider: 'stripe',
      environment: 'test',
      externalAccountId: stripeAccount,
      label: 'Main account',
      isDefault: true,
      failures: 0,
      lastError: null,
    });
    expect(c.displayName).toContain(stripeAccount);
    // Sealed, not stored in the clear; the one-time state is gone and there was never a PKCE verifier.
    expect(c.tokenEnc).toMatch(/^v1\./);
    expect(c.tokenEnc).not.toContain('fake-stripe-refresh');
    expect(c.oauthStateHash).toBeNull();
    expect(c.pkceVerifierEnc).toBeNull();
    // Stripe's access is our own key plus an account header, so there is nothing that lapses and nothing to renew.
    expect(c.tokenExpiresAt).toBeNull();
    expect(c.nextRefreshAt).toBeNull();
    expect(await refreshJob(stripeId)).toHaveLength(0);
    // What the account can do was read at activation, not guessed.
    expect(c.capabilities).toMatchObject({
      card: true,
      bankTransfer: true,
      flow: 'client_confirm',
    });
  });

  it('a used sign-in link is a dead end', async () => {
    const used = await get(`/oauth/stripe/start?state=${encodeURIComponent(stripeState)}`);
    expect(used.statusCode).toBe(400);
    expect(used.body).toContain('This sign-in link has expired');
    expect(used.body).toContain('Payments');
  });

  it('connects Square too, keeps its location and books the first token renewal', async () => {
    const signed = await connect('square', squareAccount);
    squareId = signed.connectionId;
    expect(signed.location).toBe(settings('connected'));
    const c = await connection(squareId);
    expect(c).toMatchObject({
      status: 'active',
      provider: 'square',
      externalAccountId: squareAccount,
      locationId: `fake-location-${squareAccount}`,
      // Stripe already took the default for this environment.
      isDefault: false,
    });
    expect(c.capabilities).toMatchObject({ flow: 'server_charge' });
    // Square's token lasts 30 days, so a renewal is already waiting for it.
    expect(c.tokenExpiresAt).not.toBeNull();
    expect(c.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 25 * 86_400_000);
    expect(c.nextRefreshAt).not.toBeNull();
    const [job] = await refreshJob(squareId);
    expect(job?.status).toBe('pending');
  });

  it('a second account of the same provider connects beside the first', async () => {
    const second = `acct_test_${token()}`;
    const signed = await connect('stripe', second, { label: 'Service account' });
    secondStripeId = signed.connectionId;
    expect(signed.location).toBe(settings('connected'));
    const c = await connection(secondStripeId);
    expect(c).toMatchObject({ status: 'active', externalAccountId: second, isDefault: false });
    // Three accounts at once, two of them Stripe.
    const live = await admin()
      .select({ id: paymentConnections.id })
      .from(paymentConnections)
      .where(eq(paymentConnections.workspaceId, workspaceId));
    expect(live.filter((r) => [stripeId, secondStripeId, squareId].includes(r.id))).toHaveLength(3);
  });

  it('reconnecting the same account retires the old row without revoking the new sign-in', async () => {
    const again = await connect('stripe', stripeAccount);
    expect(again.location).toBe(settings('connected'));
    const old = await connection(stripeId);
    expect(old).toMatchObject({
      status: 'disconnected',
      disconnectedReason: 'replaced',
      tokenEnc: null,
      isDefault: false,
    });
    const fresh = await connection(again.connectionId);
    expect(fresh).toMatchObject({ status: 'active', externalAccountId: stripeAccount });
    // The reason is 'replaced', so the provider was not told to revoke — which would have killed this token.
    await expect(
      s.payments.providers.stripe.capabilities(accountFor(s.sealer, fresh)),
    ).resolves.toMatchObject({ card: true });
    stripeId = again.connectionId;
  });

  it('comes back as cancelled when the business says no, and nothing connects', async () => {
    const signed = await connect('square', `merchant_test_${token()}`, { decision: 'deny' });
    expect(signed.location).toBe(settings('cancelled'));
    const c = await connection(signed.connectionId);
    expect(c.status).toBe('pending');
    expect(c.lastError).toContain('access_denied');
  });

  it('says so when a permission was left unticked, and doesn’t connect', async () => {
    const signed = await connect('square', `merchant_test_${token()}`, { partial: true });
    expect(signed.location).toBe(settings('missing_permissions'));
    const c = await connection(signed.connectionId);
    expect(c.status).toBe('pending');
    expect(c.lastError).toContain('PAYMENTS_WRITE');
  });

  it('explains Stripe’s refusal to attach an account another platform controls, and offers Square', async () => {
    const signed = await connect('stripe', `acct_test_${token()}`, { held: true });
    expect(signed.status).toBe(200);
    expect(signed.body).toContain('connected to another platform');
    expect(signed.body).toContain('Square');
    const c = await connection(signed.connectionId);
    expect(c.status).toBe('pending');
    // The provider's own code is kept, in plain sight, for whoever has to work out why.
    expect(c.lastError).toContain('account_controlled_by_another_platform');
  });

  it('connects nothing when somebody else finishes a sign-in link they were sent (SEC-M1)', async () => {
    // Riley, in another business, is sent the owner's sign-in link and approves his own account on it.
    const riley = await createTestUser('payments-conn-riley');
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Somebody Else Electric' },
      actor(riley),
      meta(),
    );
    const theirs = `acct_test_${token()}`;
    const signed = await connect('stripe', theirs, { finishedBy: await signInTestUser(riley) });
    expect(signed.location).toBeNull();
    expect(signed.body).toContain('started by someone else');
    const c = await connection(signed.connectionId);
    expect(c).toMatchObject({ status: 'pending', externalAccountId: null, tokenEnc: null });
    // And the link is spent: the owner can't be tricked into finishing it afterwards either.
    expect(c.oauthStateHash).toBeNull();
  });

  it('connects nothing when the sign-in comes back to somebody signed out', async () => {
    const signed = await connect('square', `merchant_test_${token()}`, { finishedBy: '' });
    expect(signed.status).toBe(401);
    expect((await connection(signed.connectionId)).status).toBe('pending');
  });
});

describe('disconnecting', () => {
  it('moves the default on, and tells the provider too', async () => {
    expect((await connection(stripeId)).isDefault).toBe(true);
    await executeCommand(
      api(),
      paymentConnectionDisconnect,
      { workspaceId, connectionId: stripeId, acknowledgeSubscriptions: false },
      actor(owner),
      meta(),
    );
    await drain();
    const gone = await connection(stripeId);
    expect(gone).toMatchObject({
      status: 'disconnected',
      disconnectedReason: 'person',
      tokenEnc: null,
      isDefault: false,
      nextRefreshAt: null,
    });
    // A business is never left with nowhere to be paid: the next account takes over.
    const others = [await connection(secondStripeId), await connection(squareId)];
    expect(others.filter((c) => c.isDefault)).toHaveLength(1);
    // The provider was told: the stand-in refuses that account until it signs in again.
    await expect(
      s.payments.providers.stripe.capabilities({
        provider: 'stripe',
        externalAccountId: stripeAccount,
        locationId: null,
        accessToken: null,
        environment: 'test',
      }),
    ).rejects.toMatchObject({ name: 'PaymentAuthError' });
  });
});

describe('Square’s 30-day token', () => {
  it('renews it, seals the new one and books the next renewal', async () => {
    const before = await connection(squareId);
    const beforeTokens = JSON.parse(s.sealer.open(before.tokenEnc!)) as PaymentTokens;
    await refreshNow(squareId);
    const after = await connection(squareId);
    expect(after.status).toBe('active');
    expect(after.failures).toBe(0);
    expect(after.tokenEnc).toMatch(/^v1\./);
    expect(after.tokenEnc).not.toBe(before.tokenEnc);
    const afterTokens = JSON.parse(s.sealer.open(after.tokenEnc!)) as PaymentTokens;
    expect(afterTokens.accessToken).not.toBe(beforeTokens.accessToken);
    expect(afterTokens.externalAccountId).toBe(squareAccount);
    expect(after.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 25 * 86_400_000);
    expect(after.nextRefreshAt).not.toBeNull();
    const [job] = await refreshJob(squareId);
    expect(job?.status).toBe('pending');
  });

  it('asks for a reconnect when the sign-in was revoked, and stops asking', async () => {
    await s.payments.fake.revoke(squareAccount);
    await refreshNow(squareId);
    const c = await connection(squareId);
    expect(c.status).toBe('reauth_required');
    expect(c.lastError).toContain('stopped accepting');
    expect(c.nextRefreshAt).toBeNull();
    expect((await refreshJob(squareId)).filter((j) => j.status === 'pending')).toHaveLength(0);
  });

  it('the hourly plan rescues a connection whose own refresh job died', async () => {
    // Signed in again, its renewal overdue, and its per-connection job exhausted its retries.
    const signed = await connect('square', squareAccount);
    const rescued = signed.connectionId;
    await worker((tx) =>
      tx
        .update(paymentConnections)
        .set({ nextRefreshAt: new Date(Date.now() - 60_000) })
        .where(eq(paymentConnections.id, rescued)),
    );
    await rows(
      admin(),
      sql`update app.scheduled_jobs set status = 'failed', finished_at = now(),
            last_error = 'the refresh gave up'
          where dedupe_key = ${refreshJobKey(rescued)} and status = 'pending'`,
    );
    expect((await refreshJob(rescued)).filter((j) => j.status === 'pending')).toHaveLength(0);

    // The hourly plan puts one back, so a dead job can't end a business's payments thirty days later.
    await runHourlyPlan();
    expect((await refreshJob(rescued)).filter((j) => j.status === 'pending')).toHaveLength(1);

    // And it really runs: the token is renewed.
    const before = await connection(rescued);
    await refreshNow(rescued);
    const after = await connection(rescued);
    expect(after.status).toBe('active');
    expect(after.tokenEnc).not.toBe(before.tokenEnc);
  });
});

describe('sign-ins nobody finished', () => {
  it('the hourly plan clears them away once they can never finish, and leaves real accounts alone', async () => {
    // Cancelled at the provider an hour and more after its link lapsed, and one started just now.
    const left = await connect('square', `merchant_test_${token()}`, { decision: 'deny' });
    await worker((tx) =>
      tx
        .update(paymentConnections)
        .set({ oauthStateExpiresAt: new Date(Date.now() - 2 * 60 * 60_000) })
        .where(eq(paymentConnections.id, left.connectionId)),
    );
    const { output: fresh } = await executeCommand(
      api(),
      paymentConnectionConnect,
      { workspaceId, provider: 'stripe', environment: 'test' as const },
      actor(owner),
      meta(),
    );
    // An invoice the business raised on its own, pointed at the one that never finished: nobody could pay it.
    const { output: person } = await executeCommand(
      api(),
      personCreate,
      { workspaceId, firstName: 'Client', lastName: 'Co' },
      actor(owner),
      meta(),
    );
    const { output: bill } = await executeCommand(
      testDbs().worker.db,
      invoiceCreate,
      {
        workspaceId,
        personId: person.personId,
        lines: [{ name: 'Work', quantity: 1, unitPriceCents: 10_000, taxable: false }],
        connectionId: left.connectionId,
      },
      systemActor(scope()),
      meta(),
    );

    await runHourlyPlan();

    const still = await rows<{ id: string }>(
      admin(),
      sql`select id from app.payment_connections
          where id in (${left.connectionId}, ${fresh.connectionId}, ${stripeId})`,
    );
    expect(still.map((r) => r.id).sort()).toEqual([fresh.connectionId, stripeId].sort());
    // The invoice names no account now, so it is paid into the default like any other.
    const [invoice] = await rows<{ connection_id: string | null }>(
      admin(),
      sql`select connection_id from app.invoices where id = ${bill.invoiceId}`,
    );
    expect(invoice?.connection_id).toBeNull();
  });
});
