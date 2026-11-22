/**
 * A deposit taken when a customer books (M9 step 10).
 *
 * The rule under test is Chris's: **a card is held, not charged, until the time is confirmed**, and if the
 * time goes while they are typing, nothing is taken. A bank transfer cannot be held, so a bank deposit on a
 * lost time is sent back in full, at once, without anyone asking.
 *
 * Everything runs against the stand-in provider through its own payment page, which stands exactly where
 * Stripe's Payment Element or Square's Web Payments SDK would.
 */
import { randomUUID } from 'node:crypto';
import {
  bookingConfirmDeposit,
  executeCommand,
  paymentConnectionDisconnect,
  serviceCreate,
  serviceUpdate,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemActor } from '../src/services';
import {
  admin,
  at,
  drain,
  errorOf,
  get,
  makeCalendar,
  makeWorld,
  post,
  run,
  runDue,
  type World,
} from './booking-world';
import { connect, patchMoneySettings, payOnStandInPage, type MoneyWorld } from './money-world';

const CARD_OK = '4242424242424242';
const CARD_DECLINED = '4000000000000002';
const BANK_OK = '000123456789';
const PRICE = 45_000;

type HoldView = {
  state: 'held' | 'booked' | 'gone';
  deposit: {
    mode: string;
    what: string;
    amountCents: number;
    priceCents: number;
    dueAfterCents: number;
    paidCents: number;
    number: string | null;
    cardBrand: string | null;
    cardLast4: string | null;
  };
  pay: { canPay: boolean; reason: string | null; methods: string[]; session: unknown };
  holdToken: string;
  expiresAt: string | null;
  booked: { manageToken: string; contact: { email: string | null } } | null;
};
type Prepared = {
  stage: 'prepared';
  payment: { hostedUrl: string | null; providerPaymentId: string | null };
  hold: HoldView;
};
type Recorded = {
  stage: 'recorded';
  state?: 'gone';
  payment: {
    status: string;
    amountCents: number;
    method: string;
    failureCode: string | null;
    failureMessage: string | null;
    charged?: boolean;
    refunded?: boolean;
  };
  hold: HoldView;
  times?: { startsAt: string }[];
};

let w: MoneyWorld;

