/**
 * An add-on's webhooks (round five, 20261021000200): what a service it's connected to tells it.
 *
 * - `openConnectionWebhook(ctx, connection, …)`: gives a connection its own address for the service's updates,
 *   `<WORKER_PUBLIC_URL>/webhooks/addon/<token>`, replacing any it had. The add-on then gives the address to the
 *   service (when connected, say). Only the token's hash is kept.
 * - The worker's route (http/addon-webhooks.ts) finds the connection by the address, has the add-on's receiver check
 *   the service's signature and read what happened, and keeps each update once, by the service's own id.
 * - `addonDeliveryProcessor`: the delivery runner hands each update to the receiver's `handle`, with the connection
 *   it came in on, in its own transaction with retries, and only while the add-on is on in that business.
 *
 * A service that doesn't sign is kept with `signed: false`: the address alone vouches for it, so the add-on reads
 * what changed back from the service rather than trusting what was sent.
 */
import { createHash, randomBytes } from 'node:crypto';
import { addonConnectionWebhook, executeCommand, findAddon, type Catalog } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { DeliveryProcessor } from '../deliveries';
import { workerMeta } from '../services';
import { connectionById, type AddonConnection } from './connections';
import { addonScope } from './context';
import type { AddonScopeContext, AddonWorkerModule } from './types';

/** The most one update may carry. */
export const ADDON_WEBHOOK_MAX_BYTES = 512 * 1024;

/** One thing a service says happened. */
export interface AddonWebhookUpdate {
  /** The service's own id for it: a replay is kept once. */
  readonly id: string;
  /** What kind of thing happened, in the service's words (`listing.updated`). */
  readonly kind: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** What arrived at a connection's address, for the receiver to check and read. */
export interface AddonWebhookRequest {
  /** The exact text that arrived: what a service signs. */
  readonly rawBody: string;
  /** Lowercased names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The address it was sent to (a service may sign that too). */
  readonly url: string;
}

/** An update kept for the add-on, as its receiver's `handle` gets it. */
export interface AddonWebhookContext extends AddonScopeContext {
  readonly connection: AddonConnection;
  readonly update: AddonWebhookUpdate & {
    /** The service's signature was checked. False: read what changed back from the service. */
    readonly signed: boolean;
    readonly receivedAt: Date;
  };
  /** 1 on the first try. */
  readonly attempt: number;
}

/** How an add-on reads one service's updates (its worker module's `webhooks`). */
export interface AddonWebhookReceiver {
  /**
   * Checks the service's signature with the connection's webhook secret (null when none was kept). Without one, the
   * address alone vouches for an update, which is kept unsigned.
   */
  readonly verify?: (request: AddonWebhookRequest, secret: string | null) => boolean;
  /** What the service says happened: one entry each. Empty: nothing to act on. Throws on what it can't read. */
  readonly parse: (request: AddonWebhookRequest) => readonly AddonWebhookUpdate[];
  /** Acts on one update. 'ignored' when there was nothing to do. Throwing tries it again later. */
  readonly handle: (ctx: AddonWebhookContext) => Promise<void | 'ignored'>;
}

/** An address's token: 32 random bytes, base64url. */
export const ADDON_WEBHOOK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const webhookTokenHash = (token: string) => createHash('sha256').update(token).digest();

/**
 * Gives one of the add-on's connections its own address for the service's updates, replacing any it had (the old
 * one stops working). `secret`: what the service signs with, when it gave one; 'generate' makes one to give it.
 */
export async function openConnectionWebhook(
  ctx: AddonScopeContext,
  connection: Pick<AddonConnection, 'id'>,
  opts: { readonly secret?: string | 'generate' } = {},
): Promise<{ readonly url: string; readonly secret: string | null }> {
  const token = randomBytes(32).toString('base64url');
  const secret =
    opts.secret === 'generate' ? randomBytes(32).toString('base64url') : (opts.secret ?? null);
  await executeCommand(
    ctx.db,
    addonConnectionWebhook,
    {
      workspaceId: ctx.scope.workspaceId,
      connectionId: connection.id,
      tokenHash: webhookTokenHash(token).toString('hex'),
      secretEnc: secret ? ctx.sealer.seal(secret) : null,
    },
    ctx.actor,
    ctx.meta,
  );
  return { url: `${ctx.publicUrl}/webhooks/addon/${token}`, secret };
}

/** The receiver for one connection's service, or null. */
export function receiverFor(
  modules: readonly AddonWorkerModule[],
  addonId: string,
  connector: string,
  provider: string,
): AddonWebhookReceiver | null {
  return modules.find((m) => m.manifest.id === addonId)?.webhooks?.[connector]?.[provider] ?? null;
}

/** Hands each kept update to its add-on's receiver (the delivery runner has already checked the add-on is on). */
export function addonDeliveryProcessor(
  catalog: Catalog,
  modules: readonly AddonWorkerModule[],
): DeliveryProcessor {
  return async (ctx) => {
    const d = ctx.delivery;
    const manifest = d.addonId ? findAddon(catalog, d.addonId) : undefined;
    if (!manifest || !d.workspaceId || !d.organizationId || !d.addonConnectionId) return 'ignored';
    const scope = { workspaceId: d.workspaceId, organizationId: d.organizationId };
    const [installed] = await asWorker(ctx.db, scope, (tx) =>
      rows<{ generation: number }>(
        tx,
        sql`select generation from app.addon_installations
            where workspace_id = ${d.workspaceId} and addon_id = ${manifest.id} and state = 'enabled'`,
      ),
    );
    if (!installed) return 'ignored';
    const addon = addonScope(ctx, manifest, scope, installed.generation, workerMeta(null, null));
    // Let go of since it arrived: nothing to act for.
    const connection = await connectionById(addon, d.addonConnectionId);
    if (!connection) return 'ignored';
    const receiver = receiverFor(modules, manifest.id, connection.connector, connection.provider);
    if (!receiver) return 'ignored';
    const update = (d.params as { update?: AddonWebhookUpdate }).update;
    if (!update) return 'ignored';
    return receiver.handle({
      ...addon,
      connection,
      update: { ...update, signed: d.signatureValid, receivedAt: d.receivedAt },
      attempt: ctx.attempt,
    });
  };
}
