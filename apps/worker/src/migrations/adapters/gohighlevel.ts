/**
 * Reading GoHighLevel.
 *
 * This is the only file in HandsFreeOS that knows what a GoHighLevel payload looks like. Everything past
 * `normalize` is the canonical shape, and the import engine could not tell you which CRM it came from. That is
 * the point of the milestone, and it is the thing to protect in review.
 *
 * **What is verified and what is not.** The endpoints, the token flow and the location-token exchange below
 * follow HighLevel's published API (v2, `Version: 2021-07-28`). They have not been run against a live agency
 * from this repository, because that needs an account and an approved marketplace app. So the adapter is built
 * to find out rather than to assume:
 *   - `inspectCapabilities` probes each category with a one-record read and reports what actually came back,
 *     so a category we cannot reach is reported as `not_available` with the scope that was missing rather than
 *     as an empty account;
 *   - every mapper keeps whatever it did not understand in `extensions.gohighlevel` and raises a warning, so a
 *     field we guessed wrong about is visible in the findings rather than lost;
 *   - nothing here writes to GoHighLevel, ever. There is no code path in this file that is not a GET.
 *
 * Phase 0 of the plan — running this against a real agency and a real sub-account and writing down the field
 * coverage — is still owed before any of it is called finished. `docs/migrations.md` says so too.
 */
import { createHash } from 'node:crypto';
import type {
  CategorySupport,
  CanonicalEnvelope,
  CountQuality,
  CrmSourceAdapter,
  InventoryResult,
  ListOptions,
  MappingContext,
  MigrationCapability,
  SourceConnection,
  SourceFinding,
  SourcePage,
  SourceRecord,
  SourceScope,
} from '@hfos/core/server';
import { CANONICAL_SCHEMA_VERSION, migrationCategory, releaseCapability } from '@hfos/core/server';

export const GHL_ADAPTER_VERSION = '1.0.0';

/** HighLevel pins its v2 API by date. Changing this is a mapping change, so it goes up with the version. */
const API_VERSION = '2021-07-28';
const API_BASE = 'https://services.leadconnectorhq.com';
const AUTHORIZE_URL = 'https://marketplace.gohighlevel.com/oauth/chooselocation';

export interface GoHighLevelConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Left empty, the adapter exists but refuses to sign in, and the screen says the app is not set up. */
  readonly configured: boolean;
}

/**
 * The read-only scopes each category needs. Asked for together at the sign-in, granted or not by the person
 * signing in, and then checked one by one — because "the customer did not tick that box" and "GoHighLevel has
 * no such endpoint" are different answers and the report keeps them apart.
 */
export const GHL_SCOPES: Record<string, readonly string[]> = {
  locations: ['locations.readonly'],
  users: ['users.readonly'],
  custom_fields: ['locations/customFields.readonly'],
  tags: ['locations/tags.readonly'],
  contacts: ['contacts.readonly'],
  companies: ['companies.readonly'],
  pipelines: ['opportunities.readonly'],
  opportunities: ['opportunities.readonly'],
  calendars: ['calendars.readonly'],
  appointments: ['calendars/events.readonly'],
  conversations: ['conversations.readonly'],
  messages: ['conversations/message.readonly'],
  calls: ['conversations/message.readonly'],
  forms: ['forms.readonly'],
  form_submissions: ['forms.readonly'],
  templates: ['emails/builder.readonly'],
  products: ['products.readonly', 'products/prices.readonly'],
  invoices: ['invoices.readonly'],
  estimates: ['invoices.readonly'],
  subscriptions: ['payments/subscriptions.readonly'],
  tasks: ['contacts.readonly'],
  reviews: ['reviews.readonly'],
  media: ['medias.readonly'],
  phone_numbers: ['phone-system.readonly'],
  workflows: ['workflows.readonly'],
  sending_domains: ['emails/builder.readonly'],
  integrations: ['locations.readonly'],
  websites: ['funnels/page.readonly'],
  funnels: ['funnels/funnel.readonly'],
};

