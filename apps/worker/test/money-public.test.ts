/**
 * The customer's own money pages: `/e/<token>` to approve an estimate and `/i/<token>` to pay an invoice,
 * signed out, with nothing but the link to go on.
 *
 * What is under test here is everything a customer can do and everything they can't: a good link, a forged
 * one, one the business has since reissued, a withdrawn document, and an invoice already paid. Then paying —
 * on **both** providers through the stand-in, in both of their flows — a card refused, and a bank transfer
 * that sits in `processing` for days and settles later.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { estimateCreate, estimateVoid, invoiceVoid } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMoneyLinks,
  estimateToken,
  estimateUrl,
  invoiceToken,
  invoiceUrl,
  verifyDocumentCode,
} from '../src/money/links';
import {
  FAKE_BANK,
  FAKE_CARDS,
  FAKE_SQUARE_APPLICATION_ID,
  FAKE_STRIPE_PUBLISHABLE_KEY,
} from '../src/payments/fake';
import {
  admin,
  drain,
  errorOf,
  get,
  invoiceRow,
  moneyWorld,
  paymentRows,
  payOnStandInPage,
  post,
  run,
  sentEstimate,
  sentInvoice,
  tokenOf,
  type MoneyWorld,
  type SentDocument,
} from './money-world';

let w: MoneyWorld;

beforeAll(async () => {
  w = await moneyWorld('money-public');
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

interface PayAnswer {
  stage: 'prepared' | 'recorded';
  payment: {
    paymentId: string | null;
    status: string;
    amountCents: number;
    method: string;
    failureMessage?: string | null;
    flow?: string;
    publishableKey?: string;
    accountId?: string;
    locationId?: string | null;
    clientSecret?: string | null;
    providerPaymentId?: string | null;
    hostedUrl?: string | null;
    methods?: string[];
  };
  invoice: { state: string; invoice: { balanceCents: number } };
}

/** Asks the page for a payment session, exactly as the customer's browser does on Pay. */
async function startPayment(
  doc: SentDocument,
  body: Record<string, unknown> = {},
): Promise<{ clientId: string; answer: PayAnswer }> {
  const clientId = randomUUID();
  const res = await post(w, `/public/invoice/${doc.token}/pay`, {
    clientId,
    method: 'card',
    ...body,
  });
  expect(res.statusCode, res.body).toBe(200);
  const answer = res.json() as PayAnswer;
  expect(answer.stage).toBe('prepared');
  return { clientId, answer };
}

/** The whole Stripe journey: prepare, confirm on the stand-in's page, then read the intent back. */
async function payWithStripe(
  doc: SentDocument,
  instrument: string,
  method: 'card' | 'ach' = 'card',
): Promise<PayAnswer> {
  const { clientId, answer } = await startPayment(doc, { method });
  expect(answer.payment.flow).toBe('client_confirm');
  const back = await payOnStandInPage(w, answer.payment.hostedUrl!, instrument, method);
  expect(back.pathname).toBe(`/i/${doc.token}`);
  const done = await post(w, `/public/invoice/${doc.token}/pay`, {
    clientId,
    providerPaymentId: answer.payment.providerPaymentId,
  });
  expect(done.statusCode, done.body).toBe(200);
  const settled = done.json() as PayAnswer;
  expect(settled.stage).toBe('recorded');
  return settled;
}

/** The whole Square journey: tokenise on the stand-in's page, then charge from here. */
async function payWithSquare(doc: SentDocument, instrument: string): Promise<PayAnswer> {
  const { clientId, answer } = await startPayment(doc);
  expect(answer.payment.flow).toBe('server_charge');
  const back = await payOnStandInPage(w, answer.payment.hostedUrl!, instrument, 'card');
  const done = await post(w, `/public/invoice/${doc.token}/pay`, {
    clientId,
    method: 'card',
    sourceToken: back.searchParams.get('token'),
  });
  expect(done.statusCode, done.body).toBe(200);
  return done.json() as PayAnswer;
}

