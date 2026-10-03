/**
 * Reading deals (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Screens"): the Deals list, one deal's page, its
 * history and its terms' history, and the deals of a customer, company, lead or property for the panels on their
 * pages. Row security keeps each to the deals the person sees; nothing here decides that again.
 */
import { linkedFactsOf } from './risk';
import { KEY_DATES, type KeyDateKey } from '../dates/key-dates';
import { linkedProblems, type LinkedDates } from '../dates/linked';
import { and, asc, desc, eq, lt, type SQL } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { customRecords } from '@hfos/db/schema';
import { scopeCan } from '../../../kernel/execute';
import type { Permission } from '../../../permissions';
import { defineAddonQuery } from '../../server';
import type { ResolvedDuty } from '../catalog/types';
import { checkDealDates } from '../dates/conflicts';
import { realestateAddon } from '../manifest';
import { gapWords, proofGaps, type EvidenceFact } from '../proof';
import { proofRuleWords } from '../rule-words';
import {
  DealGetInput,
  DealGetOutput,
  DealHistoryInput,
  DealHistoryOutput,
  DealListInput,
  DealListOutput,
  DealsForInput,
  DealsForOutput,
  OverviewInput,
  OverviewOutput,
  PropertySearchInput,
  PropertySearchOutput,
  TermHistoryInput,
  TermHistoryOutput,
} from '../schemas';
import {
  isDoneDuty,
  isOverdue,
  OPEN_DUTY_STATUSES,
  STAGE_LABELS,
  type DealStage,
  type DutyStatus,
} from '../states';
import { dealHistory, deals, duties, termEntries } from '../tables';
import {
  isLive,
  isTermKey,
  keyDatesOf,
  termKind,
  termLabel,
  termsNow,
  TERM_KEYS,
  type TermKey,
} from '../terms';
import { PARTY_ROLES, type PartyRole } from '../words';
import {
  businessCalendarOf,
  inWorkspace,
  kindIds,
  loadDeal,
  mayChangeTeam,
  timeZoneOf,
  todayIn,
  userNames,
  type Ctx,
} from './common';
import { dealProofFactsOf } from './duties';
import { termEntriesOf } from './engine';
import { commissionView, propertyOf, teamOf } from './people';

const isoOf = (v: Date | string) => new Date(v).toISOString();
const OPEN = sql.raw(`(${OPEN_DUTY_STATUSES.map((s) => `'${s}'`).join(', ')})`);

interface Row extends Record<string, unknown> {
  record_id: string;
  name: string;
  side: 'buyer' | 'listing';
  stage: string;
  outcome: string | null;
  archived: boolean;
  health: 'green' | 'yellow' | 'red';
  owner_user_id: string | null;
  owner_name: string | null;
  client_id: string | null;
  client_name: string | null;
  property_id: string | null;
  property_address: string | null;
  open_duties: number;
  overdue_duties: number;
  next_id: string | null;
  next_title: string | null;
  next_due_at: string | null;
  closing: string | null;
  headline: string | null;
  mine: boolean;
  dates_to_confirm: number;
  updated_at: string;
  waiting_title: string | null;
  waiting_who: string | null;
}

const me = (ctx: Ctx) => (ctx.actor.type === 'human' ? ctx.actor.userId : null);
/** The deals someone is on: its main agent or on its team. */
const onDealSql = (userId: string | null) =>
  userId
    ? sql`(r.owner_user_id = ${userId}::uuid or ${userId}::uuid = any(r.team_user_ids))`
    : sql`false`;

