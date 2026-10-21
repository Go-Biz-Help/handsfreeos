/**
 * Files (records.read): their names, folded, across the whole business; and the words read inside them (Search 5),
 * in a window of the files with words read most recently, ranked after the names. Only files that are ready and not deleted;
 * never port papers, which hold the losing carrier's account number and PIN (decision 24), and never knowledge files,
 * whose words are knowledge items. Row security hides a file sealed to a private record and one in the bin, and a
 * file's words with it (`file_texts_select`); a file on a turned-off add-on's record hides with it, as the storage
 * read rule says. A result opens its record's Files tab with the file ringed, a PDF at the page its words are on.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { SearchHit } from '../../../schemas/search';
import { foldPattern } from '../../fold';
import { searchHref, type SearchRecordRef } from '../../href';
import { searchTerms } from '../../probes';
import { tierOf } from '../../rank';
import { hitOf, isoOf, stretchSnippet } from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import {
  LIVE_PERSON,
  likeAll,
  reachOf,
  startsAll,
  stretchAt,
  uuidArray,
  windowed,
  windowOf,
  type WindowRow,
} from '../sql';

type OnType = 'person' | 'company' | 'lead' | 'custom_record';

interface Row extends Record<string, unknown> {
  id: string | null;
  name: string;
  record_type: OnType;
  record_id: string;
  created_at: Date;
  on_name: string | null;
  on_reads: boolean;
}

interface FactRow extends Record<string, unknown> {
  id: string;
  record_type: OnType;
  record_id: string;
  mime_type: string | null;
  page: number | null;
  snip: string | null;
  snip_cut_before: boolean;
  snip_cut_after: boolean;
}

/**
 * Files search may show, for a file aliased `f`: ready, not deleted, no port papers or knowledge files, and on a record
 * of the business's own kinds only when that record reads.
 */
export const SEARCHABLE_FILE = sql`(f.status = 'ready' and f.deleted_at is null
  and f.record_type not in ('port', 'knowledge')
  and (f.record_type <> 'custom_record' or exists (select 1 from app.custom_records rr where rr.id = f.record_id)))`;

/**
 * Words read inside a file that hold any, for its words aliased `t`: a photo, a voice note or a file too big has a row
 * with none, which would take a place in the window. `file_texts_recent_idx` is partial on exactly this, and it's used
 * because this repeats its condition word for word, as `NOTE_LINES` does.
 */
export const WITH_WORDS = sql`t.chars > 0`;

/**
 * A search's words (`$tsq`, from `searchProbes`) as a query over a file's words. Postgres's parser splits a few words
 * further than core does, "65e8m" into the number 65e8 and m, and `to_tsquery` makes those a phrase, which never
 * matches words kept without their places: so every `<->` is made `&`. A lexeme holds only letters and digits, so
 * `<->` is only ever the operator.
 */
export const wordsQuery = (tsq: SQL | string): SQL =>
  sql`replace(to_tsquery('simple'::regconfig, ${tsq})::text, '<->', '&')::tsquery`;

/**
 * Who a file is on, for a file aliased `f`: its record read by its key, for the files on one (offset 0 keeps each a
 * lookup, not a join over every customer), and whether that record still reads.
 */
const ON = {
  columns: sql`case f.record_type
      when 'person' then nullif(concat_ws(' ', p.first_name, p.last_name), '')
      when 'company' then c.name
      when 'lead' then l.title
      else r.name end as on_name,
    coalesce(p.id, c.id, l.id, r.id) is not null as on_reads`,
  joins: sql`left join lateral (
        select p.id, p.first_name, p.last_name from app.people p
        where f.record_type = 'person' and p.id = f.record_id and ${LIVE_PERSON('p')} offset 0) p on true
      left join lateral (
        select c.id, c.name from app.companies c
        where f.record_type = 'company' and c.id = f.record_id offset 0) c on true
      left join lateral (
        select l.id, l.title from app.leads l where f.record_type = 'lead' and l.id = f.record_id offset 0) l on true
      left join lateral (
        select r.id, r.name from app.custom_records r
        where f.record_type = 'custom_record' and r.id = f.record_id offset 0) r on true`,
};

/** The longest word typed, as a file's words are split: the likeliest to land on the place they matched. */
function longestTerm(typed: string): string | null {
  return searchTerms(typed).reduce<string | null>(
    (best, t) => (best === null || t.length > best.length ? t : best),
    null,
  );
}

/**
 * Where a typed word starts in a file's words, as they matched: at the start of a word, never inside one ("test" not
 * in "latest"), and a number past any leading zeros ("142" at "0142"), since words are kept without them.
 */
export function termPattern(term: string): string {
  return `(?<![[:alnum:]])${/^[0-9]/.test(term) ? '0*' : ''}${foldPattern(term)}`;
}

