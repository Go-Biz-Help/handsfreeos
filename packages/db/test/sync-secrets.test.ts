/**
 * 0057 and apps/sync: nothing secret reaches PowerSync, and nothing a phone mustn't have reaches a phone.
 *   - The `powersync` publication is exactly the tables phones need, listed by name (never all tables or a schema),
 *     and no published table has a column that holds a secret. (PowerSync's first copy of a table ignores column
 *     lists, so a published table's every column reaches its storage.)
 *   - hfos_sync may read those tables and nothing else: no other table, no column grants, no other schema, no roles.
 *   - apps/sync/sync-config.yaml selects only published tables, names columns that exist, never a generated column,
 *     never an identifier phones don't need, and the same columns for a table wherever it appears. Its stream names
 *     carry a version, and every published table is used.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { closeAll, dbs } from './harness';
import { identifiersOf, readSyncConfig } from './sync-config';

afterAll(closeAll);

const admin$ = dbs.admin.db;

/** What phones need (plan: "How much is on the phone"), and so what may be published and read by hfos_sync. */
const PUBLISHED = [
  'activities',
  // Round six: what an add-on's phones keep (records_v1).
  'addon_phone_rows',
  'custom_record_types',
  'custom_records',
  'sync_keys',
  // Their links (20261022000700).
  'relationship_types',
  'relationships',
  // A person's own check-ins and safety contacts (20261022001000).
  'safety_checkins',
  'safety_contacts',
  // The business's booking site and who has the portal (20261022001100).
  'booking_sites',
  'portal_access',
  'ai_teammate_drafts',
  'ai_teammates',
  'appointment_attendees',
  'appointment_staff',
  'appointments',
  'attention_items',
  'calendar_busy_blocks',
  'calendar_members',
  'calendar_services',
  'calendars',
  'calls',
  'command_receipts',
  'companies',
  'conversations',
  'email_addresses',
  'email_suppressions',
  'estimate_lines',
  'estimates',
  'files',
  'form_versions',
  'forms',
  'invoice_lines',
  'invoices',
  'jobs',
  'leads',
  'messages',
  'opt_outs',
  'organization_memberships',
  'organizations',
  'payments',
  'people',
  'phone_numbers',
  'pipeline_stages',
  'pipelines',
  'plans',
  'products',
  'push_devices',
  'record_tags',
  'refunds',
  'schedule_exceptions',
  'schedules',
  'service_staff',
  'services',
  'subscriptions',
  'tags',
  'tasks',
  'user_phones',
  'users',
  'workflow_approvals',
  'workspace_access',
  'workspace_memberships',
  'workspaces',
].sort();

/** Column names that hold a secret: sealed tokens and their key ids, sign-in state, token hashes, keyed hashes. */
const SECRET_COLUMN =
  /(_enc$|secret|password|pkce|oauth_state|token_hash|_hmac$|(^|_)key_id$|^token$|client_state)/;

/** The tables whose columns hold one today: none may ever be published. */
const SECRET_TABLES = [
  // Real Estate round five: an add-on's key at another service (a listing feed), sealed. No phone ever needs it.
  'addon_connections',
  'calendar_connections',
  'chat_visitors',
  // M15: a half-finished answer sheet keeps the hash of the key that reopens it.
  'form_responses',
  // M14 slice B: a connected app's key is kept only as its hash, and no phone ever needs it.
  'intake_sources',
  'invitations',
  'mailbox_connections',
  'migration_connections',
  'payment_connections',
  // Real Estate round two: a client's signed-in device, kept only as its bearer's hash. No phone ever needs it.
  'portal_sessions',
  // M16: the sign-in to a Google Business Profile or a Facebook Page. No phone ever needs it.
  'review_connections',
  // Round six: a safety contact's link to a missed check-out, kept only as its token's hash. No phone needs it.
  'safety_escalations',
  'telephony_accounts',
  // A Twilio account a business connected to bring its numbers in: its auth token or API key secret, sealed.
  'twilio_connections',
  // 20261018000300: a link for a customer to send a video is kept only as its token's hash.
  'video_links',
  'workflow_webhooks',
];

/**
 * Columns of published tables that no stream may select: identifiers that aren't secrets but that no phone needs
 * (reply tokens, provider ids and card tokens, idempotency keys, customer-link references, raw email), the sync
 * bookkeeping itself, and the generated columns (which arrive empty after any update).
 */
