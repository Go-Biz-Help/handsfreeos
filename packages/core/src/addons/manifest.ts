/**
 * Add-ons (docs/addon-architecture.md). An add-on is first-party code that ships with every deploy and is switched
 * on per business. This file is what an add-on says about itself: one browser-safe object that the kernel, the
 * lifecycle commands, the worker, the screens, the AI and the tests all read, so none of them keeps its own list.
 *
 * The manifest owns no behaviour. What runs lives beside it, layer by layer like every other feature: commands and
 * queries in `packages/core/src/addons/<id>/`, event subscribers and jobs in `apps/worker/src/addons/<id>/`, screens
 * in `apps/web/src/addons/<id>/`, tables in the add-on's own schema `addon_<id>`. Everything an add-on contributes
 * carries its id as a prefix (`pm.lease.create`, `pm_property`, `addon_pm`), so what it owns is always mechanical to
 * find, check and remove.
 */
import type { z } from 'zod';
import { RECORD_ICONS } from '../relationships/words';

/**
 * An add-on's id: 2 to 16 lowercase letters. Never reused and never renamed. Letters only, because it starts every
 * permission it adds, and a permission is letters, dots and underscores (`app.role_permissions`).
 */
export const ADDON_ID_PATTERN = /^[a-z]{2,16}$/;
export type AddonId = string;

/**
 * Ids no add-on may take: core's own first segments (a command named `lead.create` must never be mistaken for an
 * add-on's) and the words the platform uses for itself. `packages/core/test/addons/catalog.test.ts` also checks every
 * add-on id against the first segment of every core command and query.
 */
export const RESERVED_ADDON_IDS: ReadonlySet<string> = new Set([
  'addon',
  'addons',
  'app',
  'auth',
  'core',
  'org',
  'platform',
  'private',
  'public',
  'support',
  'system',
  'test',
  'workspace',
]);

/** `<domain>.<feature>`: `social.publish`, `crm.contacts`. An add-on's capabilities start with its own id. */
export type CapabilityId = `${string}.${string}`;
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

/**
 * Where an add-on is in its life, as the catalogue says. Only `available` may ever be recommended or installed by a
 * business on its own; `planned` has no code at all and is never offered, only listed as coming.
 */
export const CATALOG_STATUSES = [
  'planned',
  'development',
  'beta',
  'built',
  'available',
  'deprecated',
  'unavailable',
] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

/** Statuses a staff override may set in the database (`platform.addon_overrides`): only ever downwards. */
export const OVERRIDE_STATUSES = ['deprecated', 'unavailable'] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];

export const ADDON_CATEGORIES = [
  'sales',
  'marketing',
  'operations',
  'finance',
  'industry',
  'productivity',
  'ai',
] as const;
export type AddonCategory = (typeof ADDON_CATEGORIES)[number];

/** Something an add-on lets a business do, in the words a person and the AI read. */
export interface AddonCapability {
  readonly id: CapabilityId;
  /** "Schedule social posts". */
  readonly label: string;
  /** What it does, for discovery: the AI matches requests against this. */
  readonly description: string;
  /** The permission a person needs to use it. Absent: anyone who works in the business. */
  readonly permission?: string;
}

/** A permission an add-on adds. It exists for people only while the add-on is on in their business. */
export interface AddonPermission {
  /** `<id>.<verb>`, e.g. `pm.write`. */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Roles besides the owner that start with it. Owners always hold every permission of an add-on that is on. */
  readonly defaultRoles: readonly ('admin' | 'member')[];
  /** What it needs to mean anything: off whenever one of these is off. */
  readonly requires?: readonly string[];
  /** Whether a business may turn it on or off for a role or a person. Defaults to true. */
  readonly customizable?: boolean;
}

/** Another add-on this one uses. */
export interface AddonDependency {
  readonly addon: AddonId;
  /** required: it can't be on without it. optional: it uses it when it's on, and works without it. */
  readonly kind: 'required' | 'optional';
  /** Why, in a sentence a person reads when they're asked to turn both on or off. */
  readonly why: string;
}

/**
 * A kind of record the add-on keeps: a custom record kind it manages (a Property, a Lease). Its records are the
 * add-on's anchors: they get the timeline, tasks, files, appointments, relationships, fields and search every custom
 * record has, while the add-on's own table holds the rest of what it knows about each one.
 */