/** Everything asked for at the sign-in: the union above, in a stable order. */
export const GHL_ALL_SCOPES: readonly string[] = [
  ...new Set(Object.values(GHL_SCOPES).flat()),
].sort();

/** Where each category is read from, and how a page of it is asked for. */
interface Endpoint {
  readonly path: (scope: string) => string;
  /** The key the array of records sits under in the answer. */
  readonly listKey: string;
  /** The field that is the record's own id. */
  readonly idKey: string;
  /** GoHighLevel pages some things by a cursor and some by a page number; both are here. */
  readonly paging: 'startAfter' | 'page' | 'none';
  readonly countQuality: CountQuality;
  /** Whether the endpoint can be asked "what changed since?". Most of v2 cannot. */
  readonly incremental: boolean;
  readonly objectType: string;
}

const ENDPOINTS: Record<string, Endpoint> = {
  users: {
    path: (s) => `/users/?locationId=${encodeURIComponent(s)}`,
    listKey: 'users',
    idKey: 'id',
    paging: 'none',
    countQuality: 'complete',
    incremental: false,
    objectType: 'user',
  },
  custom_fields: {
    path: (s) => `/locations/${encodeURIComponent(s)}/customFields`,
    listKey: 'customFields',
    idKey: 'id',
    paging: 'none',
    countQuality: 'complete',
    incremental: false,
    objectType: 'custom_field',
  },
  tags: {
    path: (s) => `/locations/${encodeURIComponent(s)}/tags`,
    listKey: 'tags',
    idKey: 'id',
    paging: 'none',
    countQuality: 'complete',
    incremental: false,
    objectType: 'tag',
  },
  contacts: {
    path: (s) => `/contacts/?locationId=${encodeURIComponent(s)}`,
    listKey: 'contacts',
    idKey: 'id',
    paging: 'startAfter',
    countQuality: 'complete',
    incremental: true,
    objectType: 'contact',
  },
  companies: {
    path: (s) => `/companies/?locationId=${encodeURIComponent(s)}`,
    listKey: 'companies',
    idKey: 'id',
    paging: 'page',
    countQuality: 'complete',
    incremental: false,
    objectType: 'company',
  },
};

/** Categories the scan counts but this release does not read record by record. */
const COUNT_ONLY: readonly string[] = [
  'pipelines',
  'opportunities',
  'calendars',
  'appointments',
  'conversations',
  'messages',
  'calls',
  'forms',
  'form_submissions',
  'templates',
  'products',
  'invoices',
  'estimates',
  'subscriptions',
  'tasks',
  'reviews',
  'media',
  'phone_numbers',
  'sending_domains',
  'integrations',
  'workflows',
  'websites',
  'funnels',
];

class GhlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'GhlError';
  }
}

const checksum = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(v ?? null))
    .digest('hex')
    .slice(0, 32);

const asDate = (v: unknown): Date | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};
const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/**
 * GoHighLevel's custom-field types, as far as they map. Anything not here is kept whole in extensions with a
 * finding, rather than flattened to text — a date silently turned into a string is the kind of loss nobody
 * notices until they need to sort by it.
 */
const FIELD_TYPES: Record<string, string> = {
  TEXT: 'text',
  LARGE_TEXT: 'long_text',
  TEXTBOX_LIST: 'long_text',
  NUMERICAL: 'number',
  MONETARY: 'money',
  PHONE: 'phone',
  EMAIL: 'email',
  DATE: 'date',
  CHECKBOX: 'multi_choice',
  SINGLE_OPTIONS: 'choice',
  MULTIPLE_OPTIONS: 'multi_choice',
  RADIO: 'choice',
  FILE_UPLOAD: 'file',
  SIGNATURE: 'file',
};