/** The business reissued the document: every link sent before it is retired. */
async function reissue(kind: 'estimate' | 'invoice', id: string): Promise<void> {
  const table = kind === 'estimate' ? sql`app.estimates` : sql`app.invoices`;
  await rows(admin(), sql`update ${table} set link_version = link_version + 1 where id = ${id}`);
}

describe('the links themselves', () => {
  it('keeps working after a key rotation, and never opens the other document', () => {
    const oldKey = randomBytes(32).toString('base64');
    const newKey = randomBytes(32).toString('base64');
    const before = createMoneyLinks({ webUrl: 'https://app.test', key: oldKey });
    const after = createMoneyLinks({
      webUrl: 'https://app.test',
      key: newKey,
      previousKeys: [oldKey],
    });
    const link = { publicRef: 'AbCd1234', documentId: randomUUID(), linkVersion: 3 };
    const sentBefore = estimateToken(before, link).slice(8);
    // A link sent under the old key still opens; one signed with a key we never had never does.
    expect(verifyDocumentCode(after, 'estimate', sentBefore, link.documentId, 3)).toBe(true);
    expect(verifyDocumentCode(after, 'estimate', sentBefore, link.documentId, 2)).toBe(false);
    const stranger = createMoneyLinks({
      webUrl: 'https://app.test',
      key: randomBytes(32).toString('base64'),
    });
    expect(
      verifyDocumentCode(
        after,
        'estimate',
        estimateToken(stranger, link).slice(8),
        link.documentId,
        3,
      ),
    ).toBe(false);
    // Each kind has its own key, so an estimate's code is not an invoice's.
    expect(estimateToken(after, link)).not.toBe(invoiceToken(after, link));
    expect(
      verifyDocumentCode(after, 'invoice', estimateToken(after, link).slice(8), link.documentId, 3),
    ).toBe(false);
    expect(estimateUrl(after, link)).toBe(`https://app.test/e/${estimateToken(after, link)}`);
    expect(invoiceUrl(after, link)).toBe(`https://app.test/i/${invoiceToken(after, link)}`);
  });
});

