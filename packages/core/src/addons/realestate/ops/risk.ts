/**
 * What else puts a deal at risk, beyond its duties and dates (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round
 * four"): its open contingencies, the values read from its contracts still waiting, the duties that wait on others,
 * and what its linked sale or purchase breaks. Loaded here once for every place a deal's health is worked out.
 *
 * Contingencies follow the key dates: each kind a contract has (its end date entered, from the offer, the contract or
 * by hand) is tracked from then on, once. One that ended stays ended whatever its date does next.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import type { CommandContext } from '../../../kernel/types';
import {
  CONTINGENCY_END_KEYS,
  contingencyEnd,
  contingencyLabel,
  contingencyOfKey,
  type ContingencyKind,
} from '../contingencies';
import type { TermSource } from '../dates/key-dates';
import type { KeyDates } from '../dates/key-dates';
import { linkedProblems, type LinkedDates } from '../dates/linked';
import type { DealSide } from '../states';
import type { HealthContingency, HealthLinked, HealthWait } from '../health';
import { contingencies } from '../tables';
import type { TermKey, TermNow } from '../terms';
import { actorUserId, historyLine, type Ctx, type Deal } from './common';

export type ContingencySource = 'offer' | 'contract' | 'typed';

/** Where a contingency came from, by the source of the date it ends on. */
export const contingencySourceOf = (s: TermSource): ContingencySource =>
  s === 'contract' || s === 'amendment' || s === 'addendum'
    ? 'contract'
    : s === 'counter'
      ? 'offer'
      : 'typed';

/** Tracks each of these kinds on the deal, once: one already there (open or ended) is left as it is. */
export async function ensureContingencies(
  ctx: CommandContext,
  deal: Pick<Deal, 'recordId' | 'workspaceId'>,
  wanted: readonly {
    readonly kind: Exclude<ContingencyKind, 'other'>;
    readonly source: ContingencySource;
  }[],
): Promise<number> {
  if (!wanted.length) return 0;
  const made = await ctx.tx
    .insert(contingencies)
    .values(
      wanted.map((w) => ({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        kind: w.kind,
        endKey: contingencyEndKey(w.kind),
        source: w.source,
        createdBy: actorUserId(ctx),
      })),
    )
    .onConflictDoNothing()
    .returning({ kind: contingencies.kind, source: contingencies.source });
  for (const m of made)
    await historyLine(ctx, deal, 'contingency_added', {
      after: { kind: m.kind, source: m.source },
    });
  return made.length;
}

const contingencyEndKey = (kind: Exclude<ContingencyKind, 'other'>) =>
  CONTINGENCY_END_KEYS.find((k) => contingencyOfKey(k) === kind)!;

/** Every contingency whose end date the deal has, tracked. */
export async function syncContingencies(
  ctx: CommandContext,
  deal: Pick<Deal, 'recordId' | 'workspaceId'>,
  terms: ReadonlyMap<TermKey, TermNow>,
): Promise<number> {
  const wanted = CONTINGENCY_END_KEYS.flatMap((key) => {
    const t = terms.get(key);
    const e = t?.current ?? t?.live[0];
    const kind = contingencyOfKey(key);
    return e && kind ? [{ kind, source: contingencySourceOf(e.source) }] : [];
  });
  if (!wanted.length) return 0;
  const have = await ctx.tx
    .select({ kind: contingencies.kind })
    .from(contingencies)
    .where(eq(contingencies.dealRecordId, deal.recordId));
  return ensureContingencies(
    ctx,
    deal,
    wanted.filter((w) => !have.some((h) => h.kind === w.kind)),
  );
}

/** The round-four facts health needs about a deal. */
export async function riskFactsOf(
  ctx: Ctx,
  deal: Pick<Deal, 'recordId' | 'side'>,
  keyDates: KeyDates,
): Promise<{
  readonly contingencies: HealthContingency[];
  readonly readsWaiting: number;
  readonly waits: HealthWait[];
  readonly linked: HealthLinked[];
}> {
  const open = await ctx.tx
    .select()
    .from(contingencies)
    .where(and(eq(contingencies.dealRecordId, deal.recordId), eq(contingencies.state, 'open')));
  const [reads] = await rows<{ waiting: number }>(
    ctx.tx,
    sql`select coalesce(sum((select count(*) from jsonb_array_elements(r.found) v
                              where v ->> 'state' = 'waiting')), 0)::int as waiting
        from addon_realestate.contract_reads r
        where r.deal_record_id = ${deal.recordId} and r.state = 'read'`,
  );
  const waits = await rows<{ dutyId: string; dependsOnId: string }>(
    ctx.tx,
    sql`select duty_id as "dutyId", depends_on_id as "dependsOnId" from addon_realestate.duty_links
        where deal_record_id = ${deal.recordId} and kind = 'finish_to_start'`,
  );
  return {
    contingencies: open.map((c) => ({
      id: c.id,
      label: contingencyLabel(c),
      end: contingencyEnd(c, keyDates).date,
    })),
    readsWaiting: reads?.waiting ?? 0,
    waits,
    linked: (await linkedFactsOf(ctx, deal.recordId)).flatMap((o) =>
      linkedProblems(
        { side: deal.side, keyDates: keyDates as LinkedDates },
        { name: o.name, side: o.side, kind: o.kind, agentName: o.agentName, keyDates: o.keyDates },
      ),
    ),
  };
}

/** A linked deal as the link shows it: its key dates, health and agent's name, never anything else. */
export interface LinkedFacts {
  readonly otherId: string;
  readonly kind: 'same_home' | 'sale_and_purchase';
  readonly name: string;
  readonly side: DealSide;
  readonly stage: string;
  readonly outcome: string | null;
  readonly health: 'green' | 'yellow' | 'red';
  readonly agentName: string | null;
  readonly keyDates: LinkedDates;
}

/** The deals linked to this one, through the one door that lets their facts across (20261020001400). */
export async function linkedFactsOf(ctx: Pick<Ctx, 'tx'>, dealId: string): Promise<LinkedFacts[]> {
  const list = await rows<{
    other_id: string;
    kind: 'same_home' | 'sale_and_purchase';
    name: string;
    side: DealSide;
    stage: string;
    outcome: string | null;
    health: 'green' | 'yellow' | 'red';
    agent_name: string | null;
    key_dates: Record<string, { date: string; confirmed: boolean }>;
  }>(ctx.tx, sql`select * from private.linked_deal_facts(${dealId})`);
  return list.map((l) => ({
    otherId: l.other_id,
    kind: l.kind,
    name: l.name,
    side: l.side,
    stage: l.stage,
    outcome: l.outcome,
    health: l.health,
    agentName: l.agent_name,
    keyDates: l.key_dates ?? {},
  }));
}
