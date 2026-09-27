/**
 * A business for the money worker tests (M9 step 5): an owner, a customer, and **both** providers connected
 * through the real sign-in routes against the stand-in — Stripe (confirm in the browser) as the default, and
 * Square (tokenise, then charge from here) beside it, because one business can have several accounts at once.
 *
 * The stand-in's webhooks are pointed at this world's own server, so every event that arrives is **properly
 * signed** and goes through the real verifier. Nothing here reaches the network.
 */
import { randomUUID } from 'node:crypto';
import {
  estimateCreate,
  estimateSend,
  executeCommand,
  executeQuery,
  invoiceCreate,
  invoiceSend,
  moneySaveSettings,
  moneySettingsGet,
  organizationCreate,
  paymentConnectionConnect,
  paymentConnectionSetDefault,
  personCreate,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { createTestUser, signInTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { expect } from 'vitest';
import type { z } from 'zod';
import { buildHttpServer } from '../src/http/server';
import { documentToken, type MoneyDocumentKind } from '../src/money/links';
import { jobs } from '../src/scheduled';
import { finishSignIn, testTokenVerifier } from './finish-sign-in';
import { testServices } from './helpers';
import { admin, api, drain, MIN, nextPhone, type World } from './booking-world';

export { admin, api, drain, errorOf, get, post } from './booking-world';

const ROOM = { max: 10_000, timeWindow: MIN };
const shortId = () => randomUUID().slice(0, 8);

/** Where "at our place" is: the stand-in a business's documents fall back to until they set a real one. */
export const CALENDAR_ADDRESS = '4120 Almeda Rd, Houston, TX 77004';

/** The seller's own address, as they write it in Settings → Payments (`money.businessAddress`). */
export const BUSINESS_ADDRESS =
  'Lone Star HVAC & Roofing\n7200 Harwin Dr, Suite 210\nHouston, TX 77036';

const actorOf = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

export interface ConnectedAccount {
  readonly connectionId: string;
  /** The provider's own id for it: what a webhook is routed by. */
  readonly accountId: string;
}

export interface MoneyWorld extends World {
  /** Maria Lopez: the customer every document here is for. */
  readonly person: { id: string; name: string; email: string; phone: string };
  readonly stripe: ConnectedAccount;
  readonly square: ConnectedAccount;
}

/** A command as the world's owner. */
export function run<I extends z.ZodType, O extends z.ZodType>(
  w: World,
  cmd: CommandDef<I, O>,
  input: unknown,
): Promise<z.output<O>> {
  return executeCommand(api(), cmd, input, actorOf(w.owner), meta()).then((r) => r.output);
}

export async function moneyWorld(label: string): Promise<MoneyWorld> {
  const owner = await createTestUser(`${label}-dale`, { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: `${label} Lone Star HVAC` },
    actorOf(owner),
    meta(),
  );
  const s = testServices();
  const app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    // The app finishes a sign-in signed in as the owner who started it.
    verifyToken: testTokenVerifier(),
    webOrigins: ['http://localhost:3000'],
    // Room to spare: these tests hammer one address on purpose, and the limits have their own test.
    money: { limits: { read: ROOM, act: ROOM, pay: ROOM } },
    testRoutes: { jobs },
  });
  // Every webhook the stand-in posts arrives at this server, signed with the real algorithms.
  s.payments.fake.setDeliver(async (post) => {
    const url = new URL(post.url);
    const res = await app.inject({
      method: 'POST',
      url: `${url.pathname}${url.search}`,
      headers: { 'content-type': 'application/json', ...post.headers },
      payload: post.body,
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300 };
  });
  const base: World = {
    label,
    owner,
    workspaceId: output.workspaceId,
    organizationId: output.organizationId,
    site: `${label}-${shortId()}`,
    s,
    app,
    workerId: `vitest-${label}-${process.pid}`,
    number: null,
  };
  // A calendar that says where the business is. Written straight in: its only job here is to hold the address
  // the money pages read, and the calendar builder has its own tests.
  await rows(
    admin(),
    sql`insert into app.calendars (workspace_id, name, slug, config)
        values (${base.workspaceId}, 'Service calls', ${`calls-${shortId()}`},
          ${JSON.stringify({
            locations: { options: [{ kind: 'business', address: CALENDAR_ADDRESS }] },
          })}::jsonb)`,
  );
  const phone = nextPhone();
  const person = await run(base, personCreate, {
    workspaceId: base.workspaceId,
    firstName: 'Maria',
    lastName: 'Lopez',
    email: `maria-${shortId()}@example.com`,
    phone,
  });
  const stripe = await connect(base, 'stripe', `acct_${shortId()}`);
  const square = await connect(base, 'square', `merchant_${shortId()}`);
  // Stripe is the account documents are paid into unless one names another.
  await run(base, paymentConnectionSetDefault, {
    workspaceId: base.workspaceId,
    connectionId: stripe.connectionId,
  });
  await drain(base);
  return Object.assign(base, {
    person: {
      id: (person as { personId: string }).personId,
      name: 'Maria Lopez',
      email: '',
      phone,
    },
    stripe,
    square,
  });
}

/**
 * Signs in at the provider through the real routes (start → the stand-in's page → callback → the app finishing
 * it as the owner).
 */
export async function connect(
  w: World,
  provider: 'stripe' | 'square',
  accountId: string,
): Promise<ConnectedAccount> {
  const started = await run(w, paymentConnectionConnect, {
    workspaceId: w.workspaceId,
    provider,
    environment: 'test' as const,
  });
  const state = (started as { state: string; connectionId: string }).state;
  const go = (url: string) => w.app.inject({ method: 'GET', url });
  const start = await go(`/oauth/${provider}/start?state=${encodeURIComponent(state)}`);
  expect(start.statusCode, start.body).toBe(302);
  const authorize = new URL(String(start.headers.location));
  const approve = await go(
    `/oauth/fake/payments/${provider}/approve?${new URLSearchParams({
      state,
      redirect_uri: authorize.searchParams.get('redirect_uri')!,
      account: accountId,
      decision: 'allow',
    })}`,
  );
  expect(approve.statusCode, approve.body).toBe(302);
  const callback = new URL(String(approve.headers.location));
  const done = await finishSignIn(
    w.app,
    await go(`${callback.pathname}${callback.search}`),
    await signInTestUser(w.owner),
  );
  expect(done.status, done.body).toBe(302);
  await drain(w);
  return { connectionId: (started as { connectionId: string }).connectionId, accountId };
}

/** The same account, signed in again after a disconnect: a new row, the same provider account. */
export const reconnect = connect;

export interface SentDocument {
  readonly id: string;
  readonly number: string | null;
  readonly token: string;
  readonly totalCents: number;
}

/** The part of a customer's link after /e/ or /i/, worked out the way the worker mints it. */
export async function tokenOf(
  w: World,
  kind: MoneyDocumentKind,
  documentId: string,
): Promise<string> {
  const table = kind === 'estimate' ? sql`app.estimates` : sql`app.invoices`;
  const [row] = await rows<{ public_ref: string; link_version: number }>(
    admin(),
    sql`select public_ref, link_version from ${table} where id = ${documentId}`,
  );
  return documentToken(w.s.moneyLinks, kind, {
    publicRef: row!.public_ref,
    documentId,
    linkVersion: row!.link_version,
  });
}

const ONE_LINE = [
  {
    name: 'AC tune-up',
    quantity: 1,
    unitPriceCents: 18_000,
    unitLabel: 'each',
    taxable: true,
  },
];

/** An estimate, written and sent: numbered, frozen and with a live link. */
export async function sentEstimate(
  w: MoneyWorld,
  over: Record<string, unknown> = {},
): Promise<SentDocument> {
  const created = await run(w, estimateCreate, {
    workspaceId: w.workspaceId,
    personId: w.person.id,
    title: 'AC tune-up',
    lines: ONE_LINE,
    ...over,
  });
  const id = (created as { estimateId: string }).estimateId;
  const sent = await run(w, estimateSend, { workspaceId: w.workspaceId, estimateId: id });
  await drain(w);
  return {
    id,
    number: (sent as { number: string | null }).number,
    token: await tokenOf(w, 'estimate', id),
    totalCents: (sent as { totalCents: number }).totalCents,
  };
}

/** An invoice, written and sent, paid into `connectionId` (the business's default unless one is named). */
export async function sentInvoice(
  w: MoneyWorld,
  over: Record<string, unknown> = {},
): Promise<SentDocument> {
  const created = await run(w, invoiceCreate, {
    workspaceId: w.workspaceId,
    personId: w.person.id,
    title: 'AC tune-up',
    lines: ONE_LINE,
    ...over,
  });
  const id = (created as { invoiceId: string }).invoiceId;
  const sent = await run(w, invoiceSend, { workspaceId: w.workspaceId, invoiceId: id });
  await drain(w);
  return {
    id,
    number: (sent as { number: string | null }).number,
    token: await tokenOf(w, 'invoice', id),
    totalCents: (sent as { totalCents: number }).totalCents,
  };
}

/** Pays on the stand-in's own page the way a customer's browser would, and answers where it sent them back. */
export async function payOnStandInPage(
  w: World,
  hostedUrl: string,
  instrument: string,
  method: 'card' | 'ach' = 'card',
): Promise<URL> {
  const page = new URL(hostedUrl);
  const rendered = await w.app.inject({
    method: 'GET',
    url: `${page.pathname}${page.search}`,
  });
  expect(rendered.statusCode, rendered.body).toBe(200);
  const paid = await w.app.inject({
    method: 'POST',
    url: '/payments/fake/pay',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      provider: page.searchParams.get('provider')!,
      account: page.searchParams.get('account')!,
      amount: page.searchParams.get('amount')!,
      ...(page.searchParams.get('intent') ? { intent: page.searchParams.get('intent')! } : {}),
      ...(page.searchParams.get('return') ? { return: page.searchParams.get('return')! } : {}),
      instrument,
      method,
      decision: 'pay',
    }).toString(),
  });
  expect(paid.statusCode, paid.body).toBe(302);
  return new URL(String(paid.headers.location));
}

