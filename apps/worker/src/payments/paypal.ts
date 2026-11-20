/**
 * PayPal, as a partner (the PayPal plan, part 2). The business signs up through PayPal's Partner Referrals and
 * grants HandsFreeOS permission to take payments for it; nothing of theirs is kept but their merchant id.
 *
 * - **Calls go out as us, for them.** Every call carries our own client-credentials token and a
 *   `PayPal-Auth-Assertion` naming the seller, so the money settles in their PayPal and there is no seller token
 *   to keep fresh (like Stripe's account header). The assertion is unsigned by design: PayPal trusts it because
 *   the seller granted our app permission, and refuses it the moment they take that back.
 * - **The browser approves, we take the money.** PayPal's buttons (PayPal, Venmo, Pay Later and its card button,
 *   part 4) approve an order we made in `prepare`; `confirmFromClient` then captures it, or authorizes it for a
 *   booking deposit's hold, and reads the answer back. The payment's id changes once on the way: the order's id
 *   until it is captured, then the capture's, which is what a refund and the fees are asked of.
 * - **One-time payments only** (the owner's pick 4a, 20 Nov 2026). Plans, saved cards and charging for
 *   HandsFreeOS itself are refused in plain words, like Square's `platform`.
 *
 * Webhooks are one endpoint for every seller, signed with a certificate PayPal serves; they are checked here,
 * against `PAYPAL_WEBHOOK_ID`, without a call to PayPal for each one.
 */
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  X509Certificate,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { crc32 } from 'node:zlib';
import {
  cardBrandLabel,
  cardLast4,
  centsOfDecimal,
  decimalOfCents,
  declineWording,
  idempotencyKey,
  isoOf,
  NO_CAPABILITIES,
  PaymentAuthError,
  PaymentError,
  PlatformUnsupportedError,
  requireAmount,
  type ConnectedAccount,
  type PaymentAccount,
  type PaymentCapabilities,
  type PaymentEnvironment,
  type PaymentEvent,
  type PaymentFees,
  type PaymentProvider,
  type PaymentResult,
  type PaymentState,
  type PaymentTokens,
  type PreparedPayment,
  type RefundResult,
  type WebhookInput,
} from './provider';

const HOSTS: Record<PaymentEnvironment, string> = {
  live: 'https://api-m.paypal.com',
  test: 'https://api-m.sandbox.paypal.com',
};

/**
 * What the seller is asked to let us do (Partner Referrals' `third_party_details.features`): take payments,
 * refund them, read their account's state for the account card, and read disputes about their payments.
 */
export const PAYPAL_FEATURES = [
  'PAYMENT',
  'REFUND',
  'ACCESS_MERCHANT_INFORMATION',
  'READ_SELLER_DISPUTE',
] as const;

/**
 * The permissions a connection can't work without, as PayPal names them back on the seller's account. Holds
 * (`payments/payment/authcapture`) are read too, but only decide whether a deposit can be held.
 */
const NEEDED_SCOPES = [
  'https://uri.paypal.com/services/payments/realtimepayment',
  'https://uri.paypal.com/services/payments/refund',
] as const;
const HOLD_SCOPE = 'https://uri.paypal.com/services/payments/payment/authcapture';

/** Issues where the buyer's card or bank (or PayPal on their behalf) said no: an answer, never a failure. */
const DECLINED = new Set([
  'INSTRUMENT_DECLINED',
  'TRANSACTION_REFUSED',
  'PAYER_CANNOT_PAY',
  'PAYER_ACTION_REQUIRED',
  'PAYEE_BLOCKED_TRANSACTION',
  'MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED',
  'REDIRECT_PAYER_FOR_ALTERNATE_FUNDING',
  'CARD_EXPIRED',
  'COMPLIANCE_VIOLATION',
]);

/** The seller took back the permission they gave us, or never finished giving it: they must connect again. */
const RECONNECT = new Set([
  'PERMISSION_DENIED',
  'NOT_AUTHORIZED',
  'PAYEE_NOT_CONSENTED',
  'CONSENT_NEEDED',
  'PAYEE_ACCOUNT_INVALID',
]);

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(obj) : []);
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** The tracking id a sign-up is given and found again by: the state's hash, exactly as the row keeps it. */
export const payPalTrackingId = (state: string): string =>
  createHash('sha256').update(state).digest('hex');

