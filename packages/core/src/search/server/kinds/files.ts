/**
 * Files (records.read): their names, folded, across the whole business; the words inside them come with Search 5.
 * Only files that are ready and not deleted; never port papers, which hold the losing carrier's account number and PIN
 * (decision 24), and never knowledge files, whose words are knowledge items. Row security hides a file sealed to a
 * private record and one in the bin; a file on a turned-off add-on's record hides with it, as the storage read rule
 * says. A result opens its record's Files tab with the file ringed.
 */
import { sql } from 'drizzle-orm';
import type { SearchHit } from '../../../schemas/search';
import { searchHref, type SearchRecordRef } from '../../href';
import { tierOf } from '../../rank';
import { hitOf, isoOf } from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import { LIVE_PERSON, likeAll, startsAll } from '../sql';

interface Row extends Record<string, unknown> {
  id: string;
  name: string;
  record_type: 'person' | 'company' | 'lead' | 'custom_record';
  record_id: string;
  created_at: Date;
  on_name: string | null;
  on_reads: boolean;
}

/**
 * Files search may show, for a file aliased `f`: ready, not deleted, no port papers or knowledge files, and on a record
 * of the business's own kinds only when that record reads.
 */
export const SEARCHABLE_FILE = sql`(f.status = 'ready' and f.deleted_at is null
  and f.record_type not in ('port', 'knowledge')
  and (f.record_type <> 'custom_record' or exists (select 1 from app.custom_records rr where rr.id = f.record_id)))`;

function hitFrom(r: Row, plan: SearchPlan): SearchHit | null {
  // A file on a customer in the bin, erased or merged away has nowhere to open.
  if (!r.on_reads) return null;
  const on: SearchRecordRef = { type: r.record_type, id: r.record_id };
  return hitOf({
    kind: 'files',
    id: r.id,
    title: r.name,
    href: searchHref(plan.workspaceId, { type: 'file', id: r.id, on }),
    tier: tierOf(r.name, plan.p) ?? 2,
    why: { field: 'file_name', label: null, snippet: null, page: null },
    at: isoOf(r.created_at),
    facts: r.on_name?.trim() ? { on: r.on_name.trim() } : {},
  });
}

export const filesSearcher: KindSearcher = {
  key: 'files',
  async find(db, plan) {
    const { p } = plan;
    // Files aren't archived; the Archived page has nothing here.
    if (plan.archivedOnly) return [{ kind: 'files', label: null, icon: null, hits: [] }];
    const startsArm = startsAll(sql`fn.fname`, p.starts);
    const tier = sql`case when ${startsArm} then 1 else 2 end`;
    const order =
      plan.sort === 'name'
        ? sql`lower(f.name), f.id`
        : plan.sort === 'recent'
          ? sql`f.created_at desc, f.id desc`
          : sql`tier, f.created_at desc, f.id`;
    const list = await db.rows<Row>(
      sql`select f.id, f.name, f.record_type::text as record_type, f.record_id, f.created_at, ${tier} as tier,
            case f.record_type
              when 'person' then nullif(concat_ws(' ', p.first_name, p.last_name), '')
              when 'company' then c.name
              when 'lead' then l.title
              else r.name end as on_name,
            case f.record_type
              when 'person' then p.id is not null
              when 'company' then c.id is not null
              when 'lead' then l.id is not null
              else r.id is not null end as on_reads
          from app.files f
          cross join lateral (select private.search_fold(f.name) as fname offset 0) fn
          left join app.people p on f.record_type = 'person' and p.id = f.record_id and ${LIVE_PERSON('p')}
          left join app.companies c on f.record_type = 'company' and c.id = f.record_id
          left join app.leads l on f.record_type = 'lead' and l.id = f.record_id
          left join app.custom_records r on f.record_type = 'custom_record' and r.id = f.record_id
          where f.workspace_id = ${plan.workspaceId} and ${SEARCHABLE_FILE}
            and ${likeAll(sql`fn.fname`, p.folds)}
            ${plan.onlyMine && plan.me ? sql`and f.created_by = ${plan.me}` : sql``}
          order by ${order}
          limit ${plan.limit}`,
    );
    return [
      {
        kind: 'files',
        label: null,
        icon: null,
        hits: list.map((r) => hitFrom(r, plan)).filter((h): h is SearchHit => !!h),
      },
    ];
  },
};