describe('the estimate a customer was sent', () => {
  it('shows the document, its business and the words it will be approved with', async () => {
    const e = await sentEstimate(w);
    const res = await get(w, `/public/estimate/${e.token}`);
    expect(res.statusCode, res.body).toBe(200);
    // Never cached, and the token never leaves in a Referer header.
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const body = res.json() as {
      state: string;
      business: { name: string };
      customer: { name: string };
      estimate: {
        number: string | null;
        totals: { totalCents: number };
        lines: { name: string }[];
      };
      answer: { canAccept: boolean; canDecline: boolean; wording: string; reason: string | null };
    };
    expect(body.state).toBe('sent');
    expect(body.business.name).toContain('Lone Star');
    expect(body.customer.name).toBe('Maria Lopez');
    expect(body.estimate.number).toBe(e.number);
    expect(body.estimate.lines[0]!.name).toBe('AC tune-up');
    expect(body.estimate.totals.totalCents).toBe(e.totalCents);
    expect(body.answer).toMatchObject({ canAccept: true, canDecline: true, reason: null });
    expect(body.answer.wording.length).toBeGreaterThan(10);
  });

  it('is not found with a wrong code, and out of date once it has been reissued', async () => {
    const e = await sentEstimate(w);
    const wrong = `${e.token.slice(0, -1)}${e.token.endsWith('a') ? 'b' : 'a'}`;
    expect((await get(w, `/public/estimate/${wrong}`)).statusCode).toBe(404);
    expect((await get(w, '/public/estimate/not-a-token')).statusCode).toBe(404);

    await reissue('estimate', e.id);
    const stale = await get(w, `/public/estimate/${e.token}`);
    expect(stale.statusCode).toBe(410);
    expect(errorOf(stale)).toMatchObject({
      rule: 'money_link_stale',
      details: { business: { name: expect.stringContaining('Lone Star') as unknown as string } },
    });
    // The newest link works.
    const fresh = await tokenOf(w, 'estimate', e.id);
    expect((await get(w, `/public/estimate/${fresh}`)).statusCode).toBe(200);
  });

  it('never opens a draft: no link to one was ever sent', async () => {
    const draft = await run(w, estimateCreate, {
      workspaceId: w.workspaceId,
      personId: w.person.id,
      lines: [{ name: 'Draft line', quantity: 1, unitPriceCents: 1_000 }],
    });
    const token = await tokenOf(w, 'estimate', (draft as { estimateId: string }).estimateId);
    expect((await get(w, `/public/estimate/${token}`)).statusCode).toBe(404);
  });

  it('records the name and the moment, and refuses a second approval', async () => {
    const e = await sentEstimate(w);
    const res = await post(w, `/public/estimate/${e.token}/accept`, { name: 'Maria L.' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { state: string; accepted: { at: string; name: string } };
    expect(body.state).toBe('accepted');
    expect(body.accepted.name).toBe('Maria L.');
    const [row] = await rows<{
      accepted_name: string;
      accepted_via: string;
      accepted_at: Date;
      accepted_wording: string;
      accepted_hash: string;
    }>(
      admin(),
      sql`select accepted_name, accepted_via, accepted_at, accepted_wording, accepted_hash
          from app.estimates where id = ${e.id}`,
    );
    expect(row).toMatchObject({ accepted_name: 'Maria L.', accepted_via: 'link' });
    // The database's own clock, the words shown, and a hash of exactly what was approved.
    expect(Math.abs(Date.now() - new Date(row!.accepted_at).getTime())).toBeLessThan(120_000);
    expect(row!.accepted_wording.length).toBeGreaterThan(10);
    expect(row!.accepted_hash.length).toBeGreaterThanOrEqual(16);

    const again = await post(w, `/public/estimate/${e.token}/accept`, { name: 'Maria L.' });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).rule).toBe('estimate_not_open');
    await drain(w);
  });

  it('declines with a reason, and a withdrawn estimate can be read but not answered', async () => {
    const declined = await sentEstimate(w);
    const no = await post(w, `/public/estimate/${declined.token}/decline`, {
      name: 'Maria L.',
      reason: 'Going with someone else.',
    });
    expect(no.statusCode, no.body).toBe(200);
    expect((no.json() as { state: string }).state).toBe('declined');

    const voided = await sentEstimate(w);
    await run(w, estimateVoid, {
      workspaceId: w.workspaceId,
      estimateId: voided.id,
      reason: 'Priced wrong',
    });
    const view = await get(w, `/public/estimate/${voided.token}`);
    expect(view.statusCode).toBe(200);
    expect(
      view.json() as { state: string; answer: { canAccept: boolean; reason: string } },
    ).toMatchObject({ state: 'void', answer: { canAccept: false, reason: 'withdrawn' } });
    expect(
      (await post(w, `/public/estimate/${voided.token}/accept`, { name: 'Maria L.' })).statusCode,
    ).toBe(409);
    await drain(w);
  });

  it('records the first open, and only the first, and only from a POST', async () => {
    const e = await sentEstimate(w);
    // Opening the page changes nothing: mail scanners open links.
    await get(w, `/public/estimate/${e.token}`);
    const [before] = await rows<{ first_viewed_at: Date | null }>(
      admin(),
      sql`select first_viewed_at from app.estimates where id = ${e.id}`,
    );
    expect(before!.first_viewed_at).toBeNull();

    const first = await post(w, `/public/estimate/${e.token}/viewed`, {});
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as { changed: boolean }).changed).toBe(true);
    const second = await post(w, `/public/estimate/${e.token}/viewed`, {});
    expect((second.json() as { changed: boolean }).changed).toBe(false);
    await drain(w);
  });

  it('refuses a filled honeypot without recording anything', async () => {
    const e = await sentEstimate(w);
    const res = await post(w, `/public/estimate/${e.token}/accept`, {
      name: 'A Bot',
      website: 'https://spam.example',
    });
    expect(res.statusCode).toBe(400);
    const [row] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.estimates where id = ${e.id}`,
    );
    expect(row!.status).toBe('sent');
  });
});

describe('the invoice a customer pays', () => {
  it('hands the browser public keys only, and never a secret', async () => {
    const stripeInvoice = await sentInvoice(w);
    const res = await get(w, `/public/invoice/${stripeInvoice.token}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      state: string;
      invoice: { balanceCents: number; number: string | null };
      pay: {
        canPay: boolean;
        methods: string[];
        session: { provider: string; flow: string; publishableKey: string; accountId: string };
      };
    };
    expect(body.state).toBe('sent');
    expect(body.invoice.balanceCents).toBe(stripeInvoice.totalCents);
    expect(body.pay.canPay).toBe(true);
    // Bank transfer leads: it is the cheap rail.
    expect(body.pay.methods).toEqual(['ach', 'card']);
    expect(body.pay.session).toMatchObject({
      provider: 'stripe',
      flow: 'client_confirm',
      publishableKey: FAKE_STRIPE_PUBLISHABLE_KEY,
      accountId: w.stripe.accountId,
    });

    const squareInvoice = await sentInvoice(w, { connectionId: w.square.connectionId });
    const square = await get(w, `/public/invoice/${squareInvoice.token}`);
    const squareBody = square.json() as {
      pay: { session: { publishableKey: string; locationId: string | null; flow: string } };
    };
    expect(squareBody.pay.session).toMatchObject({
      publishableKey: FAKE_SQUARE_APPLICATION_ID,
      flow: 'server_charge',
    });
    expect(squareBody.pay.session.locationId).toContain('fake-location');
    // Nothing that could take money is on the customer's page.
    const text = `${square.body}${res.body}`;
    expect(text).not.toContain('fake-square-token');
    expect(text).not.toContain('fake-stripe-refresh');
    expect(text).not.toContain('sk_');
  });

  it('takes a card through Stripe, and a replayed webhook leaves one payment', async () => {
    const inv = await sentInvoice(w);
    const paid = await payWithStripe(inv, FAKE_CARDS.succeeds);
    expect(paid.payment.status).toBe('succeeded');
    expect(paid.invoice.state).toBe('paid');
    expect(paid.invoice.invoice.balanceCents).toBe(0);
    // The stand-in's own `payment_intent.succeeded` lands afterwards and changes nothing.
    await drain(w);
    const row = await invoiceRow(inv.id);
    expect(row).toMatchObject({ status: 'paid', balance_cents: 0 });
    expect(row.paid_at).not.toBeNull();
    const payments = await paymentRows(inv.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'succeeded', method: 'card' });
  });

  it('takes a tokenised card through Square', async () => {
    const inv = await sentInvoice(w, { connectionId: w.square.connectionId });
    const paid = await payWithSquare(inv, FAKE_CARDS.succeeds);
    expect(paid.payment.status).toBe('succeeded');
    await drain(w);
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    expect(await paymentRows(inv.id)).toHaveLength(1);
  });

  it('answers a declined card with plain words, and leaves the invoice owing', async () => {
    const inv = await sentInvoice(w);
    const refused = await payWithStripe(inv, FAKE_CARDS.declines);
    // A decline is an answer, not an error.
    expect(refused.payment.status).toBe('failed');
    expect(refused.payment.failureMessage).toMatch(/declined/i);
    await drain(w);
    const row = await invoiceRow(inv.id);
    expect(row.status).toBe('sent');
    expect(row.balance_cents).toBe(inv.totalCents);
  });

  it('holds a bank transfer in `paying` for days, then settles it', async () => {
    const inv = await sentInvoice(w);
    const sent = await payWithStripe(inv, FAKE_BANK.settles, 'ach');
    expect(sent.payment.status).toBe('processing');
    // Paying, not overdue: that is the whole point of the status.
    expect(sent.invoice.state).toBe('paying');
    await drain(w);
    expect((await invoiceRow(inv.id)).status).toBe('sent');

    const [payment] = await paymentRows(inv.id);
    const settled = await post(w, '/test/money/provider-event', {
      workspaceId: w.workspaceId,
      paymentId: payment!.provider_payment_id,
      event: 'settle',
    });
    expect(settled.statusCode, settled.body).toBe(200);
    expect((settled.json() as { webhooks: { ok: boolean }[] }).webhooks[0]!.ok).toBe(true);
    await drain(w);
    expect(await invoiceRow(inv.id)).toMatchObject({ status: 'paid', balance_cents: 0 });
  });

  it('shows a paid invoice as a receipt, and refuses to take more', async () => {
    const inv = await sentInvoice(w);
    await payWithStripe(inv, FAKE_CARDS.succeeds);
    await drain(w);
    const res = await get(w, `/public/invoice/${inv.token}`);
    const body = res.json() as {
      state: string;
      payments: { amountCents: number; status: string; method: string }[];
      pay: { canPay: boolean; reason: string };
      invoice: { balanceCents: number; amountPaidCents: number };
    };
    expect(body.state).toBe('paid');
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({ amountCents: inv.totalCents, status: 'succeeded' });
    expect(body.pay).toMatchObject({ canPay: false, reason: 'paid' });
    expect(body.invoice).toMatchObject({ balanceCents: 0, amountPaidCents: inv.totalCents });
    const again = await post(w, `/public/invoice/${inv.token}/pay`, { clientId: randomUUID() });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).rule).toBe('invoice_settled');
  });

  it('refuses to take money on a withdrawn invoice, and says so plainly', async () => {
    const inv = await sentInvoice(w);
    await run(w, invoiceVoid, {
      workspaceId: w.workspaceId,
      invoiceId: inv.id,
      reason: 'Billed twice',
    });
    const view = await get(w, `/public/invoice/${inv.token}`);
    expect(view.statusCode).toBe(200);
    expect(
      view.json() as { state: string; pay: { canPay: boolean; reason: string } },
    ).toMatchObject({ state: 'void', pay: { canPay: false, reason: 'withdrawn' } });
    const pay = await post(w, `/public/invoice/${inv.token}/pay`, { clientId: randomUUID() });
    expect(pay.statusCode).toBe(409);
    expect(errorOf(pay).rule).toBe('invoice_voided');
    await drain(w);
  });

  it('takes one payment for one press, however many times it is sent', async () => {
    const inv = await sentInvoice(w, { connectionId: w.square.connectionId });
    const { clientId, answer } = await startPayment(inv);
    const back = await payOnStandInPage(w, answer.payment.hostedUrl!, FAKE_CARDS.succeeds, 'card');
    const body = {
      clientId,
      method: 'card',
      sourceToken: back.searchParams.get('token'),
    };
    const first = await post(w, `/public/invoice/${inv.token}/pay`, body);
    expect(first.statusCode, first.body).toBe(200);
    const second = await post(w, `/public/invoice/${inv.token}/pay`, body);
    expect(second.statusCode, second.body).toBe(200);
    await drain(w);
    // One key, one charge: the second press is answered with the payment the first one made.
    expect(await paymentRows(inv.id)).toHaveLength(1);
    expect(
      w.s.payments.fake.charges().filter((c) => c.metadata['invoiceId'] === inv.id),
    ).toHaveLength(1);
    expect((await invoiceRow(inv.id)).status).toBe('paid');
  });

  it('never lets a payment id from somewhere else be recorded against this invoice', async () => {
    const mine = await sentInvoice(w);
    const other = await sentInvoice(w);
    const { answer } = await startPayment(other);
    await payOnStandInPage(w, answer.payment.hostedUrl!, FAKE_CARDS.succeeds);
    const stolen = await post(w, `/public/invoice/${mine.token}/pay`, {
      clientId: randomUUID(),
      providerPaymentId: answer.payment.providerPaymentId,
    });
    expect(stolen.statusCode).toBe(409);
    expect(errorOf(stolen).rule).toBe('payment_not_started');
    await drain(w);
    expect((await invoiceRow(mine.id)).status).toBe('sent');
  });
});
