/**
 * The one thing that must never go wrong about the usage wallet's money (M16, step 5): **whose account it
 * lands in**.
 *
 * With Stripe Connect a call carrying the `stripe-account` header acts for a business and money lands in their
 * bank; a call without it acts for us and money lands in ours. That header is the entire difference between
 * HandsFreeOS charging a business for its texts and HandsFreeOS accidentally paying itself out of a plumber's
 * takings. So the provider's `platform` section takes no account at all — there is nothing to pass wrongly —
 * and these tests check the header itself, over a stubbed fetch, rather than trusting that arrangement.
 */
import { describe, expect, it } from 'vitest';
import { fakePaymentServices } from '../src/payments/index';
import { FAKE_CARDS } from '../src/payments/fake';
import { PlatformUnsupportedError, type PaymentAccount } from '../src/payments/provider';
import { createStripePayments } from '../src/payments/stripe';

/** What a browser's payment SDK hands back for a typed card. A card number is not a token. */
const card = (fake: ReturnType<typeof fakePaymentServices>, instrument: string): string =>
  fake.fake.page.tokenise({ instrument, method: 'card' });

const connected: PaymentAccount = {
  provider: 'stripe',
  externalAccountId: 'acct_plumber',
  locationId: null,
  accessToken: null,
  environment: 'test',
};

