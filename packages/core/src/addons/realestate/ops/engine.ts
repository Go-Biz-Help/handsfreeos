/**
 * The duty engine (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Duties" and "Dates"), server-only: what a moment
 * on a deal creates, when each duty is due, and which drafts are ready to work. Every command that changes a deal
 * opens its work here and settles it before it ends, so a deal's duties always match its stage, facts and dates.
 *
 * - **Created by a moment.** Entering a stage (or passing it on a jump), confirming a key date, or a named event
 *   creates the duties of the deal's list for it whose facts hold. A duty is created again only once every earlier
 *   one of it is finished, and a date's duties once per contract: after an offer is lost or a contract ends, the
 *   next contract's dates make their own.
 * - **Drafts first.** A duty resting on a contract date starts as a draft, and is ready to work (not started) once
 *   every contract date it rests on is confirmed (Chris, 2026-09-30).
 * - **Due times** are worked out from the rule, the deal's key dates and the business's calendar, with the trace
 *   kept (dates/due.ts); a date changing moves every open duty resting on it, unless a person set its due by hand.
 * - **Everything is logged** in `duty_log`: created, activated, due changed, cancelled.
 */
import { and, asc, eq } from 'drizzle-orm';
import { localDateOf } from '../../../calendar/engine/zoned';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import {
  CATALOG,
  dutiesCreatedBy,
  dutyDates,
  resolveDuty,
  type DealEvent,
  type DealFact,
  type DutyDef,
  type DutyTrigger,
  type ResolvedDuty,
} from '../catalog';
import { commissionOf } from '../commission';
import type { BusinessCalendar } from '../dates/business-days';
import { resolveDue } from '../dates/due';
import { KEY_DATES, type KeyDateKey, type KeyDates } from '../dates/key-dates';
import { isDoneDuty, type DealStage, type DutyStatus } from '../states';
import {
  dealHistory,
  deals,
  duties,
  dutyLinks,
  dutyLog,
  templateItems,
  termEntries,
} from '../tables';
import { waitsOnOf } from '../catalog/order';
import {
  conflictsOf,
  keyDatesOf,
  moneyOf,
  termsNow,
  type TermEntry,
  type TermKey,
  type TermNow,
} from '../terms';
import type { DealRole } from '../words';
import { checkDealDates, type DateProblem } from '../dates/conflicts';
import { healthOf } from '../health';
import { linkedFactsOf, riskFactsOf, syncContingencies } from './risk';
import {
  actorKind,
  actorUserId,
  businessCalendarOf,
  historyLine,
  personFor,
  rolesOf,
  timeZoneOf,
  type Deal,
} from './common';

const RESOLVED_CATALOG: readonly ResolvedDuty[] = CATALOG.map(resolveDuty);

/** The duty list a deal follows: its published version's items, or the catalog's own. */
export async function dutyListOf(
  ctx: CommandContext,
  deal: Pick<Deal, 'templateSetId'>,
): Promise<readonly ResolvedDuty[]> {
  if (!deal.templateSetId) return RESOLVED_CATALOG;
  const items = await ctx.tx
    .select({ definition: templateItems.definition, enabled: templateItems.enabled })
    .from(templateItems)
    .where(eq(templateItems.templateSetId, deal.templateSetId));
  return items.filter((i) => i.enabled).map((i) => i.definition as unknown as ResolvedDuty);
}

/** A deal's term entries, as the pure helpers read them. */
export async function termEntriesOf(
  ctx: Pick<CommandContext, 'tx'>,
  dealId: string,
): Promise<
  (TermEntry & { readonly confirmedBy: string | null; readonly sourceRef: string | null })[]
