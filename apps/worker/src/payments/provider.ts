/**
 * The accounts businesses take money into (Stripe and Square today; PayPal, NMI and Authorize.net on the same
 * seam later) behind one interface, so the sign-in routes, the customer's pay page, the webhook routes and the
 * jobs never name a provider. Hand-rolled `fetch`, no vendor SDK on the server, like every other provider here.
 *
 * Two things are deliberately not hidden:
 * - **`flow`.** Stripe confirms the payment in the browser (Payment Element, then we read the intent back);
 *   Square tokenises in the browser and charges from the server. One branch on our page is better than an
 *   abstraction that makes Stripe's bank transfers impossible.
 * - **A decline is a return value, not an event.** Every charge answers with a status, and a refusal comes back
 *   as `failed` with the provider's code. Webhooks only ever confirm what a call already told us — Square has no
 *   "payment failed" event at all, so a state machine waiting for one would hang.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The two that ship in M9. The database's enum has five; the other three arrive on this same seam. */
export type PaymentProviderName = 'stripe' | 'square';

export const PAYMENT_NAME: Record<PaymentProviderName, string> = {
  stripe: 'Stripe',
  square: 'Square',
};

export const isPaymentProvider = (p: string): p is PaymentProviderName =>
  p === 'stripe' || p === 'square';

/** Live money, or the test account a business connects so the first real payment isn't a client's. */
export type PaymentEnvironment = 'live' | 'test';

/** What the customer pays with. Cash and cheques never reach a provider. */
export type PaymentMethodKind = 'card' | 'ach';

/** Stripe confirms in the browser; Square tokenises there and we charge from here. */
export type PaymentFlow = 'client_confirm' | 'server_charge';

/**
 * Where a payment stands, in our words. Only ever forward: `processing` covers the days a bank transfer takes,
 * and `failed` is an answer the call gave us.
 */
export type PaymentState = 'requires_payment' | 'processing' | 'succeeded' | 'failed';

export type RefundState = 'pending' | 'succeeded' | 'failed';

export type SubscriptionState =
  'active' | 'paused' | 'past_due' | 'cancelled' | 'unmanaged' | 'pending';

/**
 * The connected account a call is made against, always the first argument. Stripe calls go out with our own
 * platform key and a `Stripe-Account` header; Square calls go out with the seller's own token, which is why it
 * has to be kept fresh.
 */
export interface PaymentAccount {
  readonly provider: PaymentProviderName;
  /** Stripe's `acct_…`, Square's merchant id. */
  readonly externalAccountId: string;
  /** Square only: the location money is taken at. */
  readonly locationId: string | null;
  /** The seller's token, opened from its seal. Null for Stripe, which uses our platform key. */
  readonly accessToken: string | null;
  readonly environment: PaymentEnvironment;
}

/** What an account can actually do, read at activation and again whenever the provider tells us it changed. */
export interface PaymentCapabilities {
  readonly card: boolean;
  /** Bank transfer (ACH) — the cheap rail we lead with. */
  readonly bankTransfer: boolean;
  readonly subscriptions: boolean;
  readonly refunds: boolean;
  readonly savedMethods: boolean;
  /** A card can be held now and captured later (a deposit at booking). */
  readonly holds: boolean;
  readonly flow: PaymentFlow;
  /**
   * The provider is waiting on the business for something — an identity document, a business detail, a bank
   * account — and will stop them taking money if it doesn't arrive. Read on the same call as everything else
   * above, and refreshed by the same `account.updated` webhook, so it is never more stale than the rest.
   *
   * We only ever *say* this; we never collect it. Every business here signs in with their own Stripe account
   * and keeps their own full dashboard, so the fix belongs where the requirement does. (Stripe's embedded
   * notification banner exists for accounts that have no dashboard to go to. Ours all do.)
   */
  readonly needsInfo: boolean;
  /** When the provider says it starts refusing, in unix seconds, where it named a date. */
  readonly needsInfoBy: number | null;
}

/** Nothing works until the provider says the account is ready. */
export const NO_CAPABILITIES = (flow: PaymentFlow): PaymentCapabilities => ({
  card: false,
  bankTransfer: false,
  subscriptions: false,
  refunds: false,
  savedMethods: false,
  holds: false,
  flow,
  needsInfo: false,
  needsInfoBy: null,
});

