/**
 * `POST /v1/wallet/card`: putting a card on the business's **own** balance, through the payment provider's own
 * page.
 *
 * What is worth doubting here, and so what is tested:
 *
 * - **The card never comes through us.** The route hands back a page to go to, and what it saves afterwards is
 *   read from the provider by the session's id. Nothing in the request, and nothing on the address they came
 *   back on, is ever a card.
 * - **The money is ours.** The card is saved against HandsFreeOS's own customer for this business, so a top-up
 *   charges it on our account and not on the business's Stripe connection (`platform-charges.test.ts` holds
 *   the header itself to account).
 * - **Who may.** A member may read a balance and may not put a card on one.
 * - **Whose page.** A card page another business opened is refused: its id is on their address bar, and taking
 *   it would put their card on this balance.
 * - **A business that has never spent anything.** A card is usually the first thing anybody does to a balance.
 *   A business opens its wallet as it's made, with its $5 starting credit (20261027012500); before then a
 *   wallet waited for the first text, and the route still opens one where there is none, since only
 *   HandsFreeOS may. Before it did, the first press was refused by Postgres.
 */
import { randomUUID } from 'node:crypto';
import { createTokenVerifier } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, signInTestUser, testDbs, testEnv } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_CARDS } from '../src/payments/fake';
import { buildHttpServer } from '../src/http/server';
import { jobs } from '../src/scheduled';
import { admin, moneyWorld, type MoneyWorld } from './money-world';

let w: MoneyWorld;
let app: FastifyInstance;
let ownerToken: string;
let memberToken: string;

beforeAll(async () => {
  w = await moneyWorld('wallet-card');
  const member = await createTestUser('wallet-card-marco', { fullName: 'Marco Tech' });
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

const addCard = (
  token: string | null,
  body: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: '/v1/wallet/card',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { workspaceId: w.workspaceId, ...body },
  });

/** The wallet row as the database holds it: what a card actually landed as. */
async function walletRow() {
  const [row] = await rows<{
    provider: string | null;
    customer_ref: string | null;
    method_token: string | null;
    card_last4: string | null;
    card_requested_at: Date | null;
  }>(
    admin(),
    sql`select provider::text as provider, customer_ref, method_token, card_last4, card_requested_at
        from app.usage_wallets where workspace_id = ${w.workspaceId}`,
  );
  return row ?? null;
}

describe('a card for the business’s own balance', () => {
  it('hands back the provider’s page and says the wallet is waiting for one', async () => {
    // Nothing has been spent here: the wallet the business opened with, and no card on it or asked for.
    expect(await walletRow()).toMatchObject({ method_token: null, card_requested_at: null });
    const res = await addCard(ownerToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const started = res.json() as { stage: string; hostedUrl: string };
    expect(started.stage).toBe('started');
    // The stand-in's page here; Stripe's own with the real thing. Either way, not one of ours.
    expect(started.hostedUrl).toContain('/payments/fake/card');

    const waiting = await walletRow();
    expect(waiting?.card_requested_at).not.toBeNull();
    // Nothing about a card yet: they have only been sent to type one.
    expect(waiting?.method_token).toBeNull();
  });

  it('saves what the session ended with, against our own customer', async () => {
    const started = (await addCard(ownerToken)).json() as { hostedUrl: string };
    const sessionRef = new URL(started.hostedUrl).searchParams.get('session')!;
    const returnUrl = new URL(started.hostedUrl).searchParams.get('return')!;
    expect(returnUrl).toBe(`http://localhost:3000/app/w/${w.workspaceId}/settings/usage`);

    // Typed on the provider's page, exactly as a person would: the page posts, and sends them back.
    const typed = await app.inject({
      method: 'POST',
      url: '/payments/fake/card',
      payload: {
        session: sessionRef,
        return: returnUrl,
        instrument: FAKE_CARDS.succeeds,
        decision: 'save',
      },
    });
    expect(typed.statusCode, typed.body).toBe(302);
    expect(typed.headers['location']).toBe(`${returnUrl}?card=${sessionRef}`);

    const saved = await addCard(ownerToken, { sessionRef });
    expect(saved.statusCode, saved.body).toBe(200);
    const answer = saved.json() as { stage: string; card: { cardLast4: string | null } };
    expect(answer.stage).toBe('saved');
    expect(answer.card.cardLast4).toBe(FAKE_CARDS.succeeds.replace(/\D+/g, '').slice(-4));

    const row = await walletRow();
    expect(row?.provider).toBe('stripe');
    expect(row?.method_token).toBeTruthy();
    // HandsFreeOS's own customer at the provider, not the business's Stripe connection: a top-up charges us.
    expect(row?.customer_ref).toMatch(/^cus_hfos/);
    // No longer waiting: the card is on.
    expect(row?.card_requested_at).toBeNull();
  });

  it('says nothing was saved when the page was left alone', async () => {
    const started = (await addCard(ownerToken)).json() as { hostedUrl: string };
    const sessionRef = new URL(started.hostedUrl).searchParams.get('session')!;

    // Straight back with the provider's own word for it, and with a session nobody finished.
    expect(
      ((await addCard(ownerToken, { sessionRef: 'cancelled' })).json() as { stage: string }).stage,
    ).toBe('cancelled');
    expect(((await addCard(ownerToken, { sessionRef })).json() as { stage: string }).stage).toBe(
      'cancelled',
    );
  });

  it('refuses a card page another business opened, and leaves this balance alone', async () => {
    const before = await walletRow();
    // Another business's page, finished, with its id read off their address bar.
    const platform = w.s.payments.providers.stripe.platform;
    const { customerRef } = await platform.ensureCustomer({
      customerRef: null,
      name: 'Someone Else Plumbing',
      email: null,
      phone: null,
      idempotencyKey: 'wallet-customer:someone-else',
    });
    const theirs = await platform.startCardSession({
      customerRef,
      reference: randomUUID(),
      returnUrl: 'http://localhost:3000/app/w/someone-else/settings/usage',
      idempotencyKey: 'wallet-card:someone-else:1',
    });
    w.s.payments.fake.page.saveCard({
      sessionRef: theirs.sessionRef,
      instrument: FAKE_CARDS.succeeds,
    });

    const tried = await addCard(ownerToken, { sessionRef: theirs.sessionRef });
    expect(tried.statusCode, tried.body).toBe(409);
    expect((tried.json() as { error: { rule: string } }).error.rule).toBe(
      'wallet_card_other_business',
    );
    expect(await walletRow()).toEqual(before);
  });

  it('is an owner’s and an admin’s, never a member’s, and never nobody’s', async () => {
    expect((await addCard(memberToken)).statusCode).toBe(403);
    expect((await addCard(null)).statusCode).toBe(401);
  });
});
