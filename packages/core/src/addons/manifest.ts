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

/** In the order the planned list's filters show them. */
export const ADDON_CATEGORIES = [
  'industry',
  'sales',
  'marketing',
  'customers',
  'operations',
  'team',
  'finance',
  'insights',
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
  /**
   * Each record is kept to the people on it: its owner (its main person) and its team see it, and so does anyone
   * holding `seeAllPermission` (one of the add-on's own); nobody else in the business knows it's there. What hangs
   * off one (its timeline, tasks, files, Home cards, relationships, and the add-on's rows about it) follows it.
   * Fixed once the kind is made (Real Estate, step 4).
   */
  readonly keptToTeam?: { readonly seeAllPermission: string };
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
  /**
   * The customer at the person end sees the record in their portal, while the add-on is on (Real Estate round two):
   * a client and their deals. Only between a customer and one of the add-on's own kinds of record.
   */
  readonly portal?: true;
}

/** The places in core screens an add-on can put a panel. The app decides where each one sits. */
export const ADDON_SLOTS = [
  'person.panels',
  'company.panels',
  // A Pipeline lead (Real Estate step 6: "Start a buyer deal" from the lead the client came in as).
  'lead.panels',
  'record.panels',
  'conversation.panels',
  'home.cards',
] as const;
export type AddonSlotName = (typeof ADDON_SLOTS)[number];

/**
 * One of its pages in the side menu. The add-on is one row there, named after it, and these open from it (the owner's
 * decision, 2026-10-09). The path is under the add-on's own pages, `/app/w/<workspace>/a/<id>/…`.
 */
export interface AddonNavItem {
  /** Unique within the add-on; the web knows the page as `addon:<id>:<key>`. */
  readonly key: string;
  readonly label: string;
  /** A lucide icon name the web registry maps. */
  readonly icon: string;
  /** Relative to the add-on's pages: '' for its first page, 'leases' for `/a/<id>/leases`. */
  readonly path: string;
  /** Who sees it. Absent: everyone who holds any of the add-on's permissions. */
  readonly permission?: string;
}

/**
 * One of the add-on's tables a phone keeps offline (round six): which columns, the record each row follows, and who
 * beyond that record's people gets it. A migration registers the same with `private.addon_phone_table()`; a test
 * holds the two equal. What a phone keeps changes by migration, never by a change to the sync config.
 */
export interface AddonOfflineTable {
  /** The table's name in the add-on's schema, one of `tables`. Needs a `workspace_id` column. */
  readonly table: string;
  /** The column naming each row: `id` (the default), or the record for a table with one row per record. */
  readonly key?: string;
  /** The column naming the record each row follows (a deal); absent for the business's own rows (its vendors). */
  readonly record?: string;
  /** What the phone keeps of each row, beside `id` and `workspace_id`. Never a secret. */
  readonly columns: readonly string[];
  /** `team` (the default): only the people on the record. `all`: also whoever sees every record of its kind. */
  readonly reach?: 'team' | 'all';
  /**
   * A person's own rows (Social Outreach's messages waiting, 20261027001800): the column naming whose each row is, one
   * of `columns`. Each row goes to that person's phone alone, never open; a row naming nobody isn't kept. Not with
   * `record`, nor with `reach: 'all'`. The migration registers it with `private.addon_phone_own_table()`.
   */
  readonly owner?: string;
  /** Only rows whose `column` (one of `columns`) is one of `values` are kept (`state` in `waiting`); the rest leave. */
  readonly keep?: { readonly column: string; readonly values: readonly string[] };
}

/**
 * One of the add-on's pages the phone draws too. Its links (an alert's push, an email, a Home card) open that screen
 * on a phone whose build has it, and the web on one that doesn't yet, so they never change when the screen arrives.
 */
export interface AddonPhonePage {
  /** Relative to the add-on's pages, as the web has it: '' for its first page, `deals/:dealId` with `:name` for an id. */
  readonly path: string;
  /** The query parameters the screen reads too (`duty`), kept on its address. */
  readonly query?: readonly string[];
  /**
   * Values of its query parameters whose page stays on the web (`{ view: ['activity'] }`): a link with one opens the
   * web, as for a page the phone doesn't draw. Each key is one of `query`.
   */
  readonly web?: Readonly<Record<string, readonly string[]>>;
}

/**
 * One of the add-on's pages in a customer's portal (`/c/<link>/a/<id>/<path>`), for the records they're on through a
 * portal relationship. It shows what one of the add-on's customer queries (`<id>.portal.*`) answers, and nothing else.
 */