function hitFrom(r: Row, plan: SearchPlan, inWords: boolean): SearchHit | null {
  // A file on a customer in the bin, erased or merged away has nowhere to open.
  if (!r.on_reads || !r.id) return null;
  const on: SearchRecordRef = { type: r.record_type, id: r.record_id };
  return hitOf({
    kind: 'files',
    id: r.id,
    title: r.name,
    href: searchHref(plan.workspaceId, { type: 'file', id: r.id, on }),
    // Found by its words, it's words in content (tier 4); its snippet and page come with the facts.
    tier: inWords ? 4 : (tierOf(r.name, plan.p) ?? 2),
    why: { field: inWords ? 'file_text' : 'file_name', label: null, snippet: null, page: null },
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
    const mine = plan.onlyMine && plan.me ? sql`and f.created_by = ${plan.me}` : sql``;
    const order =
      plan.sort === 'name'
        ? sql`lower(f.name), f.id`
        : plan.sort === 'recent'
          ? sql`f.created_at desc, f.id desc`
          : null;

    // Names, across the business. Look further back moves only the window of words: every name was read the first
    // time.
    const startsArm = startsAll(sql`fn.fname`, p.starts);
    const named = plan.before
      ? []
      : await db.rows<Row>(
          sql`select f.id, f.name, f.record_type::text as record_type, f.record_id, f.created_at,
                case when ${startsArm} then 1 else 2 end as tier, ${ON.columns}
              from app.files f
              cross join lateral (select private.search_fold(f.name) as fname offset 0) fn
              ${ON.joins}
              where f.workspace_id = ${plan.workspaceId} and ${SEARCHABLE_FILE}
                and ${likeAll(sql`fn.fname`, p.folds)}
                ${mine}
              order by ${order ?? sql`tier, f.created_at desc, f.id`}
              limit ${plan.limit}`,
        );
    const hits = named.map((r) => hitFrom(r, plan, false)).filter((h): h is SearchHit => !!h);
    const tsq = p.tsq;
    if (!tsq) return [{ kind: 'files', label: null, icon: null, hits }];

    // The words inside, in a window of the files read most recently that hold any: the stored words against the
    // search split the same way (`$tsq`), so "1042", "0142" and "smith" match in a file as they do everywhere else.
    const w = windowOf(plan, 'fileWords');
    const inside = await db.rows<Row & WindowRow>(
      windowed(
        w,
        sql`select t.extracted_at as at from app.file_texts t
            where t.workspace_id = ${plan.workspaceId} and ${WITH_WORDS}
              ${w.before ? sql`and t.extracted_at <= ${w.before}::timestamptz` : sql``}
            order by t.extracted_at desc`,
        (inWindow) =>
          sql`select f.id, f.name, f.record_type::text as record_type, f.record_id, f.created_at, ${ON.columns}
              from app.file_texts t
              join app.files f on f.id = t.file_id
              ${ON.joins}
              where t.workspace_id = ${plan.workspaceId} and ${WITH_WORDS}
                and ${inWindow(sql`t.extracted_at`)}
                and t.words @@ ${wordsQuery(tsq)}
                and ${SEARCHABLE_FILE}
                ${mine}
              order by ${order ?? sql`f.created_at desc, f.id desc`}
              limit ${plan.limit}`,
      ),
    );
    // A file its name found too is shown once, as its name found it.
    const byName = new Set(hits.map((h) => h.id));
    for (const r of inside) {
      if (r.id && byName.has(r.id)) continue;
      const hit = hitFrom(r, plan, true);
      if (hit) hits.push(hit);
    }
    return [{ kind: 'files', label: null, icon: null, hits, ...reachOf(inside) }];
  },

  /**
   * For the files shown that their words found: a stretch of those words around the longest typed word, and the page
   * (a PDF's) or sheet (a workbook's) it's on, when the file has more than one. The word is found with `foldPattern`
   * rather than by folding the whole text, which costs about 2.4 µs a character once the text holds an accent.
   */
  async facts(db, plan, hits) {
    const inWords = hits.filter((h) => h.why.field === 'file_text');
    if (!inWords.length) return [...hits];
    const term = longestTerm(plan.p.q);
    const at = term ? sql`regexp_instr(t.text, ${termPattern(term)}, 1, 1, 0, 'i')` : sql`0`;
    const found = await db.rows<FactRow>(
      sql`select t.file_id as id, f.record_type::text as record_type, f.record_id, f.mime_type,
            -- Each page's start, counted from 0, against the word's, counted from 1.
            case when cardinality(t.pages) > 1 and m.at > 0
              then (select count(*) from unnest(t.pages) s where s < m.at)::int end as page,
            ${stretchAt(sql`t.text`, sql`m.at`, 'snip')}
          from app.file_texts t
          join app.files f on f.id = t.file_id
          cross join lateral (select ${at} as at offset 0) m
          where t.file_id = any(${uuidArray(inWords.map((h) => h.id))})`,
    );
    const byId = new Map(found.map((r) => [r.id, r]));
    return hits.map((h) => {
      const r = h.why.field === 'file_text' ? byId.get(h.id) : undefined;
      if (!r) return h;
      const page = r.page === null ? null : Number(r.page);
      const on: SearchRecordRef = { type: r.record_type, id: r.record_id };
      return {
        ...h,
        // A PDF opens at its page; a workbook's sheet is only said.
        href: searchHref(plan.workspaceId, {
          type: 'file',
          id: h.id,
          on,
          page: r.mime_type === 'application/pdf' ? page : null,
        }),
        why: {
          ...h.why,
          snippet: stretchSnippet(
            r.snip,
            { before: r.snip_cut_before, after: r.snip_cut_after },
            plan.p,
          ),
          page,
        },
      };
    });
  },
};
