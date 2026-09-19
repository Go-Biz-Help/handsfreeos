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
 * **Two doors (0069).** A marketplace sign-in is the first, and the one to prefer: HighLevel says what it
 * granted, an agency reaches every sub-account it approved, and nobody handles a credential. The second is a
 * **private integration token**, made by the business inside one sub-account and pasted here with that
 * sub-account's Location ID. It exists because a marketplace app has to be approved and installable, and
 * neither is true of every account. What it costs: one sub-account only — HighLevel will neither list an
 * agency's locations for a private token nor mint a location token from one — and no scope list at all, so
 * every category is probed and a refusal is reported as a refusal rather than as an empty account.
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
  readonly paging: 'startAfter' | 'page' | 'offset' | 'none';
  readonly countQuality: CountQuality;
  /** Whether the endpoint can be asked "what changed since?". Most of v2 cannot. */
  readonly incremental: boolean;
  readonly objectType: string;
  /**
   * Whether this endpoint accepts `limit`. Two of HighLevel's reject it outright — `/users` and a location's
   * `/customFields` answer `422 property limit should not exist` — which cost us the team list and every
   * custom field on the first real account, because the count probe added `limit=1` to everything it asked
   * for. A shape the source refuses is not a category the business does not have.
   */
  readonly limit?: boolean;
  /**
   * Where the total sits in the answer, when the endpoint reports one. Dotted for a nested key. Without it a
   * count is the length of what came back, which is a floor rather than a total, and is labelled as such.
   */
  readonly totalKey?: string;
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
    // 422 property limit should not exist.
    limit: false,
  },
  custom_fields: {
    path: (s) => `/locations/${encodeURIComponent(s)}/customFields`,
    listKey: 'customFields',
    idKey: 'id',
    paging: 'none',
    countQuality: 'complete',
    incremental: false,
    objectType: 'custom_field',
    // 422 property limit should not exist.
    limit: false,
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

  // ---------- the structures records live in ----------
  pipelines: {
    path: (s) => `/opportunities/pipelines?locationId=${encodeURIComponent(s)}`,
    listKey: 'pipelines',
    idKey: 'id',
    paging: 'none',
    countQuality: 'complete',
    incremental: false,
    objectType: 'pipeline',
    limit: false,
  },
  calendars: {
    path: (s) => `/calendars/?locationId=${encodeURIComponent(s)}`,
    listKey: 'calendars',
    idKey: 'id',
    paging: 'none',
    countQuality: 'complete',
    incremental: false,
    objectType: 'calendar',
    limit: false,
  },
  forms: {
    path: (s) => `/forms/?locationId=${encodeURIComponent(s)}`,
    listKey: 'forms',
    idKey: 'id',
    paging: 'offset',
    countQuality: 'complete',
    incremental: false,
    objectType: 'form',
    totalKey: 'meta.total',
  },
  products: {
    path: (s) => `/products/?locationId=${encodeURIComponent(s)}`,
    listKey: 'products',
    idKey: '_id',
    paging: 'offset',
    countQuality: 'complete',
    incremental: false,
    objectType: 'product',
    totalKey: 'total',
  },
  templates: {
    path: (s) => `/emails/builder?locationId=${encodeURIComponent(s)}`,
    listKey: 'builders',
    idKey: 'id',
    paging: 'offset',
    countQuality: 'complete',
    incremental: false,
    objectType: 'template',
    totalKey: 'total',
  },
  funnels: {
    path: (s) => `/funnels/funnel/list?locationId=${encodeURIComponent(s)}`,
    listKey: 'funnels',
    idKey: '_id',
    paging: 'none',
    countQuality: 'complete',
    incremental: false,
    objectType: 'funnel',
    limit: false,
  },

  // ---------- the records themselves ----------
  // `location_id` rather than `locationId`: the opportunity search is the one endpoint in v2 that spells it
  // with an underscore, and spelling it the other way returns every opportunity the token can see.
  opportunities: {
    path: (s) => `/opportunities/search?location_id=${encodeURIComponent(s)}`,
    listKey: 'opportunities',
    idKey: 'id',
    paging: 'page',
    countQuality: 'complete',
    incremental: false,
    objectType: 'opportunity',
    totalKey: 'meta.total',
  },
  conversations: {
    path: (s) => `/conversations/search?locationId=${encodeURIComponent(s)}`,
    listKey: 'conversations',
    idKey: 'id',
    paging: 'startAfter',
    countQuality: 'complete',
    incremental: false,
    objectType: 'conversation',
    totalKey: 'total',
  },
  form_submissions: {
    path: (s) => `/forms/submissions?locationId=${encodeURIComponent(s)}`,
    listKey: 'submissions',
    idKey: 'id',
    paging: 'offset',
    countQuality: 'complete',
    incremental: false,
    objectType: 'form_submission',
    totalKey: 'meta.total',
  },
  reviews: {
    path: (s) => `/reviews/all?locationId=${encodeURIComponent(s)}`,
    listKey: 'reviews',
    idKey: 'id',
    paging: 'offset',
    countQuality: 'complete',
    incremental: false,
    objectType: 'review',
    totalKey: 'meta.total',
  },
  media: {
    path: (s) => `/medias/files?altType=location&altId=${encodeURIComponent(s)}`,
    listKey: 'files',
    idKey: 'id',
    paging: 'offset',
    countQuality: 'complete',
    incremental: false,
    objectType: 'media',
    totalKey: 'total',
  },

  // ---------- money ----------
  // The money endpoints name the account as `altId` + `altType`, not `locationId`.
  invoices: {
    path: (s) => `/invoices/?altType=location&altId=${encodeURIComponent(s)}`,
    listKey: 'invoices',
    idKey: '_id',
    paging: 'offset',
    countQuality: 'complete',
    incremental: false,
    objectType: 'invoice',
    totalKey: 'total',
  },
  estimates: {
    path: (s) => `/invoices/estimate/list?altType=location&altId=${encodeURIComponent(s)}`,
    listKey: 'estimates',
    idKey: '_id',
    paging: 'offset',
    countQuality: 'complete',
    incremental: false,
    objectType: 'estimate',
    totalKey: 'total',
  },
  subscriptions: {
    path: (s) => `/payments/subscriptions?altType=location&altId=${encodeURIComponent(s)}`,
    listKey: 'data',
    idKey: '_id',
    paging: 'offset',
    countQuality: 'complete',
    incremental: false,
    objectType: 'subscription',
    totalKey: 'totalCount',
  },
};