export interface AddonPortalPage {
  /** Relative to the add-on's portal pages: '' for its first, `deals/:dealId` with `:name` for an id. */
  readonly path: string;
  /** Its heading and its place in the portal's menu ("Your home search"). */
  readonly title: string;
  /** The customer query it shows. */
  readonly query: string;
}

/**
 * One of the add-on's public pages (`/a/<site>/<id>/<path>`), open to anyone, signed in to nothing (Real Estate round
 * three): a listing's page, an open house's sign-in. It shows what one of the add-on's public queries
 * (`<id>.public.*`) answers, only while the add-on is on, and only what that query chooses to publish.
 */
export interface AddonPublicPage {
  /** Relative to the add-on's public pages, with `:name` for a part of the address (`:slug/open-house/:openHouseId`). */
  readonly path: string;
  /** The public query it shows. */
  readonly query: string;
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

/**
 * One thing an add-on connects to another service for (round five, 20261021000100): its listing feed, its e-sign. A
 * business connects it with a key it pastes, a sign-in, or HandsFreeOS's own account; the worker tries and seals what
 * it's given, and the add-on's worker half uses it (`connectionFor`).
 */
/**
 * A value an add-on keeps sealed (round seven): a lockbox's code, say. The app hands it to the worker, which seals it
 * with its own key before any command sees it (`POST /v1/addons/sealed`); the database, the API, phones, history and
 * exports only ever hold it sealed. Showing it again goes through the worker too (`/reveal`), for someone with
 * `reveal` who can see the record, and is kept in the history as viewed.
 */
export interface AddonSealedValue {
  /** Its name in the add-on (`lockbox_code`). */
  readonly key: string;
  /** What it is, in the words people use ("Lockbox code"). */
  readonly label: string;
  /** Who may set it: one of the add-on's own permissions. */
  readonly permission: string;
  /** Who may see it again: one of the add-on's own permissions. */
  readonly reveal: string;
}

/**
 * What the AI teammate may do with an add-on, for the customer in the conversation it's answering (round seven;
 * Chris 2026-10-05: answer from their deal, ask before acting). Separate from `ai`, which is the Assistant's: the
 * teammate never acts as someone who works in the business.
 */
export interface AddonTeammate {
  /** One line the teammate reads about what these tools are for ("their home search, deal and showings"). */
  readonly directory: string;
  /**
   * Look-ups it runs as the customer, on its own: the add-on's own portal queries (`<id>.portal.*`), so it sees
   * exactly what that client's portal shows them and nothing about anyone else.
   */
  readonly lookups: readonly AddonTeammateTool[];
  /**
   * What it may ask for: each waits, as an approval, for someone who may see the record named by `record` (the
   * client's deal), and runs as them once they OK it, with their permission checked then.
   */
  readonly asks?: readonly AddonTeammateAsk[];
  /** Its replies go through the add-on's own checks first (the worker half's `checkTeammateReply`). */
  readonly checksReplies?: boolean;
}

export interface AddonTeammateTool {
  /** The operation it runs (`realestate.portal.deal`). */
  readonly operation: string;
  /** The tool's name, as the model sees it: the add-on's id, then words (`realestate_my_deal`). */
  readonly tool: string;
  /** What the model reads to decide when to call it. */
  readonly description: string;
}

export interface AddonTeammateAsk extends AddonTeammateTool {
  /** The input key holding the record it's about, which must be one of the customer's (`dealId`). */
  readonly record: string;
}

export interface AddonOfflineFiles {
  /** One of `offline.tables`. */
  readonly table: string;
  /** Its column holding a file's id. */
  readonly column: string;
  /** Rows whose `column` holds one of `values` keep no file. */
  readonly skip?: { readonly column: string; readonly values: readonly string[] };
}

export interface AddonConnector {
  /** Its name in the add-on (`listing_data`). */
  readonly key: string;
  readonly label: string;
  /** Who connects it and lets it go: one of the add-on's own permissions (its owners and admins, usually). */
  readonly permission: string;
  /** Several services at once (DocuSign and Dotloop), or one of its own at a time (a listing feed). */
  readonly many?: boolean;
  readonly providers: readonly AddonConnectorProvider[];
}

export interface AddonConnectorProvider {
  /** The service (`repliers`). */
  readonly id: string;
  readonly label: string;
  /**
   * How a business connects it: a key it pastes (`key`), a sign-in (`oauth`), or HandsFreeOS's own account
   * (`platform`), turned on by staff, its key only in the worker's environment.
   */
  readonly auth: readonly ('key' | 'oauth' | 'platform')[];
  /** What a pasted key asks for. A secret one is sealed and never shown again. */
  readonly fields?: readonly {
    readonly key: string;
    readonly label: string;
    readonly secret: boolean;
    readonly hint?: string;
    /** It may be left empty (one of two ways a service signs in, say); the service's tester decides. */
    readonly optional?: boolean;
  }[];
  /**
   * The service sends its updates to the connection's own address (round five, step 2): the add-on's worker half
   * has a receiver for it, which checks the service's signature and reads what happened.
   */
  readonly webhooks?: boolean;
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
    /** What the planned list filters it by: a line of work, or the areas it belongs to ("Social Media"). */
    readonly groups?: readonly string[];
    /** For a planned one that overlaps core: what HandsFreeOS already does of it, and what the add-on would add. */
    readonly overlap?: string;
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
  /** The services it connects to, and what for (round five). */
  readonly connectors?: readonly AddonConnector[];
  /** Values it keeps sealed by the worker, never in the clear (round seven). */
  readonly sealed?: readonly AddonSealedValue[];
  /**
   * What phones keep with no signal (round six): the permission a person needs before their phone keeps any of it,
   * and its tables. Its kinds of records come too, private ones to the people on them; anything not here loads live.
   */
  readonly offline?: {
    readonly permission: string;
    readonly tables: readonly AddonOfflineTable[];
    /** Keys of the business's settings the phone keeps too (20261022000800), for pages that rest on them. */
    readonly settings?: readonly string[];
    /**
     * Files its phone rows bring (round seven): each row of `table` keeps the file named in `column` on the phone,
     * encrypted, downloaded on Wi-Fi, up to the phone's limit, unless `skip` says it's no longer current (a replaced
     * or void document). The person can pin any other. It goes when its row leaves the phone or stops asking for it.
     */
    readonly files?: readonly AddonOfflineFiles[];
  };
  readonly settings?: AddonSettingsDeclaration;
  readonly ui?: {
    readonly nav?: readonly AddonNavItem[];
    readonly slots?: readonly { readonly slot: AddonSlotName; readonly permission?: string }[];
    /** The pages the phone draws too. Anything else of the add-on's opens the web there. */
    readonly phone?: readonly AddonPhonePage[];
    /** Its pages in a customer's portal. They need a relationship type with `portal`. */
    readonly portal?: readonly AddonPortalPage[];
    /** Its public pages, for anyone with the link. */
    readonly public?: readonly AddonPublicPage[];
  };
  /** One line the AI reads while the add-on is on: what its tools cover ("properties, units, leases, rent"). */
  readonly ai?: { readonly directory: string };
  /** What the AI teammate may look up and ask for in a customer's conversation (round seven). */
  readonly teammate?: AddonTeammate;
  readonly billing: AddonBilling;
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
/** Column names that hold a secret (packages/db/test/sync-secrets.test.ts asks the same of core's tables). */
const SECRET_COLUMN =
  /(_enc$|secret|password|pkce|oauth_state|token_hash|_hmac$|(^|_)key_id$|^token$|client_state)/;
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
    if (k.keptToTeam && !permissionKeys.has(k.keptToTeam.seeAllPermission))
      say(
        `record kind "${k.key}" is seen whole with "${k.keptToTeam.seeAllPermission}", which isn't declared`,
      );
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
    if (t.portal) {
      const ends = [t.a.kind, t.b.kind].sort().join('+');
      if (ends !== 'person+record')
        say(
          `relationship type "${t.key}" shows a record in a portal, so it joins a customer and a record`,
        );
    }
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

