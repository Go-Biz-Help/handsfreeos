import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, isPgEnum } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index';
import { tables } from '../src/schema/index';
import { closeAll, dbs } from './harness';
import { rows, sql } from '../src/client';

afterAll(closeAll);

describe('Drizzle enums mirror the live enums', () => {
  // `app` holds tenant data, `platform` HandsFreeOS's own support desk (0070); both are mirrored here.
  it('every app and platform enum has a Drizzle mirror with the same values, in order', async () => {
    const live = await rows<{ name: string; labels: string[] }>(
      dbs.admin.db,
      sql`select t.typname::text as name, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
          from pg_type t join pg_enum e on e.enumtypid = t.oid
          where t.typnamespace in ('app'::regnamespace, 'platform'::regnamespace)
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

/** Core's money arithmetic, loaded by path for the same reason: pure, with no imports of its own. */
const totalsFile = fileURLToPath(new URL('../../core/src/money/totals.ts', import.meta.url));

describe('generated columns mirror core', () => {
  /**
   * The balance is worked out in three places — the generated column, its Drizzle mirror and core's
   * `balanceCents` — and a customer's page, the reminder job and Home read different ones. So all three are
   * run over the cases that matter, rather than their SQL compared as text: unpaid, part paid, paid, refunded
   * in part and in full, part paid then given back, and an overpayment given back a bit at a time.
   */
  it('app.invoices.balance_cents is core’s balanceCents, in the database and in the mirror', async () => {
    const { balanceCents } = (await import(/* @vite-ignore */ totalsFile)) as {
      balanceCents: (total: number, paid: number, refunded: number) => number;
    };
    const cases: [number, number, number][] = [
      [45000, 0, 0],
      [45000, 20000, 0],
      [45000, 45000, 0],
      [45000, 45000, 5000],
      [45000, 45000, 45000],
      [45000, 15000, 15000],
      [45000, 50000, 0],
      [45000, 50000, 2000],
      [45000, 50000, 5000],
      [45000, 50000, 20000],
      [45000, 50000, 50000],
      [0, 0, 0],
    ];
    const values = sql.join(
      cases.map(([t, p, r], i) => sql`(${i}::int, ${t}::bigint, ${p}::bigint, ${r}::bigint)`),
      sql`, `,
    );
    const evaluate = async (expression: ReturnType<typeof sql>) =>
      (
        await rows<{ balance: string }>(
          dbs.admin.db,
          sql`select (${expression})::text as balance
              from (values ${values}) as v(i, total_cents, amount_paid_cents, amount_refunded_cents)
              order by v.i`,
        )
      ).map((r) => Number(r.balance));
    const [live] = await rows<{ expression: string }>(
      dbs.admin.db,
      sql`select generation_expression as expression from information_schema.columns
          where table_schema = 'app' and table_name = 'invoices' and column_name = 'balance_cents'`,
    );
    const mirror = getTableColumns(schema.invoices).balanceCents.generated?.as;
    expect(live?.expression).toBeTruthy();
    expect(mirror).toBeTruthy();
    const expected = cases.map(([t, p, r]) => balanceCents(t, p, r));
    expect(await evaluate(sql.raw(live!.expression))).toEqual(expected);
    expect(await evaluate(mirror as ReturnType<typeof sql>)).toEqual(expected);
  });
});

describe('Drizzle schema mirrors the live schema', () => {
  for (const [key, table] of Object.entries(tables)) {
    const schemaName = getTableConfig(table).schema ?? 'public';
    it(`${schemaName}.${getTableName(table)} (${key}) has exactly the columns Drizzle declares`, async () => {
      const live = await rows<{ column_name: string }>(
        dbs.admin.db,
        sql`select column_name from information_schema.columns where table_schema = ${schemaName} and table_name = ${getTableName(table)} order by 1`,
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
