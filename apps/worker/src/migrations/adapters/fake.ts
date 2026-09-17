/**
 * The stand-in CRM: local development, the tests and every Playwright spec migrate from this.
 *
 * It is not a mock that returns three rows. It is a small, deliberately awkward agency, because the things
 * that go wrong in a migration are the things a happy-path fixture never contains:
 *
 *   - **Two sub-accounts** (Austin and Dallas), so the many-to-one mapping Chris chose is really exercised.
 *   - **The same customer in both**, with the same mobile number, so a merge across sub-accounts happens.
 *   - **Two Dave Smiths**, one in each sub-account, with different numbers — so anything matching on names
 *     would join two real people and the test would catch it.
 *   - **A customer whose email points at one person here and whose phone points at another**, which is the
 *     conflict that must always go to a human.
 *   - **A custom field of a type we have no home for**, so the "kept, not dropped" promise is under test.
 *   - **A category the sign-in cannot reach**, so "we were not allowed to look" never renders as zero.
 *   - **A page boundary**: more contacts than one page holds, so resuming and the cursor are exercised.
 *
 * Nothing here looks like a secret: its tokens say they are fake.
 */
import type {
  CapabilityManifest,
  CategorySupport,
  CanonicalEnvelope,
  CrmSourceAdapter,
  InventoryResult,
  ListOptions,
  MappingContext,
  SourceConnection,
  SourcePage,
  SourceRecord,
} from '@hfos/core/server';
import { CANONICAL_SCHEMA_VERSION, migrationCategory, releaseCapability } from '@hfos/core/server';

export const FAKE_ADAPTER_VERSION = 'fake-1';
/** A page, small on purpose so the tests cross a boundary without thousands of rows. */
export const FAKE_PAGE_SIZE = 3;

export interface FakeSource {
  readonly adapter: CrmSourceAdapter;
  /** Every request the engine made, so a spec can assert the scan never wrote and the import never re-read. */
  readonly calls: { category: string; scope: string; cursor: unknown }[];
  /** Take a category away from the sign-in, to prove a permission gap never shows as an empty account. */
  denyScope(scope: string): void;
  reset(): void;
}

interface FakeRecord {
  readonly objectType: string;
  readonly objectId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly payload: Record<string, unknown>;
}

const AUSTIN = 'loc_austin';
const DALLAS = 'loc_dallas';

/** The agency, as the stand-in holds it. Exported so specs can name what they expect to arrive. */
export const FAKE_SCOPES: readonly { id: string; name: string; timezone: string }[] = [
  { id: AUSTIN, name: 'Lone Star HVAC — Austin', timezone: 'America/Chicago' },
  { id: DALLAS, name: 'Lone Star HVAC — Dallas', timezone: 'America/Chicago' },
];

const user = (
  id: string,
  first: string,
  last: string,
  email: string,
  role: string,
): FakeRecord => ({
  objectType: 'user',
  objectId: id,
  createdAt: '2024-01-04T15:00:00.000Z',
  updatedAt: '2025-06-01T12:00:00.000Z',
  payload: { id, firstName: first, lastName: last, email, roles: { type: 'account', role } },
});

const tag = (id: string, name: string): FakeRecord => ({
  objectType: 'tag',
  objectId: id,
  createdAt: '2024-02-01T10:00:00.000Z',
  updatedAt: '2024-02-01T10:00:00.000Z',
  payload: { id, name },
});

const field = (id: string, name: string, key: string, dataType: string): FakeRecord => ({
  objectType: 'custom_field',
  objectId: id,
  createdAt: '2024-02-01T10:00:00.000Z',
  updatedAt: '2024-02-01T10:00:00.000Z',
  payload: { id, name, fieldKey: key, dataType, model: 'contact', position: 1 },
});

interface ContactSeed {
  id: string;
  first: string;
  last: string;
  email?: string;
  phone?: string;
  tags?: string[];
  owner?: string;
  added: string;
  updated?: string;
  dnd?: boolean;
  fields?: { id: string; value: unknown }[];
  extra?: Record<string, unknown>;
}

