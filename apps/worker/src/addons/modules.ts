/**
 * Every add-on's worker half, in the catalogue's order: one line per add-on that has one (`apps/worker/src/addons/
 * <id>/index.ts`), added by the generator (`pnpm addon:new`). An add-on that only has screens and commands needs no
 * line here. None exists yet.
 */
import type { AddonWorkerModule } from './types';
import { realestateAddonWorker } from './realestate/index';

export const ADDON_WORKER_MODULES: readonly AddonWorkerModule[] = [realestateAddonWorker];
