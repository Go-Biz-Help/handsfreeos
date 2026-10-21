/**
 * Contacts (records.read): names folded, every email and phone, the address, the company's name and the fields the
 * business invented, across the whole business. Customers in the bin, erased names and merged shells never show
 * (`LIVE_PERSON`). The last contact rides along for the rows read; whether they're a client, their open lead and
 * the business's own field names are read for the winners only.
 */
import { sql } from 'drizzle-orm';
import { personIsClient } from '../../../crm/clients';
import { formatPhone } from '../../../crm/phone';
import { fullName } from '../../../crm/records';
import type { SearchHit } from '../../../schemas/search';
import { explainContact } from '../../explain';
import { searchHref } from '../../href';
import { escapeLike } from '../../probes';
import { SEARCH_WORDS } from '../../words';
import { fieldSnippet, hitOf, holdsAny, isoOf } from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import {
  archivedRule,
  contactLines,
  digitsOf,
  LIVE_PERSON,
  likeAll,
  startsAll,
  uuidArray,
} from '../sql';

interface Row extends Record<string, unknown> {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone_e164: string | null;
  phone_alt: string | null;
  other_phones: unknown;
  other_emails: unknown;
  other_addresses: unknown;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  company_name: string | null;
  custom_text: string | null;
  archived_at: Date | null;
  updated_at: Date;
  client?: boolean;
  lc_kind: string | null;
  lc_subtype: string | null;
  lc_at: Date | null;
}

function hitFrom(r: Row, plan: SearchPlan): SearchHit {
  const name = fullName(r.first_name, r.last_name);
  const lastContact =
    r.lc_kind && r.lc_at
      ? { kind: r.lc_kind, subtype: r.lc_subtype, at: isoOf(r.lc_at)! }
      : undefined;
  return hitOf({
    kind: 'contacts',
    id: r.id,
    title: name || SEARCH_WORDS.noName,
    href: searchHref(plan.workspaceId, { type: 'person', id: r.id }),
    // Why it matched is core's, the same on the phone (search/explain.ts).
    ...explainContact(r, plan.p),
    badges: [
      ...(r.archived_at ? ['archived'] : []),
      ...(r.client === undefined ? [] : [r.client ? 'client' : 'lead']),
    ],
    at: isoOf(r.lc_at ?? r.updated_at),
    contact: { personId: r.id, phoneE164: r.phone_e164, email: r.email },
    facts: {
      ...(r.phone_e164 || r.phone_alt
        ? { phone: r.phone_e164 ? formatPhone(r.phone_e164) : r.phone_alt! }
        : {}),
      ...(r.email ? { email: r.email } : {}),
      ...(r.address_line1 || r.city
        ? { where: [r.address_line1, r.city].filter(Boolean).join(', ') }
        : {}),
      ...(r.company_name ? { company: r.company_name } : {}),
      ...(lastContact ? { lastContact } : {}),
      ...(r.archived_at ? { archivedAt: isoOf(r.archived_at)! } : {}),
    },
  });
}