/** Deals as a list shows them, newest change first, the open ones before the rest. */
async function dealRows(ctx: Ctx, filter: SQL, limit: number) {
  const list = await rows<Row>(
    ctx.tx,
    sql`select d.record_id, r.name, d.side, d.stage, d.outcome, r.archived_at is not null as archived, d.health,
          r.owner_user_id, coalesce(nullif(u.full_name, ''), u.email::text) as owner_name,
          client.person_id as client_id, client.name as client_name,
          prop.id as property_id, prop.name as property_address,
          coalesce(dt.open, 0) as open_duties, coalesce(dt.overdue, 0) as overdue_duties,
          nx.id as next_id, nx.title as next_title, nx.due_at as next_due_at,
          cl.value_date::text as closing,
          d.health_reasons -> 0 ->> 'words' as headline,
          ${onDealSql(me(ctx))} as mine,
          coalesce(uc.n, 0) as dates_to_confirm,
          greatest(d.updated_at, r.updated_at) as updated_at,
          wt.title as waiting_title, wt.who as waiting_who
        from addon_realestate.deals d
        join app.custom_records r on r.id = d.record_id
        left join app.users u on u.id = r.owner_user_id
        left join lateral (
          select p.id as person_id,
                 coalesce(nullif(btrim(p.first_name || ' ' || p.last_name), ''), p.email::text, 'Customer') as name
          from app.relationships rel
          join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_client'
          join app.people p on p.id = rel.a_person_id
          where rel.b_custom_record_id = d.record_id
          order by rel.created_at, rel.id limit 1) client on true
        left join lateral (
          select pr.id, pr.name
          from app.relationships rel
          join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_property_of'
          join app.custom_records pr on pr.id = rel.b_custom_record_id
          where rel.a_custom_record_id = d.record_id
          order by rel.created_at desc, rel.id desc limit 1) prop on true
        left join lateral (
          select count(*)::int as open, (count(*) filter (where t.due_at <= now()))::int as overdue
          from addon_realestate.duties t
          where t.deal_record_id = d.record_id and t.status in ${OPEN}) dt on true
        left join lateral (
          select t.id, t.title, t.due_at
          from addon_realestate.duties t
          where t.deal_record_id = d.record_id and t.status in ${OPEN} and t.due_at is not null
          order by t.due_at, t.id limit 1) nx on true
        left join lateral (
          select e.value_date
          from addon_realestate.term_entries e
          where e.deal_record_id = d.record_id and e.key = 'closing'
            and e.superseded_at is null and e.rejected_at is null
          order by e.entered_at desc, e.id desc limit 1) cl on true
        left join lateral (
          select count(distinct e.key)::int as n
          from addon_realestate.term_entries e
          where e.deal_record_id = d.record_id and e.confirmed_at is null
            and e.superseded_at is null and e.rejected_at is null) uc on true
        left join lateral (
          select t.title, coalesce(t.waiting_on, t.blocker_owner, t.blocker) as who
          from addon_realestate.duties t
          where t.deal_record_id = d.record_id and t.status in ('waiting_external', 'blocked')
          order by coalesce(t.chase_at, t.blocker_review_at) nulls last, t.id limit 1) wt on true
        where d.workspace_id = ${ctx.scope.workspaceId!} and ${filter}
        order by (r.archived_at is null and d.outcome is null) desc, greatest(d.updated_at, r.updated_at) desc,
          d.record_id
        limit ${limit}`,
  );
  return list.map((r) => ({
    dealId: r.record_id,
    name: r.name,
    side: r.side,
    stage: r.stage,
    stageLabel: STAGE_LABELS[r.stage as DealStage] ?? r.stage,
    outcome: r.outcome,
    archived: r.archived,
    health: r.health,
    mainAgent: r.owner_user_id
      ? { userId: r.owner_user_id, name: r.owner_name ?? 'Former member' }
      : null,
    client: r.client_id ? { personId: r.client_id, name: r.client_name ?? 'Customer' } : null,
    property: r.property_id
      ? { propertyId: r.property_id, address: r.property_address ?? '' }
      : null,
    openDuties: r.open_duties,
    overdueDuties: r.overdue_duties,
    nextDue:
      r.next_id && r.next_due_at
        ? { dutyId: r.next_id, title: r.next_title ?? '', dueAt: isoOf(r.next_due_at) }
        : null,
    closing: r.closing,
    headline: r.headline,
    mine: r.mine,
    datesToConfirm: r.dates_to_confirm,
    updatedAt: isoOf(r.updated_at),
    waiting: r.waiting_title ? { title: r.waiting_title, who: r.waiting_who ?? '' } : null,
  }));
}

