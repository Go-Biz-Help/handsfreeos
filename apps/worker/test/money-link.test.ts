/**
 * `POST /v1/money/link`: a customer's own link, for whoever bills to copy. Signed in, with `money.bill` — and
 * only for the customers they're on unless they manage money (0105) — only for something a customer can
 * actually use, never cached — and **exactly the link the messages send**, which is also what
 * `/test/money/link` hands a browser test.
 */
import {
  createTokenVerifier,
  estimateCreate,
  invoiceCreate,
  invoiceVoid,
  subscriptionCancel,
  subscriptionStart,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, signInTestUser, testDbs, testEnv } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { jobs } from '../src/scheduled';
import {
  admin,
  drain,
  errorOf,
  moneyWorld,
  post,
  run,
  sentEstimate,
  sentInvoice,
  type MoneyWorld,
} from './money-world';

let w: MoneyWorld;
/** The world's own services behind a server that checks real sign-ins, so both mint with one key. */
let app: FastifyInstance;
let ownerToken: string;
let memberToken: string;
let memberId: string;

const ONE_LINE = [{ name: 'AC tune-up', quantity: 1, unitPriceCents: 18_000, taxable: true }];

beforeAll(async () => {
  w = await moneyWorld('money-link');
  const member = await createTestUser('money-link-marco', { fullName: 'Marco Tech' });
  memberId = member.id;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${w.workspaceId}, ${member.id}, 'member')`,
  );
  [ownerToken, memberToken] = await Promise.all([signInTestUser(w.owner), signInTestUser(member)]);
  const env = testEnv();
  app = await buildHttpServer({
    ...w.s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    testRoutes: { jobs },
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await w?.app.close();
  await closeTestDbs();
});

/** Copy link, as the web app asks for it. */
const copyLink = (
  token: string | null,
  body: { kind: string; id: string },
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: '/v1/money/link',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { workspaceId: w.workspaceId, ...body },
  });

/** The link the customer was sent, as the test route hands it to a browser test. */
async function sentLink(body: Record<string, string>): Promise<string> {
  const res = await post(w, '/test/money/link', { workspaceId: w.workspaceId, ...body });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { url: string }).url;
}

/** A plan waiting on the customer's card: the page they put one on is the link. */
async function plan(): Promise<string> {
  const started = (await run(w, subscriptionStart, {
    workspaceId: w.workspaceId,
    personId: w.person.id,
    planName: 'Comfort Club',
    priceCents: 2_900,
    interval: 'month',
  })) as { subscriptionId: string };
  await drain(w);
  return started.subscriptionId;
}

describe('copying a customer’s link', () => {
  it('gives an owner the very link the customer was sent, and nothing keeps a copy on the way', async () => {
    const invoice = await sentInvoice(w);
    const res = await copyLink(ownerToken, { kind: 'invoice', id: invoice.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { url } = res.json() as { url: string };
    expect(url).toMatch(/^http:\/\/localhost:3000\/i\/[0-9A-Za-z]{18}$/);
    expect(url).toBe(await sentLink({ invoiceId: invoice.id }));

    const estimate = await sentEstimate(w);
    const est = await copyLink(ownerToken, { kind: 'estimate', id: estimate.id });
    expect(est.statusCode, est.body).toBe(200);
    expect((est.json() as { url: string }).url).toBe(await sentLink({ estimateId: estimate.id }));

    const subscriptionId = await plan();
    const theirs = await copyLink(ownerToken, { kind: 'plan', id: subscriptionId });
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect((theirs.json() as { url: string }).url).toBe(await sentLink({ subscriptionId }));
    expect((theirs.json() as { url: string }).url).toMatch(/\/p\/[0-9A-Za-z]{18}$/);
  });

  it('opens: the copied link is the customer’s page, signed out', async () => {
    const invoice = await sentInvoice(w);
    const { url } = (await copyLink(ownerToken, { kind: 'invoice', id: invoice.id })).json() as {
      url: string;
    };
    const page = await w.app.inject({
      method: 'GET',
      url: `/public/invoice/${url.slice(url.lastIndexOf('/') + 1)}`,
    });
    expect(page.statusCode, page.body).toBe(200);
    expect((page.json() as { invoice: { number: string } }).invoice.number).toBe(invoice.number);
  });

  it('refuses anyone signed out, and a member who may see money but not take it', async () => {
    const invoice = await sentInvoice(w);
    const signedOut = await copyLink(null, { kind: 'invoice', id: invoice.id });
    expect(signedOut.statusCode).toBe(401);
    const member = await copyLink(memberToken, { kind: 'invoice', id: invoice.id });
    expect(member.statusCode).toBe(403);
    expect(member.body).not.toContain('/i/');
  });

  it('gives a member the business lets bill the links of their own customers, and nobody else’s', async () => {
    await rows(
      admin(),
      sql`insert into app.member_permission_overrides (workspace_id, user_id, permission, allowed)
          values (${w.workspaceId}, ${memberId}, 'money.bill', true)`,
    );
    try {
      const invoice = await sentInvoice(w);
      // Not on the customer: to them it isn't there, and nothing about it comes back.
      const notTheirs = await copyLink(memberToken, { kind: 'invoice', id: invoice.id });
      expect(notTheirs.statusCode).toBe(404);
      expect(notTheirs.body).not.toContain('/i/');

      await rows(
        admin(),
        sql`update app.people set team_user_ids = array_append(team_user_ids, ${memberId}::uuid)
            where id = ${w.person.id}`,
      );
      const theirs = await copyLink(memberToken, { kind: 'invoice', id: invoice.id });
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect((theirs.json() as { url: string }).url).toBe(
        await sentLink({ invoiceId: invoice.id }),
      );
    } finally {
      await rows(
        admin(),
        sql`update app.people set team_user_ids = array_remove(team_user_ids, ${memberId}::uuid)
            where id = ${w.person.id}`,
      );
      await rows(
        admin(),
        sql`delete from app.member_permission_overrides
            where workspace_id = ${w.workspaceId} and user_id = ${memberId}`,
      );
    }
  });

  it('refuses a draft, a voided document and a plan that has ended, in words', async () => {
    const draft = (await run(w, invoiceCreate, {
      workspaceId: w.workspaceId,
      personId: w.person.id,
      title: 'AC tune-up',
      lines: ONE_LINE,
    })) as { invoiceId: string };
    const notSent = await copyLink(ownerToken, { kind: 'invoice', id: draft.invoiceId });
    expect(notSent.statusCode).toBe(409);
    expect(errorOf(notSent)).toMatchObject({
      rule: 'money_document_not_sent',
      message: 'Send the invoice first. A draft has no page a customer can open.',
    });

    const draftEstimate = (await run(w, estimateCreate, {
      workspaceId: w.workspaceId,
      personId: w.person.id,
      title: 'AC tune-up',
      lines: ONE_LINE,
    })) as { estimateId: string };
    expect(
      errorOf(await copyLink(ownerToken, { kind: 'estimate', id: draftEstimate.estimateId })).rule,
    ).toBe('money_document_not_sent');

    const voided = await sentInvoice(w);
    await run(w, invoiceVoid, { workspaceId: w.workspaceId, invoiceId: voided.id });
    const gone = await copyLink(ownerToken, { kind: 'invoice', id: voided.id });
    expect(gone.statusCode).toBe(409);
    expect(errorOf(gone).rule).toBe('money_document_voided');

    const ended = await plan();
    await run(w, subscriptionCancel, { workspaceId: w.workspaceId, subscriptionId: ended });
    await drain(w);
    const over = await copyLink(ownerToken, { kind: 'plan', id: ended });
    expect(over.statusCode).toBe(409);
    expect(errorOf(over).rule).toBe('subscription_cancelled');

    // Something that isn't this business's, or isn't anything at all, is simply not there.
    const nowhere = await copyLink(ownerToken, { kind: 'invoice', id: w.person.id });
    expect(nowhere.statusCode).toBe(404);
    const unreadable = await copyLink(ownerToken, { kind: 'receipt', id: voided.id });
    expect(unreadable.statusCode).toBe(400);
  });
});
