/**
 * Values an add-on keeps sealed (round seven): the worker's side, since only it holds the key.
 *
 * - `POST /v1/addons/sealed`: a value a person typed (a lockbox's code), sealed for this business, add-on and value,
 *   and handed back to go in the add-on's command. Who may is the manifest's `permission`.
 * - `POST /v1/addons/sealed/reveal`: one shown again, to someone with the manifest's `reveal` who can see the record
 *   it's on, and kept in that record's history as viewed (`addon_sealed.viewed`).
 *
 * What a person types goes from the request into the sealer. Nothing here logs it.
 */
import {
  ADDON_CATALOG,
  addonSealedCommands,
  executeCommand,
  HfosError,
  sealedOf,
  type Catalog,
} from '@hfos/core/server';
import { asUser, asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ADDON_WORKER_MODULES } from '../addons/modules';
import { openSealed, sealFor, SealedMismatch } from '../addons/sealed';
import type { AddonWorkerModule } from '../addons/types';
import { systemActor, workerMeta } from '../services';
import { authenticate, parseBody, requirePermission, type HttpDeps } from './common';

const addonId = z.string().regex(/^[a-z]{2,16}$/);
const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const SealInput = z.strictObject({
  workspaceId: z.uuid(),
  addonId,
  key,
  value: z.string().trim().min(1).max(500),
});
const RevealInput = z.strictObject({
  workspaceId: z.uuid(),
  addonId,
  key,
  recordId: z.uuid(),
  itemId: z.uuid(),
});

export interface AddonSealedRouteOptions {
  readonly catalog?: Catalog;
  readonly modules?: readonly AddonWorkerModule[];
}

export function registerAddonSealedRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  opts: AddonSealedRouteOptions = {},
): void {
  const catalog = opts.catalog ?? ADDON_CATALOG;
  const modules = opts.modules ?? ADDON_WORKER_MODULES;
  const { viewed } = addonSealedCommands(catalog);

  /** The add-on is on in the business: its organization, or a refusal saying what's wrong. */
  const inUse = async (workspaceId: string, id: string) => {
    const manifest = catalog.find((m) => m.id === id);
    if (!manifest)
      throw HfosError.rule('addon_sealed_unknown', 404, 'That add-on isn’t one HandsFreeOS has.');
    const [on] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{ ok: boolean; organization_id: string | null }>(
        tx,
        sql`select private.addon_in_use(${workspaceId}::uuid, ${id}, false) as ok,
                   private.workspace_organization(${workspaceId}::uuid) as organization_id`,
      ),
    );
    if (!on?.organization_id)
      throw HfosError.notFound(
        'This workspace isn’t there anymore. Refresh the page and try again.',
      );
    if (!on.ok) throw HfosError.addonInactive(manifest);
    return on.organization_id;
  };

  app.post('/v1/addons/sealed', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(SealInput, req.body);
    const declared = sealedOf(catalog, input.addonId, input.key);
    await inUse(input.workspaceId, input.addonId);
    await requirePermission(deps, actor.userId, input.workspaceId, declared.permission);
    return { sealed: sealFor(deps.sealer, input, input.value) };
  });

  app.post('/v1/addons/sealed/reveal', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(RevealInput, req.body);
    const declared = sealedOf(catalog, input.addonId, input.key);
    const organizationId = await inUse(input.workspaceId, input.addonId);
    await requirePermission(deps, actor.userId, input.workspaceId, declared.reveal);
    // The record as the person sees it: a private one they're not on isn't there for them.
    const [seen] = await asUser(deps.httpDb, actor.claims, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from app.custom_records
            where id = ${input.recordId}::uuid and workspace_id = ${input.workspaceId}::uuid`,
      ),
    );
    if (!seen)
      throw HfosError.notFound(
        'That record isn’t one you can see anymore. Ask an owner of this business if you need it.',
      );
    const reader = modules.find((m) => m.manifest.id === input.addonId)?.sealed?.[input.key];
    const scope = { workspaceId: input.workspaceId, organizationId };
    const sealed = reader ? await asWorker(deps.httpDb, scope, (tx) => reader(tx, input)) : null;
    if (!sealed)
      throw HfosError.rule(
        'addon_sealed_none',
        404,
        `No ${declared.label.toLowerCase()} is saved here yet. Add it, and it’s kept locked.`,
      );
    let value: string;
    try {
      value = openSealed(deps.sealer, sealed, input);
    } catch (e) {
      if (!(e instanceof SealedMismatch)) throw e;
      deps.log.warn({ addonId: input.addonId, key: input.key }, 'a sealed value didn’t open');
      throw HfosError.rule(
        'addon_sealed_unopened',
        409,
        `The ${declared.label.toLowerCase()} saved here couldn’t be opened. Type it again to save it.`,
      );
    }
    await executeCommand(
      deps.httpDb,
      viewed,
      {
        workspaceId: input.workspaceId,
        addonId: input.addonId,
        key: input.key,
        recordId: input.recordId,
        itemId: input.itemId,
        viewedBy: actor.userId,
      },
      systemActor(scope, actor.userId),
      workerMeta(),
    );
    return { value };
  });
}