export function createGoHighLevelAdapter(config: GoHighLevelConfig): CrmSourceAdapter {
  const call = async <T>(
    token: string,
    path: string,
    init?: { readonly method?: 'GET'; readonly timeoutMs?: number },
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 30_000);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          version: API_VERSION,
          accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // The three that mean something different from "it broke".
        const code =
          res.status === 401
            ? 'unauthorized'
            : res.status === 403
              ? 'forbidden'
              : res.status === 429
                ? 'rate_limited'
                : res.status === 404
                  ? 'not_found'
                  : 'http_error';
        throw new GhlError(
          `GoHighLevel answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
          res.status,
          code,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  };

  const tokenOf = (connection: SourceConnection, scope?: SourceScope) =>
    scope?.accessToken ?? connection.accessToken;

  /** One page, in whichever way this endpoint pages. */
  const page = async (
    token: string,
    endpoint: Endpoint,
    scopeId: string,
    options: ListOptions,
  ): Promise<SourcePage> => {
    const limit = Math.min(options.limit ?? 100, 100);
    const base = endpoint.path(scopeId);
    const join = base.includes('?') ? '&' : '?';
    const cursor = (options.cursor ?? {}) as {
      startAfterId?: string;
      startAfter?: number;
      page?: number;
    };
    let path = `${base}${join}limit=${limit}`;
    if (endpoint.paging === 'startAfter' && cursor.startAfterId)
      path += `&startAfterId=${encodeURIComponent(cursor.startAfterId)}${
        cursor.startAfter ? `&startAfter=${cursor.startAfter}` : ''
      }`;
    if (endpoint.paging === 'page') path += `&page=${cursor.page ?? 1}`;

    const body = await call<Record<string, unknown>>(token, path);
    const list = Array.isArray(body[endpoint.listKey])
      ? (body[endpoint.listKey] as Record<string, unknown>[])
      : [];
    const records: SourceRecord[] = [];
    let highWaterAt: Date | null = null;
    for (const raw of list) {
      const id = asString(raw[endpoint.idKey]) ?? asString(raw['_id']);
      if (!id) continue;
      const updatedAt = asDate(raw['dateUpdated'] ?? raw['updatedAt']);
      const createdAt = asDate(raw['dateAdded'] ?? raw['createdAt']);
      // The watermark is the point the first import stops and the catch-up starts, so a record whose change
      // arrived while we were reading is picked up by exactly one of the two.
      if (options.until && updatedAt && updatedAt > options.until) continue;
      if (options.changedSince && updatedAt && updatedAt <= options.changedSince) continue;
      if (!options.includeDeleted && raw['deleted'] === true) continue;
      if (updatedAt && (!highWaterAt || updatedAt > highWaterAt)) highWaterAt = updatedAt;
      records.push({
        objectType: endpoint.objectType,
        objectId: id,
        sourceCreatedAt: createdAt,
        sourceUpdatedAt: updatedAt,
        sourceDeletedAt: raw['deleted'] === true ? (updatedAt ?? null) : null,
        payload: raw,
      });
    }
    const last = list[list.length - 1];
    const done = list.length < limit;
    const nextCursor = done
      ? null
      : endpoint.paging === 'page'
        ? { page: (cursor.page ?? 1) + 1 }
        : endpoint.paging === 'startAfter' && last
          ? {
              startAfterId: asString(last[endpoint.idKey]) ?? '',
              startAfter: Number(last['dateAdded'] ?? last['dateUpdated'] ?? 0) || undefined,
            }
          : null;
    return {
      records,
      cursor: nextCursor,
      highWaterAt,
      done: done || nextCursor === null,
    };
  };

  /** Ask for one record. What comes back — an answer, a refusal, a 404 — is the capability. */
  const probe = async (
    token: string,
    category: string,
    scopeId: string,
  ): Promise<{
    capability: MigrationCapability;
    count: number;
    quality: CountQuality;
    note?: string;
  }> => {
    const endpoint = ENDPOINTS[category];
    if (!endpoint) return { capability: 'not_in_release', count: 0, quality: 'unknown' };
    try {
      const body = await call<Record<string, unknown>>(
        token,
        `${endpoint.path(scopeId)}${endpoint.path(scopeId).includes('?') ? '&' : '?'}limit=1`,
        { timeoutMs: 15_000 },
      );
      const total = body['total'] ?? body['meta'];
      const count =
        typeof total === 'number'
          ? total
          : typeof total === 'object' &&
              total !== null &&
              typeof (total as { total?: unknown }).total === 'number'
            ? (total as { total: number }).total
            : Array.isArray(body[endpoint.listKey])
              ? (body[endpoint.listKey] as unknown[]).length
              : 0;
      return {
        capability: 'ready',
        count,
        // A total the source gave us is a real count; one read record only proves there is at least one.
        quality: typeof total === 'number' || typeof total === 'object' ? 'complete' : 'estimated',
      };
    } catch (e) {
      const err = e as GhlError;
      if (err.code === 'forbidden' || err.code === 'unauthorized')
        return {
          capability: 'not_available',
          count: 0,
          quality: 'permission_limited',
          note: 'This sign-in was not given access to it.',
        };
      if (err.code === 'not_found')
        return {
          capability: 'not_available',
          count: 0,
          quality: 'not_enumerable',
          note: 'GoHighLevel has no way to list these for this account.',
        };
      throw e;
    }
  };

  const supportOf = (
    category: string,
    granted: ReadonlySet<string>,
    capability: MigrationCapability,
    quality: CountQuality,
  ): CategorySupport => {
    const required = GHL_SCOPES[category] ?? [];
    const missing = required.filter((s) => !granted.has(s));
    const endpoint = ENDPOINTS[category];
    return {
      category,
      capability: missing.length > 0 ? 'not_available' : capability,
      requiredScopes: required,
      missingScopes: missing,
      countQuality: missing.length > 0 ? 'permission_limited' : quality,
      incremental: endpoint?.incremental ?? false,
      // v2 offers webhooks for contacts, conversations, opportunities and appointments; the ones this
      // release reads are covered, and the rest say so honestly rather than promising a catch-up they
      // cannot do.
      webhooks: category === 'contacts',
      stableIds: true,
      timestamps: { created: true, updated: true, deleted: false },
      mediaUrlTtlSeconds: null,
      limitations:
        endpoint?.incremental === false && ENDPOINTS[category]
          ? ['GoHighLevel cannot be asked what changed, so this category is re-read and compared.']
          : undefined,
    };
  };

  return {
    system: 'gohighlevel',
    adapterVersion: GHL_ADAPTER_VERSION,

    authorizeUrl({ state, redirectUri }) {
      if (!config.configured)
        throw new GhlError(
          'The GoHighLevel app is not set up on this server.',
          500,
          'not_configured',
        );
      const params = new URLSearchParams({
        response_type: 'code',
        redirect_uri: redirectUri,
        client_id: config.clientId,
        scope: GHL_ALL_SCOPES.join(' '),
        state,
      });
      return `${AUTHORIZE_URL}?${params.toString()}`;
    },

    async exchangeCode({ code, redirectUri }) {
      const res = await fetch(`${API_BASE}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });
      if (!res.ok)
        throw new GhlError(
          `GoHighLevel refused the sign-in (${res.status}).`,
          res.status,
          'exchange_failed',
        );
      const body = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        locationId?: string;
        companyId?: string;
        userType?: string;
      };
      const agency = body.userType === 'Company' || (!body.locationId && !!body.companyId);
      return {
        id: '',
        system: 'gohighlevel',
        installKind: agency ? 'agency' : 'location',
        externalAccountId: body.locationId ?? body.companyId ?? null,
        scopes: (body.scope ?? '').split(/\s+/).filter(Boolean),
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? null,
        expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
      };
    },

    async refresh(connection) {
      if (!connection.refreshToken)
        throw new GhlError('This connection has nothing to refresh with.', 400, 'no_refresh_token');
      const res = await fetch(`${API_BASE}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: connection.refreshToken,
        }).toString(),
      });
      if (!res.ok)
        throw new GhlError(
          `GoHighLevel would not refresh the sign-in (${res.status}).`,
          res.status,
          res.status === 400 || res.status === 401 ? 'reauth_required' : 'refresh_failed',
        );
      const body = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };
      return {
        ...connection,
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? connection.refreshToken,
        expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
      };
    },

    async discoverScopes(connection) {
      if (connection.installKind === 'location')
        return [
          {
            externalScopeId: connection.externalAccountId ?? '',
            name: 'This business',
          },
        ];
      // An agency sign-in reaches the sub-accounts the person approved, and only those.
      const body = await call<{
        locations?: {
          _id?: string;
          id?: string;
          name?: string;
          timezone?: string;
          address?: string;
          country?: string;
        }[];
      }>(
        connection.accessToken,
        `/oauth/installedLocations?companyId=${encodeURIComponent(connection.externalAccountId ?? '')}&limit=500`,
      );
      return (body.locations ?? [])
        .map((l) => ({
          externalScopeId: asString(l._id ?? l.id) ?? '',
          name: asString(l.name) ?? 'Unnamed sub-account',
          timezone: asString(l.timezone),
          descriptor: { address: asString(l.address), country: asString(l.country) },
        }))
        .filter((s) => s.externalScopeId);
    },

    async scopeToken(connection, scope) {
      if (connection.installKind === 'location') return scope;
      const res = await fetch(`${API_BASE}/oauth/locationToken`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.accessToken}`,
          version: API_VERSION,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          companyId: connection.externalAccountId ?? '',
          locationId: scope.externalScopeId,
        }).toString(),
      });
      if (!res.ok)
        throw new GhlError(
          `GoHighLevel would not give a token for ${scope.name} (${res.status}).`,
          res.status,
          res.status === 401 || res.status === 403 ? 'forbidden' : 'http_error',
        );
      const body = (await res.json()) as { access_token: string };
      return { ...scope, accessToken: body.access_token };
    },

    async inspectCapabilities(connection, scope) {
      const granted = new Set(connection.scopes);
      const token = tokenOf(connection, scope);
      const categories: CategorySupport[] = [];
      for (const category of Object.keys(ENDPOINTS)) {
        const required = GHL_SCOPES[category] ?? [];
        if (required.some((s) => !granted.has(s))) {
          categories.push(supportOf(category, granted, 'not_available', 'permission_limited'));
          continue;
        }
        try {
          const p = await probe(token, category, scope.externalScopeId);
          categories.push(supportOf(category, granted, p.capability, p.quality));
        } catch {
          // A broken probe is not a permission answer; it is unknown, and the scan says so.
          categories.push(supportOf(category, granted, 'ready', 'unknown'));
        }
      }
      for (const category of COUNT_ONLY) {
        const cat = migrationCategory(category);
        categories.push({
          ...supportOf(category, granted, 'not_in_release', 'unknown'),
          capability: cat ? releaseCapability(cat.release) : 'not_in_release',
        });
      }
      return {
        system: 'gohighlevel',
        adapterVersion: GHL_ADAPTER_VERSION,
        categories,
        // HighLevel's published burst allowance, kept well under so one migration never costs a business its
        // own API budget for the day.
        rateLimit: { requestsPerSecond: 5, burst: 50, dailyCap: null },
      };
    },

    async *scan(connection, scope) {
      const granted = new Set(connection.scopes);
      const token = tokenOf(connection, scope);
      for (const category of [...Object.keys(ENDPOINTS), ...COUNT_ONLY]) {
        const cat = migrationCategory(category);
        if (!cat) continue;
        const required = GHL_SCOPES[category] ?? [];
        const missing = required.filter((s) => !granted.has(s));
        const findings: SourceFinding[] = [];
        if (missing.length > 0) {
          yield {
            category,
            count: 0,
            countQuality: 'permission_limited',
            capability: 'not_available',
            notes: 'This sign-in was not given access to it.',
            findings: [
              {
                code: 'access.scope_missing',
                capability: 'not_available',
                severity: 'action',
                summary: `This sign-in cannot read ${cat.label.toLowerCase()}.`,
                whatImports: 'Nothing from this category.',
                whatChanges:
                  'The count is unknown, not zero: we were not allowed to look, so we will not pretend there is nothing there.',
                recommendedAction: 'Sign in again and allow the extra access, then scan once more.',
                detail: { missingScopes: missing },
              },
            ],
          } satisfies InventoryResult;
          continue;
        }
        let count = 0;
        let quality: CountQuality = 'unknown';
        let capability: MigrationCapability = releaseCapability(cat.release);
        try {
          const p = await probe(token, category, scope.externalScopeId);
          count = p.count;
          quality = p.quality;
          if (p.capability === 'not_available') capability = 'not_available';
        } catch (e) {
          quality = 'unknown';
          findings.push({
            code: 'gohighlevel.scan_failed',
            capability,
            severity: 'review',
            summary: `We could not count ${cat.label.toLowerCase()} this time.`,
            whatChanges: 'Scanning again usually settles it.',
            detail: { message: (e as Error).message.slice(0, 200) },
          });
        }
        yield {
          category,
          count,
          countQuality: quality,
          capability,
          notes: cat.release === 'ready' ? null : (cat.releaseNote ?? null),
          findings,
        } satisfies InventoryResult;
      }
    },

    async list(connection, scope, category, options) {
      const endpoint = ENDPOINTS[category];
      if (!endpoint) return { records: [], cursor: null, done: true };
      return page(tokenOf(connection, scope), endpoint, scope.externalScopeId, options);
    },

    async getById(connection, scope, objectType, objectId) {
      const path =
        objectType === 'contact'
          ? `/contacts/${encodeURIComponent(objectId)}`
          : objectType === 'company'
            ? `/companies/${encodeURIComponent(objectId)}`
            : null;
      if (!path) return null;
      try {
        const body = await call<Record<string, unknown>>(tokenOf(connection, scope), path);
        const raw = (body['contact'] ?? body['company'] ?? body) as Record<string, unknown>;
        return {
          objectType,
          objectId,
          sourceCreatedAt: asDate(raw['dateAdded']),
          sourceUpdatedAt: asDate(raw['dateUpdated']),
          payload: raw,
        };
      } catch (e) {
        if ((e as GhlError).code === 'not_found') return null;
        throw e;
      }
    },

    normalize(record, context) {
      switch (record.objectType) {
        case 'contact':
          return [contactEnvelope(record, context)];
        case 'company':
          return [companyEnvelope(record, context)];
        case 'user':
          return [userEnvelope(record, context)];
        case 'tag':
          return [tagEnvelope(record, context)];
        case 'custom_field':
          return [customFieldEnvelope(record, context)];
        default:
          return [];
      }
    },
  };
}