const NEVER_SELECTED = new Set([
  'email_reply_token',
  'ai_epoch',
  'ai_answered_through',
  'method_token',
  'customer_ref',
  'external_subscription_id',
  'idempotency_key',
  'provider_payment_id',
  'provider_refund_id',
  'provider_status',
  'provider_sid',
  'provider_message_id',
  'provider_thread_id',
  'dedupe_key',
  'message_id_header',
  'in_reply_to_header',
  'references_headers',
  'body_html',
  'mailbox_connection_id',
  'connection_id',
  'account_id',
  'routing',
  'recording_sid',
  'recording_object_path',
  'public_ref',
  'link_version',
  'pay_version',
  'manage_version',
  'accepted_hash',
  'accepted_wording',
  'reminder_state',
  'input_hash',
  'expo_push_token',
  'fingerprint',
  'alert_fingerprint',
  'import_id',
  'import_row',
  'member_viewer_ids',
  'member_workspace_ids',
  'member_organization_ids',
  'sync_window',
]);

const liveColumns = async () => {
  const cols = await rows<{ table_name: string; column_name: string; is_generated: string }>(
    admin$,
    sql`select table_name, column_name, is_generated from information_schema.columns where table_schema = 'app'`,
  );
  const byTable = new Map<string, Map<string, boolean>>();
  for (const c of cols) {
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, new Map());
    byTable.get(c.table_name)!.set(c.column_name, c.is_generated === 'ALWAYS');
  }
  return byTable;
};

describe('the powersync publication', () => {
  it('is exactly the tables phones need, listed by name, publishing every change', async () => {
    const [pub] = await rows<{
      all: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
      tru: boolean;
      schemas: number;
    }>(
      admin$,
      sql`select p.puballtables as all, p.pubinsert as ins, p.pubupdate as upd, p.pubdelete as del, p.pubtruncate as tru,
            (select count(*)::int from pg_publication_namespace n where n.pnpubid = p.oid) as schemas
          from pg_publication p where p.pubname = 'powersync'`,
    );
    expect(pub).toEqual({ all: false, ins: true, upd: true, del: true, tru: true, schemas: 0 });
    const tables = await rows<{ schemaname: string; tablename: string }>(
      admin$,
      sql`select schemaname, tablename from pg_publication_tables where pubname = 'powersync' order by tablename`,
    );
    expect(tables.every((t) => t.schemaname === 'app')).toBe(true);
    expect(tables.map((t) => t.tablename)).toEqual(PUBLISHED);
  });

  it('has no table with a secret column, and never a table that holds one', async () => {
    const byTable = await liveColumns();
    const holding = [...byTable.entries()]
      .filter(([, cols]) => [...cols.keys()].some((c) => SECRET_COLUMN.test(c)))
      .map(([t]) => t)
      .sort();
    // The pattern bites: it finds exactly the tables known to hold secrets.
    expect(holding).toEqual(SECRET_TABLES);
    for (const table of PUBLISHED)
      expect(
        [...byTable.get(table)!.keys()].filter((c) => SECRET_COLUMN.test(c)),
        table,
      ).toEqual([]);
  });
});

