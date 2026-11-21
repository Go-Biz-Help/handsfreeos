/**
 * What we actually put on the wire to PayPal, and how its answers and webhooks are read (the PayPal plan, part 2).
 *
 * Every other money test runs against the stand-in (`payments/fake.ts`), so the real adapter's requests are pinned
 * here with a stubbed `fetch`. The parts that fail silently and expensively if they drift:
 *
 * - **Who a call is for.** Every call for a business carries our own token plus a `PayPal-Auth-Assertion` naming
 *   that business; without it the money would be asked of our own account.
 * - **Who signed up.** The address bar on the way back can be typed by anyone, so the seller is found again by the
 *   tracking id we gave PayPal, under our own partner account.
 * - **One press, one payment.** Capturing twice is answered by PayPal's request id, never a second capture.
 * - **Webhook signatures**, checked against a certificate only PayPal's own host may serve.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  disputeFactsOf,
  paymentFactsOf,
  paymentKindOf,
  refundFactsOf,
} from '../src/money/webhook-events';
import { createPayPalPayments, readPayPalEvent } from '../src/payments/paypal';
import {
  centsOfDecimal,
  decimalOfCents,
  PaymentAuthError,
  PaymentError,
  type PaymentAccount,
} from '../src/payments/provider';

const HOST = 'https://api-m.sandbox.paypal.com';
const PARTNER = 'PARTNER123456';
const CLIENT_ID = 'AbcPayPalClientId';
const SELLER = 'SELLER7Q4ZK2M';

const connected: PaymentAccount = {
  provider: 'paypal',
  externalAccountId: SELLER,
  locationId: null,
  accessToken: null,
  environment: 'test',
};

interface Call {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A request body read back in a test, followed down any path. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Route = (call: Call) => { status?: number; body?: unknown; text?: string } | undefined;

/** A PayPal adapter whose every call is recorded and answered by `route` (the token call is answered here). */
function payPalWatching(route: Route, opts: { webhookId?: string | null } = {}) {
  const calls: Call[] = [];
  let tokens = 0;
  const fetchStub = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const raw = init?.body ? String(init.body) : '';
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // A form body (the token call), kept as it came.
    }
    const call: Call = {
      method: init?.method ?? 'GET',
      url: u.toString(),
      path: `${u.pathname}${u.search}`,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body,
    };
    calls.push(call);
    if (u.pathname === '/v1/oauth2/token') {
      tokens += 1;
      return Response.json({ access_token: `platform-token-${tokens}`, expires_in: 32_400 });
    }
    const answer = route(call) ?? { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } };
    if (answer.text !== undefined)
      return new Response(answer.text, { status: answer.status ?? 200 });
    return answer.status === 204
      ? new Response(null, { status: 204 })
      : Response.json(answer.body ?? {}, { status: answer.status ?? 200 });
  };
  const provider = createPayPalPayments({
    clientId: CLIENT_ID,
    clientSecret: 'paypal-secret',
    partnerMerchantId: PARTNER,
    bnCode: 'HFOS_SP_PPCP',
    webhookId: opts.webhookId === undefined ? 'WH-OUR-HOOK' : opts.webhookId,
    environment: 'test',
    fetch: fetchStub as typeof fetch,
  });
  const api = () => calls.filter((c) => !c.path.startsWith('/v1/oauth2/token'));
  return { provider, calls, api, tokenCalls: () => tokens };
}

/** The seller named in a call's assertion: PayPal's `{"alg":"none"}` JWT, unsigned by design. */
function assertedSeller(call: Call): { iss: string; payer_id: string } | null {
  const assertion = call.headers['paypal-auth-assertion'];
  if (!assertion) return null;
  const [head, payload, signature] = assertion.split('.');
  expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ alg: 'none' });
  expect(signature).toBe('');
  return JSON.parse(Buffer.from(payload!, 'base64url').toString()) as {
    iss: string;
    payer_id: string;
  };
}

const READY_SELLER = {
  merchant_id: SELLER,
  tracking_id: 'x',
  legal_name: 'Lone Star Heating & Air',
  primary_email: 'owner@lonestar.example',
  payments_receivable: true,
  primary_email_confirmed: true,
  oauth_integrations: [
    {
      integration_type: 'OAUTH_THIRDPARTY',
      integration_method: 'PAYPAL',
      oauth_third_party: [
        {
          partner_client_id: CLIENT_ID,
          merchant_client_id: 'their-client',
          scopes: [
            'https://uri.paypal.com/services/payments/realtimepayment',
            'https://uri.paypal.com/services/payments/refund',
            'https://uri.paypal.com/services/payments/payment/authcapture',
            'https://uri.paypal.com/services/customer/merchant-integrations/read',
          ],
        },
      ],
    },
  ],
};

