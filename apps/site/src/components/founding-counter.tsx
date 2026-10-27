/**
 * The live spot counter.
 *
 * The honest version of scarcity: the number here is the number the database will enforce, read from the
 * same view the app's Pay button is held against. Nothing is inflated, nothing counts down on a timer, and
 * when the worker cannot be reached the component says nothing rather than guessing.
 *
 * `count` is null in three cases that look the same to a visitor and should: the worker is down, the spot
 * is not on sale, or its counter is switched off. All three mean "no number to show", which the bar and
 * the sentence both handle by simply not appearing.
 */
import { foundingSpotsOnSale, hasRoom, type FoundingCount } from '@/lib/founding';

/** Full, and worth saying so plainly — an offer that pretends otherwise is the thing people resent. */
const isFull = (c: FoundingCount) => c.remaining <= 0;

/** "1,000". */
const n = (value: number) => value.toLocaleString('en-US');

export function SpotBar({ count }: { count: FoundingCount }) {
  const pct = count.seatCap > 0 ? Math.min(100, (count.claimed / count.seatCap) * 100) : 0;
  return (
    <div>
      <div
        className="bg-card-2 border-border h-2.5 w-full overflow-hidden rounded-full border"
        role="progressbar"
        aria-valuenow={count.claimed}
        aria-valuemin={0}
        aria-valuemax={count.seatCap}
        aria-label={`${n(count.claimed)} of ${n(count.seatCap)} ${count.name} spots taken`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            isFull(count) ? 'bg-text-3' : 'bg-accent'
          }`}
          style={{ width: `${Math.max(pct, count.claimed > 0 ? 3 : 0)}%` }}
        />
      </div>
      <p className="text-text-3 mt-2 text-sm">
        {n(count.claimed)} of {n(count.seatCap)} taken
      </p>
    </div>
  );
}

/**
 * The sentence. Deliberately not a countdown and not a "hurry": the number is either interesting on its own
 * or it is not, and a page that shouts about three spots left is the page people assume is lying.
 */
export function SpotsLeft({ count, className = '' }: { count: FoundingCount; className?: string }) {
  if (isFull(count))
    return (
      <p className={`text-text-2 text-base font-semibold ${className}`}>
        All {n(count.seatCap)} spots are taken
      </p>
    );
  return (
    <p className={`text-base font-semibold ${className}`}>
      <span className="text-accent">
        {n(count.remaining)} of {n(count.seatCap)}
      </span>{' '}
      <span className="text-text-2">{count.remaining === 1 ? 'spot' : 'spots'} left</span>
    </p>
  );
}

/** Both together, for a card. Renders nothing at all when there is no number worth showing. */
export function FoundingCounter({
  count,
  className = '',
}: {
  count: FoundingCount | null;
  className?: string;
}) {
  if (!count || !count.showCounter) return null;
  return (
    <div className={className}>
      <SpotsLeft count={count} className="mb-3" />
      <SpotBar count={count} />
    </div>
  );
}

/**
 * The strip that goes above the fold on the home page. One line, every spot with room, and it disappears
 * entirely rather than degrade — the home page has a job that does not depend on this.
 */
export function FoundingStrip({ counts }: { counts: readonly FoundingCount[] | null }) {
  // Only spots with a number to print and room left: a full one, or one with no live number, isn't news.
  const open = foundingSpotsOnSale(counts).flatMap(({ content, count }) =>
    count && count.showCounter && hasRoom({ content, count }) ? [{ content, count }] : [],
  );
  if (open.length === 0) return null;
  return (
    <div className="border-border bg-card-2 border-b">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-6 gap-y-1 px-5 py-3 text-center text-sm sm:px-8">
        {open.map(({ content, count }) => (
          <span key={content.id} className="text-text-2">
            <span className="text-accent font-semibold">{n(count.remaining)}</span> of{' '}
            {n(count.seatCap)} founding spots left at {content.priceLabel} {content.per}
          </span>
        ))}
        <a href="/pricing" className="text-accent font-semibold underline-offset-4 hover:underline">
          Get yours
        </a>
      </div>
    </div>
  );
}
