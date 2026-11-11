/**
 * A job's materials (docs/contractor.md, "Materials"; the owner's decision 9, 2026-11-10): how much of each thing a
 * job needs, and how much is ordered, delivered, used, wasted and returned so far. What's still missing for a
 * visit, where a material stands, and what the job has taken come from those six counts and nothing else. One copy
 * of these rules, which the server keeps and both apps and the AI read. Pure and browser-safe.
 *
 * Stock in warehouses and vans, and orders to suppliers, come in Phase 2: this is one job's list.
 */
import { roundHalfUp as cents } from '../../money/totals';

/** The six counts kept for each material, in the order they happen. */
export const MATERIAL_COUNTS = [
  'needed',
  'ordered',
  'delivered',
  'used',
  'wasted',
  'returned',
] as const;
export type MaterialCount = (typeof MATERIAL_COUNTS)[number];
export type MaterialCounts = Readonly<Record<MaterialCount, number>>;

/** Where a material stands: still to order, on order, here, or all used up (or wasted or sent back). */
export const MATERIAL_STATES = ['to_order', 'ordered', 'here', 'used'] as const;
export type MaterialState = (typeof MATERIAL_STATES)[number];

/** Counts are kept to three decimal places, as an estimate's quantities are. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** How much of it still isn't here: what the job needs, less what was delivered. */
export const shortOf = (m: Pick<MaterialCounts, 'needed' | 'delivered'>): number =>
  round3(Math.max(0, m.needed - m.delivered));

/** How much of it nobody has ordered yet. What's delivered counts as ordered, however it came. */
export const toOrderOf = (m: Pick<MaterialCounts, 'needed' | 'ordered' | 'delivered'>): number =>
  round3(Math.max(0, m.needed - Math.max(m.ordered, m.delivered)));

/** How much of it is here and not yet used, wasted or sent back. Never below nothing. */
export const leftOf = (m: Pick<MaterialCounts, 'delivered' | 'used' | 'wasted' | 'returned'>) =>
  round3(Math.max(0, m.delivered - m.used - m.wasted - m.returned));

/**
 * How much of it the job has taken: what was delivered and not sent back, or what the crew says it used and wasted
 * when that's more (a tech can say what was used before the office says it arrived).
 */
export const takenOf = (m: Pick<MaterialCounts, 'delivered' | 'used' | 'wasted' | 'returned'>) =>
  round3(Math.max(0, m.delivered - m.returned, m.used + m.wasted));

export function materialState(m: MaterialCounts): MaterialState {
  if (toOrderOf(m) > 0) return 'to_order';
  if (shortOf(m) > 0) return 'ordered';
  // All of it is here. Once every bit is used, wasted or sent back, there's nothing left to do with it.
  return m.delivered > 0 && leftOf(m) === 0 ? 'used' : 'here';
}

/** The next thing to do with a material, as its quick button offers it: order it, take delivery, or use it up. */
export type MaterialStep = 'order' | 'deliver' | 'use';

/**
 * The one press that moves a material along, and the counts it sets: everything still to order is ordered, then
 * everything needed is delivered, then everything left is used. Null when there's nothing left to do with it.
 */
export function nextStep(
  m: MaterialCounts,
): { readonly step: MaterialStep; readonly change: Partial<MaterialCounts> } | null {
  const state = materialState(m);
  if (state === 'to_order') return { step: 'order', change: { ordered: m.needed } };
  if (state === 'ordered') return { step: 'deliver', change: { delivered: m.needed } };
  const left = leftOf(m);
  return state === 'here' && left > 0
    ? { step: 'use', change: { used: round3(m.used + left) } }
    : null;
}

/** A visit can't be done right while this is short. */
export const isMissing = (m: Pick<MaterialCounts, 'needed' | 'delivered'>): boolean =>
  shortOf(m) > 0;

/** Whether a material is needed on a visit: it's for that visit, or for any visit on the job. */
export const neededOn = (
  m: { readonly appointmentId: string | null },
  appointmentId: string,
): boolean => m.appointmentId === null || m.appointmentId === appointmentId;

/** What a visit is still missing: the materials needed on it that aren't all here. */
export function missingFor<T extends MaterialCounts & { readonly appointmentId: string | null }>(
  materials: readonly T[],
  appointmentId: string,
): T[] {
  return materials.filter((m) => neededOn(m, appointmentId) && isMissing(m));
}

/** "12", "2.5", "0.125": a count as people write it. */
export const qtyWords = (n: number): string =>
  round3(n).toLocaleString('en-US', { maximumFractionDigits: 3 });

/** "12 ft", "3 boxes", or just "4" when it's counted one by one. */
export function amountWords(n: number, unitLabel: string | null | undefined): string {
  const unit = (unitLabel ?? '').trim();
  return !unit || unit.toLowerCase() === 'each' ? qtyWords(n) : `${qtyWords(n)} ${unit}`;
}

/** "12 ft of 12/2 wire", or "4 GFCI outlets" said as "4 × GFCI outlet" when it's counted one by one. */
export function materialWords(n: number, unitLabel: string | null | undefined, name: string) {
  const unit = (unitLabel ?? '').trim();
  return !unit || unit.toLowerCase() === 'each'
    ? `${qtyWords(n)} × ${name}`
    : `${qtyWords(n)} ${unit} of ${name}`;
}

/** What a material costs the job at its unit cost. Nothing when nobody has said what one costs. */
export const materialCostCents = (quantity: number, unitCostCents: number | null): number =>
  cents(quantity * (unitCostCents ?? 0));

/** A job's materials in money, for people who may see job costs. */
export interface MaterialsCosting {
  /** What everything the job needs costs. */
  readonly plannedCents: number;
  /** What the job has taken so far costs: delivered and not sent back, or used and wasted when that's more. */
  readonly takenCents: number;
  /** Materials with no cost yet, so both figures run low. */
  readonly uncosted: number;
}

export function costMaterials(
  materials: readonly (MaterialCounts & { readonly unitCostCents: number | null })[],
): MaterialsCosting {
  return {
    plannedCents: materials.reduce((n, m) => n + materialCostCents(m.needed, m.unitCostCents), 0),
    takenCents: materials.reduce((n, m) => n + materialCostCents(takenOf(m), m.unitCostCents), 0),
    uncosted: materials.filter((m) => m.unitCostCents === null).length,
  };
}

/**
 * How long before a visit the business is told what's still missing for it (the add-on's settings). 0 is never.
 * A day to start: time to pick something up before the crew leaves.
 */
export const MATERIALS_ALERT_HOURS = [0, 2, 24, 48, 72, 168] as const;
export type MaterialsAlertHours = (typeof MATERIALS_ALERT_HOURS)[number];
export const DEFAULT_MATERIALS_ALERT_HOURS: MaterialsAlertHours = 24;

/** When to look at what a visit is missing: that long before it starts, and never in the past. Null: never. */
export function materialsCheckAt(startsAt: number, hours: number, now: number): number | null {
  if (hours <= 0) return null;
  return Math.max(now, startsAt - hours * 3_600_000);
}