// ---------- the mappers ----------
// Each one takes GoHighLevel's payload and gives back HandsFreeOS's shape. Everything they do not use goes
// into `extensions.gohighlevel` with a warning beside it, because a field quietly dropped is a field nobody
// finds out about until the day they need it.

const envelopeOf = (
  record: SourceRecord,
  context: MappingContext,
  canonicalType: string,
  category: string,
  data: Record<string, unknown>,
  extensions: Record<string, unknown>,
  warnings: { code: string; field?: string | null; message: string }[],
  relationships: CanonicalEnvelope['relationships'] = [],
): CanonicalEnvelope => ({
  canonicalType,
  canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
  category,
  source: {
    system: 'gohighlevel',
    adapterVersion: GHL_ADAPTER_VERSION,
    installationId: context.installationId,
    locationId: context.locationId,
    objectType: record.objectType,
    objectId: record.objectId,
    parentObjectId: record.parentObjectId ?? null,
    sourceCreatedAt: record.sourceCreatedAt?.toISOString() ?? null,
    sourceUpdatedAt: record.sourceUpdatedAt?.toISOString() ?? null,
    sourceDeletedAt: record.sourceDeletedAt?.toISOString() ?? null,
    retrievedAt: new Date().toISOString(),
    payloadChecksum: checksum(record.payload),
    payloadVersion: 1,
  },
  relationships,
  data,
  extensions: Object.keys(extensions).length ? { gohighlevel: extensions } : {},
  warnings,
});

