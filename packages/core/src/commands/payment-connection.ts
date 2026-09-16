/**
 * The accounts a business is paid into. A business connects several at once — including two of the same
 * provider — and chooses which one each document is paid into.
 *
 * People start a sign-in, rename an account, choose the default and disconnect one. Everything the provider
 * decides (the tokens, the capabilities, the failures, a revoke) is the worker's, and the column grants in 0046
 * hold the same line: `authenticated` may update only `status`, `label` and `is_default`, so every write here
 * names its columns and every read names the ones people may see.
 *
 * Two rules worth knowing:
 * - **Disconnecting destroys the tokens on purpose.** Credentials are found again by (provider, account id), so
 *   reconnecting the same account restores the ability to refund every old payment. `payment.refund` checks
 *   exactly that.
 * - **Plans keep billing at the provider after a disconnect.** So a disconnect refuses while any plan is still
 *   billing through the account, lists them, and only goes ahead when the business says it knows
 *   (`acknowledgeSubscriptions`), marking each one `unmanaged`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, ne, sql as dsql } from 'drizzle-orm';
import { paymentConnections, subscriptions } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  PaymentConnectionActivateInput,
  PaymentConnectionConnectInput,
  PaymentConnectionConnectOutput,
  PaymentConnectionDisconnectInput,
  PaymentConnectionFailInput,
  PaymentConnectionRefInput,
  PaymentConnectionRevokedInput,
  PaymentConnectionSetLabelInput,
  PaymentConnectionStateOutput,
} from '../schemas/money';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** How long a payment sign-in state stays good, as mailboxes and calendars use. */
const STATE_TTL_MS = 10 * 60_000;
/** A connection that hasn't ended: the unique index per account counts these. */
export const LIVE_CONNECTION_STATUSES = ['pending', 'active', 'reauth_required', 'error'] as const;
/** Plans that are still the provider's business, so disconnecting leaves them unmanaged. */
const LIVE_SUBSCRIPTION_STATUSES = ['active', 'past_due', 'paused'] as const;

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** The columns people may read (0046's column grants); never a token or a sign-in secret. */
const CONNECTION_COLUMNS = {
  id: paymentConnections.id,
  provider: paymentConnections.provider,
  environment: paymentConnections.environment,
  status: paymentConnections.status,
  externalAccountId: paymentConnections.externalAccountId,
  locationId: paymentConnections.locationId,
  label: paymentConnections.label,
  displayName: paymentConnections.displayName,
  isDefault: paymentConnections.isDefault,
  capabilities: paymentConnections.capabilities,
  tokenExpiresAt: paymentConnections.tokenExpiresAt,
  failures: paymentConnections.failures,
  lastError: paymentConnections.lastError,
  disconnectedReason: paymentConnections.disconnectedReason,
  connectedAt: paymentConnections.connectedAt,
  disconnectedAt: paymentConnections.disconnectedAt,
} as const;

export type LoadedPaymentConnection = {
  [K in keyof typeof CONNECTION_COLUMNS]: (typeof paymentConnections)[K]['_']['data'];
};

export async function loadPaymentConnection(
  ctx: CommandContext,
  connectionId: string,
): Promise<LoadedPaymentConnection> {
  const [c] = await ctx.tx
    .select(CONNECTION_COLUMNS)
    .from(paymentConnections)
    .where(
      and(
        eq(paymentConnections.id, connectionId),
        eq(paymentConnections.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  if (!c) throw HfosError.notFound('That payment account isn’t there.');
  return c as LoadedPaymentConnection;
}

/** What it is called in an event and the audit log: the business's own name for it, else the provider's. */
const connectionLabel = (c: {
  label: string | null;
  displayName: string | null;
  provider: string;
}) => c.label ?? c.displayName ?? c.provider;

/** The plans still billing through an account: what a disconnect would leave unmanaged. */
async function liveSubscriptionsOf(
  ctx: CommandContext,
  connectionId: string,
): Promise<{ id: string; planName: string }[]> {
  return ctx.tx
    .select({ id: subscriptions.id, planName: subscriptions.planName })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, ctx.scope.workspaceId!),
        eq(subscriptions.connectionId, connectionId),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
      ),
    );
}

/**
 * The account is gone but the plans are not: they keep billing at the provider, so they are marked unmanaged
 * and the plan page says so.
 */
async function markSubscriptionsUnmanaged(
  ctx: CommandContext,
  connectionId: string,
  reason: string,
): Promise<string[]> {
  const live = await liveSubscriptionsOf(ctx, connectionId);
  if (!live.length) return [];
  await ctx.tx
    .update(subscriptions)
    .set({ status: 'unmanaged', pausedAt: null, lastError: reason })
    .where(
      inArray(
        subscriptions.id,
        live.map((s) => s.id),
      ),
    );
  for (const s of live)
    await ctx.emit({
      type: 'subscription.unmanaged',
      entityType: 'subscription',
      entityId: s.id,
      payload: { connectionId, reason },
      after: { plan: s.planName, status: 'unmanaged', reason },
    });
  return live.map((s) => s.id);
}

/**
 * One default per business and environment (a partial unique index). Called before the winner is set, so the
 * index never sees two.
 */
async function clearDefault(
  ctx: CommandContext,
  environment: 'live' | 'test',
  exceptId: string,
): Promise<void> {
  await ctx.tx
    .update(paymentConnections)
    .set({ isDefault: false })
    .where(
      and(
        eq(paymentConnections.workspaceId, ctx.scope.workspaceId!),
        eq(paymentConnections.environment, environment),
        eq(paymentConnections.isDefault, true),
        ne(paymentConnections.id, exceptId),
      ),
    );
}

/** The state an unchanged command returns. */
const stateOut = (c: LoadedPaymentConnection, changed: boolean) => ({
  connectionId: c.id,
  status: c.status,
  isDefault: c.isDefault,
  changed,
});

// ---------- people ----------

export const paymentConnectionConnect = defineCommand({
  name: 'payment_connection.connect',
  description:
    'Start connecting a Stripe or Square account to be paid into. Returns a one-time state; the browser signs in at the provider through the worker. A business can have several accounts connected at once.',
  risk: 2,
  input: PaymentConnectionConnectInput,
  output: PaymentConnectionConnectOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['payment_connection.connect_started'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const state = randomBytes(32).toString('base64url');
    // The insert policy allows only a pending sign-in with no account, no token and no default.
    const [row] = await ctx.tx
      .insert(paymentConnections)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        provider: input.provider,
        environment: input.environment,
        status: 'pending',
        label: input.label ?? null,
        oauthStateHash: sha256Hex(state),
        oauthStateExpiresAt: new Date(Date.now() + STATE_TTL_MS),
        createdBy: me,
      })
      .returning({ id: paymentConnections.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'payment_connection.connect_started',
      entityType: 'payment_connection',
      entityId: row.id,
      payload: { provider: input.provider, environment: input.environment },
      after: { provider: input.provider, environment: input.environment },
      broadcast: false,
    });
    return { connectionId: row.id, state };
  },
});

