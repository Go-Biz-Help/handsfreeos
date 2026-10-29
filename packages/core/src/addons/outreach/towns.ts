/**
 * The towns near the person's own on Alignable (docs/outreach.md, decision 115; the owner's pick of 28 Oct 2026:
 * "Towns within 25 miles, closest first."). Alignable puts each business in a town ("round-rock-tx" in
 * /round-rock-tx/acme-roofing), and a local search of its businesses (decision 92's 4) looked only in the person's
 * own. Now it keeps the businesses in any town within `NEAR_MILES` of theirs, the closest first, and each day it also
 * searches one of those towns, in turn from the closest (`outreach.finds.towns`). The towns' places are the US
 * Census Bureau's (./us-towns.ts, server-only), so a town outside the US has none near it yet, and its searches stay in
 * it as before.
 *
 * Browser-safe: the extension reads these shapes. The server's side is ./ops/towns.ts.
 */
import { z } from 'zod';

/** How far from the person's own town a town is near: the owner's pick. */
export const NEAR_MILES = 25;
/** The most towns near theirs it keeps businesses in and searches in turn: the closest. */
export const NEAR_TOWNS_MOST = 100;

/** A town as Alignable writes it in its addresses: its name in lowercase with dashes, then its state's two letters. */
export const TOWN_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*-[a-z]{2}$/;

/**
 * A town as one key however it's written: "st-louis-mo" and "saint-louis-mo" are one town, and so are
 * "coeur-dalene-id" and "coeur-d-alene-id", and "fort-worth-tx" and "ft-worth-tx".
 */
export function townKey(town: string): string {
  return town
    .toLowerCase()
    .replace(/(^|-)saint(?=-)/g, '$1st')
    .replace(/(^|-)sainte(?=-)/g, '$1ste')
    .replace(/(^|-)fort(?=-)/g, '$1ft')
    .replace(/(^|-)mount(?=-)/g, '$1mt')
    .replace(/[^a-z0-9]/g, '');
}

/** Whether a business's town is the person's own or one near it (`towns`, the own one first). */
export const inTowns = (towns: readonly string[], town: string | null): boolean =>
  town !== null && towns.some((t) => townKey(t) === townKey(town));

/** Where a business's town comes among the person's own and those near it: the closest first, others last. */
export function townOrder(towns: readonly string[], town: string | null): number {
  const at = town ? towns.findIndex((t) => townKey(t) === townKey(town)) : -1;
  return at < 0 ? towns.length : at;
}

export const FindsTownsInput = z.object({
  workspaceId: z.uuid(),
  /** The person's own town on Alignable, as their business page's address names it ("austin-tx"). */
  town: z
    .string()
    .trim()
    .toLowerCase()
    .max(100)
    .regex(TOWN_SLUG, 'Send the town as Alignable writes it in its addresses, like austin-tx.'),
});
export type FindsTownsInput = z.input<typeof FindsTownsInput>;

export const FindsTownsOutput = z.object({
  /**
   * The towns within `NEAR_MILES` of theirs, the closest first, up to `NEAR_TOWNS_MOST`, as Alignable writes towns
   * ("round-rock-tx"); never their own. None when HandsFreeOS doesn't know where their town is.
   */
  near: z.array(z.string()).max(NEAR_TOWNS_MOST),
  /** Today's town of those to search in too: each in turn from the closest. Null with none near. */
  today: z.string().nullable(),
});
export type FindsTownsOutput = z.output<typeof FindsTownsOutput>;
