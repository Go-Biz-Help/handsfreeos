import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { isPgEnum } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index';
import { tables } from '../src/schema/index';
import { closeAll, dbs } from './harness';
import { rows, sql } from '../src/client';

afterAll(closeAll);

describe('Drizzle enums mirror the live app enums', () => {
  it('every app enum has a Drizzle mirror with the same values, in order', async () => {
    const live = await rows<{ name: string; labels: string[] }>(
      dbs.admin.db,
      sql`select t.typname::text as name, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
          from pg_type t join pg_enum e on e.enumtypid = t.oid
          where t.typnamespace = 'app'::regnamespace
          group by t.typname`,
    );
    const declared = Object.values(schema as Record<string, unknown>)
      .filter(isPgEnum)
      .map((e) => [e.enumName, [...e.enumValues]]);
    expect(Object.fromEntries(declared)).toEqual(
      Object.fromEntries(live.map((e) => [e.name, e.labels])),
    );
  });
});

/**
 * Core's attention kinds. @hfos/db can't depend on @hfos/core (core depends on db), so the file is loaded by
 * path. It is browser-safe, with no runtime imports.
 */
const attentionKindsFile = fileURLToPath(
  new URL('../../core/src/attention/kinds.ts', import.meta.url),
);

describe('check constraints mirror core', () => {
  // Skipped (not failed) only while core's kinds file doesn't exist yet.
  it.skipIf(!existsSync(attentionKindsFile))(
    'attention_items.kind allows exactly core’s ATTENTION_KINDS',
    async () => {
      const { ATTENTION_KINDS } = (await import(/* @vite-ignore */ attentionKindsFile)) as {
        ATTENTION_KINDS: readonly string[];
      };
      const [check] = await rows<{ def: string }>(
        dbs.admin.db,
        sql`select pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = 'app.attention_items'::regclass and conname = 'attention_items_kind_check'`,
      );
      const live = [...(check?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
      expect(live.length).toBeGreaterThan(0);
      expect(new Set(live).size).toBe(live.length);
      expect([...live].sort()).toEqual([...ATTENTION_KINDS].sort());
    },
  );
});

describe('Drizzle schema mirrors the live app schema', () => {
  for (const [key, table] of Object.entries(tables)) {
    it(`app.${getTableName(table)} (${key}) has exactly the columns Drizzle declares`, async () => {
      const live = await rows<{ column_name: string }>(
        dbs.admin.db,
        sql`select column_name from information_schema.columns where table_schema = 'app' and table_name = ${getTableName(table)} order by 1`,
      );
      const liveNames = live.map((r) => r.column_name).sort();
      const declared = Object.values(getTableColumns(table))
        .map((c) => c.name)
        .sort();
      expect(liveNames.length).toBeGreaterThan(0);
      expect(declared).toEqual(liveNames);
    });
  }
});