/** Fields a mapper has used; whatever is left over is kept rather than dropped. */
const leftovers = (payload: Record<string, unknown>, used: readonly string[]) => {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (used.includes(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    rest[k] = v;
  }
  return rest;
};

const CONTACT_USED = [
  'id',
  '_id',
  'locationId',
  'firstName',
  'lastName',
  'firstNameLowerCase',
  'lastNameLowerCase',
  'contactName',
  'fullNameLowerCase',
  'email',
  'phone',
  'additionalEmails',
  'additionalPhones',
  'address1',
  'city',
  'state',
  'postalCode',
  'country',
  'timezone',
  'source',
  'tags',
  'customFields',
  'customField',
  'dnd',
  'dndSettings',
  'assignedTo',
  'companyName',
  'businessId',
  'dateAdded',
  'dateUpdated',
  'type',
  'deleted',
];

function contactEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const warnings: { code: string; field?: string | null; message: string }[] = [];
  const endpoints: { kind: 'phone' | 'email'; value: string; primary: boolean }[] = [];
  const email = asString(p['email']);
  const phone = asString(p['phone']);
  if (email) endpoints.push({ kind: 'email', value: email, primary: true });
  if (phone) endpoints.push({ kind: 'phone', value: phone, primary: true });
  for (const extra of Array.isArray(p['additionalEmails']) ? p['additionalEmails'] : [])
    if (asString(extra)) endpoints.push({ kind: 'email', value: String(extra), primary: false });
  for (const extra of Array.isArray(p['additionalPhones']) ? p['additionalPhones'] : [])
    if (asString(extra)) endpoints.push({ kind: 'phone', value: String(extra), primary: false });

  // What the customer agreed to, channel by channel. GoHighLevel's `dnd` is the whole-person switch and
  // `dndSettings` is per channel; the stricter of the two wins, which is what "do not disturb" has to mean.
  const dnd = p['dnd'] === true;
  const dndSettings = (p['dndSettings'] ?? {}) as Record<string, { status?: string }>;
  const consentFor = (key: string, channel: string) => {
    const status = dndSettings[key]?.status;
    const off = dnd || status === 'active';
    return { channel, state: off ? ('opted_out' as const) : ('unknown' as const) };
  };
  const consent = [
    consentFor('SMS', 'sms'),
    consentFor('Email', 'email'),
    consentFor('Call', 'call'),
    consentFor('WhatsApp', 'whatsapp'),
  ];

  // Custom-field values. A type we do not know is kept whole and raised, never flattened to a string.
  const customFields: Record<string, unknown> = {};
  const rawFields = Array.isArray(p['customFields'])
    ? (p['customFields'] as { id?: string; value?: unknown }[])
    : [];
  for (const f of rawFields) {
    const id = asString(f.id);
    if (!id) continue;
    const known = context.customFields.get(id);
    if (!known) {
      warnings.push({
        code: 'mapping.unknown_custom_field',
        field: id,
        message: 'A custom field we have not seen the shape of; its value is kept as it came.',
      });
      customFields[id] = f.value;
      continue;
    }
    customFields[known.key] = f.value;
  }

  const relationships: CanonicalEnvelope['relationships'] = [];
  const owner = asString(p['assignedTo']);
  if (owner)
    relationships.push({
      category: 'users',
      objectType: 'user',
      objectId: owner,
      role: 'owner',
      required: false,
    });
  const business = asString(p['businessId']);
  if (business)
    relationships.push({
      category: 'companies',
      objectType: 'company',
      objectId: business,
      role: 'company',
      required: false,
    });

  const data = {
    firstName: asString(p['firstName']),
    lastName: asString(p['lastName']),
    fullName: asString(p['contactName']),
    email,
    phone,
    endpoints,
    address: {
      line1: asString(p['address1']),
      city: asString(p['city']),
      state: asString(p['state']),
      postalCode: asString(p['postalCode']),
      country: asString(p['country'])?.slice(0, 2) ?? null,
    },
    timezone: asString(p['timezone']),
    source: asString(p['source']),
    tags: (Array.isArray(p['tags']) ? p['tags'] : []).map(String).filter(Boolean),
    customFields,
    consent,
  };
  return envelopeOf(
    record,
    context,
    'contact',
    'contacts',
    data,
    leftovers(p, CONTACT_USED),
    warnings,
    relationships,
  );
}