/** A booking world that can also take money: both providers signed in, and a 25% deposit set. */
async function depositWorld(label: string): Promise<MoneyWorld> {
  const base = await makeWorld(label);
  const stripe = await connect(base, 'stripe', `acct_${randomUUID().slice(0, 8)}`);
  const square = await connect(base, 'square', `merchant_${randomUUID().slice(0, 8)}`);
  const world = Object.assign(base, {
    person: { id: '', name: '', email: '', phone: '' },
    stripe,
    square,
  }) as MoneyWorld;
  await patchMoneySettings(world, {
    deposit: { kind: 'percent', percentBp: 2_500 },
    bankTransfer: true,
  });
  // Its webhooks arrive at this world's own server, signed with the real algorithms.
  world.s.payments.fake.setDeliver(async (delivery) => {
    const url = new URL(delivery.url);
    const res = await world.app.inject({
      method: 'POST',
      url: `${url.pathname}${url.search}`,
      headers: { 'content-type': 'application/json', ...delivery.headers },
      payload: delivery.body,
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300 };
  });
  return world;
}

/** A calendar that asks for a deposit on a priced service. */
async function depositCalendar(
  world: World,
  name: string,
  payments: Record<string, unknown> = { mode: 'deposit' },
  priceCents: number | null = PRICE,
) {
  const service = await run(world, serviceCreate, {
    workspaceId: world.workspaceId,
    name,
    durations: [180],
    priceCents,
  });
  const serviceId = (service as { serviceId: string }).serviceId;
  const calendar = await makeCalendar(world, name, {
    services: { mode: 'one', items: [{ serviceId }] },
    payments,
  });
  return { ...calendar, serviceId };
}

const customer = (first: string) => ({
  name: `${first} Customer`,
  phone: `+1713555${String(1000 + Math.floor(Math.random() * 8999)).padStart(4, '0')}`,
  email: `${first.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
});

/** Books and gets the hold back: the time is taken, nobody has been told, and a deposit is due. */
async function hold(
  world: World,
  slug: string,
  startsAt: number,
  who = customer('Dana'),
): Promise<HoldView> {
  const res = await post(world, `/public/book/${world.site}/${slug}/bookings`, {
    clientId: randomUUID(),
    startsAt: new Date(startsAt).toISOString(),
    ...who,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as HoldView;
}

const pay = (world: World, token: string, body: Record<string, unknown>) =>
  post(world, `/public/hold/${token}/pay`, { clientId: randomUUID(), ...body });

/** The whole payment, the way a browser does it: a session, the provider's page, then the answer. */
async function payDeposit(
  world: World,
  token: string,
  instrument: string,
  method: 'card' | 'ach' = 'card',
  between?: () => Promise<void>,
): Promise<Recorded> {
  const clientId = randomUUID();
  const first = await post(world, `/public/hold/${token}/pay`, { clientId, method });
  expect(first.statusCode, first.body).toBe(200);
  const prepared = first.json() as Prepared;
  expect(prepared.stage).toBe('prepared');
  const back = await payOnStandInPage(world, prepared.payment.hostedUrl!, instrument, method);
  // Somebody else takes the time while the customer is on the provider's page.
  if (between) await between();
  const second = await post(world, `/public/hold/${token}/pay`, {
    clientId,
    method,
    ...(back.searchParams.get('payment')
      ? { providerPaymentId: back.searchParams.get('payment')! }
      : { sourceToken: back.searchParams.get('token')! }),
  });
  expect(second.statusCode, second.body).toBe(200);
  return second.json() as Recorded;
}

async function invoiceOf(attendeeToken: string) {
  const [row] = await rows<{
    id: string;
    status: string;
    purpose: string;
    origin: string;
    number: string | null;
    total_cents: number;
    amount_paid_cents: number;
    amount_refunded_cents: number;
    attendee_id: string | null;
  }>(
    admin(),
    sql`select i.id, i.status::text as status, i.purpose::text as purpose, i.origin::text as origin,
          i.number, i.total_cents::float8 as total_cents,
          i.amount_paid_cents::float8 as amount_paid_cents,
          i.amount_refunded_cents::float8 as amount_refunded_cents, i.attendee_id
        from app.invoices i
        join app.appointment_attendees a on a.id = i.attendee_id
        where a.public_ref = ${attendeeToken.slice(0, 8)}`,
  );
  return row;
}

async function paymentsOf(invoiceId: string) {
  return rows<{ status: string; method: string; amount_cents: number; provider_status: string }>(
    admin(),
    sql`select status::text as status, method::text as method, amount_cents::float8 as amount_cents,
          provider_status
        from app.payments where invoice_id = ${invoiceId} order by created_at, id`,
  );
}

async function refundsOf(invoiceId: string) {
  return rows<{ id: string; status: string; amount_cents: number }>(
    admin(),
    sql`select id, status::text as status, amount_cents::float8 as amount_cents
        from app.refunds where invoice_id = ${invoiceId}`,
  );
}

async function attendeeOf(token: string) {
  const [row] = await rows<{ id: string; status: string; appointment_status: string }>(
    admin(),
    sql`select a.id, a.status::text as status, p.status::text as appointment_status
        from app.appointment_attendees a join app.appointments p on p.id = a.appointment_id
        where a.public_ref = ${token.slice(0, 8)}`,
  );
  return row;
}

/** Still a hold, not a booking: the time is taken, the deposit is an unnumbered draft, and nobody was told. */
async function expectStillHeld(token: string) {
  const view = await get(w, `/public/hold/${token}`);
  expect(view.statusCode, view.body).toBe(200);
  expect((view.json() as HoldView).state).toBe('held');
  expect((view.json() as HoldView).booked).toBeNull();
  expect(await invoiceOf(token)).toMatchObject({ status: 'draft', number: null });
  expect(await attendeeOf(token)).toMatchObject({
    status: 'booked',
    appointment_status: 'scheduled',
  });
  const [announced] = await rows<{ n: number }>(
    admin(),
    sql`select count(*)::int as n from app.events e
        join app.appointment_attendees a on a.appointment_id = e.entity_id
        where a.public_ref = ${token.slice(0, 8)} and e.event_type = 'appointment.booked'`,
  );
  expect(announced?.n).toBe(0);
}

/** Phase one only: the session the browser would take to the provider, which nobody then pays. */
async function startOnly(token: string, method: 'card' | 'paypal' = 'card') {
  const clientId = randomUUID();
  const res = await post(w, `/public/hold/${token}/pay`, { clientId, method });
  expect(res.statusCode, res.body).toBe(200);
  const prepared = res.json() as Prepared;
  expect(prepared.stage).toBe('prepared');
  expect(prepared.payment.providerPaymentId).toBeTruthy();
  return { clientId, prepared, id: prepared.payment.providerPaymentId! };
}

beforeAll(async () => {
  w = await depositWorld('deposit');
}, 120_000);

afterAll(async () => {
  await w?.app.close();
});

describe('a deposit at booking', () => {
  it('raises its own invoice, holds the card, and captures once the time is confirmed', async () => {
    const cal = await depositCalendar(w, 'Duct cleaning');
    const held = await hold(w, cal.slug, at(2, '09:00'));

    // Held, not confirmed: a deposit is due and nothing has been said to anybody.
    expect(held.state).toBe('held');
    expect(held.deposit).toMatchObject({
      mode: 'deposit',
      amountCents: PRICE / 4,
      priceCents: PRICE,
      dueAfterCents: PRICE - PRICE / 4,
      paidCents: 0,
      number: null,
    });
    expect(held.pay.canPay).toBe(true);
    expect(held.expiresAt).toBeTruthy();
    expect(held.booked).toBeNull();

    // The deposit is its own invoice, linked to the seat, and still a draft while it is being paid.
    const draft = await invoiceOf(held.holdToken);
    expect(draft).toMatchObject({
      status: 'draft',
      purpose: 'deposit',
      origin: 'booking',
      number: null,
      total_cents: PRICE / 4,
    });

    const paid = await payDeposit(w, held.holdToken, CARD_OK);
    expect(paid.payment.status).toBe('succeeded');
    expect(paid.hold.state).toBe('booked');
    expect(paid.hold.deposit.paidCents).toBe(PRICE / 4);
    expect(paid.hold.deposit.cardLast4).toBe('4242');
    // Only now is it a document that really went out: numbered, frozen and paid.
    expect(paid.hold.deposit.number).toBeTruthy();
    expect(paid.hold.booked?.manageToken).toBeTruthy();

    const settled = await invoiceOf(held.holdToken);
    expect(settled).toMatchObject({ status: 'paid', amount_paid_cents: PRICE / 4 });
    const money = await paymentsOf(settled!.id);
    expect(money).toHaveLength(1);
    expect(money[0]).toMatchObject({ status: 'succeeded', method: 'card' });
    await drain(w);
  });

  it('takes nothing when the time goes while they are paying, and lets the hold go', async () => {
    const cal = await depositCalendar(w, 'Roof check');
    const when = at(3, '13:00');
    const held = await hold(w, cal.slug, when);
    const invoice = await invoiceOf(held.holdToken);

    // The time goes while they are on the provider's page: the hold runs out and somebody else takes it.
    const answer = await payDeposit(w, held.holdToken, CARD_OK, 'card', async () => {
      await runDue(w, [`deposit-hold:${(await attendeeOf(held.holdToken))!.id}`]);
    });

    expect(answer.state).toBe('gone');
    expect(answer.payment).toMatchObject({ charged: false, refunded: false, status: 'failed' });
    expect(answer.payment.failureMessage).toContain('nothing was charged');
    expect(answer.hold.state).toBe('gone');
    // Other times to pick from, as the canvas draws it.
    expect(answer.times?.length).toBeGreaterThan(0);

    // Nothing was ever taken: the payment ends failed, and the hold at the provider was let go.
    const money = await paymentsOf(invoice!.id);
    expect(money.every((p) => p.status !== 'succeeded')).toBe(true);
    expect(await refundsOf(invoice!.id)).toHaveLength(0);
    const charge = w.s.payments.fake.charges().find((c) => c.amountCents === PRICE / 4);
    expect(charge?.capturable).toBe(false);
    expect((await invoiceOf(held.holdToken))?.status).toBe('void');
    await drain(w);
  });

  it('sends a bank deposit straight back, in full, when the time goes as it is taken', async () => {
    const cal = await depositCalendar(w, 'Drain clearing');
    const held = await hold(w, cal.slug, at(4, '10:00'));
    const invoice = await invoiceOf(held.holdToken);
    const seat = await attendeeOf(held.holdToken);

    /**
     * The worst moment there is: the time goes while the bank transfer is being taken. The stand-in posts its
     * "payment is on its way" webhook from inside the charge, so releasing the hold there puts the race
     * exactly where it hurts — the money has left and the time is gone.
     */
    const deliver = w.s.payments.fake;
    let released = false;
    deliver.setDeliver(async () => {
      if (!released) {
        released = true;
        await post(w, '/test/scheduled-jobs/run-due', {
          workspaceId: w.workspaceId,
          dedupeKeys: [`deposit-hold:${seat!.id}`],
        });
      }
      return { ok: false };
    });
    const answer = await payDeposit(w, held.holdToken, BANK_OK, 'ach');
    expect(released).toBe(true);
    expect(answer.state).toBe('gone');
    expect(answer.payment.charged).toBe(false);
    expect(answer.payment.refunded).toBe(true);
    expect(answer.payment.failureMessage).toContain('sent your deposit straight back');

    // The whole amount is put back the moment it lands: nobody asked, and nobody had to.
    const raised = await refundsOf(invoice!.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ amount_cents: PRICE / 4, status: 'pending' });
    expect((await attendeeOf(held.holdToken))!.appointment_status).toBe('cancelled');

    // The bank takes days. When the transfer settles, the refund goes without anyone touching it.
    deliver.setDeliver(async (delivery) => {
      const url = new URL(delivery.url);
      const res = await w.app.inject({
        method: 'POST',
        url: `${url.pathname}${url.search}`,
        headers: { 'content-type': 'application/json', ...delivery.headers },
        payload: delivery.body,
      });
      return { ok: res.statusCode >= 200 && res.statusCode < 300 };
    });
    const charge = deliver.charges().find((c) => c.method === 'ach' && c.amountCents === PRICE / 4);
    deliver.settle(charge!.id);
    await drain(w);
    await runDue(w, [`payment.refund:${raised[0]!.id}`]);
    expect((await refundsOf(invoice!.id))[0]).toMatchObject({
      status: 'succeeded',
      amount_cents: PRICE / 4,
    });
    expect(deliver.refunds().length).toBeGreaterThan(0);
  });

  it('gives the time back when nobody pays, and says so if they come back', async () => {
    const cal = await depositCalendar(w, 'Filter swap');
    const when = at(5, '11:00');
    const held = await hold(w, cal.slug, when);
    const seat = await attendeeOf(held.holdToken);

    await runDue(w, [`deposit-hold:${seat!.id}`]);

    const after = await attendeeOf(held.holdToken);
    expect(after!.appointment_status).toBe('cancelled');
    expect((await invoiceOf(held.holdToken))?.status).toBe('void');
    // The time is open again: somebody else can hold it.
    const other = await hold(w, cal.slug, when, customer('Second'));
    expect(other.state).toBe('held');
    expect(other.deposit.amountCents).toBe(PRICE / 4);
    await drain(w);
  });

  it('answers a second attempt with the payment it already made', async () => {
    const cal = await depositCalendar(w, 'Vent check');
    const held = await hold(w, cal.slug, at(6, '09:00'));
    const first = await payDeposit(w, held.holdToken, CARD_OK);
    expect(first.hold.state).toBe('booked');

    const again = await pay(w, held.holdToken, { method: 'card' });
    expect(again.statusCode, again.body).toBe(200);
    const body = again.json() as { stage: string; hold: HoldView };
    expect(body.stage).toBe('recorded');
    expect(body.hold.state).toBe('booked');

    const invoice = await invoiceOf(held.holdToken);
    // One payment, once: the second press charged nothing.
    expect(await paymentsOf(invoice!.id)).toHaveLength(1);
    expect(invoice).toMatchObject({ amount_paid_cents: PRICE / 4 });
    await drain(w);
  });

  it('keeps the time held when a card is refused, so they can try another', async () => {
    const cal = await depositCalendar(w, 'Thermostat fitting');
    const held = await hold(w, cal.slug, at(7, '14:00'));
    const refused = await payDeposit(w, held.holdToken, CARD_DECLINED);

    expect(refused.payment.status).toBe('failed');
    expect(refused.payment.failureMessage).toBeTruthy();
    expect(refused.hold.state).toBe('held');
    expect(refused.hold.pay.canPay).toBe(true);

    const good = await payDeposit(w, held.holdToken, CARD_OK);
    expect(good.hold.state).toBe('booked');
    expect(good.hold.deposit.paidCents).toBe(PRICE / 4);
    await drain(w);
  });

  it('never confirms the time on an intent nobody confirmed, and the hold still runs out', async () => {
    const cal = await depositCalendar(w, 'Unpaid intent');
    const when = at(16, '09:00');
    const held = await hold(w, cal.slug, when);
    const { clientId, id } = await startOnly(held.holdToken);
    expect(id).toMatch(/^pi_/);

    // Straight back with the intent, no card ever entered: Stripe says it still needs paying.
    const res = await post(w, `/public/hold/${held.holdToken}/pay`, {
      clientId,
      method: 'card',
      providerPaymentId: id,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).rule).toBe('deposit_not_paid');
    expect(errorOf(res).message).toContain('isn’t booked');
    await expectStillHeld(held.holdToken);
    const invoice = await invoiceOf(held.holdToken);
    expect((await paymentsOf(invoice!.id)).map((p) => p.status)).toEqual(['requires_payment']);

    // Fifteen minutes on, the time goes back as it would for anyone who never paid.
    await runDue(w, [`deposit-hold:${(await attendeeOf(held.holdToken))!.id}`]);
    expect((await attendeeOf(held.holdToken))!.appointment_status).toBe('cancelled');
    expect((await hold(w, cal.slug, when, customer('Next'))).state).toBe('held');
    await drain(w);
  });

  it('refuses a payment id this deposit never started, then confirms the one it did', async () => {
    const cal = await depositCalendar(w, 'Borrowed intent');
    const held = await hold(w, cal.slug, at(17, '09:00'));

    // Made up.
    const madeUp = await pay(w, held.holdToken, { method: 'card', providerPaymentId: 'pi_madeup' });
    expect(madeUp.statusCode, madeUp.body).toBe(409);
    expect(errorOf(madeUp).rule).toBe('payment_not_started');

    // Another booking's, really held on its card: it belongs to that deposit, not this one.
    const other = await hold(w, cal.slug, at(17, '14:00'), customer('Other'));
    const started = await startOnly(other.holdToken);
    await payOnStandInPage(w, started.prepared.payment.hostedUrl!, CARD_OK);
    const borrowed = await pay(w, held.holdToken, {
      method: 'card',
      providerPaymentId: started.id,
    });
    expect(borrowed.statusCode, borrowed.body).toBe(409);
    expect(errorOf(borrowed).rule).toBe('payment_not_started');
    await expectStillHeld(held.holdToken);
    // Nothing was taken from the other customer's card on this one's behalf.
    expect(w.s.payments.fake.charges().find((c) => c.id === started.id)?.capturable).toBe(true);

    // The deposit paid the ordinary way still confirms the time.
    const paid = await payDeposit(w, held.holdToken, CARD_OK);
    expect(paid.hold.state).toBe('booked');
    expect(paid.hold.deposit.paidCents).toBe(PRICE / 4);
    await drain(w);
  });

  it('never lets anything confirm a deposit that wasn’t paid', async () => {
    const cal = await depositCalendar(w, 'Direct confirm');
    const held = await hold(w, cal.slug, at(18, '09:00'));
    await startOnly(held.holdToken);
    const seat = await attendeeOf(held.holdToken);
    const invoice = await invoiceOf(held.holdToken);

    await expect(
      executeCommand(
        testDbs().worker.db,
        bookingConfirmDeposit,
        { workspaceId: w.workspaceId, attendeeId: seat!.id, invoiceId: invoice!.id },
        systemActor({ workspaceId: w.workspaceId, organizationId: w.organizationId }),
        { correlationId: randomUUID(), channel: 'worker' },
      ),
    ).rejects.toMatchObject({ rule: 'deposit_not_paid' });
    await expectStillHeld(held.holdToken);
  });

  it('asks for the full price, or the calendar’s own figure, or nothing at all', async () => {
    const full = await depositCalendar(w, 'Full survey', { mode: 'full' });
    const wholly = await hold(w, full.slug, at(8, '09:00'));
    expect(wholly.deposit).toMatchObject({
      mode: 'full',
      amountCents: PRICE,
      dueAfterCents: 0,
    });

    const own = await depositCalendar(w, 'Set deposit', {
      mode: 'deposit',
      deposit: { kind: 'amount', amountCents: 9_900 },
    });
    const set = await hold(w, own.slug, at(9, '09:00'));
    expect(set.deposit.amountCents).toBe(9_900);

    /**
     * A calendar can't be turned on asking for a share of a price nobody set — the validator refuses that
     * (payment_without_price). But a live one can lose its price afterwards, and then a share of nothing is
     * nothing: the booking goes through as it always has, rather than holding a time for $0.
     */
    const priced = await depositCalendar(w, 'Price removed');
    await run(w, serviceUpdate, {
      workspaceId: w.workspaceId,
      serviceId: priced.serviceId,
      priceCents: null,
    });
    const booked = (await hold(
      w,
      priced.slug,
      at(10, '09:00'),
      customer('Unpriced'),
    )) as unknown as {
      manageToken: string;
    };
    expect(booked.manageToken).toBeTruthy();
    await drain(w);
  });

  it('refuses a hold nobody can be paid for, in plain words', async () => {
    // A calendar paid into an account of its own, which the business then disconnects: nothing can be taken,
    // so nobody is offered a time they could never hold.
    const extra = await connect(w, 'stripe', `acct_${randomUUID().slice(0, 8)}`);
    const cal = await depositCalendar(w, 'Unpaid calendar', {
      mode: 'deposit',
      connectionId: extra.connectionId,
    });
    await run(w, paymentConnectionDisconnect, {
      workspaceId: w.workspaceId,
      connectionId: extra.connectionId,
    });
    const res = await post(w, `/public/book/${w.site}/${cal.slug}/bookings`, {
      clientId: randomUUID(),
      startsAt: new Date(at(11, '09:00')).toISOString(),
      ...customer('Nowhere'),
    });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).rule).toBe('payment_unavailable');
    await drain(w);
  });

  it('never hands the browser anything secret', async () => {
    const cal = await depositCalendar(w, 'Keys check');
    const held = await hold(w, cal.slug, at(12, '09:00'));
    const view = await get(w, `/public/hold/${held.holdToken}`);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.body).not.toContain('sk_');
    expect(view.body).not.toContain('fake-square-token');
    expect((view.json() as HoldView).pay.session).toMatchObject({ provider: 'stripe' });
  });
});

/**
 * PayPal's buttons beside the card box (PayPal plan, part 4). They hold the deposit the way a card is held: an
 * order made for authorization, approved in PayPal's window, held there, and taken once the time is confirmed.
 * Connected last, so the tests above see a business with Stripe and Square only.
 */
describe('a deposit through PayPal', () => {
  let paypal: { connectionId: string; accountId: string };
  type PayPalHold = HoldView & {
    pay: HoldView['pay'] & {
      payPal: { merchantId: string; intent: string; venmo: boolean; payLater: boolean } | null;
    };
  };
  type PayPalPrepared = {
    stage: 'prepared';
    payment: { provider: string; method: string; providerPaymentId: string; hostedUrl: string };
  };

  beforeAll(async () => {
    paypal = await connect(w, 'paypal', `PAYPAL${randomUUID().slice(0, 8).toUpperCase()}`);
  });

  /** Phase one for PayPal's button, then PayPal's window approving the order. */
  async function approveOrder(token: string) {
    const clientId = randomUUID();
    const first = await post(w, `/public/hold/${token}/pay`, { clientId, method: 'paypal' });
    expect(first.statusCode, first.body).toBe(200);
    const prepared = first.json() as PayPalPrepared;
    expect(prepared.payment).toMatchObject({ provider: 'paypal', method: 'paypal' });
    expect(prepared.payment.providerPaymentId).toMatch(/^ORDER_/);
    await payOnStandInPage(w, prepared.payment.hostedUrl, CARD_OK, 'card');
    return { clientId, order: prepared.payment.providerPaymentId };
  }

  it('shows PayPal beside the card box, holds the deposit there, and takes it once the time is confirmed', async () => {
    const cal = await depositCalendar(w, 'Gutter cleaning');
    const held = (await hold(w, cal.slug, at(13, '09:00'))) as PayPalHold;
    expect(held.pay.session).toMatchObject({ provider: 'stripe' });
    // Held, not taken: Venmo and Pay Later can't be held, so they stay off on a deposit.
    expect(held.pay.payPal).toMatchObject({
      merchantId: paypal.accountId,
      intent: 'authorize',
      venmo: false,
      payLater: false,
    });

    const { clientId, order } = await approveOrder(held.holdToken);
    // Coming back from PayPal names only the order: the row it started on says it was PayPal's.
    const second = await post(w, `/public/hold/${held.holdToken}/pay`, {
      clientId,
      providerPaymentId: order,
    });
    expect(second.statusCode, second.body).toBe(200);
    const paid = second.json() as Recorded;
    expect(paid.payment.status).toBe('succeeded');
    expect(paid.hold.state).toBe('booked');

    const invoice = await invoiceOf(held.holdToken);
    expect(invoice).toMatchObject({ status: 'paid', amount_paid_cents: PRICE / 4 });
    const [row] = await rows<{
      provider: string;
      connection_id: string;
      status: string;
      provider_payment_id: string;
    }>(
      admin(),
      sql`select provider::text as provider, connection_id, status::text as status, provider_payment_id
          from app.payments where invoice_id = ${invoice!.id}`,
    );
    expect(row).toMatchObject({
      provider: 'paypal',
      connection_id: paypal.connectionId,
      status: 'succeeded',
    });
    // The order became a hold, and the hold a capture.
    expect(row!.provider_payment_id).toMatch(/^CAPTURE_/);
    await drain(w);
  });

  it('never confirms the time on an order nobody approved', async () => {
    const cal = await depositCalendar(w, 'Unapproved order');
    const held = await hold(w, cal.slug, at(19, '09:00'));
    const { clientId, prepared, id } = await startOnly(held.holdToken, 'paypal');
    expect(id).toMatch(/^ORDER_/);

    // Back with the order, though PayPal's window was never used: nothing is held there.
    const res = await post(w, `/public/hold/${held.holdToken}/pay`, {
      clientId,
      method: 'paypal',
      providerPaymentId: id,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).rule).toBe('deposit_not_paid');
    await expectStillHeld(held.holdToken);

    // Approved after all: the same order now holds the deposit, and the time is confirmed.
    await payOnStandInPage(w, prepared.payment.hostedUrl!, CARD_OK, 'card');
    const second = await post(w, `/public/hold/${held.holdToken}/pay`, {
      clientId,
      providerPaymentId: id,
    });
    expect(second.statusCode, second.body).toBe(200);
    const paid = second.json() as Recorded;
    expect(paid.hold.state).toBe('booked');
    expect(await invoiceOf(held.holdToken)).toMatchObject({
      status: 'paid',
      amount_paid_cents: PRICE / 4,
    });
    await drain(w);
  });

  it('asks PayPal to hold nothing when the time goes while they are in its window', async () => {
    const cal = await depositCalendar(w, 'Window wash');
    const held = await hold(w, cal.slug, at(14, '09:00'));
    const invoice = await invoiceOf(held.holdToken);
    const { clientId, order } = await approveOrder(held.holdToken);
    await runDue(w, [`deposit-hold:${(await attendeeOf(held.holdToken))!.id}`]);

    const res = await post(w, `/public/hold/${held.holdToken}/pay`, {
      clientId,
      providerPaymentId: order,
    });
    expect(res.statusCode, res.body).toBe(200);
    const answer = res.json() as Recorded;
    expect(answer.state).toBe('gone');
    expect(answer.payment).toMatchObject({ charged: false, refunded: false, status: 'failed' });
    expect(await refundsOf(invoice!.id)).toHaveLength(0);
    expect((await invoiceOf(held.holdToken))?.status).toBe('void');
  });

  it('leaves PayPal off a deposit when its account can’t hold money', async () => {
    await admin().execute(
      sql`update app.payment_connections
          set capabilities = capabilities || '{"holds": false}'::jsonb
          where id = ${paypal.connectionId}`,
    );
    try {
      const cal = await depositCalendar(w, 'Chimney sweep');
      const held = (await hold(w, cal.slug, at(15, '09:00'))) as PayPalHold;
      expect(held.pay.payPal).toBeNull();
      expect(held.pay.session).toMatchObject({ provider: 'stripe' });
      const res = await pay(w, held.holdToken, { method: 'paypal' });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).rule).toBe('payment_unavailable');
    } finally {
      await admin().execute(
        sql`update app.payment_connections
            set capabilities = capabilities || '{"holds": true}'::jsonb
            where id = ${paypal.connectionId}`,
      );
    }
  });
});