/** A capture's status, in our words. A refunded capture still brought the money in; its refunds are their own rows. */
function captureState(status: string): PaymentState {
  switch (status) {
    case 'COMPLETED':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'succeeded';
    // An eCheck, or a payment PayPal is reviewing: promised, not landed.
    case 'PENDING':
      return 'processing';
    case 'DECLINED':
    case 'FAILED':
      return 'failed';
    default:
      return 'requires_payment';
  }
}

/** An authorization's: a hold is `processing` with the money set aside, never `succeeded`. */
function authorizationState(status: string): PaymentState {
  switch (status) {
    case 'CREATED':
    case 'PENDING':
      return 'processing';
    case 'CAPTURED':
    case 'PARTIALLY_CAPTURED':
      return 'succeeded';
    case 'DENIED':
    case 'VOIDED':
    case 'EXPIRED':
      return 'failed';
    default:
      return 'requires_payment';
  }
}

/** The PayPal account behind a webhook: whose payment, refund, dispute or permission it is about. */
function merchantOf(resource: Json): string | null {
  const disputed = list(resource['disputed_transactions'])[0] ?? {};
  return (
    str(obj(resource['payee'])['merchant_id']) ??
    // A refund names the seller as the one paying it back.
    str(obj(resource['payer'])['merchant_id']) ??
    str(resource['merchant_id']) ??
    str(obj(disputed['seller'])['merchant_id']) ??
    str(obj(resource['seller'])['merchant_id'])
  );
}

/** A PayPal webhook's envelope: its id, its name, the seller it's about, and the resource itself. */
export function readPayPalEvent(rawBody: string): PaymentEvent | null {
  let body: Json;
  try {
    body = obj(JSON.parse(rawBody));
  } catch {
    return null;
  }
  const id = str(body['id']);
  const type = str(body['event_type']);
  if (!id || !type) return null;
  const resource = obj(body['resource']);
  return {
    id,
    type,
    // One webhook serves every seller, so the merchant named on the resource is how it finds its business.
    accountRef: merchantOf(resource),
    createdAt: isoOf(body['create_time']),
    data: resource,
  };
}

const refused = (what: string) =>
  new PaymentError(
    `PayPal here takes one-time payments only, so it can’t ${what}. Use Stripe or Square for plans and saved cards.`,
    null,
    true,
    null,
    'paypal_one_time_only',
  );

