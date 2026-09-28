/**
 * The web's list of add-ons (0108, docs/addon-readiness-audit.md §5): for each add-on in the catalogue that draws
 * anything, its icon and the panels it puts on core pages — metadata and lazy loaders only. Explicit, like the
 * catalogue it follows (packages/core/src/addons/catalog.ts): nothing joins by being imported, and a panel's code
 * is fetched only when a page draws its slot while the add-on runs (components/addons/slot.tsx).
 *
 * This is the one file outside an add-on that imports from an add-on's folder (`apps/web/src/addons/<id>/…`).
 * The shell, core's screens and other add-ons reach an add-on only through here — a lint rule in eslint.config.js
 * holds them to it — so an add-on that is off, or taken out of the codebase, leaves nothing behind in them. An
 * add-on's own pages live at `app/app/w/[workspaceId]/a/<id>/…`, import its folder, and open through the gate
 * (./gate.tsx).
 *
 * Adding one is a line keyed by its id, once its manifest is in the catalogue:
 *
 *   pm: { icon: Building2, slots: { 'person.panels': () => import('./pm/person-panel') } },
 */
import type { AddonSlotName } from '@hfos/core';
import type { ComponentType } from 'react';

/** Any lucide icon, as the side menu draws its places. */
export type AddonIcon = ComponentType<{ className?: string; strokeWidth?: number }>;

/** Checks at compile time that every slot core has (ADDON_SLOTS) is below. */
type EverySlot<T extends Record<AddonSlotName, object>> = T;

/** What each slot hands its panels besides the business: the record the page is about. */
export type SlotEntities = EverySlot<{
  'person.panels': { readonly personId: string };
  'company.panels': { readonly companyId: string };
  /** A record of one of the business's own kinds; `recordTypeKey` says which (`pm_property` for an add-on's). */
  'record.panels': {
    readonly recordId: string;
    readonly recordTypeId: string;
    readonly recordTypeKey: string;
  };
  'conversation.panels': { readonly conversationId: string };
  'home.cards': object;
}>;

/** What a panel in slot `S` is drawn with. */
export type SlotProps<S extends AddonSlotName = AddonSlotName> = {
  readonly workspaceId: string;
} & SlotEntities[S];

/** A panel's code, fetched the first time it's drawn: `() => import('./<id>/<panel>')`. */
export type SlotLoader<S extends AddonSlotName = AddonSlotName> = () => Promise<{
  default: ComponentType<SlotProps<S>>;
}>;

/** What the web knows about one add-on. */
export interface AddonUi {
  /** Its places in the side menu. */
  readonly icon: AddonIcon;
  /** A different icon for one of its places, by that place's key in the manifest's `ui.nav`. */
  readonly navIcons?: Readonly<Record<string, AddonIcon>>;
  /** Its panels on core pages. One is drawn only where the manifest declares the slot too (`ui.slots`). */
  readonly slots?: { readonly [S in AddonSlotName]?: SlotLoader<S> };
}

/** Every add-on's UI, by add-on id. None yet: the first add-on adds the first line. */
export const ADDON_UI: Readonly<Record<string, AddonUi>> = {};
