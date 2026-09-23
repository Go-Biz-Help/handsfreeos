/**
 * The payment providers a worker holds, and how to reach a connected account with them. `createPayments(env)`
 * picks the real adapters or the stand-in, exactly as mailboxes and calendars do.
 */
import { eq } from 'drizzle-orm';
import { asWorker, type Db } from '@hfos/db/client';
import { paymentConnections } from '@hfos/db/schema';
import type { Sealer } from '../crypto';
import type { WorkerEnv } from '../env';
import type { TenantScope } from '../services';
import { createFakePayments, type FakePayments } from './fake';
import {
  PaymentAuthError,
  type PaymentAccount,
  type PaymentProvider,
  type PaymentProviderName,
  type PaymentTokens,
} from './provider';
import { createSquarePayments } from './square';
import { createStripePayments } from './stripe';

export * from './provider';
export {
  createFakePayments,
  FAKE_BANK,
  FAKE_CARDS,
  FAKE_SQUARE_APPLICATION_ID,
  FAKE_SQUARE_SIGNATURE_KEY,
  FAKE_STRIPE_PLATFORM_WEBHOOK_SECRET,
  FAKE_STRIPE_PUBLISHABLE_KEY,
  FAKE_STRIPE_WEBHOOK_SECRET,
  fakePaymentCode,
  type FakeCharge,
  type FakeCheckout,
  type FakePaymentGrant,
  type FakePayments,
  type FakeRefund,
  type FakeSubscription,
  type FakeWebhookPost,
  type WebhookDeliver,
} from './fake';
export { SQUARE_SCOPES, SQUARE_TOKEN_LIFE_MS } from './square';

/** The providers a business can take money with, and the cadence Square's token is kept alive on. */
export interface PaymentServices {
  readonly providers: Readonly<Record<PaymentProviderName, PaymentProvider>>;
  /** Local and tests: the stand-in, with its own payment page on the worker. Null with the real providers. */
  readonly fake: FakePayments | null;
  /** How often a connection's token is renewed (Square's lasts 30 days; Square advises weekly). */
  readonly refreshEveryMs: number;
  /** A token with less life left than this is renewed at once, whatever its schedule said. */
  readonly refreshAheadMs: number;
}

const WEEK = 7 * 86_400_000;
const THREE_DAYS = 3 * 86_400_000;

/** The stand-in (local development, tests and the seed). */
export function fakePaymentServices(
  publicUrl: string,
  opts: { settleMs?: number; refreshEveryMs?: number } = {},
): PaymentServices & { readonly fake: FakePayments } {
  const fake = createFakePayments({
    publicUrl,
    ...(opts.settleMs === undefined ? {} : { settleMs: opts.settleMs }),
  });
  return {
    providers: fake.providers,
    fake,
    refreshEveryMs: opts.refreshEveryMs ?? WEEK,
    refreshAheadMs: THREE_DAYS,
  };
}

export function createPayments(env: WorkerEnv): PaymentServices {
  if (env.paymentsProvider === 'fake')
    return fakePaymentServices(env.publicUrl, {
      ...(env.paymentsFakeSettleMs === null ? {} : { settleMs: env.paymentsFakeSettleMs }),
    });
  return {
    providers: {
      stripe: createStripePayments({
        clientId: env.stripeClientId,
        secretKey: env.stripeSecretKey,
        publishableKey: env.stripePublishableKey,
        webhookSecret: env.stripeWebhookSecret,
        platformWebhookSecret: env.stripePlatformWebhookSecret,
      }),
      square: createSquarePayments({
        applicationId: env.squareApplicationId,
        applicationSecret: env.squareApplicationSecret,
        webhookSignatureKeys: env.squareWebhookSignatureKeys,
        environment: env.squareEnvironment,
      }),
    },
    fake: null,
    refreshEveryMs: WEEK,
    refreshAheadMs: THREE_DAYS,
  };
}

/** A connection row, as every job and route here reads it. */
export type PaymentConnectionRow = typeof paymentConnections.$inferSelect;

export const openPaymentTokens = (sealer: Sealer, sealed: string): PaymentTokens =>
  JSON.parse(sealer.open(sealed)) as PaymentTokens;

/** Signed in and in use (maybe failing lately); not waiting on a reconnect and not disconnected. */
export const paymentConnectionUsable = (c: PaymentConnectionRow): boolean =>
  (c.status === 'active' || c.status === 'error') && !!c.tokenEnc;

/**
 * The account a call is made against, from a connection row. Stripe needs no token of its own (our platform key
 * plus the account header does it); Square's seller token is opened from its seal.
 */
export function accountFor(sealer: Sealer, c: PaymentConnectionRow): PaymentAccount {
  if (!c.externalAccountId)
    throw new PaymentAuthError('This account never finished connecting.', 'missing');
  const provider = c.provider as PaymentProviderName;
  const tokens = c.tokenEnc ? openPaymentTokens(sealer, c.tokenEnc) : null;
  if (provider === 'square' && !tokens?.accessToken)
    throw new PaymentAuthError(
      'This Square account has no sign-in. Reconnect it to take payments again.',
      'missing',
    );
  return {
    provider,
    externalAccountId: c.externalAccountId,
    locationId: c.locationId,
    accessToken: tokens?.accessToken ?? null,
    environment: c.environment === 'test' ? 'test' : 'live',
  };
}

/**
 * The credentials for an account, found by **(business, provider, account id)** and never by the connection
 * row — so refunding a payment taken years ago still works after a disconnect and a reconnect of the same
 * account. Deliberately unfiltered by status: a live row wins, and a disconnected one has no token to give,
 * which is what tells the caller to say "reconnect the account" instead of failing with a provider error.
 */
export async function accountByExternalId(
  db: Db,
  scope: TenantScope,
  input: { provider: PaymentProviderName; externalAccountId: string },
  sealer: Sealer,
): Promise<{ account: PaymentAccount; connection: PaymentConnectionRow } | null> {
  const found = await asWorker(db, scope, (tx) =>
    tx
      .select()
      .from(paymentConnections)
      .where(eq(paymentConnections.workspaceId, scope.workspaceId)),
  );
  const rows = found
    .filter((c) => c.provider === input.provider && c.externalAccountId === input.externalAccountId)
    .sort((a, b) => Number(!!a.disconnectedAt) - Number(!!b.disconnectedAt));
  const connection = rows.find((c) => paymentConnectionUsable(c)) ?? rows[0];
  if (!connection || !connection.tokenEnc) return null;
  return { account: accountFor(sealer, connection), connection };
}