/** A Stripe adapter whose every call is recorded instead of sent. */
function stripeWatching() {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchStub = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: String(init?.body ?? ''),
    });
    return new Response(
      JSON.stringify({ id: 'pi_1', status: 'succeeded', amount: 2500, latest_charge: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const provider = createStripePayments({
    clientId: 'ca_test',
    secretKey: 'sk_test',
    publishableKey: 'pk_test',
    webhookSecret: 'whsec_test',
    fetch: fetchStub as typeof fetch,
  });
  return { provider, calls };
}

/** A Stripe adapter whose answers are chosen per path, for calls that read something back. */
function stripeAnswering(answers: Record<string, unknown>) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchStub = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    calls.push({
      url: target,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: String(init?.body ?? ''),
    });
    const key = Object.keys(answers).find((path) => target.includes(path));
    return new Response(JSON.stringify(key ? answers[key] : {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const provider = createStripePayments({
    clientId: 'ca_test',
    secretKey: 'sk_test',
    publishableKey: 'pk_test',
    webhookSecret: 'whsec_test',
    fetch: fetchStub as typeof fetch,
  });
  return { provider, calls };
}

describe('the page a card is typed on', () => {
  it('is the provider\u2019s own, opened as us, and sends them back with the session on the address', async () => {
    const { provider, calls } = stripeAnswering({
      '/checkout/sessions': {
        id: 'cs_test_1',
        url: 'https://checkout.stripe.test/c/pay/cs_test_1',
      },
    });
    const session = await provider.platform.startCardSession({
      customerRef: 'cus_hfos_1',
      returnUrl: 'https://app.test/app/w/ws-1/settings/usage',
      idempotencyKey: 'wallet-card:ws-1:1',
    });
    expect(session).toEqual({
      sessionRef: 'cs_test_1',
      hostedUrl: 'https://checkout.stripe.test/c/pay/cs_test_1',
    });
    // Ours, not a seller's: the same header that decides whose money a charge is.
    expect(calls[0]!.headers).not.toHaveProperty('stripe-account');
    const sent = new URLSearchParams(calls[0]!.body);
    // Every field, and nothing else. Stripe refuses one it does not know with a 400, and the stand-in accepts
    // anything — which is how `setup_intent_data[usage]` reached production: this test asserted it was sent,
    // and Stripe had never heard of it. Checkout's SetupIntent is `off_session` without being told.
    expect([...sent.keys()].sort()).toEqual([
      'cancel_url',
      'customer',
      'mode',
      'payment_method_types[0]',
      'success_url',
    ]);
    // Setting a card up for later, and only a card.
    expect(sent.get('mode')).toBe('setup');
    expect(sent.get('customer')).toBe('cus_hfos_1');
    expect(sent.get('payment_method_types[0]')).toBe('card');
    expect(sent.get('success_url')).toBe(
      'https://app.test/app/w/ws-1/settings/usage?card={CHECKOUT_SESSION_ID}',
    );
    expect(sent.get('cancel_url')).toBe(
      'https://app.test/app/w/ws-1/settings/usage?card=cancelled',
    );
  });

  it('reads what it ended with from the provider, never from the address it came back on', async () => {
    const { provider, calls } = stripeAnswering({
      '/checkout/sessions/': {
        id: 'cs_test_1',
        status: 'complete',
        customer: 'cus_hfos_1',
        setup_intent: 'seti_1',
      },
      '/setup_intents/': { id: 'seti_1', payment_method: 'pm_new', customer: 'cus_hfos_1' },
    });
    await expect(provider.platform.readCardSession('cs_test_1')).resolves.toEqual({
      sourceToken: 'pm_new',
      customerRef: 'cus_hfos_1',
    });
    // Both reads are ours, and both are reads: nothing about a card is taken on trust from the browser.
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.headers, c.url).not.toHaveProperty('stripe-account');
      expect(c.body, c.url).toBe('');
    }
  });

  it('answers with no card when nobody finished the page', async () => {
    const { provider } = stripeAnswering({
      '/checkout/sessions/': { id: 'cs_test_1', status: 'open', customer: 'cus_hfos_1' },
    });
    await expect(provider.platform.readCardSession('cs_test_1')).resolves.toEqual({
      sourceToken: null,
      customerRef: 'cus_hfos_1',
    });
  });
});

describe('a charge of ours', () => {
  it('carries no business account, which is what makes the money ours', async () => {
    const { provider, calls } = stripeWatching();
    await provider.platform.charge({
      amountCents: 2500,
      method: 'card',
      sourceToken: 'pm_saved',
      idempotencyKey: 'topup:rc-1',
      description: 'HandsFreeOS usage top-up',
      customerRef: 'cus_hfos_1',
      metadata: {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers).not.toHaveProperty('stripe-account');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk_test');
  });

  it('carries no business account when a card is saved or forgotten either', async () => {
    const { provider, calls } = stripeWatching();
    await provider.platform.ensureCustomer({
      customerRef: null,
      name: 'Lone Star Plumbing',
      email: null,
      phone: null,
      idempotencyKey: 'cus-1',
    });
    await provider.platform.saveMethod({
      customerRef: 'cus_hfos_1',
      sourceToken: 'pm_new',
      idempotencyKey: 'save-1',
    });
    await provider.platform.forgetMethod({ customerRef: 'cus_hfos_1', token: 'pm_old' });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.headers, c.url).not.toHaveProperty('stripe-account');
  });
});

describe('a charge for a business', () => {
  it('still carries their account, exactly as it did before any of this', async () => {
    const { provider, calls } = stripeWatching();
    await provider.charge(connected, {
      amountCents: 12_000,
      method: 'card',
      sourceToken: 'pm_customer',
      idempotencyKey: 'pay-1',
      description: 'Invoice 1042',
      customerRef: 'cus_customer',
      metadata: {},
    });
    expect(calls[0]!.headers['stripe-account']).toBe('acct_plumber');
  });
});

describe('Square', () => {
  /**
   * Not an oversight. Square's API acts only as a seller, with that seller's own token, so there is no
   * equivalent of omitting a header — there is no "us" for Square to charge on behalf of. A business with only
   * Square connected is told so in words, which is what wallet.request_card says back to them.
   */
  it('says plainly that it cannot bill a card for us', async () => {
    const fake = fakePaymentServices('http://localhost:4000');
    const { providers } = fake;
    expect(providers.square.platform.supported).toBe(false);
    await expect(
      providers.square.platform.charge({
        amountCents: 2500,
        method: 'card',
        sourceToken: card(fake, FAKE_CARDS.succeeds),
        idempotencyKey: 'topup:rc-2',
        description: null,
        customerRef: null,
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(PlatformUnsupportedError);
    await expect(
      providers.square.platform.charge({
        amountCents: 2500,
        method: 'card',
        sourceToken: card(fake, FAKE_CARDS.succeeds),
        idempotencyKey: 'topup:rc-3',
        description: null,
        customerRef: null,
        metadata: {},
      }),
    ).rejects.toThrow(/Connect Stripe/);
    // And there is no page for them to type one on either, in the same words.
    await expect(
      providers.square.platform.startCardSession({
        customerRef: 'cus_1',
        returnUrl: 'https://app.test/app/w/ws-1/settings/usage',
        idempotencyKey: 'wallet-card:ws-1:1',
      }),
    ).rejects.toThrow(/Connect Stripe/);
    await expect(providers.square.platform.readCardSession('cs_1')).rejects.toBeInstanceOf(
      PlatformUnsupportedError,
    );
  });
});

describe('the stand-in’s card page', () => {
  it('carries a session from its page to a card the wallet can be charged with', async () => {
    const fake = fakePaymentServices('http://localhost:4000');
    const stripe = fake.providers.stripe;
    const { customerRef } = await stripe.platform.ensureCustomer({
      customerRef: null,
      name: 'Lone Star Plumbing',
      email: null,
      phone: null,
      idempotencyKey: 'cus-1',
    });
    const session = await stripe.platform.startCardSession({
      customerRef,
      returnUrl: 'http://localhost:3000/app/w/ws-1/settings/usage',
      idempotencyKey: 'wallet-card:ws-1:1',
    });
    expect(session.hostedUrl).toContain('/payments/fake/card');
    expect(session.hostedUrl).toContain(`session=${session.sessionRef}`);
    // Nobody has typed anything yet, and that is an answer rather than a failure.
    await expect(stripe.platform.readCardSession(session.sessionRef)).resolves.toEqual({
      sourceToken: null,
      customerRef,
    });

    fake.fake.page.saveCard({ sessionRef: session.sessionRef, instrument: FAKE_CARDS.succeeds });
    const ended = await stripe.platform.readCardSession(session.sessionRef);
    expect(ended.sourceToken).toBeTruthy();
    const saved = await stripe.platform.saveMethod({
      customerRef,
      sourceToken: ended.sourceToken!,
      idempotencyKey: 'save-1',
    });
    expect(saved.last4).toBe(FAKE_CARDS.succeeds.replace(/\D+/g, '').slice(-4));
    // And that card is one our own charges can use.
    const charged = await stripe.platform.charge({
      amountCents: 2500,
      method: 'card',
      sourceToken: saved.token,
      idempotencyKey: 'topup:rc-card',
      description: 'HandsFreeOS usage top-up',
      customerRef,
      metadata: {},
    });
    expect(charged.status).toBe('succeeded');
  });
});

describe('the stand-in', () => {
  it('keeps our charges and a business’s in separate lists', async () => {
    const fake = fakePaymentServices('http://localhost:4000');
    const stripe = fake.providers.stripe;
    const { customerRef } = await stripe.platform.ensureCustomer({
      customerRef: null,
      name: 'Lone Star Plumbing',
      email: null,
      phone: null,
      idempotencyKey: 'cus-1',
    });
    const saved = await stripe.platform.saveMethod({
      customerRef,
      sourceToken: card(fake, FAKE_CARDS.succeeds),
      idempotencyKey: 'save-1',
    });
    const charged = await stripe.platform.charge({
      amountCents: 2500,
      method: 'card',
      sourceToken: saved.token,
      idempotencyKey: 'topup:rc-4',
      description: 'HandsFreeOS usage top-up',
      customerRef,
      metadata: {},
    });
    expect(charged.status).toBe('succeeded');
    expect(fake.fake.platformCharges()).toHaveLength(1);
    // And none of it shows up as a business having taken money from one of its own customers.
    expect(fake.fake.charges()).toHaveLength(0);
  });

  it('answers a declined card rather than throwing at the job that asked', async () => {
    const fake = fakePaymentServices('http://localhost:4000');
    const stripe = fake.providers.stripe;
    const { customerRef } = await stripe.platform.ensureCustomer({
      customerRef: null,
      name: 'Lone Star Plumbing',
      email: null,
      phone: null,
      idempotencyKey: 'cus-2',
    });
    // A card that saves fine and is refused the next time nobody is watching: exactly a top-up's case.
    const saved = await stripe.platform.saveMethod({
      customerRef,
      sourceToken: card(fake, FAKE_CARDS.failsOffSession),
      idempotencyKey: 'save-2',
    });
    const result = await stripe.platform.charge({
      amountCents: 2500,
      method: 'card',
      sourceToken: saved.token,
      idempotencyKey: 'topup:rc-5',
      description: null,
      customerRef,
      metadata: {},
    });
    // A decline is an answer the decline ladder records, never an exception the job retries.
    expect(result.status).toBe('failed');
    expect(result.failureCode).toBeTruthy();
    expect(result.failureMessage).toBeTruthy();
  });

  it('charges one top-up once, however many times the job asks', async () => {
    const fake = fakePaymentServices('http://localhost:4000');
    const stripe = fake.providers.stripe;
    const { customerRef } = await stripe.platform.ensureCustomer({
      customerRef: null,
      name: 'Lone Star Plumbing',
      email: null,
      phone: null,
      idempotencyKey: 'cus-3',
    });
    const saved = await stripe.platform.saveMethod({
      customerRef,
      sourceToken: card(fake, FAKE_CARDS.succeeds),
      idempotencyKey: 'save-3',
    });
    const ask = () =>
      stripe.platform.charge({
        amountCents: 2500,
        method: 'card',
        sourceToken: saved.token,
        idempotencyKey: 'topup:rc-6',
        description: null,
        customerRef,
        metadata: {},
      });
    const first = await ask();
    const again = await ask();
    expect(again.providerPaymentId).toBe(first.providerPaymentId);
    expect(fake.fake.platformCharges()).toHaveLength(1);
  });
});
