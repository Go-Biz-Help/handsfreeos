/**
 * The capacity guard (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How it works, 2): each searcher's real statement,
 * explained as a signed-in owner under row security, reads its table through a btree index on the business, never a
 * scan of every business's rows. Here rather than in `packages/db`, because these are core's own statements.
 *
 * A small business picks a Seq Scan, or a bitmap scan on another index and a sort, whatever indexes exist, so both
 * are turned off first (stage 1's Built note): what's left is whether an index can serve the statement at all. And a
 * row's name is folded once, not once an arm: an accented name costs about 40 µs a fold. Search 3 adds the windows
 * (messages, threads, notes, form answers) as their searchers arrive.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchProbes } from '../../src/search/probes';
import { SEARCHERS } from '../../src/search/server/kinds/index';
import type { SearchDb, SearchPlan } from '../../src/search/server/run';
import { human } from '../calendar-helpers';
import { searchWorld, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await searchWorld('search-plans');
});
afterAll(closeTestDbs);

/** Every statement a searcher runs for `q`, explained, as the owner; each also runs, so the next one is real. */
async function plansOf(key: string, q: string, verbose = false): Promise<string> {
  const searcher = SEARCHERS.find((s) => s.key === key)!;
  return asUser(testDbs().api.db, w.owner.claims, async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    await tx.execute(sql`set local enable_bitmapscan = off`);
    const [me] = await rows<{ permissions: string[] }>(
      tx,
      sql`select private.my_permissions(${w.wsId}) as permissions`,
    );
    const explained: string[] = [];
    const db: SearchDb = {
      async rows<T extends Record<string, unknown>>(query: ReturnType<typeof sql>) {
        const plan = await rows<{ 'QUERY PLAN': string }>(
          tx,
          verbose ? sql`explain (costs off, verbose) ${query}` : sql`explain (costs off) ${query}`,
        );
        explained.push(plan.map((r) => r['QUERY PLAN']).join('\n'));
        return rows<T>(tx, query);
      },
      run: (fn) => fn(tx),
    };
    const plan: SearchPlan = {
      ctx: {
        tx,
        actor: human(w.owner),
        scope: {
          workspaceId: w.wsId,
          organizationId: w.orgId,
          workspaceRole: 'owner',
          workspacePermissions: me!.permissions,
          orgRole: null,
        },
        meta: { correlationId: randomUUID(), channel: 'test' },
      },
      workspaceId: w.wsId,
      me: w.owner.id,
      p: searchProbes(q),
      mode: 'everything',
      perKind: 3,
      limit: 101,
      sort: 'best',
      includeArchived: false,
      archivedOnly: false,
      onlyMine: false,
      before: null,
      kinds: null,
      can: () => true,
    };
    await searcher.find(db, plan);
    return explained.join('\n---\n');
  });
}

const indexScan = (table: string, index?: string) =>
  new RegExp(`Index (Only )?Scan( Backward)? using ${index ?? '\\w+'} on ${table}\\b`);

describe('the statements search runs', () => {
  it('read contacts through a btree on the business', async () => {
    const plan = await plansOf('contacts', 'smith');
    // people_workspace_idx, or people_workspace_updated_idx when the order by recency makes it cheaper: both lead
    // with the business.
    expect(plan).toMatch(
      indexScan('people', '(people_workspace_idx|people_workspace_updated_idx)'),
    );
    expect(plan).toMatch(/Index Cond: \(workspace_id = '[0-9a-f-]+'::uuid\)/);
    expect(plan).not.toMatch(/Seq Scan on people\b/);
  });

  it('read companies, leads and records through an index on the business', async () => {
    const companies = await plansOf('companies', 'smith');
    expect(companies).toMatch(indexScan('companies', 'companies_workspace_idx'));
    expect(companies).not.toMatch(/Seq Scan on companies\b/);
    const leads = await plansOf('leads', 'smith');
    expect(leads).toMatch(indexScan('leads'));
    expect(leads).not.toMatch(/Seq Scan on leads\b/);
    const records = await plansOf('records', 'smith');
    expect(records).toMatch(indexScan('custom_records'));
    expect(records).not.toMatch(/Seq Scan on custom_records\b/);
  });

  it('read money through indexes on the business, never every business’s bills', async () => {
    const money = await plansOf('money', 'smith');
    for (const table of ['invoices', 'estimates', 'payments']) {
      expect(money, table).toMatch(indexScan(table));
      expect(money, table).not.toMatch(new RegExp(`Seq Scan on ${table}\\b`));
    }
  });

  it('fold each name once a row, however many arms read it', async () => {
    // `private.search_fold` is worked out inline, so each fold is one `octet_length(<name>)` in the verbose plan.
    for (const [key, name] of [
      ['contacts', "concat_ws(' '::text, p.first_name, p.last_name)"],
      ['companies', 'c.name'],
      ['leads', 'l.title'],
      ['records', 'r.name'],
    ] as const) {
      const plan = await plansOf(key, 'josé gar', true);
      expect(plan.split(`octet_length(${name})`).length - 1, key).toBe(1);
    }
  });

  it('read the bin through bin_items_list_idx, and close matches through each table’s index', async () => {
    const bin = await plansOf('bin', 'smith');
    expect(bin).toMatch(indexScan('bin_items', 'bin_items_list_idx'));
    const close = await plansOf('close', 'dnaa smtih');
    for (const table of ['people', 'companies', 'leads', 'custom_records']) {
      expect(close, table).toMatch(indexScan(table));
      expect(close, table).not.toMatch(new RegExp(`Seq Scan on ${table}\\b`));
    }
  });
});