/** The sign-in's result. Sealed as JSON before it touches the database, like mailboxes and calendars. */
export interface PaymentTokens {
  /** Square's seller token. Null for Stripe: its calls use our own key. */
  readonly accessToken: string | null;
  /** Square rotates it on every refresh. Stripe's never expires and is only used to deauthorize. */
  readonly refreshToken: string | null;
  /** When the access token stops working (ISO). Square: 30 days. Null: it doesn't. */
  readonly expiresAt: string | null;
  readonly scopes: readonly string[];
  /** Stripe's `stripe_user_id`, Square's `merchant_id`. */
  readonly externalAccountId: string;
  /** What the provider says this token is for, which need not be what we asked for. */
  readonly environment: PaymentEnvironment;
}

/** The account as the provider describes it, read once at activation. */
export interface ConnectedAccount {
  readonly externalAccountId: string;
  /** What the provider calls it ("Lone Star Heating & Air"), for the account list. */
  readonly displayName: string | null;
  /** Square only: the location money is taken at (the first one that can take cards). */
  readonly locationId: string | null;
  readonly capabilities: PaymentCapabilities;
  /** Permissions the seller left unticked; the connection needs them all. */
  readonly missingScopes: readonly string[];
}

/** What the browser needs to collect a payment for this account. The page branches once, on `flow`. */
export interface PreparedPayment {
  readonly flow: PaymentFlow;
  /** Stripe: `pk_…`. Square: the application id. Public either way. */
  readonly publishableKey: string;
  /** Stripe: the connected account the Elements session belongs to. */
  readonly accountId: string;
  /** Square: the location the Web Payments SDK charges at. */
  readonly locationId: string | null;
  /** Stripe: the PaymentIntent's client secret, which the browser confirms. Null for Square. */
  readonly clientSecret: string | null;
  /** Stripe: the intent already made, so `confirmFromClient` can read it back. Null for Square. */
  readonly providerPaymentId: string | null;
  readonly methods: readonly PaymentMethodKind[];
  readonly amountCents: number;
  /** The stand-in's own payment page (development and tests only). Null with the real providers. */
  readonly hostedUrl: string | null;
}

export interface PrepareInput {
  readonly amountCents: number;
  readonly methods: readonly PaymentMethodKind[];
  readonly idempotencyKey: string;
  readonly description: string | null;
  /** The provider's customer, when the business has one (saved cards, plans). */
  readonly customerRef: string | null;
  /** A deposit at booking holds the card and captures once the slot is confirmed. */
  readonly hold: boolean;
  readonly metadata: Readonly<Record<string, string>>;
  /** Where the stand-in's page sends the customer back to. Ignored by the real providers. */
  readonly returnUrl: string | null;
}

