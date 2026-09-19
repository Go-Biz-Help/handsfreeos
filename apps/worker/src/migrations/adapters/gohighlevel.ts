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
  CanonicalFormQuestion,
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

/**
 * How far back appointments are read from, how far ahead, and in what size of window. 2015 is early enough for
 * any business HandsFreeOS is for, and two years ahead covers an annual service booked a year out.
 */
const APPOINTMENTS_FROM = Date.UTC(2015, 0, 1);
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

/** How many customers one page of the tasks-and-notes walk asks about. Two requests each. */
const CUSTOMERS_PER_PAGE = 10;

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

/**
 * The message types GoHighLevel uses for a call or a voicemail. Everything else in a conversation is a
 * message, and these become calls here, where a call has a duration, a recording and a transcript.
 */
const CALL_TYPES = new Set(['TYPE_CALL', 'CALL', 'TYPE_VOICEMAIL', 'VOICEMAIL', 'TYPE_PHONE_CALL']);

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

  /**
   * Forms, each one carrying a sample of its own answers.
   *
   * HighLevel's `/forms/` hands over a name and an id and nothing about what the form asks. The questions
   * are only visible in the answers, so each form is read once more — twenty submissions, enough to see
   * every field somebody has filled in — and the sample travels on the payload for the mapper to read back.
   * One extra request per form, on a list that is usually a handful.
   */
  const formPage = async (
    token: string,
    scopeId: string,
    options: ListOptions,
  ): Promise<SourcePage> => {
    const forms = await page(token, ENDPOINTS['forms']!, scopeId, options);
    const records: SourceRecord[] = [];
    for (const form of forms.records) {
      let sample: Record<string, unknown>[] = [];
      try {
        const body = await call<Record<string, unknown>>(
          token,
          `/forms/submissions?locationId=${encodeURIComponent(scopeId)}` +
            `&formId=${encodeURIComponent(form.objectId)}&limit=20`,
        );
        sample = Array.isArray(body['submissions'])
          ? (body['submissions'] as Record<string, unknown>[])
          : [];
      } catch {
        // A form whose answers we may not read still comes across as a form; it simply arrives with no
        // questions on it, and says so.
        sample = [];
      }
      records.push({ ...form, payload: { ...form.payload, __sampleSubmissions: sample } });
    }
    return { ...forms, records };
  };

  /**
   * A page of tasks and notes, walked customer by customer.
   *
   * GoHighLevel keeps both on the customer and nowhere else: there is no list of a sub-account's tasks, which
   * is why the scan says it cannot count them. So this walks the customers ten at a time and asks each for
   * both — two requests per customer, which is the cost of having them at all, and cheaper than the same walk
   * twice.
   */
  const taskPage = async (
    token: string,
    scopeId: string,
    options: ListOptions,
  ): Promise<SourcePage> => {
    const cursor = (options.cursor ?? {}) as {
      queue?: string[];
      contacts?: { startAfterId?: string; startAfter?: number } | null;
      contactsDone?: boolean;
    };
    let queue = [...(cursor.queue ?? [])];
    let contacts = cursor.contacts ?? null;
    let contactsDone = cursor.contactsDone ?? false;

    while (queue.length === 0 && !contactsDone) {
      const endpoint = ENDPOINTS['contacts']!;
      const base = endpoint.path(scopeId);
      let path = `${base}&limit=100`;
      if (contacts?.startAfterId) {
        path += `&startAfterId=${encodeURIComponent(contacts.startAfterId)}`;
        if (contacts.startAfter) path += `&startAfter=${contacts.startAfter}`;
      }
      const body = await call<{ contacts?: Record<string, unknown>[] }>(token, path);
      const list = body.contacts ?? [];
      queue = list.map((c) => asString(c['id']) ?? asString(c['_id']) ?? '').filter(Boolean);
      const last = list[list.length - 1];
      contactsDone = list.length < 100 || !last;
      contacts = last
        ? {
            startAfterId: asString(last['id']) ?? asString(last['_id']) ?? '',
            startAfter: Number(last['dateAdded'] ?? last['dateUpdated'] ?? 0) || undefined,
          }
        : null;
    }
    if (queue.length === 0) return { records: [], cursor: null, highWaterAt: null, done: true };

    const take = queue.slice(0, CUSTOMERS_PER_PAGE);
    const records: SourceRecord[] = [];
    let highWaterAt: Date | null = null;
    for (const contactId of take) {
      for (const want of ['tasks', 'notes'] as const) {
        let body: Record<string, unknown>;
        try {
          body = await call<Record<string, unknown>>(
            token,
            `/contacts/${encodeURIComponent(contactId)}/${want}`,
          );
        } catch (e) {
          // One customer's list being refused must not stop the walk: their own record already came across,
          // and the scan's findings carry what could not be read.
          if ((e as GhlError).code === 'not_found' || (e as GhlError).code === 'forbidden')
            continue;
          throw e;
        }
        const list = Array.isArray(body[want]) ? (body[want] as Record<string, unknown>[]) : [];
        for (const raw of list) {
          const id = asString(raw['id']) ?? asString(raw['_id']);
          if (!id) continue;
          const at = asDate(raw['dateUpdated'] ?? raw['dateAdded'] ?? raw['createdAt']);
          if (options.until && at && at > options.until) continue;
          if (options.changedSince && at && at <= options.changedSince) continue;
          if (at && (!highWaterAt || at > highWaterAt)) highWaterAt = at;
          records.push({
            objectType: want === 'tasks' ? 'task' : 'note',
            objectId: id,
            parentObjectId: contactId,
            sourceCreatedAt: asDate(raw['dateAdded'] ?? raw['createdAt']) ?? at,
            sourceUpdatedAt: at,
            payload: { ...raw, contactId },
          });
        }
      }
    }
    const rest = queue.slice(take.length);
    const done = rest.length === 0 && contactsDone;
    return {
      records,
      cursor: done ? null : { queue: rest, contacts, contactsDone },
      highWaterAt,
      done,
    };
  };

  /**
   * A page of appointments, walked calendar by calendar and window by window.
   *
   * GoHighLevel will not list a sub-account's appointments: it lists one calendar's events between two
   * moments. So this keeps three things in its cursor — which calendars are left, where in time it has got
   * to, and nothing else — and walks from `APPOINTMENTS_FROM` to two years ahead in windows. Past visits are
   * the point (a business's history is mostly behind it) and the future matters just as much, because
   * tomorrow's visit has to be here on the morning they move in.
   */
  const appointmentPage = async (
    token: string,
    scopeId: string,
    options: ListOptions,
  ): Promise<SourcePage> => {
    const cursor = (options.cursor ?? {}) as {
      queue?: string[];
      from?: number;
      listed?: boolean;
    };
    let queue = [...(cursor.queue ?? [])];
    let from = cursor.from ?? APPOINTMENTS_FROM;
    // The calendars, once: there is no paging over them.
    if (!cursor.listed) {
      const body = await call<{ calendars?: Record<string, unknown>[] }>(
        token,
        ENDPOINTS['calendars']!.path(scopeId),
      );
      queue = (body.calendars ?? [])
        .map((c) => asString(c['id']) ?? asString(c['_id']) ?? '')
        .filter(Boolean);
      from = APPOINTMENTS_FROM;
    }
    const horizon = Date.now() + TWO_YEARS_MS;
    while (queue.length > 0 && from >= horizon) {
      queue = queue.slice(1);
      from = APPOINTMENTS_FROM;
    }
    if (queue.length === 0) return { records: [], cursor: null, highWaterAt: null, done: true };

    const calendarId = queue[0]!;
    const to = Math.min(from + WINDOW_MS, horizon);
    const body = await call<{ events?: Record<string, unknown>[] }>(
      token,
      `/calendars/events?locationId=${encodeURIComponent(scopeId)}&calendarId=${encodeURIComponent(
        calendarId,
      )}&startTime=${from}&endTime=${to}`,
    );
    const list = body.events ?? [];
    const records: SourceRecord[] = [];
    let highWaterAt: Date | null = null;
    for (const raw of list) {
      const id = asString(raw['id']) ?? asString(raw['_id']);
      if (!id) continue;
      const updatedAt = asDate(raw['dateUpdated']) ?? asDate(raw['startTime']);
      if (options.until && updatedAt && updatedAt > options.until) continue;
      if (options.changedSince && updatedAt && updatedAt <= options.changedSince) continue;
      if (updatedAt && (!highWaterAt || updatedAt > highWaterAt)) highWaterAt = updatedAt;
      records.push({
        objectType: 'appointment',
        objectId: id,
        parentObjectId: calendarId,
        sourceCreatedAt: asDate(raw['dateAdded']) ?? updatedAt,
        sourceUpdatedAt: updatedAt,
        payload: { ...raw, calendarId },
      });
    }
    // On through time, then on to the next calendar.
    const nextFrom = to;
    const doneWithThis = nextFrom >= horizon;
    const nextQueue = doneWithThis ? queue.slice(1) : queue;
    const done = nextQueue.length === 0;
    return {
      records,
      cursor: done
        ? null
        : { queue: nextQueue, from: doneWithThis ? APPOINTMENTS_FROM : nextFrom, listed: true },
      highWaterAt,
      done,
    };
  };

  /**
   * A page of messages, walked through the conversations they belong to.
   *
   * GoHighLevel has no way to ask a sub-account for its messages: they exist only inside a conversation. So
   * this keeps its place in two dimensions at once — which conversations are left on the current page, and
   * where we got to inside the one being read — and hands both back in the cursor. The engine sees an
   * ordinary page of records and never learns that two reads were involved, which is the seam the milestone
   * is built to keep.
   *
   * Calls and voicemail come out of the same walk: over there a call is a message whose type says so, and a
   * second pass over the same conversations to find them would double the reading for nothing.
   */
  const messagePage = async (
    token: string,
    scopeId: string,
    options: ListOptions,
    want: 'messages' | 'calls',
  ): Promise<SourcePage> => {
    const limit = Math.min(options.limit ?? 100, 100);
    const cursor = (options.cursor ?? {}) as {
      queue?: string[];
      conv?: { startAfterId?: string; startAfter?: number } | null;
      convDone?: boolean;
      msg?: string | null;
    };
    let queue = [...(cursor.queue ?? [])];
    let conv = cursor.conv ?? null;
    let convDone = cursor.convDone ?? false;
    let msg = cursor.msg ?? null;

    // Out of conversations to read from: fetch the next page of them.
    while (queue.length === 0 && !convDone) {
      const endpoint = ENDPOINTS['conversations']!;
      const base = endpoint.path(scopeId);
      let path = `${base}&limit=${limit}`;
      if (conv?.startAfterId) {
        path += `&startAfterId=${encodeURIComponent(conv.startAfterId)}`;
        if (conv.startAfter) path += `&startAfter=${conv.startAfter}`;
      }
      const body = await call<{ conversations?: Record<string, unknown>[] }>(token, path);
      const list = body.conversations ?? [];
      queue = list.map((c) => asString(c['id']) ?? asString(c['_id']) ?? '').filter(Boolean);
      const last = list[list.length - 1];
      convDone = list.length < limit || !last;
      conv = last
        ? {
            startAfterId: asString(last['id']) ?? asString(last['_id']) ?? '',
            startAfter: Number(last['dateUpdated'] ?? last['dateAdded'] ?? 0) || undefined,
          }
        : null;
    }
    if (queue.length === 0) return { records: [], cursor: null, highWaterAt: null, done: true };

    const conversationId = queue[0]!;
    let path = `/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`;
    if (msg) path += `&lastMessageId=${encodeURIComponent(msg)}`;
    const answer = await call<Record<string, unknown>>(token, path);
    // HighLevel wraps this one: { messages: { messages: [...], lastMessageId, nextPage } }.
    const inner = (answer['messages'] ?? answer) as Record<string, unknown>;
    const list = Array.isArray(inner['messages'])
      ? (inner['messages'] as Record<string, unknown>[])
      : Array.isArray(answer['messages'])
        ? (answer['messages'] as Record<string, unknown>[])
        : [];
    const more = inner['nextPage'] === true && list.length > 0;
    const lastId = asString(inner['lastMessageId']) ?? asString(list[list.length - 1]?.['id']);

    const records: SourceRecord[] = [];
    let highWaterAt: Date | null = null;
    for (const raw of list) {
      const id = asString(raw['id']) ?? asString(raw['_id']);
      if (!id) continue;
      const isCall = CALL_TYPES.has((asString(raw['messageType']) ?? '').toUpperCase());
      if (want === 'calls' ? !isCall : isCall) continue;
      const at = asDate(raw['dateAdded'] ?? raw['dateUpdated']);
      if (options.until && at && at > options.until) continue;
      if (options.changedSince && at && at <= options.changedSince) continue;
      if (at && (!highWaterAt || at > highWaterAt)) highWaterAt = at;
      records.push({
        objectType: want === 'calls' ? 'call' : 'message',
        objectId: id,
        parentObjectId: conversationId,
        sourceCreatedAt: at,
        sourceUpdatedAt: asDate(raw['dateUpdated']) ?? at,
        payload: { ...raw, conversationId },
      });
    }

    // Where to carry on: further into this conversation, or on to the next one.
    if (more && lastId) msg = lastId;
    else {
      queue = queue.slice(1);
      msg = null;
    }
    const done = queue.length === 0 && convDone && !msg;
    return {
      records,
      cursor: done ? null : { queue, conv, convDone, msg },
      highWaterAt,
      done,
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
      // Tasks and notes live on the customer over there, so they are read customer by customer.
      if (category === 'tasks')
        return taskPage(tokenOf(connection, scope), scope.externalScopeId, options);
      // Appointments are read one calendar and one window of time at a time; there is no other way to ask.
      if (category === 'appointments')
        return appointmentPage(tokenOf(connection, scope), scope.externalScopeId, options);
      // Messages and calls have no list of their own over there: both are read through the conversations.
      if (category === 'messages' || category === 'calls')
        return messagePage(
          tokenOf(connection, scope),
          scope.externalScopeId,
          options,
          category === 'calls' ? 'calls' : 'messages',
        );
      // A form's questions are only visible in its answers, so each one is read with a sample of them.
      if (category === 'forms')
        return formPage(tokenOf(connection, scope), scope.externalScopeId, options);
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

    /**
     * HighLevel keeps two kinds of file behind two kinds of door. A photo somebody texted sits on a public
     * CDN and comes down for anyone with the link; a call recording is an API call in disguise, and without
     * the sub-account's bearer token it answers 401. Only the adapter can know which is which, so the copier
     * asks here and sends whatever comes back.
     */
    mediaAuth(connection, scope, locator): Readonly<Record<string, string>> {
      if (!locator.startsWith(`${API_BASE}/`)) return {};
      return {
        authorization: `Bearer ${tokenOf(connection, scope)}`,
        version: API_VERSION,
      };
    },

    normalize(record, context) {
      switch (record.objectType) {
        case 'form':
        case 'survey':
          return [formEnvelope(record, context)];
        case 'form_submission':
          return [formResponseEnvelope(record, context)];
        case 'product':
          return [productEnvelope(record, context)];
        case 'invoice':
          return [invoiceEnvelope(record, context)];
        case 'estimate':
          return [estimateEnvelope(record, context)];
        case 'subscription':
          return [subscriptionEnvelope(record, context)];
        case 'task':
          return [taskEnvelope(record, context)];
        case 'note':
          return [noteEnvelope(record, context)];
        case 'calendar':
          return [calendarEnvelope(record, context)];
        case 'appointment':
          return [appointmentEnvelope(record, context)];
        case 'pipeline':
          return [pipelineEnvelope(record, context)];
        case 'opportunity':
          return [leadEnvelope(record, context)];
        case 'conversation':
          return [conversationEnvelope(record, context)];
        case 'message':
          return [messageEnvelope(record, context)];
        case 'call':
          return [callEnvelope(record, context)];
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

/** Money over there is a number of dollars; here it is whole cents, and half a cent has never existed. */
const cents = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
};

function productEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  // A product's prices are a list of their own over there; the first one stands for it here, and the rest are
  // kept beside it rather than being invented into products nobody made.
  const prices = Array.isArray(p['prices']) ? (p['prices'] as Record<string, unknown>[]) : [];
  const first = prices[0];
  const warnings =
    prices.length > 1
      ? [
          {
            code: 'mapping.one_price_kept',
            field: 'prices',
            message: `"${asString(p['name']) ?? 'This product'}" had ${prices.length} prices over there and one here; the first is used and the others are kept beside it.`,
          },
        ]
      : [];
  return envelopeOf(
    record,
    context,
    'product',
    'products',
    {
      name: (asString(p['name']) ?? 'Product').slice(0, 200),
      description: asString(p['description'])?.slice(0, 2000) ?? null,
      unitPriceCents: first ? cents(first['amount']) : 0,
      unitLabel: 'each',
      taxable: true,
      active: p['availableInStore'] !== false,
    },
    leftovers(p, ['id', '_id', 'name', 'description', 'prices', 'availableInStore', 'locationId']),
    warnings,
  );
}

const INVOICE_STATUS: Readonly<Record<string, 'draft' | 'sent' | 'partly_paid' | 'paid' | 'void'>> =
  {
    draft: 'draft',
    sent: 'sent',
    payment_processing: 'sent',
    partially_paid: 'partly_paid',
    partially: 'partly_paid',
    paid: 'paid',
    void: 'void',
    voided: 'void',
    cancelled: 'void',
  };

function invoiceEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const rawStatus = (asString(p['status']) ?? '').toLowerCase();
  const status = INVOICE_STATUS[rawStatus] ?? 'sent';
  const items = Array.isArray(p['invoiceItems'])
    ? (p['invoiceItems'] as Record<string, unknown>[])
    : [];
  const contactId =
    asString((p['contactDetails'] as Record<string, unknown> | undefined)?.['id']) ??
    asString(p['contactId']);
  const total = cents(p['total']);
  const paid = cents(p['amountPaid'] ?? p['amountPaidSummary']);
  return envelopeOf(
    record,
    context,
    'invoice',
    'invoices',
    {
      number: asString(p['invoiceNumber'])?.slice(0, 40) ?? null,
      title: asString(p['title'] ?? p['name'])?.slice(0, 200) ?? null,
      notes: asString(p['termsNotes'])?.slice(0, 5000) ?? null,
      status,
      currency: (asString(p['currency']) ?? 'USD').toUpperCase().slice(0, 3),
      subtotalCents: cents(p['subtotal'] ?? p['total']),
      discountCents: cents((p['discount'] as Record<string, unknown> | undefined)?.['value']),
      taxCents: cents(p['taxSum'] ?? p['totalTax']),
      totalCents: total,
      paidCents: Math.min(paid, total),
      paidAt:
        asDate(p['paidAt'] ?? p['updatedAt'])?.toISOString() ??
        record.sourceUpdatedAt?.toISOString() ??
        null,
      issuedAt:
        asDate(p['issueDate'] ?? p['sentAt'])?.toISOString() ??
        record.sourceCreatedAt?.toISOString() ??
        null,
      dueOn: asDate(p['dueDate'])?.toISOString().slice(0, 10) ?? null,
      terms: asString(p['termsNotes'])?.slice(0, 2000) ?? null,
      lines: items.slice(0, 200).map((it) => ({
        name: (asString(it['name']) ?? 'Item').slice(0, 200),
        description: asString(it['description'])?.slice(0, 2000) ?? null,
        quantity: Math.max(0.001, Number(it['qty'] ?? it['quantity'] ?? 1) || 1),
        unitLabel: 'each',
        unitPriceCents: cents(it['amount'] ?? it['price']),
        taxable: Array.isArray(it['taxes']) ? (it['taxes'] as unknown[]).length > 0 : true,
      })),
    },
    leftovers(p, [
      'id',
      '_id',
      'invoiceNumber',
      'title',
      'name',
      'status',
      'currency',
      'subtotal',
      'discount',
      'taxSum',
      'totalTax',
      'total',
      'amountPaid',
      'amountPaidSummary',
      'paidAt',
      'issueDate',
      'sentAt',
      'dueDate',
      'termsNotes',
      'invoiceItems',
      'contactDetails',
      'contactId',
      'altId',
      'locationId',
      'updatedAt',
    ]),
    [],
    contactId
      ? [
          {
            category: 'contacts',
            objectType: 'contact',
            objectId: contactId,
            role: 'contact',
            required: true,
          },
        ]
      : [],
  );
}

const ESTIMATE_STATUS: Readonly<
  Record<string, 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'void'>
> = {
  draft: 'draft',
  sent: 'sent',
  accepted: 'accepted',
  declined: 'declined',
  rejected: 'declined',
  expired: 'expired',
  invalid: 'void',
  void: 'void',
};

function estimateEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const rawStatus = (asString(p['status']) ?? '').toLowerCase();
  const status = ESTIMATE_STATUS[rawStatus] ?? 'sent';
  const items = Array.isArray(p['estimateItems'] ?? p['invoiceItems'])
    ? ((p['estimateItems'] ?? p['invoiceItems']) as Record<string, unknown>[])
    : [];
  const contactId =
    asString((p['contactDetails'] as Record<string, unknown> | undefined)?.['id']) ??
    asString(p['contactId']);
  return envelopeOf(
    record,
    context,
    'estimate',
    'estimates',
    {
      number: asString(p['estimateNumber'] ?? p['number'])?.slice(0, 40) ?? null,
      title: asString(p['title'] ?? p['name'])?.slice(0, 200) ?? null,
      notes: asString(p['termsNotes'])?.slice(0, 5000) ?? null,
      status,
      currency: (asString(p['currency']) ?? 'USD').toUpperCase().slice(0, 3),
      subtotalCents: cents(p['subtotal'] ?? p['total']),
      discountCents: cents((p['discount'] as Record<string, unknown> | undefined)?.['value']),
      taxCents: cents(p['taxSum'] ?? p['totalTax']),
      totalCents: cents(p['total']),
      issuedAt:
        asDate(p['issueDate'] ?? p['sentAt'])?.toISOString() ??
        record.sourceCreatedAt?.toISOString() ??
        null,
      expiresOn:
        asDate(p['expiryDate'] ?? p['expiresOn'])
          ?.toISOString()
          .slice(0, 10) ?? null,
      answeredAt:
        status === 'accepted' || status === 'declined'
          ? (asDate(p['updatedAt'])?.toISOString() ??
            record.sourceUpdatedAt?.toISOString() ??
            new Date().toISOString())
          : null,
      acceptedName: asString(p['acceptedBy'] ?? p['signedBy'])?.slice(0, 120) ?? null,
      declinedReason: asString(p['declineReason'])?.slice(0, 1000) ?? null,
      lines: items.slice(0, 200).map((it) => ({
        name: (asString(it['name']) ?? 'Item').slice(0, 200),
        description: asString(it['description'])?.slice(0, 2000) ?? null,
        quantity: Math.max(0.001, Number(it['qty'] ?? it['quantity'] ?? 1) || 1),
        unitLabel: 'each',
        unitPriceCents: cents(it['amount'] ?? it['price']),
        taxable: Array.isArray(it['taxes']) ? (it['taxes'] as unknown[]).length > 0 : true,
      })),
    },
    leftovers(p, [
      'id',
      '_id',
      'estimateNumber',
      'number',
      'title',
      'name',
      'status',
      'currency',
      'subtotal',
      'discount',
      'taxSum',
      'totalTax',
      'total',
      'issueDate',
      'sentAt',
      'expiryDate',
      'expiresOn',
      'acceptedBy',
      'signedBy',
      'declineReason',
      'termsNotes',
      'estimateItems',
      'invoiceItems',
      'contactDetails',
      'contactId',
      'altId',
      'locationId',
      'updatedAt',
    ]),
    [],
    contactId
      ? [
          {
            category: 'contacts',
            objectType: 'contact',
            objectId: contactId,
            role: 'contact',
            required: true,
          },
        ]
      : [],
  );
}

