/**
 * Why search has no text indexes (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "How it works", 2), read from the
 * catalogue.
 *   - A person's query runs under row security, and Postgres uses an index for a condition the query adds only when
 *     that condition's function is leakproof. LIKE, ILIKE, pg_trgm's similarity, full text's `@@`, jsonb and array
 *     containment and citext's equality are not, so a GIN or trigram index would never be used for a person's
 *     search. Plain equality, ordering, `starts_with` and the timestamp comparisons are, which is what the windows
 *     on (workspace_id, time) are built from.
 *   - Supabase's `postgres` role isn't a superuser, so nothing can be marked leakproof.
 * If any of this changes, so does the reason for search's design: this fails first.
 *
 * Only the catalogue: the plans of core's own statements are tested in core (`search/plans.test.ts`), because this
 * package can't import core.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { closeAll, dbs } from './harness';

afterAll(closeAll);

const admin$ = dbs.admin.db;

/** Whether each function is leakproof, by its exact signature. */
async function leakproof(signatures: readonly string[]): Promise<Record<string, boolean | null>> {
  const found = await rows<{ signature: string; leakproof: boolean | null }>(
    admin$,
    sql`select s.signature, p.proleakproof as leakproof
        from jsonb_array_elements_text(${JSON.stringify(signatures)}::jsonb) as s(signature)
        left join pg_proc p on p.oid = to_regprocedure(s.signature)`,
  );
  return Object.fromEntries(found.map((f) => [f.signature, f.leakproof]));
}

describe('what row security lets an index serve', () => {
  it('never a text match: LIKE, ILIKE, trigrams, full text, containment or citext', async () => {
    const matches = [
      'pg_catalog.textlike(text,text)',
      'pg_catalog.texticlike(text,text)',
      'extensions.similarity_op(text,text)',
      'extensions.word_similarity_op(text,text)',
      'pg_catalog.ts_match_vq(tsvector,tsquery)',
      'pg_catalog.jsonb_contains(jsonb,jsonb)',
      'pg_catalog.arraycontains(anyarray,anyarray)',
      'extensions.citext_eq(extensions.citext,extensions.citext)',
    ];
    expect(await leakproof(matches)).toEqual(Object.fromEntries(matches.map((s) => [s, false])));
  });

  it('equality, ordering, starts_with and time: what the windows use', async () => {
    const plain = [
      'pg_catalog.texteq(text,text)',
      'pg_catalog.uuid_eq(uuid,uuid)',
      'pg_catalog.int8eq(bigint,bigint)',
      'pg_catalog.text_ge(text,text)',
      'pg_catalog.text_lt(text,text)',
      'pg_catalog.starts_with(text,text)',
      'pg_catalog.timestamptz_lt(timestamptz,timestamptz)',
      'pg_catalog.timestamptz_ge(timestamptz,timestamptz)',
    ];
    expect(await leakproof(plain)).toEqual(Object.fromEntries(plain.map((s) => [s, true])));
  });

  it('can’t be changed: Supabase’s postgres role isn’t a superuser, and only one may mark a function', async () => {
    const [role] = await rows<{ superuser: boolean }>(
      admin$,
      sql`select rolsuper as superuser from pg_roles where rolname = 'postgres'`,
    );
    expect(role!.superuser).toBe(false);
  });
});
