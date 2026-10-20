/**
 * Companies (records.read): the name folded, the website, every email and phone, and the address, across the whole
 * business. Row security already hides a company in the bin. How many people work there (live ones only) and its
 * open leads are read for the winners only.
 */
import { sql } from 'drizzle-orm';
import { formatPhone } from '../../../crm/phone';
import type { SearchHit } from '../../../schemas/search';
import { explainCompany } from '../../explain';
import { searchHref } from '../../href';
import { escapeLike } from '../../probes';
import { hitOf, isoOf } from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import { archivedRule, digitsOf, LIVE_PERSON, likeAll, startsAll, uuidArray } from '../sql';

interface Row extends Record<string, unknown> {
  id: string;
  name: string;
  email: string | null;
  phone_e164: string | null;
  website: string | null;
  other_phones: unknown;
  other_emails: unknown;
  other_addresses: unknown;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  custom_text: string | null;
  archived_at: Date | null;
  updated_at: Date;
}

function hitFrom(r: Row, plan: SearchPlan): SearchHit {
  return hitOf({
    kind: 'companies',
    id: r.id,
    title: r.name,
    href: searchHref(plan.workspaceId, { type: 'company', id: r.id }),
    ...explainCompany(r, plan.p),
    badges: r.archived_at ? ['archived'] : [],
    at: isoOf(r.updated_at),
    contact:
      r.phone_e164 || r.email ? { personId: null, phoneE164: r.phone_e164, email: r.email } : null,
    facts: {
      ...(r.phone_e164 ? { phone: formatPhone(r.phone_e164) } : {}),
      ...(r.email ? { email: r.email } : {}),
      ...(r.address_line1 || r.city
        ? { where: [r.address_line1, r.city].filter(Boolean).join(', ') }
        : {}),
      ...(r.archived_at ? { archivedAt: isoOf(r.archived_at)! } : {}),
    },
  });
}

export const companiesSearcher: KindSearcher = {
  key: 'companies',
  async find(db, plan) {
    const { p } = plan;
    const byName = sql`(${startsAll(sql`f.fname`, p.starts)} or ${likeAll(sql`f.fname`, p.folds)})`;
    const phoneArm = p.phoneE164
      ? sql`(c.phone_e164 = ${p.phoneE164} or c.other_phones @> ${JSON.stringify([{ phone: p.phoneE164 }])}::jsonb)`
      : sql`false`;
    const emailArm = p.email
      ? sql`(lower(c.email::text) = ${p.email} or c.other_emails @> ${JSON.stringify([{ email: p.email }])}::jsonb)`
      : sql`false`;
    const domain = p.domain ? escapeLike(p.domain) : null;
    const domainArm = domain
      ? sql`(lower(coalesce(c.website, '')) like ${`%${domain}%`} or lower(coalesce(c.email::text, '')) like ${`%@${domain}`})`
      : sql`false`;
    const wordsArm = likeAll(
      sql`(c.search_text || ' ' || lower(coalesce(c.website, '') || ' ' || coalesce(c.address_line2, '') || ' ' ||
          coalesce(c.state, '') || ' ' || coalesce(c.postal_code, '') || ' ' ||
          coalesce(jsonb_path_query_array(c.custom, 'strict $.*')::text, '')))`,
      p.likes,
    );
    const digitsArm = p.digits
      ? sql`(c.search_text like ${`%${p.digits}%`} or ${digitsOf(sql`c.phone`)} like ${`%${p.digits}%`})`
      : sql`false`;
    const tier = sql`case
        when ${phoneArm} or ${emailArm} then 0
        when ${startsAll(sql`f.fname`, p.starts)} or ${domainArm} then 1
        when ${likeAll(sql`f.fname`, p.folds)} then 2
        else 3 end`;
    const order =
      plan.sort === 'name'
        ? sql`sort_name, c.id`
        : plan.sort === 'recent'
          ? sql`c.updated_at desc, c.id desc`
          : sql`(c.archived_at is not null), tier, c.updated_at desc, c.id`;
    const list = await db.rows<Row>(
      sql`select c.id, c.name, c.email::text as email, c.phone_e164, c.website, c.other_phones, c.other_emails,
            c.other_addresses, c.address_line1, c.address_line2, c.city, c.state, c.postal_code,
            jsonb_path_query_array(c.custom, 'strict $.*')::text as custom_text,
            c.archived_at, c.updated_at, lower(c.name) as sort_name, ${tier} as tier
          from app.companies c
          cross join lateral (select private.search_fold(c.name) as fname offset 0) f
          where c.workspace_id = ${plan.workspaceId}
            and (${phoneArm} or ${emailArm} or ${domainArm} or ${byName} or ${wordsArm} or ${digitsArm})
            and ${archivedRule(plan, sql`c.archived_at`, byName)}
            ${plan.onlyMine && plan.me ? sql`and (c.owner_user_id = ${plan.me} or c.team_user_ids @> array[${plan.me}::uuid])` : sql``}
          order by ${order}
          limit ${plan.limit}`,
    );
    return [
      { kind: 'companies', label: null, icon: null, hits: list.map((r) => hitFrom(r, plan)) },
    ];
  },

  async facts(db, _plan, hits) {
    const counts = await db.rows<{ id: string; people: number; open_leads: number }>(
      sql`select c.id,
            (select count(*) from app.people cp where cp.company_id = c.id and ${LIVE_PERSON('cp')})::int as people,
            (select count(*) from app.leads l
             where l.company_id = c.id and l.status = 'open' and l.archived_at is null)::int as open_leads
          from app.companies c
          where c.id = any(${uuidArray(hits.map((h) => h.id))})`,
    );
    const byId = new Map(counts.map((c) => [c.id, c]));
    return hits.map((h) => {
      const c = byId.get(h.id);
      return c
        ? { ...h, facts: { ...h.facts, people: Number(c.people), openLeads: Number(c.open_leads) } }
        : h;
    });
  },
};
