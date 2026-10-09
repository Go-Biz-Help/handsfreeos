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
 *
 * and, when it has settings of its own to fill in, the form the Add-ons page draws for it:
 *
 *   pm: { icon: Building2, settings: () => import('./pm/settings') },
 */
import type { AddonSlotName } from '@hfos/core';
import type { ComponentType } from 'react';
import {
  House as realestateAddonIcon,
  ListChecks as realestateDutiesIcon,
  ListTodo as realestateTodoIcon,
  Radar as realestateCoordinateIcon,
  Settings2 as realestateSettingsIcon,
  Wrench as realestateVendorsIcon,
} from 'lucide-react';
import { Handshake as outreachAddonIcon } from 'lucide-react';

/** Any lucide icon, as the side menu draws its places. */
export type AddonIcon = ComponentType<{ className?: string; strokeWidth?: number }>;

/** Checks at compile time that every slot core has (ADDON_SLOTS) is below. */
type EverySlot<T extends Record<AddonSlotName, object>> = T;

/** What each slot hands its panels besides the business: the record the page is about. */
export type SlotEntities = EverySlot<{
  'person.panels': { readonly personId: string };
  'company.panels': { readonly companyId: string };
  'lead.panels': { readonly leadId: string; readonly personId: string | null };
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

/**
 * What an add-on's own settings form is drawn with, in its settings on the Add-ons page
 * (components/settings/add-ons/addon-settings-sheet.tsx). The sheet has already drawn the add-on's switches (its
 * manifest's `settings.flags`); the form is for everything else it lets a business or a person set. It is drawn only
 * while the add-on is on, inside its own error boundary, and its code is fetched the first time it's opened.
 */
export interface AddonSettingsProps {
  readonly workspaceId: string;
  /** The business's settings, or null when this person may not see them (the add-on's settings permission). */
  readonly settings: Readonly<Record<string, unknown>> | null;
  /** This person's own settings for the add-on. */
  readonly mySettings: Readonly<Record<string, unknown>>;
  /**
   * Saves the business's settings (`addon.save_settings`), checked against the manifest's `settings.workspace`.
   * A refusal is thrown as the API's error, field by field (`fieldErrors` in lib/api/field-errors.ts).
   */
  readonly saveSettings: (settings: Record<string, unknown>) => Promise<void>;
  /** Saves this person's own settings (`addon.save_my_settings`), checked against `settings.user`. */
  readonly saveMySettings: (settings: Record<string, unknown>) => Promise<void>;
}

/** An add-on's settings form, fetched the first time it's opened: `() => import('./<id>/settings')`. */
export type SettingsLoader = () => Promise<{ default: ComponentType<AddonSettingsProps> }>;

/**
 * An add-on's part of a customer's portal (`/c/<link>`, components/portal/): drawn only for a customer with records
 * of its kinds, inside the portal's shell, which hands it `usePortal()` (components/portal/context.tsx).
 */
export interface AddonPortalUi {
  /** Its part of the portal's Home: what's happening on their records, in a card or two. */
  readonly home?: () => Promise<{ default: ComponentType }>;
  /**
   * Its pages (`a/<id>/<path>`): one component for all of them, handed the path's parts. Only the paths the manifest
   * declares in `ui.portal` open; any other is the portal's not-found.
   */
  readonly pages: () => Promise<{ default: ComponentType<{ readonly path: readonly string[] }> }>;
  /** The icon of each of its places in the portal's menu, by the page's path. */
  readonly icons?: Readonly<Record<string, AddonIcon>>;
}

/** What the web knows about one add-on. */
/** What an add-on's public page is handed: where it is, and what its look-up answered. */
export interface AddonPublicPageProps {
  /** The booking site's name the page is under (`/a/<site>/…`). */
  readonly site: string;
  /** The manifest's page it is (`:slug/open-house/:openHouseId`), and what each `:name` was. */
  readonly page: string;
  readonly params: Readonly<Record<string, string>>;
  /** What the page's public query answered: the add-on's own shape. */
  readonly result: unknown;
  readonly business: { readonly name: string; readonly timeZone: string };
  readonly botCheck: { readonly siteKey: string | null } | null;
}

/**
 * An add-on's public pages (`/a/<site>/<id>/<path>`, Real Estate round three): what anyone with the link sees. The
 * web's server reads the public query the manifest's `ui.public` names for the path, and hands the answer to one
 * component for all of them. Only the paths the manifest declares open; any other is the 404 page.
 */
export interface AddonPublicUi {
  readonly pages: () => Promise<{ default: ComponentType<AddonPublicPageProps> }>;
  /** The page's title in the browser tab, from the same answer. */
  readonly title?: (props: AddonPublicPageProps) => string;
}

export interface AddonUi {
  /** Its row in the side menu, and its card on the Add-ons page. */
  readonly icon: AddonIcon;
  /** A different icon for one of its pages in the side menu, by that page's key in the manifest's `ui.nav`. */
  readonly navIcons?: Readonly<Record<string, AddonIcon>>;
  /** Its panels on core pages. One is drawn only where the manifest declares the slot too (`ui.slots`). */
  readonly slots?: { readonly [S in AddonSlotName]?: SlotLoader<S> };
  /** Its own settings form on the Add-ons page, beside its switches. Absent: its switches are all there is. */
  readonly settings?: SettingsLoader;
  /** Its pages in a customer's portal. */
  readonly portal?: AddonPortalUi;
  /** Its public pages, for anyone with the link. */
  readonly public?: AddonPublicUi;
  /**
   * Where it shows its connections (round five), as a path under its own pages (`a/<id>/<path>`). A sign-in comes back
   * to core's `addons/<id>/connections`, which sends the person on to here. Absent: core's page shows them.
   */
  readonly connections?: string;
}

/** Every add-on's UI, by add-on id. */
export const ADDON_UI: Readonly<Record<string, AddonUi>> = {
  realestate: {
    icon: realestateAddonIcon,
    navIcons: {
      duties: realestateDutiesIcon,
      coordinate: realestateCoordinateIcon,
      vendors: realestateVendorsIcon,
      settings: realestateSettingsIcon,
    },
    slots: {
      'person.panels': () => import('./realestate/person-panel'),
      'company.panels': () => import('./realestate/company-panel'),
      'lead.panels': () => import('./realestate/lead-panel'),
      'record.panels': () => import('./realestate/record-panel'),
    },
    settings: () => import('./realestate/settings-link'),
    connections: 'settings?tab=connections',
    portal: {
      home: () => import('./realestate/portal/home-panel'),
      pages: () => import('./realestate/portal/pages'),
      icons: { homes: realestateAddonIcon, todo: realestateTodoIcon },
    },
    public: {
      pages: () => import('./realestate/public/pages'),
      // The home's street, then the business: what the tab and a shared link show.
      title: (p) => {
        const street = (p.result as { street?: string } | null)?.street;
        return street ? `${street} · ${p.business.name}` : p.business.name;
      },
    },
  },
  outreach: {
    icon: outreachAddonIcon,
    slots: { 'person.panels': () => import('./outreach/person-panel') },
  },
};