export const paymentConnectionSetLabel = defineCommand({
  name: 'payment_connection.set_label',
  description: 'Rename a connected payment account, so a business tells its own accounts apart.',
  risk: 1,
  input: PaymentConnectionSetLabelInput,
  output: PaymentConnectionStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['payment_connection.renamed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const c = await loadPaymentConnection(ctx, input.connectionId);
    const label = input.label?.trim() || null;
    if (c.label === label) return stateOut(c, false);
    if (c.status !== 'active')
      throw HfosError.rule(
        'payment_connection_not_active',
        409,
        'Only a connected account can be renamed.',
      );
    await ctx.tx.update(paymentConnections).set({ label }).where(eq(paymentConnections.id, c.id));
    await ctx.emit({
      type: 'payment_connection.renamed',
      entityType: 'payment_connection',
      entityId: c.id,
      payload: { provider: c.provider, label },
      before: { account: connectionLabel(c) },
      after: { account: label ?? c.displayName ?? c.provider },
    });
    return { ...stateOut(c, true), status: c.status };
  },
});

export const paymentConnectionSetDefault = defineCommand({
  name: 'payment_connection.set_default',
  description:
    'Choose which connected account new invoices are paid into. One default per business and environment.',
  risk: 1,
  input: PaymentConnectionRefInput,
  output: PaymentConnectionStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['payment_connection.default_set'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const c = await loadPaymentConnection(ctx, input.connectionId);
    if (c.isDefault) return stateOut(c, false);
    if (c.status !== 'active')
      throw HfosError.rule(
        'payment_connection_not_active',
        409,
        'Only a connected account can be the default.',
      );
    await clearDefault(ctx, c.environment, c.id);
    await ctx.tx
      .update(paymentConnections)
      .set({ isDefault: true })
      .where(eq(paymentConnections.id, c.id));
    await ctx.emit({
      type: 'payment_connection.default_set',
      entityType: 'payment_connection',
      entityId: c.id,
      payload: { provider: c.provider, environment: c.environment },
      after: { account: connectionLabel(c), environment: c.environment, default: true },
    });
    return { connectionId: c.id, status: c.status, isDefault: true, changed: true };
  },
});

