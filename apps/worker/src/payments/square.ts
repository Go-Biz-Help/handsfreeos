/**
 * Square, through its own OAuth 2.0. The seller signs in, we get an access token for **their** account and the
 * location money is taken at, and every call goes out with that token — so the money settles with them. Nothing
 * touches our balance: M9 takes no `app_fee_money`.
 *
 * Two things shape this file:
 * - **The token expires after 30 days.** A per-connection refresh runs weekly (payments/refresh.ts), with an
 *   hourly re-arm, because a refresh job that quietly exhausted its retries would end a business's payments a
 *   month later with nothing to show for it.
 * - **There is no "payment failed" event.** Declines come back from `CreatePayment` itself, so `charge` answers
 *   with `status: 'failed'` and the card's code instead of throwing. Square's webhooks only ever confirm.
 *
 * The browser tokenises with the Web Payments SDK (our application id, their location) and we charge from here:
 * `flow: 'server_charge'`.
 */
import { randomUUID } from 'node:crypto';
import {
  centsOf,
  cleanMetadata,
  declineWording,
  hmacBase64,
  idempotencyKey,
  isoOf,
  meansReconnect,
  NO_CAPABILITIES,
  PaymentAuthError,
  PaymentError,
  requireAmount,
  signatureMatches,
  type ChargeInput,
  type ConnectedAccount,
  type CustomerInput,
  type PaymentAccount,
  type PaymentCapabilities,
  type PaymentEnvironment,
  type PaymentEvent,
  type PaymentFees,
  type PaymentProvider,
  type PaymentResult,
  type PaymentState,
  type PaymentTokens,
  type PrepareInput,
  type PreparedPayment,
  type RefundInput,
  type RefundResult,
  type SavedMethod,
  type SubscriptionInput,
  type SubscriptionResult,
  type SubscriptionState,
  type WebhookInput,
} from './provider';

const HOSTS: Record<PaymentEnvironment, string> = {
  live: 'https://connect.squareup.com',
  test: 'https://connect.squareupsandbox.com',
};
/** Pinned, so a new Square version never changes what our calls mean underneath us. */
const SQUARE_VERSION = '2025-06-18';
/** Everything we use on the seller's behalf. Square refuses the sign-in outright if one is not granted. */
export const SQUARE_SCOPES = [
  'MERCHANT_PROFILE_READ',
  'PAYMENTS_READ',
  'PAYMENTS_WRITE',
  'CUSTOMERS_READ',
  'CUSTOMERS_WRITE',
  'SUBSCRIPTIONS_READ',
  'SUBSCRIPTIONS_WRITE',
  'ITEMS_READ',
  'ITEMS_WRITE',
] as const;
/** Square advises refreshing at least weekly; a token under this much life left is renewed at once. */
export const SQUARE_TOKEN_LIFE_MS = 30 * 86_400_000;

type Json = Record<string, unknown>;

interface SquareError {
  category?: string;
  code?: string;
  detail?: string;
  field?: string;
}

const obj = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(obj) : []);
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/** Square's own word for where a payment stands, in ours. */
function stateOf(status: string): PaymentState {
  switch (status) {
    case 'COMPLETED':
      return 'succeeded';
    // A bank transfer on its way, and a held card: promised, not taken.
    case 'PENDING':
    case 'APPROVED':
      return 'processing';
    case 'FAILED':
    case 'CANCELED':
      return 'failed';
    default:
      return 'requires_payment';
  }
}

/** Codes where the card, not Square, said no: an answer for the customer's page, never a failure to retry. */
const DECLINED = new Set([
  'CARD_DECLINED',
  'GENERIC_DECLINE',
  'CVV_FAILURE',
  'ADDRESS_VERIFICATION_FAILURE',
  'INVALID_ACCOUNT',
  'INSUFFICIENT_FUNDS',
  'INVALID_EXPIRATION',
  'CARD_EXPIRED',
  'CARD_NOT_SUPPORTED',
  'ALLOWABLE_PIN_TRIES_EXCEEDED',
  'PAN_FAILURE',
  'TRANSACTION_LIMIT',
  'VOICE_FAILURE',
  'CARD_DECLINED_VERIFICATION_REQUIRED',
  'CARD_DECLINED_CALL_ISSUER',
  'INVALID_CARD',
  'INVALID_CARD_DATA',
  'INVALID_PIN',
  'EXPIRATION_FAILURE',
  'CHIP_INSERTION_REQUIRED',
  'MANUALLY_ENTERED_PAYMENT_NOT_SUPPORTED',
  'PAYMENT_LIMIT_EXCEEDED',
  'TEMPORARY_ERROR',
]);

