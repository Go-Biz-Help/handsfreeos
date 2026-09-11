import { getTableColumns, getTableName } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { tables } from '../src/schema/index';
import { closeAll, dbs } from './harness';
import { rows, sql } from '../src/client';

afterAll(closeAll);

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
