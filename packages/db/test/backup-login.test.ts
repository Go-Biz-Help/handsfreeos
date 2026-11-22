/**
 * 20261027032200: the hfos_backup login behind the nightly copy outside Supabase (.github/workflows/backup.yml).
 *   - It reads every table, past RLS, so pg_dump can copy the whole database, auth and storage included.
 *   - It can change nothing: its only role is pg_read_all_data, it holds no grants of its own, and its sessions
 *     start read-only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { closeAll, dbs } from './harness';

afterAll(closeAll);

const admin$ = dbs.admin.db;

describe('the hfos_backup role', () => {
  it('signs in, bypasses RLS, and has no other power', async () => {
    const [role] = await rows<Record<string, boolean | number>>(
      admin$,
      sql`select rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolinherit, rolconnlimit
          from pg_roles where rolname = 'hfos_backup'`,
    );
    expect(role).toEqual({
      rolcanlogin: true,
      rolbypassrls: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolinherit: true,
      rolconnlimit: 2,
    });
  });

  it('belongs to pg_read_all_data and nothing else', async () => {
    const memberships = await rows<{ rolname: string }>(
      admin$,
      sql`select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid
          where m.member = 'hfos_backup'::regrole order by r.rolname`,
    );
    expect(memberships.map((m) => m.rolname)).toEqual(['pg_read_all_data']);
    const [grants] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from information_schema.role_table_grants where grantee = 'hfos_backup'`,
    );
    expect(grants!.n).toBe(0);
  });

  it('reads the tables a restore needs', async () => {
    const [can] = await rows<Record<string, boolean>>(
      admin$,
      sql`select has_table_privilege('hfos_backup', 'app.workspaces', 'select') as workspaces,
                 has_table_privilege('hfos_backup', 'app.messages', 'select') as messages,
                 has_table_privilege('hfos_backup', 'auth.users', 'select') as users,
                 has_table_privilege('hfos_backup', 'storage.objects', 'select') as objects,
                 has_table_privilege('hfos_backup', 'supabase_migrations.schema_migrations', 'select') as migrations`,
    );
    expect(can).toEqual({
      workspaces: true,
      messages: true,
      users: true,
      objects: true,
      migrations: true,
    });
  });

  it('can write to no table in any schema', async () => {
    const writable = await rows<{ name: string }>(
      admin$,
      sql`select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
            and (has_table_privilege('hfos_backup', c.oid, 'insert') or has_table_privilege('hfos_backup', c.oid, 'update')
              or has_table_privilege('hfos_backup', c.oid, 'delete') or has_table_privilege('hfos_backup', c.oid, 'truncate'))
          order by 1`,
    );
    expect(writable).toEqual([]);
  });

  it('starts every session read-only', async () => {
    const settings = await rows<{ setting: string }>(
      admin$,
      sql`select unnest(setconfig) as setting from pg_db_role_setting
          where setrole = 'hfos_backup'::regrole and setdatabase = 0`,
    );
    expect(settings.map((s) => s.setting)).toEqual(['default_transaction_read_only=on']);
  });
});