export interface AddonRecordKind {
  /** `<id>_<name>`, unique in a business, e.g. `pm_property`. */
  readonly key: string;
  readonly singular: string;
  readonly plural: string;
  /** What one's name is called on its page ("Address"). */
  readonly nameLabel?: string;
  /** One of core's RECORD_ICONS. */
  readonly icon?: string;
  /**
   * Who may add or change one (the add-on's own permission); reading follows records.read like every record.
   * Permanently deleting the add-on's data keeps each record's name and nothing else (the owner's decision,
   * 2026-09-28), so the tasks, files and timeline lines about one still say what it was.
   */
  readonly writePermission: string;
}

/** One end of a relationship type an add-on manages: a customer, a company, or one of its record kinds. */
export type AddonRelationshipEnd =
  | { readonly kind: 'person' }
  | { readonly kind: 'company' }
  | { readonly kind: 'record'; readonly recordKind: string };

/** A relationship type an add-on manages: Tenant ↔ Lease, Owner ↔ Property. */
export interface AddonRelationshipType {
  /** `<id>_<name>`, e.g. `pm_tenant`. */
  readonly key: string;
  readonly a: AddonRelationshipEnd;
  readonly aLabel: string;
  readonly b: AddonRelationshipEnd;
  readonly bLabel: string;
  readonly cardinality?: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
}

/** The places in core screens an add-on can put a panel. The app decides where each one sits. */
export const ADDON_SLOTS = [
  'person.panels',
  'company.panels',
  'record.panels',
  'conversation.panels',
  'home.cards',
] as const;
export type AddonSlotName = (typeof ADDON_SLOTS)[number];

/** A place in the side menu. The path is under the add-on's own pages, `/app/w/<workspace>/a/<id>/…`. */
export interface AddonNavItem {
  /** Unique within the add-on; the menu keeps it as `addon:<id>:<key>`. */
  readonly key: string;
  readonly label: string;
  /** A lucide icon name the web registry maps. */
  readonly icon: string;
  /** Relative to the add-on's pages: '' for its first page, 'leases' for `/a/<id>/leases`. */
  readonly path: string;
  /** Who sees it. Absent: everyone who holds any of the add-on's permissions. */
  readonly permission?: string;
}

export interface AddonSettingsDeclaration {
  /** The business's settings, checked on every save. Stored in `app.addon_installations.settings`. */
  readonly workspace?: z.ZodType;
  /** Each person's own settings, stored in `app.addon_user_settings`. */
  readonly user?: z.ZodType;
  /** The settings' shape; the worker upgrades stored settings from older versions when the add-on comes back. */
  readonly version: number;
  /** Who may change the business's settings. Defaults to `addons.manage`. */
  readonly permission?: string;
  /** On/off switches with a default, kept per business in `app.addon_installations.flags`. */
  readonly flags?: Readonly<Record<string, { readonly label: string; readonly default: boolean }>>;
}

/** What an add-on costs is never here: only what it counts, so any pricing can be built on top later. */
export interface AddonBilling {
  /** `free` installs on its own; `paid` needs billing, which does not exist yet, so only staff can grant it. */
  readonly model: 'free' | 'paid';
  readonly meters?: readonly {
    readonly key: string;
    readonly unit: string;
    readonly label: string;
  }[];
}

