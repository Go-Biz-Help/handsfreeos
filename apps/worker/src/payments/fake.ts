/**
 * The stand-in payment provider: local development, tests and every Playwright spec in M9 take money through
 * this. It stands in for **both** Stripe and Square at once, so one business can hold a connection to each and
 * both flows are really exercised — Stripe's confirm-in-the-browser and Square's tokenise-then-charge.
 *
 * What it gives the rest of the milestone (this list is a public interface; specs are written against it):
 * - **Its own payment page**, served by the worker (`payments/fake-routes.ts`), the way a provider's hosted page
 *   or SDK is. `prepare()` hands back its URL.
 * - **Test cards.** `FAKE_CARDS.succeeds` goes through. `FAKE_CARDS.declines` is refused there and then, as an
 *   answer and not an event. `FAKE_CARDS.failsOffSession` saves fine and is refused the next time a plan bills
 *   it. `FAKE_CARDS.disputes` goes through and can then be disputed.
 * - **A bank transfer** (`FAKE_BANK.settles`) that answers `processing` and settles later — after
 *   `settleMs`, or the moment a spec asks (`settle()`), which is how the specs do it.
 * - **Refunds, disputes and subscription cycles** on demand.
 * - **Properly signed webhooks** posted back to our own endpoints with the real algorithms — Stripe's
 *   `t=…,v1=<hex HMAC over "t.body">` and Square's base64 HMAC over URL plus body — so the verifier that reads
 *   them is under test too, not just the happy path.
 * - **A list of everything it took** (`charges()`, `refunds()`, `subscriptions()`, `webhooks()`), the way the
 *   fake carrier keeps `sent`.
 *
 * Nothing here looks like a secret: tokens say they are fake and name the account.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  centsOf,
  cleanMetadata,
  cardBrandLabel,
  cardLast4,
  declineWording,
  hmacBase64,
  hmacHex,
  PaymentAuthError,
  PaymentError,
  PlatformUnsupportedError,
  requireAmount,
  type ChargeInput,
  type ConnectedAccount,
  type PaymentAccount,
  type PaymentCapabilities,
  type PaymentEnvironment,
  type PaymentFlow,
  type PaymentMethodKind,
  type PaymentProvider,
  type PaymentProviderName,
  type PaymentResult,
  type PaymentState,
  type PaymentTokens,
  type PreparedPayment,
  type RefundResult,
  type SavedMethod,
  type SubscriptionResult,
  type SubscriptionState,
} from './provider';

/** Not secrets: the stand-in signs with these and the verifier checks with the same ones. */
export const FAKE_STRIPE_WEBHOOK_SECRET = 'whsec_local_development_only';
export const FAKE_SQUARE_SIGNATURE_KEY = 'local-square-webhook-signature-key';
export const FAKE_STRIPE_PUBLISHABLE_KEY = 'pk_test_local_development_only';
export const FAKE_SQUARE_APPLICATION_ID = 'sandbox-sq0idb-local-development';

/**
 * The cards the specs type. They behave the same whichever provider is standing in, so one spec covers both.
 */
export const FAKE_CARDS = {
  /** Goes through. */
  succeeds: '4242424242424242',
  /** Refused by the card, there and then — the answer comes back from the call, never as a webhook. */
  declines: '4000000000000002',
  /** Saves fine, and is refused the next time something bills it without the customer there (a plan's cycle). */
  failsOffSession: '4000000000000341',
  /** Goes through, and can then be disputed (`dispute()`). */
  disputes: '4000000000000259',
} as const;

/** Bank accounts the specs type. A transfer is never instant: it answers `processing` and settles later. */
export const FAKE_BANK = {
  /** Settles after the delay, or the moment a spec asks. */
  settles: '000123456789',
  /** The bank sends it back days later (`failTransfer()` does it on demand). */
  fails: '000111111116',
} as const;

/** What the stand-in keeps: 2.9% + 30¢ on a card, 0.8% capped at $5 on a bank transfer. */
const feeFor = (amountCents: number, method: PaymentMethodKind): number =>
  method === 'ach'
    ? Math.min(500, Math.round(amountCents * 0.008))
    : Math.round(amountCents * 0.029) + 30;

export interface FakeCharge {
  readonly id: string;
  readonly provider: PaymentProviderName;
  readonly accountId: string;
  readonly amountCents: number;
  /** What it was finally paid with; the page can still choose between a card and a bank transfer. */
  method: PaymentMethodKind;
  status: PaymentState;
  providerStatus: string;
  failureCode: string | null;
  feeCents: number | null;
  netCents: number | null;
  receivedAt: string | null;
  capturable: boolean;
  refundedCents: number;
  disputed: boolean;
  readonly customerRef: string | null;
  readonly idempotencyKey: string;
  readonly description: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  /** The last four of whatever was typed, so a spec can tell one charge from another. */
  instrument: string;
  /** The brand the number says it is, worked out while the whole number was still in hand. */
  cardBrand: string | null;
  /** Stripe's flow: what the browser confirms with. Null for the Square stand-in. */
  readonly clientSecret: string | null;
  readonly createdAt: string;
}

export interface FakeRefund {
  readonly id: string;
  readonly paymentId: string;
  readonly amountCents: number;
  status: 'pending' | 'succeeded' | 'failed';
  readonly createdAt: string;
}

export interface FakeSubscription {
  readonly id: string;
  readonly provider: PaymentProviderName;
  readonly accountId: string;
  readonly customerRef: string;
  readonly methodToken: string | null;
  readonly amountCents: number;
  readonly interval: 'month' | 'year';
  readonly intervalCount: number;
  readonly name: string;
  status: SubscriptionState;
  cycles: number;
  periodStart: string;
  periodEnd: string;
  cancelAt: string | null;
}

