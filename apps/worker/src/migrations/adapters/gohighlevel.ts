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
 *
 * **What the first real account taught (0091).** Paging is where the published API and the real one part
 * company, and a page read wrongly is not an error — it is the same records again, counted again. So every
 * list walk here keeps how many it has seen against the source's own total, and stops the batch outright
 * when a page ends where the last one did. The test beside this file (`migrations-gohighlevel-paging`)
 * holds a stand-in that pages the way GoHighLevel really does.
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

/** How many of those customers are asked about at once. */
const TASK_WALK_CONCURRENCY = 4;

/** Every item through `fn`, at most `size` at a time, in the order given. */
async function inPool<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(lanes);
  return out;
}

/**
 * How many of one page's records are asked about at once when the list leaves something off: an email's
 * words, a product's prices.
 */
const EMAIL_CONCURRENCY = 4;

/** How many times one request is asked again after a 429 before the batch is left to its own backoff. */
const RATE_LIMIT_TRIES = 6;

/** How many times a request that timed out or dropped is asked, in all, before the page fails. */
const NETWORK_TRIES = 3;

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
const CALL_TYPES = new Set([
  'TYPE_CALL',
  'CALL',
  'TYPE_VOICEMAIL',
  'VOICEMAIL',
  'TYPE_PHONE_CALL',
  // A call placed through a connected dialer (its recording rides as the first attachment), and one answered
  // by a phone menu. Both are calls; filed as messages, they were texts with no words in a chat thread.
  'TYPE_CUSTOM_CALL',
  'TYPE_IVR_CALL',
]);

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
  /**
   * How GoHighLevel pages this list. Four ways, and the first two are the ones that bit:
   *   - `startAfter`: contacts. A pair — the last record's id *and* its `dateAdded` as epoch milliseconds
   *     (`meta.startAfterId` / `meta.startAfter` in the answer). The id on its own is ignored and the first
   *     page comes back again, forever.
   *   - `startAfterDate`: the conversation search, which has no id cursor at all and pages by the last
   *     conversation's `lastMessageDate`.
   *   - `page` and `offset`: what they say.
   *   - `skip`: an offset under another name. The forms list refuses `offset` outright (`422 property offset
   *     should not exist`), which cost us every form on the first real account.
   */
  readonly paging: 'startAfter' | 'startAfterDate' | 'page' | 'offset' | 'skip' | 'none';
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
  /**
   * Which rows are records, when the list holds other things too. The email builder lists its folders among
   * the templates, so the scan said thirteen and twelve came across. With this, the scan reads the first
   * page whole and counts only what will really be brought.
   */
  readonly counts?: (row: Record<string, unknown>) => boolean;
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
    // Ignores `limit` and answers with every tag, so the whole list is the count — not "at least one".
    limit: false,
  },
  contacts: {
    path: (s) => `/contacts/?locationId=${encodeURIComponent(s)}`,
    listKey: 'contacts',
    idKey: 'id',
    paging: 'startAfter',
    countQuality: 'complete',
    incremental: true,
    objectType: 'contact',
    // The answer carries the sub-account's whole count under `meta`, so the scan says "856" rather than
    // "at least 1" from the one record it asked for.
    totalKey: 'meta.total',
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
    // `skip`, not `offset`, and the total at the top of the answer rather than under `meta`.
    paging: 'skip',
    countQuality: 'complete',
    incremental: false,
    objectType: 'form',
    totalKey: 'total',
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
    counts: (row) => row['templateType'] !== 'folder',
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
    paging: 'startAfterDate',
    countQuality: 'complete',
    incremental: false,
    objectType: 'conversation',
    totalKey: 'total',
  },
  form_submissions: {
    path: (s) => `/forms/submissions?locationId=${encodeURIComponent(s)}`,
    listKey: 'submissions',
    idKey: 'id',
    // By page: this one refuses `offset` the way the forms list does.
    paging: 'page',
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
    // `type` is required: without it the answer is `422 type should not be empty`.
    path: (s) => `/medias/files?altType=location&altId=${encodeURIComponent(s)}&type=file`,
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
 * What a connection made through the GoHighLevel app does about access it was never given. The app is retired
 * (the owner's call, 2026-10-06) and the screens no longer offer its sign-in, so the way back is a private
 * integration token that can read the thing, connected as its own connection.
 */
const SIGN_IN_MISSING_ACCESS =
  'In GoHighLevel, make a private integration token that can read this, connect it from the Migrations page, then start the move again from there.';

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
    /** How long HighLevel asked us to wait, on a 429 that said. */
    readonly retryAfterMs?: number,
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
 * The total an answer carries, as a number, or undefined. The products list and the email builder give it
 * as `[{ "total": 26 }]` — an aggregation result passed straight through — and read as-is that is not a
 * number, so the scan said "at least 1" for twenty-six products.
 */
const totalOf = (body: Record<string, unknown>, key: string): number | undefined => {
  let v = dig(body, key);
  if (Array.isArray(v)) v = (v[0] as Record<string, unknown> | undefined)?.['total'];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

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
  /**
   * One GET, waiting out HighLevel's rate limit rather than failing on it.
   *
   * A private token gets about a hundred requests in ten seconds, and the walks that go customer by customer
   * (tasks and notes: two requests each) reach that within seconds on an ordinary account. A 429 used to fail
   * the whole batch and send it round the backoff, over and over; now the request waits as long as HighLevel
   * asks — or a couple of seconds when it does not say — and asks again, a few times, before giving up.
   */
  const call = async <T>(
    token: string,
    path: string,
    init?: { readonly method?: 'GET'; readonly timeoutMs?: number },
  ): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await callOnce<T>(token, path, init);
      } catch (e) {
        const err = e as GhlError;
        /**
         * A request that timed out or lost its connection is asked again too, a couple of times. Every call
         * here is a read, so asking twice changes nothing over there — and one slow answer from HighLevel
         * (the first real import had one, forty minutes in, on a calendar) is not a reason to fail a page.
         */
        /**
         * HighLevel's own timeouts count too. It answers a request it gave up on with a 401 that says
         * "Command timed out" — not a sign-in problem at all, and read as one it failed a batch of the
         * first real import's notes — and a busy moment with a 502, 503 or 504.
         */
        const dropped =
          !(e instanceof GhlError) ||
          (err.status === 401 && /timed out/i.test(err.message)) ||
          [502, 503, 504].includes(err.status);
        if (dropped && attempt < NETWORK_TRIES) {
          await new Promise((r) => setTimeout(r, 2_000 * attempt));
          continue;
        }
        if (err.code !== 'rate_limited' || attempt >= RATE_LIMIT_TRIES) throw e;
        await new Promise((r) => setTimeout(r, err.retryAfterMs ?? 2_000 * attempt));
      }
    }
  };

  const callOnce = async <T>(
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
        // Seconds, as HighLevel sends it; capped so one answer cannot park a batch past its lease.
        const retryAfter = Number(res.headers.get('retry-after'));
        throw new GhlError(
          `GoHighLevel answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
          res.status,
          code,
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 30_000)
            : undefined,
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

  /**
   * Where a walk has got to. Whatever the endpoint pages by, two more things ride along: how many records
   * have been read so far (checked against the total the answer carries, so a page GoHighLevel quietly caps
   * below what we asked for never reads as the end of the list) and the id the last page ended on (so a
   * page that ends on it again is caught, below, rather than counted).
   */
  interface PageCursor {
    startAfterId?: string;
    startAfter?: number;
    startAfterDate?: number;
    page?: number;
    offset?: number;
    seen?: number;
    lastId?: string;
  }

  /** A moment as epoch milliseconds, from whichever spelling GoHighLevel used, or undefined. */
  const epochOf = (v: unknown): number | undefined => {
    const t = asDate(v)?.getTime();
    return t && t > 0 ? t : undefined;
  };

  /**
   * The `dateAdded` of one contact, as the number the contacts list wants beside its id.
   *
   * Only ever asked for a cursor that was saved before this adapter knew the list needs the pair: those have
   * an id and no time. One request puts the walk back where it stopped; if the contact has since gone, the
   * walk starts again from the top, which costs re-reading what is already here and loses nothing.
   */
  const whenAdded = async (
    token: string,
    endpoint: Endpoint,
    id: string,
  ): Promise<number | undefined> => {
    if (endpoint.objectType !== 'contact') return undefined;
    try {
      const body = await call<{ contact?: Record<string, unknown> }>(
        token,
        `/contacts/${encodeURIComponent(id)}`,
        { timeoutMs: 15_000 },
      );
      return epochOf(body.contact?.['dateAdded']);
    } catch {
      return undefined;
    }
  };

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
    const cursor = (options.cursor ?? {}) as PageCursor;
    // An endpoint that refuses `limit` gives everything it has in one answer, so there is nothing to page.
    let path = endpoint.limit === false ? base : `${base}${join}limit=${limit}`;
    if (endpoint.paging === 'startAfter' && cursor.startAfterId) {
      /**
       * The contacts list pages by a pair: the last record's id and its `dateAdded` as epoch milliseconds.
       * The id alone is ignored — GoHighLevel answers with the first page again, and an import that trusts
       * it reads that page forever, counting the same hundred customers each time. That is what "99 of
       * 7,700" was on an account with 856. The time used to be worked out with `Number()` on an ISO date,
       * which is NaN, so it was never sent. A cursor saved by that code has the id and no time; the time is
       * asked for once and the walk carries on from where it stopped.
       */
      const startAfter =
        cursor.startAfter ?? (await whenAdded(token, endpoint, cursor.startAfterId));
      if (startAfter)
        path += `&startAfterId=${encodeURIComponent(cursor.startAfterId)}&startAfter=${startAfter}`;
    }
    if (endpoint.paging === 'startAfterDate' && cursor.startAfterDate)
      path += `&startAfterDate=${cursor.startAfterDate}`;
    if (endpoint.paging === 'page') path += `&page=${cursor.page ?? 1}`;
    if (endpoint.paging === 'offset') path += `&offset=${cursor.offset ?? 0}`;
    if (endpoint.paging === 'skip') path += `&skip=${cursor.offset ?? 0}`;

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
    const lastId = last ? (asString(last[endpoint.idKey]) ?? asString(last['_id'])) : null;
    /**
     * A page that ends where the last one ended is the last one again: the source ignored where we asked it
     * to start. Reading on would count the same records forever and never reach the ones behind them, so
     * this stops the batch instead. The batch fails with this sentence on it, which is ours to fix, and the
     * business sees a stopped import rather than a count climbing past what they own.
     */
    if (lastId && cursor.lastId && cursor.lastId === lastId)
      throw new GhlError(
        `GoHighLevel handed back the same page of ${endpoint.objectType} records twice, so the rest cannot be read from here. This one is ours to fix.`,
        500,
        'paging_stuck',
      );
    const total = totalOf(body, endpoint.totalKey ?? 'total');
    const seen = (cursor.seen ?? 0) + list.length;
    /**
     * The end of the list. An endpoint that takes no limit answered with everything at once. Otherwise the
     * answer's own total decides when it carries one — a page the source caps below what we asked for is
     * not the end — and a page short of what we asked for decides when it does not. An empty page is the
     * end whatever anybody says.
     */
    const done =
      endpoint.limit === false ||
      list.length === 0 ||
      (typeof total === 'number' ? seen >= total : list.length < limit);
    let nextCursor: PageCursor | null = null;
    if (!done && last) {
      const meta = (body['meta'] ?? {}) as Record<string, unknown>;
      switch (endpoint.paging) {
        case 'page':
          nextCursor = { page: (cursor.page ?? 1) + 1 };
          break;
        case 'offset':
        case 'skip':
          nextCursor = { offset: (cursor.offset ?? 0) + list.length };
          break;
        case 'startAfter':
          // The answer says where the next page starts, when it says; the last record says otherwise.
          nextCursor = {
            startAfterId: asString(meta['startAfterId']) ?? lastId ?? '',
            startAfter:
              epochOf(meta['startAfter']) ?? epochOf(last['dateAdded'] ?? last['dateUpdated']),
          };
          break;
        case 'startAfterDate': {
          const at = epochOf(last['lastMessageDate'] ?? last['dateUpdated'] ?? last['dateAdded']);
          if (!at)
            throw new GhlError(
              `GoHighLevel gave a page of ${endpoint.objectType} records with no date to carry on from. This one is ours to fix.`,
              500,
              'paging_stuck',
            );
          nextCursor = { startAfterDate: at };
          break;
        }
        default:
          nextCursor = null;
      }
      if (nextCursor) nextCursor = { ...nextCursor, seen, lastId: lastId ?? undefined };
    }
    return {
      records,
      cursor: nextCursor as Record<string, unknown> | null,
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
   * Email templates, each with its words.
   *
   * HighLevel's builder list hands over a name and a `previewUrl` — a rendered copy of the email sitting in
   * its storage — and nothing of what the email says. Every one of the thirteen on the first real account
   * came across as "its words did not come with it". So each is read once more from that copy and turned
   * into plain wording, which is what a template is here. Folders are listed alongside the templates over
   * there and are not templates; they are left out rather than reported as templates with no words.
   */
  const templatePage = async (
    token: string,
    scopeId: string,
    options: ListOptions,
  ): Promise<SourcePage> => {
    const listed = await page(token, ENDPOINTS['templates']!, scopeId, options);
    const records: SourceRecord[] = [];
    for (const t of listed.records) {
      if (asString(t.payload['templateType']) === 'folder') continue;
      const text = await previewText(asString(t.payload['previewUrl']));
      records.push(text ? { ...t, payload: { ...t.payload, __previewText: text } } : t);
    }
    return { ...listed, records };
  };

  /**
   * A page of products, each with its prices. The list carries none — it says `hasPrices: false` even of a
   * product that has one, and every product on the first real account came across at $0 — so each product is
   * asked for its own, the way HighLevel's own product screen asks.
   */
  const productPage = async (
    token: string,
    scopeId: string,
    options: ListOptions,
  ): Promise<SourcePage> => {
    const listed = await page(token, ENDPOINTS['products']!, scopeId, options);
    const records = await inPool(listed.records, EMAIL_CONCURRENCY, async (r) => {
      if (Array.isArray(r.payload['prices']) && r.payload['prices'].length > 0) return r;
      try {
        const answer = await call<Record<string, unknown>>(
          token,
          `/products/${encodeURIComponent(r.objectId)}/price?locationId=${encodeURIComponent(scopeId)}`,
        );
        const prices = (
          Array.isArray(answer['prices']) ? (answer['prices'] as Record<string, unknown>[]) : []
        ).filter((price) => price['deleted'] !== true);
        return prices.length > 0 ? { ...r, payload: { ...r.payload, prices } } : r;
      } catch (e) {
        // A product whose prices HighLevel will not show still comes across, as it was listed.
        if (e instanceof GhlError && [400, 403, 404, 422].includes(e.status)) return r;
        throw e;
      }
    });
    return { ...listed, records };
  };

  /**
   * A page of invoices, each paid one with the day its money arrived. The invoice itself only says when it was
   * last touched, and on the first real account that put a quarter of the payments days after they were
   * made; the payment's own record says when. An invoice whose payment cannot be read keeps the old guess.
   */
  const invoicePage = async (
    token: string,
    scopeId: string,
    options: ListOptions,
  ): Promise<SourcePage> => {
    const cursor = (options.cursor ?? null) as { payments?: number } | null;
    if (cursor && typeof cursor.payments === 'number')
      return paymentPage(token, scopeId, cursor.payments, options);
    const listed = await page(token, ENDPOINTS['invoices']!, scopeId, options);
    const records = await inPool(listed.records, EMAIL_CONCURRENCY, async (r) => {
      if (cents(r.payload['amountPaid']) <= 0) return r;
      try {
        const answer = await call<Record<string, unknown>>(
          token,
          `/payments/transactions?altId=${encodeURIComponent(scopeId)}&altType=location` +
            `&entityId=${encodeURIComponent(r.objectId)}&limit=100`,
        );
        const paidOn = (
          Array.isArray(answer['data']) ? (answer['data'] as Record<string, unknown>[]) : []
        )
          .filter((t) => t['status'] === 'succeeded' && asString(t['entityId']) === r.objectId)
          .map((t) => asDate(t['createdAt']))
          .filter((d): d is Date => !!d)
          .sort((a, b) => b.getTime() - a.getTime())[0];
        return paidOn ? { ...r, payload: { ...r.payload, __paidAt: paidOn.toISOString() } } : r;
      } catch (e) {
        // A sign-in without the payments scope still brings the invoice, dated the way it was.
        if (e instanceof GhlError && [400, 401, 403, 404, 422].includes(e.status)) return r;
        throw e;
      }
    });
    // The invoices done, the same walk carries on through the money that never had one.
    if (listed.done) return { ...listed, records, cursor: { payments: 0 }, done: false };
    return { ...listed, records };
  };

  /**
   * Money that came in without an invoice: an order form, a store checkout, a payment link, a plan's charge,
   * or one somebody recorded by hand. The first real account had 206 of them beside its 146 invoices, and
   * none came across. Here every payment belongs to an invoice — a deposit at booking or a quick payment makes
   * one behind the scenes — so each comes across the same way: a paid invoice for what was bought, dated the
   * day it was paid. What was bought is on the order, read once per order.
   */
  const paymentPage = async (
    token: string,
    scopeId: string,
    offset: number,
    options: ListOptions,
  ): Promise<SourcePage> => {
    const limit = Math.min(options.limit ?? 100, 100);
    const answer = await call<Record<string, unknown>>(
      token,
      `/payments/transactions?altId=${encodeURIComponent(scopeId)}&altType=location` +
        `&limit=${limit}&offset=${offset}`,
    );
    const list = Array.isArray(answer['data']) ? (answer['data'] as Record<string, unknown>[]) : [];
    const total = Number(answer['totalCount'] ?? 0) || 0;
    // An invoice's own payment came with the invoice. Only money that really arrived is money here: a $0
    // checkout (a free sign-up in the store — 87 of them on the first real account) moved nothing.
    const standing = list.filter(
      (t) =>
        asString(t['entityType']) !== 'invoice' &&
        asString(t['status']) === 'succeeded' &&
        cents(t['amount']) > 0,
    );
    const orders = new Map<string, Promise<string[]>>();
    const itemsOf = (orderId: string): Promise<string[]> => {
      let got = orders.get(orderId);
      if (!got) {
        got = call<Record<string, unknown>>(
          token,
          `/payments/orders/${encodeURIComponent(orderId)}?altId=${encodeURIComponent(scopeId)}&altType=location`,
        )
          .then((order) =>
            (Array.isArray(order['items']) ? (order['items'] as Record<string, unknown>[]) : [])
              .map((it) => asString(it['name']))
              .filter((n): n is string => !!n),
          )
          .catch(() => []);
        orders.set(orderId, got);
      }
      return got;
    };
    const records: SourceRecord[] = await inPool(standing, EMAIL_CONCURRENCY, async (t) => {
      const id = asString(t['_id']) ?? asString(t['id']) ?? '';
      const orderId = asString(t['entityType']) === 'order' ? asString(t['entityId']) : null;
      const items = orderId ? await itemsOf(orderId) : [];
      const at = asDate(t['createdAt']);
      return {
        objectType: 'payment',
        objectId: id,
        sourceCreatedAt: at,
        sourceUpdatedAt: asDate(t['updatedAt']) ?? at,
        payload: { ...t, __items: items },
      };
    });
    const next = offset + list.length;
    const done = list.length === 0 || next >= total;
    return {
      records: records.filter((r) => r.objectId),
      cursor: done ? null : { payments: next },
      highWaterAt: null,
      done,
    };
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
      contacts?: Record<string, unknown> | null;
      contactsDone?: boolean;
    };
    let queue = [...(cursor.queue ?? [])];
    let contacts = cursor.contacts ?? null;
    let contactsDone = cursor.contactsDone ?? false;

    // The customers, a page at a time, through the same reader the customers themselves come through — so
    // the cursor is the pair GoHighLevel wants and a repeated page is caught there rather than walked forever.
    while (queue.length === 0 && !contactsDone) {
      const customers = await page(token, ENDPOINTS['contacts']!, scopeId, {
        cursor: contacts,
        limit: 100,
        includeDeleted: true,
      });
      queue = customers.records.map((c) => c.objectId);
      contactsDone = customers.done;
      contacts = customers.cursor;
    }
    if (queue.length === 0) return { records: [], cursor: null, highWaterAt: null, done: true };

    const take = queue.slice(0, CUSTOMERS_PER_PAGE);
    /**
     * Both lists for each customer, a few customers at once. One at a time, at half a second a request, the
     * walk over 856 customers took a quarter of an hour on its own and held every other category up behind
     * it. Four at a time stays well inside HighLevel's hundred-in-ten-seconds, and a 429 is waited out anyway.
     */
    const lists = await inPool(take, TASK_WALK_CONCURRENCY, async (contactId) => {
      const got: { contactId: string; want: 'tasks' | 'notes'; list: Record<string, unknown>[] }[] =
        [];
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
        got.push({
          contactId,
          want,
          list: Array.isArray(body[want]) ? (body[want] as Record<string, unknown>[]) : [],
        });
      }
      return got;
    });
    const records: SourceRecord[] = [];
    let highWaterAt: Date | null = null;
    for (const { contactId, want, list } of lists.flat()) {
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
   * An email as HighLevel's thread list shows it, made whole.
   *
   * The list leaves the words off about one email in five — the first real account had 1,590 of them, a
   * subject and nothing else — and one entry can stand for a whole exchange: the ids of every email in it,
   * the customer's reply among them. Each email is asked for by its own id and comes across as itself, with
   * its own words, sender, recipients and time. The first keeps the entry's id, so what was mapped to the
   * entry stays mapped; the others are their own. An email HighLevel will not show is kept as the list had it.
   */
  const emailsOf = async (token: string, record: SourceRecord): Promise<SourceRecord[]> => {
    const p = record.payload;
    const kind = (asString(p['messageType']) ?? asString(p['type']) ?? '').toUpperCase();
    if (CHANNELS[kind]?.channel !== 'email') return [record];
    const email = ((p['meta'] ?? {}) as Record<string, Record<string, unknown>>)['email'] ?? {};
    const ids = (Array.isArray(email['messageIds']) ? (email['messageIds'] as unknown[]) : [])
      .map(asString)
      .filter((v): v is string => !!v);
    if (ids.length === 0 || (ids.length === 1 && asString(p['body']))) return [record];
    const out: SourceRecord[] = [];
    for (const [i, emailId] of ids.entries()) {
      let one: Record<string, unknown> | null = null;
      try {
        const answer = await call<Record<string, unknown>>(
          token,
          `/conversations/messages/email/${encodeURIComponent(emailId)}`,
        );
        one = (answer['emailMessage'] ?? null) as Record<string, unknown> | null;
      } catch (e) {
        if (!(e instanceof GhlError) || ![400, 403, 404, 422].includes(e.status)) throw e;
      }
      if (!one) {
        if (i === 0) out.push(record);
        continue;
      }
      const at = asDate(one['dateAdded']) ?? record.sourceCreatedAt ?? null;
      const words = asString(one['body']);
      const html = words && /<[a-z!][\s\S]*>/i.test(words) ? words : null;
      out.push({
        ...record,
        objectId: i === 0 ? record.objectId : emailId,
        sourceCreatedAt: at,
        sourceUpdatedAt: asDate(one['dateUpdated']) ?? at,
        payload: {
          ...p,
          ...(i === 0 ? {} : { id: emailId, status: null }),
          emailMessageId: emailId,
          emailThreadId: record.objectId,
          direction: asString(one['direction']) ?? directionOf(p),
          subject: asString(one['subject']) ?? asString(email['subject']),
          body: html ? null : words,
          html,
          from: one['from'] ?? p['from'] ?? null,
          to: one['to'] ?? p['to'] ?? null,
          cc: one['cc'] ?? null,
          attachments: one['attachments'] ?? (i === 0 ? (p['attachments'] ?? []) : []),
          dateAdded: at?.toISOString() ?? p['dateAdded'],
        },
      });
    }
    return out;
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
      conv?: Record<string, unknown> | null;
      convDone?: boolean;
      msg?: string | null;
    };
    let queue = [...(cursor.queue ?? [])];
    let conv = cursor.conv ?? null;
    let convDone = cursor.convDone ?? false;
    let msg = cursor.msg ?? null;

    // Out of conversations to read from: fetch the next page of them, through the same reader the
    // conversations themselves come through, so the two walks can never disagree about how to page.
    while (queue.length === 0 && !convDone) {
      const threads = await page(token, ENDPOINTS['conversations']!, scopeId, {
        cursor: conv,
        limit,
        includeDeleted: true,
      });
      queue = threads.records.map((c) => c.objectId);
      convDone = threads.done;
      conv = threads.cursor;
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
      const kind = (asString(raw['messageType']) ?? '').toUpperCase();
      // "Invoice sent", "payment received", "appointment booked": HighLevel's activity log, kept in the same
      // thread as the texts. Nobody said them, and the invoice, payment and appointment each come across as
      // themselves, so they would only be the same event twice, dressed up as a message. The chat widget's
      // own notices ("Your chat has ended") are the same kind of line.
      if (kind.startsWith('TYPE_ACTIVITY') || kind.endsWith('_INFO_MESSAGE')) continue;
      const isCall = CALL_TYPES.has(kind);
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
    const whole =
      want === 'messages'
        ? (await inPool(records, EMAIL_CONCURRENCY, (r) => emailsOf(token, r))).flat()
        : records;

    // Where to carry on: further into this conversation, or on to the next one.
    if (more && lastId) msg = lastId;
    else {
      queue = queue.slice(1);
      msg = null;
    }
    const done = queue.length === 0 && convDone && !msg;
    return {
      records: whole,
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
    let path =
      endpoint.limit === false
        ? base
        : `${base}${base.includes('?') ? '&' : '?'}limit=${endpoint.counts ? 100 : 1}`;
    // Where the list starts, spelled the way a real read spells it: the invoice and estimate lists refuse a
    // question without `offset` (`422 offset should not be empty`), which is how both came to be counted as
    // "unknown" on the first real account.
    if (endpoint.limit !== false) {
      if (endpoint.paging === 'offset') path += '&offset=0';
      if (endpoint.paging === 'skip') path += '&skip=0';
      if (endpoint.paging === 'page') path += '&page=1';
    }
    try {
      const body = await call<Record<string, unknown>>(token, path, { timeoutMs: 15_000 });
      const total = totalOf(body, endpoint.totalKey ?? 'total');
      const list = Array.isArray(body[endpoint.listKey])
        ? (body[endpoint.listKey] as unknown[])
        : [];
      // Only the rows that are records, when the list mixes in other things: all of them are here when the
      // first page held the whole list, and the total less what was left out of it otherwise.
      if (endpoint.counts) {
        const rows = list as Record<string, unknown>[];
        const kept = rows.filter(endpoint.counts).length;
        const whole = typeof total !== 'number' || total <= rows.length;
        return {
          capability: 'ready',
          count: whole ? kept : total - (rows.length - kept),
          quality: whole ? 'complete' : 'estimated',
        };
      }
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
                recommendedAction: SIGN_IN_MISSING_ACCESS,
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
                  : SIGN_IN_MISSING_ACCESS,
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
      // An email template's words are only in its rendered copy, so each is read from there.
      if (category === 'templates')
        return templatePage(tokenOf(connection, scope), scope.externalScopeId, options);
      // When an invoice's money arrived is only on its payment.
      if (category === 'invoices')
        return invoicePage(tokenOf(connection, scope), scope.externalScopeId, options);
      // A product's prices are only on the product, so each is asked for them.
      if (category === 'products')
        return productPage(tokenOf(connection, scope), scope.externalScopeId, options);
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
        case 'template':
          return [templateEnvelope(record, context)];
        case 'form':
        case 'survey':
          return [formEnvelope(record, context)];
        case 'form_submission':
          return [formResponseEnvelope(record, context)];
        case 'product':
          return [productEnvelope(record, context)];
        case 'invoice':
          return [invoiceEnvelope(record, context)];
        case 'payment':
          return [paymentEnvelope(record, context)];
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

/**
 * A name typed all in lowercase, capitalized the way a name is written: "david" is "David", "mary-jane
 * o'brien" is "Mary-Jane O'Brien". Anything with a capital in it already is left exactly as it was typed —
 * "McDonald", "DeShawn" and "NYC SEO Pro" were somebody's choice, and a rule would only get them wrong.
 */
export function nameCase(name: string | null): string | null {
  // An email standing in for a name is left alone: "Bob@example.com" is nobody's name.
  if (!name || name !== name.toLowerCase() || name.includes('@')) return name;
  return name.replace(
    /(^|[\s\-'’])(\p{Ll})/gu,
    (_m, before: string, letter: string) => before + letter.toUpperCase(),
  );
}

const CONTACT_USED = [
  'id',
  '_id',
  'locationId',
  'firstName',
  'lastName',
  'firstNameRaw',
  'lastNameRaw',
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
  'website',
  'businessId',
  'dateAdded',
  'dateUpdated',
  'type',
  'deleted',
];

function contactEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  // The name as it was typed. `firstName` and `lastName` are HighLevel's lowercased copies ("bobby barber");
  // `firstNameRaw` and `lastNameRaw` are what somebody actually entered ("Bobby Barber").
  const firstName = nameCase(asString(p['firstNameRaw']) ?? asString(p['firstName']));
  const lastName = nameCase(asString(p['lastNameRaw']) ?? asString(p['lastName']));
  const warnings: { code: string; field?: string | null; message: string }[] = [];
  const endpoints: { kind: 'phone' | 'email'; value: string; primary: boolean }[] = [];
  const email = asString(p['email']);
  const phone = asString(p['phone']);
  if (email) endpoints.push({ kind: 'email', value: email, primary: true });
  if (phone) endpoints.push({ kind: 'phone', value: phone, primary: true });
  // The extra ones come as `{ email }` (and `{ phone }`), not as strings: read as strings, all of them went.
  const extraOf = (v: unknown, key: string): string | null =>
    asString(v) ?? asString((v as Record<string, unknown> | null)?.[key]);
  for (const extra of Array.isArray(p['additionalEmails']) ? p['additionalEmails'] : []) {
    const value = extraOf(extra, 'email');
    if (value) endpoints.push({ kind: 'email', value, primary: false });
  }
  for (const extra of Array.isArray(p['additionalPhones']) ? p['additionalPhones'] : []) {
    const value = extraOf(extra, 'phone');
    if (value) endpoints.push({ kind: 'phone', value, primary: false });
  }

  // What the customer agreed to, channel by channel. GoHighLevel's `dnd` is the whole-person switch and
  // `dndSettings` is per channel; the stricter of the two wins, which is what "do not disturb" has to mean.
  const dnd = p['dnd'] === true;
  const dndSettings = (p['dndSettings'] ?? {}) as Record<string, { status?: string }>;
  const consentFor = (key: string, channel: string) => {
    /**
     * Anything but `inactive` means do not send. `permanent` is the one a customer's own STOP sets, and it
     * was the one read as nothing: nine people on the first real account who had texted STOP came across
     * free to be texted again. A state not known here is read the careful way too.
     */
    const status = (asString(dndSettings[key]?.status) ?? '').toLowerCase();
    const off = dnd || (status !== '' && status !== 'inactive');
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
    firstName,
    lastName,
    // HighLevel's `contactName` is lowercased like the rest; built from the typed parts when there are any.
    fullName:
      [firstName, lastName].filter(Boolean).join(' ') || nameCase(asString(p['contactName'])),
    companyName: asString(p['companyName'])?.slice(0, 200) ?? null,
    website: asString(p['website'])?.slice(0, 400) ?? null,
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
      // Written in HighLevel's editor, so it is HTML; here it is the words on a bill.
      description: plainText(p['description'])?.slice(0, 2000) ?? null,
      unitPriceCents: first ? cents(first['amount']) : 0,
      unitLabel: 'each',
      taxable: true,
      // Whether it shows in the online store is not whether it is still sold: 15 of the first real account's 26
      // products were kept out of the store and billed every month, and came across archived.
      active:
        p['deleted'] !== true && (asString(p['status']) ?? 'active').toLowerCase() !== 'archived',
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
      customerEmail:
        asString((p['contactDetails'] as Record<string, unknown> | undefined)?.['email'])?.slice(
          0,
          320,
        ) ?? null,
      customerPhone:
        asString((p['contactDetails'] as Record<string, unknown> | undefined)?.['phoneNo'])?.slice(
          0,
          40,
        ) ?? null,
      number: asString(p['invoiceNumber'])?.slice(0, 40) ?? null,
      // `name` is what the bill is for; `title` is the word printed at the top of it, "INVOICE" nearly always.
      title: (asString(p['name']) ?? asString(p['title']))?.slice(0, 200) ?? null,
      notes: asString(p['termsNotes'])?.slice(0, 5000) ?? null,
      status,
      currency: (asString(p['currency']) ?? 'USD').toUpperCase().slice(0, 3),
      subtotalCents: cents(p['subtotal'] ?? p['total']),
      discountCents: cents((p['discount'] as Record<string, unknown> | undefined)?.['value']),
      taxCents: cents(p['taxSum'] ?? p['totalTax']),
      totalCents: total,
      paidCents: Math.min(paid, total),
      paidAt:
        asDate(p['__paidAt'] ?? p['paidAt'] ?? p['updatedAt'])?.toISOString() ??
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

/** A payment with no invoice over there, as the paid invoice that holds it here. */
function paymentEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const amount = cents(p['amount']);
  const items = Array.isArray(p['__items']) ? (p['__items'] as string[]) : [];
  const meta = (p['entitySourceMeta'] ?? {}) as Record<string, unknown>;
  const kind = asString(p['entityType']);
  // What it was for: the order's items, what somebody wrote on a payment taken by hand, or where it came from.
  const described = kind === 'manual' ? plainText(meta['description']) : null;
  const what = (
    items.join(', ') ||
    described?.split('\n')[0] ||
    asString(p['entitySourceName']) ||
    'Payment'
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const plan = asString(p['subscriptionId']);
  const paidAt = (asDate(p['createdAt']) ?? record.sourceCreatedAt ?? new Date()).toISOString();
  return envelopeOf(
    record,
    context,
    'invoice',
    'invoices',
    {
      customerEmail: asString(p['contactEmail'])?.slice(0, 320) ?? null,
      customerPhone: null,
      // A number of its own, so the receipt reads as the paid bill it is rather than as a draft: the day it was
      // paid and the end of the old system's id, which no invoice number over there looks like.
      number: `P-${paidAt.slice(0, 10).replace(/-/g, '')}-${(asString(p['_id']) ?? '').slice(-6)}`,
      title: what,
      notes: described && described !== what ? described.slice(0, 5000) : null,
      status: 'paid',
      currency: (asString(p['currency']) ?? 'USD').toUpperCase().slice(0, 3),
      subtotalCents: amount,
      discountCents: 0,
      taxCents: 0,
      totalCents: amount,
      paidCents: amount,
      paidAt,
      issuedAt: paidAt,
      dueOn: null,
      terms: null,
      purpose: plan ? 'subscription' : 'quick',
      planRef: plan,
      lines: [
        {
          name: what,
          description: null,
          quantity: 1,
          unitLabel: 'each',
          unitPriceCents: amount,
          taxable: false,
        },
      ],
    },
    leftovers(p, [
      '_id',
      'id',
      'amount',
      'currency',
      'status',
      'createdAt',
      'updatedAt',
      '__items',
    ]),
    [],
    asString(p['contactId'])
      ? [
          {
            category: 'contacts',
            objectType: 'contact',
            objectId: asString(p['contactId'])!,
            role: 'contact',
            required: false,
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
      customerEmail:
        asString((p['contactDetails'] as Record<string, unknown> | undefined)?.['email'])?.slice(
          0,
          320,
        ) ?? null,
      customerPhone:
        asString((p['contactDetails'] as Record<string, unknown> | undefined)?.['phoneNo'])?.slice(
          0,
          40,
        ) ?? null,
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

/**
 * A plan that has stopped, whatever the processor calls it. `incomplete_expired` is Stripe's word for a plan
 * whose first payment never went through and which then lapsed — it never charged anybody, and read as
 * anything but over it came across as a live plan, "billed elsewhere", on the first real account five times.
 */
const PLAN_ENDED = new Set([
  'cancelled',
  'canceled',
  'incomplete_expired',
  'expired',
  'ended',
  'completed',
  'terminated',
]);

function subscriptionEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const rawStatus = (asString(p['status']) ?? '').toLowerCase();
  const status = PLAN_ENDED.has(rawStatus)
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
  /**
   * What the plan is and how often it bills live on its recurring product, not beside the amount: read from
   * the top, every plan on the first real account came across as "Plan", monthly — a quarterly one included.
   */
  const recurring = (p['recurringProduct'] ?? {}) as Record<string, Record<string, unknown>>;
  const every = (recurring['price']?.['recurring'] ?? {}) as Record<string, unknown>;
  const rawInterval = (
    asString(every['interval']) ??
    asString(p['interval']) ??
    'month'
  ).toLowerCase();
  const count = Math.max(
    1,
    Math.min(36, Number(every['intervalCount'] ?? p['intervalCount'] ?? 1) || 1),
  );
  // Plans here run by the month, the quarter or the year. A shorter one keeps its price and says so.
  const unit = PLAN_INTERVAL[rawInterval] ?? 'month';
  const planWarnings =
    unit === 'day' || unit === 'week'
      ? [
          {
            code: 'mapping.plan_interval_narrowed',
            field: 'interval',
            message: `This plan billed every ${count > 1 ? `${count} ` : ''}${unit}${count > 1 ? 's' : ''} over there; plans here run by the month, so it shows monthly.`,
          },
        ]
      : [];
  return envelopeOf(
    record,
    context,
    'subscription',
    'subscriptions',
    {
      customerEmail: asString(p['contactEmail'])?.slice(0, 320) ?? null,
      customerPhone: asString(p['contactPhone'])?.slice(0, 40) ?? null,
      planName: (
        asString(recurring['product']?.['name']) ??
        asString(p['name'] ?? p['productName']) ??
        asString(p['entitySourceName']) ??
        'Plan'
      ).slice(0, 160),
      priceCents: cents(p['amount'] ?? p['price']),
      interval: unit === 'year' ? 'year' : 'month',
      intervalCount: unit === 'day' || unit === 'week' ? 1 : count,
      status,
      startedOn: day(p['subscriptionStartDate'] ?? p['startDate'] ?? p['createdAt']),
      currentPeriodStart: day(p['currentPeriodStart']),
      currentPeriodEnd: day(p['currentPeriodEnd']),
      nextBillingOn: day(p['nextChargeDate'] ?? p['nextBillingDate']),
      cancelledAt:
        status === 'cancelled'
          ? (asDate(p['cancelledAt'] ?? p['canceledAt'] ?? p['endedAt'])?.toISOString() ?? null)
          : null,
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
      'recurringProduct',
      'subscriptionStartDate',
    ]),
    planWarnings,
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
      // `bodyText` is what was typed; `body` can be the editor's HTML, which read as tags in the timeline.
      body:
        (asString(p['bodyText']) ?? htmlToText(asString(p['body']) ?? '')).slice(0, 10_000) ||
        '(empty note)',
      occurredAt: (record.sourceCreatedAt ?? new Date()).toISOString(),
    },
    leftovers(p, [
      'id',
      '_id',
      'body',
      'bodyText',
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

// ---------- the wording they reuse ----------

/**
 * Where an email builder keeps the words, which is not the same place twice.
 *
 * HighLevel's builder returns a template's HTML under whichever of these the template was made with, and an
 * older one made in the plain-text editor has only `textOnly`. Taking the first that has anything in it is
 * the honest reading; a template with none of them has a name and nothing else, and is refused below rather
 * than landing in the picker as an empty card.
 */
const TEMPLATE_BODY_KEYS = [
  '__previewText',
  'html',
  'body',
  'content',
  'textOnly',
  'text',
  'message',
] as const;

/**
 * Where a template's rendered copy may be read from. The URL comes out of GoHighLevel's answer, and the
 * worker follows it, so it is held to HighLevel's own storage rather than to anywhere an answer names.
 */
const PREVIEW_HOSTS = [
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
  '.leadconnectorhq.com',
  '.msgsndr.com',
];

/** The words of a rendered email, as plain text: what a template is here. Null when it cannot be read. */
async function previewText(url: string | null): Promise<string | null> {
  if (!url) return null;
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return null;
  }
  const host = at.hostname.toLowerCase();
  if (
    at.protocol !== 'https:' ||
    !PREVIEW_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h))
  )
    return null;
  // A few tries: one blip on the way to the rendered copy used to leave the template without its words for good.
  for (let attempt = 1; attempt <= PREVIEW_TRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(at, { signal: controller.signal, redirect: 'error' });
      if (res.ok) {
        const html = (await res.text()).slice(0, 2_000_000);
        const text = htmlToText(html);
        return text ? text.slice(0, 20_000) : null;
      }
      // Not there, or not ours to read: asking again will not change that.
      if (res.status < 500 && res.status !== 429) return null;
    } catch {
      // Timed out or dropped: asked again below.
    } finally {
      clearTimeout(timer);
    }
    if (attempt < PREVIEW_TRIES) await new Promise((r) => setTimeout(r, 1_000 * attempt));
  }
  return null;
}

const PREVIEW_TRIES = 3;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

/**
 * HTML to the words a person reads in it. Blocks and line breaks become line breaks, links keep where they
 * go, and everything else — styles, head, Outlook's conditional comments — goes. `{{placeholders}}` pass
 * through untouched, because they are the same language here.
 */
/** Words that may have come as an editor's HTML, as the words. Plain text passes through untouched. */
const plainText = (v: unknown): string | null => {
  const said = asString(v);
  if (!said) return null;
  return /<[a-z][^>]*>/i.test(said) ? htmlToText(said) || null : said;
};

export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, inner: string) => {
        const label = inner.replace(/<[^>]+>/g, '').trim();
        return !label || label === href || href.startsWith('mailto:')
          ? label || href
          : `${label} (${href})`;
      },
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code =
          e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function templateEnvelope(record: SourceRecord, context: MappingContext): CanonicalEnvelope {
  const p = record.payload;
  const body =
    TEMPLATE_BODY_KEYS.map((k) => asString(p[k]))
      .find((v) => v && v.trim().length > 0)
      ?.slice(0, 20_000) ?? '';
  const html = !!asString(p['html']);
  return envelopeOf(
    record,
    context,
    'template',
    'templates',
    {
      name: (asString(p['name']) ?? asString(p['templateName']) ?? 'Template').slice(0, 120),
      // HighLevel's builder is for email. A text template is a different thing over there and is not here.
      channel: 'email',
      subject: asString(p['subject'])?.slice(0, 200) ?? null,
      body,
      folder: asString(p['folder'])?.slice(0, 60) ?? null,
    },
    {
      ...leftovers(p, [
        ...TEMPLATE_BODY_KEYS,
        'id',
        '_id',
        'name',
        'templateName',
        'subject',
        'folder',
        'locationId',
      ]),
      html,
    },
    body
      ? []
      : [
          {
            code: 'mapping.template_has_no_words',
            field: 'body',
            message:
              'The old system listed this template but would not hand over what it says, so there is nothing to save.',
          },
        ],
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
 *
 * Only names that cannot mean anything else. "Booked" was one, and on the first real account it named six
 * stages across five pipelines — "Booked Call", "Ai Booked Sales Call" — every one of them a step on the way
 * to a sale, not the sale: the won deals were filed back in the booked-call column, and a deal still open
 * there would have come across won. A stage read as open costs nothing, because the deal's own status still
 * decides where it lands.
 */
const STAGE_KIND = (name: string): 'open' | 'won' | 'lost' => {
  const n = name.toLowerCase();
  if (/\b(won|sold|signed|closed[\s-]*won)\b/.test(n)) return 'won';
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
  // A conversation's own type. HighLevel keeps one thread per customer and calls nearly all of them
  // TYPE_PHONE, whatever is inside; unrecognised, every one of them came across as a website chat and not one
  // text or email could be filed in it. A phone thread is a text thread, and each message still goes to the
  // thread for its own channel.
  TYPE_PHONE: { channel: 'sms' },
  TYPE_SMS: { channel: 'sms' },
  TYPE_SMS_REACTION: { channel: 'sms' },
  TYPE_CUSTOM_SMS: { channel: 'sms' },
  TYPE_CUSTOM_EMAIL: { channel: 'email' },
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
  // Who the thread is with. Email threads carry the address, texts the number, chats a name or an id — so
  // the preferred one comes first for the thread's own channel. Both travel separately too, for the
  // importer to fall back on and to file each message in the thread for its own channel.
  const phone = asString(p['phone']);
  const email = asString(p['email']);
  const counterpart =
    (channel === 'sms' ? (phone ?? email) : channel === 'email' ? (email ?? phone) : null) ??
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
      phone: phone?.slice(0, 40) ?? null,
      email: email?.slice(0, 320) ?? null,
      subject: asString(p['lastMessageBody'])?.slice(0, 400) ?? null,
      /*
       * Open, every one of them. GoHighLevel has no closed thread: its inbox lists every conversation a
       * business has ever had. Arriving closed took them out of the inbox here, which lists open ones, so a
       * business opened its inbox after the move and found most of its customers missing — there on the
       * customer's page, nowhere in the list. History still does not become work: the importer writes no
       * unread count and no waiting clock, so an open thread from 2019 sits in the list by its date and asks
       * nobody for anything.
       */
      status: 'open',
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
/**
 * Which way a message went. An email often says so only under `meta.email` — 708 of them on the first real
 * account, customers' replies nearly all — and read from the top alone every one of them was "sent".
 */
const directionOf = (p: Record<string, unknown>): 'inbound' | 'outbound' =>
  (
    asString(p['direction']) ??
    asString(
      ((p['meta'] ?? {}) as Record<string, Record<string, unknown>>)['email']?.['direction'],
    ) ??
    ''
  ).toLowerCase() === 'inbound'
    ? 'inbound'
    : 'outbound';

/** "Chris Evans <chris@example.com>", or an address or number on its own, as the address alone. */
const addressOf = (v: unknown): string | null => {
  const said = asString(v);
  if (!said) return null;
  return (/<([^<>\s]+)>/.exec(said)?.[1] ?? said).trim() || null;
};

/** One address, or a list of them (an email's recipients come as a list), as addresses. */
const addressesOf = (v: unknown): string[] =>
  (Array.isArray(v) ? (v as unknown[]) : [v]).map(addressOf).filter((a): a is string => !!a);

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
      channelName: name,
      direction,
      status,
      // An email's subject lives under `meta.email`, not beside the body.
      subject:
        asString(p['subject']) ??
        asString(
          ((p['meta'] ?? {}) as Record<string, Record<string, unknown>>)['email']?.['subject'],
        ),
      body: asString(p['body']) ?? asString(p['message']),
      bodyHtml: asString(p['html']),
      fromAddress: addressOf(p['from']),
      toAddresses: addressesOf(p['to']),
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
  // Zero is a length: a missed call lasted no time. Only a call that never said stays without one.
  const said = Number(callData['duration'] ?? p['duration']);
  const duration = Number.isFinite(said) && said >= 0 ? Math.round(said) : null;
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
      // HighLevel's positions can be negative or fractional; here they are a whole number from zero.
      position: Math.min(10_000, Math.max(0, Math.round(Number(p['position'] ?? 0) || 0))),
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
