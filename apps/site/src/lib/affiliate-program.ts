/**
 * The affiliate program's two numbers staff set, read from the worker (`GET /public/affiliates/program`,
 * 20261027014500): the share every affiliate earns, and the most their codes take off.
 *
 * The same two rules as the founding counts (`founding.ts`): **the page renders without them**, saying "a share"
 * rather than a number, and every failure comes back as `null`. Staff change the share in the Admin area, so it's
 * never written into this repo: a page that says 40% when affiliates are paid 35% is a promise we'd break.
 */
import 'server-only';
import { workerUrl } from './worker-url';

export interface AffiliateProgram {
  /** Everyone's share of each plan payment, in basis points: 4000 is 40%. */
  readonly rateBp: number;
  /** The most an affiliate's code takes off, in basis points. */
  readonly maxDiscountBp: number;
}

/** Revalidated every five minutes: a share staff just changed shows soon after. */
export async function affiliateProgram(): Promise<AffiliateProgram | null> {
  try {
    const res = await fetch(`${workerUrl()}/public/affiliates/program`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<AffiliateProgram> | null;
    const ok = (n: unknown): n is number => typeof n === 'number' && n > 0 && n <= 10000;
    return ok(body?.rateBp) && ok(body?.maxDiscountBp)
      ? { rateBp: body.rateBp, maxDiscountBp: body.maxDiscountBp }
      : null;
  } catch {
    return null;
  }
}

/** 4000 as "40%", 3750 as "37.5%". */
export const percentWords = (bp: number): string => `${Number((bp / 100).toFixed(2)).toString()}%`;