export const overview = defineAddonQuery(realestateAddon, {
  name: 'realestate.overview',
  description:
    'Real Estate Agent at a glance: open deals in the business and the person’s own, and their overdue and this week’s duties.',
  input: OverviewInput,
  output: OverviewOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  // Offered to the AI behind tool search, only while the add-on is on and the person holds the permission.
  ai: {
    tool: 'realestate_overview',
    description:
      'How many deals are open, how many are the person’s own, and how many of their duties are overdue or due this week.',
  },
  handler: async (ctx) => {
    const mine = onDealSql(me(ctx));
    const [c] = await rows<{ open: number; mine: number; overdue: number; week: number }>(
      ctx.tx,
      sql`select
            (select count(*)::int from addon_realestate.deals d join app.custom_records r on r.id = d.record_id
              where d.workspace_id = ${ctx.scope.workspaceId!} and d.outcome is null and r.archived_at is null) as open,
            (select count(*)::int from addon_realestate.deals d join app.custom_records r on r.id = d.record_id
              where d.workspace_id = ${ctx.scope.workspaceId!} and d.outcome is null and r.archived_at is null
                and ${mine}) as mine,
            (select count(*)::int from addon_realestate.duties t
              join app.custom_records r on r.id = t.deal_record_id
              where t.workspace_id = ${ctx.scope.workspaceId!} and t.status in ${OPEN} and r.archived_at is null
                and t.due_at <= now() and ${mine}) as overdue,
            (select count(*)::int from addon_realestate.duties t
              join app.custom_records r on r.id = t.deal_record_id
              where t.workspace_id = ${ctx.scope.workspaceId!} and t.status in ${OPEN} and r.archived_at is null
                and t.due_at > now() and t.due_at <= now() + interval '7 days' and ${mine}) as week`,
    );
    return {
      name: realestateAddon.name,
      version: realestateAddon.version,
      openDeals: c?.open ?? 0,
      myOpenDeals: c?.mine ?? 0,
      overdueDuties: c?.overdue ?? 0,
      dueThisWeek: c?.week ?? 0,
    };
  },
});