export const paymentConnectionDisconnect = defineCommand({
  name: 'payment_connection.disconnect',
  description:
    'Disconnect a payment account. HandsFreeOS forgets the sign-in and stops taking money into it; payments already on their way still settle, and reconnecting the same account restores refunds on old payments. Plans billing through it keep billing at the provider, so this refuses and lists them until you say you know.',
  risk: 3,
  input: PaymentConnectionDisconnectInput,
  output: PaymentConnectionStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['payment_connection.disconnected', 'subscription.unmanaged'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const c = await loadPaymentConnection(ctx, input.connectionId);
    if (c.status === 'disconnected') return stateOut(c, false);
    const live = await liveSubscriptionsOf(ctx, c.id);
    if (live.length && !input.acknowledgeSubscriptions)
      throw new HfosError(
        'rule_violation',
        409,
        live.length === 1
          ? `${live[0]!.planName} still bills through this account. Cancel it first, or disconnect anyway and it keeps billing at the provider.`
          : `${live.length} plans still bill through this account. Cancel them first, or disconnect anyway and they keep billing at the provider.`,
        { subscriptions: live.map((s) => ({ id: s.id, planName: s.planName })) },
        'payment_connection_has_plans',
      );
    // The guard clears the tokens, the sign-in secret and the refresh, stamps the reason and drops the default.
    await ctx.tx
      .update(paymentConnections)
      .set({ status: 'disconnected' })
      .where(eq(paymentConnections.id, c.id));
    const unmanaged = await markSubscriptionsUnmanaged(ctx, c.id, 'The account was disconnected.');
    // A business without a default has nowhere to be paid: the oldest account still connected takes over.
    const promoted = c.isDefault ? await promoteDefault(ctx, c.environment) : null;
    await ctx.emit({
      type: 'payment_connection.disconnected',
      entityType: 'payment_connection',
      entityId: c.id,
      payload: {
        provider: c.provider,
        environment: c.environment,
        reason: 'person',
        unmanagedSubscriptions: unmanaged,
        newDefaultConnectionId: promoted,
      },
      before: { account: connectionLabel(c), status: c.status },
      after: {
        account: connectionLabel(c),
        status: 'disconnected',
        reason: 'person',
        ...(unmanaged.length ? { plansLeftBilling: unmanaged.length } : {}),
      },
    });
    return { connectionId: c.id, status: 'disconnected' as const, isDefault: false, changed: true };
  },
});

/** The oldest account still connected in an environment becomes the default when the old one goes. */
async function promoteDefault(
  ctx: CommandContext,
  environment: 'live' | 'test',
): Promise<string | null> {
  const [next] = await ctx.tx
    .select({ id: paymentConnections.id })
    .from(paymentConnections)
    .where(
      and(
        eq(paymentConnections.workspaceId, ctx.scope.workspaceId!),
        eq(paymentConnections.environment, environment),
        eq(paymentConnections.status, 'active'),
        eq(paymentConnections.isDefault, false),
      ),
    )
    .orderBy(asc(paymentConnections.connectedAt), asc(paymentConnections.id))
    .limit(1);
  if (!next) return null;
  await ctx.tx
    .update(paymentConnections)
    .set({ isDefault: true })
    .where(eq(paymentConnections.id, next.id));
  return next.id;
}