const subscriptionState = (status: string): SubscriptionState => {
  switch (status) {
    case 'ACTIVE':
      return 'active';
    case 'PAUSED':
      return 'paused';
    case 'DELINQUENT':
      return 'past_due';
    case 'CANCELED':
      return 'cancelled';
    default:
      return 'pending';
  }
};

export function createSquarePayments(opts: {
  applicationId: string | null;
  applicationSecret: string | null;
  /** Comma-separated in the environment, so a signature key can be rotated without dropping a webhook. */
  webhookSignatureKeys: readonly string[];
  environment: PaymentEnvironment;
  fetch?: typeof fetch;
}): PaymentProvider {
  const f = opts.fetch ?? fetch;
  const host = HOSTS[opts.environment];
  const configured = !!(opts.applicationId && opts.applicationSecret);

  const app = () => {
    if (!opts.applicationId || !opts.applicationSecret)
      throw new PaymentError('Square isn’t set up on this server yet.', null, true);
    return { id: opts.applicationId, secret: opts.applicationSecret };
  };

  const tokenOf = (account: PaymentAccount): string => {
    if (!account.accessToken)
      throw new PaymentAuthError('This Square account has no sign-in.', 'missing');
    return account.accessToken;
  };

  /** The first error Square listed: its code is what everything here decides on. */
  async function errorsOf(res: Response): Promise<SquareError> {
    try {
      const body = (await res.json()) as { errors?: SquareError[] };
      return body.errors?.[0] ?? {};
    } catch {
      return {};
    }
  }

  async function fail(res: Response, error: SquareError): Promise<never> {
    const code = error.code ?? `http_${res.status}`;
    if (meansReconnect(code) || res.status === 401)
      throw new PaymentAuthError(`Square no longer accepts this sign-in (${code}).`, code);
    if (code === 'INSUFFICIENT_SCOPES')
      throw new PaymentAuthError(
        'This Square sign-in is missing a permission HandsFreeOS needs.',
        code,
      );
    const seconds = Number(res.headers.get('retry-after'));
    const transient = code === 'RATE_LIMITED' || res.status === 429 || res.status >= 500;
    throw new PaymentError(
      `Square answered ${res.status} (${code}).`,
      res.status,
      !transient,
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      code,
    );
  }

  async function api<T>(
    account: PaymentAccount | null,
    path: string,
    init: { method?: string; body?: Json; token?: string } = {},
  ): Promise<T> {
    const token = init.token ?? (account ? tokenOf(account) : null);
    const res = await f(`${host}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        'square-version': SQUARE_VERSION,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) return fail(res, await errorsOf(res));
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** A payment call whose refusal may be the card's answer rather than Square's failure. */
  async function charged(
    account: PaymentAccount,
    path: string,
    body: Json,
    fallbackAmount: number,
  ): Promise<PaymentResult> {
    const res = await f(`${host}${path}`, {
      method: 'POST',
      headers: {
        'square-version': SQUARE_VERSION,
        authorization: `Bearer ${tokenOf(account)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const answer = (await res.json()) as { payment?: unknown };
      return paymentResult(answer.payment, fallbackAmount);
    }
    const error = await errorsOf(res);
    const code = error.code ?? '';
    if (DECLINED.has(code) || error.category === 'PAYMENT_METHOD_ERROR')
      return {
        // A refused payment has no id of its own here: the row we wrote before calling keeps the idempotency key.
        providerPaymentId: str(body['idempotency_key']) ?? '',
        status: 'failed',
        providerStatus: code || 'DECLINED',
        amountCents: fallbackAmount,
        failureCode: code || 'card_declined',
        failureMessage: declineWording(code),
        feeCents: null,
        netCents: null,
        receivedAt: null,
        capturable: false,
      };
    return fail(res, error);
  }

  function paymentResult(raw: unknown, fallbackAmount: number): PaymentResult {
    const p = obj(raw);
    const status = String(p['status'] ?? '');
    const state = stateOf(status);
    const fees = list(p['processing_fee']).reduce<number | null>((sum, fee) => {
      const amount = centsOf(obj(fee['amount_money'])['amount']);
      return amount === null ? sum : (sum ?? 0) + amount;
    }, null);
    const amount = centsOf(obj(p['amount_money'])['amount']) ?? fallbackAmount;
    return {
      providerPaymentId: String(p['id'] ?? ''),
      status: state,
      providerStatus: status,
      amountCents: amount,
      failureCode: state === 'failed' ? (str(p['delay_action']) ?? 'payment_failed') : null,
      failureMessage: state === 'failed' ? declineWording(null) : null,
      feeCents: fees,
      netCents: fees === null ? null : amount - fees,
      receivedAt: state === 'succeeded' ? isoOf(p['updated_at'] ?? p['created_at']) : null,
      capturable: status === 'APPROVED',
    };
  }

  async function tokensFrom(params: Json): Promise<PaymentTokens> {
    const { id, secret } = app();
    const res = await f(`${host}/oauth2/token`, {
      method: 'POST',
      headers: { 'square-version': SQUARE_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: id, client_secret: secret, ...params }),
    });
    if (!res.ok) return fail(res, await errorsOf(res));
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: string;
      merchant_id?: string;
    };
    if (!body.access_token || !body.merchant_id)
      throw new PaymentError('Square didn’t say which account signed in.', null, true);
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      // Square dates its own expiry; without one, take the documented 30 days.
      expiresAt:
        isoOf(body.expires_at) ?? new Date(Date.now() + SQUARE_TOKEN_LIFE_MS).toISOString(),
      scopes: [...SQUARE_SCOPES],
      externalAccountId: body.merchant_id,
      environment: opts.environment,
    };
  }

  const accountOf = (tokens: PaymentTokens, locationId: string | null = null): PaymentAccount => ({
    provider: 'square',
    externalAccountId: tokens.externalAccountId,
    locationId,
    accessToken: tokens.accessToken,
    environment: tokens.environment,
  });

  /** The location money is taken at: the first active one that can take cards. */
  async function mainLocation(account: PaymentAccount): Promise<Json | null> {
    const answer = await api<{ locations?: unknown[] }>(account, '/v2/locations');
    const all = (answer.locations ?? []).map(obj);
    const usable = all.filter((l) => String(l['status'] ?? 'ACTIVE') === 'ACTIVE');
    return (
      usable.find((l) =>
        (Array.isArray(l['capabilities']) ? l['capabilities'] : []).includes(
          'CREDIT_CARD_PROCESSING',
        ),
      ) ??
      usable[0] ??
      all[0] ??
      null
    );
  }

  async function readCapabilities(account: PaymentAccount): Promise<PaymentCapabilities> {
    const location = await mainLocation(account);
    if (!location) return NO_CAPABILITIES('server_charge');
    const caps = Array.isArray(location['capabilities']) ? location['capabilities'] : [];
    const card = caps.includes('CREDIT_CARD_PROCESSING');
    return {
      card,
      // The seller turns ACH on per location; the Web Payments SDK offers it only where it is.
      bankTransfer: card && caps.includes('ACH_PROCESSING'),
      // Square's plans are card-only and want at least a dollar a cycle (research, 2026-09-16).
      subscriptions: card,
      refunds: card,
      savedMethods: card,
      holds: card,
      flow: 'server_charge',
    };
  }

  const cardOf = (raw: unknown): SavedMethod => {
    const c = obj(raw);
    return {
      token: String(c['id'] ?? ''),
      kind: 'card',
      brand: str(c['card_brand']),
      last4: str(c['last_4']),
      expiryMonth: centsOf(c['exp_month']),
      expiryYear: centsOf(c['exp_year']),
    };
  };

  function subscriptionResult(raw: unknown): SubscriptionResult {
    const s = obj(raw);
    const status = String(s['status'] ?? '');
    return {
      providerSubscriptionId: String(s['id'] ?? ''),
      status: subscriptionState(status),
      providerStatus: status,
      currentPeriodStart: isoOf(s['start_date']),
      currentPeriodEnd: isoOf(s['charged_through_date']),
      cancelAt: isoOf(s['canceled_date']),
    };
  }

  /**
   * Square bills a plan from a catalogue variation, so one is made per price and cadence. The idempotency key
   * makes a repeat land on the same objects rather than a second plan.
   */
  async function planVariation(account: PaymentAccount, input: SubscriptionInput): Promise<string> {
    const cadence = input.interval === 'year' ? 'ANNUAL' : 'MONTHLY';
    const planId = `#plan-${input.idempotencyKey.slice(0, 20)}`;
    const variationId = `#variation-${input.idempotencyKey.slice(0, 20)}`;
    const made = await api<{ id_mappings?: unknown[] }>(account, '/v2/catalog/batch-upsert', {
      body: {
        idempotency_key: idempotencyKey(input.idempotencyKey),
        batches: [
          {
            objects: [
              {
                type: 'SUBSCRIPTION_PLAN',
                id: planId,
                subscription_plan_data: {
                  name: input.name.slice(0, 200),
                  subscription_plan_variations: [
                    {
                      type: 'SUBSCRIPTION_PLAN_VARIATION',
                      id: variationId,
                      subscription_plan_variation_data: {
                        name: input.name.slice(0, 200),
                        phases: [
                          {
                            cadence,
                            pricing: {
                              type: 'STATIC',
                              price_money: {
                                amount: requireAmount(input.amountCents),
                                currency: 'USD',
                              },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    const mapped = (made.id_mappings ?? [])
      .map(obj)
      .find((m) => str(m['client_object_id']) === variationId);
    const id = str(mapped?.['object_id']);
    if (!id) throw new PaymentError('Square didn’t make the plan to bill.', null, true);
    return id;
  }

  return {
    name: 'square',
    configured,
    flow: 'server_charge',
    // The Web Payments SDK's application id is public, and the same one in both environments' pages.
    publishableKey: opts.applicationId ?? '',

    authorizeUrl({ state, redirectUri }) {
      const q = new URLSearchParams({
        client_id: opts.applicationId ?? '',
        scope: SQUARE_SCOPES.join(' '),
        // `session=false` makes the seller sign in rather than reusing whoever is already signed in there.
        session: 'false',
        state,
        redirect_uri: redirectUri,
      });
      // No PKCE on purpose: Square's PKCE flow trades the 30-day refresh token for rotating short-lived ones,
      // which is worse for a server that has to keep a connection alive for years.
      return `${host}/oauth2/authorize?${q}`;
    },

    exchangeCode: ({ code, redirectUri }) =>
      tokensFrom({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),

    async refreshTokens(tokens) {
      if (!tokens.refreshToken)
        throw new PaymentAuthError(
          'There is no refresh token to renew this Square sign-in.',
          'invalid_grant',
        );
      const next = await tokensFrom({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      });
      // Square keeps the first refresh token unless it sends a new one.
      return { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
    },

    async describe(tokens) {
      const account = accountOf(tokens);
      const location = await mainLocation(account);
      const merchant = await api<{ merchant?: unknown }>(
        account,
        `/v2/merchants/${encodeURIComponent(tokens.externalAccountId)}`,
      ).catch(() => ({ merchant: null }));
      const m = obj(merchant.merchant);
      const caps = location ? await readCapabilities(account) : NO_CAPABILITIES('server_charge');
      return {
        externalAccountId: tokens.externalAccountId,
        displayName: str(m['business_name']) ?? str(obj(location ?? {})['name']),
        locationId: location ? str(location['id']) : null,
        capabilities: caps,
        missingScopes: SQUARE_SCOPES.filter((s) => !tokens.scopes.includes(s)),
      } satisfies ConnectedAccount;
    },

    async revokeAccess(account) {
      const { id, secret } = app();
      const res = await f(`${host}/oauth2/revoke`, {
        method: 'POST',
        headers: {
          'square-version': SQUARE_VERSION,
          // Square's revoke authenticates as the application, not as the seller.
          authorization: `Client ${secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ client_id: id, merchant_id: account.externalAccountId }),
      });
      if (!res.ok && res.status !== 400) await fail(res, await errorsOf(res));
    },

    capabilities: readCapabilities,

    /**
     * Square has nothing to make in advance: the browser tokenises with the Web Payments SDK and we charge here.
     * This only hands the page what it needs to load the SDK.
     */
    async prepare(account, input: PrepareInput) {
      return {
        flow: 'server_charge',
        publishableKey: opts.applicationId ?? '',
        accountId: account.externalAccountId,
        locationId: account.locationId,
        clientSecret: null,
        providerPaymentId: null,
        methods: input.methods,
        amountCents: requireAmount(input.amountCents),
        hostedUrl: null,
      } satisfies PreparedPayment;
    },

    /** Nothing is confirmed in the browser here; a page that asks reads the payment back as it stands. */
    async confirmFromClient(account, providerPaymentId) {
      const answer = await api<{ payment?: unknown }>(
        account,
        `/v2/payments/${encodeURIComponent(providerPaymentId)}`,
      );
      return paymentResult(answer.payment, 0);
    },

    charge(account, input: ChargeInput) {
      const amount = requireAmount(input.amountCents);
      if (!input.sourceToken)
        throw new PaymentError('Square needs a card before it can take a payment.', null, true);
      return charged(
        account,
        '/v2/payments',
        {
          idempotency_key: idempotencyKey(input.idempotencyKey),
          source_id: input.sourceToken,
          amount_money: { amount, currency: 'USD' },
          autocomplete: true,
          ...(account.locationId ? { location_id: account.locationId } : {}),
          ...(input.customerRef ? { customer_id: input.customerRef } : {}),
          ...(input.description ? { note: input.description.slice(0, 500) } : {}),
          ...(cleanMetadata(input.metadata)['invoiceId']
            ? { reference_id: cleanMetadata(input.metadata)['invoiceId']?.slice(0, 40) }
            : {}),
        },
        amount,
      );
    },

    authorize(account, input) {
      const amount = requireAmount(input.amountCents);
      if (!input.sourceToken)
        throw new PaymentError('Square needs a card before it can hold a payment.', null, true);
      return charged(
        account,
        '/v2/payments',
        {
          idempotency_key: idempotencyKey(input.idempotencyKey),
          source_id: input.sourceToken,
          amount_money: { amount, currency: 'USD' },
          // Held, not taken: `complete` captures it, `cancel` lets it go.
          autocomplete: false,
          ...(account.locationId ? { location_id: account.locationId } : {}),
          ...(input.customerRef ? { customer_id: input.customerRef } : {}),
        },
        amount,
      );
    },

    async capture(account, input) {
      const answer = await api<{ payment?: unknown }>(
        account,
        `/v2/payments/${encodeURIComponent(input.providerPaymentId)}/complete`,
        { body: {} },
      );
      return paymentResult(answer.payment, input.amountCents);
    },

    async voidAuthorization(account, input) {
      const answer = await api<{ payment?: unknown }>(
        account,
        `/v2/payments/${encodeURIComponent(input.providerPaymentId)}/cancel`,
        { body: {} },
      );
      return { ...paymentResult(answer.payment, 0), failureCode: null, failureMessage: null };
    },

    async refund(account, input: RefundInput) {
      const answer = await api<{ refund?: unknown }>(account, '/v2/refunds', {
        body: {
          idempotency_key: idempotencyKey(input.idempotencyKey),
          payment_id: input.providerPaymentId,
          amount_money: { amount: requireAmount(input.amountCents), currency: 'USD' },
          ...(input.reason ? { reason: input.reason.slice(0, 192) } : {}),
        },
      });
      const r = obj(answer.refund);
      const status = String(r['status'] ?? '');
      return {
        providerRefundId: String(r['id'] ?? ''),
        status: status === 'COMPLETED' ? 'succeeded' : status === 'FAILED' ? 'failed' : 'pending',
        providerStatus: status,
        amountCents: centsOf(obj(r['amount_money'])['amount']) ?? input.amountCents,
        failureCode: status === 'FAILED' ? 'refund_failed' : null,
        failureMessage: status === 'FAILED' ? 'Square couldn’t send that refund. Try again.' : null,
      } satisfies RefundResult;
    },

    async ensureCustomer(account, input: CustomerInput) {
      if (input.customerRef) return { customerRef: input.customerRef };
      const [given, ...rest] = (input.name ?? '').trim().split(/\s+/);
      const answer = await api<{ customer?: unknown }>(account, '/v2/customers', {
        body: {
          idempotency_key: idempotencyKey(input.idempotencyKey),
          ...(given ? { given_name: given.slice(0, 300) } : {}),
          ...(rest.length ? { family_name: rest.join(' ').slice(0, 300) } : {}),
          ...(input.email ? { email_address: input.email.slice(0, 254) } : {}),
          ...(input.phone ? { phone_number: input.phone.slice(0, 17) } : {}),
        },
      });
      return { customerRef: String(obj(answer.customer)['id'] ?? '') };
    },

    async saveMethod(account, input) {
      const answer = await api<{ card?: unknown }>(account, '/v2/cards', {
        body: {
          idempotency_key: idempotencyKey(input.idempotencyKey),
          source_id: input.sourceToken,
          card: { customer_id: input.customerRef },
        },
      });
      return cardOf(answer.card);
    },

    async listMethods(account, customerRef) {
      const answer = await api<{ cards?: unknown[] }>(
        account,
        `/v2/cards?customer_id=${encodeURIComponent(customerRef)}&include_disabled=false`,
      );
      return (answer.cards ?? []).map(cardOf);
    },

    async forgetMethod(account, input) {
      await api(account, `/v2/cards/${encodeURIComponent(input.token)}/disable`, { body: {} });
    },

    subscriptions: {
      async create(account, input) {
        if (!account.locationId)
          throw new PaymentError('This Square account has no location to bill from.', null, true);
        const variationId = await planVariation(account, input);
        const answer = await api<{ subscription?: unknown }>(account, '/v2/subscriptions', {
          body: {
            idempotency_key: idempotencyKey(`${input.idempotencyKey}-sub`),
            location_id: account.locationId,
            plan_variation_id: variationId,
            customer_id: input.customerRef,
            ...(input.methodToken ? { card_id: input.methodToken } : {}),
            ...(input.startAt ? { start_date: input.startAt.slice(0, 10) } : {}),
          },
        });
        return subscriptionResult(answer.subscription);
      },
      async pause(account, input) {
        const answer = await api<{ subscription?: unknown }>(
          account,
          `/v2/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}/pause`,
          {
            body: {
              pause_reason: 'Paused in HandsFreeOS',
              ...(input.resumeAt ? { resume_effective_date: input.resumeAt.slice(0, 10) } : {}),
            },
          },
        );
        return subscriptionResult(answer.subscription);
      },
      async resume(account, input) {
        const answer = await api<{ subscription?: unknown }>(
          account,
          `/v2/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}/resume`,
          { body: { resume_change_timing: 'IMMEDIATE' } },
        );
        return subscriptionResult(answer.subscription);
      },
      async cancel(account, input) {
        // Square always cancels at the end of the paid period; `atPeriodEnd: false` can't be honoured there.
        const answer = await api<{ subscription?: unknown }>(
          account,
          `/v2/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}/cancel`,
          { body: {} },
        );
        return subscriptionResult(answer.subscription);
      },
      async get(account, input) {
        const answer = await api<{ subscription?: unknown }>(
          account,
          `/v2/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`,
        );
        return subscriptionResult(answer.subscription);
      },
    },

    async fees(account, providerPaymentId): Promise<PaymentFees> {
      const answer = await api<{ payment?: unknown }>(
        account,
        `/v2/payments/${encodeURIComponent(providerPaymentId)}`,
      );
      const result = paymentResult(answer.payment, 0);
      return { feeCents: result.feeCents, netCents: result.netCents };
    },

    webhooks: {
      /** Base64 HMAC-SHA256 over **the URL Square called plus the raw body**, with any live signature key. */
      verify({ rawBody, headers, url }: WebhookInput) {
        const given = headers['x-square-hmacsha256-signature'];
        if (!given || opts.webhookSignatureKeys.length === 0) return false;
        return opts.webhookSignatureKeys.some((key) =>
          signatureMatches(given, hmacBase64(key, `${url}${rawBody}`)),
        );
      },
      parse(rawBody) {
        let body: Json;
        try {
          body = obj(JSON.parse(rawBody));
        } catch {
          return null;
        }
        const id = str(body['event_id']);
        const type = str(body['type']);
        if (!id || !type) return null;
        return {
          id,
          type,
          // One webhook URL serves every seller, so the merchant id is how an event finds its business.
          accountRef: str(body['merchant_id']),
          createdAt: isoOf(body['created_at']),
          data: obj(obj(body['data'])['object']),
        } satisfies PaymentEvent;
      },
    },
  };
}

/** A fresh idempotency key for work Square insists on one for but we have nothing to key on. */
export const squareKey = (): string => randomUUID();
