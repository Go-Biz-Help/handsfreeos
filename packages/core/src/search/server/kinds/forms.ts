/**
 * Forms (workspace.read): forms by their folded name, across the whole business (archived ones go under Archived);
 * and, in a window of the business's newest answers, the answers of completed responses, then the name of who
 * answered (decision 34), ranked after the answers whose own words matched. One row per response, its best answer
 * as the snippet with its question.
 *
 * A response in the Deleted bin takes its answers with it (`form_answers_follow_response`, and the join to a response
 * that still reads); a payment answer shows only to someone who may see money. Nobody owns an answer, so Only mine
 * leaves answers out. A response opens on its form's Results.
 */
import { sql } from 'drizzle-orm';
import type { SearchHit } from '../../../schemas/search';
import { searchHref } from '../../href';
import { tierOf } from '../../rank';
import { fieldSnippet, hitOf, isoOf, stretchSnippet } from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import {
  archivedRule,
  folded,
  LIVE_PERSON,
  likeAll,
  reachOf,
  startsAll,
  stretchOf,
  windowed,
  windowOf,
  type WindowRow,
} from '../sql';

interface FormRow extends Record<string, unknown> {
  id: string;
  name: string;
  archived_at: Date | null;
  updated_at: Date;
}

interface AnswerRow extends WindowRow {
  response_id: string | null;
  form_id: string;
  form_name: string;
  question_title: string;
  answered_at: Date;
  in_words: boolean;
  /** Who answered, when they're a live customer; null for one merged away, in the bin or erased, and for nobody. */
  person_id: string | null;
  person_name: string | null;
  /** Nobody said who they were. */
  anonymous: boolean;
  snip: string | null;
  snip_cut_before: boolean;
  snip_cut_after: boolean;
}

/**
 * An answer's words, as they're matched and shown: the choices picked, else what was typed. A choice's labels are in
 * `text_value` too (forms/submit.ts), so they're read once, as `form.response` reads them.
 */
const ANSWER_TEXT = sql`coalesce(nullif(array_to_string(fa.choice_labels, ', '), ''), fa.text_value)`;

function formHit(r: FormRow, plan: SearchPlan): SearchHit {
  return hitOf({
    kind: 'forms',
    id: r.id,
    title: r.name,
    href: searchHref(plan.workspaceId, { type: 'form', id: r.id }),
    tier: tierOf(r.name, plan.p) ?? 2,
    why: { field: 'form_name', label: null, snippet: null, page: null },
    badges: r.archived_at ? ['archived'] : [],
    at: isoOf(r.updated_at),
    facts: r.archived_at ? { archivedAt: isoOf(r.archived_at)! } : {},
  });
}

function answerHit(r: AnswerRow, plan: SearchPlan): SearchHit {
  const snippet = stretchSnippet(
    r.snip,
    { before: r.snip_cut_before, after: r.snip_cut_after },
    plan.p,
  );
  return hitOf({
    kind: 'forms',
    id: r.response_id!,
    title: r.form_name,
    href: searchHref(plan.workspaceId, {
      type: 'form_response',
      formId: r.form_id,
      id: r.response_id!,
    }),
    tier: 4,
    why: {
      field: r.in_words ? 'answer' : 'customer',
      label: null,
      // Found by who answered, their first answer, marked where it holds the words, if it does.
      snippet: r.in_words ? snippet : snippet && (fieldSnippet(snippet.text, plan.p) ?? snippet),
      page: null,
    },
    badges: r.anonymous ? ['anonymous'] : [],
    at: isoOf(r.answered_at),
    contact: r.person_id ? { personId: r.person_id, phoneE164: null, email: null } : null,
    facts: { answeredBy: r.person_name?.trim() || null, question: r.question_title },
  });
}

