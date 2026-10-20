/**
 * The Settings menu's pages, in its groups (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Web: Settings search"). Moved
 * here from the web's settings-nav.tsx unchanged, so the menu, settings search on the web and the phone, and the
 * Assistant's map all read one list. Browser-safe; the web keeps each page's icon beside it, keyed by `key`.
 *
 * The groups are in the order a business owner looks for things: themselves first, then the business, then how it
 * talks to customers, what it keeps about them, how they book and pay, and last bringing data across, which is done
 * once. Everyone has their account and their calendar; each of the business's own pages shows for whoever may change
 * what is on it, as the business has set that up (0106), and a group with none of them doesn't show.
 *
 * Add-ons is never one of these pages: it sits at the foot of the side menu (the owner's decision, 2026-09-28), and
 * an add-on's own settings are found under its own name.
 */
import { ADDON_CATALOG } from '../addons/catalog';
import { coreFeatureHeld, coreFeatureRunning } from '../addons/capabilities';
import type { CoreFeature } from '../addons/manifest';
import { PARTNERS_WORDS } from '../partners/business-words';
import type { WorkspacePermission } from '../permissions';

export interface SettingsPage {
  readonly key: string;
  /** Under /app/w/<business>/settings: '' for Account. */
  readonly path: string;
  readonly label: string;
  /** Marked in the menu only on this very page, not on the pages under it. */
  readonly exact?: boolean;
  readonly needs?: WorkspacePermission;
  /** A part of core only some add-ons use: shown only while one of them is on (the main offer, partners). */
  readonly feature?: CoreFeature;
}

export const SETTINGS_GROUPS = [
  {
    label: 'Your account',
    items: [
      { key: 'account', path: '', label: 'Account', exact: true },
      { key: 'my_calendar', path: '/my-calendar', label: 'My calendar' },
    ],
  },
  {
    label: 'Business',
    items: [
      { key: 'workspace', path: '/workspace', label: 'Workspace', needs: 'workspace.update' },
      { key: 'main_offer', path: '/main-offer', label: 'Main offer', feature: 'main_offer' },
      // Who may do what: only an owner sets it.
      {
        key: 'permissions',
        path: '/permissions',
        label: 'Permissions',
        needs: 'permissions.manage',
      },
      { key: 'automations', path: '/automations', label: 'Automations', needs: 'workspace.update' },
      // Check-ins (round six): the business's times and its safety person. Each person's own contacts are on their
      // Safety page, never here.
      { key: 'safety', path: '/safety', label: 'Safety', needs: 'workspace.update' },
      // Named apart from Payments, and kept in another group, on purpose: Payments is the business's own customers
      // paying *them*, and this is what the business pays HandsFreeOS. Two things, two names.
      { key: 'usage', path: '/usage', label: 'Usage & balance', needs: 'money.manage' },
    ],
  },
  {
    label: 'Messages',
    items: [
      { key: 'texting', path: '/texting', label: 'Texting & calls', needs: 'channels.manage' },
      { key: 'email', path: '/email', label: 'Email', needs: 'channels.manage' },
      {
        key: 'website_chat',
        path: '/website-chat',
        label: 'Website chat',
        needs: 'channels.manage',
      },
      // Messenger and Instagram direct messages, through the business's Facebook Page (20261025000200).
      {
        key: 'facebook_instagram',
        path: '/facebook-instagram',
        label: 'Facebook & Instagram',
        needs: 'channels.manage',
      },
      // Beside the channels, because that is what it is for: the wording they send on them.
      { key: 'templates', path: '/templates', label: 'Templates', needs: 'templates.manage' },
      // After the channels: what happens when someone new arrives on any of them.
      { key: 'lead_intake', path: '/lead-intake', label: 'Lead intake', needs: 'channels.manage' },
    ],
  },
  {
    label: 'Customers',
    items: [
      { key: 'pipelines', path: '/pipelines', label: 'Pipelines', needs: 'pipelines.manage' },
      // The business's tags, and the AI putting them on every customer (0107).
      { key: 'tags', path: '/tags', label: 'Tags', needs: 'tags.manage' },
      // What a business keeps about its customers: its own fields, and its own kinds of records (pets, vehicles,
      // properties) with how they relate.
      { key: 'fields', path: '/fields', label: 'Fields', needs: 'fields.manage' },
      {
        key: 'relationships',
        path: '/relationships',
        label: 'Relationships',
        needs: 'fields.manage',
      },
      // Customers, conversations and bookings deleted for good, for their 30 days (20261027000400).
      { key: 'deleted_bin', path: '/deleted-bin', label: 'Deleted bin', needs: 'records.delete' },
    ],
  },
  {
    label: 'Bookings & payments',
    items: [
      { key: 'calendars', path: '/calendars', label: 'Calendars', needs: 'calendars.manage' },
      // Payments is exact so its own Products page is the only one marked while you're on it.
      { key: 'payments', path: '/payments', label: 'Payments', exact: true, needs: 'money.manage' },
      { key: 'products', path: '/payments/products', label: 'Products', needs: 'money.manage' },
      {
        key: 'partners',
        path: '/partners',
        label: PARTNERS_WORDS.menu,
        needs: 'partners.manage',
        feature: 'partners',
      },
    ],
  },
  {
    label: 'Bring data in',
    items: [
      { key: 'imports', path: '/imports', label: 'Imports', needs: 'records.import' },
      // Its own page, not a tab inside Imports: that page lists spreadsheets, and this moves a whole business across
      // from another system.
      {
        key: 'migrations',
        path: '/migrations',
        label: 'Migrations',
        needs: 'migrations.manage',
      },
    ],
  },
] as const satisfies readonly {
  readonly label: string;
  readonly items: readonly SettingsPage[];
}[];