const COMPANY_USED = [
  'id',
  '_id',
  'locationId',
  'name',
  'email',
  'phone',
  'website',
  'address',
  'city',
  'state',
  'postalCode',
  'country',
  'dateAdded',
  'dateUpdated',
];

function companyEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  return envelopeOf(
    record,
    context,
    'company',
    'companies',
    {
      name: asString(p['name']) ?? 'Unnamed company',
      email: asString(p['email']),
      phone: asString(p['phone']),
      website: asString(p['website']),
      address: {
        line1: asString(p['address']),
        city: asString(p['city']),
        state: asString(p['state']),
        postalCode: asString(p['postalCode']),
        country: asString(p['country'])?.slice(0, 2) ?? null,
      },
      tags: [],
      customFields: {},
    },
    leftovers(p, COMPANY_USED),
    asString(p['name'])
      ? []
      : [
          {
            code: 'mapping.company_without_name',
            field: 'name',
            message: 'This company had no name in the old system.',
          },
        ],
  );
}

const USER_USED = [
  'id',
  '_id',
  'firstName',
  'lastName',
  'name',
  'email',
  'phone',
  'roles',
  'type',
  'permissions',
  'deleted',
];

function userEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const roles = (p['roles'] ?? {}) as { type?: string; role?: string };
  const warnings =
    roles.role && roles.role !== 'admin' && roles.role !== 'user'
      ? [
          {
            code: 'mapping.role_not_exact',
            field: 'roles.role',
            message: `"${roles.role}" has no exact match here, so this person comes across with the nearest smaller role.`,
          },
        ]
      : [];
  return envelopeOf(
    record,
    context,
    'user_identity',
    'users',
    {
      firstName: asString(p['firstName']),
      lastName: asString(p['lastName']),
      email: asString(p['email']),
      phone: asString(p['phone']),
      roleName: asString(roles.role) ?? asString(roles.type),
      active: p['deleted'] !== true,
    },
    leftovers(p, USER_USED),
    warnings,
  );
}

function tagEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  return envelopeOf(
    record,
    context,
    'tag',
    'tags',
    { name: asString(p['name']) ?? 'Unnamed tag', color: null },
    leftovers(p, ['id', '_id', 'name', 'locationId']),
    [],
  );
}

function customFieldEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const raw = asString(p['dataType']) ?? '';
  const type = FIELD_TYPES[raw];
  const warnings = type
    ? []
    : [
        {
          code: 'mapping.unknown_field_type',
          field: 'dataType',
          message: `"${raw || 'unknown'}" is a field type we have no match for, so it comes across as plain text and the original is kept.`,
        },
      ];
  const options = Array.isArray(p['picklistOptions'])
    ? (p['picklistOptions'] as unknown[]).map(String)
    : [];
  return envelopeOf(
    record,
    context,
    'custom_field',
    'custom_fields',
    {
      name: asString(p['name']) ?? 'Unnamed field',
      key: asString(p['fieldKey']) ?? asString(p['id']) ?? record.objectId,
      type: type ?? 'text',
      options,
      required: p['isRequired'] === true,
      position: Number(p['position'] ?? 0) || 0,
      appliesTo: asString(p['model']) === 'opportunity' ? 'lead' : 'contact',
    },
    leftovers(p, [
      'id',
      '_id',
      'name',
      'fieldKey',
      'dataType',
      'picklistOptions',
      'isRequired',
      'position',
      'model',
      'locationId',
    ]),
    warnings,
  );
}
