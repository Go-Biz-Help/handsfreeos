/**
 * The coordinator's views from a phone's copy (Real Estate round six, step 13): Today, Exceptions and the Waiting
 * room, as `realestate.today`, `realestate.exceptions` and `realestate.waiting_room` answer them (ops/coordinate.ts),
 * worked out from the rows the phone keeps and the business's closed days (its `_settings` row).
 * `packages/core/test/addons/realestate-phone-views.test.ts` holds each to the server's answer.
 *
 * Someone who sees every deal keeps the deals they aren't on as summaries: their duties and health, not their proof,
 * contingencies or contract reads. Exceptions says so (`partial`), and lists those only for the deals held whole.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import { contingencyClock, contingencyLabel, type ContingencyKind } from '../contingencies';
import { businessDaysBetween, calendarOf } from '../dates/business-days';
import type { HealthReason } from '../health';
import type {
  CoordinateInput,
  ExceptionsOutput,
  TodayOutput,
  WaitingRoomOutput,
  WorkloadOutput,
} from '../schemas';
import type { DutyStatus } from '../states';
import { holdsWhole, isoOr } from './deal-facts';
import { byName, byText, iso, text, type CopyDuty, type RealestateCopy } from './synced';

export type CoordinateFilter = Partial<Omit<z.input<typeof CoordinateInput>, 'workspaceId'>>;
export type TodayView = z.infer<typeof TodayOutput>;
export type ExceptionsView = z.infer<typeof ExceptionsOutput> & { readonly partial: boolean };
export type WaitingRoomView = z.infer<typeof WaitingRoomOutput>;
export type WorkloadView = z.infer<typeof WorkloadOutput>;
export interface CoordinateContext {
  readonly userId: string | null;
  readonly now: number;
  /** The business's today (YYYY-MM-DD). */
  readonly today: string;
}

const RANK = { critical: 0, material: 1, standard: 2 } as const;
const WORKING = new Set(['not_started', 'in_progress', 'waiting_external', 'blocked']);
/** Health reasons that aren't about one duty being late: what Today lists as at risk (as on the server). */
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

interface OpenDuty extends CopyDuty {
  readonly name: string;
  readonly row: Readonly<Record<string, unknown>>;
}

/** The open deals the person's phone holds, by name, with their stored health. */
function openDeals(copy: RealestateCopy, f: CoordinateFilter) {
  return [...copy.deals.values()]
    .filter((d) => !d.archived && (d.data.outcome === null || d.data.outcome === undefined))
    .filter((d) => !f.agentUserId || d.ownerUserId === f.agentUserId)
    .map((d) => ({
      id: d.id,
      name: d.name,
      health: (text(d.data.health) ?? 'green') as 'green' | 'yellow' | 'red',
      reasons: (Array.isArray(d.data.health_reasons)
        ? d.data.health_reasons
        : []) as HealthReason[],
      owner: d.ownerUserId,
    }))
    .sort((a, b) => byName(a.name, b.name) || byText(a.id, b.id));
}

/** The duties being worked on those deals, soonest due first. */
function openDuties(copy: RealestateCopy, f: CoordinateFilter, ctx: CoordinateContext): OpenDuty[] {
  const out: OpenDuty[] = [];
  for (const d of copy.deals.values()) {
    if (d.archived || (d.data.outcome !== null && d.data.outcome !== undefined)) continue;
    if (f.agentUserId && d.ownerUserId !== f.agentUserId) continue;
    const onIt =
      ctx.userId !== null &&
      (d.ownerUserId === ctx.userId ||
        copy.rows('deal_roles', d.id).some((r) => text(r.data.user_id) === ctx.userId));
    const rows = new Map(copy.rows('duties', d.id).map((r) => [r.id, r.data]));
    for (const t of copy.duties.get(d.id) ?? []) {
      if (!WORKING.has(t.status)) continue;
      if (f.mine && !(ctx.userId !== null && (t.accountableUserId === ctx.userId || onIt)))
        continue;
      out.push({ ...t, name: d.name, row: rows.get(t.id) ?? {} });
    }
  }
  return out.sort(
    (a, b) =>
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) ||
      a.createdAt - b.createdAt ||
      byText(a.id, b.id),
  );
}

const isSet = (v: unknown) => v !== null && v !== undefined;
const nameOf = (copy: RealestateCopy, id: string | null) => (id ? copy.user(id) : null);

