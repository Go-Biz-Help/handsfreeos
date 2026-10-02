/**
 * The coordinator's views (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round four", step 7). Chris decided
 * (2026-10-02): Today, Exceptions, the Waiting room and Team workload. The round's exit outcome: exceptions replace
 * checking duties by hand.
 *
 * Each looks only at the deals the person sees: those they're on, or every deal with See every deal (row security
 * decides). Workload, about people rather than deals, needs See every deal.
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { scopeCan } from '../../../kernel/execute';
import type { Permission } from '../../../permissions';
import { defineAddonQuery } from '../../server';
import { contingencyClock, contingencyLabel, type ContingencyKind } from '../contingencies';
import { businessDaysBetween } from '../dates/business-days';
import { KEY_DATES, type KeyDateKey } from '../dates/key-dates';
import type { HealthReason } from '../health';
import { realestateAddon } from '../manifest';
import {
  CoordinateInput,
  ExceptionsOutput,
  TodayOutput,
  WaitingRoomOutput,
  WorkloadOutput,
} from '../schemas';
import type { DutyStatus } from '../states';
import {
  businessCalendarOf,
  inWorkspace,
  timeZoneOf,
  todayIn,
  userNames,
  type Ctx,
} from './common';

const RANK = { critical: 0, material: 1, standard: 2 } as const;

/** The open duties of the deals the person sees, with their deal's name and health. */
async function openDutiesOf(
  ctx: Ctx,
  input: { readonly agentUserId?: string | undefined; readonly mine?: boolean | undefined },
) {
  const me = ctx.actor.type === 'human' ? ctx.actor.userId : null;
  return rows<{
    id: string;
    deal: string;
    name: string;
    title: string;
    status: DutyStatus;
    materiality: 'standard' | 'material' | 'critical';
    accountable: string | null;
    accountable_role: string;
    due_at: string | null;
    due_date: string | null;
    waiting_on: string | null;
    waiting_since: string | null;
    chase_at: string | null;
    blocker: string | null;
    blocker_owner: string | null;
    blocker_review_at: string | null;
    updated_at: string;
    at_risk_since: string | null;
    escalated_at: string | null;
    acknowledged_at: string | null;
  }>(
    ctx.tx,
    sql`select t.id, t.deal_record_id as deal, r.name, t.title, t.status, t.materiality,
          t.accountable_user_id as accountable, t.accountable_role, t.due_at::text, t.due_date::text,
          t.waiting_on, t.waiting_since::text, t.chase_at::text, t.blocker, t.blocker_owner,
          t.blocker_review_at::text, t.updated_at::text, t.at_risk_since::text, t.escalated_at::text,
          t.acknowledged_at::text
        from addon_realestate.duties t
        join addon_realestate.deals d on d.workspace_id = t.workspace_id and d.record_id = t.deal_record_id
        join app.custom_records r on r.id = t.deal_record_id
        where t.workspace_id = ${ctx.scope.workspaceId!} and r.archived_at is null and d.outcome is null
          and t.status in ('not_started', 'in_progress', 'waiting_external', 'blocked')
          ${input.agentUserId ? sql`and r.owner_user_id = ${input.agentUserId}` : sql``}
          ${
            input.mine
              ? me
                ? sql`and (t.accountable_user_id = ${me} or r.owner_user_id = ${me}
                    or exists (select 1 from addon_realestate.deal_roles x
                               where x.deal_record_id = t.deal_record_id and x.user_id = ${me}))`
                : sql`and false`
              : sql``
          }`,
  );
}

/** The deals the person sees, with their stored health. */
async function dealsOf(ctx: Ctx, input: { readonly agentUserId?: string | undefined }) {
  return rows<{
    id: string;
    name: string;
    health: 'green' | 'yellow' | 'red';
    reasons: HealthReason[];
    owner: string | null;
  }>(
    ctx.tx,
    sql`select d.record_id as id, r.name, d.health, d.health_reasons as reasons, r.owner_user_id as owner
        from addon_realestate.deals d
        join app.custom_records r on r.id = d.record_id
        where d.workspace_id = ${ctx.scope.workspaceId!} and r.archived_at is null and d.outcome is null
          ${input.agentUserId ? sql`and r.owner_user_id = ${input.agentUserId}` : sql``}
        order by r.name`,
  );
}

/** Health reasons that aren't about one duty being late: what Today lists as at risk. */
const DEAL_RISKS: ReadonlySet<string> = new Set([
  'date_conflict',
  'date_problem',
  'wire_hold',
  'closing_with_open_work',
  'contingency_passed',
  'linked_conflict',
  'contingency_ending',
  'prerequisite_open',
]);

