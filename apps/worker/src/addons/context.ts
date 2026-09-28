import {
  addonRef,
  type AddonManifest,
  type RequestMeta,
  type SystemActor,
} from '@hfos/core/server';
import { systemActor, type TenantScope, type WorkerServices } from '../services';
import type { AddonScopeContext } from './types';

/** The system acting for an add-on in one business: refused by the kernel while it's off, and named in history. */
export const addonActor = (scope: TenantScope, manifest: AddonManifest): SystemActor => ({
  ...systemActor(scope),
  addon: addonRef(manifest),
});

/** Everything an add-on's worker code is handed, for one business. */
export function addonScope(
  services: WorkerServices,
  manifest: AddonManifest,
  scope: TenantScope,
  generation: number,
  meta: RequestMeta,
): AddonScopeContext {
  return {
    ...services,
    manifest,
    scope,
    generation,
    meta,
    actor: addonActor(scope, manifest),
    log: services.log.child({ addon: manifest.id, workspaceId: scope.workspaceId }),
  };
}
