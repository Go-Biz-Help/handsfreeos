/**
 * Stripe, through Connect OAuth (Standard accounts). The business signs in at Stripe and we get their
 * `acct_…`; every call after that goes out with **our** platform secret key and a `Stripe-Account` header, so
 * the money settles in their account and they are the merchant of record. Nothing touches our balance: M9 takes
 * no application fee.
 *
 * Payments are PaymentIntents confirmed **in the browser** with the Payment Element, which is what makes Stripe's
 * bank transfers (ACH) possible at all; `confirmFromClient` then reads the intent back so the answer is Stripe's
 * and not the page's. Server-side charges exist for off-session work only — a plan's cycle, a deposit captured
 * later. A decline comes back as a `failed` result, never as a thrown error.
 *
 * Sharp edge (research, 2026-09-16): since 2021 `read_write` OAuth cannot attach to a Standard account another
 * platform already controls, and Stripe pushes the seller to make a second account. The callback turns that into
 * plain words and offers Square instead.
 */
import {
  ACCOUNT_HELD_ELSEWHERE,
  centsOf,
  cleanMetadata,
  cardBrandLabel,
  cardLast4,
  declineWording,
  hmacHex,
  idempotencyKey,
  isoOf,
  meansReconnect,
  NO_CAPABILITIES,
  PaymentAuthError,
  PaymentError,
  requireAmount,
  signatureMatches,
  type CustomerInput,
  type PaymentAccount,
  type PaymentCapabilities,
  type PaymentEvent,
  type PaymentFees,
  type PaymentProvider,
  type PaymentResult,
  type PaymentState,
  type PaymentTokens,
  type PreparedPayment,
  type RefundResult,
  type SavedMethod,
  type SubscriptionInput,
  type SubscriptionResult,
  type SubscriptionState,
  type WebhookInput,
  type CheckoutEvent,
} from './provider';

const CONNECT = 'https://connect.stripe.com';
const API = 'https://api.stripe.com/v1';
/**
 * The API version every call is made against. **Pinned on purpose**: without this header Stripe uses the
 * platform account's own default, which Stripe can move and a dashboard upgrade can change — so response
 * shapes would shift under a running deploy that nobody made. Square is pinned the same way (`SQUARE_VERSION`).
 * Moving it is a deliberate commit: read the changelog between the two versions first.
 */
const API_VERSION = '2026-08-26.dahlia';
/** Stripe's own window for a signed webhook; anything older is a replay. */
const TOLERANCE_MS = 5 * 60_000;
/** Everything a platform needs to charge, refund and bill on the seller's behalf. */
const SCOPE = 'read_write';

type Json = Record<string, unknown>;

interface StripeErrorBody {
  error?: {
    type?: string;
    code?: string;
    decline_code?: string;
    message?: string;
    payment_intent?: Json;
  };
  /** The OAuth endpoints answer in the plain OAuth shape instead. */
  error_description?: string;
}

const obj = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/** Stripe reads nested form bodies as `a[b][0][c]`. Nothing here ever sends a raw object. */
function form(input: Json): URLSearchParams {
  const out = new URLSearchParams();
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => add(`${key}[${i}]`, v));
    else if (typeof value === 'object')
      for (const [k, v] of Object.entries(value as Json)) add(`${key}[${k}]`, v);
    else out.append(key, String(value));
  };
  for (const [k, v] of Object.entries(input)) add(k, v);
  return out;
}

/** Stripe's own words for where a PaymentIntent stands, in ours. */
function stateOf(status: string): PaymentState {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
      return 'processing';
    case 'canceled':
      return 'failed';
    case 'requires_capture':
      // A held card. Ours calls that `processing`: the money is promised but not taken.
      return 'processing';
    default:
      return 'requires_payment';
  }
}

const subscriptionState = (status: string, paused: boolean): SubscriptionState => {
  if (paused) return 'paused';
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'cancelled';
    case 'paused':
      return 'paused';
    default:
      return 'pending';
  }
};

/**
 * `Stripe-Signature: t=…,v1=…` — HMAC-SHA256 over `"{timestamp}.{raw body}"`, within five minutes. The same
 * scheme for the Connect endpoint and our own account's, each with its own secret.
 */
