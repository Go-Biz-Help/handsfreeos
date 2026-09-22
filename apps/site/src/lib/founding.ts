/**
 * The founding offers' live numbers, read from the worker.
 *
 * This is the first data the marketing site has ever fetched — every other page is content in this repo. Two
 * rules follow from that, and they are the whole of this file:
 *
 * **The page must render without it.** A marketing site that returns a 500 because a counter is down has
 * turned a cosmetic problem into a lost customer. Every failure here — unreachable, slow, malformed, a body
 * that is not what we expected — comes back as `null`, and the components say the offer exists without
 * saying how much is left. Nobody is misled by an absent number; they are misled by a wrong one.
 *
 * **The number is a decoration, not a promise.** The seat is taken under a row lock in Postgres whatever
 * this said. Caching it for a minute is therefore free: the worst case is somebody reading "3 left" that
 * became "2 left" thirty seconds ago, and applying anyway — which is exactly what the waitlist is for.
 */
import 'server-only';

export interface FoundingCount {
  readonly offerId: string;
  readonly name: string;
  readonly blurb: string;
  readonly status: 'draft' | 'open' | 'closed';
  readonly priceCents: number;
  readonly seatCap: number;
  readonly claimed: number;
  readonly remaining: number;
}

/** Where the worker answers. The same address the providers call; never the fly.dev one. */
export const workerUrl = (): string =>
  process.env.WORKER_PUBLIC_URL?.replace(/\/$/, '') ?? 'https://hooks.handsfreeos.com';

const isCount = (v: unknown): v is FoundingCount => {
  const o = v as Record<string, unknown>;
  return (
    typeof o?.['offerId'] === 'string' &&
    typeof o['name'] === 'string' &&
    typeof o['seatCap'] === 'number' &&
    typeof o['claimed'] === 'number' &&
    typeof o['remaining'] === 'number'
  );
};

/**
 * Every open offer's numbers, or null if the worker could not be reached.
 *
 * Revalidated every sixty seconds, so a launch-day rush costs one request a minute rather than one a visitor.
 */
export async function foundingCounts(): Promise<readonly FoundingCount[] | null> {
  try {
    const res = await fetch(`${workerUrl()}/public/founding/counts`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const offers = (body as { offers?: unknown })?.offers;
    if (!Array.isArray(offers)) return null;
    // A partly-malformed answer is no answer: showing half the offers would be its own kind of wrong.
    return offers.every(isCount) ? (offers as FoundingCount[]) : null;
  } catch {
    return null;
  }
}

/** One offer's numbers by id, or null — the id is the row in `platform.founding_offers`. */
export async function foundingCount(offerId: string): Promise<FoundingCount | null> {
  const all = await foundingCounts();
  return all?.find((o) => o.offerId === offerId) ?? null;
}