describe('the hfos_sync role', () => {
  it('replicates, bypasses RLS and can do nothing else', async () => {
    const [role] = await rows<Record<string, boolean>>(
      admin$,
      sql`select rolcanlogin, rolreplication, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole, rolinherit
          from pg_roles where rolname = 'hfos_sync'`,
    );
    expect(role).toEqual({
      rolcanlogin: true,
      rolreplication: true,
      rolbypassrls: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
    });
    const [memberships] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from pg_auth_members where member = 'hfos_sync'::regrole`,
    );
    expect(memberships!.n).toBe(0);
  });

  it('reads the published tables, only with SELECT, and no other table, column or schema', async () => {
    const grants = await rows<{ table_schema: string; table_name: string; privilege_type: string }>(
      admin$,
      sql`select table_schema, table_name, privilege_type from information_schema.role_table_grants
          where grantee = 'hfos_sync' order by table_name, privilege_type`,
    );
    expect(grants.every((g) => g.table_schema === 'app' && g.privilege_type === 'SELECT')).toBe(
      true,
    );
    expect(grants.map((g) => g.table_name)).toEqual(PUBLISHED);

    // Whatever PUBLIC or anyone else was granted, it can't read another app table.
    const readable = await rows<{ relname: string }>(
      admin$,
      sql`select c.relname from pg_class c
          where c.relnamespace = 'app'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
            and has_table_privilege('hfos_sync', c.oid, 'select')
          order by c.relname`,
    );
    expect(readable.map((r) => r.relname)).toEqual(PUBLISHED);
    const [columnGrants] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from pg_attribute a join pg_class c on c.oid = a.attrelid
          where a.attacl is not null and exists (select 1 from aclexplode(a.attacl) x where x.grantee = 'hfos_sync'::regrole)`,
    );
    expect(columnGrants!.n).toBe(0);
    const [schemas] = await rows<{
      app: boolean;
      private: boolean;
      auth: boolean;
      storage: boolean;
    }>(
      admin$,
      sql`select has_schema_privilege('hfos_sync', 'app', 'usage') as app, has_schema_privilege('hfos_sync', 'private', 'usage') as private,
            has_schema_privilege('hfos_sync', 'auth', 'usage') as auth, has_schema_privilege('hfos_sync', 'storage', 'usage') as storage`,
    );
    expect(schemas).toEqual({ app: true, private: false, auth: false, storage: false });
  });
});

// ---------- apps/sync/sync-config.yaml ----------

describe('apps/sync/sync-config.yaml', () => {
  const { streams, queries } = readSyncConfig();
  const cteNames = new Set(queries.filter((q) => q.cte).map((q) => q.name!));

  it('is read whole', () => {
    expect(streams.length).toBeGreaterThanOrEqual(3);
    expect(queries.filter((q) => !q.cte).length).toBeGreaterThan(40);
    expect(
      streams.every((s) => /_v[0-9]+$/.test(s)),
      streams.join(', '),
    ).toBe(true);
  });

  it('reads only published tables, and uses every one', () => {
    for (const q of queries) expect(PUBLISHED, `${q.stream}: ${q.table}`).toContain(q.table);
    expect([...new Set(queries.map((q) => q.table))].sort()).toEqual(PUBLISHED);
  });

  it('names columns that exist, never a generated one, and nothing phones mustn’t have', async () => {
    const byTable = await liveColumns();
    for (const q of queries) {
      const cols = byTable.get(q.table)!;
      for (const [output, sources] of q.select) {
        expect(sources.length, `${q.stream} ${q.table}.${output}`).toBeGreaterThan(0);
        for (const source of sources) {
          expect(cols.has(source), `${q.stream}: ${q.table}.${source} exists`).toBe(true);
          expect(cols.get(source), `${q.stream}: ${q.table}.${source} is generated`).toBe(false);
          expect(
            NEVER_SELECTED.has(source),
            `${q.stream}: ${q.table}.${source} is never selected`,
          ).toBe(false);
          expect(SECRET_COLUMN.test(source), `${q.stream}: ${q.table}.${source}`).toBe(false);
        }
      }
      // Its filters read real columns too (the bookkeeping columns among them).
      for (const ident of identifiersOf(q.where).filter((i) => !cteNames.has(i)))
        expect(cols.has(ident), `${q.stream}: ${q.table} filters on ${ident}`).toBe(true);
    }
  });

  it('selects the same columns for a client table wherever it appears', () => {
    const shapes = new Map<string, string>();
    for (const q of queries.filter((x) => !x.cte)) {
      const shape = [...q.select.keys()].join(',');
      const seen = shapes.get(q.output);
      if (seen === undefined) shapes.set(q.output, shape);
      else expect(shape, `${q.output} in ${q.stream}`).toBe(seen);
    }
    // Every client table has an id.
    for (const [output, shape] of shapes) expect(shape.split(','), output).toContain('id');
  });
});

describe('apps/sync/service.yaml', () => {
  it('takes every connection string and token from the environment', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../../../apps/sync/service.yaml', import.meta.url)),
      'utf8',
    );
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
    for (const key of ['uri', 'jwks_uri', 'sslmode'])
      for (const m of text.matchAll(new RegExp(`^\\s*${key}: (.+)$`, 'gm')))
        expect(m[1], key).toMatch(/^!env [A-Z_]+/);
    expect(text).toMatch(/tokens:\n\s+- !env PS_ADMIN_TOKEN/);
  });
});
