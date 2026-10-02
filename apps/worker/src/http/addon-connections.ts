/**
 * An add-on's connections to other services (round five, 20261021000100): the worker's side of its Connections
 * screen, since only the worker may call a service or hold its key (the API refuses to start with one).
 *
 * - `POST /v1/addons/connections/key`: a key a business pasted for one of the things an add-on connects (its
 *   listing feed at Repliers, say). The add-on's worker half tries it with the service; only a key that works is
 *   sealed and kept, as the system acting for the person, and it replaces the add-on's own account there.
 *
 * **Who may** is the connector's own permission, in a business where the add-on is on. Letting a connection go is
 * `addon_connection.disconnect` through the API; the database checks the same permission.
 *
 * What a person pastes goes from the request into the tester and the sealer. Nothing here logs it, and nothing
 * sends it back.
 */
import {
  ADDON_CATALOG,
  addonConnectionCommands,
  connectorOf,
  executeCommand,
  HfosError,
  type Catalog,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectionRefused, type ConnectionTried } from '../addons/connections';
import { ADDON_WORKER_MODULES } from '../addons/modules';
import type { AddonWorkerModule } from '../addons/types';
import { systemActor, workerMeta } from '../services';
import { authenticate, parseBody, requirePermission, type HttpDeps } from './common';

/** How long a service gets to answer a key being tried. */
export const CONNECTION_TRY_MS = 15_000;

const slug = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const KeyInput = z.strictObject({
  workspaceId: z.uuid(),
  addonId: z.string().regex(/^[a-z]{2,16}$/),
  connector: slug,
  provider: slug,
  fields: z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/), z.string().max(4000)),
});

export interface AddonConnectionRouteOptions {
  /** The catalogue and worker modules (the real ones; tests give their own). */
  readonly catalog?: Catalog;
  readonly modules?: readonly AddonWorkerModule[];
}

export function registerAddonConnectionRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  opts: AddonConnectionRouteOptions = {},
): void {
  const catalog = opts.catalog ?? ADDON_CATALOG;
  const modules = opts.modules ?? ADDON_WORKER_MODULES;
  const { save } = addonConnectionCommands(catalog);

  /** Tries a pasted key with the service and, if it works, keeps it sealed. */
  app.post('/v1/addons/connections/key', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(KeyInput, req.body);
    const { connector, provider } = connectorOf(
      catalog,
      input.addonId,
      input.connector,
      input.provider,
    );
    const manifest = catalog.find((m) => m.id === input.addonId)!;
    const [on] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{ ok: boolean; organization_id: string | null }>(
        tx,
        sql`select private.addon_in_use(${input.workspaceId}::uuid, ${input.addonId}, false) as ok,
                   private.workspace_organization(${input.workspaceId}::uuid) as organization_id`,
      ),
    );
    if (!on?.organization_id)
      throw HfosError.notFound(
        'This workspace isn’t there anymore. Refresh the page and try again.',
      );
    if (!on.ok) throw HfosError.addonInactive(manifest);
    await requirePermission(deps, actor.userId, input.workspaceId, connector.permission);

    const tester = modules.find((m) => m.manifest.id === input.addonId)?.connectors?.[
      input.connector
    ]?.[input.provider];
    if (!provider.auth.includes('key') || !tester)
      throw HfosError.rule(
        'addon_connector_auth',
        409,
        `${provider.label} doesn’t connect with a key here. Use what its Connections offers.`,
      );

    // Only the fields the service asks for, each filled in; a secret one is never trimmed into something else.
    const fields: Record<string, string> = {};
    const missing: string[] = [];
    for (const f of provider.fields ?? []) {
      const v = input.fields[f.key];
      const value = f.secret ? v : v?.trim();
      if (!value?.trim()) missing.push(f.label);
      else fields[f.key] = value;
    }
    if (missing.length)
      throw HfosError.rule(
        'addon_connection_fields',
        400,
        `Fill in ${missing.join(' and ')}, from your ${provider.label} account, then connect again.`,
      );

    let tried: ConnectionTried;
    const signal = AbortSignal.timeout(CONNECTION_TRY_MS);
    try {
      tried = await tester(fields, { fake: deps.addonConnect?.fake ?? true, signal });
    } catch (e) {
      if (e instanceof ConnectionRefused)
        throw HfosError.rule('addon_connection_refused', 400, e.message);
      deps.log.warn(
        {
          addonId: input.addonId,
          connector: input.connector,
          provider: input.provider,
          err: e instanceof Error ? e.name : 'unknown',
        },
        'couldn’t reach a service to try a key',
      );
      throw HfosError.rule(
        'addon_connection_unreachable',
        502,
        `${provider.label} didn’t answer just now, so nothing was saved. Try again in a minute.`,
      );
    }

    const scope = { workspaceId: input.workspaceId, organizationId: on.organization_id };
    const { output } = await executeCommand(
      deps.httpDb,
      save,
      {
        workspaceId: input.workspaceId,
        addonId: input.addonId,
        connector: input.connector,
        provider: input.provider,
        auth: 'key',
        label: tried.label?.slice(0, 200) || null,
        accountRef: tried.accountRef?.slice(0, 200) || null,
        details: tried.details ?? {},
        secretEnc: deps.sealer.seal(JSON.stringify(fields)),
        keyId: deps.sealer.keyId,
        connectedBy: actor.userId,
      },
      systemActor(scope, actor.userId),
      workerMeta(),
    );
    return {
      connectionId: output.connectionId,
      provider: input.provider,
      label: tried.label ?? null,
      details: tried.details ?? {},
    };
  });
}
