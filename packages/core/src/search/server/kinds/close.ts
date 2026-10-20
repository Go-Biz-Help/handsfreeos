/**
 * Close matches (records.read, decision 26): only when nothing else matched, no setting did on the device, and a
 * typed word has 4 or more letters. The database takes up to 300 contact, company, lead and record names that look
 * roughly alike (trigrams, `similarity` or `word_similarity` over the folded name); core's `closeMatches` keeps those
 * within an edit or two of the words, close on every word first. Contacts are held to `LIVE_PERSON`: row security still
 * shows a customer in the bin, and a misspelt name must not lead a member to them. With chips picked, only those kinds
 * are read; their own page (`search.kind` with `close`) reads every one, a page at a time.
 */
import { sql } from 'drizzle-orm';
import { closeMatches } from '../../close';
import { searchHref, type SearchRecordRef } from '../../href';
import { SEARCH_WORDS } from '../../words';
import { hitOf, isoOf } from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import { LIVE_PERSON, textArray } from '../sql';

/** Names the database hands over to be checked. */
const CLOSE_ROWS = 300;
/** How alike a name must look to be checked at all: low, so a swapped letter in each word still gets through. */
const SIMILAR = 0.08;
const WORD_SIMILAR = 0.15;

interface Row extends Record<string, unknown> {
  kind: 'contacts' | 'companies' | 'leads' | 'records';
  id: string;
  name: string;
  type_key: string | null;
  updated_at: Date;
}

const REF: Record<Row['kind'], SearchRecordRef['type']> = {
  contacts: 'person',
  companies: 'company',
  leads: 'lead',
  records: 'custom_record',
};

/** Only mine, for each kind as its own searcher reads it. */
function mineOf(plan: SearchPlan, kind: Row['kind']) {
  if (!plan.onlyMine || !plan.me) return sql``;
  const me = plan.me;
  switch (kind) {
    case 'contacts':
      return sql`and (p.owner_user_id = ${me} or p.team_user_ids @> array[${me}::uuid])`;
    case 'companies':
      return sql`and (c.owner_user_id = ${me} or c.team_user_ids @> array[${me}::uuid])`;
    case 'leads':
      return sql`and l.assignee_user_id = ${me}`;
    case 'records':
      return sql`and (case when r.kept_to_team
                  then (r.owner_user_id = ${me} or r.team_user_ids @> array[${me}::uuid])
                  else r.created_by = ${me} end)`;
  }
}

/**
 * The kinds the chips asked for, as close matches read them: every one with no chips, and on close matches' own page
 * (`search.kind` with `close`, the Search page's "Show more" and "See all"); otherwise only those picked, and of the
 * business's own kinds only the ones picked by name (`record.pets`), or all of them for `records`.
 */
function askedOf(plan: SearchPlan): {
  kinds: ReadonlySet<Row['kind']>;
  recordKeys: string[] | null;
} {
  if (!plan.kinds || plan.kinds.has('close'))
    return { kinds: new Set(['contacts', 'companies', 'leads', 'records']), recordKeys: null };
  const recordKeys = [...plan.kinds].filter((k) => k.startsWith('record.')).map((k) => k.slice(7));
  const kinds = new Set<Row['kind']>(
    (['contacts', 'companies', 'leads'] as const).filter((k) => plan.kinds!.has(k)),
  );
  if (recordKeys.length || plan.kinds.has('records')) kinds.add('records');
  return { kinds, recordKeys: plan.kinds.has('records') || !recordKeys.length ? null : recordKeys };
}

export const closeSearcher: KindSearcher = {
  key: 'close',
  async find(db, plan) {
    const typed = plan.p.folded.join(' ');
    const asked = askedOf(plan);
    const alike = (
      name: ReturnType<typeof sql>,
    ) => sql`(extensions.similarity(${name}, ${typed}) > ${SIMILAR}
      or extensions.word_similarity(${typed}, ${name}) > ${WORD_SIMILAR})`;
    const score = (name: ReturnType<typeof sql>) =>
      sql`greatest(extensions.similarity(${name}, ${typed}), extensions.word_similarity(${typed}, ${name}))`;
    const arms: Record<Row['kind'], ReturnType<typeof sql>> = {
      contacts: sql`select 'contacts' as kind, p.id, concat_ws(' ', p.first_name, p.last_name) as name,
              null::text as type_key, p.updated_at, ${score(sql`f.fname`)} as score
            from app.people p
            cross join lateral (
              select private.search_fold(concat_ws(' ', p.first_name, p.last_name)) as fname offset 0) f
            where p.workspace_id = ${plan.workspaceId} and ${LIVE_PERSON('p')} and p.archived_at is null
              and ${alike(sql`f.fname`)} ${mineOf(plan, 'contacts')}`,
      companies: sql`select 'companies' as kind, c.id, c.name, null::text as type_key, c.updated_at,
              ${score(sql`f.fname`)} as score
            from app.companies c
            cross join lateral (select private.search_fold(c.name) as fname offset 0) f
            where c.workspace_id = ${plan.workspaceId} and c.archived_at is null
              and ${alike(sql`f.fname`)} ${mineOf(plan, 'companies')}`,
      leads: sql`select 'leads' as kind, l.id, l.title as name, null::text as type_key, l.updated_at,
              ${score(sql`f.fname`)} as score
            from app.leads l
            cross join lateral (select private.search_fold(l.title) as fname offset 0) f
            where l.workspace_id = ${plan.workspaceId} and l.archived_at is null
              and ${alike(sql`f.fname`)} ${mineOf(plan, 'leads')}`,
      records: sql`select 'records' as kind, r.id, r.name, t.key as type_key, r.updated_at,
              ${score(sql`f.fname`)} as score
            from app.custom_records r
            join app.custom_record_types t on t.id = r.type_id and t.archived_at is null
              ${asked.recordKeys ? sql`and t.key = any(${textArray(asked.recordKeys)})` : sql``}
            cross join lateral (select private.search_fold(r.name) as fname offset 0) f
            where r.workspace_id = ${plan.workspaceId} and r.archived_at is null and r.purged_at is null
              and ${alike(sql`f.fname`)} ${mineOf(plan, 'records')}`,
    };
    const union = (Object.keys(arms) as Row['kind'][])
      .filter((k) => asked.kinds.has(k))
      .map((k) => arms[k]);
    if (!union.length) return [];
    const list = await db.rows<Row>(
      sql`select * from (${sql.join(union, sql` union all `)}) x
          order by x.score desc, x.updated_at desc
          limit ${CLOSE_ROWS}`,
    );
    const close = closeMatches(list, (r) => r.name, plan.p.folded);
    return [
      {
        kind: 'close',
        label: null,
        icon: null,
        hits: close.map((r) =>
          hitOf({
            kind: r.kind === 'records' ? `record.${r.type_key}` : r.kind,
            id: r.id,
            title: r.name.trim() || SEARCH_WORDS.noName,
            href: searchHref(plan.workspaceId, { type: REF[r.kind], id: r.id }),
            tier: 5,
            why: { field: 'close', label: null, snippet: null, page: null },
            at: isoOf(r.updated_at),
          }),
        ),
      },
    ];
  },
};