export interface AddonManifest {
  readonly id: AddonId;
  readonly name: string;
  /** One line for the catalogue, the AI's directory and recommendations. */
  readonly summary: string;
  readonly description: string;
  readonly category: AddonCategory;
  /** The code's version (semver). Recorded on every install and on every event the add-on causes. */
  readonly version: string;
  /**
   * The shape of the add-on's stored data. Bump it with a data migration (the worker module's `migrations`) when rows
   * an older version wrote need changing; reinstalling runs every migration from the version the business was on.
   */
  readonly dataVersion: number;
  readonly catalog: {
    readonly status: CatalogStatus;
    /** Words people use for what it does, for matching a request to it. Never shown as an advert. */
    readonly keywords: readonly string[];
    /** Things someone might ask for that it does ("schedule my posts for next month"). */
    readonly exampleNeeds?: readonly string[];
    readonly industries?: readonly string[];
    /** A deprecated add-on's replacement. */
    readonly replacedBy?: AddonId;
  };
  readonly capabilities: readonly AddonCapability[];
  readonly permissions: readonly AddonPermission[];
  readonly requires?: readonly AddonDependency[];
  readonly recordKinds?: readonly AddonRecordKind[];
  readonly relationshipTypes?: readonly AddonRelationshipType[];
  /** Tables in its own schema `addon_<id>`, listed so purge and the database checks can find them. */
  readonly tables?: readonly string[];
  /** Event types it emits (`<id>.*`) and consumes (core's or a declared dependency's). */
  readonly events?: {
    readonly emits?: readonly string[];
    readonly consumes?: readonly string[];
  };
  /** Job kinds it queues (`<id>.*`). */
  readonly jobs?: readonly string[];
  /** Kinds of things it holds outside HandsFreeOS (`<id>.page_subscription`), released on uninstall. */
  readonly resources?: readonly string[];
  readonly settings?: AddonSettingsDeclaration;
  readonly ui?: {
    readonly nav?: readonly AddonNavItem[];
    readonly slots?: readonly { readonly slot: AddonSlotName; readonly permission?: string }[];
  };
  /** One line the AI reads while the add-on is on: what its tools cover ("properties, units, leases, rent"). */
  readonly ai?: { readonly directory: string };
  readonly billing: AddonBilling;
  /** Ids this version renamed (capabilities, permissions): old → new, applied to what a business stored. */
  readonly renamed?: Readonly<Record<string, string>>;
}

/** Declares an add-on. Identity at runtime: validation happens in tests (`manifestIssues`, `catalogIssues`). */
export function defineAddon<const M extends AddonManifest>(manifest: M): M {
  return manifest;
}

