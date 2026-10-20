/**
 * Notes (records.read), in a window of the business's newest note lines: their words, then the name of who the note
 * is on (decision 34), ranked after the notes whose own words matched.
 *
 * A note is `NOTE_LINES` (decision 6): kind `note` with any subtype and any actor (people's own, imported ones, the
 * AI's "Call summary:"), or a call or visit with no subtype (logged by a person). Channel copies of texts, emails and
 * calls always carry a subtype and system lines are kind `system`, so a narrowed member never finds a hidden thread's
 * words through its timeline copy (gap 2). A note on a turned-off add-on's record hides with it (`RECORD_READS`);
 * row security hides one sealed to a private record, the meeting summary of a tour on a private deal included.
 */
import { sql } from 'drizzle-orm';
import type { SearchHit } from '../../../schemas/search';
import { searchHref, type SearchRecordRef } from '../../href';
import { SEARCH_WORDS } from '../../words';
import { fieldSnippet, hitOf, isoOf, stretchSnippet } from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import {
  folded,
  LIVE_PERSON,
  likeAll,
  reachOf,
  RECORD_READS,
  stretchOf,
  windowed,
  windowOf,
  type WindowRow,
} from '../sql';

/**
 * The timeline lines that are notes, for an activity aliased `a`: the same condition, word for word, as
 * `activities_notes_idx` (20261027009700_search_windows.sql), so the planner proves the partial index from it.
 */
export const NOTE_LINES = sql`(a.kind = 'note' or (a.kind in ('call', 'visit') and a.subtype is null))`;

/** How much of a note found by who it's on shows, from its start (board 2's "Gate code 4471, dog in the yard"). */
const OPENING = 120;
/** A note's title: its first line, cut to about this. */
const TITLE = 80;

/** The first `n` characters of a text, its spaces made one, with "…" when it was cut. */
function cut(text: string | null | undefined, n: number): string {
  const whole = (text ?? '').replace(/\s+/g, ' ').trim();
  return whole.length > n ? `${whole.slice(0, n).trimEnd()}…` : whole;
}

interface Row extends WindowRow {
  id: string | null;
  occurred_at: Date;
  opening: string | null;
  in_words: boolean;
  snip: string | null;
  snip_cut_before: boolean;
  snip_cut_after: boolean;
  person_id: string | null;
  person_name: string | null;
  company_id: string | null;
  company_name: string | null;
  lead_id: string | null;
  lead_title: string | null;
  record_id: string | null;
  record_name: string | null;
}

/** The record a note opens on, and its name: the customer first, then the company, the lead, the record. */
function onOf(r: Row): { ref: SearchRecordRef; name: string } | null {
  if (r.person_id) return { ref: { type: 'person', id: r.person_id }, name: r.person_name ?? '' };
  if (r.company_id)
    return { ref: { type: 'company', id: r.company_id }, name: r.company_name ?? '' };
  if (r.lead_id) return { ref: { type: 'lead', id: r.lead_id }, name: r.lead_title ?? '' };
  if (r.record_id)
    return { ref: { type: 'custom_record', id: r.record_id }, name: r.record_name ?? '' };
  return null;
}

function hitFrom(r: Row, plan: SearchPlan): SearchHit | null {
  const on = onOf(r);
  // A note on a customer in the bin, or on nothing that reads, has nowhere to open.
  if (!on || !r.id) return null;
  const opening = cut(r.opening, OPENING);
  const snippet = r.in_words
    ? stretchSnippet(r.snip, { before: r.snip_cut_before, after: r.snip_cut_after }, plan.p)
    : opening
      ? (fieldSnippet(opening, plan.p) ?? { text: opening, marks: [] })
      : null;
  return hitOf({
    kind: 'notes',
    id: r.id,
    // Its first line; the line under it says who it's on ("Note on Dana Smith · Oct 18").
    title: cut(r.opening?.split('\n')[0], TITLE) || SEARCH_WORDS.untitledNote,
    href: searchHref(plan.workspaceId, { type: 'activity', id: r.id, on: on.ref }),
    tier: 4,
    why: { field: r.in_words ? 'note' : 'customer', label: null, snippet, page: null },
    at: isoOf(r.occurred_at),
    facts: on.name.trim() ? { on: on.name.trim() } : {},
  });
}

export const notesSearcher: KindSearcher = {
  key: 'notes',
  async find(db, plan) {
    const { p } = plan;
    if (plan.archivedOnly || !p.likes.length)
      return [{ kind: 'notes', label: null, icon: null, hits: [] }];
    const w = windowOf(plan, 'notes');
    // A call or visit logged with no words has no body: false, never null, which `desc` would put first.
    const inBody = sql`coalesce(${likeAll(sql`lower(a.body)`, p.likes)}, false)`;
    const list = await db.rows<Row>(
      windowed(
        w,
        sql`select a.occurred_at as at from app.activities a
            where a.workspace_id = ${plan.workspaceId} and ${NOTE_LINES}
              ${w.before ? sql`and a.occurred_at <= ${w.before}::timestamptz` : sql``}
            order by a.occurred_at desc, a.id desc`,
        (inWindow) =>
          sql`select a.id, a.occurred_at, ${inBody} as in_words, substr(a.body, 1, 200) as opening,
                ${stretchOf(sql`a.body`, p.words[0] ?? null, 'snip')},
                p.id as person_id, nullif(concat_ws(' ', p.first_name, p.last_name), '') as person_name,
                co.id as company_id, co.name as company_name, l.id as lead_id, l.title as lead_title,
                r.id as record_id, r.name as record_name
              from app.activities a
              -- Who it's on, each read by its key for the lines that have one (offset 0 keeps them lookups,
              -- not joins over every customer).
              left join lateral (
                select p.id, p.first_name, p.last_name from app.people p
                where p.id = a.person_id and ${LIVE_PERSON('p')} offset 0) p on true
              left join lateral (
                select co.id, co.name from app.companies co where co.id = a.company_id offset 0) co on true
              left join lateral (select l.id, l.title from app.leads l where l.id = a.lead_id offset 0) l on true
              left join lateral (
                select r.id, r.name from app.custom_records r where r.id = a.custom_record_id offset 0) r on true
              where a.workspace_id = ${plan.workspaceId} and ${NOTE_LINES} and ${inWindow(sql`a.occurred_at`)}
                and ${RECORD_READS(sql`a.custom_record_id`)}
                and (${inBody}
                  -- Decision 34: the name of who it's on, folded (decision 23), ranked after the notes whose own
                  -- words matched.
                  or ${likeAll(folded(sql`concat_ws(' ', p.first_name, p.last_name, co.name, l.title, r.name)`), p.folds)})
                ${plan.onlyMine && plan.me ? sql`and a.author_user_id = ${plan.me}` : sql``}
              order by ${plan.sort === 'recent' || plan.sort === 'name' ? sql`` : sql`${inBody} desc,`} a.occurred_at desc, a.id desc
              limit ${plan.limit}`,
      ),
    );
    return [
      {
        kind: 'notes',
        label: null,
        icon: null,
        hits: list.map((r) => hitFrom(r, plan)).filter((h): h is SearchHit => !!h),
        ...reachOf(list),
      },
    ];
  },
};