export interface ChargeInput {
  readonly amountCents: number;
  readonly method: PaymentMethodKind;
  /**
   * Square: the Web Payments SDK's one-time token, or a saved card's id. Stripe: a saved payment method for an
   * off-session charge (a plan's cycle). Null means there is nothing to charge yet.
   */
  readonly sourceToken: string | null;
  /** Written on the payment row before we call, so a double-clicked button charges once. */
  readonly idempotencyKey: string;
  readonly description: string | null;
  readonly customerRef: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

/** What a charge, a capture or a void answers. A refusal is right here, as `failed`. */
export interface PaymentResult {
  readonly providerPaymentId: string;
  readonly status: PaymentState;
  /** The provider's own word for it (`requires_capture`, `COMPLETED`, `PENDING`), kept beside ours. */
  readonly providerStatus: string;
  readonly amountCents: number;
  readonly failureCode: string | null;
  /** Plain words for the customer's page: never the provider's raw message. */
  readonly failureMessage: string | null;
  readonly feeCents: number | null;
  readonly netCents: number | null;
  /** When the money actually arrived (ISO); null until it has. */
  readonly receivedAt: string | null;
  /** A held card waiting to be captured. */
  readonly capturable: boolean;
  /**
   * What the card was, when it was a card and the provider said: "Visa", "4242". Never the number — the
   * provider holds that — and null for a bank transfer, for cash, and any time a provider doesn't say.
   */
  readonly cardBrand: string | null;
  readonly cardLast4: string | null;
  /** Stripe's charge behind the payment (`ch_…`), which a transfer to a partner is tied to. Not every provider says. */
  readonly chargeRef?: string | null;
}

export interface RefundInput {
  readonly providerPaymentId: string;
  readonly amountCents: number;
  readonly reason: string | null;
  readonly idempotencyKey: string;
}

export interface RefundResult {
  readonly providerRefundId: string;
  readonly status: RefundState;
  readonly providerStatus: string;
  readonly amountCents: number;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
}

/** A card the customer let the business keep. Never the number: the provider holds that. */
export interface CardSessionInput {
  /** The provider's customer the card is saved against, made by `ensureCustomer` first. */
  readonly customerRef: string;
  /** Where the provider sends them when they are done, with `?card=<session>` on it (or `cancelled`). */
  readonly returnUrl: string;
  readonly idempotencyKey: string;
}

export interface CardSession {
  /** The provider's id for the session, which comes back on the return and reads it. */
  readonly sessionRef: string;
  /** The page to send the browser to. */
  readonly hostedUrl: string;
}

export interface CardSessionResult {
  /** The card the session ended with, or null when nobody finished it. */
  readonly sourceToken: string | null;
  /** The customer it was saved against, as the provider has it. */
  readonly customerRef: string | null;
}

export interface SavedMethod {
  /** The provider's id for it (Stripe's `pm_…`, Square's card id). */
  readonly token: string;
  readonly kind: PaymentMethodKind;
  readonly brand: string | null;
  readonly last4: string | null;
  readonly expiryMonth: number | null;
  readonly expiryYear: number | null;
}

export interface CustomerInput {
  /** The provider's customer, when we already made one. */
  readonly customerRef: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly idempotencyKey: string;
}

export interface SubscriptionInput {
  readonly customerRef: string;
  /** The saved card the plan bills. Square needs one; Stripe takes the customer's default without it. */
  readonly methodToken: string | null;
  readonly amountCents: number;
  readonly interval: 'month' | 'year';
  readonly intervalCount: number;
  readonly name: string;
  readonly startAt: string | null;
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SubscriptionResult {
  readonly providerSubscriptionId: string;
  readonly status: SubscriptionState;
  readonly providerStatus: string;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAt: string | null;
}

/** What the provider kept, and what actually lands in the business's bank. */
export interface PaymentFees {
  readonly feeCents: number | null;
  readonly netCents: number | null;
}

/** One provider event, as its webhook route stores it. Step 5's routes act on these. */
export interface PaymentEvent {
  /** The provider's own event id: what the delivery is deduplicated on. */
  readonly id: string;
  /** The provider's event name (`payment_intent.succeeded`, `refund.updated`). */
  readonly type: string;
  /** The account it is about (`acct_…` / `merchant_id`), which is how it finds its business. */
  readonly accountRef: string | null;
  readonly createdAt: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface WebhookInput {
  /** The exact bytes the provider sent: signatures are checked over these, never a re-serialised object. */
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The URL the provider called, built from WORKER_PUBLIC_URL and never from the Host header. */
  readonly url: string;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** This server has the provider's app (client id and secret). */
  readonly configured: boolean;
  /** Stripe confirms in the browser; Square tokenises there and charges here. */
  readonly flow: PaymentFlow;
  /** Public, and safe on a customer's page: Stripe's `pk_…`, Square's application id. */
  readonly publishableKey: string;

  // ---------- connecting ----------
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<PaymentTokens>;
  /** Square's token lasts 30 days. Stripe's never expires, so this is a no-op there. */
  refreshTokens(tokens: PaymentTokens): Promise<PaymentTokens>;
  /** The account's name and what it can do, read at activation. */
  describe(tokens: PaymentTokens): Promise<ConnectedAccount>;
  /**
   * Our disconnect tells the provider too. Both are authenticated as **the platform** and need only the account
   * id — Stripe's deauthorize takes `client_id` + `stripe_user_id`, Square's revoke takes `client_id` +
   * `merchant_id` — which is what makes this possible at all: by the time the event reaches the worker, the
   * connection's sealed token is already gone, on purpose. A failure here is logged, never fatal.
   */
  revokeAccess(account: Pick<PaymentAccount, 'externalAccountId'>): Promise<void>;

  // ---------- money ----------
  capabilities(account: PaymentAccount): Promise<PaymentCapabilities>;
  prepare(account: PaymentAccount, input: PrepareInput): Promise<PreparedPayment>;
  /** After the browser confirmed (Stripe): read the intent back, so the answer is the provider's, not the page's. */
  confirmFromClient(account: PaymentAccount, providerPaymentId: string): Promise<PaymentResult>;
  charge(account: PaymentAccount, input: ChargeInput): Promise<PaymentResult>;
  /** Holds the money without taking it (a deposit while the slot is confirmed). Cards only. */
  authorize(account: PaymentAccount, input: ChargeInput): Promise<PaymentResult>;
  capture(
    account: PaymentAccount,
    input: { providerPaymentId: string; amountCents: number; idempotencyKey: string },
  ): Promise<PaymentResult>;
  /** Lets a hold go: the customer is never charged, and the money is theirs again within days. */
  voidAuthorization(
    account: PaymentAccount,
    input: { providerPaymentId: string; idempotencyKey: string },
  ): Promise<PaymentResult>;
  refund(account: PaymentAccount, input: RefundInput): Promise<RefundResult>;

  // ---------- customers and their cards ----------
  ensureCustomer(account: PaymentAccount, input: CustomerInput): Promise<{ customerRef: string }>;
  saveMethod(
    account: PaymentAccount,
    input: { customerRef: string; sourceToken: string; idempotencyKey: string },
  ): Promise<SavedMethod>;
  listMethods(account: PaymentAccount, customerRef: string): Promise<SavedMethod[]>;
  forgetMethod(
    account: PaymentAccount,
    input: { customerRef: string; token: string },
  ): Promise<void>;

  /**
   * Charges **HandsFreeOS itself** makes: the usage wallet's top-ups (M16, step 5). Everything else on this
   * interface acts for a business against their connected account; these act for us, against nobody's.
   *
   * They take no account at all, on purpose. With Stripe Connect a call carrying the `stripe-account` header
   * is the business's and a call without it is ours — the difference between money landing in their bank and
   * money landing in ours is one header. Passing an account somehow marked "not really an account" would put
   * that difference inside a conditional somebody could get wrong; having no account to pass makes it
   * impossible to get wrong.
   */
  readonly platform: PlatformPayments;

  /** Plans run on the provider: it brings the retries, the card updater and the re-authentication. */
  readonly subscriptions: {
    create(account: PaymentAccount, input: SubscriptionInput): Promise<SubscriptionResult>;
    pause(
      account: PaymentAccount,
      input: { providerSubscriptionId: string; resumeAt: string | null },
    ): Promise<SubscriptionResult>;
    resume(
      account: PaymentAccount,
      input: { providerSubscriptionId: string },
    ): Promise<SubscriptionResult>;
    cancel(
      account: PaymentAccount,
      input: { providerSubscriptionId: string; atPeriodEnd: boolean },
    ): Promise<SubscriptionResult>;
    get(
      account: PaymentAccount,
      input: { providerSubscriptionId: string },
    ): Promise<SubscriptionResult>;
  };

  /** What the provider kept. Not known until the money has settled, so it comes back null until then. */
  fees(account: PaymentAccount, providerPaymentId: string): Promise<PaymentFees>;

  /**
   * The provider's own signature scheme and event shape. Step 5's webhook routes verify before they store
   * anything, and deduplicate on `PaymentEvent.id`.
   */
  readonly webhooks: {
    /**
     * False until the endpoint's signing secret is on the server. Nothing verifies without it, so every event is
     * refused — and a provider refused for days turns the endpoint off (Stripe did, 2026-10-08).
     */
    readonly configured: boolean;
    /** True only when the bytes really came from the provider, within its time window. */
    verify(input: WebhookInput): boolean;
    /** The event, or null when the body isn't one we understand. */
    parse(rawBody: string): PaymentEvent | null;
  };
}

/**
 * The provider no longer accepts the sign-in (revoked, deauthorized, a token 30 days gone): the business must
 * reconnect. Connections move to `reauth_required` and the owners hear once.
 */
/**
 * What HandsFreeOS can do with its own money. Square is absent on purpose: its API acts only as a seller with
 * that seller's own token, so there is no way to charge a business through it on our behalf. `supported` is
 * false there and every method refuses in words a person can read — which is what `wallet.request_card` says
 * back to a business that has only connected Square.
 */
/**
 * A page to pay HandsFreeOS once (0093): a founding seat. The provider hosts it, so a card number never touches
 * us, and the money lands in our own account — there is no seller's account anywhere in it.
 */
export interface CheckoutInput {
  /**
   * What is being paid for, which is the metadata key the id goes out under (`founding_checkout_id`,
   * `rcs_request_id`) and so how its events find their way back. A founding seat when left out.
   */
  readonly kind?: 'founding_checkout' | 'rcs_request' | 'texting_fee';
  /** Ours. Stamped on the page and on its payment, so every event about it finds its way back. */
  readonly checkoutId: string;
  readonly amountCents: number;
  /** What the person is buying, as the page and their receipt name it. */
  readonly productName: string;
  readonly description: string | null;
  /** Where the provider sends them after paying, and after giving up. */
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Filled in on the page for them, and where the receipt goes. */
  readonly customerEmail: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  /** Stable per checkout, so a retry makes the same page rather than a second one. */
  readonly idempotencyKey: string;
  /**
   * The page's lines, when it is more than one thing (RCS: the carriers' fee, the vetting, our setup). They add
   * up to `amountCents`; left out, the page is one line named `productName`.
   */
  readonly lines?: readonly CheckoutLine[];
  /** Keep the card on the customer for charging later without them there (a yearly renewal). */
  readonly saveCard?: boolean;
}

export interface CheckoutLine {
  readonly name: string;
  readonly description: string | null;
  readonly amountCents: number;
}

export interface CheckoutSession {
  /** The provider's id for the page (`cs_…`). */
  readonly sessionRef: string;
  readonly url: string;
  /** When the page stops taking payment, if the provider said. */
  readonly expiresAt: string | null;
}

/** What one of our own account's checkout events says, read the same way whoever sent it. */
export interface CheckoutEvent {
  /** The provider's event id: what the delivery is deduplicated on. */
  readonly id: string;
  /** `checkout.session.completed`, `.expired`, `.async_payment_succeeded`, `.async_payment_failed`. */
  readonly type: string;
  readonly sessionRef: string;
  /** A founding seat's checkout, from the page's metadata. Null on a page some other part of the account made. */
  readonly checkoutId: string | null;
  /** An RCS request (0104), from the page's metadata. Null on any other page. */
  readonly rcsRequestId: string | null;
  /** On an RCS renewal paid with another card: the `paid_through` it renews. Null on a first payment. */
  readonly renewalFor: string | null;
  /** A texting fee (0105), from the page's metadata. Null on any other page. */
  readonly textingFeeId: string | null;
  /** The provider's customer the page made (`cus_…`). */
  readonly customerRef: string | null;
  /** `paid`, `unpaid` or `no_payment_required`. Only `paid` means the money is in. */
  readonly paymentStatus: string | null;
  /** The payment behind it (`pi_…`): what a refund is made against. */
  readonly paymentRef: string | null;
  readonly amountTotal: number | null;
}

/** A partner's Stripe Express account, as Stripe describes it (the partners plan's stage 3). */
export interface PayoutAccountState {
  /** Stripe's `acct_…`. */
  readonly accountRef: string;
  /** Made with a test key: it only ever takes test money. */
  readonly livemode: boolean;
  /** They finished Stripe's form. */
  readonly detailsSubmitted: boolean;
  /** Stripe pays what's in their Stripe balance out to their bank. */
  readonly payoutsEnabled: boolean;
  /** We can send them money: the account's `transfers` capability is active. */
  readonly transfersActive: boolean;
  /** Why Stripe stopped it, in Stripe's own words (`requirements.past_due`), when it has. */
  readonly disabledReason: string | null;
  /** What Stripe still needs from them, by its own field names. */
  readonly due: readonly string[];
}

/** Money from our balance to a partner's, once the charge that brought it in has landed. */
export interface PayoutTransferInput {
  readonly accountRef: string;
  readonly amountCents: number;
  /** The business's charge (`ch_…`) the money came in on: Stripe sends it once that charge's money is ours. */
  readonly sourceChargeRef: string;
  /** Every transfer of one month's payout, and its charge, under one name in Stripe's dashboard. */
  readonly transferGroup: string;
  readonly description: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
}

/**
 * Paying partners for the businesses they send customers to (the partners plan's stage 3): each partner's bank is
 * a Stripe Express account of HandsFreeOS's platform, set up on Stripe's own form, and paid by transfers from what
 * the business's card was charged. Stripe holds and moves the money, and files the partners' 1099s.
 */
export interface PayoutAccounts {
  /** One account for a partner, made the first time they set up payouts. */
  create(input: {
    readonly email: string | null;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<PayoutAccountState>;
  read(accountRef: string): Promise<PayoutAccountState>;
  /** Stripe's own form for it: their bank, tax and identity details go to Stripe, never to us. */
  onboardingLink(input: {
    readonly accountRef: string;
    /** Where Stripe sends them when the link has run out, for a fresh one. */
    readonly refreshUrl: string;
    readonly returnUrl: string;
  }): Promise<{ url: string }>;
  /** Their Stripe Express page, where they see their payouts and change their bank. */
  loginLink(accountRef: string): Promise<{ url: string }>;
  /** A refusal (an account that can't take it) is a permanent `PaymentError`; a provider that's down retries. */
  transfer(input: PayoutTransferInput): Promise<{ transferRef: string }>;
}

export interface PlatformPayments {
  readonly supported: boolean;
  /** Our own key moves real money. A test key's partner payouts pay only payments taken in a test mode. */
  readonly livemode: boolean;
  readonly payouts: PayoutAccounts;
  /** Us, as a customer of the provider, for one business. Their id for it is kept on the wallet. */
  ensureCustomer(input: CustomerInput): Promise<{ customerRef: string }>;
  /**
   * A page the provider hosts, where a business types the card that tops its balance up.
   *
   * **The card never reaches us.** It is typed on the provider's own page, and what comes back here is the
   * session it happened in — which `readCardSession` turns into a token. That is the whole reason this is a
   * session rather than a form: a card that never touches our servers is a card we cannot lose.
   */
  startCardSession(input: CardSessionInput): Promise<CardSession>;
  /**
   * What the session ended with, read from the provider rather than from whatever came back in the browser's
   * address bar. A session nobody finished answers `null` and is not an error: they closed the page.
   */
  readCardSession(sessionRef: string): Promise<CardSessionResult>;
  saveMethod(input: {
    customerRef: string;
    sourceToken: string;
    idempotencyKey: string;
  }): Promise<SavedMethod>;
  forgetMethod(input: { customerRef: string; token: string }): Promise<void>;
  /** A top-up. A declined card is a returned `failed`, never an exception: it is an answer, not a breakdown. */
  charge(input: ChargeInput): Promise<PaymentResult>;
  /** A hosted page to pay us once. Square refuses, like everything else here. */
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  /**
   * The customer and the card a paid page kept (`saveCard`), read from the provider rather than from the event,
   * which doesn't carry the card. Null where it kept none.
   */
  checkoutCard(sessionRef: string): Promise<{ customerRef: string | null; cardRef: string | null }>;
  /**
   * Our own account's events — Stripe's "Your account" destination, not the Connect one — signed with a secret
   * of their own. `configured` is false until that secret is on the server, and nothing verifies without it.
   */
  readonly webhooks: {
    readonly configured: boolean;
    verify(input: WebhookInput): boolean;
    /** A checkout event, or null for anything else (answered and dropped). */
    checkout(rawBody: string): CheckoutEvent | null;
  };
}

/** What a provider says when it has no way to take money for us. */
export class PlatformUnsupportedError extends Error {
  constructor(readonly provider: PaymentProviderName) {
    super(
      provider === 'square'
        ? 'Square can only take money for your own customers, so HandsFreeOS cannot bill a card through it. Connect Stripe to keep your balance topped up.'
        : `HandsFreeOS cannot bill a card through ${provider}.`,
    );
    this.name = 'PlatformUnsupportedError';
  }
}

export class PaymentAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PaymentAuthError';
  }
}

/**
 * Any other refusal. `permanent` ones are recorded and not retried (a bad amount); the rest retry, after
 * `retryAfterMs` when the provider is throttling. A declined card is **not** one of these — it comes back as a
 * `PaymentResult` with `status: 'failed'`.
 */
export class PaymentError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly permanent = false,
    readonly retryAfterMs: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/**
 * Stripe refuses `read_write` for a Standard account another platform already controls, and the seller is told
 * to make a second account. The callback says that in plain words and offers Square instead; the raw code stays
 * in `last_error`.
 */
export const ACCOUNT_HELD_ELSEWHERE = 'account_controlled_by_another_platform';

/** OAuth errors that mean "sign in again", keyed on the code and never on its description. */
const RECONNECT = new Set([
  'invalid_grant',
  'access_token_revoked',
  'ACCESS_TOKEN_REVOKED',
  'ACCESS_TOKEN_EXPIRED',
  'UNAUTHORIZED',
  'authorization_code_expired',
]);

export const meansReconnect = (code: string): boolean => RECONNECT.has(code);

/** Cents as the providers count them: whole, positive, and never more than a hundred million dollars. */
export function requireAmount(amountCents: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100_000_000_000)
    throw new PaymentError(`That amount can’t be charged (${amountCents}).`, null, true);
  return amountCents;
}

/** Idempotency keys are the provider's too: long enough to be unique, short enough for both. */
export const idempotencyKey = (value: string): string => value.slice(0, 64);

/** A constant-time compare of two hex or base64 signatures of the same scheme. */
export function signatureMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const hmacHex = (key: string, payload: string): string =>
  createHmac('sha256', key).update(payload, 'utf8').digest('hex');

export const hmacBase64 = (key: string, payload: string): string =>
  createHmac('sha256', key).update(payload, 'utf8').digest('base64');

/** Providers name their own money in cents already; this only keeps the arithmetic honest. */
export const centsOf = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && Number.isSafeInteger(n) ? n : null;
};

/** An ISO time from whatever the provider sent (seconds, milliseconds or a string). */
export function isoOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value))
    return new Date(value < 1e11 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/** Metadata the providers will accept: short keys, short values, and never more than twenty of them. */
export function cleanMetadata(metadata: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata).slice(0, 20))
    if (k && typeof v === 'string') out[k.slice(0, 40)] = v.slice(0, 500);
  return out;
}

