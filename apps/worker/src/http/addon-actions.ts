/**
 * An add-on's worker actions (round five, step 7): `POST /v1/addons/:addonId/actions/:name`, for something a person
 * needs from a service the add-on is connected to right now, which only the worker can ask (it holds the keys): a
 * DocuSign envelope's page to place fields on, say. Each is its worker module's `actions[name]`.
 *
 * The add-on must be on in the business and the person must hold the action's permission. The action runs as the
 * system acting for the add-on, on the person's behalf; what it changes, it changes through the kernel as any of the
 * add-on's work does. Nothing here is in the API or its OpenAPI.
 */
import { ADDON_CATALOG, HfosError, type Catalog } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addonScope } from '../addons/context';
import { ADDON_WORKER_MODULES } from '../addons/modules';
import type { AddonWorkerModule } from '../addons/types';
import { workerMeta } from '../services';
import { authenticate, parseBody, requirePermission, type HttpDeps } from './common';

const Body = z.strictObject({
  workspaceId: z.uuid(),
  input: z.record(z.string(), z.unknown()).default({}),
});

export function registerAddonActionRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  opts: { readonly catalog?: Catalog; readonly modules?: readonly AddonWorkerModule[] } = {},
): void {
  const catalog = opts.catalog ?? ADDON_CATALOG;
  const modules = opts.modules ?? ADDON_WORKER_MODULES;
  const noSuchAction = () =>
    HfosError.notFound('That add-on can’t do that here. Refresh the page and try again.');

  app.post<{ Params: { addonId: string; name: string } }>(
    '/v1/addons/:addonId/actions/:name',
    async (req) => {
      const actor = await authenticate(deps, req);
      const body = parseBody(Body, req.body);
      const { addonId, name } = req.params;
      const manifest = catalog.find((m) => m.id === addonId);
      const action = modules.find((m) => m.manifest.id === addonId)?.actions?.[name];
      if (!manifest || !action) throw noSuchAction();
      const [on] = await asWorker(deps.httpDb, { workspaceId: body.workspaceId }, (tx) =>
        rows<{ ok: boolean; organization_id: string | null; generation: number | null }>(
          tx,
          sql`select private.addon_in_use(${body.workspaceId}::uuid, ${addonId}, false) as ok,
                     private.workspace_organization(${body.workspaceId}::uuid) as organization_id,
                     (select i.generation from app.addon_installations i
                      where i.workspace_id = ${body.workspaceId}::uuid and i.addon_id = ${addonId}) as generation`,
        ),
      );
      if (!on?.organization_id)
        throw HfosError.notFound(
          'This workspace isn’t there anymore. Refresh the page and try again.',
        );
      if (!on.ok) throw HfosError.addonInactive(manifest);
      await requirePermission(deps, actor.userId, body.workspaceId, action.permission);
      const input = parseBody(action.input, body.input);
      const scope = { workspaceId: body.workspaceId, organizationId: on.organization_id };
      const ctx = addonScope(deps, manifest, scope, on.generation ?? 1, workerMeta());
      return action.run(
        { ...ctx, actor: { ...ctx.actor, onBehalfOf: actor.userId }, userId: actor.userId },
        input,
      );
    },
  );
}
