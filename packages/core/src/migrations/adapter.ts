/**
 * The contract a CRM has to meet to be a source.
 *
 * Read it as a promise in two directions. An adapter promises to say honestly what it can and cannot do, to
 * page through records the same way twice, and to hand back canonical envelopes rather than its own payloads.
 * HandsFreeOS promises never to ask it about jobs, retries, merging, dependencies, verification, media,
 * reporting or rollback — all of which happen on this side, once, for every source there will ever be.
 *
 * The test of the architecture is Phase 7 of the plan: the second adapter should be able to implement this
 * and nothing else. If a source ever needs a change inside the import engine, that is a defect here.
 */
import type { CanonicalEnvelope } from './canonical';
import type { CountQuality, MigrationCapability } from './capability';

/** An authorized sign-in, as the engine holds it. The token itself never leaves the worker. */
export interface SourceConnection {
  readonly id: string;
  readonly system: string;
  readonly installKind: 'agency' | 'location';
  readonly externalAccountId: string | null;
  readonly scopes: readonly string[];
  readonly accessToken: string;
  readonly refreshToken?: string | null;
  readonly expiresAt?: Date | null;
}

/** One sub-account the connection can reach. */
export interface SourceScope {
  readonly externalScopeId: string;
  readonly name: string;
  readonly timezone?: string | null;
  readonly descriptor?: Record<string, unknown>;
  /** Some sources hand out a per-sub-account token from an agency one; the adapter asks for it when needed. */
  readonly accessToken?: string;
}

/**
 * What this adapter, this sign-in, this plan and this account can actually do with one category — the four
 * things combined, at runtime, rather than a static list that lies as soon as scopes differ.
 */
export interface CategorySupport {
  readonly category: string;
  readonly capability: MigrationCapability;
  /** The scopes this needs, and the ones it did not get. The difference is what "reconnect" asks for. */
  readonly requiredScopes: readonly string[];
  readonly missingScopes: readonly string[];
  /** How it pages, whether the count can be trusted, and whether it can be asked "what changed since?". */
  readonly countQuality: CountQuality;
  readonly incremental: boolean;
  readonly webhooks: boolean;
  /** Whether the source gives a stable id per record. Without one, messages fall back to a fingerprint. */
  readonly stableIds: boolean;
  /** Whether the source tells us when a record was created, changed and deleted. */
  readonly timestamps: {
    readonly created: boolean;
    readonly updated: boolean;
    readonly deleted: boolean;
  };
  /** Media links that expire, and how long they last, so the copier knows to hurry or to ask again. */
  readonly mediaUrlTtlSeconds?: number | null;
  /** Anything known to be missing or odd, in words, for the findings. */
  readonly limitations?: readonly string[];
}

export interface CapabilityManifest {
  readonly system: string;
  readonly adapterVersion: string;
  readonly categories: readonly CategorySupport[];
  /** How fast we may read, so one migration never costs a business its own API budget. */
  readonly rateLimit?: {
    readonly requestsPerSecond: number;
    readonly burst: number;
    readonly dailyCap?: number | null;
  };
}

/** What the scan found for one category, streamed so a big account fills the screen as it goes. */
export interface InventoryResult {
  readonly category: string;
  /** Null for the category as a whole; set for one calendar, one pipeline, one form. */
  readonly resourceId?: string | null;
  readonly resourceName?: string | null;
  readonly count: number;
  readonly countQuality: CountQuality;
  readonly capability: MigrationCapability;
  readonly estimatedBytes?: number;
  readonly notes?: string | null;
  /** Raised straight from the scan: things that will not fit, before anyone agrees to anything. */
  readonly findings?: readonly SourceFinding[];
}

export interface SourceFinding {
  readonly code: string;
  readonly capability: MigrationCapability;
  readonly severity: 'info' | 'review' | 'action' | 'blocking';
  readonly summary: string;
  readonly sourceCapability?: string | null;
  readonly targetCapability?: string | null;
  readonly whatImports?: string | null;
  readonly whatChanges?: string | null;
  readonly recommendedAction?: string | null;
  readonly affectedCount?: number;
  readonly detail?: Record<string, unknown>;
}

/** A page of records, with where to carry on from. */
export interface SourcePage {
  readonly records: readonly SourceRecord[];
  readonly cursor: Record<string, unknown> | null;
  /** The newest source change time on this page, for the checkpoint's high-water mark. */
  readonly highWaterAt?: Date | null;
  readonly done: boolean;
}