> {
  const list = await ctx.tx
    .select()
    .from(termEntries)
    .where(eq(termEntries.dealRecordId, dealId))
    .orderBy(asc(termEntries.enteredAt));
  return list.map((e) => ({
    id: e.id,
    key: e.key as TermKey,
    valueDate: e.valueDate,
    valueTime: e.valueTime,
    valueCents: e.valueCents,
    valueText: e.valueText,
    source: e.source as TermEntry['source'],
    enteredAt: e.enteredAt.toISOString(),
    confirmedAt: e.confirmedAt?.toISOString() ?? null,
    confirmedBy: e.confirmedBy,
    sourceRef: e.sourceRef,
    supersededAt: e.supersededAt?.toISOString() ?? null,
    rejectedAt: e.rejectedAt?.toISOString() ?? null,
  }));
}

/** What has happened on a deal, from its history: stages entered, the last restart, and events since. */
export interface Past {
  /** How many times each stage was entered (opening, a move, a jump through it). */
  readonly entered: ReadonlyMap<DealStage, number>;
  /** When the deal last went back to looking (an offer lost, a contract terminated). */
  readonly restartAt: Date | null;
  readonly eventsSinceRestart: ReadonlySet<DealEvent>;
}

export async function pastOf(ctx: Pick<CommandContext, 'tx'>, dealId: string): Promise<Past> {
  const lines = await ctx.tx
    .select({ at: dealHistory.at, what: dealHistory.what, after: dealHistory.after })
    .from(dealHistory)
    .where(eq(dealHistory.dealRecordId, dealId))
    .orderBy(asc(dealHistory.at), asc(dealHistory.createdAt));
  const entered = new Map<DealStage, number>();
  let restartAt: Date | null = null;
  const events: { at: Date; event: DealEvent }[] = [];
  for (const l of lines) {
    const passed = (l.after?.passed ?? []) as DealStage[];
    for (const s of passed) entered.set(s, (entered.get(s) ?? 0) + 1);
    if (RESTARTS.has(l.what)) restartAt = l.at;
    for (const e of (l.after?.events ?? []) as DealEvent[]) events.push({ at: l.at, event: e });
  }
  return {
    entered,
    restartAt,
    eventsSinceRestart: new Set(
      events.filter((e) => !restartAt || e.at >= restartAt).map((e) => e.event),
    ),
  };
}

/** The history lines that send a deal back to looking. */
export const RESTARTS: ReadonlySet<string> = new Set(['offer_lost', 'terminated']);

interface DutyRow {
  id: string;
  dutyKey: string;
  pass: number;
  status: DutyStatus;
  startedBy: string;
  startedAt: Date;
  definition: ResolvedDuty;
  dueOverrideAt: Date | null;
  dueState: string;
  dueAt: Date | null;
  needsDates: string[];
  dueWarnings: unknown[];
  accountableUserId: string | null;
  accountableRole: 'agent' | 'coordinator' | 'broker';
  title: string;
  materiality: 'standard' | 'material' | 'critical';
  dueDate: string | null;
  blocker: string | null;
  waitingOn: string | null;
  chaseAt: Date | null;
}

/** How much a command's work changed. */
export interface Counts {
  created: number;
  cancelled: number;
  activated: number;
  redated: number;
  handedOver: number;
}

/** The contract dates a duty rests on. */
const contractDates = (def: DutyDef): KeyDateKey[] =>
  dutyDates(def).filter((k) => KEY_DATES[k].contract);

/** The checks across a deal's dates; a buyer deal tied to the client's sale is checked against its closing. */
export async function dateProblemsOf(
  ctx: Pick<CommandContext, 'tx'>,
  deal: Pick<Deal, 'recordId' | 'side' | 'facts'>,
  keyDates: KeyDates,
  calendar: BusinessCalendar,
  today: string,
): Promise<DateProblem[]> {
  let linkedSaleClosing: string | null = null;
  if (deal.side === 'buyer' && deal.facts.includes('linked_sale')) {
    // Through the link's own door: a private sale the person isn't on still gives its closing date.
    const sale = (await linkedFactsOf(ctx, deal.recordId)).find(
      (l) => l.kind === 'sale_and_purchase' && l.side === 'listing',
    );
    linkedSaleClosing = sale?.keyDates['closing']?.date ?? null;
  }
  return checkDealDates({
    side: deal.side,
    keyDates,
    calendar,
    financed: deal.facts.includes('financed'),
    linkedSaleClosing,
    today,
  });
}

