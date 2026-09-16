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
import {
  acceptanceWording,
  estimateCreate,
  estimateVoid,
  invoiceVoid,
  paymentRefund,
} from '@hfos/core/server';
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
  BUSINESS_ADDRESS,
  CALENDAR_ADDRESS,
  drain,
  errorOf,
  get,
  invoiceRow,
  moneyWorld,
  patchMoneySettings,
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

interface MoneyTerms {
  kind: string;
  percentBp: number;
  amountCents: number;
}

interface EstimateView {
  state: string;
  business: {
    name: string;
    phone: string | null;
    phoneDisplay: string | null;
    address: string | null;
  };
  customer: { name: string };
  estimate: {
    number: string | null;
    totals: { totalCents: number; discountCents: number; discountPercentBp: number | null };
    discount: MoneyTerms;
    deposit: MoneyTerms;
    depositCents: number;
    lines: { name: string }[];
  };
  answer: { canAccept: boolean; canDecline: boolean; wording: string; reason: string | null };
}

interface InvoiceView {
  state: string;
  invoice: {
    purpose: string;
    balanceCents: number;
    amountPaidCents: number;
    amountRefundedCents: number;
    discount: MoneyTerms;
    totals: { discountPercentBp: number | null };
    number: string | null;
  };
  payments: {
    amountCents: number;
    method: string;
    status: string;
    purpose: string;
    cardBrand: string | null;
    cardLast4: string | null;
    reference: string;
    receivedAt: string | null;
  }[];
  refunds: { amountCents: number; status: string; refundedAt: string | null; reference: string }[];
  pay: {
    canPay: boolean;
    reason: string | null;
    methods: string[];
    session: {
      provider: string;
      flow: string;
      publishableKey: string;
      accountId: string;
      locationId: string | null;
    } | null;
  };
}

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
    const body = res.json() as EstimateView;
    expect(body.state).toBe('sent');
    expect(body.business.name).toContain('Lone Star');
    expect(body.customer.name).toBe('Maria Lopez');
    expect(body.estimate.number).toBe(e.number);
    expect(body.estimate.lines[0]!.name).toBe('AC tune-up');
    expect(body.estimate.totals.totalCents).toBe(e.totalCents);
    expect(body.answer).toMatchObject({ canAccept: true, canDecline: true, reason: null });
    // The sentence names this estimate's own figure and this business: it is the evidence, not a boilerplate.
    expect(body.answer.wording).toBe(acceptanceWording(e.totalCents, body.business.name));
    // `money` shows cents only when there are any, so a round estimate reads "$180".
    expect(body.answer.wording).toContain('$180 from');
  });

  it('shows the discount and the deposit as they were written, and where the business is', async () => {
    const e = await sentEstimate(w, {
      discount: { kind: 'percent', percentBp: 1_000 },
      deposit: { kind: 'percent', percentBp: 2_500 },
    });
    const body = (await get(w, `/public/estimate/${e.token}`)).json() as EstimateView;
    // "Discount · 10% off", not only the amount that came off.
    expect(body.estimate.discount).toEqual({ kind: 'percent', percentBp: 1_000, amountCents: 0 });
    expect(body.estimate.totals.discountPercentBp).toBe(1_000);
    expect(body.estimate.totals.discountCents).toBeGreaterThan(0);
    // "Deposit to start · 25%", beside the figure it comes to.
    expect(body.estimate.deposit).toEqual({ kind: 'percent', percentBp: 2_500, amountCents: 0 });
    expect(body.estimate.depositCents).toBe(Math.round(e.totalCents * 0.25));
    // Until they set one in Settings → Payments, the address they typed for "at our place" stands in.
    expect(body.business.address).toBe(CALENDAR_ADDRESS);

    const flat = await sentEstimate(w, { discount: { kind: 'amount', amountCents: 2_000 } });
    const flatBody = (await get(w, `/public/estimate/${flat.token}`)).json() as EstimateView;
    expect(flatBody.estimate.discount).toEqual({
      kind: 'amount',
      percentBp: 0,
      amountCents: 2_000,
    });
    expect(flatBody.estimate.totals.discountPercentBp).toBeNull();
    expect(flatBody.estimate.deposit.kind).toBe('none');
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

  it('shows the address from Settings → Payments, over the calendar’s stand-in', async () => {
    await patchMoneySettings(w, { businessAddress: BUSINESS_ADDRESS });
    const e = await sentEstimate(w);
    const estimate = (await get(w, `/public/estimate/${e.token}`)).json() as EstimateView;
    // A seller's own address, verbatim and in their own line breaks — never parsed into a city and a state.
    expect(estimate.business.address).toBe(BUSINESS_ADDRESS);
    expect(estimate.business.address).toContain('\n');
    const inv = await sentInvoice(w);
    const invoice = (await get(w, `/public/invoice/${inv.token}`)).json() as {
      business: { address: string | null };
    };
    expect(invoice.business.address).toBe(BUSINESS_ADDRESS);
    // Put back, so the tests that came before this one keep the world they were written against.
    await patchMoneySettings(w, { businessAddress: '' });
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
    // Square names the card too, spelt the way a person writes it.
    const view = (await get(w, `/public/invoice/${inv.token}`)).json() as InvoiceView;
    expect(view.payments[0]).toMatchObject({
      cardBrand: 'Visa',
      cardLast4: FAKE_CARDS.succeeds.slice(-4),
    });
  });

  it('leaves the card brand off a bank transfer, which never had one', async () => {
    const inv = await sentInvoice(w);
    const sent = await payWithStripe(inv, FAKE_BANK.settles, 'ach');
    expect(sent.payment.status).toBe('processing');
    await drain(w);
    const view = (await get(w, `/public/invoice/${inv.token}`)).json() as InvoiceView;
    expect(view.payments[0]).toMatchObject({ method: 'ach', cardBrand: null, cardLast4: null });
    const [row] = await paymentRows(inv.id);
    expect(row).toMatchObject({ card_brand: null, card_last4: null });
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
    const body = res.json() as InvoiceView;
    expect(body.state).toBe('paid');
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({
      amountCents: inv.totalCents,
      status: 'succeeded',
      method: 'card',
      // A payment's purpose is its invoice's, so the receipt line can read "Paid" or "Deposit paid".
      purpose: 'standard',
      // "Visa •••• 4242": what makes a receipt read like a receipt.
      cardBrand: 'Visa',
      cardLast4: FAKE_CARDS.succeeds.slice(-4),
    });
    expect(body.payments[0]!.reference).toMatch(/^[0-9A-F]{8}$/);
    expect(body.payments[0]!.receivedAt).toBeTruthy();
    expect(body.refunds).toEqual([]);
    expect(body.pay).toMatchObject({ canPay: false, reason: 'paid' });
    expect(body.invoice).toMatchObject({ balanceCents: 0, amountPaidCents: inv.totalCents });
    const again = await post(w, `/public/invoice/${inv.token}/pay`, { clientId: randomUUID() });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).rule).toBe('invoice_settled');
  });

  it('says a deposit is a deposit, and names the day money went back', async () => {
    const inv = await sentInvoice(w, {
      purpose: 'deposit',
      connectionId: w.square.connectionId,
      discount: { kind: 'percent', percentBp: 1_000 },
    });
    await payWithSquare(inv, FAKE_CARDS.succeeds);
    await drain(w);
    const before = (await get(w, `/public/invoice/${inv.token}`)).json() as InvoiceView;
    expect(before.invoice.purpose).toBe('deposit');
    expect(before.payments[0]!.purpose).toBe('deposit');
    expect(before.invoice.discount).toEqual({ kind: 'percent', percentBp: 1_000, amountCents: 0 });
    expect(before.invoice.totals.discountPercentBp).toBe(1_000);

    const [payment] = await paymentRows(inv.id);
    const refund = (await run(w, paymentRefund, {
      workspaceId: w.workspaceId,
      paymentId: payment!.id,
      amountCents: 1_000,
      reason: 'Overcharged',
    })) as { refundId: string };
    expect(refund.refundId).toBeTruthy();
    await drain(w);
    const ran = await post(w, '/test/money/run-due', { workspaceId: w.workspaceId });
    expect(ran.statusCode, ran.body).toBe(200);
    await drain(w);

    const after = (await get(w, `/public/invoice/${inv.token}`)).json() as InvoiceView;
    expect(after.refunds).toHaveLength(1);
    expect(after.refunds[0]).toMatchObject({ amountCents: 1_000, status: 'succeeded' });
    // The day it was sent back, not only the amount.
    expect(after.refunds[0]!.refundedAt).toBeTruthy();
    expect(after.refunds[0]!.reference).toMatch(/^[0-9A-F]{8}$/);
    expect(after.invoice.amountRefundedCents).toBe(1_000);
    // Part of it given back is still a paid deposit: nothing owed, and nothing to pay.
    expect(after.state).toBe('partly_refunded');
    expect(after.invoice.balanceCents).toBe(0);
    expect(after.pay).toMatchObject({ canPay: false, reason: 'paid' });
  });

  it('reads as refunded once it all went back, and never asks for the money again', async () => {
    const inv = await sentInvoice(w);
    await payWithStripe(inv, FAKE_CARDS.succeeds);
    await drain(w);
    const [payment] = await paymentRows(inv.id);
    await run(w, paymentRefund, {
      workspaceId: w.workspaceId,
      paymentId: payment!.id,
      reason: 'Job called off',
    });
    await drain(w);
    const ran = await post(w, '/test/money/run-due', { workspaceId: w.workspaceId });
    expect(ran.statusCode, ran.body).toBe(200);
    await drain(w);

    expect(await invoiceRow(inv.id)).toMatchObject({
      status: 'paid',
      amount_refunded_cents: inv.totalCents,
      balance_cents: 0,
    });
    const view = (await get(w, `/public/invoice/${inv.token}`)).json() as InvoiceView;
    expect(view.state).toBe('refunded');
    expect(view.invoice).toMatchObject({
      balanceCents: 0,
      amountPaidCents: inv.totalCents,
      amountRefundedCents: inv.totalCents,
    });
    expect(view.refunds).toHaveLength(1);
    expect(view.refunds[0]!.refundedAt).toBeTruthy();
    expect(view.pay).toMatchObject({ canPay: false, reason: 'paid', session: null });
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