  for (const c of m.connectors ?? []) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(c.key)) say(`connector "${c.key}" isn't a valid key`);
    if (!permissionKeys.has(c.permission))
      say(`connector "${c.key}" needs "${c.permission}", which isn't one of its permissions`);
    if (!c.providers.length) say(`connector "${c.key}" names no service`);
    for (const p of c.providers) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(p.id))
        say(`connector "${c.key}" service "${p.id}" isn't a valid key`);
      if (!p.auth.length) say(`connector "${c.key}" service "${p.id}" has no way to connect`);
      if (p.auth.includes('key') && !p.fields?.some((f) => f.secret))
        say(`connector "${c.key}" service "${p.id}" takes a key but asks for no secret field`);
      for (const f of p.fields ?? [])
        if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(f.key))
          say(`connector "${c.key}" service "${p.id}" field "${f.key}" isn't a valid key`);
    }
    unique(
      `connector "${c.key}" service`,
      c.providers.map((p) => p.id),
    );
  }
  unique(
    'connector',
    (m.connectors ?? []).map((c) => c.key),
  );

  for (const v of m.sealed ?? []) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(v.key)) say(`sealed value "${v.key}" isn't a valid key`);
    if (!v.label.trim()) say(`sealed value "${v.key}" needs a label`);
    if (!permissionKeys.has(v.permission))
      say(
        `sealed value "${v.key}" is set with "${v.permission}", which isn't one of its permissions`,
      );
    if (!permissionKeys.has(v.reveal))
      say(
        `sealed value "${v.key}" is shown with "${v.reveal}", which isn't one of its permissions`,
      );
  }
  unique(
    'sealed value',
    (m.sealed ?? []).map((v) => v.key),
  );

  if (m.teammate) {
    const t = m.teammate;
    if (!t.directory.trim() || t.directory.length > 200)
      say('teammate.directory must be 1–200 characters');
    if (t.lookups.length === 0) say('teammate needs at least one look-up');
    const toolName = new RegExp(`^${m.id}_[a-z][a-z0-9_]{1,40}$`);
    for (const x of [...t.lookups, ...(t.asks ?? [])]) {
      if (!toolName.test(x.tool))
        say(`teammate tool "${x.tool}" must start with "${m.id}_", in lowercase words`);
      if (!x.operation.startsWith(`${m.id}.`))
        say(`teammate tool "${x.tool}" runs "${x.operation}", which isn't one of this add-on's`);
      if (!x.description.trim() || x.description.length > 600)
        say(`teammate tool "${x.tool}" needs a description of 1–600 characters`);
    }
    for (const x of t.lookups)
      if (!x.operation.startsWith(`${m.id}.portal.`))
        say(
          `teammate look-up "${x.tool}" runs "${x.operation}": look-ups are its portal's ("${m.id}.portal.*")`,
        );
    for (const a of t.asks ?? [])
      if (!/^[a-z][A-Za-z0-9]{0,39}$/.test(a.record))
        say(`teammate ask "${a.tool}" names its record by "${a.record}", which isn't an input key`);
    unique(
      'teammate tool',
      [...t.lookups, ...(t.asks ?? [])].map((x) => x.tool),
    );
    if (!(m.relationshipTypes ?? []).some((r) => r.portal))
      say('teammate tools need a relationship type with "portal", so a customer has records');
  }

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
  for (const page of m.ui?.phone ?? []) {
    const parts = page.path.split('/');
    if (
      page.path !== '' &&
      !parts.every((p) => /^(:[a-z][A-Za-z0-9]{0,39}|[a-z0-9][a-z0-9_-]{0,39})$/.test(p))
    )
      say(`phone page "${page.path}" must be the web page's path, with ":name" for an id`);
    for (const q of page.query ?? [])
      if (!/^[a-z][A-Za-z0-9_]{0,39}$/.test(q))
        say(`phone page "${page.path}" reads "${q}", which isn't a query key`);
    for (const [q, values] of Object.entries(page.web ?? {})) {
      if (!(page.query ?? []).includes(q))
        say(`phone page "${page.path}" leaves "${q}" to the web, but doesn't read it`);
      if (!values.length) say(`phone page "${page.path}" leaves "${q}" to the web with no values`);
    }
  }
  const portalShapes = new Set<string>();
  for (const page of m.ui?.portal ?? []) {
    const parts = page.path.split('/');
    if (
      page.path !== '' &&
      !parts.every((p) => /^(:[a-z][A-Za-z0-9]{0,39}|[a-z0-9][a-z0-9_-]{0,39})$/.test(p))
    )
      say(`portal page "${page.path}" must be a path, with ":name" for an id`);
    if (!page.title.trim() || page.title.length > 40)
      say(`portal page "${page.path}"'s title must be 1–40 characters`);
    if (!page.query.startsWith(`${m.id}.portal.`))
      say(
        `portal page "${page.path}" shows "${page.query}", which must be one of "${m.id}.portal.*"`,
      );
    const shape = page.path.replace(/:[^/]+/g, ':');
    if (portalShapes.has(shape)) say(`portal page "${page.path}" is declared twice`);
    portalShapes.add(shape);
  }
  if ((m.ui?.portal ?? []).length > 0 && !(m.relationshipTypes ?? []).some((t) => t.portal))
    say('portal pages need a relationship type with "portal", so a customer has records to see');
  const publicShapes = new Set<string>();
  for (const page of m.ui?.public ?? []) {
    const parts = page.path.split('/');
    if (!parts.every((p) => /^(:[a-z][A-Za-z0-9]{0,39}|[a-z0-9][a-z0-9_-]{0,39})$/.test(p)))
      say(`public page "${page.path}" must be a path, with ":name" for a part of the address`);
    if (!page.query.startsWith(`${m.id}.public.`))
      say(
        `public page "${page.path}" shows "${page.query}", which must be one of "${m.id}.public.*"`,
      );
    const shape = page.path.replace(/:[^/]+/g, ':');
    if (publicShapes.has(shape)) say(`public page "${page.path}" is declared twice`);
    publicShapes.add(shape);
  }
  if (m.offline) {
    if (!permissionKeys.has(m.offline.permission))
      say(`offline.permission "${m.offline.permission}" isn't one of its permissions`);
    for (const t of m.offline.tables) {
      if (!(m.tables ?? []).includes(t.table))
        say(`offline table "${t.table}" isn't one of its tables`);
      if (!t.columns.length || t.columns.length > 80)
        say(`offline table "${t.table}" keeps 1–80 columns`);
      for (const c of t.columns) {
        if (!/^[a-z][a-z0-9_]{0,62}$/.test(c))
          say(`offline table "${t.table}" column "${c}" isn't a column name`);
        if (SECRET_COLUMN.test(c))
          say(`offline table "${t.table}" keeps "${c}", which looks like a secret`);
        if (c === 'id' || c === 'workspace_id')
          say(`offline table "${t.table}" keeps "${c}" already`);
      }
      unique(`offline table "${t.table}" column`, t.columns);
      if (t.record !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(t.record))
        say(`offline table "${t.table}" record "${t.record}" isn't a column name`);
      if (t.owner !== undefined) {
        if (!t.columns.includes(t.owner))
          say(
            `offline table "${t.table}" is each person's own by "${t.owner}", which it doesn't keep`,
          );
        if (t.record !== undefined)
          say(`offline table "${t.table}" is a person's own or follows a record, not both`);
        if (t.reach === 'all')
          say(`offline table "${t.table}" is a person's own, so it reaches only them`);
      }
      if (t.keep) {
        if (!t.columns.includes(t.keep.column))
          say(`offline table "${t.table}" keeps rows by "${t.keep.column}", which it doesn't keep`);
        if (!t.keep.values.length)
          say(`offline table "${t.table}" keeps rows by "${t.keep.column}" but names no values`);
      }
    }
    unique(
      'offline table',
      m.offline.tables.map((t) => t.table),
    );
    for (const k of m.offline.settings ?? []) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(k))
        say(`offline setting "${k}" isn't a settings key`);
      if (SECRET_COLUMN.test(k)) say(`offline setting "${k}" looks like a secret`);
      const shape = (m.settings?.workspace as { shape?: Record<string, unknown> } | undefined)
        ?.shape;
      if (!shape || !(k in shape)) say(`offline setting "${k}" isn't one of its settings`);
    }
    unique('offline setting', m.offline.settings ?? []);
    for (const f of m.offline.files ?? []) {
      const table = m.offline.tables.find((t) => t.table === f.table);
      if (!table)
        say(`offline files come from "${f.table}", which isn't one of its offline tables`);
      else {
        if (!table.columns.includes(f.column))
          say(`offline files of "${f.table}" name "${f.column}", which it doesn't keep`);
        if (f.skip && !table.columns.includes(f.skip.column))
          say(`offline files of "${f.table}" skip by "${f.skip.column}", which it doesn't keep`);
      }
      if (f.skip && !f.skip.values.length)
        say(`offline files of "${f.table}" skip by "${f.skip.column}" but name no values`);
    }
    unique(
      'offline files of',
      (m.offline.files ?? []).map((f) => `${f.table}.${f.column}`),
    );
  }
  const phoneShapes = new Set<string>();
  for (const page of m.ui?.phone ?? []) {
    // `deals/:dealId` and `deals/:id` are the same page.
    const shape = page.path.replace(/:[^/]+/g, ':');
    if (phoneShapes.has(shape)) say(`phone page "${page.path}" is declared twice`);
    phoneShapes.add(shape);
  }

  if (m.catalog.status === 'planned') {
    if ((m.tables ?? []).length || (m.jobs ?? []).length || (m.recordKinds ?? []).length)
      say('a planned add-on has no code yet, so it declares no tables, jobs or record kinds');
  }
  for (const g of m.catalog.groups ?? [])
    if (!g.trim() || g.length > 60) say(`group "${g}" must be 1–60 characters`);
  unique('group', m.catalog.groups ?? []);
  if (
    m.catalog.overlap !== undefined &&
    (!m.catalog.overlap.trim() || m.catalog.overlap.length > 300)
  )
    say('catalog.overlap must be 1–300 characters');
  if (m.catalog.replacedBy === m.id) say('an add-on cannot replace itself');
  return issues.map((message) => ({ addon: m.id, message }));
}
