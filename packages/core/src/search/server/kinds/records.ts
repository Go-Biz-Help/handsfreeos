/**
 * A business's own kinds of records (records.read): a group each (`record.<key>`, with its plural and icon), found by
 * the folded name or anything in its fields. Row security hides a turned-off add-on's kinds and private records, so a
 * kind that doesn't read answers no group at all; and the bin's own rule hides a record in the bin. The line under a
 * winner, and which of its fields matched, come from the business's field definitions.
 */
import { sql } from 'drizzle-orm';
import { customSummary } from '../../../crm/custom-fields';
import { fieldsByKind } from '../../../relationships/store';
import type { SearchHit } from '../../../schemas/search';
import { searchHref } from '../../href';
import { tierOf } from '../../rank';
import { fieldSnippet, hitOf, holdsAny, isoOf } from '../hit';
import type { FoundGroup, KindSearcher, SearchPlan } from '../run';
import { archivedRule, likeAll, startsAll, textArray, uuidArray } from '../sql';

interface TypeRow extends Record<string, unknown> {
  id: string;
  key: string;
  plural: string;
  icon: string;
  addon_id: string | null;
}

interface Row extends Record<string, unknown> {
  id: string;
  type_id: string;
  name: string;
  archived_at: Date | null;
  updated_at: Date;
}

/** The kinds of record asked for, by key, or null for every one. */
function keysAsked(plan: SearchPlan): string[] | null {
  if (!plan.kinds) return null;
  const keys = [...plan.kinds].filter((k) => k.startsWith('record.')).map((k) => k.slice(7));
  return keys.length ? keys : plan.kinds.has('records') ? null : [];
}

function hitFrom(r: Row, t: TypeRow, plan: SearchPlan): SearchHit {
  const tier = tierOf(r.name, plan.p);
  return hitOf({
    kind: `record.${t.key}`,
    id: r.id,
    title: r.name,
    href: searchHref(plan.workspaceId, { type: 'custom_record', id: r.id }),
    tier: tier ?? 3,
    why: { field: tier ? 'name' : 'field', label: null, snippet: null, page: null },
    badges: r.archived_at ? ['archived'] : [],
    at: isoOf(r.updated_at),
    facts: r.archived_at ? { archivedAt: isoOf(r.archived_at)! } : {},
  });
}

export const recordsSearcher: KindSearcher = {
  key: 'records',
  async find(db, plan) {
    const { p } = plan;
    const keys = keysAsked(plan);
    if (keys && keys.length === 0) return [];
    const types = await db.rows<TypeRow>(
      sql`select t.id, t.key, t.plural, t.icon, t.addon_id from app.custom_record_types t
          where t.workspace_id = ${plan.workspaceId} and t.archived_at is null
            ${keys ? sql`and t.key = any(${textArray(keys)})` : sql``}
          order by t.position, t.plural`,
    );
    if (!types.length) return [];
    const startsArm = startsAll(sql`f.fname`, p.starts);
    const foldsArm = likeAll(sql`f.fname`, p.folds);
    const byName = sql`(${startsArm} or ${foldsArm})`;
    const tier = sql`(case when ${startsArm} then 1 when ${foldsArm} then 2 else 3 end)`;
    const order =
      plan.sort === 'name'
        ? sql`lower(r.name), r.id`
        : plan.sort === 'recent'
          ? sql`r.updated_at desc, r.id desc`
          : sql`(r.archived_at is not null), ${tier}, r.updated_at desc, r.id`;
    const mine =
      plan.onlyMine && plan.me
        ? sql`and (case when r.kept_to_team
                  then (r.owner_user_id = ${plan.me} or r.team_user_ids @> array[${plan.me}::uuid])
                  else r.created_by = ${plan.me} end)`
        : sql``;
    const list = await db.rows<Row>(
      sql`select x.id, x.type_id, x.name, x.archived_at, x.updated_at from (
            select r.id, r.type_id, r.name, r.archived_at, r.updated_at,
              row_number() over (partition by r.type_id order by ${order}) as n
            from app.custom_records r
            cross join lateral (select private.search_fold(r.name) as fname offset 0) f
            where r.workspace_id = ${plan.workspaceId}
              and r.type_id = any(${uuidArray(types.map((t) => t.id))})
              and r.purged_at is null
              and (${likeAll(sql`r.search_text`, p.likes)} or ${byName})
              and ${archivedRule(plan, sql`r.archived_at`, byName)}
              ${mine}
          ) x
          where x.n <= ${plan.limit}
          order by x.type_id, x.n`,
    );
    const byType = new Map<string, Row[]>();
    for (const r of list) byType.set(r.type_id, [...(byType.get(r.type_id) ?? []), r]);
    // Every kind asked for by name answers a group, empty or not, so a kind's own page can tell gone from empty.
    return types
      .filter((t) => keys || byType.has(t.id))
      .map((t): FoundGroup => ({
        kind: `record.${t.key}`,
        label: t.plural,
        icon: t.icon,
        addon: t.addon_id,
        hits: (byType.get(t.id) ?? []).map((r) => hitFrom(r, t, plan)),
      }));
  },

  async facts(db, plan, hits) {
    const rowsRead = await db.rows<{
      id: string;
      type_id: string;
      custom: Record<string, unknown> | null;
    }>(
      sql`select r.id, r.type_id, r.custom from app.custom_records r
          where r.id = any(${uuidArray(hits.map((h) => h.id))})`,
    );
    const fields = await db.run((sp) =>
      fieldsByKind(
        sp,
        plan.workspaceId,
        rowsRead.map((r) => r.type_id),
      ),
    );
    const byId = new Map(rowsRead.map((r) => [r.id, r]));
    return hits.map((h) => {
      const r = byId.get(h.id);
      if (!r) return h;
      const own = fields.get(r.type_id) ?? [];
      const custom = r.custom ?? {};
      let why = h.why;
      if (why.field === 'field') {
        const field = own.find((f) => holdsAny(String(custom[f.id] ?? ''), plan.p));
        if (field)
          why = {
            ...why,
            label: field.label,
            snippet: fieldSnippet(String(custom[field.id]), plan.p),
          };
      }
      return { ...h, why, subtitle: customSummary(own, custom) };
    });
  },
};
