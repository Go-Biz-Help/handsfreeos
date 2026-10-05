/**
 * Every add-on's server half, in the catalogue's order: the one list that puts an add-on's commands and queries into
 * the registry (`../server.ts`). Adding an add-on is one line here beside its manifest's line in `./catalog.ts`;
 * `pnpm addon:new <id>` writes both. A `planned` add-on has no module: it has no code yet.
 */
import type { AddonServerModule } from './server';
import { realestateAddonServer } from './realestate/server';
import { outreachAddonServer } from './outreach/server';

export const ADDON_SERVER_MODULES: readonly AddonServerModule[] = [
  realestateAddonServer,
  outreachAddonServer,
];