export interface SourceRecord {
  readonly objectType: string;
  readonly objectId: string;
  readonly parentObjectId?: string | null;
  readonly sourceCreatedAt?: Date | null;
  readonly sourceUpdatedAt?: Date | null;
  readonly sourceDeletedAt?: Date | null;
  readonly payload: Record<string, unknown>;
}

export interface SourceMedia {
  readonly sourceObjectType: string;
  readonly sourceObjectId: string;
  readonly locator: string;
  readonly fileName?: string | null;
  readonly declaredMime?: string | null;
  readonly sizeBytes?: number | null;
  /** When the link stops working, when the source says. */
  readonly expiresAt?: Date | null;
}

/** A change the source told us about during the catch-up. */
export interface SourceChange {
  readonly eventId?: string | null;
  readonly objectType: string;
  readonly objectId: string;
  readonly category: string;
  readonly action: 'created' | 'updated' | 'deleted';
  readonly occurredAt?: Date | null;
}

export interface ListOptions {
  readonly cursor?: Record<string, unknown> | null;
  /** Only what changed since this. Ignored by a category whose support says it cannot. */
  readonly changedSince?: Date | null;
  /** Never past this, so the first import and the catch-up meet exactly once at the watermark. */
  readonly until?: Date | null;
  readonly limit?: number;
  readonly includeDeleted?: boolean;
}

/** What a normalizer may look things up in while it works. Never the database; never another record's row. */
export interface MappingContext {
  readonly locationId: string;
  readonly installationId: string;
  readonly adapterVersion: string;
  readonly timezone: string;
  /** The country phone numbers with no country code belong to. */
  readonly defaultCountry: string;
  /** Custom-field shapes already brought across, so a value knows what type it is. */
  readonly customFields: ReadonlyMap<string, { readonly key: string; readonly type: string }>;
}

export interface CrmSourceAdapter {
  readonly system: string;
  readonly adapterVersion: string;

  /** Where to send someone to sign in, and what comes back. */
  authorizeUrl(input: {
    readonly state: string;
    readonly redirectUri: string;
    readonly codeChallenge?: string;
  }): string;
  exchangeCode(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier?: string;
  }): Promise<SourceConnection>;
  refresh(connection: SourceConnection): Promise<SourceConnection>;
  revoke?(connection: SourceConnection): Promise<void>;

  /** Every sub-account this sign-in reaches. One, for a sub-account sign-in. */
  discoverScopes(connection: SourceConnection): Promise<readonly SourceScope[]>;
  /** A token for one sub-account, when the source works that way. */
  scopeToken?(connection: SourceConnection, scope: SourceScope): Promise<SourceScope>;

  /** What this sign-in can really do, probed rather than assumed. */
  inspectCapabilities(
    connection: SourceConnection,
    scope: SourceScope,
  ): Promise<CapabilityManifest>;
  /** Read-only. Counts, sizes, resources and the findings that come out of looking. */
  scan(connection: SourceConnection, scope: SourceScope): AsyncIterable<InventoryResult>;

  list(
    connection: SourceConnection,
    scope: SourceScope,
    category: string,
    options: ListOptions,
  ): Promise<SourcePage>;

  /** One record again, by its id — for a retry, or to see a changed record whole. */
  getById?(
    connection: SourceConnection,
    scope: SourceScope,
    objectType: string,
    objectId: string,
  ): Promise<SourceRecord | null>;

  /** Its own payload turned into HandsFreeOS's shape. The only place source knowledge is allowed. */
  normalize(record: SourceRecord, context: MappingContext): readonly CanonicalEnvelope[];

  /** Files this record points at. Fetched and copied by the engine, not by the adapter. */
  listMedia?(record: SourceRecord): readonly SourceMedia[];
  /** A fresh link for a file whose last one expired. */
  refreshMedia?(
    connection: SourceConnection,
    scope: SourceScope,
    media: SourceMedia,
  ): Promise<SourceMedia | null>;

  registerWebhooks?(
    connection: SourceConnection,
    scope: SourceScope,
    endpoint: string,
  ): Promise<readonly { readonly id: string; readonly events: readonly string[] }[]>;
  parseWebhook?(input: {
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body: unknown;
    readonly rawBody: string;
  }): readonly SourceChange[];
  reconcile?(
    connection: SourceConnection,
    scope: SourceScope,
    category: string,
    since: Date,
  ): AsyncIterable<SourceChange>;
}

/** Adapters register themselves here; the engine only ever asks for one by name. */
export interface AdapterRegistry {
  get(system: string): CrmSourceAdapter | undefined;
  readonly systems: readonly string[];
}