export type SettingsPageKey = (typeof SETTINGS_GROUPS)[number]['items'][number]['key'];

/** Every page, in menu order, with the group it's in. */
export const SETTINGS_PAGES: readonly (SettingsPage & {
  readonly key: SettingsPageKey;
  readonly group: string;
})[] = SETTINGS_GROUPS.flatMap((g) => g.items.map((p) => ({ ...p, group: g.label })));

/** One page by its key. */
export function settingsPage(key: SettingsPageKey): (typeof SETTINGS_PAGES)[number] {
  return SETTINGS_PAGES.find((p) => p.key === key)!;
}

/** Who is asking, for what they may see: their permissions, and the add-ons running here. */
export interface SettingsViewer {
  readonly permissions: readonly string[];
  /**
   * The add-ons running in the business. The phone has no list with no signal and passes null: a part of core shows
   * when they hold a permission of an add-on that uses it, since those are only theirs while it runs.
   */
  readonly addons: readonly string[] | null;
}

/** Whether a part of core some add-ons use is here for this person. */
export function settingsFeatureHere(viewer: SettingsViewer, feature: CoreFeature): boolean {
  return viewer.addons
    ? coreFeatureRunning(ADDON_CATALOG, viewer.addons, feature)
    : coreFeatureHeld(ADDON_CATALOG, viewer.permissions, feature);
}

/** Whether a page is in this person's menu: they may change what's on it, and its part of core is here. */
export function settingsPageShown(
  page: Pick<SettingsPage, 'needs' | 'feature'>,
  viewer: SettingsViewer,
): boolean {
  return (
    (!page.needs || viewer.permissions.includes(page.needs)) &&
    (!page.feature || settingsFeatureHere(viewer, page.feature))
  );
}

/** The menu as this person sees it: each group with the pages they may open, and no group left empty. */
export function settingsGroupsFor(viewer: SettingsViewer): {
  readonly label: string;
  readonly items: readonly (typeof SETTINGS_PAGES)[number][];
}[] {
  return SETTINGS_GROUPS.map((g) => ({
    label: g.label,
    items: SETTINGS_PAGES.filter((p) => p.group === g.label && settingsPageShown(p, viewer)),
  })).filter((g) => g.items.length > 0);
}

/** A page's address: `/app/w/<business>/settings/texting`. */
export function settingsPageHref(workspaceId: string, page: Pick<SettingsPage, 'path'>): string {
  return `/app/w/${workspaceId}/settings${page.path}`;
}