export const coordinateToday = defineAddonQuery(realestateAddon, {
  name: 'realestate.today',
  description:
    'Today across the deals the person sees: what’s at risk (escalated duties, dates that disagree, contingencies ending or passed), what’s overdue and what’s due today, the most serious first.',
  input: CoordinateInput,
  output: TodayOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_today',
    description: 'What needs doing today across the deals: at risk, overdue and due today.',
    keywords: ['today', 'coordinator', 'overdue', 'at risk'],
  },
  async handler(ctx, input) {
    const timeZone = await timeZoneOf(ctx);
    const today = todayIn(timeZone);
    const now = Date.now();
    const [list, deals] = await Promise.all([openDutiesOf(ctx, input), dealsOf(ctx, input)]);
    const names = await userNames(
      ctx,
      list.map((d) => d.accountable),
    );
    const healthOf = new Map(deals.map((d) => [d.id, d.health]));
    const line = (d: (typeof list)[number]) => ({
      dutyId: d.id,
      dealId: d.deal,
      dealName: d.name,
      title: d.title,
      status: d.status,
      materiality: d.materiality,
      accountableName: d.accountable ? (names.get(d.accountable) ?? null) : null,
      dueAt: d.due_at ? new Date(d.due_at).toISOString() : null,
      health: healthOf.get(d.deal) ?? 'green',
      escalated: !!d.escalated_at && !d.acknowledged_at,
      acknowledged: !!d.acknowledged_at,
    });
    const byWeight = <T extends { materiality: keyof typeof RANK; dueAt: string | null }>(
      a: T,
      b: T,
    ) => RANK[a.materiality] - RANK[b.materiality] || (a.dueAt ?? '').localeCompare(b.dueAt ?? '');
    const overdue = list
      .filter((d) => d.due_at && Date.parse(d.due_at) <= now)
      .map(line)
      .sort(byWeight);
    const dueToday = list
      .filter((d) => d.due_at && Date.parse(d.due_at) > now && d.due_date === today)
      .map(line)
      .sort(byWeight);
    const atRisk = [
      ...list
        .filter((d) => d.escalated_at && !d.acknowledged_at)
        .map((d) => ({
          kind: 'duty' as const,
          dealId: d.deal,
          dealName: d.name,
          dutyId: d.id,
          words: `“${d.title}” has been at risk for a business day, and nobody acknowledged it.`,
          next: 'Acknowledge it, then do it or say what’s in the way.',
          level: 'red' as const,
          health: healthOf.get(d.deal) ?? 'green',
        })),
      ...deals.flatMap((deal) =>
        (deal.reasons ?? [])
          .filter((r) => DEAL_RISKS.has(r.code))
          .map((r) => ({
            kind: 'reason' as const,
            dealId: deal.id,
            dealName: deal.name,
            dutyId: r.dutyId ?? null,
            words: r.words,
            next: r.next,
            level: r.level,
            health: deal.health,
          })),
      ),
    ].sort((a, b) => Number(b.level === 'red') - Number(a.level === 'red'));
    return { today, atRisk, overdue, dueToday };
  },
});