/**
 * Changes one money setting and leaves the rest as they are. The whole document is saved, and the numbering
 * counters have moved on by now, so anything less than a read-then-write is refused.
 */
export async function patchMoneySettings(
  w: MoneyWorld,
  patch: Record<string, unknown>,
): Promise<void> {
  const { settings } = (await executeQuery(
    api(),
    moneySettingsGet,
    { workspaceId: w.workspaceId },
    actorOf(w.owner),
    meta(),
  )) as { settings: { numbering: Record<string, { next: number }> } & Record<string, unknown> };
  // The counter row is the authority and the document's `next` is only a mirror of it, so a save that sends
  // the stored one back is refused the moment anything has been sent. The page does the same.
  const counters = await rows<{ kind: string; next_number: string }>(
    admin(),
    sql`select kind, next_number::text as next_number from app.document_counters
        where workspace_id = ${w.workspaceId}`,
  );
  const numbering = { ...settings.numbering };
  for (const c of counters)
    numbering[c.kind] = { ...numbering[c.kind]!, next: Number(c.next_number) };
  await run(w, moneySaveSettings, {
    workspaceId: w.workspaceId,
    settings: { ...settings, numbering, ...patch },
  });
}

/** The invoice row as the database has it, for the assertions that are about money and not about JSON. */
export async function invoiceRow(invoiceId: string) {
  const [row] = await rows<{
    status: string;
    amount_paid_cents: number;
    amount_refunded_cents: number;
    balance_cents: number;
    paid_at: Date | null;
  }>(
    admin(),
    sql`select status::text as status, amount_paid_cents::float8 as amount_paid_cents,
          amount_refunded_cents::float8 as amount_refunded_cents, balance_cents::float8 as balance_cents,
          paid_at
        from app.invoices where id = ${invoiceId}`,
  );
  return row!;
}

/** Every payment on an invoice, oldest first. */
export async function paymentRows(invoiceId: string) {
  return rows<{
    id: string;
    status: string;
    method: string;
    amount_cents: number;
    provider_payment_id: string | null;
    provider_status: string | null;
    idempotency_key: string | null;
    card_brand: string | null;
    card_last4: string | null;
  }>(
    admin(),
    sql`select id, status::text as status, method::text as method,
          amount_cents::float8 as amount_cents, provider_payment_id, provider_status, idempotency_key,
          card_brand, card_last4
        from app.payments where invoice_id = ${invoiceId} order by created_at, id`,
  );
}

/** Webhook deliveries this business has stored, newest last. */
export async function deliveryRows(workspaceId: string) {
  return rows<{
    provider: string;
    kind: string;
    dedupe_key: string;
    status: string;
    signature_valid: boolean;
  }>(
    admin(),
    sql`select provider, kind, dedupe_key, status::text as status, signature_valid
        from app.webhook_deliveries
        where workspace_id = ${workspaceId} and provider in ('stripe', 'square')
        order by received_at, id`,
  );
}