function verifyStripeSignature(secret: string | null, { rawBody, headers }: WebhookInput): boolean {
  const header = headers['stripe-signature'];
  if (!secret || !header) return false;
  const parts = new Map(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() - timestamp * 1000) > TOLERANCE_MS) return false;
  const expected = hmacHex(secret, `${timestamp}.${rawBody}`);
  // Stripe may send several v1 signatures while a secret is being rotated.
  return header
    .split(',')
    .filter((p) => p.trim().startsWith('v1='))
    .some((p) => signatureMatches(p.trim().slice(3), expected));
}

/**
 * One of our own account's Checkout events, or null for anything else. An event that names a connected account
 * is somebody else's and is never read as ours — the Connect endpoint is where those go.
 */
export function readStripeCheckoutEvent(rawBody: string): CheckoutEvent | null {
  let body: Json;
  try {
    body = obj(JSON.parse(rawBody));
  } catch {
    return null;
  }
  const id = str(body['id']);
  const type = str(body['type']);
  if (!id || !type || !type.startsWith('checkout.session.') || str(body['account'])) return null;
  const session = obj(obj(body['data'])['object']);
  const sessionRef = str(session['id']);
  if (!sessionRef) return null;
  const intent = session['payment_intent'];
  return {
    id,
    type,
    sessionRef,
    checkoutId:
      str(obj(session['metadata'])['founding_checkout_id']) ?? str(session['client_reference_id']),
    paymentStatus: str(session['payment_status']),
    paymentRef: typeof intent === 'string' ? str(intent) : str(obj(intent)['id']),
    amountTotal: centsOf(session['amount_total']),
  };
}