const PLAN_INTERVAL: Readonly<Record<string, 'day' | 'week' | 'month' | 'year'>> = {
  daily: 'day',
  day: 'day',
  weekly: 'week',
  week: 'week',
  monthly: 'month',
  month: 'month',
  yearly: 'year',
  annually: 'year',
  year: 'year',
};

function subscriptionEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const rawStatus = (asString(p['status']) ?? '').toLowerCase();
  const status =
    rawStatus === 'cancelled' || rawStatus === 'canceled'
      ? 'cancelled'
      : rawStatus === 'paused'
        ? 'paused'
        : rawStatus === 'past_due' || rawStatus === 'unpaid'
          ? 'past_due'
          : 'active';
  const contactId =
    asString((p['contactDetails'] as Record<string, unknown> | undefined)?.['id']) ??
    asString(p['contactId']);
  const day = (v: unknown) => asDate(v)?.toISOString().slice(0, 10) ?? null;
  return envelopeOf(
    record,
    context,
    'subscription',
    'subscriptions',
    {
      planName: (asString(p['name'] ?? p['productName']) ?? 'Plan').slice(0, 160),
      priceCents: cents(p['amount'] ?? p['price']),
      interval: PLAN_INTERVAL[(asString(p['interval']) ?? 'month').toLowerCase()] ?? 'month',
      intervalCount: Math.max(1, Math.min(36, Number(p['intervalCount'] ?? 1) || 1)),
      status,
      startedOn: day(p['startDate'] ?? p['createdAt']),
      currentPeriodStart: day(p['currentPeriodStart']),
      currentPeriodEnd: day(p['currentPeriodEnd']),
      nextBillingOn: day(p['nextChargeDate'] ?? p['nextBillingDate']),
      cancelledAt:
        status === 'cancelled' ? (asDate(p['cancelledAt'])?.toISOString() ?? null) : null,
      externalId: asString(p['subscriptionId'] ?? p['_id'] ?? p['id']),
    },
    leftovers(p, [
      'id',
      '_id',
      'subscriptionId',
      'name',
      'productName',
      'amount',
      'price',
      'interval',
      'intervalCount',
      'status',
      'startDate',
      'createdAt',
      'currentPeriodStart',
      'currentPeriodEnd',
      'nextChargeDate',
      'nextBillingDate',
      'cancelledAt',
      'contactDetails',
      'contactId',
      'altId',
      'locationId',
    ]),
    [],
    contactId
      ? [
          {
            category: 'contacts',
            objectType: 'contact',
            objectId: contactId,
            role: 'contact',
            required: true,
          },
        ]
      : [],
  );
}

