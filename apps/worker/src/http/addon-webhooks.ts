/**
 * An add-on's webhooks (round five, 20261021000200): `POST /webhooks/addon/:token`, the address a connection gives
 * the service it connects to (addons/webhooks.ts, `openConnectionWebhook`).
 *
 * - **The address finds the connection** by its token's hash, and nothing else: an address that was replaced, or
 *   whose connection was let go, is a 404.
 * - **The add-on's receiver checks the signature** over the exact text that arrived, with the connection's webhook
 *   secret, where the service signs; one that doesn't check out is a 403 and nothing is kept.
 * - **Each update is kept once**, by the service's own id on that connection, then handled by the delivery runner,
 *   which sets it aside while the add-on is off in that business.
 *
 * The token is never logged or stored: the delivery keeps the address without it.
 */
import { ADDON_CATALOG, type Catalog } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { webhookDeliveries } from '@hfos/db/schema';
import type { FastifyInstance } from 'fastify';
import { ADDON_WORKER_MODULES } from '../addons/modules';
import type { AddonWorkerModule } from '../addons/types';
import {
  ADDON_WEBHOOK_MAX_BYTES,
  ADDON_WEBHOOK_TOKEN,
  receiverFor,
  webhookTokenHash,
  type AddonWebhookRequest,
  type AddonWebhookUpdate,
} from '../addons/webhooks';
import type { HttpDeps } from './common';

interface Route extends Record<string, unknown> {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly organization_id: string;
  readonly addon_id: string;
  readonly connector: string;
  readonly provider: string;
  readonly webhook_secret_enc: string | null;
}

export async function registerAddonWebhookRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  opts: { readonly catalog?: Catalog; readonly modules?: readonly AddonWorkerModule[] } = {},
): Promise<void> {
  const catalog = opts.catalog ?? ADDON_CATALOG;
  const modules = opts.modules ?? ADDON_WORKER_MODULES;
  const noAddress = { received: false };

  await app.register(async (hooks) => {
    // What a service signs is the exact text: every body stays the string that arrived, whatever its type.
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser(
      '*',
      { parseAs: 'string', bodyLimit: ADDON_WEBHOOK_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );

    hooks.post<{ Params: { token: string } }>(
      '/webhooks/addon/:token',
      { bodyLimit: ADDON_WEBHOOK_MAX_BYTES },
      async (req, reply) => {
        const { token } = req.params;
        if (!ADDON_WEBHOOK_TOKEN.test(token)) return reply.code(404).send(noAddress);
        const [route] = await asWorker(deps.httpDb, {}, (tx) =>
          rows<Route>(
            tx,
            sql`select connection_id, workspace_id, organization_id, addon_id, connector, provider,
                       webhook_secret_enc
                from private.addon_webhook_route(${webhookTokenHash(token)})`,
          ),
        );
        const receiver =
          route && catalog.some((m) => m.id === route.addon_id)
            ? receiverFor(modules, route.addon_id, route.connector, route.provider)
            : null;
        if (!route || !receiver) {
          deps.log.info('an add-on webhook for an address nobody has');
          return reply.code(404).send(noAddress);
        }
        const where = {
          addonId: route.addon_id,
          connector: route.connector,
          provider: route.provider,
          connectionId: route.connection_id,
        };

        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(req.headers))
          headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        const request: AddonWebhookRequest = {
          rawBody: typeof req.body === 'string' ? req.body : '',
          headers,
          url: `${deps.publicUrl}${req.url}`,
        };
        if (receiver.verify) {
          const secret = route.webhook_secret_enc
            ? deps.sealer.open(route.webhook_secret_enc)
            : null;
          if (!receiver.verify(request, secret)) {
            deps.log.warn(where, 'rejected an unsigned or mis-signed add-on webhook');
            return reply.code(403).type('text/plain').send('Invalid signature');
          }
        }

        let updates: readonly AddonWebhookUpdate[];
        try {
          updates = receiver.parse(request);
        } catch {
          deps.log.warn(where, 'an add-on webhook its receiver couldn’t read');
          return reply.code(400).send({ received: false });
        }
        // Without the service's own id it can't be kept once, so it isn't kept.
        const unnamed = updates.filter(
          (u) => typeof u.id !== 'string' || !u.id || u.id.length > 200,
        );
        if (unnamed.length) {
          deps.log.warn(
            { ...where, unnamed: unnamed.length },
            'add-on webhook updates without an id',
          );
          updates = updates.filter((u) => !unnamed.includes(u));
        }

        const scope = { workspaceId: route.workspace_id, organizationId: route.organization_id };
        const kept = updates.length
          ? await asWorker(deps.httpDb, scope, (tx) =>
              tx
                .insert(webhookDeliveries)
                .values(
                  updates.map((u) => ({
                    provider: 'addon',
                    kind: (u.kind || 'update').slice(0, 80),
                    // The service's own id, on this connection: a replay is kept once.
                    dedupeKey: `${route.connection_id}:${u.id}`.slice(0, 300),
                    url: `${deps.publicUrl}/webhooks/addon/…`,
                    params: { update: { id: u.id, kind: u.kind, data: u.data } },
                    signatureValid: !!receiver.verify,
                    workspaceId: route.workspace_id,
                    organizationId: route.organization_id,
                    addonId: route.addon_id,
                    addonConnectionId: route.connection_id,
                  })),
                )
                .onConflictDoNothing({
                  target: [webhookDeliveries.provider, webhookDeliveries.dedupeKey],
                })
                .returning({ id: webhookDeliveries.id }),
            )
          : [];
        return reply.code(200).send({ received: true, kept: kept.length });
      },
    );
  });
}