// ---------- the worker ----------

export const paymentConnectionActivate = defineCommand({
  name: 'payment_connection.activate',
  description:
    'Worker: the business signed in at Stripe or Square and the account is connected. Reconnecting an account the business already had disconnects the old row first, and the first account in an environment becomes its default.',
  risk: 1,
  input: PaymentConnectionActivateInput,
  output: PaymentConnectionStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['payment_connection.connected', 'payment_connection.disconnected'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadPaymentConnection(ctx, input.connectionId);
    if (c.status === 'active' && c.externalAccountId === input.externalAccountId)
      return stateOut(c, false);
    if (c.status !== 'pending')
      throw HfosError.rule(
        'payment_connection_not_pending',
        409,
        'This account isn’t waiting to connect.',
      );
    const now = new Date();
    // One live row per account: the earlier one steps down, keeping the unique index happy.
    const replaced = await ctx.tx
      .update(paymentConnections)
      .set({
        status: 'disconnected',
        disconnectedAt: now,
        disconnectedReason: 'replaced',
        isDefault: false,
        nextRefreshAt: null,
        tokenEnc: null,
        tokenKeyId: null,
        pkceVerifierEnc: null,
        oauthStateHash: null,
        oauthStateExpiresAt: null,
      })
      .where(
        and(
          eq(paymentConnections.workspaceId, ctx.scope.workspaceId!),
          eq(paymentConnections.provider, c.provider),
          eq(paymentConnections.environment, c.environment),
          eq(paymentConnections.externalAccountId, input.externalAccountId),
          inArray(paymentConnections.status, [...LIVE_CONNECTION_STATUSES]),
          ne(paymentConnections.id, c.id),
        ),
      )
      .returning({ id: paymentConnections.id, isDefault: paymentConnections.isDefault });
    for (const old of replaced)
      await ctx.emit({
        type: 'payment_connection.disconnected',
        entityType: 'payment_connection',
        entityId: old.id,
        payload: { provider: c.provider, reason: 'replaced', replacedBy: c.id },
        after: { account: connectionLabel(c), status: 'disconnected', reason: 'replaced' },
      });
    // The first account a business connects in an environment is the one everything is paid into.
    const [other] = await ctx.tx
      .select({ id: paymentConnections.id })
      .from(paymentConnections)
      .where(
        and(
          eq(paymentConnections.workspaceId, ctx.scope.workspaceId!),
          eq(paymentConnections.environment, c.environment),
          eq(paymentConnections.isDefault, true),
          ne(paymentConnections.id, c.id),
        ),
      )
      .limit(1);
    const isDefault = !other;
    await ctx.tx
      .update(paymentConnections)
      .set({
        status: 'active',
        externalAccountId: input.externalAccountId,
        locationId: input.locationId ?? null,
        displayName: input.displayName ?? null,
        scopes: input.scopes,
        capabilities: input.capabilities as Record<string, unknown>,
        tokenEnc: input.tokenEnc,
        tokenKeyId: input.tokenKeyId,
        tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
        nextRefreshAt: input.nextRefreshAt ? new Date(input.nextRefreshAt) : null,
        connectedAt: now,
        disconnectedAt: null,
        disconnectedReason: null,
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        pkceVerifierEnc: null,
        failures: 0,
        lastError: null,
        isDefault,
      })
      .where(eq(paymentConnections.id, c.id));
    // Never the token: the event, the audit row and the output carry the account and the provider only.
    await ctx.emit({
      type: 'payment_connection.connected',
      entityType: 'payment_connection',
      entityId: c.id,
      payload: {
        provider: c.provider,
        environment: c.environment,
        externalAccountId: input.externalAccountId,
        replaced: replaced.map((r) => r.id),
        isDefault,
      },
      before: { status: c.status },
      after: {
        account: input.displayName ?? c.label ?? c.provider,
        provider: c.provider,
        environment: c.environment,
        status: 'active',
        ...(isDefault ? { default: true } : {}),
      },
    });
    return { connectionId: c.id, status: 'active' as const, isDefault, changed: true };
  },
});