export function createPayPalPayments(opts: {
  clientId: string | null;
  clientSecret: string | null;
  /** HandsFreeOS's own PayPal merchant id, as the partner: the sign-up and the seller's status are asked under it. */
  partnerMerchantId: string | null;
  /** The partner attribution (BN) code PayPal gives a partner, sent on every call. */
  bnCode: string | null;
  /** The id of the webhook in our PayPal app: what every event's signature is made over. */
  webhookId: string | null;
  environment: PaymentEnvironment;
  fetch?: typeof fetch;
  now?: () => number;
}): PaymentProvider {
  const f = opts.fetch ?? fetch;
  const clock = opts.now ?? Date.now;
  const host = HOSTS[opts.environment];
  const configured = !!(opts.clientId && opts.clientSecret && opts.partnerMerchantId);

  const app = () => {
    if (!opts.clientId || !opts.clientSecret || !opts.partnerMerchantId)
      throw new PaymentError('PayPal isn’t set up on this server yet.', null, true);
    return { id: opts.clientId, secret: opts.clientSecret, partner: opts.partnerMerchantId };
  };

  // ---------- our own token ----------

  let token: { value: string; until: number } | null = null;

  async function platformToken(): Promise<string> {
    if (token && token.until > clock() + 60_000) return token.value;
    const { id, secret } = app();
    const res = await f(`${host}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      const error = await errorOf(res);
      // Our own app's credentials, not a seller's: nothing a business can reconnect will fix it.
      throw new PaymentError(
        `PayPal refused HandsFreeOS’s own sign-in (${error.code}). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the worker.`,
        res.status,
        res.status !== 429 && res.status < 500,
        null,
        error.code,
      );
    }
    const body = obj(await res.json());
    const value = str(body['access_token']);
    if (!value) throw new PaymentError('PayPal didn’t give HandsFreeOS a token.', null, false);
    const seconds = Number(body['expires_in']);
    token = { value, until: clock() + (Number.isFinite(seconds) ? seconds : 3600) * 1000 };
    return value;
  }

  /** `{"alg":"none"}`, then who is calling and for whom, then an empty signature: PayPal's own recipe. */
  const assertion = (merchantId: string): string => {
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    return `${part({ alg: 'none' })}.${part({ iss: app().id, payer_id: merchantId })}.`;
  };

  // ---------- calling ----------

  /** The issue PayPal named (`INSTRUMENT_DECLINED`), else its error's name: what everything here decides on. */
  async function errorOf(res: Response): Promise<{ code: string; message: string | null }> {
    try {
      const body = obj(await res.json());
      const detail = list(body['details'])[0] ?? {};
      return {
        code:
          str(detail['issue']) ?? str(body['name']) ?? str(body['error']) ?? `http_${res.status}`,
        message: str(detail['description']) ?? str(body['message']),
      };
    } catch {
      return { code: `http_${res.status}`, message: null };
    }
  }

  function fail(res: Response, code: string, forSeller: boolean): never {
    if (forSeller && (RECONNECT.has(code) || res.status === 403))
      throw new PaymentAuthError(
        `PayPal no longer lets HandsFreeOS take payments for this account (${code}).`,
        code,
      );
    const seconds = Number(res.headers.get('retry-after'));
    const transient = code === 'RATE_LIMIT_REACHED' || res.status === 429 || res.status >= 500;
    throw new PaymentError(
      `PayPal answered ${res.status} (${code}).`,
      res.status,
      !transient,
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      code,
    );
  }

  interface Call {
    readonly method?: string;
    readonly body?: Json;
    /** Acting for this seller: the assertion names them. Left out, the call is ours as the partner. */
    readonly account?: Pick<PaymentAccount, 'externalAccountId'> | null;
    /** PayPal's idempotency: the same id twice answers the first call's result instead of acting again. */
    readonly requestId?: string;
  }

  async function send(path: string, call: Call, retried = false): Promise<Response> {
    const res = await f(`${host}${path}`, {
      method: call.method ?? (call.body ? 'POST' : 'GET'),
      headers: {
        authorization: `Bearer ${await platformToken()}`,
        prefer: 'return=representation',
        ...(call.body ? { 'content-type': 'application/json' } : {}),
        ...(opts.bnCode ? { 'paypal-partner-attribution-id': opts.bnCode } : {}),
        ...(call.account
          ? { 'paypal-auth-assertion': assertion(call.account.externalAccountId) }
          : {}),
        ...(call.requestId ? { 'paypal-request-id': idempotencyKey(call.requestId) } : {}),
      },
      ...(call.body ? { body: JSON.stringify(call.body) } : {}),
    });
    // Our token ran out early (PayPal can end one before it said): a fresh one, once.
    if (res.status === 401 && !retried) {
      token = null;
      return send(path, call, true);
    }
    return res;
  }

  async function api<T = Json>(path: string, call: Call = {}): Promise<T> {
    const res = await send(path, call);
    if (!res.ok) fail(res, (await errorOf(res)).code, !!call.account);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ---------- reading PayPal's answers ----------

  /** The card behind an order paid with PayPal's card button. Null for a PayPal or Venmo balance. */
  function cardOf(order: Json): { brand: string | null; last4: string | null } {
    const card = obj(obj(order['payment_source'])['card']);
    return {
      brand: cardBrandLabel(str(card['brand'])),
      last4: cardLast4(str(card['last_digits'])),
    };
  }

  /** How they paid, where PayPal says: its card button is a card, and Venmo and a PayPal account are their own. */
  function methodOf(order: Json): 'card' | 'paypal' | 'venmo' | null {
    const source = obj(order['payment_source']);
    if (source['card']) return 'card';
    if (source['venmo']) return 'venmo';
    if (source['paypal']) return 'paypal';
    return null;
  }

  function fromCapture(capture: Json, fallbackAmount: number, order: Json = {}): PaymentResult {
    const status = String(capture['status'] ?? '');
    const state = captureState(status);
    const breakdown = obj(capture['seller_receivable_breakdown']);
    const fee = centsOfDecimal(obj(breakdown['paypal_fee'])['value']);
    const net = centsOfDecimal(obj(breakdown['net_amount'])['value']);
    const reason = str(obj(capture['status_details'])['reason']);
    const card = cardOf(order);
    return {
      providerPaymentId: String(capture['id'] ?? ''),
      status: state,
      providerStatus: status,
      amountCents: centsOfDecimal(obj(capture['amount'])['value']) ?? fallbackAmount,
      failureCode: state === 'failed' ? (reason ?? 'payment_failed') : null,
      failureMessage: state === 'failed' ? declineWording(reason) : null,
      feeCents: fee,
      netCents: net,
      receivedAt:
        state === 'succeeded' ? isoOf(capture['update_time'] ?? capture['create_time']) : null,
      capturable: false,
      cardBrand: card.brand,
      cardLast4: card.last4,
      method: methodOf(order),
    };
  }

  function fromAuthorization(auth: Json, fallbackAmount: number, order: Json = {}): PaymentResult {
    const status = String(auth['status'] ?? '');
    const state = authorizationState(status);
    const card = cardOf(order);
    return {
      providerPaymentId: String(auth['id'] ?? ''),
      status: state,
      providerStatus: status,
      amountCents: centsOfDecimal(obj(auth['amount'])['value']) ?? fallbackAmount,
      failureCode: state === 'failed' && status !== 'VOIDED' ? 'payment_failed' : null,
      failureMessage: state === 'failed' && status !== 'VOIDED' ? declineWording(null) : null,
      feeCents: null,
      netCents: null,
      receivedAt: null,
      capturable: status === 'CREATED',
      cardBrand: card.brand,
      cardLast4: card.last4,
      method: methodOf(order),
    };
  }

  /** An order's answer: its capture once there is one, its hold before that, or where the order itself stands. */
  function fromOrder(order: Json, fallbackAmount: number): PaymentResult {
    const unit = list(order['purchase_units'])[0] ?? {};
    const payments = obj(unit['payments']);
    const capture = list(payments['captures']).at(-1);
    if (capture) return fromCapture(capture, fallbackAmount, order);
    const auth = list(payments['authorizations']).at(-1);
    if (auth) return fromAuthorization(auth, fallbackAmount, order);
    const status = String(order['status'] ?? '');
    const amount = centsOfDecimal(obj(unit['amount'])['value']) ?? fallbackAmount;
    const voided = status === 'VOIDED';
    return {
      providerPaymentId: String(order['id'] ?? ''),
      // Made, or approved and not yet taken: nothing has moved.
      status: voided ? 'failed' : 'requires_payment',
      providerStatus: status,
      amountCents: amount,
      failureCode: voided ? 'order_voided' : null,
      failureMessage: voided ? 'That PayPal payment was cancelled. Try again.' : null,
      feeCents: null,
      netCents: null,
      receivedAt: null,
      capturable: false,
      cardBrand: null,
      cardLast4: null,
    };
  }

  /** A refusal that is the buyer's funding saying no: an answer on the customer's page, not an error. */
  const declined = (orderId: string, amountCents: number, code: string): PaymentResult => ({
    providerPaymentId: orderId,
    status: 'failed',
    providerStatus: code,
    amountCents,
    failureCode: code,
    failureMessage: declineWording(code),
    feeCents: null,
    netCents: null,
    receivedAt: null,
    capturable: false,
    cardBrand: null,
    cardLast4: null,
  });

  // ---------- the seller's account ----------

  /** The seller as PayPal describes them to us, the partner. */
  const integration = (merchantId: string): Promise<Json> =>
    api(
      `/v1/customer/partners/${encodeURIComponent(app().partner)}/merchant-integrations/${encodeURIComponent(merchantId)}`,
    );

  /** The permissions the seller gave our app, as PayPal lists them on their account. */
  function scopesOf(i: Json): string[] {
    const ours = list(i['oauth_integrations'])
      .filter((o) => String(o['integration_type'] ?? '') === 'OAUTH_THIRDPARTY')
      .flatMap((o) => list(o['oauth_third_party']))
      .filter(
        (t) =>
          !opts.clientId || !t['partner_client_id'] || t['partner_client_id'] === opts.clientId,
      );
    return [
      ...new Set(
        ours
          .flatMap((t) => (Array.isArray(t['scopes']) ? t['scopes'] : []))
          .filter((s): s is string => typeof s === 'string'),
      ),
    ];
  }

  function capabilitiesOf(i: Json): PaymentCapabilities {
    const scopes = scopesOf(i);
    const has = (s: string) => scopes.includes(s);
    // PayPal requires both before a seller can take money, and says so on their account.
    const receivable = i['payments_receivable'] === true;
    const confirmed = i['primary_email_confirmed'] === true;
    const ready = receivable && confirmed && NEEDED_SCOPES.every(has);
    if (!ready && receivable && confirmed) return NO_CAPABILITIES('client_confirm');
    return {
      card: ready,
      // PayPal's own bank payments (eCheck) arrive as a pending capture, not a method a customer picks here.
      bankTransfer: false,
      subscriptions: false,
      refunds: ready,
      savedMethods: false,
      holds: ready && has(HOLD_SCOPE),
      flow: 'client_confirm',
      // A restricted account, or an email never confirmed: PayPal holds their money until they fix it there.
      needsInfo: !receivable || !confirmed,
      needsInfoBy: null,
      ...(!confirmed
        ? { needsInfoWhat: 'PayPal needs you to confirm your email address with them.' }
        : !receivable
          ? { needsInfoWhat: 'PayPal has limited your account, so it can’t take payments yet.' }
          : {}),
    };
  }

  return {
    name: 'paypal',
    configured,
    flow: 'client_confirm',
    // Our client id is public: the page loads PayPal's script with it and the seller's merchant id (part 4).
    publishableKey: opts.clientId ?? '',
    partnerAttributionId: opts.bnCode,

    /**
     * PayPal's sign-up is a link its API makes for each attempt. The tracking id is the state's hash, which is
     * also what PayPal hands back on the way home (`merchantId`), so the state itself never leaves our page.
     */
    async authorizeUrl({ state, redirectUri }) {
      const answer = await api('/v2/customer/partner-referrals', {
        body: {
          tracking_id: payPalTrackingId(state),
          partner_config_override: {
            return_url: redirectUri,
            return_url_description: 'Back to HandsFreeOS',
          },
          operations: [
            {
              operation: 'API_INTEGRATION',
              api_integration_preference: {
                rest_api_integration: {
                  integration_method: 'PAYPAL',
                  integration_type: 'THIRD_PARTY',
                  third_party_details: { features: [...PAYPAL_FEATURES] },
                },
              },
            },
          ],
          // PayPal's buttons: PayPal, Venmo, Pay Later and its card button (the owner's pick 3a).
          products: ['EXPRESS_CHECKOUT'],
          legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
        },
      });
      const link = list(answer['links']).find((l) => l['rel'] === 'action_url');
      const href = str(link?.['href']);
      if (!href) throw new PaymentError('PayPal didn’t give a sign-up link.', null, false);
      return href;
    },

    /**
     * Nothing to trade: the address bar's merchant id could be typed by anyone, so the seller is found again by
     * the tracking id we gave PayPal, under our own partner account. Only PayPal can say who signed up with it.
     */
    async exchangeCode({ code, stateHash }) {
      const { partner } = app();
      if (!stateHash)
        throw new PaymentError(
          'This PayPal sign-up came back without its tracking id.',
          null,
          true,
        );
      const res = await send(
        `/v1/customer/partners/${encodeURIComponent(partner)}/merchant-integrations?tracking_id=${encodeURIComponent(stateHash)}`,
        {},
      );
      if (res.status === 404)
        throw new PaymentError(
          'PayPal hasn’t finished setting up that account yet. Wait a minute, then choose Connect PayPal again.',
          404,
          true,
          null,
          'onboarding_incomplete',
        );
      if (!res.ok) fail(res, (await errorOf(res)).code, false);
      const found = obj(await res.json());
      const merchantId = str(found['merchant_id']);
      if (!merchantId)
        throw new PaymentError('PayPal didn’t say which account signed up.', null, true);
      // The address bar's id, when it carried one, has to be the same account PayPal names.
      if (/^[A-Z0-9]{8,20}$/.test(code) && code !== merchantId)
        throw new PaymentError(
          'The PayPal account that came back isn’t the one that signed up.',
          null,
          true,
          null,
          'merchant_mismatch',
        );
      const i = await integration(merchantId);
      return {
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scopes: scopesOf(i),
        externalAccountId: merchantId,
        environment: opts.environment,
      } satisfies PaymentTokens;
    },

    // There is no seller token: our own is fetched as needed.
    refreshTokens: async (tokens) => tokens,

    async describe(tokens) {
      const i = await integration(tokens.externalAccountId);
      const scopes = scopesOf(i);
      return {
        externalAccountId: tokens.externalAccountId,
        displayName: str(i['legal_name']) ?? str(i['primary_email']),
        locationId: null,
        capabilities: capabilitiesOf(i),
        missingScopes: NEEDED_SCOPES.filter((s) => !scopes.includes(s)),
      } satisfies ConnectedAccount;
    },

    /**
     * PayPal gives a partner no call to take back a seller's permission: the seller removes HandsFreeOS in their
     * own PayPal settings, and `MERCHANT.PARTNER-CONSENT.REVOKED` tells us. Until then nothing here can act for
     * them, because every call needs a connection row this disconnect has already ended.
     */
    async revokeAccess() {},

    async capabilities(account) {
      return capabilitiesOf(await integration(account.externalAccountId));
    },

    /** The order the buttons approve. Its id is the payment's until the money is captured. */
    async prepare(account, input) {
      const amount = requireAmount(input.amountCents);
      const invoiceId = str(input.metadata['invoiceId']);
      const order = await api('/v2/checkout/orders', {
        account,
        requestId: `order-${input.idempotencyKey}`,
        body: {
          // A booking deposit is held, and captured once the time is confirmed.
          intent: input.hold ? 'AUTHORIZE' : 'CAPTURE',
          purchase_units: [
            {
              amount: { currency_code: 'USD', value: decimalOfCents(amount) },
              // Not `invoice_id`: PayPal refuses one twice, and an invoice can be paid in parts or tried again.
              ...(invoiceId ? { custom_id: invoiceId.slice(0, 127) } : {}),
              ...(input.description ? { description: input.description.slice(0, 127) } : {}),
            },
          ],
          // Nothing is shipped for a service or an invoice, so PayPal doesn't ask for an address.
          application_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' },
        },
      });
      const id = str(order['id']);
      if (!id) throw new PaymentError('PayPal didn’t make the order.', null, false);
      return {
        flow: 'client_confirm',
        publishableKey: opts.clientId ?? '',
        accountId: account.externalAccountId,
        locationId: null,
        clientSecret: null,
        providerPaymentId: id,
        methods: input.methods,
        amountCents: amount,
        hostedUrl: null,
      } satisfies PreparedPayment;
    },

    /**
     * The buyer approved the order in PayPal's window: take the money (or hold it) and read PayPal's answer.
     * Asked again for the same order, PayPal's request id answers the first capture instead of a second one.
     */
    async confirmFromClient(account, orderId) {
      const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}`;
      const order = await api(path, { account });
      const unit = list(order['purchase_units'])[0] ?? {};
      const amount = centsOfDecimal(obj(unit['amount'])['value']) ?? 0;
      if (String(order['status'] ?? '') !== 'APPROVED') return fromOrder(order, amount);
      const step = String(order['intent'] ?? '') === 'AUTHORIZE' ? 'authorize' : 'capture';
      const res = await send(`${path}/${step}`, {
        account,
        body: {},
        requestId: `${step}-${orderId}`,
      });
      if (res.ok) return fromOrder(obj(await res.json()), amount);
      const { code } = await errorOf(res);
      if (DECLINED.has(code)) return declined(orderId, amount, code);
      // Taken already (a second press, a lost answer): read what the first one did.
      if (code === 'ORDER_ALREADY_CAPTURED' || code === 'ORDER_ALREADY_AUTHORIZED')
        return fromOrder(await api(path, { account }), amount);
      return fail(res, code, true);
    },

    /** PayPal takes a payment through its buttons; there is nothing for us to charge without the buyer. */
    charge: () =>
      Promise.reject(refused('charge a card without the customer pressing PayPal’s button')),
    authorize: () =>
      Promise.reject(refused('hold a card without the customer pressing PayPal’s button')),

    async capture(account, input) {
      const capture = await api(
        `/v2/payments/authorizations/${encodeURIComponent(input.providerPaymentId)}/capture`,
        {
          account,
          requestId: input.idempotencyKey,
          body: {
            amount: {
              currency_code: 'USD',
              value: decimalOfCents(requireAmount(input.amountCents)),
            },
            final_capture: true,
          },
        },
      );
      return fromCapture(capture, input.amountCents);
    },

    async voidAuthorization(account, input) {
      const id = input.providerPaymentId;
      const res = await send(`/v2/payments/authorizations/${encodeURIComponent(id)}/void`, {
        account,
        method: 'POST',
        requestId: input.idempotencyKey,
      });
      // Let go already is let go.
      if (!res.ok) {
        const { code } = await errorOf(res);
        if (
          !['AUTHORIZATION_ALREADY_VOIDED', 'AUTHORIZATION_VOIDED', 'PREVIOUSLY_VOIDED'].includes(
            code,
          )
        )
          fail(res, code, true);
      }
      return {
        providerPaymentId: id,
        status: 'failed',
        providerStatus: 'VOIDED',
        amountCents: 0,
        failureCode: null,
        failureMessage: null,
        feeCents: null,
        netCents: null,
        receivedAt: null,
        capturable: false,
        cardBrand: null,
        cardLast4: null,
      };
    },

    async refund(account, input) {
      const amount = requireAmount(input.amountCents);
      const r = await api(
        `/v2/payments/captures/${encodeURIComponent(input.providerPaymentId)}/refund`,
        {
          account,
          requestId: input.idempotencyKey,
          body: {
            amount: { currency_code: 'USD', value: decimalOfCents(amount) },
            ...(input.reason ? { note_to_payer: input.reason.slice(0, 255) } : {}),
          },
        },
      );
      const status = String(r['status'] ?? '');
      const failed = status === 'FAILED' || status === 'CANCELLED';
      return {
        providerRefundId: String(r['id'] ?? ''),
        status: status === 'COMPLETED' ? 'succeeded' : failed ? 'failed' : 'pending',
        providerStatus: status,
        amountCents: centsOfDecimal(obj(r['amount'])['value']) ?? amount,
        failureCode: failed ? 'refund_failed' : null,
        failureMessage: failed ? 'PayPal couldn’t send that refund. Try again.' : null,
      } satisfies RefundResult;
    },

    ensureCustomer: () => Promise.reject(refused('keep a customer for later')),
    saveMethod: () => Promise.reject(refused('save a card')),
    listMethods: async () => [],
    forgetMethod: async () => {},

    /** PayPal acts for a seller only, so HandsFreeOS can't bill itself through it. */
    platform: {
      supported: false,
      livemode: opts.environment === 'live',
      payouts: {
        create: () => Promise.reject(new PlatformUnsupportedError('paypal')),
        read: () => Promise.reject(new PlatformUnsupportedError('paypal')),
        onboardingLink: () => Promise.reject(new PlatformUnsupportedError('paypal')),
        loginLink: () => Promise.reject(new PlatformUnsupportedError('paypal')),
        transfer: () => Promise.reject(new PlatformUnsupportedError('paypal')),
        giveBack: () => Promise.reject(new PlatformUnsupportedError('paypal')),
      },
      ensureCustomer: () => Promise.reject(new PlatformUnsupportedError('paypal')),
      startCardSession: () => Promise.reject(new PlatformUnsupportedError('paypal')),
      readCardSession: () => Promise.reject(new PlatformUnsupportedError('paypal')),
      saveMethod: () => Promise.reject(new PlatformUnsupportedError('paypal')),
      forgetMethod: () => Promise.reject(new PlatformUnsupportedError('paypal')),
      describeMethod: () => Promise.reject(new PlatformUnsupportedError('paypal')),
      charge: () => Promise.reject(new PlatformUnsupportedError('paypal')),
      createCheckout: () => Promise.reject(new PlatformUnsupportedError('paypal')),
      checkoutCard: () => Promise.reject(new PlatformUnsupportedError('paypal')),
      webhooks: {
        configured: false,
        verify: () => false,
        checkout: () => null,
        refund: () => null,
      },
    },

    // Plans stay on Stripe or Square (pick 4a).
    subscriptions: {
      create: () => Promise.reject(refused('run a plan')),
      pause: () => Promise.reject(refused('run a plan')),
      resume: () => Promise.reject(refused('run a plan')),
      cancel: () => Promise.reject(refused('run a plan')),
      get: () => Promise.reject(refused('run a plan')),
    },

    /** Known the moment the money is captured: PayPal puts its fee on the capture. */
    async fees(account, providerPaymentId): Promise<PaymentFees> {
      const capture = await api(`/v2/payments/captures/${encodeURIComponent(providerPaymentId)}`, {
        account,
      });
      const result = fromCapture(capture, 0);
      return { feeCents: result.feeCents, netCents: result.netCents };
    },

    webhooks: {
      configured: !!opts.webhookId,
      verify: (input) => verifyWebhook(input),
      parse: readPayPalEvent,
    },
  };

  // ---------- webhook signatures ----------

  /**
   * PayPal signs `<transmission id>|<time>|<our webhook id>|<CRC32 of the body>` with the private key of a
   * certificate it serves, and names that certificate's address on the delivery. The address has to be PayPal's
   * own over https, or anyone could sign with a certificate of their own; the certificate is kept once fetched.
   */
  async function verifyWebhook({ rawBody, headers }: WebhookInput): Promise<boolean> {
    if (!opts.webhookId) return false;
    const id = headers['paypal-transmission-id'];
    const time = headers['paypal-transmission-time'];
    const signature = headers['paypal-transmission-sig'];
    const certUrl = headers['paypal-cert-url'];
    const algo = headers['paypal-auth-algo'];
    if (!id || !time || !signature || !certUrl) return false;
    if (algo && algo !== 'SHA256withRSA') return false;
    const key = await certificateKey(certUrl);
    if (!key) return false;
    const message = `${id}|${time}|${opts.webhookId}|${crc32(Buffer.from(rawBody, 'utf8'))}`;
    try {
      return verifySignature('sha256', Buffer.from(message), key, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }

  async function certificateKey(certUrl: string): Promise<KeyObject | null> {
    let url: URL;
    try {
      url = new URL(certUrl);
    } catch {
      return null;
    }
    const paypal = url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com');
    if (url.protocol !== 'https:' || !paypal || url.username || url.password || url.port)
      return null;
    const known = certificates.get(url.href);
    if (known && known.until > clock()) return known.key;
    try {
      const res = await f(url.href, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const pem = await res.text();
      let until = clock() + 86_400_000;
      if (pem.includes('BEGIN CERTIFICATE')) {
        const cert = new X509Certificate(pem);
        const ends = Date.parse(cert.validTo);
        if (!Number.isFinite(ends) || ends <= clock() || Date.parse(cert.validFrom) > clock())
          return null;
        until = Math.min(until, ends);
      }
      const key = createPublicKey(pem);
      certificates.set(url.href, { key, until });
      return key;
    } catch {
      return null;
    }
  }
}

/** Certificates PayPal signed with, by their address, shared by every adapter in the process. */
const certificates = new Map<string, { key: KeyObject; until: number }>();