const capturedOrder = (orderId: string, extra: Record<string, unknown> = {}) => ({
  id: orderId,
  intent: 'CAPTURE',
  status: 'COMPLETED',
  payment_source: { card: { brand: 'VISA', last_digits: '4242' } },
  purchase_units: [
    {
      amount: { currency_code: 'USD', value: '120.00' },
      payments: {
        captures: [
          {
            id: 'CAPTURE9X',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '120.00' },
            seller_receivable_breakdown: {
              gross_amount: { currency_code: 'USD', value: '120.00' },
              paypal_fee: { currency_code: 'USD', value: '4.48' },
              net_amount: { currency_code: 'USD', value: '115.52' },
            },
            create_time: '2026-11-20T20:00:00Z',
            update_time: '2026-11-20T20:00:01Z',
          },
        ],
      },
    },
  ],
  ...extra,
});

describe('money as PayPal writes it', () => {
  it('turns decimal strings into cents without a float, and back', () => {
    expect(centsOfDecimal('120.00')).toBe(12_000);
    expect(centsOfDecimal('0.29')).toBe(29);
    expect(centsOfDecimal('4.5')).toBe(450);
    expect(centsOfDecimal('7')).toBe(700);
    expect(centsOfDecimal('abc')).toBeNull();
    expect(centsOfDecimal(12)).toBeNull();
    expect(decimalOfCents(12_000)).toBe('120.00');
    expect(decimalOfCents(29)).toBe('0.29');
    expect(decimalOfCents(1_234_505)).toBe('12345.05');
  });
});