export const formsSearcher: KindSearcher = {
  key: 'forms',
  async find(db, plan) {
    const { p } = plan;
    const byName = sql`(${startsAll(sql`fn.fname`, p.starts)} or ${likeAll(sql`fn.fname`, p.folds)})`;
    const order =
      plan.sort === 'name'
        ? sql`lower(f.name), f.id`
        : plan.sort === 'recent'
          ? sql`f.updated_at desc, f.id desc`
          : sql`(f.archived_at is not null), (case when ${startsAll(sql`fn.fname`, p.starts)} then 1 else 2 end),
              f.updated_at desc, f.id`;
    const forms = await db.rows<FormRow>(
      sql`select f.id, f.name, f.archived_at, f.updated_at from app.forms f
          cross join lateral (select private.search_fold(f.name) as fname offset 0) fn
          where f.workspace_id = ${plan.workspaceId} and ${byName}
            and ${archivedRule(plan, sql`f.archived_at`, byName)}
            ${plan.onlyMine && plan.me ? sql`and f.created_by = ${plan.me}` : sql``}
          order by ${order}
          limit ${plan.limit}`,
    );
    const hits = forms.map((r) => formHit(r, plan));
    // Answers aren't archived, and nobody owns one.
    if (plan.archivedOnly || plan.onlyMine || !p.likes.length)
      return [{ kind: 'forms', label: null, icon: null, hits }];

    const w = windowOf(plan, 'answers');
    const inWords = likeAll(sql`lower(${ANSWER_TEXT})`, p.likes);
    const answers = await db.rows<AnswerRow>(
      windowed(
        w,
        sql`select fa.answered_at as at from app.form_answers fa
            where fa.workspace_id = ${plan.workspaceId}
              ${w.before ? sql`and fa.answered_at <= ${w.before}::timestamptz` : sql``}
            order by fa.answered_at desc, fa.response_id desc`,
        (inWindow) =>
          sql`select x.* from (
                select distinct on (fa.response_id) fa.response_id, fa.form_id, f.name as form_name,
                  fa.question_title, fa.answered_at, ${inWords} as in_words, p.id as person_id,
                  nullif(concat_ws(' ', p.first_name, p.last_name), '') as person_name,
                  r.person_id is null as anonymous,
                  ${stretchOf(ANSWER_TEXT, p.words[0] ?? null, 'snip')}
                from (
                  -- The window's answers, newest first as their index holds them: the order keeps this its own
                  -- read of that index, bounded by the window's edge.
                  select fa.response_id, fa.form_id, fa.question_id, fa.question_title, fa.text_value,
                    fa.choice_labels, fa.answered_at
                  from app.form_answers fa
                  where fa.workspace_id = ${plan.workspaceId} and ${inWindow(sql`fa.answered_at`)}
                    and nullif(${ANSWER_TEXT}, '') is not null
                    ${plan.can('money.read') ? sql`` : sql`and fa.question_type <> 'payment'`}
                  order by fa.answered_at desc, fa.response_id desc
                ) fa
                -- Only a completed response that still reads: one in the bin hides its answers.
                join app.form_responses r on r.id = fa.response_id and r.status = 'completed'
                join app.forms f on f.id = fa.form_id
                left join app.people p on p.id = r.person_id and ${LIVE_PERSON('p')}
                -- The question's place on its form, as the version answered lists them: question ids are random.
                left join lateral (
                  select q.place
                  from app.form_versions v
                  cross join lateral jsonb_path_query(v.definition, '$.pages[*].questions[*].id')
                    with ordinality q(id, place)
                  where v.id = r.version_id and q.id = to_jsonb(fa.question_id)
                  offset 0) qp on true
                where ${inWords}
                  -- Decision 34: who answered, folded (decision 23), ranked after the answers whose own words
                  -- matched.
                  or ${likeAll(folded(sql`concat_ws(' ', p.first_name, p.last_name)`), p.folds)}
                -- A response's best answer: one whose words matched, else its first that says something, each in
                -- the form's order.
                order by fa.response_id, ${inWords} desc, qp.place nulls last, fa.question_id
              ) x
              order by x.in_words desc, x.answered_at desc, x.response_id desc
              limit ${plan.limit}`,
      ),
    );
    hits.push(...answers.filter((r) => r.response_id).map((r) => answerHit(r, plan)));
    return [{ kind: 'forms', label: null, icon: null, hits, ...reachOf(answers) }];
  },
};
