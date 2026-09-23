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
  /** `once` is a founding seat, free or paid once. `monthly` is the plan itself, which has no seats. */
  readonly billing: 'once' | 'monthly';
  /** Whether its numbers are for printing. Off for the monthly plan. */
  readonly showCounter: boolean;
  /** A later founding offer has opened after this one: it is no longer what is on sale. */
  readonly superseded: boolean;
}

/** Where the worker answers. The same address the providers call; never the fly.dev one. */
export const workerUrl = (): string =>
  process.env.WORKER_PUBLIC_URL?.replace(/\/$/, '') ?? 'https://hooks.handsfreeos.com';

type RawCount = Record<string, unknown>;

const isCount = (v: unknown): v is RawCount => {
  const o = v as RawCount;
  return (
    typeof o?.['offerId'] === 'string' &&
    typeof o['name'] === 'string' &&
    typeof o['seatCap'] === 'number' &&
    typeof o['claimed'] === 'number' &&
    typeof o['remaining'] === 'number'
  );
};

/**
 * The three stage fields arrived after the first four (0092). A worker that has not been deployed with them yet
 * answers without them, and that answer is read as it would have been before: every offer a founding seat, its
 * numbers printed, nothing superseded. Refusing it outright would hide offers the database has open.
 */
const normalise = (o: RawCount): FoundingCount => ({
  ...(o as unknown as FoundingCount),
  billing: o['billing'] === 'monthly' ? 'monthly' : 'once',
  showCounter: typeof o['showCounter'] === 'boolean' ? o['showCounter'] : true,
  superseded: o['superseded'] === true,
});

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
    return offers.every(isCount) ? offers.map(normalise) : null;
  } catch {
    return null;
  }
}

/** One offer's numbers by id, or null — the id is the row in `platform.founding_offers`. */
export async function foundingCount(offerId: string): Promise<FoundingCount | null> {
  const all = await foundingCounts();
  return all?.find((o) => o.offerId === offerId) ?? null;
}

/**
 * The founding offer on sale right now: the one seat-based offer that nothing later has superseded. In the
 * growth plan that is the free seats until they are all out, then the $497 seats.
 *
 * Null when the worker could not be reached, or when no founding offer is open or closed at all. The pages
 * read that as "say nothing about founding seats" rather than guess which stage it is.
 */
export function currentFoundingOffer(
  counts: readonly FoundingCount[] | null,
): FoundingCount | null {
  const live = (counts ?? []).filter(
    (c) => c.billing === 'once' && c.status !== 'draft' && !c.superseded,
  );
  // Several at once only if somebody opened offers out of order by hand; the later one is the later stage.
  return live.at(-1) ?? null;
}

/**
 * Whether the $97 plan is on sale. It opens itself partway through the $497 seats.
 *
 * When the worker cannot be reached this answers **yes**. The plan is the product that outlasts every founding
 * offer, and a pricing page that hid it on a network blip would have nothing on it to buy at all. Signing up
 * charges nothing by itself, so the cost of being wrong for a minute is a sign-up, not a sale.
 */
export function monthlyOnSale(counts: readonly FoundingCount[] | null): boolean {
  if (counts === null) return true;
  return counts.some((c) => c.billing === 'monthly' && c.status === 'open');
}