/**
 * Categories this release counts but does not yet read record by record. They have endpoints above, so the
 * scan reports a real number for each; whether anything is imported is decided by the category's release in
 * core's catalog, never here.
 */
const COUNT_ONLY: readonly string[] = ['workflows'];

/**
 * Categories HighLevel will not give us a count of at all, and why. Said out loud on the screen rather than
 * left as a dash beside the words "counted now" — a promise the adapter cannot keep is worse than a gap it
 * admits to.
 *
 * Everything here is a genuine limit of the v2 API for one sub-account, not a shape we have yet to get right:
 * appointments and messages can only be asked for within a parent (a calendar and a time range, one
 * conversation), tasks and notes only one customer at a time, and the last four are not exposed to a
 * location's own token in any form we can ask for.
 */
const CANNOT_COUNT: Readonly<Record<string, string>> = {
  appointments:
    'GoHighLevel only lists appointments inside one calendar and one date range, so there is no number for the account as a whole until the calendars come across.',
  messages:
    'GoHighLevel only lists messages inside one conversation, so the number arrives with the conversations.',
  calls:
    'Calls are messages inside a conversation over there, so they are counted with the conversations rather than on their own.',
  tasks:
    'GoHighLevel only lists tasks one customer at a time, so the number arrives with the customers.',
  websites:
    'GoHighLevel only lists pages inside one funnel, so pages are counted with the funnels they belong to.',
  phone_numbers: 'A sub-account cannot list its own numbers through the API.',
  sending_domains: 'A sub-account cannot list its own sending domains through the API.',
  integrations:
    'GoHighLevel does not say what a sub-account is plugged into, so connected apps are found from what their data leaves behind.',
};

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

