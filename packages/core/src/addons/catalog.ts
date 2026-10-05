/**
 * The add-on catalogue: every add-on HandsFreeOS knows about, built or planned, as its manifest. This is the one
 * list the kernel, the lifecycle commands, the screens and the AI read; nothing else keeps its own.
 *
 * Adding an add-on is one line in `BUILT_ADDONS` (browser-safe manifest), one in `./modules.ts` (its commands and
 * queries) and, when it has them, one in the worker's and the web's lists — `pnpm addon:new <id>` writes all of them.
 * A `planned` add-on is a manifest with no code (./planned.ts): it lets "what is coming" be answered, and businesses
 * vote on it, without it ever being offered.
 *
 * Kept deliberately explicit: no add-on registers itself as a side effect of being imported (the package is
 * `sideEffects: false`), so what ships is exactly what is listed.
 */
import type { Catalog } from './graph';
import type { AddonManifest } from './manifest';
import { PLANNED_ADDONS } from './planned';
import { realestateAddon } from './realestate/manifest';
import { outreachAddon } from './outreach/manifest';

/** The add-ons with code: one line each, which `pnpm addon:new` writes. */
export const BUILT_ADDONS: Catalog = [realestateAddon, outreachAddon];

/**
 * Every add-on: the built ones, then every planned one (./planned.ts) that isn't built yet. Building a planned one
 * starts it under the same id, and its manifest takes the planned one's place here.
 */
export const ADDON_CATALOG: Catalog = [
  ...BUILT_ADDONS,
  ...PLANNED_ADDONS.filter((p) => !BUILT_ADDONS.some((m) => m.id === p.id)),
];

/**
 * One add-on's manifest, from the catalogue: its worker and web halves take it from here, so every layer holds the
 * very same one (the worker refuses a module whose manifest isn't the catalogue's).
 */
export function catalogAddon(id: string): AddonManifest {
  const found = ADDON_CATALOG.find((m) => m.id === id);
  if (!found) throw new Error(`${id} isn't in the add-on catalogue`);
  return found;
}