describe('signing a business up', () => {
  it('asks PayPal for a sign-up link, tracked by the state’s hash, as the partner', async () => {
    const { provider, api, calls } = payPalWatching((c) =>
      c.path === '/v2/customer/partner-referrals'
        ? {
            body: {
              links: [
                { rel: 'self', href: `${HOST}/v2/customer/partner-referrals/abc` },
                {
                  rel: 'action_url',
                  href: 'https://www.sandbox.paypal.com/bizsignup/partner/entry?referralToken=abc',
                },
              ],
            },
          }
        : undefined,
    );
    const url = await provider.authorizeUrl({
      state: 'the-one-time-state',
      redirectUri: 'https://worker.example/oauth/paypal/callback',
    });
    expect(url).toBe('https://www.sandbox.paypal.com/bizsignup/partner/entry?referralToken=abc');

    // Our own token first, with our client id and secret.
    const token = calls[0]!;
    expect(token.path).toBe('/v1/oauth2/token');
    expect(token.headers['authorization']).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:paypal-secret`).toString('base64')}`,
    );

    const [referral] = api();
    expect(referral!.method).toBe('POST');
    expect(referral!.headers['authorization']).toBe('Bearer platform-token-1');
    expect(referral!.headers['paypal-partner-attribution-id']).toBe('HFOS_SP_PPCP');
    // Nobody's assertion: this call is ours, as the partner.
    expect(referral!.headers['paypal-auth-assertion']).toBeUndefined();
    const body = referral!.body as Loose;
    expect(body.tracking_id).toBe(createHash('sha256').update('the-one-time-state').digest('hex'));
    // The state itself never goes to PayPal: its hash comes back as `merchantId`.
    expect(JSON.stringify(body)).not.toContain('the-one-time-state');
    expect(body.partner_config_override.return_url).toBe(
      'https://worker.example/oauth/paypal/callback',
    );
    const integration = body.operations[0].api_integration_preference.rest_api_integration;
    expect(integration.integration_type).toBe('THIRD_PARTY');
    expect(integration.third_party_details.features).toEqual(
      expect.arrayContaining(['PAYMENT', 'REFUND']),
    );
    expect(body.products).toEqual(['EXPRESS_CHECKOUT']);
  });

  it('finds who signed up by the tracking id, under our partner account, never by the address bar', async () => {
    const hash = 'a'.repeat(64);
    const { provider, api } = payPalWatching((c) => {
      if (c.path === `/v1/customer/partners/${PARTNER}/merchant-integrations?tracking_id=${hash}`)
        return { body: { merchant_id: SELLER, tracking_id: hash } };
      if (c.path === `/v1/customer/partners/${PARTNER}/merchant-integrations/${SELLER}`)
        return { body: READY_SELLER };
      return undefined;
    });
    const tokens = await provider.exchangeCode({
      code: SELLER,
      redirectUri: 'https://worker.example/oauth/paypal/callback',
      stateHash: hash,
    });
    expect(tokens).toMatchObject({
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      externalAccountId: SELLER,
      environment: 'test',
    });
    expect(tokens.scopes).toContain('https://uri.paypal.com/services/payments/refund');
    expect(api().every((c) => !c.headers['paypal-auth-assertion'])).toBe(true);

    // Somebody else's merchant id typed into the address bar is refused, not believed.
    await expect(
      provider.exchangeCode({ code: 'SOMEONEELSE99', redirectUri: 'x', stateHash: hash }),
    ).rejects.toMatchObject({ code: 'merchant_mismatch' });
  });

  it('says plainly when PayPal hasn’t finished the account yet', async () => {
    const { provider } = payPalWatching(() => undefined);
    await expect(
      provider.exchangeCode({ code: SELLER, redirectUri: 'x', stateHash: 'b'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'onboarding_incomplete' });
    await expect(provider.exchangeCode({ code: SELLER, redirectUri: 'x' })).rejects.toBeInstanceOf(
      PaymentError,
    );
  });

  it('reads what the account can do, and what PayPal is waiting on', async () => {
    let seller: Record<string, unknown> = READY_SELLER;
    const { provider } = payPalWatching((c) =>
      c.path.endsWith(`/merchant-integrations/${SELLER}`) ? { body: seller } : undefined,
    );
    const tokens = {
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      externalAccountId: SELLER,
      environment: 'test' as const,
    };
    const ready = await provider.describe(tokens);
    expect(ready.displayName).toBe('Lone Star Heating & Air');
    expect(ready.missingScopes).toEqual([]);
    expect(ready.capabilities).toMatchObject({
      card: true,
      refunds: true,
      holds: true,
      subscriptions: false,
      savedMethods: false,
      bankTransfer: false,
      flow: 'client_confirm',
      needsInfo: false,
    });

    // An email never confirmed: PayPal holds their money until they do, and the account card says so.
    seller = { ...READY_SELLER, primary_email_confirmed: false };
    const unconfirmed = await provider.describe(tokens);
    expect(unconfirmed.capabilities).toMatchObject({ card: false, needsInfo: true });

    // Refunds left unticked: the connection can't work, so it's sent back to ask again.
    seller = {
      ...READY_SELLER,
      oauth_integrations: [
        {
          integration_type: 'OAUTH_THIRDPARTY',
          oauth_third_party: [
            {
              partner_client_id: CLIENT_ID,
              scopes: ['https://uri.paypal.com/services/payments/realtimepayment'],
            },
          ],
        },
      ],
    };
    const partial = await provider.describe(tokens);
    expect(partial.missingScopes).toEqual(['https://uri.paypal.com/services/payments/refund']);
    expect(partial.capabilities.card).toBe(false);
  });
});

