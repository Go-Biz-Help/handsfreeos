/**
 * The duty catalog (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Duties"): all 148 rows of the specification,
 * each resolved against its tracker, and which of them a moment on a deal creates. Browser-safe and pure. A business's
 * own published list (step 12) starts from `CATALOG_VERSION` and keeps each item resolved, so a version replays
 * exactly whatever this file becomes.
 */
import { dueRuleDates } from '../dates/due';
import { KEY_DATES, type KeyDateKey } from '../dates/key-dates';
import { isStageOf, type DealSide } from '../states';
import { BUYER_DUTIES } from './buyer';
import { CROSS_DUTIES } from './cross';
import { LISTING_DUTIES } from './listing';
import { TRACKERS } from './trackers';
import type { DealFact, DutyDef, DutyId, DutyTrigger, ResolvedDuty } from './types';

export * from './types';
export { TRACKERS } from './trackers';

/** Bumped whenever a row or a tracker's defaults change. */
export const CATALOG_VERSION = 1;

export const CATALOG: readonly DutyDef[] = [...BUYER_DUTIES, ...LISTING_DUTIES, ...CROSS_DUTIES];

const byId = new Map<string, DutyDef>(CATALOG.map((d) => [d.id, d]));

export const catalogDuty = (id: DutyId | string): DutyDef | undefined => byId.get(id);

/** A row with its tracker's defaults filled in. */
export function resolveDuty(def: DutyDef): ResolvedDuty {
  const t = TRACKERS[def.tracker].defaults;
  return {
    ...def,
    proof: def.proof === undefined ? t.proof : def.proof,
    accountable: def.accountable ?? t.accountable,
    materiality: def.materiality ?? t.materiality,
    reminders: def.reminders ?? t.reminders,
  };
}

/** Whether a row is a duty on this side's deals at all. */
export const appliesTo = (def: DutyDef, side: DealSide): boolean =>
  def.perDeal !== false && (def.side === side || def.side === 'both');

/** What creates a row on a side's deal, or null when it doesn't apply there. */
export function triggerOf(def: DutyDef, side: DealSide): DutyTrigger | null {
  if (!appliesTo(def, side)) return null;
  const t = def.trigger;
  if ('on' in t) return t;
  return t[side] ?? null;
}

const sameTrigger = (a: DutyTrigger, b: DutyTrigger): boolean =>
  a.on === b.on &&
  ((a.on === 'stage' && b.on === 'stage' && a.stage === b.stage) ||
    (a.on === 'dates' && b.on === 'dates' && a.key === b.key) ||
    (a.on === 'event' && b.on === 'event' && a.event === b.event));

/** Whether a row's facts hold for a deal. */
export function factsHold(def: DutyDef, facts: ReadonlySet<DealFact>): boolean {
  if (def.when && !def.when.every((f) => facts.has(f))) return false;
  if (def.whenAny && !def.whenAny.some((f) => facts.has(f))) return false;
  return true;
}

/**
 * The rows a moment creates on a deal: the side's rows whose trigger it is and whose facts hold, for this pass
 * through the stage (`first`, or `later` after an offer was lost).
 */
export function dutiesCreatedBy(
  side: DealSide,
  trigger: DutyTrigger,
  facts: ReadonlySet<DealFact>,
  round: 'first' | 'later' = 'first',
  list: readonly DutyDef[] = CATALOG,
): DutyDef[] {
  return list.filter((def) => {
    const t = triggerOf(def, side);
    if (!t || !sameTrigger(t, trigger)) return false;
    if (def.round && def.round !== round) return false;
    return factsHold(def, facts);
  });
}

/** The key dates a row's deadline rests on. */
export const dutyDates = (def: DutyDef): KeyDateKey[] => dueRuleDates(def.due);

/**
 * Whether a row's deadline comes from a contract date: such a duty starts as a draft, and becomes active once every
 * date it needs is confirmed (Chris, 2026-09-30).
 */
export const restsOnContract = (def: DutyDef): boolean =>
  dutyDates(def).some((k) => KEY_DATES[k].contract);

/** Anything wrong with the catalog: the test holds it to none. */
export function catalogIssues(list: readonly DutyDef[] = CATALOG): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const def of list) {
    if (seen.has(def.id)) issues.push(`${def.id} is there twice`);
    seen.add(def.id);
    const sides: DealSide[] = def.side === 'both' ? ['buyer', 'listing'] : [def.side];
    for (const side of sides) {
      if (def.perDeal === false) continue;
      const t = triggerOf(def, side);
      if (!t) {
        issues.push(`${def.id} has nothing that creates it on a ${side} deal`);
        continue;
      }
      if (t.on === 'stage' && !isStageOf(side, t.stage))
        issues.push(`${def.id} starts at ${t.stage}, which a ${side} deal doesn't have`);
      if (t.on === 'dates' && !(KEY_DATES[t.key].sides as readonly string[]).includes(side))
        issues.push(`${def.id} waits for ${t.key}, which a ${side} deal doesn't have`);
      for (const k of dutyDates(def))
        if (!(KEY_DATES[k].sides as readonly string[]).includes(side))
          issues.push(`${def.id} is due from ${k}, which a ${side} deal doesn't have`);
    }
    if (def.round && !('on' in def.trigger && def.trigger.on === 'stage'))
      issues.push(`${def.id} counts passes through a stage but isn't started by one`);
    if (def.title.trim().length === 0 || def.title.length > 80)
      issues.push(`${def.id}'s title must be 1 to 80 characters`);
  }
  return issues;
}