/** Who and what a task or a note hangs off: always a customer over there. */
const onCustomer = (record: SourceRecord): CanonicalEnvelope['relationships'] => [
  {
    category: 'contacts',
    objectType: 'contact',
    objectId: record.parentObjectId ?? '',
    role: 'contact',
    required: true,
  },
];

function taskEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const done =
    p['completed'] === true || (asString(p['status']) ?? '').toLowerCase() === 'completed';
  const owner = asString(p['assignedTo']);
  const relationships = [...onCustomer(record)];
  if (owner)
    relationships.push({
      category: 'users',
      objectType: 'user',
      objectId: owner,
      role: 'owner',
      required: false,
    });
  return envelopeOf(
    record,
    context,
    'task',
    'tasks',
    {
      title: (asString(p['title']) ?? 'Task').slice(0, 200),
      notes: asString(p['body'])?.slice(0, 10_000) ?? null,
      dueAt: asDate(p['dueDate'])?.toISOString() ?? null,
      // When it was finished is not something the old system records, so the last change stands in for it and
      // the fact that it is finished is what matters.
      doneAt: done ? (record.sourceUpdatedAt ?? new Date()).toISOString() : null,
    },
    leftovers(p, [
      'id',
      '_id',
      'title',
      'body',
      'dueDate',
      'completed',
      'status',
      'assignedTo',
      'contactId',
      'dateAdded',
      'dateUpdated',
      'locationId',
    ]),
    [],
    relationships,
  );
}

function noteEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const author = asString(p['userId']);
  const relationships = [...onCustomer(record)];
  if (author)
    relationships.push({
      category: 'users',
      objectType: 'user',
      objectId: author,
      role: 'owner',
      required: false,
    });
  return envelopeOf(
    record,
    context,
    'note',
    'tasks',
    {
      body: (asString(p['body']) ?? '').slice(0, 10_000) || '(empty note)',
      occurredAt: (record.sourceCreatedAt ?? new Date()).toISOString(),
    },
    leftovers(p, [
      'id',
      '_id',
      'body',
      'userId',
      'contactId',
      'dateAdded',
      'dateUpdated',
      'locationId',
    ]),
    [],
    relationships,
  );
}

// ---------- forms and the answers people gave them ----------

/**
 * The keys on a submission that are the submission, not an answer.
 *
 * Everything else on the object is something somebody typed, which is the only way to find out what a
 * HighLevel form asked: its API hands over the answers and never the questions.
 */
const SUBMISSION_KEYS = new Set([
  'id',
  '_id',
  'formId',
  'surveyId',
  'contactId',
  'locationId',
  'createdAt',
  'updatedAt',
  'dateAdded',
  'dateUpdated',
  'eventData',
  'pageDetails',
  'others',
  'deleted',
]);