describe('taking a payment', () => {
  const prepareInput = (hold: boolean) => ({
    amountCents: 12_000,
    methods: ['card' as const],
    idempotencyKey: 'pay-1',
    description: 'Invoice 1042',
    customerRef: null,
    hold,
    metadata: { invoiceId: 'inv-uuid-1', workspaceId: 'ws-1' },
    returnUrl: null,
  });

  it('makes the order for the business, with our invoice on it, for the buttons to approve', async () => {
    const { provider, api } = payPalWatching((c) =>
      c.path === '/v2/checkout/orders'
        ? { status: 201, body: { id: 'ORDER5X', status: 'CREATED' } }
        : undefined,
    );
    const prepared = await provider.prepare(connected, prepareInput(false));
    expect(prepared).toMatchObject({
      flow: 'client_confirm',
      publishableKey: CLIENT_ID,
      accountId: SELLER,
      clientSecret: null,
      providerPaymentId: 'ORDER5X',
      hostedUrl: null,
      amountCents: 12_000,
    });
    const [order] = api();
    expect(assertedSeller(order!)).toEqual({ iss: CLIENT_ID, payer_id: SELLER });
    expect(order!.headers['paypal-request-id']).toBe('order-pay-1');
    const body = order!.body as Loose;
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units[0]).toMatchObject({
      amount: { currency_code: 'USD', value: '120.00' },
      custom_id: 'inv-uuid-1',
      description: 'Invoice 1042',
    });
    // Never `invoice_id`: PayPal refuses one twice, and an invoice can be paid in parts.
    expect(body.purchase_units[0].invoice_id).toBeUndefined();
    expect(body.application_context.shipping_preference).toBe('NO_SHIPPING');
  });

  it('holds a booking deposit instead of taking it', async () => {
    const { provider, api } = payPalWatching(() => ({
      body: { id: 'ORDERHOLD', status: 'CREATED' },
    }));
    await provider.prepare(connected, prepareInput(true));
    expect((api()[0]!.body as Loose).intent).toBe('AUTHORIZE');
  });

  it('captures an approved order once, and answers with the capture, its fee and the card', async () => {
    const { provider, api } = payPalWatching((c) => {
      if (c.method === 'GET' && c.path === '/v2/checkout/orders/ORDER5X')
        return {
          body: {
            id: 'ORDER5X',
            intent: 'CAPTURE',
            status: 'APPROVED',
            purchase_units: [{ amount: { currency_code: 'USD', value: '120.00' } }],
          },
        };
      if (c.method === 'POST' && c.path === '/v2/checkout/orders/ORDER5X/capture')
        return { status: 201, body: capturedOrder('ORDER5X') };
      return undefined;
    });
    const result = await provider.confirmFromClient(connected, 'ORDER5X');
    expect(result).toMatchObject({
      // The capture's id from here on: what a refund and the fees are asked of.
      providerPaymentId: 'CAPTURE9X',
      status: 'succeeded',
      providerStatus: 'COMPLETED',
      amountCents: 12_000,
      feeCents: 448,
      netCents: 11_552,
      capturable: false,
      cardBrand: 'Visa',
      cardLast4: '4242',
      method: 'card',
      receivedAt: '2026-11-20T20:00:01.000Z',
    });
    const capture = api().find((c) => c.path.endsWith('/capture'))!;
    expect(capture.headers['paypal-request-id']).toBe('capture-ORDER5X');
    expect(assertedSeller(capture)).toEqual({ iss: CLIENT_ID, payer_id: SELLER });
  });

  it('reads back what the first capture did when it is asked twice', async () => {
    let gets = 0;
    const { provider } = payPalWatching((c) => {
      if (c.method === 'GET') {
        gets += 1;
        return gets === 1
          ? {
              body: {
                id: 'ORDER5X',
                intent: 'CAPTURE',
                status: 'APPROVED',
                purchase_units: [{ amount: { currency_code: 'USD', value: '120.00' } }],
              },
            }
          : { body: capturedOrder('ORDER5X') };
      }
      return {
        status: 422,
        body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] },
      };
    });
    const result = await provider.confirmFromClient(connected, 'ORDER5X');
    expect(result).toMatchObject({ providerPaymentId: 'CAPTURE9X', status: 'succeeded' });
  });

  it('answers a declined PayPal payment as a refusal for the customer, not an error', async () => {
    const { provider } = payPalWatching((c) =>
      c.method === 'GET'
        ? {
            body: {
              id: 'ORDER5X',
              intent: 'CAPTURE',
              status: 'APPROVED',
              purchase_units: [{ amount: { currency_code: 'USD', value: '120.00' } }],
            },
          }
        : {
            status: 422,
            body: {
              name: 'UNPROCESSABLE_ENTITY',
              details: [{ issue: 'INSTRUMENT_DECLINED', description: 'issuer said no' }],
            },
          },
    );
    const result = await provider.confirmFromClient(connected, 'ORDER5X');
    expect(result).toMatchObject({
      providerPaymentId: 'ORDER5X',
      status: 'failed',
      failureCode: 'INSTRUMENT_DECLINED',
      amountCents: 12_000,
    });
    // Our words, never PayPal's.
    expect(result.failureMessage).toMatch(/PayPal declined that payment/);
    expect(result.failureMessage).not.toContain('issuer');
  });

  it('takes nothing for an order the buyer never approved', async () => {
    const { provider, api } = payPalWatching(() => ({
      body: {
        id: 'ORDER5X',
        intent: 'CAPTURE',
        status: 'PAYER_ACTION_REQUIRED',
        purchase_units: [{ amount: { currency_code: 'USD', value: '120.00' } }],
      },
    }));
    const result = await provider.confirmFromClient(connected, 'ORDER5X');
    expect(result).toMatchObject({ providerPaymentId: 'ORDER5X', status: 'requires_payment' });
    expect(api().filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('holds a deposit, then captures or lets go of the hold', async () => {
    const { provider, api } = payPalWatching((c) => {
      if (c.method === 'GET')
        return {
          body: {
            id: 'ORDERHOLD',
            intent: 'AUTHORIZE',
            status: 'APPROVED',
            purchase_units: [{ amount: { currency_code: 'USD', value: '50.00' } }],
          },
        };
      if (c.path === '/v2/checkout/orders/ORDERHOLD/authorize')
        return {
          status: 201,
          body: {
            id: 'ORDERHOLD',
            status: 'COMPLETED',
            purchase_units: [
              {
                payments: {
                  authorizations: [
                    {
                      id: 'AUTH7',
                      status: 'CREATED',
                      amount: { currency_code: 'USD', value: '50.00' },
                    },
                  ],
                },
              },
            ],
          },
        };
      if (c.path === '/v2/payments/authorizations/AUTH7/capture')
        return {
          status: 201,
          body: {
            id: 'CAPTUREHOLD',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '50.00' },
          },
        };
      if (c.path === '/v2/payments/authorizations/AUTH7/void') return { status: 204 };
      return undefined;
    });
    const held = await provider.confirmFromClient(connected, 'ORDERHOLD');
    expect(held).toMatchObject({
      providerPaymentId: 'AUTH7',
      status: 'processing',
      capturable: true,
      providerStatus: 'CREATED',
    });
    expect(api().some((c) => c.path === '/v2/checkout/orders/ORDERHOLD/authorize')).toBe(true);

    const taken = await provider.capture(connected, {
      providerPaymentId: 'AUTH7',
      amountCents: 5_000,
      idempotencyKey: 'capture:hold-1',
    });
    expect(taken).toMatchObject({ providerPaymentId: 'CAPTUREHOLD', status: 'succeeded' });
    const capture = api().find((c) => c.path.endsWith('/AUTH7/capture'))!;
    expect(capture.body).toEqual({
      amount: { currency_code: 'USD', value: '50.00' },
      final_capture: true,
    });
    expect(capture.headers['paypal-request-id']).toBe('capture:hold-1');

    const letGo = await provider.voidAuthorization(connected, {
      providerPaymentId: 'AUTH7',
      idempotencyKey: 'void:hold-1',
    });
    expect(letGo).toMatchObject({
      providerPaymentId: 'AUTH7',
      status: 'failed',
      providerStatus: 'VOIDED',
      failureCode: null,
    });
  });

  it('refunds the capture, and reads the fee off it', async () => {
    const { provider, api } = payPalWatching((c) => {
      if (c.path === '/v2/payments/captures/CAPTURE9X/refund')
        return {
          status: 201,
          body: {
            id: 'REFUND3',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '20.00' },
          },
        };
      if (c.path === '/v2/payments/captures/CAPTURE9X')
        return { body: capturedOrder('ORDER5X').purchase_units[0]!.payments.captures[0] };
      return undefined;
    });
    const refund = await provider.refund(connected, {
      providerPaymentId: 'CAPTURE9X',
      amountCents: 2_000,
      reason: 'Part of the job was not done',
      idempotencyKey: 'refund-1',
    });
    expect(refund).toMatchObject({
      providerRefundId: 'REFUND3',
      status: 'succeeded',
      amountCents: 2_000,
    });
    const call = api().find((c) => c.path.endsWith('/refund'))!;
    expect(call.body).toEqual({
      amount: { currency_code: 'USD', value: '20.00' },
      note_to_payer: 'Part of the job was not done',
    });
    expect(call.headers['paypal-request-id']).toBe('refund-1');
    expect(assertedSeller(call)!.payer_id).toBe(SELLER);

    expect(await provider.fees(connected, 'CAPTURE9X')).toEqual({
      feeCents: 448,
      netCents: 11_552,
    });
  });

  it('asks the business to reconnect once they have taken our permission back', async () => {
    const { provider } = payPalWatching(() => ({
      status: 403,
      body: { name: 'NOT_AUTHORIZED', details: [{ issue: 'PERMISSION_DENIED' }] },
    }));
    await expect(provider.prepare(connected, prepareInput(false))).rejects.toBeInstanceOf(
      PaymentAuthError,
    );
  });

  it('keeps our own token until it runs out, and fetches a fresh one when PayPal ends it early', async () => {
    let refuseOnce = true;
    const { provider, tokenCalls } = payPalWatching((c) => {
      if (
        refuseOnce &&
        c.headers['authorization'] === 'Bearer platform-token-1' &&
        c.path.startsWith('/v2/checkout/orders/ORDERB')
      ) {
        refuseOnce = false;
        return { status: 401, body: { error: 'invalid_token' } };
      }
      return { body: { id: c.path.split('/').pop(), status: 'CREATED' } };
    });
    await provider.prepare(connected, prepareInput(false));
    await provider.prepare(connected, prepareInput(false));
    expect(tokenCalls()).toBe(1);
    await provider.confirmFromClient(connected, 'ORDERB');
    expect(tokenCalls()).toBe(2);
  });

  it('refuses plans, saved cards and charging without the buyer, in words (one-time payments only)', async () => {
    const { provider } = payPalWatching(() => undefined);
    await expect(
      provider.subscriptions.create(connected, {
        customerRef: 'c',
        methodToken: null,
        amountCents: 100,
        interval: 'month',
        intervalCount: 1,
        name: 'Plan',
        startAt: null,
        idempotencyKey: 'k',
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'paypal_one_time_only' });
    await expect(
      provider.charge(connected, {
        amountCents: 100,
        method: 'card',
        sourceToken: 'x',
        idempotencyKey: 'k',
        description: null,
        customerRef: null,
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'paypal_one_time_only' });
    expect(provider.platform.supported).toBe(false);
  });
});

describe('PayPal’s webhooks', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42';

  const signed = (body: string, webhookId = 'WH-OUR-HOOK', certUrl = CERT_URL) => {
    const id = 'b2384410-f8d2-11ed-8d0f-1f5bd0e5c0a4';
    const time = '2026-11-20T20:00:00Z';
    const message = `${id}|${time}|${webhookId}|${crc32(Buffer.from(body, 'utf8'))}`;
    return {
      'paypal-transmission-id': id,
      'paypal-transmission-time': time,
      'paypal-transmission-sig': sign('sha256', Buffer.from(message), privateKey).toString(
        'base64',
      ),
      'paypal-cert-url': certUrl,
      'paypal-auth-algo': 'SHA256withRSA',
    };
  };

  const event = JSON.stringify({
    id: 'WH-58D329510W468432D-8HN650336L201105X',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    create_time: '2026-11-20T20:00:02Z',
    resource: {
      id: 'CAPTURE9X',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '120.00' },
      custom_id: 'inv-uuid-1',
      payee: { merchant_id: SELLER },
      supplementary_data: { related_ids: { order_id: 'ORDER5X' } },
    },
  });

  it('believes only a signature made with the certificate on PayPal’s own host, over our webhook', async () => {
    const certFetches: string[] = [];
    const { provider } = payPalWatching((c) => {
      if (c.url.startsWith('https://api.sandbox.paypal.com/v1/notifications/certs/')) {
        certFetches.push(c.url);
        return { text: certPem };
      }
      return undefined;
    });
    const url = 'https://worker.example/webhooks/paypal';
    expect(provider.webhooks.configured).toBe(true);
    expect(await provider.webhooks.verify({ rawBody: event, headers: signed(event), url })).toBe(
      true,
    );
    // The certificate is kept once fetched.
    expect(await provider.webhooks.verify({ rawBody: event, headers: signed(event), url })).toBe(
      true,
    );
    expect(certFetches).toHaveLength(1);

    // A changed body, another app's webhook, or a certificate from anywhere but PayPal: refused.
    const tampered = event.replace('120.00', '1.00');
    expect(await provider.webhooks.verify({ rawBody: tampered, headers: signed(event), url })).toBe(
      false,
    );
    expect(
      await provider.webhooks.verify({
        rawBody: event,
        headers: signed(event, 'WH-SOMEONE-ELSE'),
        url,
      }),
    ).toBe(false);
    expect(
      await provider.webhooks.verify({
        rawBody: event,
        headers: signed(event, 'WH-OUR-HOOK', 'https://paypal.com.evil.example/cert'),
        url,
      }),
    ).toBe(false);
    expect(
      await provider.webhooks.verify({
        rawBody: event,
        headers: signed(
          event,
          'WH-OUR-HOOK',
          'http://api.sandbox.paypal.com/v1/notifications/certs/x',
        ),
        url,
      }),
    ).toBe(false);
    expect(await provider.webhooks.verify({ rawBody: event, headers: {}, url })).toBe(false);
  });

  it('refuses everything until the webhook id is on the server', async () => {
    const { provider } = payPalWatching(() => ({ text: certPem }), { webhookId: null });
    expect(provider.webhooks.configured).toBe(false);
    expect(
      await provider.webhooks.verify({ rawBody: event, headers: signed(event), url: 'x' }),
    ).toBe(false);
  });

  it('finds the business by the seller named on the resource', () => {
    expect(readPayPalEvent(event)).toMatchObject({
      id: 'WH-58D329510W468432D-8HN650336L201105X',
      type: 'PAYMENT.CAPTURE.COMPLETED',
      accountRef: SELLER,
      createdAt: '2026-11-20T20:00:02.000Z',
    });
    const refund = readPayPalEvent(
      JSON.stringify({
        id: 'WH-2',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { id: 'REFUND3', payer: { merchant_id: SELLER } },
      }),
    );
    expect(refund?.accountRef).toBe(SELLER);
    const revoked = readPayPalEvent(
      JSON.stringify({
        id: 'WH-3',
        event_type: 'MERCHANT.PARTNER-CONSENT.REVOKED',
        resource: { merchant_id: SELLER, tracking_id: 'x' },
      }),
    );
    expect(revoked?.accountRef).toBe(SELLER);
    expect(readPayPalEvent('not json')).toBeNull();
    expect(readPayPalEvent('{"id":"WH-4"}')).toBeNull();
  });

  it('reads a capture, a refund and a dispute in our own words', () => {
    const capture = readPayPalEvent(event)!;
    expect(paymentKindOf('paypal', capture)).toBe('payment.succeeded');
    expect(paymentFactsOf('paypal', capture)).toMatchObject({
      providerPaymentId: 'CAPTURE9X',
      status: 'succeeded',
      amountCents: 12_000,
      invoiceId: 'inv-uuid-1',
      // The row may still hold the order's id if this arrives before our own call kept the capture's.
      relatedIds: ['ORDER5X'],
    });

    const refund = readPayPalEvent(
      JSON.stringify({
        id: 'WH-5',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        create_time: '2026-11-21T09:00:00Z',
        resource: {
          id: 'REFUND3',
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '20.00' },
          payer: { merchant_id: SELLER },
          links: [
            { rel: 'self', href: `${HOST}/v2/payments/refunds/REFUND3` },
            { rel: 'up', href: `${HOST}/v2/payments/captures/CAPTURE9X` },
          ],
        },
      }),
    )!;
    expect(paymentKindOf('paypal', refund)).toBe('payment.refunded');
    expect(refundFactsOf('paypal', refund)).toMatchObject({
      isRefund: true,
      providerRefundId: 'REFUND3',
      providerPaymentId: 'CAPTURE9X',
      status: 'succeeded',
      amountCents: 2_000,
    });

    const dispute = readPayPalEvent(
      JSON.stringify({
        id: 'WH-6',
        event_type: 'CUSTOMER.DISPUTE.RESOLVED',
        resource: {
          dispute_id: 'PP-D-27803',
          disputed_transactions: [
            { seller_transaction_id: 'CAPTURE9X', seller: { merchant_id: SELLER } },
          ],
          reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          status: 'RESOLVED',
          dispute_amount: { currency_code: 'USD', value: '120.00' },
          dispute_outcome: { outcome_code: 'RESOLVED_SELLER_FAVOUR' },
        },
      }),
    )!;
    expect(dispute.accountRef).toBe(SELLER);
    expect(paymentKindOf('paypal', dispute)).toBe('payment.disputed');
    expect(disputeFactsOf(dispute, 'paypal')).toMatchObject({
      providerDisputeId: 'PP-D-27803',
      providerPaymentId: 'CAPTURE9X',
      amountCents: 12_000,
      status: 'won',
    });

    expect(paymentKindOf('paypal', { ...capture, type: 'MERCHANT.PARTNER-CONSENT.REVOKED' })).toBe(
      'payment_connection.revoked',
    );
    expect(paymentKindOf('paypal', { ...capture, type: 'CHECKOUT.ORDER.APPROVED' })).toBeNull();
  });
});
