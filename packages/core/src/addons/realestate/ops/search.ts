/**
 * Real Estate's answer to Search everything (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Add-ons answer searches",
 * Search 4b): `realestate.search`, which core runs inside `search.everything` and `search.kind` and nowhere else
 * (`route: false`). Four kinds, read in one statement, and a second only when a deal or a property it keeps was found
 * by one of its fields, to say which:
 *
 *   - **Listings**: a listing by its home's address (the property record's name), or by its MLS number exactly.
 *   - **Deals**: a deal by its name or its fields, its client's name or its home's address, the three things the Deals
 *     list searches (`realestate.deal.list`). One whose listing this search shows is left to that listing, which opens
 *     the same deal, so it shows once.
 *   - **Homes**: a home on a buyer deal, by its address, opening the deal's Homes with it.
 *   - **Properties**: a property by its address or its fields, unless a listing this search shows is on it: a buyer's
 *     home, or one with no deal yet. It opens the record's page, whose Real Estate panel lists its deals.
 *
 * A kind's own page leaves to their listings what the whole answer would, whichever kind it is, so it holds what its
 * group counted there. Chips naming Deals or Properties without Listings keep them, since no listing shows.
 *
 * Everything is read as the person, so a private deal, its listing and its homes stay with its people (through
 * `custom_records_select` and the add-on's table policies). It gets core's probes, never what was typed, and ranks and
 * marks with core's `tierOf`, `marksIn` and `snippetOf`, so its hits sit on core's scale. An archived deal, and what
 * hangs off it, only when archived ones are asked for; otherwise core's Archived group lists the record by its name.
 */
import { type SQL } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { listMovedOn } from '../../../kernel/pagination';
import { fieldsByKind } from '../../../relationships/store';
import { AddonSearchInput, AddonSearchOutput, type AddonSearchHit } from '../../../search/addon';
import { tierOf } from '../../../search/rank';
import { marksIn, snippetOf } from '../../../search/snippet';
import { LIVE_PERSON, likeAll, startsAll } from '../../../search/server/sql';
import { whyLabel } from '../../../search/words';
import { defineAddonQuery } from '../../server';
import { realestateAddon } from '../manifest';
import {
  RE_SEARCH_WORDS,
  dealSearchLine,
  homeSearchLine,
  listingSearchLine,
  propertySearchLine,
} from '../search-words';
import { inWorkspace } from './common';
import { onDealSql } from './queries';

/** Its kinds, in its manifest's order. */
const KINDS = ['listings', 'deals', 'homes', 'properties'] as const;
type Kind = (typeof KINDS)[number];

/** How far down a kind's own page reads, as far as core's own kinds' pages read (`KIND_ROWS`). */
const READ_MOST = 500;

/** "MLS" before a number, as people write one: "MLS 4821937", "mls# 4821937". */
const MLS_WORD = /^mls#?:?$/;
/** The same written onto the number, as listing sheets print it: "MLS#4821937", "mls:4821937". */
const MLS_MARK = /^mls[#:]+(?=[a-z0-9])/;

/** What an MLS number would be, as typed and lower-cased: one word, or one word after "MLS". */
function mlsProbe(words: readonly string[]): string | null {
  const [first, second, ...rest] = words;
  if (!first) return null;
  if (!second) return first.replace(MLS_MARK, '');
  return !rest.length && MLS_WORD.test(first) ? second : null;
}

/** Where a kind's own page starts: core hands back our own `nextCursor`, an offset. Anything else starts again. */
function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d{1,3}$/.test(cursor) || Number(cursor) >= READ_MOST) throw listMovedOn();
  return Number(cursor);
}

/**
 * A deal's home, as the Deals list reads it (`dealRows`, ops/queries.ts): the property it was last put on. A lateral
 * read by the deal's key, so it costs a look-up a deal.
 */
const lastPropertyOf = (deal: SQL) =>
  sql`select pr.id, pr.name
      from app.relationships rel
      join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_property_of'
      join app.custom_records pr on pr.id = rel.b_custom_record_id
      where rel.a_custom_record_id = ${deal}
      order by rel.created_at desc, rel.id desc limit 1`;

/**
 * A deal's client, as the Deals list reads them: the first put on it. Held to a customer search may show
 * (`LIVE_PERSON`), so a client in the Deleted bin, an erased name or a merged shell never finds a deal.
 */
const clientOf = (deal: SQL) =>
  sql`select coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.email::text) as name
      from app.relationships rel
      join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_client'
      join app.people p on p.id = rel.a_person_id and ${LIVE_PERSON('p')}
      where rel.b_custom_record_id = ${deal}
      order by rel.created_at, rel.id limit 1`;

