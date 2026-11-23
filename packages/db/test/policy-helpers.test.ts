/**
 * The functions row security calls keep their plan (speed audit, Nov 2026; migration 20261027035400), read from the
 * catalogue.
 *   - A `language sql` function that can't be inlined is parsed and planned again by every statement that calls it,
 *     and none of ours can be: each runs as its owner or pins its search_path. A policy calls its helpers from every
 *     statement on its table, so a person's small read spent about 0.6 ms of its 0.75 ms planning "which businesses
 *     is this person in?".
 *   - A `language plpgsql` function keeps its plan for the life of the database connection.
 * So a function a policy reaches, straight or through another helper, is written in plpgsql. A new one written in sql
 * fails here by name. Write it the way the migration did: `return <expression>;` for one value, `return (select …);`
 * for one value from a select that gives one row, `return query select …;` for rows, and the same
 * `stable security definer set search_path = ''`.
 *
 * What each helper answers is the security suites' to hold (rls.test.ts and the rest of this folder): they pass
 * unchanged over the plpgsql helpers.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { closeAll, dbs } from './harness';

afterAll(closeAll);

const admin$ = dbs.admin.db;

/** Our own functions that a policy reaches, with the language each is written in. */
async function reached(): Promise<{ fn: string; language: string; depth: number }[]> {
  return rows<{ fn: string; language: string; depth: number }>(
    admin$,
    sql`with recursive fn as (
          select p.oid, n.nspname, p.proname, l.lanname, p.prosrc
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          join pg_language l on l.oid = p.prolang
          where p.prokind = 'f'
            and (n.nspname in ('app', 'platform', 'private', 'portal', 'public') or n.nspname like 'addon\\_%')
        ), policies as (
          select string_agg(
            coalesce(pg_get_expr(polqual, polrelid), '') || ' ' || coalesce(pg_get_expr(polwithcheck, polrelid), ''),
            ' ') as said
          from pg_policy
        ), reach as (
          select f.oid, 0 as depth from fn f, policies p
          where p.said like '%' || f.nspname || '.' || f.proname || '(%'
          union
          select g.oid, r.depth + 1 from reach r
          join fn f on f.oid = r.oid
          join fn g on f.prosrc like '%' || g.nspname || '.' || g.proname || '(%'
          where r.depth < 8
        )
        select f.oid::regprocedure::text as fn, f.lanname as language, min(r.depth)::int as depth
        from reach r join fn f on f.oid = r.oid
        group by f.oid, f.lanname
        order by 1`,
  );
}

describe('the functions row security calls', () => {
  it('are found: the helpers every policy leans on, and the ones those call', async () => {
    const found = (await reached()).map((f) => f.fn);
    // Straight from a policy, and one, two helpers down.
    expect(found).toEqual(
      expect.arrayContaining([
        'private.accessible_workspace_ids()',
        'private.workspaces_with_permission(text)',
        'private.has_permission(uuid,text)',
        'private.system_scope_workspace()',
        'portal.person()',
        'private.user_has_permission(uuid,uuid,text)',
        'private.founder_acting_workspace_of(uuid)',
      ]),
    );
    expect(found.length).toBeGreaterThanOrEqual(79);
  });

  it('keep their plan: none is written in sql', async () => {
    const inSql = (await reached()).filter((f) => f.language === 'sql').map((f) => f.fn);
    expect(
      inSql,
      'A policy reaches these, so each statement on a protected table plans them again. Write them in plpgsql.',
    ).toEqual([]);
  });
});