const contact = (c: ContactSeed): FakeRecord => ({
  objectType: 'contact',
  objectId: c.id,
  createdAt: c.added,
  updatedAt: c.updated ?? c.added,
  payload: {
    id: c.id,
    firstName: c.first,
    lastName: c.last,
    contactName: `${c.first} ${c.last}`,
    email: c.email,
    phone: c.phone,
    tags: c.tags ?? [],
    assignedTo: c.owner,
    dateAdded: c.added,
    dateUpdated: c.updated ?? c.added,
    dnd: c.dnd ?? false,
    customFields: c.fields ?? [],
    ...(c.extra ?? {}),
  },
});

/** Austin. The 2019 dates matter: a migration that stamped today's date would fail its own history check. */
const AUSTIN_RECORDS: readonly FakeRecord[] = [
  user('usr_ana', 'Ana', 'Ruiz', 'ana@lonestarhvac.example', 'admin'),
  user('usr_dev', 'Devon', 'Clark', 'devon@lonestarhvac.example', 'user'),
  tag('tag_vip', 'VIP'),
  tag('tag_maint', 'Maintenance plan'),
  field('fld_unit', 'Unit model', 'contact.unit_model', 'TEXT'),
  field('fld_install', 'Install date', 'contact.install_date', 'DATE'),
  // A type with no home here: the promise is that it is kept and raised, not flattened and forgotten.
  field('fld_sig', 'Signed agreement', 'contact.signed_agreement', 'SIGNATURE'),
  contact({
    id: 'con_a1',
    first: 'Dave',
    last: 'Smith',
    email: 'dave.smith@example.com',
    phone: '+15125550101',
    tags: ['VIP'],
    owner: 'usr_ana',
    added: '2019-04-11T14:22:00.000Z',
    updated: '2025-08-02T09:10:00.000Z',
    fields: [{ id: 'fld_unit', value: 'Carrier 24ACC6' }],
  }),
  contact({
    id: 'con_a2',
    first: 'Maria',
    last: 'Alvarez',
    email: 'maria@example.com',
    phone: '+15125550102',
    tags: ['Maintenance plan'],
    owner: 'usr_dev',
    added: '2020-09-30T18:05:00.000Z',
  }),
  // Also in Dallas, on the same mobile: the one that proves a merge across sub-accounts works.
  contact({
    id: 'con_a3',
    first: 'Tom',
    last: 'Nguyen',
    email: 'tom@example.com',
    phone: '+15125550103',
    added: '2021-02-14T11:00:00.000Z',
  }),
  contact({
    id: 'con_a4',
    first: 'Priya',
    last: 'Patel',
    email: 'priya@example.com',
    phone: '+15125550104',
    added: '2022-07-19T16:45:00.000Z',
    dnd: true,
  }),
  contact({
    id: 'con_a5',
    first: 'Sam',
    last: 'Okafor',
    phone: '+15125550105',
    added: '2023-01-08T08:30:00.000Z',
    extra: {
      address1: '900 Congress Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
    },
  }),
];

/** Dallas. A second Dave Smith, a different person, and the email/phone conflict. */
const DALLAS_RECORDS: readonly FakeRecord[] = [
  user('usr_ana', 'Ana', 'Ruiz', 'ana@lonestarhvac.example', 'admin'),
  user('usr_kim', 'Kim', 'Bao', 'kim@lonestarhvac.example', 'user'),
  tag('tag_vip_d', 'VIP'),
  field('fld_unit_d', 'Unit model', 'contact.unit_model', 'TEXT'),
  contact({
    id: 'con_d1',
    first: 'Dave',
    last: 'Smith',
    email: 'd.smith@other.example',
    phone: '+14695550201',
    added: '2020-03-02T13:00:00.000Z',
  }),
  // The same person as Austin's con_a3, on the same number.
  contact({
    id: 'con_d2',
    first: 'Tom',
    last: 'Nguyen',
    email: 'tom.nguyen@example.com',
    phone: '+15125550103',
    added: '2021-06-21T09:15:00.000Z',
  }),
  // Email says one of ours, phone says another: always a human's decision.
  contact({
    id: 'con_d3',
    first: 'Chris',
    last: 'Doyle',
    email: 'maria@example.com',
    phone: '+15125550101',
    added: '2022-11-05T15:20:00.000Z',
  }),
  contact({
    id: 'con_d4',
    first: 'Lena',
    last: 'Fischer',
    email: 'lena@example.com',
    phone: '+14695550204',
    added: '2023-05-17T10:05:00.000Z',
  }),
];