export const contactsSearcher: KindSearcher = {
  key: 'contacts',
  async find(db, plan) {
    const { p } = plan;
    const fname = sql`f.fname`;
    const byName = sql`(${startsAll(fname, p.starts)} or ${likeAll(fname, p.folds)})`;
    const phoneArm = p.phoneE164
      ? sql`(p.phone_e164 = ${p.phoneE164} or p.other_phones @> ${JSON.stringify([{ phone: p.phoneE164 }])}::jsonb)`
      : sql`false`;
    const emailArm = p.email
      ? sql`(lower(p.email::text) = ${p.email} or p.other_emails @> ${JSON.stringify([{ email: p.email }])}::jsonb)`
      : sql`false`;
    const domainArm = p.domain
      ? sql`lower(coalesce(p.email::text, '')) like ${`%@${escapeLike(p.domain)}`}`
      : sql`false`;
    const wordsArm = likeAll(
      sql`(p.search_text || ' ' || lower(coalesce(c.name, '') || ' ' || coalesce(p.address_line2, '') || ' ' ||
          coalesce(p.state, '') || ' ' || coalesce(p.postal_code, '') || ' ' || coalesce(p.phone_alt, '') || ' ' ||
          coalesce(jsonb_path_query_array(p.custom, 'strict $.*')::text, '')))`,
      p.likes,
    );
    const digitsArm = p.digits
      ? sql`(p.search_text like ${`%${p.digits}%`} or ${digitsOf(sql`p.phone_alt`)} like ${`%${p.digits}%`})`
      : sql`false`;
    const tier = sql`case
        when ${phoneArm} or ${emailArm} then 0
        when ${startsAll(fname, p.starts)} or ${domainArm} then 1
        when ${likeAll(fname, p.folds)} then 2
        else 3 end`;
    // Most recent contact orders by the last contact before the cut, so the 500 read are the 500 most recent; the
    // other sorts read the last contact for the rows kept only.
    const recent = plan.sort === 'recent';
    const lastContact = (alias: string) => sql`left join lateral (
            select a.kind::text as kind, a.subtype, a.occurred_at from app.activities a
            where a.workspace_id = ${plan.workspaceId} and a.person_id = ${sql.raw(alias)}.id
              and ${contactLines('a')}
            order by a.occurred_at desc
            limit 1
          ) lc on true`;
    const lastContactColumns = sql`lc.kind as lc_kind, lc.subtype as lc_subtype, lc.occurred_at as lc_at`;
    const order =
      plan.sort === 'name'
        ? sql`sort_name, p.id`
        : recent
          ? sql`coalesce(lc.occurred_at, p.updated_at) desc, p.id desc`
          : sql`(p.archived_at is not null), tier, p.updated_at desc, p.id`;
    const list = await db.rows<Row>(
      sql`select x.*${recent ? sql`` : sql`, ${lastContactColumns}`}
          from (
            select p.id, p.first_name, p.last_name, p.email::text as email, p.phone_e164, p.phone_alt,
              p.other_phones, p.other_emails, p.other_addresses, p.address_line1, p.address_line2, p.city, p.state,
              p.postal_code, c.name as company_name,
              jsonb_path_query_array(p.custom, 'strict $.*')::text as custom_text,
              p.archived_at, p.updated_at, lower(concat_ws(' ', p.first_name, p.last_name)) as sort_name,
              ${tier} as tier
              ${recent ? sql`, ${lastContactColumns}` : sql``}
              ${plan.mode === 'kind' ? sql`, ${personIsClient('p')} as client` : sql``}
            from app.people p
            left join app.companies c on c.id = p.company_id
            -- The name folded once a row, for every arm that reads it.
            cross join lateral (
              select private.search_fold(concat_ws(' ', p.first_name, p.last_name)) as fname offset 0) f
            ${recent ? lastContact('p') : sql``}
            where p.workspace_id = ${plan.workspaceId}
              and ${LIVE_PERSON('p')}
              and (${phoneArm} or ${emailArm} or ${domainArm} or ${byName} or ${wordsArm} or ${digitsArm})
              and ${archivedRule(plan, sql`p.archived_at`, byName)}
              ${plan.onlyMine && plan.me ? sql`and (p.owner_user_id = ${plan.me} or p.team_user_ids @> array[${plan.me}::uuid])` : sql``}
            order by ${order}
            limit ${plan.limit}
          ) x
          ${recent ? sql`` : lastContact('x')}`,
    );
    return [{ kind: 'contacts', label: null, icon: null, hits: list.map((r) => hitFrom(r, plan)) }];
  },

  async facts(db, plan, hits) {
    const ids = hits.map((h) => h.id);
    const seesMoney = plan.can('money.read');
    const needsFields = hits.some((h) => h.why.field === 'field');
    const facts = await db.rows<{
      id: string;
      client: boolean;
      lead_title: string | null;
      lead_stage: string | null;
      paid_at: Date | null;
      custom: Record<string, unknown> | null;
    }>(
      sql`select p.id, ${personIsClient('p')} as client, ol.title as lead_title, ol.stage as lead_stage,
            ${
              seesMoney
                ? sql`(select max(i.paid_at) from app.invoices i
                       where i.workspace_id = p.workspace_id and i.person_id = p.id and i.status = 'paid')`
                : sql`null::timestamptz`
            } as paid_at,
            ${needsFields ? sql`p.custom` : sql`null::jsonb`} as custom
          from app.people p
          left join lateral (
            select l.title, s.name as stage from app.leads l
            join app.pipeline_stages s on s.id = l.stage_id
            where l.person_id = p.id and l.status = 'open' and l.archived_at is null
            order by l.updated_at desc
            limit 1
          ) ol on true
          where p.id = any(${uuidArray(ids)})`,
    );
    const labels = needsFields
      ? new Map(
          (
            await db.rows<{ id: string; label: string }>(
              sql`select f.id::text as id, f.label from app.custom_fields f
                  where f.workspace_id = ${plan.workspaceId} and f.entity = 'person' and f.archived_at is null
                  order by f.position, f.label`,
            )
          ).map((f) => [f.id, f.label]),
        )
      : new Map<string, string>();
    const byId = new Map(facts.map((f) => [f.id, f]));
    const firstOnPhone = new Map<string, SearchHit>();
    return hits.map((h) => {
      const f = byId.get(h.id);
      if (!f) return h;
      const paidAt = isoOf(f.paid_at);
      const last = h.facts.lastContact;
      const lastContact =
        paidAt && (!last || Date.parse(paidAt) > Date.parse(last.at))
          ? { kind: 'paid', subtype: null, at: paidAt }
          : last;
      let why = h.why;
      if (why.field === 'field' && f.custom) {
        // The business's own field the words sit in, by its name.
        const match = Object.entries(f.custom).find(
          ([key, value]) => labels.has(key) && holdsAny(String(value), plan.p),
        );
        if (match)
          why = {
            ...why,
            label: labels.get(match[0]) ?? null,
            snippet: fieldSnippet(String(match[1]), plan.p),
          };
      }
      // "Same number, maybe the same person": a later exact phone match points at the first.
      let duplicateOf: SearchHit['duplicateOf'] = null;
      const phone = h.contact?.phoneE164;
      if (h.tier === 0 && h.why.field === 'phone' && phone) {
        const first = firstOnPhone.get(phone);
        if (first) duplicateOf = { id: first.id, name: first.title };
        else firstOnPhone.set(phone, h);
      }
      return {
        ...h,
        why,
        duplicateOf,
        badges: [
          ...h.badges.filter((b) => b !== 'client' && b !== 'lead'),
          f.client ? 'client' : 'lead',
        ],
        facts: {
          ...h.facts,
          ...(f.lead_title ? { openLead: { title: f.lead_title, stage: f.lead_stage ?? '' } } : {}),
          ...(lastContact ? { lastContact } : {}),
        },
      };
    });
  },
};