export function createStripePayments(opts: {
  /** The Connect platform's `ca_…`: which application the seller is signing in to. */
  clientId: string | null;
  /** Our own platform key. Every call on a seller's behalf is made with it. */
  secretKey: string | null;
  /** Public; the customer's page loads Stripe.js with it. */
  publishableKey: string | null;
  /** `whsec_…`, for checking that a webhook really came from Stripe. */
  webhookSecret: string | null;
  /**
   * `whsec_…` of our own account's event destination (0093): Checkout for the founding seats. A separate
   * endpoint in Stripe, so a separate secret — the Connect one never verifies these, nor these the Connect ones.
   */
  platformWebhookSecret?: string | null;
  fetch?: typeof fetch;
}): PaymentProvider {
  const f = opts.fetch ?? fetch;
  const configured = !!(opts.clientId && opts.secretKey);

  const keys = () => {
    if (!opts.secretKey || !opts.clientId)
      throw new PaymentError('Stripe isn’t set up on this server yet.', null, true);
    return { secretKey: opts.secretKey, clientId: opts.clientId };
  };
  /**
   * Our own money needs only our own key. The Connect client id is for businesses signing their Stripe in to
   * us, and HandsFreeOS charging its own customers does not depend on that being set up.
   */
  const keyFor = (account: PaymentAccount | null): string => {
    if (account) return keys().secretKey;
    if (!opts.secretKey)
      throw new PaymentError('Stripe isn’t set up on this server yet.', null, true);
    return opts.secretKey;
  };

  /** Turns a refusal into the right error. A declined card never reaches here: `charged` catches it first. */
  async function fail(res: Response): Promise<never> {
    let body: StripeErrorBody = {};
    try {
      body = (await res.json()) as StripeErrorBody;
    } catch {
      // Not JSON: the status says enough.
    }
    const code = body.error?.code ?? `http_${res.status}`;
    const detail = body.error?.message ?? body.error_description ?? '';
    if (meansReconnect(code) || res.status === 401)
      throw new PaymentAuthError(`Stripe no longer accepts this sign-in (${code}).`, code);
    // "This account is controlled by another platform": the seller has to make a second one.
    if (/another platform|already connected to a platform|platform_account/i.test(detail))
      throw new PaymentAuthError(
        `Stripe refused the sign-in: ${detail.slice(0, 300)}`,
        ACCOUNT_HELD_ELSEWHERE,
      );
    const seconds = Number(res.headers.get('retry-after'));
    const transient = res.status === 409 || res.status === 429 || res.status >= 500;
    throw new PaymentError(
      `Stripe answered ${res.status}${code ? ` (${code})` : ''}.`,
      res.status,
      !transient,
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      code,
    );
  }

  /** One call on a seller's behalf: our key, their account, and an idempotency key when it writes. */
  async function api<T>(
    account: PaymentAccount | null,
    path: string,
    init: { method?: string; body?: Json; idempotencyKey?: string } = {},
  ): Promise<T> {
    const secretKey = keyFor(account);
    const headers: Record<string, string> = {
      authorization: `Bearer ${secretKey}`,
      'stripe-version': API_VERSION,
    };
    if (account) headers['stripe-account'] = account.externalAccountId;
    if (init.body) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (init.idempotencyKey) headers['idempotency-key'] = idempotencyKey(init.idempotencyKey);
    const res = await f(`${API}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers,
      ...(init.body ? { body: form(init.body) } : {}),
    });
    if (!res.ok) return fail(res);
    return (await res.json()) as T;
  }

  /**
   * A write that may be refused by the card rather than by Stripe. A `card_error` is an answer, so it comes back
   * as the intent Stripe attached to it; anything else is a real failure.
   */
  async function charged(
    /** The seller the money goes to. **Null is HandsFreeOS itself**: no header, so the money comes to us. */
    account: PaymentAccount | null,
    path: string,
    body: Json,
    key: string,
  ): Promise<PaymentResult> {
    const secretKey = keyFor(account);
    const res = await f(`${API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'stripe-version': API_VERSION,
        ...(account ? { 'stripe-account': account.externalAccountId } : {}),
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': idempotencyKey(key),
      },
      body: form(body),
    });
    if (res.ok) return intentResult(await res.json());
    let error: StripeErrorBody = {};
    try {
      error = (await res.json()) as StripeErrorBody;
    } catch {
      // Not JSON.
    }
    const e = error.error;
    if (e?.type === 'card_error' && e.payment_intent) {
      const code = e.decline_code ?? e.code ?? 'card_declined';
      return {
        ...intentResult(e.payment_intent),
        status: 'failed',
        failureCode: code,
        failureMessage: declineWording(code),
      };
    }
    return fail(new Response(JSON.stringify(error), { status: res.status, headers: res.headers }));
  }

  /** One PaymentIntent, read the same way whoever asked for it. */
  function intentResult(raw: unknown): PaymentResult {
    const i = obj(raw);
    const status = String(i['status'] ?? '');
    const error = obj(i['last_payment_error']);
    const code = str(error['decline_code']) ?? str(error['code']);
    const charge = obj(i['latest_charge']);
    const balance = obj(charge['balance_transaction']);
    // The card, when it was one: the intent is read back with its charge expanded, which carries these.
    const card = obj(obj(charge['payment_method_details'])['card']);
    const state = stateOf(status);
    return {
      providerPaymentId: String(i['id'] ?? ''),
      status: state,
      providerStatus: status,
      amountCents: centsOf(i['amount']) ?? 0,
      failureCode: state === 'failed' ? (code ?? 'payment_failed') : null,
      failureMessage: state === 'failed' ? declineWording(code) : null,
      feeCents: centsOf(balance['fee']),
      netCents: centsOf(balance['net']),
      receivedAt: state === 'succeeded' ? isoOf(i['created']) : null,
      capturable: status === 'requires_capture',
      cardBrand: cardBrandLabel(str(card['brand'])),
      cardLast4: cardLast4(str(card['last4'])),
    };
  }

  const intent = (account: PaymentAccount, id: string) =>
    api<Json>(
      account,
      `/payment_intents/${encodeURIComponent(id)}?expand[]=latest_charge.balance_transaction`,
    );

  async function tokensFrom(params: Record<string, string>): Promise<PaymentTokens> {
    const { secretKey, clientId } = keys();
    const res = await f(`${CONNECT}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ client_id: clientId, ...params }),
    });
    if (!res.ok) return fail(res);
    const body = (await res.json()) as {
      stripe_user_id?: string;
      refresh_token?: string;
      scope?: string;
      livemode?: boolean;
    };
    if (!body.stripe_user_id)
      throw new PaymentError('Stripe didn’t say which account signed in.', null, true);
    return {
      // Stripe calls use our own key with a Stripe-Account header, so there is no seller token to keep.
      accessToken: null,
      refreshToken: body.refresh_token ?? null,
      expiresAt: null,
      scopes: (body.scope ?? SCOPE).split(' ').filter(Boolean),
      externalAccountId: body.stripe_user_id,
      environment: body.livemode === false ? 'test' : 'live',
    };
  }

  const accountOf = (tokens: PaymentTokens): PaymentAccount => ({
    provider: 'stripe',
    externalAccountId: tokens.externalAccountId,
    locationId: null,
    accessToken: null,
    environment: tokens.environment,
  });

  async function readCapabilities(account: PaymentAccount): Promise<PaymentCapabilities> {
    const a = await api<Json>(null, `/accounts/${encodeURIComponent(account.externalAccountId)}`);
    const caps = obj(a['capabilities']);
    const charges = a['charges_enabled'] === true;
    const card = charges && caps['card_payments'] === 'active';
    // Free: it rides the account read we already make, and the same webhook already refreshes it.
    const due = obj(a['requirements']);
    const waiting = (key: string) => (Array.isArray(due[key]) ? (due[key] as unknown[]).length : 0);
    return {
      card,
      bankTransfer: charges && caps['us_bank_account_ach_payments'] === 'active',
      subscriptions: card,
      refunds: charges,
      savedMethods: card,
      holds: card,
      flow: 'client_confirm',
      needsInfo:
        waiting('currently_due') > 0 || waiting('past_due') > 0 || !!due['disabled_reason'],
      needsInfoBy: centsOf(due['current_deadline']),
    };
  }

  const cardOf = (raw: unknown): SavedMethod => {
    const m = obj(raw);
    const card = obj(m['card']);
    const bank = obj(m['us_bank_account']);
    const isBank = String(m['type'] ?? '') === 'us_bank_account';
    return {
      token: String(m['id'] ?? ''),
      kind: isBank ? 'ach' : 'card',
      brand: str(card['brand']) ?? str(bank['bank_name']),
      last4: str(card['last4']) ?? str(bank['last4']),
      expiryMonth: centsOf(card['exp_month']),
      expiryYear: centsOf(card['exp_year']),
    };
  };

  function subscriptionResult(raw: unknown): SubscriptionResult {
    const s = obj(raw);
    const pause = obj(s['pause_collection']);
    return {
      providerSubscriptionId: String(s['id'] ?? ''),
      status: subscriptionState(String(s['status'] ?? ''), !!pause['behavior']),
      providerStatus: String(s['status'] ?? ''),
      currentPeriodStart: isoOf(s['current_period_start']),
      currentPeriodEnd: isoOf(s['current_period_end']),
      cancelAt: isoOf(s['cancel_at']),
    };
  }

  return {
    name: 'stripe',
    configured,
    flow: 'client_confirm',
    publishableKey: opts.publishableKey ?? '',

    authorizeUrl({ state, redirectUri }) {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: opts.clientId ?? '',
        scope: SCOPE,
        redirect_uri: redirectUri,
        state,
      });
      // No PKCE: Stripe's Connect OAuth doesn't offer it. The one-time state is what ties the callback to us.
      return `${CONNECT}/oauth/authorize?${q}`;
    },

    exchangeCode: ({ code }) => tokensFrom({ grant_type: 'authorization_code', code }),

    // Stripe's access is our own key plus the account header, so there is nothing to renew.
    async refreshTokens(tokens) {
      return tokens;
    },

    async describe(tokens) {
      const account = accountOf(tokens);
      const a = await api<Json>(null, `/accounts/${encodeURIComponent(tokens.externalAccountId)}`);
      const profile = obj(a['business_profile']);
      const dashboard = obj(obj(a['settings'])['dashboard']);
      let capabilities: PaymentCapabilities;
      try {
        capabilities = await readCapabilities(account);
      } catch {
        // A brand-new account whose capabilities are still being decided: it connects, and says so.
        capabilities = NO_CAPABILITIES('client_confirm');
      }
      return {
        externalAccountId: tokens.externalAccountId,
        displayName:
          str(dashboard['display_name']) ?? str(profile['name']) ?? str(a['email']) ?? null,
        locationId: null,
        capabilities,
        missingScopes: tokens.scopes.includes(SCOPE) ? [] : [SCOPE],
      };
    },

    async revokeAccess(account) {
      const { secretKey, clientId } = keys();
      const res = await f(`${CONNECT}/oauth/deauthorize`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: clientId,
          stripe_user_id: account.externalAccountId,
        }),
      });
      // Already gone counts as gone; anything else is worth a line in the log, never a failed disconnect.
      if (!res.ok && res.status !== 400) await fail(res);
    },

    capabilities: readCapabilities,

    async prepare(account, input) {
      const amount = requireAmount(input.amountCents);
      const created = await api<Json>(account, '/payment_intents', {
        body: {
          amount,
          currency: 'usd',
          automatic_payment_methods: { enabled: true },
          ...(input.hold ? { capture_method: 'manual' } : {}),
          ...(input.customerRef ? { customer: input.customerRef } : {}),
          ...(input.description ? { description: input.description.slice(0, 200) } : {}),
          metadata: cleanMetadata(input.metadata),
        },
        idempotencyKey: input.idempotencyKey,
      });
      return {
        flow: 'client_confirm',
        publishableKey: opts.publishableKey ?? '',
        accountId: account.externalAccountId,
        locationId: null,
        clientSecret: str(created['client_secret']),
        providerPaymentId: String(created['id'] ?? ''),
        methods: input.methods,
        amountCents: amount,
        hostedUrl: null,
      } satisfies PreparedPayment;
    },

    async confirmFromClient(account, providerPaymentId) {
      return intentResult(await intent(account, providerPaymentId));
    },

    /** Off-session: a plan's cycle, or a saved card charged again. On-page payments go through `prepare`. */
    charge(account, input) {
      const amount = requireAmount(input.amountCents);
      return charged(
        account,
        '/payment_intents',
        {
          amount,
          currency: 'usd',
          confirm: true,
          off_session: true,
          ...(input.sourceToken ? { payment_method: input.sourceToken } : {}),
          ...(input.customerRef ? { customer: input.customerRef } : {}),
          ...(input.description ? { description: input.description.slice(0, 200) } : {}),
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: cleanMetadata(input.metadata),
        },
        input.idempotencyKey,
      );
    },

    authorize(account, input) {
      const amount = requireAmount(input.amountCents);
      return charged(
        account,
        '/payment_intents',
        {
          amount,
          currency: 'usd',
          capture_method: 'manual',
          confirm: true,
          off_session: true,
          ...(input.sourceToken ? { payment_method: input.sourceToken } : {}),
          ...(input.customerRef ? { customer: input.customerRef } : {}),
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: cleanMetadata(input.metadata),
        },
        input.idempotencyKey,
      );
    },

    capture(account, input) {
      return charged(
        account,
        `/payment_intents/${encodeURIComponent(input.providerPaymentId)}/capture`,
        { amount_to_capture: requireAmount(input.amountCents) },
        input.idempotencyKey,
      );
    },

    async voidAuthorization(account, input) {
      const cancelled = await api<Json>(
        account,
        `/payment_intents/${encodeURIComponent(input.providerPaymentId)}/cancel`,
        { body: { cancellation_reason: 'abandoned' }, idempotencyKey: input.idempotencyKey },
      );
      return { ...intentResult(cancelled), failureCode: null, failureMessage: null };
    },

    async refund(account, input) {
      const r = await api<Json>(account, '/refunds', {
        body: {
          payment_intent: input.providerPaymentId,
          amount: requireAmount(input.amountCents),
          ...(input.reason ? { metadata: { reason: input.reason.slice(0, 500) } } : {}),
        },
        idempotencyKey: input.idempotencyKey,
      });
      const status = String(r['status'] ?? '');
      const code = str(r['failure_reason']);
      return {
        providerRefundId: String(r['id'] ?? ''),
        status: status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed' : 'pending',
        providerStatus: status,
        amountCents: centsOf(r['amount']) ?? input.amountCents,
        failureCode: code,
        failureMessage: code ? 'Stripe couldn’t send that refund. Try again.' : null,
      } satisfies RefundResult;
    },

    async ensureCustomer(account, input: CustomerInput) {
      if (input.customerRef) return { customerRef: input.customerRef };
      const made = await api<Json>(account, '/customers', {
        body: {
          ...(input.name ? { name: input.name.slice(0, 200) } : {}),
          ...(input.email ? { email: input.email.slice(0, 200) } : {}),
          ...(input.phone ? { phone: input.phone.slice(0, 40) } : {}),
        },
        idempotencyKey: input.idempotencyKey,
      });
      return { customerRef: String(made['id'] ?? '') };
    },

    async saveMethod(account, input) {
      const attached = await api<Json>(
        account,
        `/payment_methods/${encodeURIComponent(input.sourceToken)}/attach`,
        { body: { customer: input.customerRef }, idempotencyKey: input.idempotencyKey },
      );
      return cardOf(attached);
    },

    async listMethods(account, customerRef) {
      const list = await api<{ data?: unknown[] }>(
        account,
        `/payment_methods?customer=${encodeURIComponent(customerRef)}&limit=20`,
      );
      return (list.data ?? []).map(cardOf);
    },

    async forgetMethod(account, input) {
      await api(account, `/payment_methods/${encodeURIComponent(input.token)}/detach`, {
        body: {},
      });
    },

    /**
     * Our own charges: the usage wallet's top-ups. Every call here passes `null` where a seller's account
     * would go, which is the whole of what makes the money ours — with Stripe Connect, the header is the
     * difference between their bank account and ours.
     */
    platform: {
      supported: true,

      async ensureCustomer(input: CustomerInput) {
        if (input.customerRef) return { customerRef: input.customerRef };
        const made = await api<Json>(null, '/customers', {
          body: {
            ...(input.name ? { name: input.name.slice(0, 200) } : {}),
            ...(input.email ? { email: input.email.slice(0, 200) } : {}),
            ...(input.phone ? { phone: input.phone.slice(0, 40) } : {}),
          },
          idempotencyKey: input.idempotencyKey,
        });
        return { customerRef: String(made['id'] ?? '') };
      },

      /**
       * Stripe's own page, in `setup` mode: it takes the card, we never see it. The session id comes back on
       * the return address (`{CHECKOUT_SESSION_ID}` is Stripe's own placeholder, filled in by Stripe on the
       * way back), and `readCardSession` reads the card off it — so the token is Stripe's answer to us, not a
       * number from a query string anybody could have typed.
       */
      async startCardSession(input) {
        const url = (mark: string) =>
          `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}card=${mark}`;
        const made = await api<Json>(null, '/checkout/sessions', {
          body: {
            mode: 'setup',
            customer: input.customerRef,
            payment_method_types: ['card'],
            // Saved for charging later, unattended: what a top-up is.
            setup_intent_data: { usage: 'off_session' },
            success_url: url('{CHECKOUT_SESSION_ID}'),
            cancel_url: url('cancelled'),
          },
          idempotencyKey: input.idempotencyKey,
        });
        const hostedUrl = str(made['url']);
        if (!hostedUrl) throw new Error('Stripe gave no page to type the card on.');
        return { sessionRef: String(made['id'] ?? ''), hostedUrl };
      },

      async readCardSession(sessionRef) {
        const session = obj(
          await api<Json>(null, `/checkout/sessions/${encodeURIComponent(sessionRef)}`),
        );
        // Anything but `complete` is a session nobody finished, which is an answer and not a failure.
        if (String(session['status'] ?? '') !== 'complete')
          return { sourceToken: null, customerRef: str(session['customer']) };
        const intent = await api<Json>(
          null,
          `/setup_intents/${encodeURIComponent(String(session['setup_intent'] ?? ''))}`,
        );
        return {
          sourceToken: str(obj(intent)['payment_method']),
          customerRef: str(session['customer']) ?? str(obj(intent)['customer']),
        };
      },

      async saveMethod(input) {
        const attached = await api<Json>(
          null,
          `/payment_methods/${encodeURIComponent(input.sourceToken)}/attach`,
          { body: { customer: input.customerRef }, idempotencyKey: input.idempotencyKey },
        );
        return cardOf(attached);
      },

      async forgetMethod(input) {
        await api(null, `/payment_methods/${encodeURIComponent(input.token)}/detach`, { body: {} });
      },

      charge(input) {
        const amount = requireAmount(input.amountCents);
        return charged(
          null,
          '/payment_intents',
          {
            amount,
            currency: 'usd',
            confirm: true,
            off_session: true,
            ...(input.sourceToken ? { payment_method: input.sourceToken } : {}),
            ...(input.customerRef ? { customer: input.customerRef } : {}),
            ...(input.description ? { description: input.description.slice(0, 200) } : {}),
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
            metadata: cleanMetadata(input.metadata),
          },
          input.idempotencyKey,
        );
      },

      /**
       * Stripe Checkout in our own account. Cards only: a card answers there and then, so `completed` with
       * `payment_status: paid` is the money in, and there is no bank transfer settling days later under a seat
       * that looks paid. The page lasts Stripe's default day, and the seat's reservation is stretched to outlast
       * it (0093).
       */
      async createCheckout(input) {
        const metadata = cleanMetadata({
          ...input.metadata,
          founding_checkout_id: input.checkoutId,
        });
        const made = await api<Json>(null, '/checkout/sessions', {
          body: {
            mode: 'payment',
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: 'usd',
                  unit_amount: requireAmount(input.amountCents),
                  product_data: {
                    name: input.productName.slice(0, 200),
                    ...(input.description ? { description: input.description.slice(0, 500) } : {}),
                  },
                },
              },
            ],
            payment_method_types: ['card'],
            success_url: input.successUrl,
            cancel_url: input.cancelUrl,
            client_reference_id: input.checkoutId,
            ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
            // A customer in our account from the first payment: the receipt goes to them, and whatever they are
            // billed later starts from somebody Stripe already knows.
            customer_creation: 'always',
            metadata,
            payment_intent_data: {
              description: input.productName.slice(0, 200),
              metadata,
            },
          },
          idempotencyKey: input.idempotencyKey,
        });
        const sessionRef = str(made['id']);
        const url = str(made['url']);
        if (!sessionRef || !url)
          throw new PaymentError('Stripe answered without a page to pay on.', null, false);
        return { sessionRef, url, expiresAt: isoOf(made['expires_at']) };
      },

      webhooks: {
        configured: !!(opts.secretKey && opts.platformWebhookSecret),
        verify: (input) => verifyStripeSignature(opts.platformWebhookSecret ?? null, input),
        checkout: readStripeCheckoutEvent,
      },
    },

    subscriptions: {
      async create(account, input: SubscriptionInput) {
        const made = await api<Json>(account, '/subscriptions', {
          body: {
            customer: input.customerRef,
            items: [
              {
                price_data: {
                  currency: 'usd',
                  unit_amount: requireAmount(input.amountCents),
                  recurring: {
                    interval: input.interval,
                    interval_count: Math.max(1, Math.trunc(input.intervalCount)),
                  },
                  product_data: { name: input.name.slice(0, 200) },
                },
              },
            ],
            ...(input.methodToken ? { default_payment_method: input.methodToken } : {}),
            ...(input.startAt
              ? { billing_cycle_anchor: Math.floor(Date.parse(input.startAt) / 1000) }
              : {}),
            metadata: cleanMetadata(input.metadata),
          },
          idempotencyKey: input.idempotencyKey,
        });
        return subscriptionResult(made);
      },
      async pause(account, input) {
        // `void` leaves the invoices unbilled while it is paused, which is what a paused plan means here.
        const paused = await api<Json>(
          account,
          `/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`,
          {
            body: {
              pause_collection: {
                behavior: 'void',
                ...(input.resumeAt
                  ? { resumes_at: Math.floor(Date.parse(input.resumeAt) / 1000) }
                  : {}),
              },
            },
          },
        );
        return subscriptionResult(paused);
      },
      async resume(account, input) {
        const resumed = await api<Json>(
          account,
          `/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`,
          { body: { pause_collection: '' } },
        );
        return subscriptionResult(resumed);
      },
      async cancel(account, input) {
        const path = `/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`;
        const done = input.atPeriodEnd
          ? await api<Json>(account, path, { body: { cancel_at_period_end: true } })
          : await api<Json>(account, path, { method: 'DELETE' });
        return subscriptionResult(done);
      },
      async get(account, input) {
        return subscriptionResult(
          await api<Json>(
            account,
            `/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`,
          ),
        );
      },
    },

    async fees(account, providerPaymentId): Promise<PaymentFees> {
      const i = await intent(account, providerPaymentId);
      const balance = obj(obj(i['latest_charge'])['balance_transaction']);
      return { feeCents: centsOf(balance['fee']), netCents: centsOf(balance['net']) };
    },

    webhooks: {
      /** The Connect endpoint's events, with the Connect endpoint's secret. */
      verify: (input: WebhookInput) => verifyStripeSignature(opts.webhookSecret, input),
      parse(rawBody) {
        let body: Json;
        try {
          body = obj(JSON.parse(rawBody));
        } catch {
          return null;
        }
        const id = str(body['id']);
        const type = str(body['type']);
        if (!id || !type) return null;
        return {
          id,
          type,
          // Connect events carry the account they happened in; ours are routed by it.
          accountRef: str(body['account']),
          createdAt: isoOf(body['created']),
          data: obj(obj(body['data'])['object']),
        } satisfies PaymentEvent;
      },
    },
  };
}