export const coordinateExceptions = defineAddonQuery(realestateAddon, {
  name: 'realestate.exceptions',
  description:
    'What checking duties by hand used to find, across the deals the person sees: values read from contracts waiting, dates or terms that disagree, duties nobody answers for, material work due soon with no proof, contingencies past their end, linked deals that disagree, and blockers past their review.',
  input: CoordinateInput,
  output: ExceptionsOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_exceptions',
    description: 'What disagrees, is missing or has passed across the deals.',
    keywords: ['exceptions', 'missing', 'disagree', 'coordinator'],
  },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const timeZone = await timeZoneOf(ctx);
    const calendar = await businessCalendarOf(ctx);
    const today = todayIn(timeZone);
    const now = Date.now();
    const deals = await dealsOf(ctx, input);
    const seen = new Set(deals.map((d) => d.id));
    const reads = (
      await rows<{
        id: string;
        deal: string;
        name: string;
        title: string;
        scan: boolean;
        waiting: number;
        kind: string;
      }>(
        ctx.tx,
        sql`select c.id, c.deal_record_id as deal, r.name, doc.title, c.scan, c.kind,
              (select count(*) from jsonb_array_elements(c.found) v where v ->> 'state' = 'waiting')::int as waiting
            from addon_realestate.contract_reads c
            join addon_realestate.documents doc on doc.id = c.document_id
            join app.custom_records r on r.id = c.deal_record_id
            where c.workspace_id = ${ws} and c.state = 'read'
            order by c.scan desc, c.requested_at`,
      )
    ).filter((r) => r.waiting > 0 && seen.has(r.deal));
    const disagree = deals.flatMap((d) =>
      (d.reasons ?? [])
        .filter(
          (r) =>
            r.code === 'date_conflict' || r.code === 'date_problem' || r.code === 'linked_conflict',
        )
        .map((r) => ({
          dealId: d.id,
          dealName: d.name,
          words: r.words,
          next: r.next,
          linked: r.code === 'linked_conflict',
        })),
    );
    const open = (await openDutiesOf(ctx, input)).filter((d) => seen.has(d.deal));
    const names = await userNames(
      ctx,
      open.map((d) => d.accountable),
    );
    const nobody = open
      .filter((d) => !d.accountable && d.accountable_role !== 'broker')
      .map((d) => ({ dealId: d.deal, dealName: d.name, dutyId: d.id, title: d.title }));
    // Material work due within three business days, or overdue, still missing its proof.
    const soon = open.filter(
      (d) =>
        d.materiality !== 'standard' &&
        d.due_date &&
        businessDaysBetween(today, d.due_date, calendar) <= 3,
    );
    const noProof = [];
    if (soon.length) {
      const missing = await rows<{ id: string; missing: boolean }>(
        ctx.tx,
        sql`select t.id, not exists (
              select 1 from addon_realestate.duty_evidence e
              where e.duty_id = t.id and e.withdrawn_at is null) as missing
            from addon_realestate.duties t
            where t.id = any(${`{${soon.map((d) => d.id).join(',')}}`}::uuid[])
              and (t.definition -> 'proof') is not null and (t.definition -> 'proof') <> 'null'::jsonb`,
      );
      for (const d of soon)
        if (missing.find((m) => m.id === d.id)?.missing)
          noProof.push({
            dealId: d.deal,
            dealName: d.name,
            dutyId: d.id,
            title: d.title,
            dueAt: d.due_at ? new Date(d.due_at).toISOString() : null,
            accountableName: d.accountable ? (names.get(d.accountable) ?? null) : null,
          });
    }
    const passed = (
      await rows<{
        id: string;
        deal: string;
        name: string;
        kind: ContingencyKind;
        label: string | null;
        end_key: string | null;
        ends_on: string | null;
      }>(
        ctx.tx,
        sql`select c.id, c.deal_record_id as deal, r.name, c.kind, c.label, c.end_key, c.ends_on::text
            from addon_realestate.contingencies c
            join app.custom_records r on r.id = c.deal_record_id
            where c.workspace_id = ${ws} and c.state = 'open'`,
      )
    ).filter((c) => seen.has(c.deal));
    const endDates = passed.length
      ? await rows<{ deal: string; key: string; date: string }>(
          ctx.tx,
          sql`select distinct on (deal_record_id, key) deal_record_id as deal, key, value_date::text as date
              from addon_realestate.term_entries
              where deal_record_id = any(${`{${[...new Set(passed.map((c) => c.deal))].join(',')}}`}::uuid[])
                and value_date is not null and superseded_at is null and rejected_at is null
              order by deal_record_id, key, entered_at desc`,
        )
      : [];
    const contingencies = passed
      .map((c) => {
        const end =
          c.kind === 'other'
            ? c.ends_on
            : (endDates.find((e) => e.deal === c.deal && e.key === c.end_key)?.date ?? null);
        return { c, end };
      })
      .filter(({ end }) => contingencyClock(end, today, calendar) === 'passed')
      .map(({ c, end }) => ({
        dealId: c.deal,
        dealName: c.name,
        contingencyId: c.id,
        label: contingencyLabel(c),
        endedOn: end!,
      }));
    const blocked = open
      .filter(
        (d) =>
          d.status === 'blocked' && d.blocker_review_at && Date.parse(d.blocker_review_at) <= now,
      )
      .map((d) => ({
        dealId: d.deal,
        dealName: d.name,
        dutyId: d.id,
        title: d.title,
        blocker: d.blocker ?? '',
        owner: d.blocker_owner,
        reviewAt: new Date(d.blocker_review_at!).toISOString(),
      }));
    return {
      reads: reads.map((r) => ({
        dealId: r.deal,
        dealName: r.name,
        readId: r.id,
        documentTitle: r.title,
        waiting: r.waiting,
        scan: r.scan,
      })),
      disagree,
      nobodyAccountable: nobody,
      noProof,
      contingencies,
      blocked,
    };
  },
});

