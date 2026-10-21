/**
 * Tasks (records.read): the title folded, then the notes, across the whole business. Done tasks stay, marked, after
 * the open ones (decision 25). A task on a turned-off add-on's record hides with it (`RECORD_READS`: `tasks_select`
 * checks only sealing); row security hides one sealed to a private record. A result opens the task over the Tasks page.
 */
import { sql } from 'drizzle-orm';
import type { SearchHit } from '../../../schemas/search';
import { explainTask } from '../../explain';
import { searchHref } from '../../href';
import { hitOf, isoOf } from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import { LIVE_PERSON, likeAll, RECORD_READS, startsAll } from '../sql';

interface Row extends Record<string, unknown> {
  id: string;
  title: string;
  notes: string | null;
  due_at: Date | null;
  done_at: Date | null;
  updated_at: Date;
  owner: string | null;
  on_name: string | null;
}

function hitFrom(r: Row, plan: SearchPlan): SearchHit {
  return hitOf({
    kind: 'tasks',
    id: r.id,
    title: r.title,
    href: searchHref(plan.workspaceId, { type: 'task', id: r.id }),
    ...explainTask(r, plan.p),
    badges: r.done_at ? ['done'] : [],
    at: isoOf(r.updated_at),
    facts: {
      ...(r.due_at ? { dueAt: isoOf(r.due_at)! } : {}),
      ...(r.done_at ? { doneAt: isoOf(r.done_at)! } : {}),
      ...(r.owner ? { owner: r.owner } : {}),
      ...(r.on_name ? { on: r.on_name } : {}),
    },
  });
}

export const tasksSearcher: KindSearcher = {
  key: 'tasks',
  async find(db, plan) {
    const { p } = plan;
    // Tasks aren't archived; the Archived page has nothing here.
    if (plan.archivedOnly) return [{ kind: 'tasks', label: null, icon: null, hits: [] }];
    const byTitle = sql`(${startsAll(sql`f.fname`, p.starts)} or ${likeAll(sql`f.fname`, p.folds)})`;
    const tier = sql`case
        when ${startsAll(sql`f.fname`, p.starts)} then 1
        when ${likeAll(sql`f.fname`, p.folds)} then 2
        else 4 end`;
    const order =
      plan.sort === 'name'
        ? sql`lower(t.title), t.id`
        : plan.sort === 'recent'
          ? sql`t.updated_at desc, t.id desc`
          : sql`tier, (t.done_at is not null), t.updated_at desc, t.id`;
    // Only mine as the Tasks page's Mine: the assignee, or whoever made it when nobody is.
    const mine =
      plan.onlyMine && plan.me
        ? sql`and (t.assignee_user_id = ${plan.me} or (t.assignee_user_id is null and t.created_by = ${plan.me}))`
        : sql``;
    const list = await db.rows<Row>(
      sql`select t.id, t.title, t.notes, t.due_at, t.done_at, t.updated_at,
            coalesce(nullif(u.full_name, ''), u.email::text) as owner,
            coalesce(nullif(concat_ws(' ', p.first_name, p.last_name), ''), c.name, l.title, r.name) as on_name,
            ${tier} as tier
          from app.tasks t
          cross join lateral (select private.search_fold(t.title) as fname offset 0) f
          left join app.users u on u.id = t.assignee_user_id
          left join app.people p on p.id = t.person_id and ${LIVE_PERSON('p')}
          left join app.companies c on c.id = t.company_id
          left join app.leads l on l.id = t.lead_id
          left join app.custom_records r on r.id = t.custom_record_id
          where t.workspace_id = ${plan.workspaceId}
            and ${RECORD_READS(sql`t.custom_record_id`)}
            and (${byTitle} or ${likeAll(sql`lower(coalesce(t.notes, ''))`, p.likes)})
            ${mine}
          order by ${order}
          limit ${plan.limit}`,
    );
    return [{ kind: 'tasks', label: null, icon: null, hits: list.map((r) => hitFrom(r, plan)) }];
  },
};
