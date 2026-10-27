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
 * **The number is a decoration, not a promise.** The spot is held under a row lock in Postgres when somebody
 * presses Pay in the app, whatever this said. Caching it for a minute is therefore free: the worst case is
 * somebody reading "3 left" that became "2 left" thirty seconds ago, signing up, and being told by the app's
 * plan page that they've gone.
 */
import 'server-only';
import { foundingSpots, type FoundingSpotContent } from '@/content/site';
import { workerUrl } from './worker-url';

export interface FoundingCount {
  readonly offerId: string;
  readonly name: string;
  readonly blurb: string;
  readonly status: 'draft' | 'open' | 'closed';
  readonly priceCents: number;
  readonly seatCap: number;
  readonly claimed: number;
  readonly remaining: number;
  /**
   * `once` is a founding spot, free or paid once. `yearly` is one paid each year, and `monthly` one paid each month:
   * since 20261027012700 the monthly plan is founding spots too, a thousand of them.
   */
  readonly billing: 'once' | 'yearly' | 'monthly';
  /** Whether its numbers are for printing. */
  readonly showCounter: boolean;
  /** A later founding offer has opened after this one: it is no longer what is on sale. */
  readonly superseded: boolean;
}

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
  billing: o['billing'] === 'monthly' ? 'monthly' : o['billing'] === 'yearly' ? 'yearly' : 'once',
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

/** A founding spot this site sells, with its live numbers: null when the worker could not be reached. */
export interface FoundingSpot {
  readonly content: FoundingSpotContent;
  readonly count: FoundingCount | null;
}

/**
 * The founding spots on sale now, in `foundingSpots`' order: the ones the database has open that nothing later has
 * superseded, full or not. A full one stays on the page saying so; it is the only honest answer to "is there room".
 *
 * When the worker cannot be reached, every spot is shown without its numbers. Signing up holds nothing — the spot is
 * held when they pay, under the cap's lock — so the cost of being wrong for a minute is somebody signing up for a
 * spot that has gone, and the app's plan page tells them so. A pricing page with nothing on it to buy would cost
 * every visitor instead.
 */
export function foundingSpotsOnSale(counts: readonly FoundingCount[] | null): FoundingSpot[] {
  if (counts === null) return foundingSpots.map((content) => ({ content, count: null }));
  return foundingSpots.flatMap((content) => {
    const count = counts.find((c) => c.offerId === content.id);
    return count && count.status === 'open' && !count.superseded ? [{ content, count }] : [];
  });
}

/** Room left, as far as anybody knows: unknown numbers count as room, and the database decides at Pay. */
export const hasRoom = (spot: FoundingSpot): boolean =>
  spot.count === null || spot.count.remaining > 0;