export const coordinateWaitingRoom = defineAddonQuery(realestateAddon, {
  name: 'realestate.waiting_room',
  description:
    'What’s waiting on someone outside, or blocked, across the deals the person sees: who, since when, and when to chase or look again; past its day first.',
  input: CoordinateInput,
  output: WaitingRoomOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_waiting_room',
    description: 'What’s waiting on someone outside or blocked, and when to chase.',
    keywords: ['waiting', 'blocked', 'chase', 'coordinator'],
  },
  async handler(ctx, input) {
    const now = Date.now();
    const list = (await openDutiesOf(ctx, input)).filter(
      (d) => d.status === 'waiting_external' || d.status === 'blocked',
    );
    const names = await userNames(
      ctx,
      list.map((d) => d.accountable),
    );
    const items = list.map((d) => {
      const next = d.status === 'blocked' ? d.blocker_review_at : d.chase_at;
      return {
        dutyId: d.id,
        dealId: d.deal,
        dealName: d.name,
        title: d.title,
        status: d.status as 'waiting_external' | 'blocked',
        waitingOn:
          d.status === 'blocked' ? (d.blocker_owner ?? d.blocker ?? '') : (d.waiting_on ?? ''),
        blocker: d.status === 'blocked' ? d.blocker : null,
        since: new Date(d.waiting_since ?? d.updated_at).toISOString(),
        next: next ? new Date(next).toISOString() : null,
        past: !!next && Date.parse(next) <= now,
        accountableName: d.accountable ? (names.get(d.accountable) ?? null) : null,
      };
    });
    items.sort(
      (a, b) =>
        Number(b.past) - Number(a.past) || (a.next ?? '9999').localeCompare(b.next ?? '9999'),
    );
    return { items };
  },
});

export const coordinateWorkload = defineAddonQuery(realestateAddon, {
  name: 'realestate.workload',
  description:
    'Who has what across every deal: each person’s deals, open duties, overdue ones, ones due within two business days, and deals at risk. For people who can see every deal.',
  input: CoordinateInput,
  output: WorkloadOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    if (!scopeCan(ctx.scope, 'realestate.all_deals' as Permission))
      throw HfosError.forbidden(
        'Team workload shows everyone’s deals, so it needs See every deal. Ask an owner or admin for it.',
        'realestate_workload_permission',
      );
    const timeZone = await timeZoneOf(ctx);
    const calendar = await businessCalendarOf(ctx);
    const today = todayIn(timeZone);
    const now = Date.now();
    const people = await rows<{ user_id: string; role: string }>(
      ctx.tx,
      sql`select user_id, role from private.realestate_team(${ctx.scope.workspaceId!}::uuid)`,
    );
    const [open, deals, onDeals] = await Promise.all([
      openDutiesOf(ctx, input),
      dealsOf(ctx, input),
      rows<{ user_id: string; deal: string }>(
        ctx.tx,
        sql`select x.user_id, x.deal_record_id as deal from addon_realestate.deal_roles x
            where x.workspace_id = ${ctx.scope.workspaceId!}`,
      ),
    ]);
    const names = await userNames(
      ctx,
      people.map((p) => p.user_id),
    );
    const rowsOut = people.map((p) => {
      const mine = open.filter((d) => d.accountable === p.user_id);
      const dealIds = new Set([
        ...deals.filter((d) => d.owner === p.user_id).map((d) => d.id),
        ...onDeals.filter((x) => x.user_id === p.user_id).map((x) => x.deal),
      ]);
      const live = deals.filter((d) => dealIds.has(d.id));
      return {
        userId: p.user_id,
        name: names.get(p.user_id) ?? 'Former member',
        role: p.role,
        deals: live.length,
        openDuties: mine.length,
        overdue: mine.filter((d) => d.due_at && Date.parse(d.due_at) <= now).length,
        dueSoon: mine.filter(
          (d) =>
            d.due_at &&
            Date.parse(d.due_at) > now &&
            d.due_date &&
            businessDaysBetween(today, d.due_date, calendar) <= 2,
        ).length,
        atRiskDeals: live.filter((d) => d.health === 'red').length,
      };
    });
    rowsOut.sort(
      (a, b) =>
        b.overdue - a.overdue || b.openDuties - a.openDuties || a.name.localeCompare(b.name),
    );
    return { people: rowsOut };
  },
});

export const coordinateQueries = [
  coordinateToday,
  coordinateExceptions,
  coordinateWaitingRoom,
  coordinateWorkload,
];

/** A key date's name, for words that mention one. */
export const dateName = (key: string) => KEY_DATES[key as KeyDateKey]?.label ?? key;