const RECORDS: Record<string, readonly FakeRecord[]> = {
  [AUSTIN]: AUSTIN_RECORDS,
  [DALLAS]: DALLAS_RECORDS,
};

const CATEGORY_TYPE: Record<string, string> = {
  users: 'user',
  tags: 'tag',
  custom_fields: 'custom_field',
  contacts: 'contact',
  companies: 'company',
};

/** What the stand-in pretends exists but this release does not read record by record. */
const COUNTS_ONLY: Record<string, number> = {
  conversations: 412,
  messages: 5104,
  calls: 318,
  appointments: 96,
  opportunities: 74,
  pipelines: 2,
  calendars: 3,
  forms: 4,
  form_submissions: 210,
  invoices: 58,
  estimates: 22,
  subscriptions: 6,
  products: 19,
  templates: 11,
  tasks: 143,
  reviews: 37,
  media: 640,
  phone_numbers: 2,
  sending_domains: 1,
  integrations: 3,
  workflows: 17,
  websites: 1,
  funnels: 4,
};

const SCOPE_NAMES: Record<string, readonly string[]> = {
  users: ['users.readonly'],
  tags: ['tags.readonly'],
  custom_fields: ['customFields.readonly'],
  contacts: ['contacts.readonly'],
  companies: ['companies.readonly'],
};