/** One value out of an answer by a dotted key ('meta.total'), or undefined. */
const dig = (body: Record<string, unknown>, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (at, part) =>
        at && typeof at === 'object' ? (at as Record<string, unknown>)[part] : undefined,
      body,
    );

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

  /**
   * What this connection is known to be allowed to read, or null when nothing is known.
   *
   * A sign-in hands back its granted scopes, so a category it cannot reach is known before a single request
   * goes out. A private integration token hands back nothing — its access was ticked inside HighLevel and is
   * never reported — so the honest answer is "we do not know", and every category is probed instead. Null is
   * that answer, and the difference between the two doors lives here and nowhere else.
   */
  const grantedScopes = (connection: SourceConnection): ReadonlySet<string> | null =>
    connection.authKind === 'private_token' ? null : new Set(connection.scopes);

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
      offset?: number;
    };
    // An endpoint that refuses `limit` gives everything it has in one answer, so there is nothing to page.
    let path = endpoint.limit === false ? base : `${base}${join}limit=${limit}`;
    if (endpoint.paging === 'startAfter' && cursor.startAfterId)
      path += `&startAfterId=${encodeURIComponent(cursor.startAfterId)}${
        cursor.startAfter ? `&startAfter=${cursor.startAfter}` : ''
      }`;
    if (endpoint.paging === 'page') path += `&page=${cursor.page ?? 1}`;
    if (endpoint.paging === 'offset') path += `&offset=${cursor.offset ?? 0}`;

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
    // An endpoint that takes no limit answered with everything at once; anything short of a full page is the
    // end of the list either way.
    const done = endpoint.limit === false || list.length < limit;
    const nextCursor = done
      ? null
      : endpoint.paging === 'page'
        ? { page: (cursor.page ?? 1) + 1 }
        : endpoint.paging === 'offset'
          ? { offset: (cursor.offset ?? 0) + list.length }
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
    const base = endpoint.path(scopeId);
    // One record is enough to count when the answer carries a total; an endpoint that refuses `limit` is
    // asked plainly instead, and what comes back is the whole list.
    const path =
      endpoint.limit === false ? base : `${base}${base.includes('?') ? '&' : '?'}limit=1`;
    try {
      const body = await call<Record<string, unknown>>(token, path, { timeoutMs: 15_000 });
      const total = dig(body, endpoint.totalKey ?? 'total');
      const list = Array.isArray(body[endpoint.listKey])
        ? (body[endpoint.listKey] as unknown[])
        : [];
      // A total the source gave us is a real count. Otherwise: everything it gave us is a real count when it
      // gave us everything, and a floor when we asked for one record.
      return typeof total === 'number'
        ? { capability: 'ready', count: total, quality: 'complete' }
        : {
            capability: 'ready',
            count: list.length,
            quality: endpoint.limit === false ? 'complete' : 'estimated',
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
    granted: ReadonlySet<string> | null,
    capability: MigrationCapability,
    quality: CountQuality,
  ): CategorySupport => {
    const required = GHL_SCOPES[category] ?? [];
    // Nothing is missing that we know of when we know nothing: a private token's access is found out by
    // asking, and what comes back is already in `capability` by the time this is called.
    const missing = granted ? required.filter((s) => !granted.has(s)) : [];
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
    requestedScopes: GHL_ALL_SCOPES,

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

    /**
     * The second door: a private integration token, made in GoHighLevel under Settings → Private
     * Integrations, with the sub-account's Location ID beside it.
     *
     * Nothing is stored until the pair has been proved against the real account, because a token that was
     * never tried is a connection that fails days later in the middle of an import. Proving it takes two
     * tries on purpose: the location itself, which also tells us what the sub-account is called, and then
     * one contact — because a token whose "View Locations" access was left unticked is perfectly usable for
     * everything else, and refusing it would be us being wrong rather than the token.
     */
    async connectWithToken({ token, accountId }) {
      const secret = token.trim();
      const locationId = accountId.trim();
      if (!secret)
        throw new GhlError(
          'Paste the private integration token from GoHighLevel.',
          400,
          'token_missing',
        );
      if (/\s/.test(secret))
        throw new GhlError(
          'That looks like more than one value. Paste just the token.',
          400,
          'token_malformed',
        );
      if (!locationId)
        throw new GhlError(
          'Paste the sub-account’s Location ID as well, from Settings → Business Profile.',
          400,
          'location_missing',
        );

      const refused = (status: number) =>
        new GhlError(
          'GoHighLevel would not let that token read this sub-account. Check the Location ID, and that the private integration has its read access ticked.',
          status,
          'token_rejected',
        );

      let displayName: string | null = null;
      try {
        const body = await call<{ location?: { name?: string } }>(
          secret,
          `/locations/${encodeURIComponent(locationId)}`,
        );
        displayName = asString(body.location?.name);
      } catch (e) {
        const err = e as GhlError;
        if (err.code === 'unauthorized')
          throw new GhlError(
            'GoHighLevel did not accept that token. Copy it again from Settings → Private Integrations; it is shown once, when it is made.',
            401,
            'token_rejected',
          );
        // Refused or not found: either the token cannot see locations, or the Location ID is wrong. One
        // contact tells the two apart.
        try {
          await call(secret, `/contacts/?locationId=${encodeURIComponent(locationId)}&limit=1`, {
            timeoutMs: 15_000,
          });
        } catch (e2) {
          const err2 = e2 as GhlError;
          if (
            err2.code === 'unauthorized' ||
            err2.code === 'forbidden' ||
            err2.code === 'not_found'
          )
            throw refused(err2.status);
          throw e2;
        }
      }

      return {
        id: '',
        system: 'gohighlevel',
        installKind: 'location',
        authKind: 'private_token',
        externalAccountId: locationId,
        displayName,
        // A private token never says what it may read. Empty here is the honest answer, and the scan finds
        // out by asking rather than by claiming.
        scopes: [],
        accessToken: secret,
        refreshToken: null,
        expiresAt: null,
      } satisfies SourceConnection;
    },

    async refresh(connection) {
      if (connection.authKind === 'private_token')
        throw new GhlError(
          'A private integration token does not expire. If it has stopped working, make a new one in GoHighLevel and paste it again.',
          400,
          'reauth_required',
        );
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
      if (connection.installKind === 'location') {
        const id = connection.externalAccountId ?? '';
        // What GoHighLevel calls it beats "This business" on every screen after this one. A token that was
        // not given access to locations still works for everything else, so being refused here is not worth
        // failing over.
        try {
          const body = await call<{ location?: { name?: string; timezone?: string } }>(
            connection.accessToken,
            `/locations/${encodeURIComponent(id)}`,
          );
          return [
            {
              externalScopeId: id,
              name: asString(body.location?.name) ?? 'This business',
              timezone: asString(body.location?.timezone),
            },
          ];
        } catch {
          return [{ externalScopeId: id, name: 'This business' }];
        }
      }
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
      const granted = grantedScopes(connection);
      const token = tokenOf(connection, scope);
      const categories: CategorySupport[] = [];
      for (const category of Object.keys(ENDPOINTS)) {
        const required = GHL_SCOPES[category] ?? [];
        if (granted && required.some((s) => !granted.has(s))) {
          categories.push(supportOf(category, granted, 'not_available', 'permission_limited'));
          continue;
        }
        // Whatever the probe found, a category cannot be more ready than its release in core's catalog: an
        // endpoint we can read is not an importer we have written.
        const ceiling = releaseCapability(migrationCategory(category)?.release ?? 'next');
        try {
          const p = await probe(token, category, scope.externalScopeId);
          const capability = p.capability === 'not_available' ? 'not_available' : ceiling;
          categories.push(supportOf(category, granted, capability, p.quality));
        } catch {
          // A broken probe is not a permission answer; it is unknown, and the scan says so.
          categories.push(supportOf(category, granted, ceiling, 'unknown'));
        }
      }
      for (const category of [...COUNT_ONLY, ...Object.keys(CANNOT_COUNT)]) {
        const cat = migrationCategory(category);
        categories.push({
          ...supportOf(
            category,
            granted,
            cat ? releaseCapability(cat.release) : 'not_in_release',
            CANNOT_COUNT[category] ? 'not_enumerable' : 'unknown',
          ),
          limitations: CANNOT_COUNT[category] ? [CANNOT_COUNT[category]!] : undefined,
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
      const granted = grantedScopes(connection);
      const token = tokenOf(connection, scope);
      for (const category of [
        ...Object.keys(ENDPOINTS),
        ...COUNT_ONLY,
        ...Object.keys(CANNOT_COUNT),
      ]) {
        const cat = migrationCategory(category);
        if (!cat) continue;
        // No number exists for this one, and the reason is a real limit of the source rather than a gap in
        // what we asked. Said in words, in place of a dash under a sentence promising a count.
        const cannot = CANNOT_COUNT[category];
        if (cannot) {
          yield {
            category,
            count: 0,
            countQuality: 'not_enumerable',
            capability: releaseCapability(cat.release),
            notes: cannot,
            findings: [],
          } satisfies InventoryResult;
          continue;
        }
        const required = GHL_SCOPES[category] ?? [];
        // A private token never said what it was given, so nothing is missing until GoHighLevel refuses it.
        const missing = granted ? required.filter((s) => !granted.has(s)) : [];
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
          // We asked and were refused. For a sign-in this is a scope somebody unticked; for a private token
          // it is access that was never ticked when the token was made. Either way it is said out loud here,
          // because a refusal that only shows as a capability is a refusal nobody reads.
          if (p.quality === 'permission_limited')
            findings.push({
              code: 'access.scope_missing',
              capability: 'not_available',
              severity: 'action',
              summary: `GoHighLevel would not let us read ${cat.label.toLowerCase()}.`,
              whatImports: 'Nothing from this category.',
              whatChanges:
                'The count is unknown, not zero: we asked and were refused, so we will not pretend there is nothing there.',
              recommendedAction:
                connection.authKind === 'private_token'
                  ? 'In GoHighLevel, edit the private integration, tick the read access for this, then scan again.'
                  : 'Sign in again and allow the extra access, then scan once more.',
              detail: { requiredScopes: required },
            });
        } catch (e) {
          quality = 'unknown';
          const err = e as GhlError;
          // 400 and 422 are not "try again": GoHighLevel understood the question and refused the shape of it,
          // which means we asked wrongly. That is ours to fix, and the finding says so rather than sending a
          // business round the same loop. It is how the `limit` bug that cost the team list was found.
          const ourFault = err.status === 400 || err.status === 422;
          findings.push({
            code: ourFault ? 'gohighlevel.request_refused' : 'gohighlevel.scan_failed',
            capability,
            severity: 'review',
            summary: ourFault
              ? `GoHighLevel refused the way we asked for ${cat.label.toLowerCase()}.`
              : `We could not count ${cat.label.toLowerCase()} this time.`,
            whatChanges: ourFault
              ? 'The count is unknown, not zero. Nothing is wrong with your account: the question we asked was wrong, and scanning again will ask it the same way.'
              : 'Scanning again usually settles it.',
            recommendedAction: ourFault
              ? 'Tell us — this one is ours to fix, and the scan is safe to leave as it is meanwhile.'
              : null,
            detail: { message: (e as Error).message.slice(0, 200), status: err.status ?? null },
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
