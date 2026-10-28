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
import type { CSSProperties } from 'react';
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
        {/* Full width and clipped to the count (globals.css), so it can fill as it comes into view. */}
        <div
          className={`bar-fill h-full w-full rounded-full ${isFull(count) ? 'bg-text-3' : 'bg-accent'}`}
          style={{ '--fill': `${Math.max(pct, count.claimed > 0 ? 3 : 0)}%` } as CSSProperties}
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
 * The line over the home page's headline: the spots with room, as one quiet link to the pricing page. It
 * disappears entirely rather than degrade — the home page has a job that does not depend on this.
 *
 * It is always one line. A phone has room for one spot, so it shows the first with room and the pricing page
 * has the rest; anything wider shows them all.
 */
export function FoundingPill({ counts }: { counts: readonly FoundingCount[] | null }) {
  // Only spots with a number to print and room left: a full one, or one with no live number, isn't news.
  const open = foundingSpotsOnSale(counts).flatMap(({ content, count }) =>
    count && count.showCounter && hasRoom({ content, count }) ? [{ content, count }] : [],
  );
  if (open.length === 0) return null;
  return (
    <a
      href="/pricing"
      className="group border-border bg-card/80 hover:border-border-strong inline-flex max-w-full items-center gap-2.5 rounded-full border py-1.5 pr-3.5 pl-1.5 text-sm whitespace-nowrap shadow-[0_1px_2px_rgb(16_24_40/0.05)] backdrop-blur transition-[border-color,transform] duration-[150ms,160ms] ease-[ease,var(--curve-out)] motion-safe:active:scale-[0.98]"
    >
      <span className="bg-accent-soft text-accent-text rounded-full px-2.5 py-0.5 text-xs font-semibold">
        Founding spots
      </span>
      {open.map(({ content, count }, index) => (
        <span
          key={content.id}
          className={`text-text-2 items-center gap-2.5 ${index === 0 ? 'inline-flex' : 'hidden sm:inline-flex'}`}
        >
          {index > 0 ? <span aria-hidden="true" className="bg-border-strong h-3.5 w-px" /> : null}
          <span>
            {content.priceLabel} {content.per} ·{' '}
            <span className="text-text font-semibold tabular-nums">{n(count.remaining)}</span> left
          </span>
        </span>
      ))}
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="text-text-3 group-hover:text-text h-3.5 w-3.5 shrink-0 transition-[transform,color] duration-200 ease-out group-hover:translate-x-0.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 8h9.5M8.5 4l4 4-4 4" />
      </svg>
    </a>
  );
}