interface Row extends Record<string, unknown> {
  kind: Kind;
  id: string;
  title: string;
  archived_at: Date | string | null;
  at: Date | string;
  tier: number;
  extra: Record<string, unknown>;
  total: number;
  price_cents: number | string | null;
  deals: number | null;
  /** A deal's or a property's kind and fields, when its fields may be what found it. */
  own: { type: string; custom: Record<string, unknown> | null } | null;
}

const iso = (v: Date | string) => new Date(v).toISOString();
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const count = (v: unknown): number | null => (typeof v === 'number' ? v : null);
/** A deal that ended keeps its place after the open ones, as finished things do (decision 25). */
const ended = (outcome: unknown): string[] =>
  outcome === 'closed' ? ['won'] : outcome ? ['lost'] : [];
const dealPage = (id: string) => `/a/realestate/deals/${id}`;
const recordPage = (id: string) => `/customers/records/${id}`;

export const realestateSearch = defineAddonQuery(realestateAddon, {
  name: 'realestate.search',
  description:
    'Real Estate’s part of Search everything: listings by address or MLS number, deals by name, client or address, buyers’ homes by address, and properties no listing covers. Run only inside a search.',
  input: AddonSearchInput,
  output: AddonSearchOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  // Only ever inside search.everything and search.kind, under their rate limit and slot gate.
  route: false,
  handler: async (ctx, input) => {
    const p = input.probes;
    const wanted = KINDS.filter((k) => !input.kinds || input.kinds.includes(k));
    // Every arm needs a word, so a search with none matches nothing rather than every row.
    if (p.tooShort || p.folds.length === 0 || wanted.length === 0) return { groups: [] };
    const from = offsetOf(input.cursor);
    const ws = input.workspaceId;
    const me = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    const mls = mlsProbe(p.words);

    const wants = (k: Kind) => (wanted.includes(k) ? sql`true` : sql`false`);
    // Listings are read to show, and to leave to them the deals and properties they are. A kind's own page of deals or
    // properties reads them too, so it holds what the whole answer's group counted.
    const listingsRead =
      wanted.includes('listings') ||
      (input.sort !== undefined && (wanted.includes('deals') || wanted.includes('properties')));
    const live = (archivedAt: SQL) =>
      input.includeArchived ? sql`true` : sql`${archivedAt} is null`;
    // The deals someone is on, the Deals list's Mine.
    const onDeal = input.onlyMine ? sql`and ${onDealSql(me)}` : sql``;
    // Properties are everyone's: Only mine keeps those the person added, as core's records search does.
    const added = input.onlyMine
      ? me
        ? sql`and pr.created_by = ${me}::uuid`
        : sql`and false`
      : sql``;
    // Every arm reads a row's name folded once, in its lateral's `fname`.
    const startsName = startsAll(sql`f.fname`, p.starts);
    const holdsName = likeAll(sql`f.fname`, p.folds);
    const byName = sql`(${startsName} or ${holdsName})`;
    const tier = sql`(case when ${startsName} then 1 when ${holdsName} then 2 else 3 end)`;
    const byMls = mls ? sql`lower(btrim(coalesce(l.mls_number, ''))) = ${mls}` : sql`false`;
    const order =
      input.sort === 'name'
        ? sql`f.fname, f.id`
        : input.sort === 'recent'
          ? sql`f.at desc, f.id desc`
          : sql`(f.archived_at is not null), f.tier, f.finished, f.at desc, f.fname, f.id`;

    const list = await rows<Row>(
      ctx.tx,
      sql`with types as (
            select
              (select t.id from app.custom_record_types t where t.workspace_id = ${ws}
                 and t.addon_id = 'realestate' and t.key = 'realestate_deal') as deal,
              (select t.id from app.custom_record_types t where t.workspace_id = ${ws}
                 and t.addon_id = 'realestate' and t.key = 'realestate_property') as property
          ),
          listing_found as (
            select l.deal_record_id as id, prop.id as property_id, coalesce(prop.name, r.name) as title, f.fname,
              r.archived_at, d.outcome is not null as finished,
              greatest(l.updated_at, d.updated_at, r.updated_at) as at,
              (case when ${byMls} then 0 else ${tier} end) as tier,
              jsonb_build_object('stage', d.stage, 'outcome', d.outcome, 'mls', l.mls_number,
                'beds', l.facts -> 'beds', 'baths', l.facts -> 'baths') as extra
            from addon_realestate.listings l
            join addon_realestate.deals d on d.record_id = l.deal_record_id
            join app.custom_records r on r.id = l.deal_record_id
            left join lateral (${lastPropertyOf(sql`l.deal_record_id`)}) prop on true
            cross join lateral (select private.search_fold(prop.name) as fname offset 0) f
            where l.workspace_id = ${ws} and ${listingsRead ? sql`true` : sql`false`} and r.purged_at is null
              and (${byMls} or ${byName})
              and ${live(sql`r.archived_at`)} ${onDeal}
          ),
          deal_found as (
            select r.id, r.name as title, f.fname, r.archived_at, d.outcome is not null as finished,
              greatest(r.updated_at, d.updated_at) as at, m.tier,
              jsonb_build_object('side', d.side, 'stage', d.stage, 'outcome', d.outcome,
                'opens', d.record_id is not null,
                'client', case when m.by_client and not m.by_name then client.name end,
                'address', case when m.by_address and not m.by_name and not m.by_client then prop.name end) as extra
            from app.custom_records r
            left join addon_realestate.deals d on d.record_id = r.id
            cross join lateral (select private.search_fold(r.name) as fname offset 0) f
            left join lateral (${clientOf(sql`r.id`)}) client on true
            left join lateral (${lastPropertyOf(sql`r.id`)}) prop on true
            cross join lateral (
              select ${byName} as by_name,
                ${likeAll(sql`r.search_text`, p.likes)} as by_fields,
                ${likeAll(sql`private.search_fold(client.name)`, p.folds)} as by_client,
                ${likeAll(sql`private.search_fold(prop.name)`, p.folds)} as by_address,
                ${tier} as tier
              offset 0) m
            where r.workspace_id = ${ws} and ${wants('deals')} and r.type_id = (select deal from types)
              and r.purged_at is null
              and (m.by_name or m.by_fields or m.by_client or m.by_address)
              -- A deal whose listing this search shows is that listing, which opens it, once.
              and not exists (select 1 from listing_found lf where lf.id = r.id)
              and ${live(sql`r.archived_at`)} ${onDeal}
          ),
          home_found as (
            select h.id, h.address as title, f.fname, r.archived_at, d.outcome is not null as finished,
              h.updated_at as at, ${tier} as tier,
              jsonb_build_object('status', h.status, 'outcome', d.outcome, 'deal', h.deal_record_id,
                'dealName', r.name) as extra
            from addon_realestate.homes h
            join addon_realestate.deals d on d.record_id = h.deal_record_id
            join app.custom_records r on r.id = h.deal_record_id
            cross join lateral (select private.search_fold(h.address) as fname offset 0) f
            where h.workspace_id = ${ws} and ${wants('homes')} and h.status <> 'removed'
              and r.purged_at is null and ${byName}
              and ${live(sql`r.archived_at`)} ${onDeal}
          ),
          property_found as (
            select pr.id, pr.name as title, f.fname, pr.archived_at, false as finished, pr.updated_at as at,
              ${tier} as tier, '{}'::jsonb as extra
            from app.custom_records pr
            cross join lateral (select private.search_fold(pr.name) as fname offset 0) f
            where pr.workspace_id = ${ws} and ${wants('properties')} and pr.type_id = (select property from types)
              and pr.purged_at is null
              and (${byName} or ${likeAll(sql`pr.search_text`, p.likes)})
              -- A property with a listing this search shows is that listing, once.
              and not exists (select 1 from listing_found lf where lf.property_id = pr.id)
              and ${live(sql`pr.archived_at`)} ${added}
          ),
          found as (
            select 'listings'::text as kind, id, title, fname, archived_at, finished, at, tier, extra
              from listing_found where ${wants('listings')}
            union all select 'deals', id, title, fname, archived_at, finished, at, tier, extra from deal_found
            union all select 'homes', id, title, fname, archived_at, finished, at, tier, extra from home_found
            union all select 'properties', id, title, fname, archived_at, finished, at, tier, extra
              from property_found
          )
          select x.kind, x.id, x.title, x.archived_at, x.at, x.tier, x.extra, x.total,
            -- The winners' own facts, for them alone: a listing's list price as it stands, confirmed first (as
            -- listPriceOf reads it), and how many deals a property has.
            case when x.kind = 'listings' then (
              select e.value_cents from addon_realestate.term_entries e
              where e.workspace_id = ${ws} and e.deal_record_id = x.id and e.key = 'list_price'
                and e.superseded_at is null and e.rejected_at is null
              order by e.confirmed_at is null, e.entered_at desc, e.id desc limit 1) end as price_cents,
            case when x.kind = 'properties' then (
              select count(*)::int from app.relationships rel
              join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_property_of'
              where rel.b_custom_record_id = x.id) end as deals,
            -- A deal or a property its name, client or address didn't find: its fields, to say which of them matched.
            case when x.kind in ('deals', 'properties') and x.tier = 3
                and x.extra ->> 'client' is null and x.extra ->> 'address' is null then (
              select jsonb_build_object('type', r.type_id, 'custom', r.custom)
              from app.custom_records r where r.id = x.id) end as own
          from (
            select f.*, row_number() over (partition by f.kind order by ${order}) as n,
              (count(*) over (partition by f.kind))::int as total
            from found f
          ) x
          where x.n > ${from}::int and x.n <= ${from + input.perKind + 1}::int
          order by x.kind, x.n`,
    );

    // Which field found a deal or a property, as core's group of records says it: the first, in the business's order,
    // the search marks something in. No kinds to read, no statement.
    const fields = await fieldsByKind(
      ctx.tx,
      ws,
      list.flatMap((r) => (r.own ? [r.own.type] : [])),
    );
    const byField = (r: Row): AddonSearchHit['why'] | null => {
      if (!r.own) return null;
      const custom = r.own.custom ?? {};
      const value = (id: string) => String(custom[id] ?? '');
      const field = fields.get(r.own.type)?.find((f) => marksIn(value(f.id), p).length > 0);
      return field ? { label: field.label, snippet: snippetOf(value(field.id), p) } : null;
    };

    const hitOf = (r: Row): AddonSearchHit => {
      const x = r.extra;
      const named = tierOf(r.title, p);
      const hit = {
        id: r.id,
        title: r.title.slice(0, 200),
        badges: [...(r.archived_at ? ['archived'] : []), ...ended(x.outcome)],
        why: { label: null as string | null, snippet: null as AddonSearchHit['why']['snippet'] },
        exact: false,
        tier: named ?? 3,
        at: iso(r.at),
      };
      if (r.kind === 'listings') {
        const exact = r.tier === 0;
        // An MLS number matches whole, so all of it is marked, however it was typed.
        const mlsNumber = text(x.mls)?.trim() ?? '';
        return {
          ...hit,
          subtitle: listingSearchLine({
            stage: text(x.stage),
            priceCents: r.price_cents === null ? null : Number(r.price_cents),
            beds: count(x.beds),
            baths: count(x.baths),
          }),
          why: exact
            ? {
                label: whyLabel({ field: 'mls' }),
                snippet: { text: mlsNumber, marks: [[0, mlsNumber.length]] },
              }
            : hit.why,
          exact,
          tier: exact ? 0 : hit.tier,
          href: dealPage(r.id),
          recordId: r.id,
        };
      }
      if (r.kind === 'deals') {
        const client = text(x.client);
        const address = text(x.address);
        return {
          ...hit,
          subtitle: dealSearchLine(text(x.side), text(x.stage)),
          why: client
            ? { label: RE_SEARCH_WORDS.client, snippet: snippetOf(client, p) }
            : address
              ? { label: whyLabel({ field: 'address' }), snippet: snippetOf(address, p) }
              : (byField(r) ?? hit.why),
          // A deal record without its deal (made as a plain record) opens its record's page.
          href: x.opens ? dealPage(r.id) : recordPage(r.id),
          recordId: r.id,
        };
      }
      if (r.kind === 'homes') {
        const deal = String(x.deal);
        return {
          ...hit,
          subtitle: homeSearchLine(String(x.status), text(x.dealName)),
          href: `${dealPage(deal)}/homes?home=${r.id}`,
          recordId: deal,
        };
      }
      return {
        ...hit,
        subtitle: propertySearchLine(r.deals ?? 0),
        why: byField(r) ?? hit.why,
        href: recordPage(r.id),
        recordId: r.id,
      };
    };

    const byKind = new Map<Kind, Row[]>();
    for (const r of list) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
    return {
      groups: KINDS.flatMap((kind) => {
        const found = byKind.get(kind);
        if (!found?.length) return [];
        const total = found[0]!.total;
        const next = from + input.perKind;
        return [
          {
            kind,
            total,
            capped: false,
            // Only a kind's own page carries on, from where this page stopped.
            nextCursor: input.sort && next < Math.min(total, READ_MOST) ? String(next) : null,
            items: found.map(hitOf),
          },
        ];
      }),
    };
  },
});

/** Its queries for Search everything. */
export const searchEverythingQueries = [realestateSearch];