export function todayOfCopy(
  copy: RealestateCopy,
  f: CoordinateFilter,
  ctx: CoordinateContext,
): TodayView {
  const list = openDuties(copy, f, ctx);
  const deals = openDeals(copy, f);
  const healthOf = new Map(deals.map((d) => [d.id, d.health]));
  const line = (d: OpenDuty) => ({
    dutyId: d.id,
    dealId: d.dealId,
    dealName: d.name,
    title: d.title,
    status: d.status as DutyStatus,
    materiality: d.materiality as keyof typeof RANK,
    accountableName: nameOf(copy, d.accountableUserId),
    dueAt: d.dueAt === null ? null : iso(d.dueAt),
    health: healthOf.get(d.dealId) ?? 'green',
    escalated: isSet(d.row.escalated_at) && !isSet(d.row.acknowledged_at),
    acknowledged: isSet(d.row.acknowledged_at),
  });
  const byWeight = <T extends { materiality: keyof typeof RANK; dueAt: string | null }>(
    a: T,
    b: T,
  ) => RANK[a.materiality] - RANK[b.materiality] || (a.dueAt ?? '').localeCompare(b.dueAt ?? '');
  const overdue = list
    .filter((d) => d.dueAt !== null && d.dueAt <= ctx.now)
    .map(line)
    .sort(byWeight);
  const dueToday = list
    .filter((d) => d.dueAt !== null && d.dueAt > ctx.now && text(d.row.due_date) === ctx.today)
    .map(line)
    .sort(byWeight);
  const atRisk = [
    ...list
      .filter((d) => isSet(d.row.escalated_at) && !isSet(d.row.acknowledged_at))
      .map((d) => ({
        kind: 'duty' as const,
        dealId: d.dealId,
        dealName: d.name,
        dutyId: d.id as string | null,
        words: `“${d.title}” has been at risk for a business day, and nobody acknowledged it.`,
        next: 'Acknowledge it, then do it or say what’s in the way.',
        level: 'red' as 'red' | 'yellow',
        health: healthOf.get(d.dealId) ?? ('green' as const),
      })),
    ...deals.flatMap((deal) =>
      deal.reasons
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
  return { today: ctx.today, atRisk, overdue, dueToday } as TodayView;
}

export function exceptionsOfCopy(
  copy: RealestateCopy,
  f: CoordinateFilter,
  ctx: CoordinateContext,
): ExceptionsView {
  const calendar = calendarOf(copy.settings.closedDays);
  const deals = openDeals(copy, f);
  const whole = new Set(deals.filter((d) => holdsWhole(copy, d.id, ctx.userId)).map((d) => d.id));
  const partial = deals.some((d) => !whole.has(d.id));

  // Values read from a contract, still waiting for a person: every read of every deal held whole, as the server orders them.
  const reads = deals
    .filter((d) => whole.has(d.id))
    .flatMap((d) => {
      const docs = new Map(copy.rows('documents', d.id).map((r) => [r.id, r.data]));
      return copy.rows('contract_reads', d.id).flatMap(({ id, data: c }) => {
        const doc = docs.get(text(c.document_id) ?? '');
        if (text(c.state) !== 'read' || !doc) return [];
        const found = Array.isArray(c.found) ? (c.found as { state?: unknown }[]) : [];
        const waiting = found.filter((v) => v && v.state === 'waiting').length;
        if (waiting === 0) return [];
        return [
          {
            id,
            at: isoOr(c.requested_at) ?? '',
            row: {
              dealId: d.id,
              dealName: d.name,
              readId: id,
              documentTitle: text(doc.title) ?? '',
              waiting,
              scan: c.scan === true,
            },
          },
        ];
      });
    })
    .sort(
      (a, b) => Number(b.row.scan) - Number(a.row.scan) || byText(a.at, b.at) || byText(a.id, b.id),
    )
    .map((r) => r.row);

  const disagree = deals.flatMap((d) =>
    d.reasons
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
  const seen = new Set(deals.map((d) => d.id));
  const open = openDuties(copy, f, ctx).filter((d) => seen.has(d.dealId));
  const nobodyAccountable = open
    .filter((d) => !d.accountableUserId && text(d.row.accountable_role) !== 'broker')
    .map((d) => ({ dealId: d.dealId, dealName: d.name, dutyId: d.id, title: d.title }));

  // Material work due within three business days, or overdue, still missing its proof: on deals held whole.
  const proved = new Set<string>();
  for (const id of whole)
    for (const { data: e } of copy.rows('duty_evidence', id))
      if (!isSet(e.withdrawn_at)) proved.add(text(e.duty_id) ?? '');
  const noProof = open
    .filter(
      (d) =>
        whole.has(d.dealId) &&
        d.materiality !== 'standard' &&
        text(d.row.due_date) !== null &&
        businessDaysBetween(ctx.today, text(d.row.due_date)!, calendar) <= 3 &&
        isSet((d.row.definition as { proof?: unknown } | null)?.proof) &&
        !proved.has(d.id),
    )
    .map((d) => ({
      dealId: d.dealId,
      dealName: d.name,
      dutyId: d.id,
      title: d.title,
      dueAt: d.dueAt === null ? null : iso(d.dueAt),
      accountableName: nameOf(copy, d.accountableUserId),
    }));

  // Contingencies past their end and still open: on deals held whole.
  const contingencies = deals
    .filter((d) => whole.has(d.id))
    .flatMap((d) => {
      const latest = new Map<string, { date: string; at: string; id: string }>();
      for (const { id, data: e } of copy.rows('term_entries', d.id)) {
        const date = text(e.value_date);
        const key = text(e.key) ?? '';
        if (!date || isSet(e.superseded_at) || isSet(e.rejected_at)) continue;
        const at = isoOr(e.entered_at) ?? '';
        const was = latest.get(key);
        if (!was || at > was.at || (at === was.at && byText(id, was.id) > 0))
          latest.set(key, { date, at, id });
      }
      return copy.rows('contingencies', d.id).flatMap(({ id, data: c }) => {
        if (text(c.state) !== 'open') return [];
        const kind = text(c.kind) as ContingencyKind;
        const end =
          kind === 'other' ? text(c.ends_on) : (latest.get(text(c.end_key) ?? '')?.date ?? null);
        if (contingencyClock(end, ctx.today, calendar) !== 'passed') return [];
        return [
          {
            dealId: d.id,
            dealName: d.name,
            contingencyId: id,
            label: contingencyLabel({ kind, label: text(c.label) }),
            endedOn: end!,
          },
        ];
      });
    });

  const blocked = open
    .filter((d) => {
      const review = isoOr(d.row.blocker_review_at);
      return d.status === 'blocked' && review !== null && Date.parse(review) <= ctx.now;
    })
    .map((d) => ({
      dealId: d.dealId,
      dealName: d.name,
      dutyId: d.id,
      title: d.title,
      blocker: text(d.row.blocker) ?? '',
      owner: text(d.row.blocker_owner),
      reviewAt: isoOr(d.row.blocker_review_at)!,
    }));

  return { reads, disagree, nobodyAccountable, noProof, contingencies, blocked, partial };
}

export function waitingRoomOfCopy(
  copy: RealestateCopy,
  f: CoordinateFilter,
  ctx: CoordinateContext,
): WaitingRoomView {
  const items = openDuties(copy, f, ctx)
    .filter((d) => d.status === 'waiting_external' || d.status === 'blocked')
    .map((d) => {
      const blocked = d.status === 'blocked';
      const next = isoOr(blocked ? d.row.blocker_review_at : d.row.chase_at);
      return {
        dutyId: d.id,
        dealId: d.dealId,
        dealName: d.name,
        title: d.title,
        status: d.status as 'waiting_external' | 'blocked',
        waitingOn: blocked
          ? (text(d.row.blocker_owner) ?? text(d.row.blocker) ?? '')
          : (text(d.row.waiting_on) ?? ''),
        blocker: blocked ? text(d.row.blocker) : null,
        since: isoOr(d.row.waiting_since) ?? isoOr(d.row.updated_at) ?? iso(0),
        next,
        past: next !== null && Date.parse(next) <= ctx.now,
        accountableName: nameOf(copy, d.accountableUserId),
      };
    });
  items.sort(
    (a, b) => Number(b.past) - Number(a.past) || (a.next ?? '9999').localeCompare(b.next ?? '9999'),
  );
  return { items };
}

/**
 * Team workload: each person who holds Real Estate, with their open deals, open duties, overdue ones, ones due within
 * two business days, and deals at risk, as `realestate.workload` answers. Only someone who sees every deal gets it
 * (the server refuses everyone else; their phone holds no team), so it's null without `seesEveryDeal`.
 */
export function workloadOfCopy(
  copy: RealestateCopy,
  f: CoordinateFilter,
  ctx: CoordinateContext & { readonly seesEveryDeal: boolean },
): WorkloadView | null {
  if (!ctx.seesEveryDeal) return null;
  const calendar = calendarOf(copy.settings.closedDays);
  const open = openDuties(copy, f, ctx);
  const deals = openDeals(copy, f);
  const onDeals = [...copy.deals.keys()].flatMap((id) =>
    copy.rows('deal_roles', id).map((r) => ({ userId: text(r.data.user_id) ?? '', deal: id })),
  );
  const people = copy.team.map((p) => {
    const mine = open.filter((d) => d.accountableUserId === p.userId);
    const dealIds = new Set([
      ...deals.filter((d) => d.owner === p.userId).map((d) => d.id),
      ...onDeals.filter((x) => x.userId === p.userId).map((x) => x.deal),
    ]);
    const live = deals.filter((d) => dealIds.has(d.id));
    return {
      userId: p.userId,
      name: copy.user(p.userId) ?? 'Former member',
      role: p.role,
      deals: live.length,
      openDuties: mine.length,
      overdue: mine.filter((d) => d.dueAt !== null && d.dueAt <= ctx.now).length,
      dueSoon: mine.filter(
        (d) =>
          d.dueAt !== null &&
          d.dueAt > ctx.now &&
          text(d.row.due_date) !== null &&
          businessDaysBetween(ctx.today, text(d.row.due_date)!, calendar) <= 2,
      ).length,
      atRiskDeals: live.filter((d) => d.health === 'red').length,
    };
  });
  people.sort(
    (a, b) =>
      b.overdue - a.overdue ||
      b.openDuties - a.openDuties ||
      byName(a.name, b.name) ||
      byText(a.userId, b.userId),
  );
  return { people };
}