/** Every answer on one submission, flattened: the top-level ones and the ones parked under `others`. */
export function submissionAnswers(p: Record<string, unknown>): { key: string; value: unknown }[] {
  const out: { key: string; value: unknown }[] = [];
  const take = (key: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return;
    if (typeof value === 'object' && !Array.isArray(value)) return;
    if (out.some((a) => a.key === key)) return;
    out.push({ key: key.slice(0, 200), value });
  };
  for (const [key, value] of Object.entries(p)) if (!SUBMISSION_KEYS.has(key)) take(key, value);
  const others = p['others'];
  if (others && typeof others === 'object' && !Array.isArray(others))
    for (const [key, value] of Object.entries(others as Record<string, unknown>)) take(key, value);
  return out;
}

/** A field name over there turned into a question somebody would recognise: `first_name` → "First name". */
function questionTitle(key: string): string {
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  const title = words.charAt(0).toUpperCase() + words.slice(1);
  return (title || key).slice(0, 300);
}

/** What kind of question it was, from its name and from what people actually put in it. */
function questionType(key: string, values: readonly unknown[]): CanonicalFormQuestion['type'] {
  const name = key.toLowerCase();
  if (/e-?mail/.test(name)) return 'email';
  if (/phone|mobile|cell/.test(name)) return 'phone';
  if (/address|street|city|postcode|zip/.test(name)) return 'address';
  if (/\bdate\b|birthday|dob/.test(name)) return 'date';
  if (values.length > 0 && values.every((v) => typeof v === 'boolean')) return 'yes_no';
  if (values.length > 0 && values.every((v) => Array.isArray(v))) return 'checkboxes';
  if (values.length > 0 && values.every((v) => typeof v === 'number')) return 'number';
  const texts = values.filter((v): v is string => typeof v === 'string');
  if (texts.length > 0 && texts.some((v) => v.length > 120)) return 'long_text';
  return 'short_text';
}

/**
 * The questions a form asked, worked out from a sample of the answers people gave it.
 *
 * HighLevel has no endpoint that hands over a form's fields, so this is the honest best: the questions
 * somebody has actually answered at least once. A question nobody ever filled in cannot be seen from here,
 * and the form is imported as a draft for that reason.
 */
export function questionsFromSubmissions(
  submissions: readonly Record<string, unknown>[],
): CanonicalFormQuestion[] {
  const seen = new Map<string, unknown[]>();
  for (const submission of submissions)
    for (const { key, value } of submissionAnswers(submission)) {
      const values = seen.get(key);
      if (values) values.push(value);
      else seen.set(key, [value]);
    }
  return [...seen.entries()].slice(0, 200).map(([key, values]) => ({
    key,
    title: questionTitle(key),
    type: questionType(key, values),
    // Everybody who answered answered this one: the closest thing to "required" the answers can show.
    required: values.length > 0 && values.length === submissions.length,
    choices: [],
  }));
}

function formEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const sampled = Array.isArray(p['__sampleSubmissions'])
    ? (p['__sampleSubmissions'] as Record<string, unknown>[])
    : [];
  const questions = questionsFromSubmissions(sampled);
  const isSurvey = record.objectType === 'survey' || p['type'] === 'survey';
  return envelopeOf(
    record,
    context,
    'form',
    'forms',
    {
      name: (asString(p['name']) ?? 'Form').slice(0, 120),
      mode: isSurvey ? 'survey' : 'form',
      intro: asString(p['description'])?.slice(0, 4000) ?? null,
      questions,
      // Never true for this source: HighLevel does not publish a form's fields, so these were read back out
      // of the answers and the business has to look at them.
      questionsAreComplete: false,
    },
    leftovers(p, ['id', '_id', 'name', 'description', 'locationId', 'type', '__sampleSubmissions']),
    [],
  );
}

const SUBMISSION_SOURCE: Readonly<
  Record<string, 'link' | 'embed' | 'chat' | 'qr' | 'app' | 'api'>
> = {
  form: 'link',
  survey: 'link',
  widget: 'embed',
  embed: 'embed',
  chat: 'chat',
  api: 'api',
};

function formResponseEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const submittedAt = (record.sourceCreatedAt ?? new Date()).toISOString();
  const contactId = asString(p['contactId']);
  return envelopeOf(
    record,
    context,
    'form_response',
    'form_submissions',
    {
      submittedAt,
      source: SUBMISSION_SOURCE[(asString(p['pageDetails']) ?? '').toLowerCase()] ?? 'link',
      answers: submissionAnswers(p).map((a) => ({
        key: a.key,
        value:
          typeof a.value === 'string'
            ? a.value.slice(0, 5000)
            : typeof a.value === 'number' || typeof a.value === 'boolean'
              ? a.value
              : Array.isArray(a.value)
                ? a.value.map((v) => String(v).slice(0, 500)).slice(0, 60)
                : String(a.value).slice(0, 5000),
      })),
    },
    leftovers(p, [...SUBMISSION_KEYS]),
    [],
    [
      {
        category: 'forms',
        objectType: 'form',
        objectId: asString(p['formId']) ?? asString(p['surveyId']) ?? record.parentObjectId ?? '',
        role: 'form',
        required: true,
      },
      ...(contactId
        ? [
            {
              category: 'contacts',
              objectType: 'contact',
              objectId: contactId,
              role: 'person' as const,
              required: false,
            },
          ]
        : []),
    ],
  );
}

function calendarEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  // A visit's length is a number and a unit over there; minutes here.
  const slot = Number(p['slotDuration'] ?? 0) || 0;
  const unit = (asString(p['slotDurationUnit']) ?? 'mins').toLowerCase();
  const minutes = Math.max(1, Math.min(1440, unit.startsWith('hour') ? slot * 60 : slot || 60));
  return envelopeOf(
    record,
    context,
    'calendar',
    'calendars',
    {
      name: (asString(p['name']) ?? 'Calendar').slice(0, 120),
      description: asString(p['description'])?.slice(0, 2000) ?? null,
      timezone: asString(p['timezone']) ?? context.timezone,
      minutes,
      active: p['isActive'] !== false,
    },
    leftovers(p, [
      'id',
      '_id',
      'name',
      'description',
      'timezone',
      'slotDuration',
      'slotDurationUnit',
      'isActive',
      'locationId',
    ]),
    // What could not come across is one finding per calendar, raised by the importer rather than here: it is
    // a fact about HandsFreeOS, not about this payload.
    [],
  );
}

const APPOINTMENT_STATUS: Readonly<
  Record<string, 'scheduled' | 'completed' | 'cancelled' | 'no_show'>
> = {
  confirmed: 'scheduled',
  booked: 'scheduled',
  new: 'scheduled',
  showed: 'completed',
  completed: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  invalid: 'cancelled',
  noshow: 'no_show',
  no_show: 'no_show',
  noshowed: 'no_show',
};

function appointmentEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const rawStatus = (asString(p['appointmentStatus']) ?? asString(p['status']) ?? '')
    .toLowerCase()
    .replace(/[\s-]/g, '');
  const startsAt = asDate(p['startTime']) ?? record.sourceCreatedAt ?? new Date();
  const ends = asDate(p['endTime']);
  // A visit with no end, or one that ends before it starts, gets an hour: a row the database would refuse
  // helps nobody, and the real length is in the payload we keep beside it.
  const endsAt =
    ends && ends.getTime() > startsAt.getTime()
      ? ends
      : new Date(startsAt.getTime() + 60 * 60 * 1000);
  const warnings = ends
    ? []
    : [
        {
          code: 'mapping.appointment_length_assumed',
          field: 'endTime',
          message:
            'The old system did not say how long this visit was, so it comes across as an hour and the original is kept.',
        },
      ];
  const contactId = asString(p['contactId']);
  const owner = asString(p['assignedUserId']) ?? asString(p['userId']);
  const relationships: CanonicalEnvelope['relationships'] = [
    {
      category: 'calendars',
      objectType: 'calendar',
      objectId: record.parentObjectId ?? asString(p['calendarId']) ?? '',
      role: 'calendar',
      required: true,
    },
  ];
  if (contactId)
    relationships.push({
      category: 'contacts',
      objectType: 'contact',
      objectId: contactId,
      role: 'contact',
      required: false,
    });
  if (owner)
    relationships.push({
      category: 'users',
      objectType: 'user',
      objectId: owner,
      role: 'owner',
      required: false,
    });
  return envelopeOf(
    record,
    context,
    'appointment',
    'appointments',
    {
      title: (asString(p['title']) ?? 'Visit').slice(0, 200),
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      status: APPOINTMENT_STATUS[rawStatus] ?? 'scheduled',
      notes: asString(p['notes'])?.slice(0, 5000) ?? null,
      where: asString(p['address'])?.slice(0, 500) ?? null,
    },
    leftovers(p, [
      'id',
      '_id',
      'title',
      'startTime',
      'endTime',
      'appointmentStatus',
      'status',
      'notes',
      'address',
      'contactId',
      'calendarId',
      'assignedUserId',
      'userId',
      'locationId',
      'dateAdded',
      'dateUpdated',
    ]),
    warnings,
    relationships,
  );
}

/**
 * What a stage means, read from what it is called. GoHighLevel's stages carry no meaning of their own — a
 * deal's own status says whether it was won — while HandsFreeOS says it with the stage, so that a board
 * column means something. Guessing from the name is the honest version of that gap, and the importer says so
 * and adds the missing stages rather than leaving a pipeline nobody can ever win in.
 */
