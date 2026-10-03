/**
 * What a person's phone holds of Real Estate, read the way the phone gets it, for the tests that hold the phone's views
 * to the server's queries (realestate-phone-*.test.ts): the rows records_v1 and business_v1 send them, as text the way
 * PowerSync stores it.
 */
import { rows, sql } from '@hfos/db/client';
import { testDbs, type TestUser } from '@hfos/db/testing';
import {
  realestateCopyOf,
  type RealestateCopy,
  type RealestateSource,
} from '../../src/addons/realestate/views/synced';

const admin = () => testDbs().admin.db;

/** A cell as the phone keeps it: text, 0/1, or nothing; arrays and JSON as JSON text; times as PowerSync writes them. */
export function cell(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().replace('T', ' ');
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number;
}
export const cells = <T extends Record<string, unknown>>(list: T[]) =>
  list.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)])));

/** What `u`'s phone holds of Real Estate, read the way its screens read it. */
export async function phoneCopy(u: TestUser, ws: string): Promise<RealestateCopy> {
  return realestateCopyOf(await phoneRows(u, ws));
}

/**
 * The rows records_v1 sends `u` (apps/sync/sync-config.yaml): by their keys and the seals, as PowerSync filters them,
 * not by row security, which lets an owner read more than their phone keeps. Customers, companies and names come
 * from business_v1, which sends a business's people to everyone in it.
 */
export async function phoneRows(u: TestUser, ws: string): Promise<RealestateSource> {
  const keys = await rows<{ kind: string; key: string }>(
    admin(),
    sql`select kind, key from app.sync_keys where user_id = ${u.id} and workspace_id = ${ws}`,
  );
  const use = `{${keys
    .filter((k) => k.kind === 'use')
    .map((k) => `"${k.key}"`)
    .join(',')}}`;
  const all = `{${keys
    .filter((k) => k.kind === 'all')
    .map((k) => `"${k.key}"`)
    .join(',')}}`;
  /** records_v1's three arms for a record, a link or one of the add-on's rows. */
  const sealed = (t: string) =>
    sql.raw(`((${t}.seal_scope = any('${use}'::text[]) and ${t}.seal_open)
      or ${t}.seal_all = any('${all}'::text[])
      or (${t}.seal_scope = any('${use}'::text[]) and '${u.id}'::uuid = any(${t}.seal_viewer_ids)))
      and ${t}.sync_window`);
  /** What hangs off a private record: to its people. */
  const toItsPeople = (t: string) =>
    sql.raw(`${t}.sealed and ${t}.seal_scope = any('${use}'::text[])
      and '${u.id}'::uuid = any(${t}.seal_viewer_ids)`);
  const db = admin();
  return {
    records: cells(
      await rows(
        db,
        sql`select r.id, r.name, r.notes, r.archived_at, r.owner_user_id, r.team_user_ids, r.updated_at
            from app.custom_records r join app.custom_record_types t on t.id = r.type_id
            where r.workspace_id = ${ws} and t.key = 'realestate_deal' and ${sealed('r')}`,
      ),
    ),
    rows: cells(
      await rows(
        db,
        sql`select p.id, p.source, p.record_id, p.data from app.addon_phone_rows p
            where p.workspace_id = ${ws} and p.addon_id = 'realestate' and ${sealed('p')}`,
      ),
    ),
    links: cells(
      await rows(
        db,
        sql`select l.id, t.addon_id, t.addon_key, t.position, l.a_person_id, l.a_company_id, l.a_custom_record_id,
              l.b_custom_record_id, l.note, l.created_at
            from app.relationships l join app.relationship_types t on t.id = l.type_id
            where l.workspace_id = ${ws} and ${sealed('l')}
              and t.seal_scope = any(${use}::text[])`,
      ),
    ),
    people: cells(
      await rows(
        db,
        sql`select id, first_name, last_name, email from app.people where workspace_id = ${ws}`,
      ),
    ),
    companies: cells(
      await rows(
        db,
        sql`select id, name, email, phone from app.companies where workspace_id = ${ws}`,
      ),
    ),
    files: cells(
      await rows(
        db,
        sql`select f.id, f.name, f.locked_at from app.files f
            where f.workspace_id = ${ws} and f.deleted_at is null and ${toItsPeople('f')}`,
      ),
    ),
    appointments: cells(
      await rows(
        db,
        sql`select a.id, a.title, a.starts_at from app.appointments a
            where a.workspace_id = ${ws} and ${toItsPeople('a')}`,
      ),
    ),
    users: cells(
      await rows(
        db,
        sql`select u.id, u.full_name, u.email from app.users u
            join app.workspace_memberships m on m.user_id = u.id where m.workspace_id = ${ws}`,
      ),
    ),
    recordNames: cells(
      await rows(
        db,
        sql`select r.id, r.name from app.custom_records r where r.workspace_id = ${ws} and ${sealed('r')}`,
      ),
    ),
  } as unknown as RealestateSource;
}