/** One webhook the stand-in posted back to us, kept so a spec can assert on it or replay it. */
export interface FakeWebhookPost {
  readonly provider: PaymentProviderName;
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly eventId: string;
  readonly type: string;
  /** Whether our own endpoint took it (false while step 5's routes don't exist yet). */
  ok: boolean | null;
}

/** How a webhook reaches us. Tests hand in one that injects into the Fastify app instead of using the network. */
export type WebhookDeliver = (post: FakeWebhookPost) => Promise<{ ok: boolean }>;

export interface FakePayments {
  readonly providers: Record<PaymentProviderName, PaymentProvider>;
  /** Every payment the stand-in took **for a business**, oldest first. */
  charges(): readonly FakeCharge[];
  /** Every payment the stand-in took **for HandsFreeOS**: the usage wallet's top-ups, and nothing else. */
  platformCharges(): readonly FakeCharge[];
  charge(providerPaymentId: string): FakeCharge | null;
  refunds(): readonly FakeRefund[];
  subscriptions(): readonly FakeSubscription[];
  webhooks(): readonly FakeWebhookPost[];
  /** A bank transfer settles now instead of after its delay. */
  settle(providerPaymentId: string): Promise<FakeCharge | null>;
  /** The bank sends a transfer back days later. */
  failTransfer(providerPaymentId: string, code?: string): Promise<FakeCharge | null>;
  /** The customer's bank takes the money back. */
  dispute(providerPaymentId: string, reason?: string): Promise<FakeCharge | null>;
  /** The plan bills its next cycle: a new charge, and the event that says so. */
  cycle(providerSubscriptionId: string): Promise<FakeCharge | null>;
  /** The seller revoked us at the provider (Square's revoke, Stripe's deauthorize). */
  revoke(externalAccountId: string): Promise<void>;
  /** Stripe refuses to attach: this account is controlled by another platform. */
  holdAccount(externalAccountId: string): void;
  /** Where webhooks go; tests set one that injects into the server. */
  setDeliver(deliver: WebhookDeliver): void;
  /** The hosted page reads and drives these (payments/fake-routes.ts). */
  readonly page: FakePageApi;
  /** The signing the verifier is checked against; a spec can forge or replay with them. */
  signStripe(body: string, at?: number): Record<string, string>;
  signSquare(url: string, body: string): Record<string, string>;
}

/** What the stand-in's own payment page is allowed to do. Nothing here touches the database. */
export interface FakePageApi {
  /** The intent the page was opened for (Stripe's flow), or null. */
  intent(providerPaymentId: string): FakeCharge | null;
  /** A token for what the customer typed, exactly as a browser SDK would mint one. */
  tokenise(input: { instrument: string; method: PaymentMethodKind }): string;
  /** The browser confirmed the intent (Stripe's flow). */
  confirm(input: {
    providerPaymentId: string;
    instrument: string;
    method: PaymentMethodKind;
  }): Promise<FakeCharge | null>;
}

const enc = (s: string) => Buffer.from(s).toString('base64url');
const dec = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
const digits = (value: string) => value.replace(/\D+/g, '');
const last4 = (value: string) => digits(value).slice(-4) || '0000';
const DAY = 86_400_000;

/** What a token carries: the stand-in has no vault, so the instrument travels inside it. */
interface FakeToken {
  readonly instrument: string;
  readonly method: PaymentMethodKind;
  /** A saved card: charging it is off-session, which is where `failsOffSession` fails. */
  readonly saved: boolean;
}

const mintToken = (t: FakeToken): string =>
  `${t.saved ? 'fakepm' : 'cnon'}:${enc(JSON.stringify(t))}`;

function readToken(token: string): FakeToken {
  const [prefix, body] = token.split(':');
  if ((prefix !== 'cnon' && prefix !== 'fakepm') || !body)
    throw new PaymentError('That isn’t a payment token from this server.', 402, true);
  const t = JSON.parse(dec(body)) as FakeToken;
  return { ...t, saved: prefix === 'fakepm' };
}

/** The sign-in's code: which account, and anything the stand-in page was asked to pretend. */
export interface FakePaymentGrant {
  readonly provider: PaymentProviderName;
  readonly accountId: string;
  readonly displayName: string;
  /** The seller left a permission unticked. */
  readonly partialScopes: boolean;
}

export const fakePaymentCode = (grant: FakePaymentGrant): string =>
  `fakepay.${enc(JSON.stringify(grant))}`;

/**
 * The "account" a charge of ours is recorded under: **no account at all**. The real difference at Stripe is a
 * missing `stripe-account` header, which a stand-in has no way to represent; an empty account id is the
 * closest honest thing, and it is what makes "ours" and "a business's" tellable apart in the charge list.
 */
const PLATFORM_ACCOUNT: PaymentAccount = {
  provider: 'stripe',
  externalAccountId: '',
  locationId: null,
  accessToken: null,
  environment: 'test',
};

/** Only Stripe can take money for us; Square acts only as a seller, so it has no way to. */
function requirePlatform(provider: PaymentProviderName): void {
  if (provider !== 'stripe') throw new PlatformUnsupportedError(provider);
}

function readGrant(code: string, provider: PaymentProviderName): FakePaymentGrant {
  const [prefix, body] = code.split('.');
  if (prefix !== 'fakepay' || !body)
    throw new PaymentAuthError('That sign-in code is not one of ours.', 'invalid_grant');
  const grant = JSON.parse(dec(body)) as FakePaymentGrant;
  if (grant.provider !== provider)
    throw new PaymentAuthError('That sign-in code is for another provider.', 'invalid_grant');
  return grant;
}

