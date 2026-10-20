/**
 * The Deleted bin (records.delete, decision 8): each item by its name and nothing inside, newest first, leaving out
 * what is being emptied now. Row security on `bin_items` asks for the same permission, so under a staff view-as it
 * comes back empty. A result opens Settings → Deleted bin with the item ringed.
 */
import { sql } from 'drizzle-orm';
import { binKindLabel } from '../../../bin-words';
import type { BinContents, BinKind } from '../../../schemas/bin';
import { searchHref } from '../../href';
import { tierOf } from '../../rank';
import { hitOf, isoOf } from '../hit';
import type { KindSearcher } from '../run';
import { likeAll } from '../sql';

interface Row extends Record<string, unknown> {
  id: string;
  kind: BinKind;
  name: string;
  contents: BinContents | null;
  deleted_at: Date;
  purge_after: Date;
}

export const binSearcher: KindSearcher = {
  key: 'bin',
  async find(db, plan) {
    if (plan.archivedOnly) return [{ kind: 'bin', label: null, icon: null, hits: [] }];
    const list = await db.rows<Row>(
      sql`select b.id, b.kind, b.name, b.contents, b.deleted_at, b.purge_after from app.bin_items b
          where b.workspace_id = ${plan.workspaceId} and b.purging_since is null
            and ${likeAll(sql`private.search_fold(b.name)`, plan.p.folds)}
            ${plan.onlyMine && plan.me ? sql`and b.deleted_by = ${plan.me}` : sql``}
          order by b.deleted_at desc, b.id desc
          limit ${plan.limit}`,
    );
    return [
      {
        kind: 'bin',
        label: null,
        icon: null,
        hits: list.map((r) =>
          hitOf({
            kind: 'bin',
            id: r.id,
            title: r.name,
            subtitle: binKindLabel({ kind: r.kind, contents: r.contents ?? {} }),
            href: searchHref(plan.workspaceId, { type: 'bin', id: r.id }),
            tier: tierOf(r.name, plan.p) ?? 2,
            at: isoOf(r.deleted_at),
            facts: { deletedAt: isoOf(r.deleted_at)!, purgeAfter: isoOf(r.purge_after)! },
          }),
        ),
      },
    ];
  },
};