/**
 * A command's work on one deal's duties: open it once, make changes, then `settle()` before the command ends.
 */
export async function openWork(ctx: CommandContext, start: Deal) {
  let deal = start;
  const at = changeMoment(ctx.meta);
  const timeZone = await timeZoneOf(ctx);
  const calendar: BusinessCalendar = await businessCalendarOf(ctx);
  const list = await dutyListOf(ctx, deal);
  let roles: ReadonlyMap<string, DealRole> = await rolesOf(ctx, deal);
  let past = await pastOf(ctx, deal.recordId);
  let terms: ReadonlyMap<TermKey, TermNow> = termsNow(await termEntriesOf(ctx, deal.recordId));
  let keyDates: KeyDates = keyDatesOf(terms);
  const existing: DutyRow[] = (
    await ctx.tx.select().from(duties).where(eq(duties.dealRecordId, deal.recordId))
  ).map((d) => ({
    id: d.id,
    dutyKey: d.dutyKey,
    pass: d.pass,
    status: d.status as DutyStatus,
    startedBy: d.startedBy,
    startedAt: d.startedAt,
    definition: d.definition as unknown as ResolvedDuty,
    dueOverrideAt: d.dueOverrideAt,
    dueState: d.dueState,
    dueAt: d.dueAt,
    needsDates: d.needsDates,
    dueWarnings: d.dueWarnings,
    accountableUserId: d.accountableUserId,
    accountableRole: d.accountableRole as DutyRow['accountableRole'],
    title: d.title,
    materiality: d.materiality as DutyRow['materiality'],
    dueDate: d.dueDate,
    blocker: d.blocker,
    waitingOn: d.waitingOn,
    chaseAt: d.chaseAt,
  }));
  const counts: Counts = { created: 0, cancelled: 0, activated: 0, redated: 0, handedOver: 0 };
  const who = { actorType: actorKind(ctx), actorUserId: actorUserId(ctx) };

  const log = (
    rows: readonly {
      dutyId: string;
      what: string;
      before?: object | null;
      after?: object | null;
      note?: string | null;
    }[],
  ) =>
    rows.length
      ? ctx.tx.insert(dutyLog).values(
          rows.map((r) => ({
            workspaceId: deal.workspaceId,
            dealRecordId: deal.recordId,
            dutyId: r.dutyId,
            at,
            ...who,
            what: r.what,
            before: (r.before ?? null) as Record<string, unknown> | null,
            after: (r.after ?? null) as Record<string, unknown> | null,
            note: r.note ?? null,
          })),
        )
      : Promise.resolve();

  const dueOf = (def: ResolvedDuty, startedAt: Date) =>
    resolveDue(def.due, { timeZone, calendar, keyDates, startedAt: startedAt.getTime() });

  const startedByOf = (t: DutyTrigger) =>
    t.on === 'stage'
      ? `stage:${t.stage}`
      : t.on === 'dates'
        ? `dates:${t.key}`
        : `event:${t.event}`;

  /** The duties a moment creates, with their due times; returns how many. */
  async function create(
    trigger: DutyTrigger,
    opts: {
      readonly round?: 'first' | 'later';
      /**
       * A fact just set: only the duties that depend on one of these, and only those the deal has never had (or
       * had cancelled), whatever time through the stage it is.
       */
      readonly forFacts?: ReadonlySet<DealFact>;
      /** Only duties the deal has never had (or had cancelled): a newer duty list applied to it. */
      readonly onlyNew?: boolean;
    } = {},
  ): Promise<number> {
    const defs = (
      dutiesCreatedBy(
        deal.side,
        trigger,
        new Set<DealFact>(deal.facts),
        opts.round ?? 'first',
        list as readonly DutyDef[],
      ) as ResolvedDuty[]
    ).filter(
      (def) =>
        !opts.forFacts ||
        [...(def.when ?? []), ...(def.whenAny ?? [])].some((f) => opts.forFacts!.has(f)),
    );
    const made: (typeof duties.$inferInsert)[] = [];
    for (const def of defs) {
      const mine = existing.filter((d) => d.dutyKey === def.id);
      if (mine.some((d) => !isDoneDuty(d.status))) continue;
      if ((opts.forFacts || opts.onlyNew) && mine.some((d) => d.status !== 'cancelled')) continue;
      // A date's duties come once per contract: one finished or cancelled stays so until the next contract.
      if (
        trigger.on === 'dates' &&
        !opts.forFacts &&
        !opts.onlyNew &&
        mine.some((d) => !past.restartAt || d.startedAt >= past.restartAt)
      )
        continue;
      const due = dueOf(def, at);
      const draft = contractDates(def).some((k) => !keyDates[k]?.confirmed);
      made.push({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        dutyKey: def.id,
        pass: Math.max(0, ...mine.map((d) => d.pass)) + 1,
        title: def.title,
        tracker: def.tracker,
        status: draft ? 'draft' : 'not_started',
        materiality: def.materiality,
        automation: def.automation,
        accountableRole: def.accountable,
        accountableUserId: personFor(def.accountable, deal, roles),
        performers: [...(def.performedBy ?? [])],
        definition: def as unknown as Record<string, unknown>,
        startedBy: startedByOf(trigger),
        startedAt: at,
        dueState: due.state,
        dueAt: due.dueAt ? new Date(due.dueAt) : null,
        dueDate: due.date,
        dueTime: due.time,
        dueTrace: [...due.trace],
        dueWarnings: [...due.warnings],
        needsDates: [...new Set([...due.missing, ...due.unconfirmed])],
      });
    }
    return (await insertRows(made)).length;
  }

  /** Writes new duties, logs them, and keeps them in the work's list. */
  async function insertRows(made: (typeof duties.$inferInsert)[]) {
    if (!made.length) return [];
    const inserted = await ctx.tx.insert(duties).values(made).returning();
    await log(
      inserted.map((d) => ({
        dutyId: d.id,
        what: 'created',
        after: { status: d.status, dueAt: d.dueAt?.toISOString() ?? null, startedBy: d.startedBy },
      })),
    );
    for (const d of inserted)
      existing.push({
        id: d.id,
        dutyKey: d.dutyKey,
        pass: d.pass,
        status: d.status as DutyStatus,
        startedBy: d.startedBy,
        startedAt: d.startedAt,
        definition: d.definition as unknown as ResolvedDuty,
        dueOverrideAt: null,
        dueState: d.dueState,
        dueAt: d.dueAt,
        needsDates: d.needsDates,
        dueWarnings: d.dueWarnings,
        accountableUserId: d.accountableUserId,
        accountableRole: d.accountableRole as DutyRow['accountableRole'],
        title: d.title,
        materiality: d.materiality as DutyRow['materiality'],
        dueDate: d.dueDate,
        blocker: d.blocker,
        waitingOn: d.waitingOn,
        chaseAt: d.chaseAt,
      });
    counts.created += inserted.length;
    return inserted;
  }

  /**
   * A duty that no moment on the list creates: one a person writes on the deal, or the check a changed wire needs.
   * Its due time comes from its rule, or is set by hand.
   */
  async function addDuty(
    def: ResolvedDuty,
    opts: {
      readonly startedBy: `manual:${string}`;
      readonly accountableUserId?: string | null;
      readonly due?: {
        readonly at: Date;
        readonly date: string;
        readonly time: string;
        readonly reason: string;
      };
    },
  ): Promise<string> {
    const mine = existing.filter((d) => d.dutyKey === def.id);
    const due = dueOf(def, at);
    const [row] = await insertRows([
      {
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        dutyKey: def.id,
        pass: Math.max(0, ...mine.map((d) => d.pass)) + 1,
        title: def.title,
        tracker: def.tracker,
        status: 'not_started',
        materiality: def.materiality,
        automation: def.automation,
        accountableRole: def.accountable,
        accountableUserId:
          opts.accountableUserId !== undefined
            ? opts.accountableUserId
            : personFor(def.accountable, deal, roles),
        performers: [...(def.performedBy ?? [])],
        definition: def as unknown as Record<string, unknown>,
        startedBy: opts.startedBy,
        startedAt: at,
        ...(opts.due
          ? {
              dueState: 'due',
              dueAt: opts.due.at,
              dueDate: opts.due.date,
              dueTime: opts.due.time,
              dueTrace: [{ step: 'set_by_hand', date: opts.due.date, time: opts.due.time }],
              dueOverrideAt: at,
              dueOverrideReason: opts.due.reason,
            }
          : {
              dueState: due.state,
              dueAt: due.dueAt ? new Date(due.dueAt) : null,
              dueDate: due.date,
              dueTime: due.time,
              dueTrace: [...due.trace],
              dueWarnings: [...due.warnings],
              needsDates: [...new Set([...due.missing, ...due.unconfirmed])],
            }),
      },
    ]);
    const added = existing.find((d) => d.id === row!.id)!;
    if (opts.due) added.dueOverrideAt = at;
    return row!.id;
  }

  /** Entering stages, in order: each one's duties, for the time through it this is. */
  async function enterStages(stages: readonly DealStage[]): Promise<void> {
    for (const s of stages) {
      const before = past.entered.get(s) ?? 0;
      await create({ on: 'stage', stage: s }, { round: before > 0 ? 'later' : 'first' });
      past = { ...past, entered: new Map(past.entered).set(s, before + 1) };
    }
  }

  /** Named moments: each one's duties. */
  async function happen(events: readonly DealEvent[]): Promise<void> {
    for (const e of events) await create({ on: 'event', event: e });
    past = {
      ...past,
      eventsSinceRestart: new Set([...past.eventsSinceRestart, ...events]),
    };
  }

  /** Ends the unfinished duties that match, with why. */
  async function cancel(which: (d: DutyRow) => boolean, reason: string): Promise<number> {
    const hit = existing.filter((d) => !isDoneDuty(d.status) && which(d));
    for (const d of hit) {
      await ctx.tx
        .update(duties)
        .set({
          status: 'cancelled',
          finishedAt: at,
          finishedBy: who.actorUserId,
          finishReason: reason,
          updatedAt: at,
        })
        .where(eq(duties.id, d.id));
      d.status = 'cancelled';
    }
    await log(
      hit.map((d) => ({
        dutyId: d.id,
        what: 'cancelled',
        after: { status: 'cancelled' },
        note: reason,
      })),
    );
    counts.cancelled += hit.length;
    return hit.length;
  }

  /**
   * Gives an unfinished duty its item's definition from a newer duty list: its name, tracker, how much it matters,
   * who answers for it, its proof and timing. Its due time follows at `settle()`.
   */
  async function redefine(dutyId: string, def: ResolvedDuty, changes: readonly string[]) {
    const d = existing.find((x) => x.id === dutyId);
    if (!d || isDoneDuty(d.status)) return;
    const accountableUserId =
      def.accountable === d.accountableRole
        ? d.accountableUserId
        : personFor(def.accountable, deal, roles);
    await ctx.tx
      .update(duties)
      .set({
        definition: def as unknown as Record<string, unknown>,
        title: def.title,
        tracker: def.tracker,
        materiality: def.materiality,
        automation: def.automation,
        accountableRole: def.accountable,
        accountableUserId,
        performers: [...(def.performedBy ?? [])],
        updatedAt: at,
      })
      .where(eq(duties.id, d.id));
    await log([
      {
        dutyId: d.id,
        what: 'redefined',
        before: { title: d.title, materiality: d.materiality, accountableRole: d.accountableRole },
        after: {
          title: def.title,
          materiality: def.materiality,
          accountableRole: def.accountable,
          changes,
        },
      },
    ]);
    Object.assign(d, {
      definition: def,
      title: def.title,
      materiality: def.materiality,
      accountableRole: def.accountable,
      accountableUserId,
    });
  }

  /**
   * Hands the unfinished duties of one person to whoever their role now falls to: after someone leaves the deal,
   * or the main agent or coordinator changes. Duties someone was given by hand to another person stay theirs.
   */
  async function handOver(fromUserId: string): Promise<void> {
    roles = await rolesOf(ctx, deal);
    const hit = existing.filter((d) => !isDoneDuty(d.status) && d.accountableUserId === fromUserId);
    const moves: { dutyId: string; what: string; before: object; after: object }[] = [];
    for (const d of hit) {
      const next = personFor(d.accountableRole, deal, roles);
      if (next === d.accountableUserId) continue;
      await ctx.tx
        .update(duties)
        .set({ accountableUserId: next, updatedAt: at })
        .where(eq(duties.id, d.id));
      moves.push({
        dutyId: d.id,
        what: 'reassigned',
        before: { accountableUserId: d.accountableUserId },
        after: { accountableUserId: next },
      });
      d.accountableUserId = next;
    }
    await log(moves);
    counts.handedOver += moves.length;
  }

  /** Reads the terms again after they changed. The confirmed dates that weren't before. */
  async function reloadTerms(): Promise<KeyDateKey[]> {
    const was = keyDates;
    terms = termsNow(await termEntriesOf(ctx, deal.recordId));
    keyDates = keyDatesOf(terms);
    return (Object.keys(keyDates) as KeyDateKey[]).filter(
      (k) => keyDates[k]?.confirmed && !was[k]?.confirmed,
    );
  }

  /** Due times again from the dates as they are now, drafts ready to work, and the expected commission. */
  async function settle(): Promise<Counts> {
    const changes: { dutyId: string; what: string; before?: object; after?: object }[] = [];
    for (const d of existing) {
      if (isDoneDuty(d.status)) continue;
      const def = d.definition;
      const patch: Partial<typeof duties.$inferInsert> = {};
      if (!d.dueOverrideAt) {
        const due = dueOf(def, d.startedAt);
        const needs = [...new Set([...due.missing, ...due.unconfirmed])];
        const was = d.dueAt?.toISOString() ?? null;
        if (
          due.dueAt !== was ||
          due.state !== d.dueState ||
          needs.join() !== d.needsDates.join() ||
          JSON.stringify(due.warnings) !== JSON.stringify(d.dueWarnings)
        ) {
          Object.assign(patch, {
            dueState: due.state,
            dueAt: due.dueAt ? new Date(due.dueAt) : null,
            dueDate: due.date,
            dueTime: due.time,
            dueTrace: [...due.trace],
            dueWarnings: [...due.warnings],
            needsDates: needs,
          });
          if (due.dueAt !== was) {
            changes.push({
              dutyId: d.id,
              what: 'due_changed',
              before: { dueAt: was },
              after: { dueAt: due.dueAt },
            });
            counts.redated += 1;
          }
          d.dueAt = due.dueAt ? new Date(due.dueAt) : null;
          d.dueDate = due.date;
          d.dueState = due.state;
          d.needsDates = needs;
          d.dueWarnings = [...due.warnings];
        }
      }
      const rests = contractDates(def);
      if (
        d.status === 'draft' &&
        !d.startedBy.startsWith('manual:') &&
        rests.length > 0 &&
        rests.every((k) => keyDates[k]?.confirmed)
      ) {
        patch.status = 'not_started';
        changes.push({
          dutyId: d.id,
          what: 'activated',
          before: { status: 'draft' },
          after: { status: 'not_started' },
        });
        d.status = 'not_started';
        counts.activated += 1;
      }
      if (Object.keys(patch).length)
        await ctx.tx
          .update(duties)
          .set({ ...patch, updatedAt: at })
          .where(eq(duties.id, d.id));
    }
    await log(changes);
    // What the business expects to be paid moves with the price.
    const price =
      moneyOf(terms, 'price') ?? (deal.side === 'listing' ? moneyOf(terms, 'list_price') : null);
    const expected = commissionOf(
      {
        rateBp: deal.commissionRateBp,
        flatCents: deal.commissionFlatCents,
        creditCents: deal.commissionCreditCents,
        splitBp: deal.commissionSplitBp,
      },
      price,
    ).expectedCents;
    if (expected !== deal.expectedCommissionCents) {
      await ctx.tx
        .update(deals)
        .set({ expectedCommissionCents: expected, updatedAt: at })
        .where(and(eq(deals.recordId, deal.recordId), eq(deals.workspaceId, deal.workspaceId)));
      deal = { ...deal, expectedCommissionCents: expected };
    }
    // Each contingency whose end date the deal now has is tracked, and the built-in order of its duties written
    // (round four).
    await syncContingencies(ctx, deal, terms);
    await linkOrders();
    await refreshHealth();
    return counts;
  }

  /** The catalog's order between the deal's duties, once both are on it: the newest time through each. */
  async function linkOrders() {
    const newest = new Map<string, DutyRow>();
    for (const d of existing) {
      if (d.status === 'cancelled') continue;
      const had = newest.get(d.dutyKey);
      if (!had || d.pass > had.pass) newest.set(d.dutyKey, d);
    }
    const wanted = [...newest.values()].flatMap((d) =>
      waitsOnOf(d.dutyKey).flatMap((pre) => {
        const first = newest.get(pre);
        return first ? [{ dutyId: d.id, dependsOnId: first.id }] : [];
      }),
    );
    if (!wanted.length) return;
    await ctx.tx
      .insert(dutyLinks)
      .values(
        wanted.map((w) => ({
          workspaceId: deal.workspaceId,
          dealRecordId: deal.recordId,
          ...w,
          kind: 'finish_to_start',
        })),
      )
      .onConflictDoNothing();
  }

  /** The deal's health as things stand now, kept on the deal; a line in its history when its colour changes. */
  async function refreshHealth() {
    const now = at.getTime();
    const today = localDateOf(now, timeZone);
    const health = healthOf({
      duties: existing.map((d) => ({
        id: d.id,
        key: d.dutyKey,
        title: d.title,
        status: d.status,
        materiality: d.materiality,
        dueAt: d.dueAt?.toISOString() ?? null,
        dueDate: d.dueDate,
        dueState: d.dueState as 'due' | 'none' | 'waiting',
        needsDates: d.needsDates,
        accountableRole: d.accountableRole,
        accountableUserId: d.accountableUserId,
        blocker: d.blocker,
        waitingOn: d.waitingOn,
        chaseAt: d.chaseAt?.toISOString() ?? null,
      })),
      keyDates,
      conflicts: conflictsOf(terms),
      dateProblems: await dateProblemsOf(ctx, deal, keyDates, calendar, today),
      now,
      today,
      calendar,
      ...(await riskFactsOf(ctx, deal, keyDates)),
    });
    const reasons = health.reasons as unknown as unknown[];
    if (
      health.level === deal.health &&
      JSON.stringify(reasons) === JSON.stringify(deal.healthReasons)
    )
      return health;
    await ctx.tx
      .update(deals)
      .set({ health: health.level, healthReasons: reasons, healthAt: at })
      .where(and(eq(deals.recordId, deal.recordId), eq(deals.workspaceId, deal.workspaceId)));
    if (health.level !== deal.health)
      await historyLine(ctx, deal, 'health', {
        before: { health: deal.health },
        after: { health: health.level, reasons: health.reasons.map((r) => r.code) },
      });
    deal = { ...deal, health: health.level, healthReasons: reasons };
    return health;
  }

  return {
    at,
    timeZone,
    calendar,
    get deal() {
      return deal;
    },
    /** Takes the deal as the command just changed it (its stage, facts, commission, people). */
    update(next: Partial<Deal>) {
      deal = { ...deal, ...next };
    },
    get past() {
      return past;
    },
    get terms() {
      return terms;
    },
    get keyDates() {
      return keyDates;
    },
    duties: existing as readonly DutyRow[],
    counts,
    list,
    create,
    addDuty,
    redefine,
    enterStages,
    happen,
    cancel,
    handOver,
    reloadTerms,
    settle,
    refreshHealth,
  };
}

export type Work = Awaited<ReturnType<typeof openWork>>;