export function createFakeSourceAdapter(): FakeSource {
  const calls: { category: string; scope: string; cursor: unknown }[] = [];
  const denied = new Set<string>();

  const supportOf = (category: string): CategorySupport => {
    const required = SCOPE_NAMES[category] ?? [];
    const missing = required.filter((s) => denied.has(s));
    const cat = migrationCategory(category);
    return {
      category,
      capability:
        missing.length > 0
          ? 'not_available'
          : cat
            ? releaseCapability(cat.release)
            : 'not_in_release',
      requiredScopes: required,
      missingScopes: missing,
      countQuality: missing.length > 0 ? 'permission_limited' : 'complete',
      incremental: category === 'contacts',
      webhooks: category === 'contacts',
      stableIds: true,
      timestamps: { created: true, updated: true, deleted: false },
    };
  };

  const adapter: CrmSourceAdapter = {
    system: 'gohighlevel',
    adapterVersion: FAKE_ADAPTER_VERSION,

    authorizeUrl: ({ state, redirectUri }) =>
      `${redirectUri}?code=fake-code&state=${encodeURIComponent(state)}`,

    async exchangeCode() {
      return {
        id: '',
        system: 'gohighlevel',
        installKind: 'agency',
        externalAccountId: 'fake-agency',
        scopes: [...new Set(Object.values(SCOPE_NAMES).flat())].filter((s) => !denied.has(s)),
        accessToken: 'fake-not-a-real-token',
        refreshToken: 'fake-not-a-real-refresh-token',
        expiresAt: new Date(Date.now() + 86_400_000),
      } satisfies SourceConnection;
    },

    async refresh(connection) {
      return { ...connection, expiresAt: new Date(Date.now() + 86_400_000) };
    },

    async discoverScopes() {
      return FAKE_SCOPES.map((s) => ({
        externalScopeId: s.id,
        name: s.name,
        timezone: s.timezone,
        descriptor: { country: 'US' },
      }));
    },

    async inspectCapabilities(): Promise<CapabilityManifest> {
      return {
        system: 'gohighlevel',
        adapterVersion: FAKE_ADAPTER_VERSION,
        categories: [
          ...Object.keys(CATEGORY_TYPE).map(supportOf),
          ...Object.keys(COUNTS_ONLY).map(supportOf),
        ],
        rateLimit: { requestsPerSecond: 100, burst: 100 },
      };
    },

    async *scan(_connection, scope) {
      for (const category of Object.keys(CATEGORY_TYPE)) {
        const support = supportOf(category);
        const cat = migrationCategory(category);
        if (support.missingScopes.length > 0) {
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
                summary: `This sign-in cannot read ${(cat?.label ?? category).toLowerCase()}.`,
                whatImports: 'Nothing from this category.',
                whatChanges:
                  'The count is unknown, not zero: we were not allowed to look, so we will not pretend there is nothing there.',
                recommendedAction: 'Sign in again and allow the extra access, then scan once more.',
                detail: { missingScopes: support.missingScopes },
              },
            ],
          } satisfies InventoryResult;
          continue;
        }
        const type = CATEGORY_TYPE[category]!;
        const count = (RECORDS[scope.externalScopeId] ?? []).filter(
          (r) => r.objectType === type,
        ).length;
        yield {
          category,
          count,
          countQuality: 'complete',
          capability: support.capability,
        } satisfies InventoryResult;
      }
      for (const [category, count] of Object.entries(COUNTS_ONLY)) {
        const cat = migrationCategory(category);
        // The stand-in's Dallas is smaller, so the two sub-accounts never look identical.
        const scaled = scope.externalScopeId === DALLAS ? Math.floor(count * 0.6) : count;
        yield {
          category,
          count: scaled,
          countQuality: 'complete',
          capability: cat ? releaseCapability(cat.release) : 'not_in_release',
          notes: cat?.releaseNote ?? null,
        } satisfies InventoryResult;
      }
    },

    async list(_connection, scope, category, options: ListOptions): Promise<SourcePage> {
      calls.push({ category, scope: scope.externalScopeId, cursor: options.cursor ?? null });
      const type = CATEGORY_TYPE[category];
      if (!type) return { records: [], cursor: null, done: true };
      if (supportOf(category).missingScopes.length > 0)
        return { records: [], cursor: null, done: true };
      const all = (RECORDS[scope.externalScopeId] ?? []).filter((r) => r.objectType === type);
      const from = Number((options.cursor as { offset?: number } | null)?.offset ?? 0);
      const size = Math.min(options.limit ?? FAKE_PAGE_SIZE, FAKE_PAGE_SIZE);
      const slice = all.slice(from, from + size);
      const records: SourceRecord[] = slice
        .filter((r) => !options.until || new Date(r.updatedAt) <= options.until)
        .filter((r) => !options.changedSince || new Date(r.updatedAt) > options.changedSince)
        .map((r) => ({
          objectType: r.objectType,
          objectId: r.objectId,
          sourceCreatedAt: new Date(r.createdAt),
          sourceUpdatedAt: new Date(r.updatedAt),
          payload: r.payload,
        }));
      const next = from + size;
      const done = next >= all.length;
      return {
        records,
        cursor: done ? null : { offset: next },
        highWaterAt: slice.length
          ? new Date(Math.max(...slice.map((r) => new Date(r.updatedAt).getTime())))
          : null,
        done,
      };
    },

    async getById(_connection, scope, objectType, objectId) {
      const r = (RECORDS[scope.externalScopeId] ?? []).find(
        (x) => x.objectType === objectType && x.objectId === objectId,
      );
      return r
        ? {
            objectType: r.objectType,
            objectId: r.objectId,
            sourceCreatedAt: new Date(r.createdAt),
            sourceUpdatedAt: new Date(r.updatedAt),
            payload: r.payload,
          }
        : null;
    },

    normalize(record, context: MappingContext): readonly CanonicalEnvelope[] {
      const p = record.payload;
      const base = {
        canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
        source: {
          system: 'gohighlevel',
          adapterVersion: FAKE_ADAPTER_VERSION,
          installationId: context.installationId,
          locationId: context.locationId,
          objectType: record.objectType,
          objectId: record.objectId,
          parentObjectId: null,
          sourceCreatedAt: record.sourceCreatedAt?.toISOString() ?? null,
          sourceUpdatedAt: record.sourceUpdatedAt?.toISOString() ?? null,
          sourceDeletedAt: null,
          retrievedAt: new Date().toISOString(),
          payloadChecksum: `fake-${record.objectId}`,
          payloadVersion: 1,
        },
        extensions: {},
        warnings: [] as CanonicalEnvelope['warnings'],
      };
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      switch (record.objectType) {
        case 'user':
          return [
            {
              ...base,
              canonicalType: 'user_identity',
              category: 'users',
              relationships: [],
              data: {
                firstName: str(p['firstName']),
                lastName: str(p['lastName']),
                email: str(p['email']),
                roleName: (p['roles'] as { role?: string } | undefined)?.role ?? null,
                active: true,
              },
            },
          ];
        case 'tag':
          return [
            {
              ...base,
              canonicalType: 'tag',
              category: 'tags',
              relationships: [],
              data: { name: str(p['name']) ?? 'Unnamed tag', color: null },
            },
          ];
        case 'custom_field': {
          const raw = str(p['dataType']) ?? '';
          const known: Record<string, string> = { TEXT: 'text', DATE: 'date', NUMERICAL: 'number' };
          const type = known[raw];
          return [
            {
              ...base,
              canonicalType: 'custom_field',
              category: 'custom_fields',
              relationships: [],
              data: {
                name: str(p['name']) ?? 'Unnamed field',
                key: str(p['fieldKey']) ?? record.objectId,
                type: type ?? 'text',
                options: [],
                required: false,
                position: Number(p['position'] ?? 0) || 0,
                appliesTo: 'contact',
              },
              extensions: type ? {} : { gohighlevel: { dataType: raw } },
              warnings: type
                ? []
                : [
                    {
                      code: 'mapping.unknown_field_type',
                      field: 'dataType',
                      message: `"${raw}" is a field type we have no match for, so it comes across as plain text and the original is kept.`,
                    },
                  ],
            },
          ];
        }
        case 'contact': {
          const relationships: CanonicalEnvelope['relationships'] = [];
          const owner = str(p['assignedTo']);
          if (owner)
            relationships.push({
              category: 'users',
              objectType: 'user',
              objectId: owner,
              role: 'owner',
              required: false,
            });
          const dnd = p['dnd'] === true;
          return [
            {
              ...base,
              canonicalType: 'contact',
              category: 'contacts',
              relationships,
              data: {
                firstName: str(p['firstName']),
                lastName: str(p['lastName']),
                fullName: str(p['contactName']),
                email: str(p['email']),
                phone: str(p['phone']),
                endpoints: [],
                address: {
                  line1: str(p['address1']),
                  city: str(p['city']),
                  state: str(p['state']),
                  postalCode: str(p['postalCode']),
                  country: str(p['country'])?.slice(0, 2) ?? null,
                },
                timezone: null,
                source: str(p['source']),
                tags: (Array.isArray(p['tags']) ? p['tags'] : []).map(String),
                customFields: Object.fromEntries(
                  (Array.isArray(p['customFields'])
                    ? (p['customFields'] as { id?: string; value?: unknown }[])
                    : []
                  )
                    .filter((f) => f.id)
                    .map((f) => [context.customFields.get(f.id!)?.key ?? f.id!, f.value]),
                ),
                consent: [
                  { channel: 'sms', state: dnd ? 'opted_out' : 'unknown' },
                  { channel: 'email', state: dnd ? 'opted_out' : 'unknown' },
                ],
              },
            },
          ];
        }
        default:
          return [];
      }
    },
  };

  return {
    adapter,
    calls,
    denyScope: (s) => denied.add(s),
    reset: () => {
      calls.length = 0;
      denied.clear();
    },
  };
}