const ALL: PaymentCapabilities = {
  card: true,
  bankTransfer: true,
  subscriptions: true,
  refunds: true,
  savedMethods: true,
  holds: true,
  flow: 'client_confirm',
};

export function createFakePayments(opts: {
  publicUrl: string;
  /**
   * How long a bank transfer takes to settle. 0 (the default, and what tests use) means it never settles on its
   * own: a spec calls `settle()` or the test route does. Local development sets a few seconds so it feels real.
   */
  settleMs?: number;
  log?: Logger;
  deliver?: WebhookDeliver;
}): FakePayments {
  const charges = new Map<string, FakeCharge>();
  const refundRows: FakeRefund[] = [];
  const subs = new Map<string, FakeSubscription>();
  const posts: FakeWebhookPost[] = [];
  const revoked = new Set<string>();
  const held = new Set<string>();
  const customers = new Map<string, { name: string | null; cards: SavedMethod[] }>();
  const settleMs = Math.max(0, opts.settleMs ?? 0);
  let seq = 0;
  let deliver: WebhookDeliver =
    opts.deliver ??
    (async (post) => {
      const res = await fetch(post.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...post.headers },
        body: post.body,
      });
      return { ok: res.ok };
    });

  const now = () => new Date().toISOString();
  const nextId = (prefix: string) =>
    `${prefix}_${(++seq).toString().padStart(4, '0')}_${randomUUID().slice(0, 8)}`;

  const signStripe = (body: string, at = Date.now()): Record<string, string> => {
    const t = Math.floor(at / 1000);
    return {
      'stripe-signature': `t=${t},v1=${hmacHex(FAKE_STRIPE_WEBHOOK_SECRET, `${t}.${body}`)}`,
    };
  };
  const signSquare = (url: string, body: string): Record<string, string> => ({
    'x-square-hmacsha256-signature': hmacBase64(FAKE_SQUARE_SIGNATURE_KEY, `${url}${body}`),
  });

  /** Posts a signed event at our own webhook endpoint, exactly as the real provider would. */
  async function send(
    provider: PaymentProviderName,
    type: string,
    accountId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const url = `${opts.publicUrl}/webhooks/${provider}`;
    const eventId = provider === 'stripe' ? nextId('evt') : randomUUID();
    const body =
      provider === 'stripe'
        ? JSON.stringify({
            id: eventId,
            object: 'event',
            type,
            account: accountId,
            created: Math.floor(Date.now() / 1000),
            data: { object: data },
          })
        : JSON.stringify({
            event_id: eventId,
            merchant_id: accountId,
            type,
            created_at: now(),
            data: { type: type.split('.')[0], id: String(data['id'] ?? ''), object: data },
          });
    const headers = provider === 'stripe' ? signStripe(body) : signSquare(url, body);
    const post: FakeWebhookPost = { provider, url, body, headers, eventId, type, ok: null };
    posts.push(post);
    try {
      post.ok = (await deliver(post)).ok;
    } catch (e) {
      post.ok = false;
      opts.log?.debug({ err: e, type }, 'the stand-in payment webhook was not taken');
    }
  }

  /** The event a provider sends when a payment lands or moves on. */
  const paymentEvent = (c: FakeCharge): { type: string; data: Record<string, unknown> } =>
    c.provider === 'stripe'
      ? {
          type:
            c.status === 'succeeded'
              ? 'payment_intent.succeeded'
              : c.status === 'processing'
                ? 'payment_intent.processing'
                : 'payment_intent.payment_failed',
          data: {
            id: c.id,
            object: 'payment_intent',
            amount: c.amountCents,
            currency: 'usd',
            status: c.providerStatus,
            metadata: c.metadata,
          },
        }
      : {
          // Square has no "payment failed" event at all, so a decline never becomes one here either.
          type: c.status === 'succeeded' ? 'payment.updated' : 'payment.created',
          data: {
            id: c.id,
            status: c.providerStatus,
            amount_money: { amount: c.amountCents, currency: 'USD' },
            reference_id: c.metadata['invoiceId'] ?? null,
          },
        };

  /**
   * What the stand-in calls a card, from its first digit — the same rule the card networks use, so the specs see
   * real-looking brands ("Visa", "Mastercard") without anybody hard-coding one per test number.
   */
  function fakeCardBrand(instrument: string): string | null {
    const value = digits(instrument);
    if (!value) return null;
    if (value.startsWith('4')) return 'visa';
    if (/^5[1-5]/.test(value) || /^2[2-7]/.test(value)) return 'mastercard';
    if (/^3[47]/.test(value)) return 'amex';
    if (value.startsWith('6')) return 'discover';
    return null;
  }

  /** How a card or a bank account behaves when it is charged. */
  function outcome(
    instrument: string,
    method: PaymentMethodKind,
    offSession: boolean,
  ): { status: PaymentState; failureCode: string | null } {
    const value = digits(instrument);
    // A bank transfer is never instant, and never refused on the spot: it sits in `processing` for days,
    // and only then does the bank say yes or send it back (settle() / failTransfer()).
    if (method === 'ach') return { status: 'processing', failureCode: null };
    if (value === digits(FAKE_CARDS.declines))
      return { status: 'failed', failureCode: 'card_declined' };
    if (value === digits(FAKE_CARDS.failsOffSession) && offSession)
      return { status: 'failed', failureCode: 'card_declined' };
    if (value.length < 12) return { status: 'failed', failureCode: 'incorrect_number' };
    return { status: 'succeeded', failureCode: null };
  }

  const providerStatusOf = (
    provider: PaymentProviderName,
    status: PaymentState,
    capturable: boolean,
  ): string => {
    if (provider === 'stripe')
      return status === 'succeeded'
        ? 'succeeded'
        : status === 'processing'
          ? capturable
            ? 'requires_capture'
            : 'processing'
          : status === 'failed'
            ? 'canceled'
            : 'requires_payment_method';
    return status === 'succeeded'
      ? 'COMPLETED'
      : status === 'processing'
        ? capturable
          ? 'APPROVED'
          : 'PENDING'
        : status === 'failed'
          ? 'FAILED'
          : 'PENDING';
  };

  function resultOf(c: FakeCharge): PaymentResult {
    return {
      providerPaymentId: c.id,
      status: c.status,
      providerStatus: c.providerStatus,
      amountCents: c.amountCents,
      failureCode: c.failureCode,
      failureMessage: c.failureCode ? declineWording(c.failureCode) : null,
      feeCents: c.feeCents,
      netCents: c.netCents,
      receivedAt: c.receivedAt,
      capturable: c.capturable,
      // The stand-in knows what was typed, so it answers the way a real provider does: the brand it can work
      // out from the number, the last four, and neither for a bank transfer.
      cardBrand: c.method === 'card' ? c.cardBrand : null,
      cardLast4: c.method === 'card' ? cardLast4(c.instrument) : null,
    };
  }

  /** Books the payment where it landed, and tells us about it the way the provider would. */
  async function land(c: FakeCharge, status: PaymentState, failureCode: string | null = null) {
    c.status = status;
    c.failureCode = failureCode;
    c.capturable = c.capturable && status === 'processing';
    c.providerStatus = providerStatusOf(c.provider, status, c.capturable);
    if (status === 'succeeded') {
      c.receivedAt = now();
      c.feeCents = feeFor(c.amountCents, c.method);
      c.netCents = c.amountCents - c.feeCents;
    }
    // A decline is the call's own answer. Every other move is something we only learn from a webhook.
    if (status !== 'failed' || c.method === 'ach') {
      const e = paymentEvent(c);
      await send(c.provider, e.type, c.accountId, e.data);
    }
    return c;
  }

  function guard(account: PaymentAccount): void {
    if (revoked.has(account.externalAccountId))
      throw new PaymentAuthError(
        `The sign-in for ${account.externalAccountId} was revoked.`,
        'invalid_grant',
      );
  }

  function record(
    account: PaymentAccount,
    input: {
      amountCents: number;
      method: PaymentMethodKind;
      instrument: string;
      idempotencyKey: string;
      description: string | null;
      customerRef: string | null;
      metadata: Readonly<Record<string, string>>;
      hold: boolean;
      clientSecret?: string | null;
    },
  ): FakeCharge {
    // One key, one charge: a double-clicked button gets the payment it already made.
    const already = [...charges.values()].find(
      (c) => c.accountId === account.externalAccountId && c.idempotencyKey === input.idempotencyKey,
    );
    if (already) return already;
    const id = nextId(account.provider === 'stripe' ? 'pi' : 'sqpay');
    const c: FakeCharge = {
      id,
      provider: account.provider,
      accountId: account.externalAccountId,
      amountCents: requireAmount(input.amountCents),
      method: input.method,
      status: 'requires_payment',
      providerStatus: providerStatusOf(account.provider, 'requires_payment', false),
      failureCode: null,
      feeCents: null,
      netCents: null,
      receivedAt: null,
      capturable: input.hold,
      refundedCents: 0,
      disputed: false,
      customerRef: input.customerRef,
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      metadata: cleanMetadata(input.metadata),
      instrument: last4(input.instrument),
      cardBrand: cardBrandLabel(fakeCardBrand(input.instrument)),
      clientSecret: input.clientSecret ?? null,
      createdAt: now(),
    };
    charges.set(id, c);
    return c;
  }

  /** A bank transfer left to settle on its own (local development; tests do it on demand instead). */
  function settleLater(c: FakeCharge): void {
    if (settleMs <= 0) return;
    const timer = setTimeout(() => {
      void (digits(c.instrument) === last4(FAKE_BANK.fails)
        ? land(c, 'failed', 'bank_transfer_returned')
        : land(c, 'succeeded'));
    }, settleMs);
    timer.unref();
  }

  const tokens = (grant: FakePaymentGrant, environment: PaymentEnvironment): PaymentTokens => ({
    accessToken: grant.provider === 'square' ? `fake-square-token.${enc(grant.accountId)}` : null,
    refreshToken: `fake-${grant.provider}-refresh.${enc(grant.accountId)}`,
    // Square's 30 days, so the refresh job has something real to renew; Stripe's never lapses.
    expiresAt: grant.provider === 'square' ? new Date(Date.now() + 30 * DAY).toISOString() : null,
    scopes: grant.partialScopes ? ['MERCHANT_PROFILE_READ'] : ['read_write', 'PAYMENTS_WRITE'],
    externalAccountId: grant.accountId,
    environment,
  });

  function provider(name: PaymentProviderName): PaymentProvider {
    const flow: PaymentFlow = name === 'stripe' ? 'client_confirm' : 'server_charge';
    const capabilities: PaymentCapabilities = { ...ALL, flow };
    const publishableKey =
      name === 'stripe' ? FAKE_STRIPE_PUBLISHABLE_KEY : FAKE_SQUARE_APPLICATION_ID;

    return {
      name,
      configured: true,
      flow,
      publishableKey,

      authorizeUrl({ state, redirectUri }) {
        const q = new URLSearchParams({ state, redirect_uri: redirectUri });
        return `${opts.publicUrl}/oauth/fake/payments/${name}/authorize?${q}`;
      },

      async exchangeCode({ code }) {
        const grant = readGrant(code, name);
        if (held.has(grant.accountId))
          throw new PaymentAuthError(
            'This account is controlled by another platform, so it can’t be connected here.',
            'account_controlled_by_another_platform',
          );
        revoked.delete(grant.accountId);
        return tokens(grant, grant.accountId.includes('test') ? 'test' : 'live');
      },

      async refreshTokens(current) {
        if (revoked.has(current.externalAccountId))
          throw new PaymentAuthError('The sign-in was revoked.', 'invalid_grant');
        if (name === 'stripe') return current;
        return {
          ...current,
          accessToken: `fake-square-token.${enc(current.externalAccountId)}.${randomUUID().slice(0, 6)}`,
          expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
        };
      },

      async describe(t) {
        if (revoked.has(t.externalAccountId))
          throw new PaymentAuthError('The sign-in was revoked.', 'invalid_grant');
        const partial = t.scopes.length === 1;
        return {
          externalAccountId: t.externalAccountId,
          displayName: `${name === 'stripe' ? 'Stripe' : 'Square'} · ${t.externalAccountId}`,
          locationId: name === 'square' ? `fake-location-${t.externalAccountId}` : null,
          capabilities,
          missingScopes: partial ? ['PAYMENTS_WRITE'] : [],
        } satisfies ConnectedAccount;
      },

      async revokeAccess(account) {
        revoked.add(account.externalAccountId);
      },

      async capabilities(account) {
        guard(account);
        return capabilities;
      },

      async prepare(account, input) {
        guard(account);
        const amount = requireAmount(input.amountCents);
        const back = new URL(`${opts.publicUrl}/payments/fake/pay`);
        back.searchParams.set('provider', name);
        back.searchParams.set('account', account.externalAccountId);
        back.searchParams.set('amount', String(amount));
        if (input.returnUrl) back.searchParams.set('return', input.returnUrl);
        if (input.methods.length) back.searchParams.set('methods', input.methods.join(','));
        // Stripe's flow makes the intent up front; Square's page only tokenises and hands the token back.
        if (flow === 'client_confirm') {
          const c = record(account, {
            amountCents: amount,
            method: input.methods[0] ?? 'card',
            instrument: '',
            idempotencyKey: input.idempotencyKey,
            description: input.description,
            customerRef: input.customerRef,
            metadata: input.metadata,
            hold: input.hold,
            clientSecret: `${nextId('cs')}_secret`,
          });
          back.searchParams.set('intent', c.id);
          return {
            flow,
            publishableKey,
            accountId: account.externalAccountId,
            locationId: account.locationId,
            clientSecret: c.clientSecret,
            providerPaymentId: c.id,
            methods: input.methods,
            amountCents: amount,
            hostedUrl: back.toString(),
          } satisfies PreparedPayment;
        }
        return {
          flow,
          publishableKey,
          accountId: account.externalAccountId,
          locationId: account.locationId,
          clientSecret: null,
          providerPaymentId: null,
          methods: input.methods,
          amountCents: amount,
          hostedUrl: back.toString(),
        } satisfies PreparedPayment;
      },

      async confirmFromClient(account, providerPaymentId) {
        guard(account);
        const c = charges.get(providerPaymentId);
        if (!c) throw new PaymentError('No payment with that id.', 404, true);
        return resultOf(c);
      },

      async charge(account, input: ChargeInput) {
        guard(account);
        const amount = requireAmount(input.amountCents);
        if (!input.sourceToken)
          throw new PaymentError('There is nothing to take the payment from.', null, true);
        const t = readToken(input.sourceToken);
        const c = record(account, {
          amountCents: amount,
          method: t.method,
          instrument: t.instrument,
          idempotencyKey: input.idempotencyKey,
          description: input.description,
          customerRef: input.customerRef,
          metadata: input.metadata,
          hold: false,
        });
        // The same key twice is the same payment, answered again rather than charged again.
        if (c.status !== 'requires_payment') return resultOf(c);
        const answer = outcome(t.instrument, t.method, t.saved);
        await land(c, answer.status, answer.failureCode);
        if (answer.status === 'processing' && t.method === 'ach') settleLater(c);
        return resultOf(c);
      },

      async authorize(account, input) {
        guard(account);
        const amount = requireAmount(input.amountCents);
        if (!input.sourceToken)
          throw new PaymentError('There is nothing to hold the payment on.', null, true);
        const t = readToken(input.sourceToken);
        if (t.method === 'ach')
          throw new PaymentError('A bank transfer can’t be held.', null, true);
        const c = record(account, {
          amountCents: amount,
          method: 'card',
          instrument: t.instrument,
          idempotencyKey: input.idempotencyKey,
          description: input.description,
          customerRef: input.customerRef,
          metadata: input.metadata,
          hold: true,
        });
        if (c.status !== 'requires_payment') return resultOf(c);
        const answer = outcome(t.instrument, 'card', t.saved);
        // A held card is `processing` with the provider's own word beside it, never `succeeded`.
        await land(
          c,
          answer.status === 'succeeded' ? 'processing' : answer.status,
          answer.failureCode,
        );
        return resultOf(c);
      },

      async capture(account, input) {
        guard(account);
        const c = charges.get(input.providerPaymentId);
        if (!c) throw new PaymentError('No payment with that id.', 404, true);
        if (!c.capturable) return resultOf(c);
        c.capturable = false;
        await land(c, 'succeeded');
        return resultOf(c);
      },

      async voidAuthorization(account, input) {
        guard(account);
        const c = charges.get(input.providerPaymentId);
        if (!c) throw new PaymentError('No payment with that id.', 404, true);
        c.capturable = false;
        await land(c, 'failed', null);
        c.failureCode = null;
        c.providerStatus = name === 'stripe' ? 'canceled' : 'CANCELED';
        return resultOf(c);
      },

      async refund(account, input) {
        guard(account);
        const c = charges.get(input.providerPaymentId);
        if (!c) throw new PaymentError('No payment with that id.', 404, true);
        if (c.status !== 'succeeded')
          throw new PaymentError('Only a payment that went through can be refunded.', 400, true);
        const amount = requireAmount(input.amountCents);
        if (c.refundedCents + amount > c.amountCents)
          throw new PaymentError('That is more than is left on the payment.', 400, true);
        const already = refundRows.find((r) => r.id === `re_${input.idempotencyKey}`);
        if (already)
          return {
            providerRefundId: already.id,
            status: already.status,
            providerStatus: already.status,
            amountCents: already.amountCents,
            failureCode: null,
            failureMessage: null,
          };
        c.refundedCents += amount;
        const row: FakeRefund = {
          id: `re_${input.idempotencyKey}`,
          paymentId: c.id,
          amountCents: amount,
          status: 'succeeded',
          createdAt: now(),
        };
        refundRows.push(row);
        await send(
          name,
          name === 'stripe' ? 'charge.refunded' : 'refund.updated',
          c.accountId,
          name === 'stripe'
            ? { id: row.id, object: 'refund', payment_intent: c.id, amount, status: 'succeeded' }
            : {
                id: row.id,
                payment_id: c.id,
                status: 'COMPLETED',
                amount_money: { amount, currency: 'USD' },
              },
        );
        return {
          providerRefundId: row.id,
          status: 'succeeded',
          providerStatus: 'succeeded',
          amountCents: amount,
          failureCode: null,
          failureMessage: null,
        } satisfies RefundResult;
      },

      async ensureCustomer(account, input) {
        guard(account);
        if (input.customerRef) return { customerRef: input.customerRef };
        const ref = nextId(name === 'stripe' ? 'cus' : 'sqcust');
        customers.set(ref, { name: input.name, cards: [] });
        return { customerRef: ref };
      },

      async saveMethod(account, input) {
        guard(account);
        const t = readToken(input.sourceToken);
        /**
         * Saving a card is where a bad one is refused, exactly as it is at both real providers: Stripe refuses
         * the attach and Square runs its own verification. The card that fails only when nobody is watching
         * (`failsOffSession`) saves fine here — that is the whole point of it.
         */
        const answer = outcome(t.instrument, t.method, false);
        if (answer.status === 'failed')
          throw new PaymentError(
            declineWording(answer.failureCode),
            402,
            true,
            null,
            answer.failureCode ?? 'card_declined',
          );
        const saved: SavedMethod = {
          token: mintToken({ ...t, saved: true }),
          kind: t.method,
          brand: t.method === 'ach' ? 'Test Bank' : 'Visa',
          last4: last4(t.instrument),
          expiryMonth: t.method === 'ach' ? null : 12,
          expiryYear: t.method === 'ach' ? null : new Date().getUTCFullYear() + 2,
        };
        const c = customers.get(input.customerRef) ?? { name: null, cards: [] };
        c.cards = [...c.cards.filter((x) => x.last4 !== saved.last4), saved];
        customers.set(input.customerRef, c);
        return saved;
      },

      async listMethods(account, customerRef) {
        guard(account);
        return [...(customers.get(customerRef)?.cards ?? [])];
      },

      async forgetMethod(account, input) {
        guard(account);
        const c = customers.get(input.customerRef);
        if (c) c.cards = c.cards.filter((x) => x.token !== input.token);
      },

      /**
       * HandsFreeOS's own charges. `accountId` is **the empty string** here rather than a business's account,
       * which is what the stand-in has instead of a missing Stripe header — and what `platformCharges()` and
       * the test read to prove a top-up never lands in a business's account, nor a customer's payment in ours.
       */
      platform: {
        supported: name === 'stripe',

        async ensureCustomer(input) {
          requirePlatform(name);
          if (input.customerRef) return { customerRef: input.customerRef };
          const ref = nextId('cus_hfos');
          customers.set(ref, { name: input.name, cards: [] });
          return { customerRef: ref };
        },

        async saveMethod(input) {
          requirePlatform(name);
          const t = readToken(input.sourceToken);
          const answer = outcome(t.instrument, t.method, false);
          if (answer.status === 'failed')
            throw new PaymentError(
              declineWording(answer.failureCode),
              402,
              true,
              null,
              answer.failureCode ?? 'card_declined',
            );
          const saved: SavedMethod = {
            token: mintToken({ ...t, saved: true }),
            kind: t.method,
            brand: t.method === 'ach' ? 'Test Bank' : 'Visa',
            last4: last4(t.instrument),
            expiryMonth: t.method === 'ach' ? null : 12,
            expiryYear: t.method === 'ach' ? null : new Date().getUTCFullYear() + 2,
          };
          const c = customers.get(input.customerRef) ?? { name: null, cards: [] };
          c.cards = [...c.cards.filter((x) => x.last4 !== saved.last4), saved];
          customers.set(input.customerRef, c);
          return saved;
        },

        async forgetMethod(input) {
          requirePlatform(name);
          const c = customers.get(input.customerRef);
          if (c) c.cards = c.cards.filter((x) => x.token !== input.token);
        },

        async charge(input: ChargeInput) {
          requirePlatform(name);
          const amount = requireAmount(input.amountCents);
          if (!input.sourceToken)
            throw new PaymentError('There is no card on the wallet to charge.', null, true);
          const t = readToken(input.sourceToken);
          const c = record(PLATFORM_ACCOUNT, {
            amountCents: amount,
            method: t.method,
            instrument: t.instrument,
            idempotencyKey: input.idempotencyKey,
            description: input.description,
            customerRef: input.customerRef,
            metadata: input.metadata,
            hold: false,
          });
          if (c.status !== 'requires_payment') return resultOf(c);
          const answer = outcome(t.instrument, t.method, t.saved);
          await land(c, answer.status, answer.failureCode);
          return resultOf(c);
        },
      },

      subscriptions: {
        async create(account, input) {
          guard(account);
          const start = input.startAt ? new Date(input.startAt) : new Date();
          const id = nextId(name === 'stripe' ? 'sub' : 'sqsub');
          const row: FakeSubscription = {
            id,
            provider: name,
            accountId: account.externalAccountId,
            customerRef: input.customerRef,
            methodToken: input.methodToken,
            amountCents: requireAmount(input.amountCents),
            interval: input.interval,
            intervalCount: Math.max(1, Math.trunc(input.intervalCount)),
            name: input.name,
            status: 'active',
            cycles: 0,
            periodStart: start.toISOString(),
            periodEnd: nextPeriodEnd(start, input.interval, input.intervalCount),
            cancelAt: null,
          };
          subs.set(id, row);
          await send(
            name,
            name === 'stripe' ? 'customer.subscription.created' : 'subscription.created',
            account.externalAccountId,
            { id, object: 'subscription', status: 'active' },
          );
          return subscriptionOf(row);
        },
        async pause(account, input) {
          guard(account);
          const row = subs.get(input.providerSubscriptionId);
          if (!row) throw new PaymentError('No plan with that id.', 404, true);
          row.status = 'paused';
          return subscriptionOf(row);
        },
        async resume(account, input) {
          guard(account);
          const row = subs.get(input.providerSubscriptionId);
          if (!row) throw new PaymentError('No plan with that id.', 404, true);
          row.status = 'active';
          return subscriptionOf(row);
        },
        async cancel(account, input) {
          guard(account);
          const row = subs.get(input.providerSubscriptionId);
          if (!row) throw new PaymentError('No plan with that id.', 404, true);
          row.status = 'cancelled';
          row.cancelAt = input.atPeriodEnd ? row.periodEnd : now();
          await send(
            name,
            name === 'stripe' ? 'customer.subscription.deleted' : 'subscription.updated',
            account.externalAccountId,
            { id: row.id, object: 'subscription', status: 'canceled' },
          );
          return subscriptionOf(row);
        },
        async get(account, input) {
          guard(account);
          const row = subs.get(input.providerSubscriptionId);
          if (!row) throw new PaymentError('No plan with that id.', 404, true);
          return subscriptionOf(row);
        },
      },

      async fees(account, providerPaymentId) {
        guard(account);
        const c = charges.get(providerPaymentId);
        return { feeCents: c?.feeCents ?? null, netCents: c?.netCents ?? null };
      },

      webhooks: {
        verify({ rawBody, headers, url }) {
          if (name === 'stripe') {
            const header = headers['stripe-signature'];
            if (!header) return false;
            const t = Number(/(?:^|,)t=([^,]+)/.exec(header)?.[1]);
            if (!Number.isFinite(t) || Math.abs(Date.now() - t * 1000) > 5 * 60_000) return false;
            const expected = hmacHex(FAKE_STRIPE_WEBHOOK_SECRET, `${t}.${rawBody}`);
            return header.includes(`v1=${expected}`);
          }
          const given = headers['x-square-hmacsha256-signature'];
          return !!given && given === hmacBase64(FAKE_SQUARE_SIGNATURE_KEY, `${url}${rawBody}`);
        },
        parse(rawBody) {
          try {
            const body = JSON.parse(rawBody) as Record<string, unknown>;
            const id = String((name === 'stripe' ? body['id'] : body['event_id']) ?? '');
            const type = String(body['type'] ?? '');
            if (!id || !type) return null;
            const data = (body['data'] ?? {}) as Record<string, unknown>;
            return {
              id,
              type,
              accountRef:
                String((name === 'stripe' ? body['account'] : body['merchant_id']) ?? '') || null,
              createdAt: now(),
              data: (data['object'] ?? {}) as Record<string, unknown>,
            };
          } catch {
            return null;
          }
        },
      },
    };
  }

  const subscriptionOf = (row: FakeSubscription): SubscriptionResult => ({
    providerSubscriptionId: row.id,
    status: row.status,
    providerStatus: row.status,
    currentPeriodStart: row.periodStart,
    currentPeriodEnd: row.periodEnd,
    cancelAt: row.cancelAt,
  });

  function nextPeriodEnd(from: Date, interval: 'month' | 'year', count: number): string {
    const d = new Date(from);
    if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + Math.max(1, count));
    else d.setUTCMonth(d.getUTCMonth() + Math.max(1, count));
    return d.toISOString();
  }

  const stripe = provider('stripe');
  const square = provider('square');

  return {
    providers: { stripe, square },
    // Split by which "account" took it, which is the stand-in's stand-in for Stripe's account header: a
    // business's charges carry theirs, and ours carry none.
    charges: () => [...charges.values()].filter((c) => c.accountId !== ''),
    platformCharges: () => [...charges.values()].filter((c) => c.accountId === ''),
    charge: (id) => charges.get(id) ?? null,
    refunds: () => [...refundRows],
    subscriptions: () => [...subs.values()],
    webhooks: () => [...posts],

    async settle(providerPaymentId) {
      const c = charges.get(providerPaymentId);
      if (!c || c.status !== 'processing') return c ?? null;
      return land(c, 'succeeded');
    },

    async failTransfer(providerPaymentId, code = 'bank_transfer_returned') {
      const c = charges.get(providerPaymentId);
      if (!c || c.status !== 'processing') return c ?? null;
      return land(c, 'failed', code);
    },

    async dispute(providerPaymentId, reason = 'fraudulent') {
      const c = charges.get(providerPaymentId);
      if (!c) return null;
      c.disputed = true;
      await send(
        c.provider,
        c.provider === 'stripe' ? 'charge.dispute.created' : 'dispute.created',
        c.accountId,
        c.provider === 'stripe'
          ? {
              id: nextId('dp'),
              object: 'dispute',
              payment_intent: c.id,
              amount: c.amountCents,
              reason,
            }
          : {
              id: randomUUID(),
              payment_id: c.id,
              reason: reason.toUpperCase(),
              state: 'EVIDENCE_REQUIRED',
              amount_money: { amount: c.amountCents, currency: 'USD' },
            },
      );
      return c;
    },

    async cycle(providerSubscriptionId) {
      const row = subs.get(providerSubscriptionId);
      if (!row || row.status !== 'active') return null;
      const account: PaymentAccount = {
        provider: row.provider,
        externalAccountId: row.accountId,
        locationId: null,
        accessToken: null,
        environment: 'test',
      };
      row.cycles += 1;
      row.periodStart = row.periodEnd;
      row.periodEnd = nextPeriodEnd(new Date(row.periodEnd), row.interval, row.intervalCount);
      const token =
        row.methodToken ??
        mintToken({ instrument: FAKE_CARDS.succeeds, method: 'card', saved: true });
      const t = readToken(token);
      const c = record(account, {
        amountCents: row.amountCents,
        method: t.method,
        instrument: t.instrument,
        idempotencyKey: `${row.id}-cycle-${row.cycles}`,
        description: row.name,
        customerRef: row.customerRef,
        metadata: { subscriptionId: row.id, cycle: String(row.cycles) },
        hold: false,
      });
      // Billed while nobody is there: exactly where `failsOffSession` fails.
      const answer = outcome(t.instrument, t.method, true);
      await land(c, answer.status, answer.failureCode);
      if (answer.status === 'failed') row.status = 'past_due';
      await send(
        row.provider,
        row.provider === 'stripe'
          ? answer.status === 'failed'
            ? 'invoice.payment_failed'
            : 'invoice.paid'
          : 'subscription.updated',
        row.accountId,
        {
          id: `${row.id}-cycle-${row.cycles}`,
          object: 'invoice',
          subscription: row.id,
          payment_intent: c.id,
          amount_paid: answer.status === 'succeeded' ? row.amountCents : 0,
          status: row.status,
        },
      );
      return c;
    },

    async revoke(externalAccountId) {
      revoked.add(externalAccountId);
      const provider: PaymentProviderName = externalAccountId.startsWith('acct')
        ? 'stripe'
        : 'square';
      await send(
        provider,
        provider === 'stripe' ? 'account.application.deauthorized' : 'oauth.authorization.revoked',
        externalAccountId,
        { id: externalAccountId, object: 'application' },
      );
    },

    holdAccount(externalAccountId) {
      held.add(externalAccountId);
    },

    setDeliver(next) {
      deliver = next;
    },

    page: {
      intent: (id) => charges.get(id) ?? null,
      tokenise: ({ instrument, method }) => mintToken({ instrument, method, saved: false }),
      async confirm({ providerPaymentId, instrument, method }) {
        const c = charges.get(providerPaymentId);
        if (!c) return null;
        if (c.status !== 'requires_payment') return c;
        const answer = outcome(instrument, method, false);
        const settled =
          c.capturable && answer.status === 'succeeded' ? 'processing' : answer.status;
        // The page can only pay what the intent was made for; it never changes the amount.
        c.method = method;
        c.instrument = last4(instrument);
        c.cardBrand = cardBrandLabel(fakeCardBrand(instrument));
        await land(c, settled, answer.failureCode);
        if (settled === 'processing' && method === 'ach') settleLater(c);
        return c;
      },
    },

    signStripe,
    signSquare,
  };
}

/** What the stand-in page and the seed type, so nothing has to remember a number. */
export const fakeInstrumentLabel = (value: string): string =>
  digits(value) === digits(FAKE_CARDS.succeeds)
    ? 'a card that goes through'
    : digits(value) === digits(FAKE_CARDS.declines)
      ? 'a card that is declined'
      : digits(value) === digits(FAKE_CARDS.failsOffSession)
        ? 'a card that fails when a plan bills it'
        : digits(value) === digits(FAKE_CARDS.disputes)
          ? 'a card that can be disputed'
          : digits(value) === digits(FAKE_BANK.settles)
            ? 'a bank account that settles later'
            : 'a card';

/** Cents from what someone typed on the stand-in page. */
export const fakeAmount = (value: unknown): number => centsOf(value) ?? 0;
