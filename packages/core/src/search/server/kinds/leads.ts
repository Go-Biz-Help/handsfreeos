/**
 * Leads (records.read): the title folded, or the name of who it's for, the person's and the company's together, so
 * a lead for both is found by either. Won and lost leads stay here with their badge, after the open ones.
 */
import { sql } from 'drizzle-orm';
import type { SearchHit } from '../../../schemas/search';
import { searchHref } from '../../href';
import type { SearchProbes } from '../../probes';
import { tierOf } from '../../rank';
import { fieldSnippet, hitOf, holdsAll, isoOf } from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import { archivedRule, folded, LIVE_PERSON, likeAll, startsAll } from '../sql';

interface Row extends Record<string, unknown> {
  id: string;
  title: string;
  status: 'open' | 'won' | 'lost';
  value_cents: string | number;
  archived_at: Date | null;
  updated_at: Date;
  stage: string;
  pipeline: string;
  person_name: string | null;
  company_name: string | null;
  owner_name: string | null;
  owner_email: string | null;
}

function explain(r: Row, p: SearchProbes): Pick<SearchHit, 'tier' | 'exact' | 'why'> {
  const t = tierOf(r.title, p);
  if (t)
    return {
      tier: t,
      exact: false,
      why: { field: 'title', label: null, snippet: null, page: null },
    };
  const onCompany = !holdsAll([r.person_name], p) && holdsAll([r.company_name], p);
  const who = onCompany
    ? r.company_name
    : [r.person_name, r.company_name].filter(Boolean).join(' · ');
  return {
    tier: 3,
    exact: false,
    why: {
      field: onCompany ? 'company' : 'customer',
      label: null,
      snippet: fieldSnippet(who, p),
      page: null,
    },
  };
}

function hitFrom(r: Row, plan: SearchPlan): SearchHit {
  const customer = r.person_name?.trim() || r.company_name || null;
  return hitOf({
    kind: 'leads',
    id: r.id,
    title: r.title,
    href: searchHref(plan.workspaceId, { type: 'lead', id: r.id }),
    ...explain(r, plan.p),
    badges: [...(r.archived_at ? ['archived'] : []), ...(r.status === 'open' ? [] : [r.status])],
    at: isoOf(r.updated_at),
    amount: { cents: Number(r.value_cents ?? 0), currency: 'USD' },
    facts: {
      ...(customer ? { customer } : {}),
      pipeline: r.pipeline,
      stage: r.stage,
      ...(r.owner_name || r.owner_email ? { owner: r.owner_name || r.owner_email! } : {}),
      status: r.status,
      ...(r.archived_at ? { archivedAt: isoOf(r.archived_at)! } : {}),
    },
  });
}

export const leadsSearcher: KindSearcher = {
  key: 'leads',
  async find(db, plan) {
    const { p } = plan;
    const byTitle = sql`(${startsAll(sql`f.fname`, p.starts)} or ${likeAll(sql`f.fname`, p.folds)})`;
    const byCustomer = likeAll(
      folded(sql`concat_ws(' ', p.first_name, p.last_name, c.name)`),
      p.folds,
    );
    const tier = sql`case
        when ${startsAll(sql`f.fname`, p.starts)} then 1
        when ${likeAll(sql`f.fname`, p.folds)} then 2
        else 3 end`;
    const order =
      plan.sort === 'name'
        ? sql`sort_name, l.id`
        : plan.sort === 'recent'
          ? sql`l.updated_at desc, l.id desc`
          : sql`(l.archived_at is not null), tier, (l.status = 'open') desc, l.updated_at desc, l.id`;
    const list = await db.rows<Row>(
      sql`select l.id, l.title, l.status::text as status, l.value_cents, l.archived_at, l.updated_at,
            s.name as stage, pl.name as pipeline,
            nullif(concat_ws(' ', p.first_name, p.last_name), '') as person_name, c.name as company_name,
            u.full_name as owner_name, u.email::text as owner_email,
            lower(l.title) as sort_name, ${tier} as tier
          from app.leads l
          join app.pipeline_stages s on s.id = l.stage_id
          join app.pipelines pl on pl.id = l.pipeline_id
          left join app.people p on p.id = l.person_id and ${LIVE_PERSON('p')}
          left join app.companies c on c.id = l.company_id
          left join app.users u on u.id = l.assignee_user_id
          cross join lateral (select private.search_fold(l.title) as fname offset 0) f
          where l.workspace_id = ${plan.workspaceId}
            and (${byTitle} or ${byCustomer})
            and ${archivedRule(plan, sql`l.archived_at`, byTitle)}
            ${plan.onlyMine && plan.me ? sql`and l.assignee_user_id = ${plan.me}` : sql``}
          order by ${order}
          limit ${plan.limit}`,
    );
    return [{ kind: 'leads', label: null, icon: null, hits: list.map((r) => hitFrom(r, plan)) }];
  },
};