export const paymentConnectionFail = defineCommand({
  name: 'payment_connection.fail',
  description:
    'Worker: a connected payment account needs signing in again, or keeps failing. Told to the owners once per change, never on every retry.',
  risk: 1,
  input: PaymentConnectionFailInput,
  output: PaymentConnectionStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['payment_connection.reauth_required', 'payment_connection.failed'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadPaymentConnection(ctx, input.connectionId);
    if (c.status === 'disconnected' || c.status === 'pending') return stateOut(c, false);
    await ctx.tx
      .update(paymentConnections)
      .set({
        status: input.reason,
        lastError: input.message,
        failures: dsql`${paymentConnections.failures} + 1`,
        // Waiting on a reconnect: nothing is refreshed until the business signs in again.
        ...(input.reason === 'reauth_required' ? { nextRefreshAt: null } : {}),
      })
      .where(eq(paymentConnections.id, c.id));
    const changed = c.status !== input.reason;
    if (changed)
      await ctx.emit({
        type:
          input.reason === 'reauth_required'
            ? 'payment_connection.reauth_required'
            : 'payment_connection.failed',
        entityType: 'payment_connection',
        entityId: c.id,
        payload: { provider: c.provider, error: input.message },
        before: { status: c.status },
        after: {
          account: connectionLabel(c),
          provider: c.provider,
          status: input.reason,
          error: input.message,
        },
      });
    return { connectionId: c.id, status: input.reason, isDefault: c.isDefault, changed };
  },
});

export const paymentConnectionRevoked = defineCommand({
  name: 'payment_connection.revoked',
  description:
    'Worker: the provider ended the connection — Square revoked it, Stripe deauthorized it, or it failed too often. The tokens go, plans still billing there are marked unmanaged, and payments already on their way still settle.',
  risk: 1,
  input: PaymentConnectionRevokedInput,
  output: PaymentConnectionStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['payment_connection.revoked', 'subscription.unmanaged'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadPaymentConnection(ctx, input.connectionId);
    if (c.status === 'disconnected') return stateOut(c, false);
    await ctx.tx
      .update(paymentConnections)
      .set({
        status: 'disconnected',
        disconnectedAt: new Date(),
        disconnectedReason: input.reason,
        isDefault: false,
        nextRefreshAt: null,
        tokenEnc: null,
        tokenKeyId: null,
        pkceVerifierEnc: null,
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        lastError: input.message,
      })
      .where(eq(paymentConnections.id, c.id));
    const unmanaged = await markSubscriptionsUnmanaged(
      ctx,
      c.id,
      input.message ?? 'The provider ended the connection.',
    );
    const promoted = c.isDefault ? await promoteDefault(ctx, c.environment) : null;
    await ctx.emit({
      type: 'payment_connection.revoked',
      entityType: 'payment_connection',
      entityId: c.id,
      payload: {
        provider: c.provider,
        environment: c.environment,
        reason: input.reason,
        unmanagedSubscriptions: unmanaged,
        newDefaultConnectionId: promoted,
      },
      before: { account: connectionLabel(c), status: c.status },
      after: {
        account: connectionLabel(c),
        status: 'disconnected',
        reason: input.reason,
        ...(input.message ? { error: input.message } : {}),
      },
    });
    return { connectionId: c.id, status: 'disconnected' as const, isDefault: false, changed: true };
  },
});

/** In the order the docs list them; the registry spreads this in. */
export const paymentConnectionCommands = [
  paymentConnectionConnect,
  paymentConnectionSetLabel,
  paymentConnectionSetDefault,
  paymentConnectionDisconnect,
  paymentConnectionActivate,
  paymentConnectionFail,
  paymentConnectionRevoked,
] as const;