/** The card brands the two providers name, each spelt the way a person writes it on a receipt. */
const CARD_BRANDS: Readonly<Record<string, string>> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  american_express: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  diners_club: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  china_unionpay: 'UnionPay',
  interac: 'Interac',
  eftpos_au: 'Eftpos',
  link: 'Link',
};

/**
 * "Visa" from Stripe's `visa` and Square's `VISA`. A brand neither of them names — and Stripe's own literal
 * `unknown` — is null rather than a guess; anything else they send is title-cased as they spelt it.
 */
export function cardBrandLabel(raw: string | null | undefined): string | null {
  const key = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!key || key === 'unknown') return null;
  return (
    CARD_BRANDS[key] ??
    key
      .split('_')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

/** The last four digits a provider gave, when they really are four digits. */
export const cardLast4 = (raw: string | null | undefined): string | null =>
  /^\d{4}$/.test((raw ?? '').trim()) ? (raw ?? '').trim() : null;

/**
 * What the customer reads when a card is refused. The provider's own message names the issuer and sometimes the
 * seller's own settings, so it never reaches the page.
 */
export function declineWording(code: string | null): string {
  switch (code) {
    case 'insufficient_funds':
    case 'INSUFFICIENT_FUNDS':
      return 'That card was declined — there wasn’t enough in the account.';
    case 'expired_card':
    case 'CARD_EXPIRED':
      return 'That card has expired. Try another one.';
    case 'incorrect_cvc':
    case 'CVV_FAILURE':
      return 'The security code didn’t match. Check it and try again.';
    case 'incorrect_number':
    case 'INVALID_CARD':
      return 'That card number doesn’t look right. Check it and try again.';
    case 'incorrect_zip':
    case 'ADDRESS_VERIFICATION_FAILURE':
      return 'The billing ZIP code didn’t match. Check it and try again.';
    case 'processing_error':
    case 'TEMPORARY_ERROR':
      return 'The card company couldn’t answer just now. Try again in a minute.';
    default:
      return 'That card was declined. Try another card, or ask your bank why.';
  }
}