/** One thing wrong with a manifest or a catalogue, for the tests to print. */
export interface AddonIssue {
  readonly addon: AddonId;
  readonly message: string;
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/;
const KEY_UNDER = (id: string) => new RegExp(`^${id}_[a-z][a-z0-9_]{0,38}$`);
const DOTTED_UNDER = (id: string) => new RegExp(`^${id}(\\.[a-z][a-z_]*)+$`);
const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Everything wrong with one manifest on its own. An empty list is a valid manifest. */
export function manifestIssues(m: AddonManifest): AddonIssue[] {
  const issues: string[] = [];
  const say = (message: string) => issues.push(message);
  if (!ADDON_ID_PATTERN.test(m.id)) say(`id "${m.id}" must be 2–16 lowercase letters`);
  if (RESERVED_ADDON_IDS.has(m.id)) say(`id "${m.id}" is reserved`);
  if (!m.name.trim() || m.name.length > 60) say('name must be 1–60 characters');
  if (!m.summary.trim() || m.summary.length > 160) say('summary must be 1–160 characters');
  if (!SEMVER.test(m.version)) say(`version "${m.version}" must be semver`);
  if (!Number.isInteger(m.dataVersion) || m.dataVersion < 1) say('dataVersion must be 1 or more');
  if (m.catalog.keywords.length === 0) say('catalog.keywords must name at least one word');

  const dotted = DOTTED_UNDER(m.id);
  const under = KEY_UNDER(m.id);
  const unique = (label: string, keys: readonly string[]) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) say(`${label} "${k}" is declared twice`);
      seen.add(k);
    }
  };

  if (m.capabilities.length === 0 && m.catalog.status !== 'planned')
    say('an add-on must provide at least one capability');
  for (const c of m.capabilities) {
    if (!CAPABILITY_ID_PATTERN.test(c.id) || !c.id.startsWith(`${m.id}.`))
      say(`capability "${c.id}" must start with "${m.id}."`);
    if (c.permission && !m.permissions.some((p) => p.key === c.permission))
      say(
        `capability "${c.id}" needs permission "${c.permission}", which the add-on doesn't declare`,
      );
  }
  unique(
    'capability',
    m.capabilities.map((c) => c.id),
  );

  const permissionKeys = new Set(m.permissions.map((p) => p.key));
  for (const p of m.permissions) {
    if (!dotted.test(p.key)) say(`permission "${p.key}" must start with "${m.id}."`);
    for (const r of p.requires ?? [])
      if (!permissionKeys.has(r) && !r.includes('.'))
        say(`permission "${p.key}" requires "${r}", which isn't a permission`);
  }
  unique(
    'permission',
    m.permissions.map((p) => p.key),
  );

  for (const d of m.requires ?? []) {
    if (d.addon === m.id) say('an add-on cannot depend on itself');
    if (!d.why.trim()) say(`dependency on "${d.addon}" needs a reason`);
  }
  unique(
    'dependency',
    (m.requires ?? []).map((d) => d.addon),
  );

  // The database's own limits on a kind of record and a relationship type (0100, 0101), checked here so a manifest
  // that breaks one fails in the catalogue's tests, never halfway through a business installing it.
  const label = (what: string, text: string | undefined) => {
    if (text !== undefined && (!text.trim() || text.trim().length > 40))
      say(`${what} must be 1–40 characters`);
  };
  const kinds = new Set((m.recordKinds ?? []).map((k) => k.key));
  for (const k of m.recordKinds ?? []) {
    if (!under.test(k.key) || k.key.length > 40)
      say(`record kind "${k.key}" must start with "${m.id}_" and be at most 40 characters`);
    if (!permissionKeys.has(k.writePermission))
      say(`record kind "${k.key}" is written with "${k.writePermission}", which isn't declared`);
    label(`record kind "${k.key}"'s singular`, k.singular);
    label(`record kind "${k.key}"'s plural`, k.plural);
    label(`record kind "${k.key}"'s name label`, k.nameLabel);
    if (k.icon !== undefined && !(RECORD_ICONS as readonly string[]).includes(k.icon))
      say(`record kind "${k.key}"'s icon "${k.icon}" isn't one of the record icons`);
  }
  unique(
    'record kind',
    (m.recordKinds ?? []).map((k) => k.key),
  );
  for (const t of m.relationshipTypes ?? []) {
    if (!under.test(t.key)) say(`relationship type "${t.key}" must start with "${m.id}_"`);
    label(`relationship type "${t.key}"'s a label`, t.aLabel);
    label(`relationship type "${t.key}"'s b label`, t.bLabel);
    for (const end of [t.a, t.b])
      if (end.kind === 'record' && !kinds.has(end.recordKind))
        say(
          `relationship type "${t.key}" names record kind "${end.recordKind}", which isn't declared`,
        );
  }
  unique(
    'relationship type',
    (m.relationshipTypes ?? []).map((t) => t.key),
  );

  for (const t of m.tables ?? []) if (!TABLE_NAME.test(t)) say(`table "${t}" isn't a valid name`);
  unique('table', m.tables ?? []);
  for (const e of m.events?.emits ?? [])
    if (!dotted.test(e)) say(`event "${e}" must start with "${m.id}."`);
  for (const j of m.jobs ?? [])
    if (!dotted.test(j)) say(`job kind "${j}" must start with "${m.id}."`);
  for (const r of m.resources ?? [])
    if (!dotted.test(r)) say(`resource kind "${r}" must start with "${m.id}."`);

  if (m.settings) {
    if (!Number.isInteger(m.settings.version) || m.settings.version < 1)
      say('settings.version must be 1 or more');
    if (m.settings.permission && !m.settings.permission.includes('.'))
      say(`settings.permission "${m.settings.permission}" isn't a permission`);
    for (const key of Object.keys(m.settings.flags ?? {}))
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) say(`switch "${key}" isn't a valid key`);
  }
  for (const n of m.ui?.nav ?? []) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(n.key)) say(`menu place "${n.key}" isn't a valid key`);
    if (n.permission && !permissionKeys.has(n.permission) && !n.permission.includes('.'))
      say(`menu place "${n.key}" needs "${n.permission}", which isn't a permission`);
  }
  unique(
    'menu place',
    (m.ui?.nav ?? []).map((n) => n.key),
  );

  if (m.catalog.status === 'planned') {
    if ((m.tables ?? []).length || (m.jobs ?? []).length || (m.recordKinds ?? []).length)
      say('a planned add-on has no code yet, so it declares no tables, jobs or record kinds');
  }
  if (m.catalog.replacedBy === m.id) say('an add-on cannot replace itself');
  return issues.map((message) => ({ addon: m.id, message }));
}