const STAGE_KIND = (name: string): 'open' | 'won' | 'lost' => {
  const n = name.toLowerCase();
  if (/\b(won|sold|signed|closed[\s-]*won|booked)\b/.test(n)) return 'won';
  if (/\b(lost|dead|closed[\s-]*lost|cancell?ed|abandoned|unqualified|no[\s-]*sale)\b/.test(n))
    return 'lost';
  return 'open';
};

function pipelineEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const rawStages = Array.isArray(p['stages']) ? (p['stages'] as Record<string, unknown>[]) : [];
  const stages = rawStages
    .map((st, i) => {
      const name = asString(st['name']) ?? `Stage ${i + 1}`;
      return {
        name: name.slice(0, 60),
        kind: STAGE_KIND(name),
        position: Number(st['position'] ?? i) || i,
        sourceId: asString(st['id']) ?? asString(st['_id']),
      };
    })
    .slice(0, 100);
  return envelopeOf(
    record,
    context,
    'pipeline',
    'pipelines',
    {
      name: (asString(p['name']) ?? 'Pipeline').slice(0, 80),
      position: Number(p['position'] ?? 0) || 0,
      stages,
    },
    leftovers(p, [
      'id',
      '_id',
      'name',
      'stages',
      'position',
      'locationId',
      'dateAdded',
      'dateUpdated',
    ]),
    [],
  );
}

const LEAD_STATUS: Readonly<Record<string, 'open' | 'won' | 'lost' | 'abandoned'>> = {
  open: 'open',
  won: 'won',
  lost: 'lost',
  abandoned: 'abandoned',
  abandon: 'abandoned',
};

function leadEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const rawStatus = (asString(p['status']) ?? '').toLowerCase();
  const status = LEAD_STATUS[rawStatus] ?? 'open';
  const warnings =
    rawStatus && !LEAD_STATUS[rawStatus]
      ? [
          {
            code: 'mapping.unknown_lead_status',
            field: 'status',
            message: `"${rawStatus}" is not a state HandsFreeOS keeps for a lead, so it comes across as still open and the original is kept.`,
          },
        ]
      : [];
  // Money over there is a number of currency units; here it is whole cents, and rounding is the only safe
  // way to cross that gap.
  const value = Number(p['monetaryValue'] ?? 0);
  const contactId =
    asString(p['contactId']) ??
    asString((p['contact'] as Record<string, unknown> | undefined)?.['id']);
  const owner = asString(p['assignedTo']);
  const relationships: CanonicalEnvelope['relationships'] = [];
  if (contactId)
    relationships.push({
      category: 'contacts',
      objectType: 'contact',
      objectId: contactId,
      role: 'contact',
      required: true,
    });
  if (asString(p['pipelineId']))
    relationships.push({
      category: 'pipelines',
      objectType: 'pipeline',
      objectId: asString(p['pipelineId'])!,
      role: 'pipeline',
      required: true,
    });
  if (owner)
    relationships.push({
      category: 'users',
      objectType: 'user',
      objectId: owner,
      role: 'owner',
      required: false,
    });
  return envelopeOf(
    record,
    context,
    'lead',
    'opportunities',
    {
      title: (asString(p['name']) ?? 'Lead').slice(0, 160),
      valueCents: Number.isFinite(value) ? Math.max(0, Math.round(value * 100)) : 0,
      status,
      source: asString(p['source']),
      sourceStageId: asString(p['pipelineStageId']),
      expectedCloseOn: asDate(p['expectedCloseDate'])?.toISOString().slice(0, 10) ?? null,
      stageEnteredAt:
        asDate(p['lastStageChangeAt'])?.toISOString() ??
        record.sourceCreatedAt?.toISOString() ??
        null,
      closedAt:
        asDate(p['lastStatusChangeAt'])?.toISOString() ??
        record.sourceUpdatedAt?.toISOString() ??
        null,
      lostReason: asString(p['lostReasonName']) ?? asString(p['lostReason']),
    },
    leftovers(p, [
      'id',
      '_id',
      'name',
      'monetaryValue',
      'status',
      'source',
      'pipelineId',
      'pipelineStageId',
      'contactId',
      'contact',
      'assignedTo',
      'expectedCloseDate',
      'lastStageChangeAt',
      'lastStatusChangeAt',
      'lostReasonName',
      'lostReason',
      'locationId',
      'dateAdded',
      'dateUpdated',
    ]),
    warnings,
    relationships,
  );
}

/**
 * GoHighLevel's channels, narrowed to the three HandsFreeOS has. What it was really — WhatsApp, Instagram,
 * Facebook, Google Business — is kept beside it rather than lost, because "chat" alone would make a business
 * wonder where their Instagram history went.
 */
const CHANNELS: Readonly<Record<string, { channel: 'sms' | 'email' | 'chat'; name?: string }>> = {
  TYPE_SMS: { channel: 'sms' },
  SMS: { channel: 'sms' },
  TYPE_EMAIL: { channel: 'email' },
  EMAIL: { channel: 'email' },
  TYPE_WEBCHAT: { channel: 'chat' },
  TYPE_LIVE_CHAT: { channel: 'chat' },
  TYPE_CHAT: { channel: 'chat' },
  TYPE_WHATSAPP: { channel: 'chat', name: 'whatsapp' },
  TYPE_INSTAGRAM: { channel: 'chat', name: 'instagram' },
  TYPE_FACEBOOK: { channel: 'chat', name: 'facebook' },
  TYPE_GMB: { channel: 'chat', name: 'google business' },
  TYPE_REVIEW: { channel: 'chat', name: 'review' },
  TYPE_CUSTOM_PROVIDER_SMS: { channel: 'sms' },
  TYPE_CUSTOM_PROVIDER_EMAIL: { channel: 'email' },
};

const channelOf = (
  raw: string | null,
): { channel: 'sms' | 'email' | 'chat'; name: string | null } => {
  const found = CHANNELS[(raw ?? '').toUpperCase()];
  return { channel: found?.channel ?? 'chat', name: found?.name ?? null };
};

function conversationEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const type = asString(p['type']) ?? asString(p['lastMessageType']);
  const { channel, name } = channelOf(type);
  const warnings = name
    ? [
        {
          code: 'mapping.channel_narrowed',
          field: 'type',
          message: `A ${name} thread comes across as a chat, which is the nearest thing HandsFreeOS has; the messages and their order are unchanged.`,
        },
      ]
    : [];
  // Who the thread is with. Email threads carry the address, texts the number, chats a name or an id.
  const counterpart =
    asString(p['email']) ??
    asString(p['phone']) ??
    asString(p['contactName']) ??
    asString(p['fullName']) ??
    asString(p['contactId']) ??
    'unknown';
  const contactId = asString(p['contactId']);
  return envelopeOf(
    record,
    context,
    'conversation',
    'conversations',
    {
      channel,
      channelName: name,
      counterpart,
      subject: asString(p['lastMessageBody'])?.slice(0, 400) ?? null,
      // A thread nobody is waiting on arrives closed: history should not look like a queue of work.
      status: p['unreadCount'] && Number(p['unreadCount']) > 0 ? 'open' : 'closed',
      startedAt: record.sourceCreatedAt?.toISOString() ?? null,
      lastMessageAt:
        asDate(p['lastMessageDate'])?.toISOString() ??
        record.sourceUpdatedAt?.toISOString() ??
        null,
    },
    leftovers(p, [
      'id',
      '_id',
      'type',
      'lastMessageType',
      'email',
      'phone',
      'contactName',
      'fullName',
      'contactId',
      'lastMessageBody',
      'lastMessageDate',
      'unreadCount',
      'locationId',
    ]),
    warnings,
    contactId
      ? [
          {
            category: 'contacts',
            objectType: 'contact',
            objectId: contactId,
            role: 'contact',
            required: true,
          },
        ]
      : [],
  );
}

/** Inbound or outbound, as GoHighLevel says it. */
const directionOf = (p: Record<string, unknown>): 'inbound' | 'outbound' =>
  (asString(p['direction']) ?? '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';

const MESSAGE_STATUS: Readonly<
  Record<string, 'sent' | 'delivered' | 'undelivered' | 'failed' | 'received' | 'bounced'>
> = {
  delivered: 'delivered',
  sent: 'sent',
  read: 'delivered',
  opened: 'delivered',
  clicked: 'delivered',
  undelivered: 'undelivered',
  failed: 'failed',
  error: 'failed',
  rejected: 'failed',
  bounced: 'bounced',
  complained: 'bounced',
  received: 'received',
  pending: 'sent',
  scheduled: 'sent',
};

function messageEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const { channel, name } = channelOf(asString(p['messageType']) ?? asString(p['type']));
  const direction = directionOf(p);
  const rawStatus = (asString(p['status']) ?? '').toLowerCase();
  const status = MESSAGE_STATUS[rawStatus] ?? (direction === 'inbound' ? 'received' : 'delivered');
  const warnings =
    rawStatus && !MESSAGE_STATUS[rawStatus]
      ? [
          {
            code: 'mapping.unknown_message_status',
            field: 'status',
            message: `"${rawStatus}" is not a state HandsFreeOS keeps, so it is recorded as ${status} and the original is kept.`,
          },
        ]
      : [];
  const attachments = Array.isArray(p['attachments']) ? (p['attachments'] as unknown[]) : [];
  return envelopeOf(
    record,
    context,
    'message',
    'messages',
    {
      channel,
      direction,
      status,
      subject: asString(p['subject']),
      body: asString(p['body']) ?? asString(p['message']),
      bodyHtml: asString(p['html']),
      fromAddress: asString(p['from']),
      toAddresses: [asString(p['to'])].filter((v): v is string => !!v),
      // A message with no time of its own would land today, which is the one thing history must never do.
      occurredAt: (record.sourceCreatedAt ?? new Date()).toISOString(),
      media: attachments
        .map((a) =>
          typeof a === 'string'
            ? { url: a, name: null, mime: null, sizeBytes: null }
            : {
                url: asString((a as Record<string, unknown>)['url']) ?? '',
                name: asString((a as Record<string, unknown>)['name']),
                mime: asString((a as Record<string, unknown>)['type']),
                sizeBytes: null,
              },
        )
        .filter((m) => m.url),
      providerMessageId: record.objectId,
    },
    { ...leftovers(p, MESSAGE_KEYS), ...(name ? { realChannel: name } : {}) },
    warnings,
    [
      {
        category: 'conversations',
        objectType: 'conversation',
        objectId: record.parentObjectId ?? '',
        role: 'conversation',
        required: true,
      },
    ],
  );
}

const MESSAGE_KEYS = [
  'id',
  '_id',
  'messageType',
  'type',
  'direction',
  'status',
  'subject',
  'body',
  'message',
  'html',
  'from',
  'to',
  'attachments',
  'dateAdded',
  'dateUpdated',
  'conversationId',
  'locationId',
  'contactId',
];

const CALL_STATUS: Readonly<
  Record<string, 'completed' | 'no_answer' | 'busy' | 'failed' | 'canceled'>
> = {
  completed: 'completed',
  answered: 'completed',
  'no-answer': 'no_answer',
  no_answer: 'no_answer',
  noanswer: 'no_answer',
  voicemail: 'completed',
  busy: 'busy',
  failed: 'failed',
  canceled: 'canceled',
  cancelled: 'canceled',
};

function callEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const meta = (p['meta'] ?? {}) as Record<string, unknown>;
  const callData = (meta['call'] ?? {}) as Record<string, unknown>;
  const rawStatus = (asString(callData['status']) ?? asString(p['status']) ?? '').toLowerCase();
  const isVoicemail =
    (asString(p['messageType']) ?? '').toUpperCase().includes('VOICEMAIL') ||
    rawStatus === 'voicemail';
  const duration = Number(callData['duration'] ?? p['duration'] ?? 0) || null;
  const startedAt = (record.sourceCreatedAt ?? new Date()).toISOString();
  return envelopeOf(
    record,
    context,
    'call',
    'calls',
    {
      direction: directionOf(p),
      status: CALL_STATUS[rawStatus] ?? 'completed',
      fromNumber: asString(p['from']),
      toNumber: asString(p['to']),
      startedAt,
      endedAt: duration
        ? new Date(new Date(startedAt).getTime() + duration * 1000).toISOString()
        : null,
      durationSeconds: duration,
      isVoicemail,
      // A call's recording arrives as its first attachment, when the sub-account kept recordings at all.
      recordingUrl:
        asString(
          (Array.isArray(p['attachments']) ? (p['attachments'] as unknown[])[0] : null) as string,
        ) ?? asString(meta['recordingUrl']),
      recordingSeconds: duration,
      transcript: asString(meta['transcript']) ?? asString(p['transcript']),
      providerCallId: record.objectId,
    },
    leftovers(p, [...MESSAGE_KEYS, 'meta', 'duration', 'transcript']),
    [],
    [
      {
        category: 'conversations',
        objectType: 'conversation',
        objectId: record.parentObjectId ?? '',
        role: 'conversation',
        required: true,
      },
    ],
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
