/**
 * What we actually put on the wire to Stripe.
 *
 * Every other money test runs against the stand-in provider (`payments/fake.ts`), which is the right call for
 * testing our own flows — but it means the real adapter's request shape is the one thing nothing checks, and
 * it is the part that spends money. These tests stub `fetch` and read the bytes.
 *
 * Two things are pinned here, both of which fail silently and expensively if they drift:
 *
 * - **The API version.** With no `stripe-version` header Stripe uses the platform account's own default, which
 *   Stripe moves and a dashboard upgrade changes. A response that quietly changes shape under a deploy nobody
 *   made is the worst kind of payments bug.
 * - **Who may be redirected.** A customer sitting at the payment page can be sent to a bank and back. A plan's
 *   cycle at 3am, a held deposit being captured, and a wallet top-up cannot — nobody is there. Stripe decides
 *   that from `allow_redirects`, so it is asserted rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import type { PaymentAccount } from '../src/payments/provider';
import { createStripePayments } from '../src/payments/stripe';

const EXPECTED_API_VERSION = '2026-08-26.dahlia';

const connected: PaymentAccount = {
  provider: 'stripe',
  externalAccountId: 'acct_plumber',
  locationId: null,
  accessToken: null,
  environment: 'test',
};

/** A Stripe adapter whose every call is recorded instead of sent. */
function stripeWatching() {
  const calls: { url: string; headers: Record<string, string>; body: URLSearchParams }[] = [];
  const fetchStub = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: new URLSearchParams(String(init?.body ?? '')),
    });
    return new Response(
      JSON.stringify({
        id: 'pi_1',
        status: 'succeeded',
        amount: 2500,
        client_secret: 'pi_1_secret',
        latest_charge: {},
      }),
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

const prepare = (p: ReturnType<typeof stripeWatching>['provider'], methods: ('card' | 'ach')[]) =>
  p.prepare(connected, {
    amountCents: 12_000,
    methods,
    idempotencyKey: 'pay-1',
    description: 'Invoice 1042',
    customerRef: null,
    hold: false,
    metadata: {},
    returnUrl: null,
  });

describe('the API version', () => {
  it('is pinned on a call made for a business', async () => {
    const { provider, calls } = stripeWatching();
    await prepare(provider, ['card']);
    expect(calls[0]!.headers['stripe-version']).toBe(EXPECTED_API_VERSION);
  });

  it('is pinned on a call made for us, where there is no business account at all', async () => {
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
    expect(calls[0]!.headers['stripe-version']).toBe(EXPECTED_API_VERSION);
    expect(calls[0]!.headers).not.toHaveProperty('stripe-account');
  });

  it('is pinned on a plain read as well as a write', async () => {
    const { provider, calls } = stripeWatching();
    await provider.capabilities(connected);
    expect(calls[0]!.headers['stripe-version']).toBe(EXPECTED_API_VERSION);
  });
});

describe('what the customer is offered', () => {
  /**
   * We used to send `payment_method_types`, which pins the page to exactly the methods we name and switches
   * off everything the seller has enabled in their own dashboard. Stripe's guidance is not to send it at all.
   */
  it('never names the payment methods itself', async () => {
    const { provider, calls } = stripeWatching();
    await prepare(provider, ['ach', 'card']);
    const sent = [...calls[0]!.body.keys()];
    expect(sent.filter((k) => k.startsWith('payment_method_types'))).toEqual([]);
  });

  it('lets Stripe offer whatever the seller has switched on', async () => {
    const { provider, calls } = stripeWatching();
    await prepare(provider, ['ach', 'card']);
    expect(calls[0]!.body.get('automatic_payment_methods[enabled]')).toBe('true');
  });

  it('allows a redirect, because the customer is at the page to come back from one', async () => {
    const { provider, calls } = stripeWatching();
    await prepare(provider, ['card']);
    expect(calls[0]!.body.get('automatic_payment_methods[allow_redirects]')).toBeNull();
  });
});

describe('a charge with nobody watching', () => {
  const noRedirects = (body: URLSearchParams) => {
    expect(body.get('automatic_payment_methods[enabled]')).toBe('true');
    expect(body.get('automatic_payment_methods[allow_redirects]')).toBe('never');
    expect([...body.keys()].filter((k) => k.startsWith('payment_method_types'))).toEqual([]);
  };

  it("refuses redirects when a plan's cycle bills a saved card", async () => {
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
    noRedirects(calls[0]!.body);
  });

  it('refuses redirects when a deposit holds a card', async () => {
    const { provider, calls } = stripeWatching();
    await provider.authorize(connected, {
      amountCents: 5_000,
      method: 'card',
      sourceToken: 'pm_customer',
      idempotencyKey: 'hold-1',
      description: 'Deposit',
      customerRef: 'cus_customer',
      metadata: {},
    });
    noRedirects(calls[0]!.body);
    expect(calls[0]!.body.get('capture_method')).toBe('manual');
  });

  it('refuses redirects when our own wallet tops itself up', async () => {
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
    noRedirects(calls[0]!.body);
  });
});
