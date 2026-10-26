/**
 * Running one of an add-on's worker actions for a person (docs/addon-architecture.md, "Its worker actions"). The one
 * door, for the route a screen calls (http/addon-actions.ts) and for the Assistant (assistant/tools-addons.ts): the
 * add-on must be on in the business, the person must hold the action's permission, and the input is the action's
 * own, parsed here once. The action runs as the system acting for the add-on, on the person's behalf.
 */
import { HfosError, type AddonManifest, type RequestMeta } from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import { workerMeta, type WorkerServices } from '../services';
import { addonScope } from './context';
import type { AddonWorkerAction } from './types';

export interface AddonActionCall {
  readonly manifest: AddonManifest;
  readonly action: AddonWorkerAction;
  readonly workspaceId: string;
  readonly userId: string;
  readonly input: unknown;
  /** Defaults to a fresh one; the Assistant passes its run's, so what the action changes ties back to it. */
  readonly meta?: RequestMeta;
}

/** Runs it, or refuses: the business is gone, the add-on is off, the person may not, or the input doesn't fit. */
export async function runAddonAction(
  services: WorkerServices,
  /** Where the checks are read: the HTTP pool, for the routes and the Assistant alike. */
  db: Db,
  call: AddonActionCall,
): Promise<unknown> {
  const { manifest, action, workspaceId, userId } = call;
  const [on] = await asWorker(db, { workspaceId }, (tx) =>
    rows<{
      ok: boolean;
      organization_id: string | null;
      generation: number | null;
      allowed: boolean;
    }>(
      tx,
      sql`select private.addon_in_use(${workspaceId}::uuid, ${manifest.id}, false) as ok,
                 private.workspace_organization(${workspaceId}::uuid) as organization_id,
                 (select i.generation from app.addon_installations i
                  where i.workspace_id = ${workspaceId}::uuid and i.addon_id = ${manifest.id}) as generation,
                 private.user_has_permission(${userId}, ${workspaceId}, ${action.permission}) as allowed`,
    ),
  );
  if (!on?.organization_id)
    throw HfosError.notFound('This workspace isn’t there anymore. Refresh the page and try again.');
  if (!on.ok) throw HfosError.addonInactive(manifest);
  if (!on.allowed) throw HfosError.forbidden();
  const parsed = action.input.safeParse(call.input);
  if (!parsed.success)
    throw HfosError.validation(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  const scope = { workspaceId, organizationId: on.organization_id };
  const ctx = addonScope(services, manifest, scope, on.generation ?? 1, call.meta ?? workerMeta());
  return action.run({ ...ctx, actor: { ...ctx.actor, onBehalfOf: userId }, userId }, parsed.data);
}