export const dealList = defineAddonQuery(realestateAddon, {
  name: 'realestate.deal.list',
  description:
    'The deals the person sees: open, closed, ended, archived or all; theirs or everyone’s they see; buyer deals or listings; searched by name, client or address.',
  input: DealListInput,
  output: DealListOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_find_deals',
    description:
      'Find deals the person sees: open, closed or ended, theirs or everyone’s, buyer deals or listings, by name, client or address.',
    keywords: ['deals', 'listings', 'buyers', 'my deals'],
  },
  handler: async (ctx, input) => {
    const parts: SQL[] = [];
    if (input.status === 'open') parts.push(sql`r.archived_at is null and d.outcome is null`);
    if (input.status === 'closed') parts.push(sql`r.archived_at is null and d.outcome = 'closed'`);
    if (input.status === 'ended')
      parts.push(sql`r.archived_at is null and d.outcome in ('lost', 'ended', 'terminated')`);
    if (input.status === 'archived') parts.push(sql`r.archived_at is not null`);
    if (input.side) parts.push(sql`d.side = ${input.side}`);
    if (input.mine) parts.push(onDealSql(me(ctx)));
    // Round four: the coordinator's filters.
    if (input.agentUserId) parts.push(sql`r.owner_user_id = ${input.agentUserId}`);
    if (input.stage) parts.push(sql`d.stage = ${input.stage}`);
    if (input.closingWithinDays !== undefined) {
      const today = todayIn(await timeZoneOf(ctx));
      parts.push(
        sql`exists (select 1 from addon_realestate.term_entries e
              where e.deal_record_id = d.record_id and e.key = 'closing'
                and e.superseded_at is null and e.rejected_at is null
                and e.value_date between ${today}::date and ${today}::date + ${input.closingWithinDays}::int)`,
      );
    }
    if (input.waitingOn)
      parts.push(
        sql`exists (select 1 from addon_realestate.duties t where t.deal_record_id = d.record_id
              and t.status in ${
                input.waitingOn === 'outside'
                  ? sql`('waiting_external')`
                  : input.waitingOn === 'blocked'
                    ? sql`('blocked')`
                    : sql`('waiting_external', 'blocked')`
              })`,
      );
    if (input.search) {
      const like = `%${input.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      parts.push(
        sql`(r.name ilike ${like} or client.name ilike ${like} or prop.name ilike ${like})`,
      );
    }
    const filter = parts.length ? sql.join(parts, sql` and `) : sql`true`;
    return { deals: await dealRows(ctx, filter, input.limit) };
  },
});

export const dealsFor = defineAddonQuery(realestateAddon, {
  name: 'realestate.deal.for',
  description:
    'The deals of one customer, company, Pipeline lead or property that the person sees: a panel on its page.',
  input: DealsForInput,
  output: DealsForOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  handler: async (ctx, input) => {
    const on = (end: 'a_person_id' | 'a_company_id', id: string) =>
      sql`exists (select 1 from app.relationships rel
            join app.relationship_types rt on rt.id = rel.type_id and rt.addon_id = 'realestate'
            where rel.b_custom_record_id = d.record_id and rel.${sql.raw(end)} = ${id})`;
    const filter = input.personId
      ? on('a_person_id', input.personId)
      : input.companyId
        ? on('a_company_id', input.companyId)
        : input.leadId
          ? sql`d.lead_id = ${input.leadId}`
          : sql`prop.id = ${input.propertyId!}`;
    return { deals: await dealRows(ctx, filter, 50) };
  },
});

export const propertySearch = defineAddonQuery(realestateAddon, {
  name: 'realestate.property.search',
  description:
    'Properties already here whose address matches, with how many deals each has: to start a deal on a home the business knows.',
  input: PropertySearchInput,
  output: PropertySearchOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  handler: async (ctx, input) => {
    const kinds = await kindIds(ctx);
    const like = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const list = await rows<{ id: string; name: string; deals: number }>(
      ctx.tx,
      sql`select r.id, r.name,
            (select count(*)::int from app.relationships rel
              join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_property_of'
              where rel.b_custom_record_id = r.id) as deals
          from app.custom_records r
          where r.workspace_id = ${ctx.scope.workspaceId!} and r.type_id = ${kinds.property}
            and r.archived_at is null and r.name ilike ${like}
          order by r.name limit ${input.limit}`,
    );
    return {
      properties: list.map((p) => ({ propertyId: p.id, address: p.name, deals: p.deals })),
    };
  },
});

export const dealGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.deal.get',
  description:
    'One deal whole: its stage and facts, team, property, outside parties, linked deals, key dates and terms with any conflicts, checks across its dates, commission and duties.',
  input: DealGetInput,
  output: DealGetOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_get_deal',
    description:
      'Read one deal whole: stage, people, property, key dates and any that disagree, date problems, commission, and every duty with its status, due time and missing proof.',
  },
  handler: async (ctx, input) => {
    const deal = await loadDeal(ctx, input.dealId);
    const [row] = await ctx.tx
      .select({ d: deals, notes: customRecords.notes })
      .from(deals)
      .innerJoin(customRecords, eq(customRecords.id, deals.recordId))
      .where(eq(deals.recordId, deal.recordId));
    const d = row!.d;
    const timeZone = await timeZoneOf(ctx);
    const calendar = await businessCalendarOf(ctx);
    const entries = await termEntriesOf(ctx, deal.recordId);
    const terms = termsNow(entries);
    const keyDates = keyDatesOf(terms);

    const team = await teamOf(ctx, deal);
    const property = await propertyOf(ctx, deal.recordId);
    const parties = await rows<{
      id: string;
      addon_key: string;
      person_id: string | null;
      company_id: string | null;
      name: string | null;
      note: string | null;
    }>(
      ctx.tx,
      sql`select rel.id, rt.addon_key, rel.a_person_id as person_id, rel.a_company_id as company_id,
            coalesce(c.name, nullif(btrim(p.first_name || ' ' || p.last_name), ''), p.email::text) as name,
            rel.note
          from app.relationships rel
          join app.relationship_types rt on rt.id = rel.type_id and rt.addon_id = 'realestate'
          left join app.people p on p.id = rel.a_person_id
          left join app.companies c on c.id = rel.a_company_id
          where rel.workspace_id = ${ctx.scope.workspaceId!} and rel.b_custom_record_id = ${deal.recordId}
            and rt.addon_key <> 'realestate_property_of'
          order by rt.position, rel.created_at, rel.id`,
    );
    const links = await rows<{
      other: string;
      kind: 'same_home' | 'sale_and_purchase';
      name: string;
      side: 'buyer' | 'listing';
      stage: string;
    }>(
      ctx.tx,
      sql`select l.other_record_id as other, l.kind, r.name, o.side, o.stage
          from addon_realestate.deal_links l
          join addon_realestate.deals o on o.record_id = l.other_record_id
          join app.custom_records r on r.id = l.other_record_id
          where l.deal_record_id = ${deal.recordId}
          order by l.created_at`,
    );
    // Through the link's own door: the other deal's key dates, health and agent, even a private one (round four).
    const linked = await linkedFactsOf(ctx, deal.recordId);
    // A client's sale closes before their purchase: its closing date, for the check.
    const sale = linked.find((l) => l.kind === 'sale_and_purchase' && l.side === 'listing');
    const linkedSaleClosing =
      deal.side === 'buyer' && sale ? (sale.keyDates['closing']?.date ?? null) : null;
    const dutyRows = await ctx.tx
      .select()
      .from(duties)
      .where(eq(duties.dealRecordId, deal.recordId))
      .orderBy(asc(duties.dueAt), asc(duties.createdAt), asc(duties.id));
    const names = await userNames(
      ctx,
      dutyRows.map((t) => t.accountableUserId),
    );
    // What each duty still lacks: its proof, against what's on it and what the deal holds.
    const evidence = await rows<{
      duty_id: string;
      kind: EvidenceFact['kind'];
      withdrawn: boolean;
      document_kind: string | null;
      signed: boolean | null;
    }>(
      ctx.tx,
      sql`select e.duty_id, e.kind, e.withdrawn_at is not null as withdrawn, d.kind as document_kind,
            d.signed_at is not null and d.status <> 'void' as signed
          from addon_realestate.duty_evidence e
          left join addon_realestate.documents d on d.id = e.document_id
          where e.deal_record_id = ${deal.recordId}`,
    );
    const proofFacts = await dealProofFactsOf(ctx, deal);
    const missingFor = (t: (typeof dutyRows)[number]) => {
      if (isDoneDuty(t.status as DutyStatus)) return '';
      const rule = (t.definition as unknown as ResolvedDuty).proof;
      const gaps = proofGaps(
        rule,
        evidence
          .filter((e) => e.duty_id === t.id)
          .map((e) => ({
            kind: e.kind,
            withdrawn: e.withdrawn,
            documentKind: e.document_kind,
            signed: e.signed === true,
          })),
        proofFacts,
      );
      return gaps.length ? gapWords(rule, gaps) : '';
    };
    const now = Date.now();
    const can = (p: string) => scopeCan(ctx.scope, p as Permission);

    return {
      deal: {
        dealId: deal.recordId,
        name: deal.name,
        notes: row!.notes,
        side: deal.side,
        stage: deal.stage,
        stageLabel: STAGE_LABELS[deal.stage] ?? deal.stage,
        stageEnteredAt: d.stageEnteredAt.toISOString(),
        outcome: deal.outcome,
        outcomeAt: deal.outcomeAt?.toISOString() ?? null,
        outcomeReason: deal.outcomeReason,
        archived: !!deal.archivedAt,
        leadId: deal.leadId,
        facts: [...deal.facts],
        health: d.health,
        healthReasons: d.healthReasons,
        catalogVersion: d.catalogVersion,
        templateSetId: d.templateSetId,
        createdAt: d.createdAt.toISOString(),
      },
      can: {
        changeTeam: mayChangeTeam(ctx, deal),
        chooseMainAgent: can('records.assign'),
        except: can('realestate.except'),
        archive: can('records.archive'),
      },
      team,
      property,
      parties: parties.map((p) => {
        const role = p.addon_key.replace(/^realestate_/, '') as PartyRole;
        return {
          relationshipId: p.id,
          role,
          label: PARTY_ROLES[role]?.label ?? role,
          personId: p.person_id,
          companyId: p.company_id,
          name: p.name ?? 'Someone',
          note: p.note,
        };
      }),
      links: linked.map((l) => ({
        otherDealId: l.otherId,
        kind: l.kind,
        name: l.name,
        side: l.side,
        stage: l.stage,
        stageLabel: STAGE_LABELS[l.stage as DealStage] ?? l.stage,
        health: l.health,
        agentName: l.agentName,
        keyDates: Object.entries(l.keyDates)
          .filter(([k]) => k in KEY_DATES)
          .map(([k, v]) => ({
            key: k,
            label: KEY_DATES[k as KeyDateKey].label,
            date: v.date,
            confirmed: v.confirmed ?? false,
          }))
          .sort((a, b) => a.date.localeCompare(b.date)),
        canOpen: links.some((x) => x.other === l.otherId),
      })),
      linkedProblems: linked.flatMap((l) =>
        linkedProblems(
          { side: deal.side, keyDates: keyDates as LinkedDates },
          {
            name: l.name,
            side: l.side,
            kind: l.kind,
            agentName: l.agentName,
            keyDates: l.keyDates,
          },
        ).map((p) => ({ words: p.words, next: p.next })),
      ),
      terms: TERM_KEYS.filter((k) => terms.has(k)).map((k) => {
        const t = terms.get(k)!;
        return {
          key: k,
          label: termLabel(k),
          kind: termKind(k),
          conflict: t.conflict,
          confirmed: t.confirmed,
          entries: t.live.map((e) => ({
            entryId: e.id,
            date: e.valueDate,
            time: e.valueTime,
            cents: e.valueCents,
            text: e.valueText,
            source: e.source,
            sourceRef: e.sourceRef,
            enteredAt: e.enteredAt,
            confirmed: e.confirmedAt !== null,
          })),
        };
      }),
      dateProblems: checkDealDates({
        side: deal.side,
        keyDates,
        calendar,
        financed: deal.facts.includes('financed'),
        linkedSaleClosing,
        today: todayIn(timeZone),
      }).map((p) => ({ check: p.check, severity: p.severity, keys: [...p.keys], words: p.words })),
      commission: commissionView({ ...deal, finalCommissionAt: d.finalCommissionAt }, terms),
      duties: dutyRows.map((t) => ({
        dutyId: t.id,
        key: t.dutyKey,
        pass: t.pass,
        title: t.title,
        tracker: t.tracker,
        status: t.status as DutyStatus,
        overdue: isOverdue(
          { status: t.status as DutyStatus, dueAt: t.dueAt?.toISOString() ?? null },
          now,
        ),
        materiality: t.materiality,
        automation: t.automation,
        accountableRole: t.accountableRole,
        accountable: t.accountableUserId
          ? { userId: t.accountableUserId, name: names.get(t.accountableUserId) ?? 'Former member' }
          : null,
        startedBy: t.startedBy,
        dueState: t.dueState as 'due' | 'none' | 'waiting',
        dueAt: t.dueAt?.toISOString() ?? null,
        dueDate: t.dueDate,
        dueTime: t.dueTime,
        needsDates: t.needsDates,
        warnings: t.dueWarnings,
        proof: (t.definition as unknown as ResolvedDuty).proof
          ? proofRuleWords((t.definition as unknown as ResolvedDuty).proof)
          : '',
        proofMissing: missingFor(t),
        waitingOn: t.waitingOn,
        blocked: t.status === 'blocked' ? (t.blocker ?? '') : null,
      })),
    };
  },
});

export const dealHistoryQuery = defineAddonQuery(realestateAddon, {
  name: 'realestate.deal.history',
  description:
    'What happened on a deal, newest first: who did it (a person, HandsFreeOS or the AI), what changed from what, and why.',
  input: DealHistoryInput,
  output: DealHistoryOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  handler: async (ctx, input) => {
    const deal = await loadDeal(ctx, input.dealId);
    const lines = await ctx.tx
      .select()
      .from(dealHistory)
      .where(
        and(
          eq(dealHistory.dealRecordId, deal.recordId),
          input.before ? lt(dealHistory.at, new Date(input.before)) : undefined,
        ),
      )
      .orderBy(desc(dealHistory.at), desc(dealHistory.createdAt))
      .limit(input.limit);
    const names = await userNames(
      ctx,
      lines.map((l) => l.actorUserId),
    );
    return {
      lines: lines.map((l) => ({
        at: l.at.toISOString(),
        what: l.what,
        actorType: l.actorType,
        actor: l.actorUserId
          ? { userId: l.actorUserId, name: names.get(l.actorUserId) ?? 'Former member' }
          : null,
        before: l.before,
        after: l.after,
        note: l.note,
      })),
    };
  },
});

export const termHistory = defineAddonQuery(realestateAddon, {
  name: 'realestate.term.history',
  description:
    'Every value a deal’s key dates and terms have had: where each came from, who entered and confirmed it, and what replaced it or why it was set aside.',
  input: TermHistoryInput,
  output: TermHistoryOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_date_history',
    description:
      'Every value a deal’s key dates and terms have had, where each came from and who confirmed it.',
  },
  handler: async (ctx, input) => {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await ctx.tx
      .select()
      .from(termEntries)
      .where(
        and(
          eq(termEntries.dealRecordId, deal.recordId),
          input.key ? eq(termEntries.key, input.key) : undefined,
        ),
      )
      .orderBy(desc(termEntries.enteredAt));
    const names = await userNames(
      ctx,
      list.flatMap((e) => [e.enteredBy, e.confirmedBy]),
    );
    const who = (id: string | null) =>
      id ? { userId: id, name: names.get(id) ?? 'Former member' } : null;
    return {
      entries: list.map((e) => ({
        entryId: e.id,
        key: e.key,
        label: isTermKey(e.key) ? termLabel(e.key as TermKey) : e.key,
        date: e.valueDate,
        time: e.valueTime,
        cents: e.valueCents,
        text: e.valueText,
        source: e.source,
        sourceRef: e.sourceRef,
        documentId: e.documentId,
        note: e.note,
        enteredBy: who(e.enteredBy),
        enteredAt: e.enteredAt.toISOString(),
        confirmedBy: who(e.confirmedBy),
        confirmedAt: e.confirmedAt?.toISOString() ?? null,
        supersededAt: e.supersededAt?.toISOString() ?? null,
        rejectedAt: e.rejectedAt?.toISOString() ?? null,
        rejectedReason: e.rejectedReason,
        live: isLive(e),
      })),
    };
  },
});

export const realestateQueries = [
  overview,
  dealList,
  dealsFor,
  propertySearch,
  dealGet,
  dealHistoryQuery,
  termHistory,
];
