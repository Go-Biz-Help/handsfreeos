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
