/**
 * The live seat counter.
 *
 * The honest version of scarcity: the number here is the number the database will enforce, read from the
 * same view the approval path counts against. Nothing is inflated, nothing counts down on a timer, and when
 * the worker cannot be reached the component says the offer exists and stops talking rather than guessing.
 *
 * `count` is null in three cases that look the same to a visitor and should: the worker is down, the offer
 * is still a draft, or its counter is switched off. All three mean "no number to show", which the bar and
 * the sentence both handle by simply not appearing.
 */
import type { FoundingCount } from '@/lib/founding';

/** Full, and worth saying so plainly — an offer that pretends otherwise is the thing people resent. */
const isFull = (c: FoundingCount) => c.remaining <= 0;

export function SeatBar({ count }: { count: FoundingCount }) {
  const pct = count.seatCap > 0 ? Math.min(100, (count.claimed / count.seatCap) * 100) : 0;
  return (
    <div>
      <div
        className="bg-card-2 border-border h-2.5 w-full overflow-hidden rounded-full border"
        role="progressbar"
        aria-valuenow={count.claimed}
        aria-valuemin={0}
        aria-valuemax={count.seatCap}
        aria-label={`${count.claimed} of ${count.seatCap} ${count.name} seats claimed`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            isFull(count) ? 'bg-text-3' : 'bg-accent'
          }`}
          style={{ width: `${Math.max(pct, count.claimed > 0 ? 3 : 0)}%` }}
        />
      </div>
      <p className="text-text-3 mt-2 text-sm">
        {count.claimed} of {count.seatCap} claimed
      </p>
    </div>
  );
}

/**
 * The sentence. Deliberately not a countdown and not a "hurry": the number is either interesting on its own
 * or it is not, and a page that shouts about three seats left is the page people assume is lying.
 */
export function SeatsLeft({ count, className = '' }: { count: FoundingCount; className?: string }) {
  if (isFull(count))
    return (
      <p className={`text-text-2 text-base font-semibold ${className}`}>
        All {count.seatCap} seats are taken — join the waitlist
      </p>
    );
  return (
    <p className={`text-base font-semibold ${className}`}>
      <span className="text-accent">
        {count.remaining} of {count.seatCap}
      </span>{' '}
      <span className="text-text-2">
        {count.name.toLowerCase()} {count.remaining === 1 ? 'seat' : 'seats'} left
      </span>
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
  if (!count) return null;
  return (
    <div className={className}>
      <SeatsLeft count={count} className="mb-3" />
      <SeatBar count={count} />
    </div>
  );
}

/**
 * The strip that goes above the fold on the home page. One line, both offers, and it disappears entirely
 * rather than degrade — the home page has a job that does not depend on this.
 */
export function FoundingStrip({ counts }: { counts: readonly FoundingCount[] | null }) {
  const open = counts?.filter((c) => c.status === 'open' && c.remaining > 0) ?? [];
  if (open.length === 0) return null;
  return (
    <div className="border-border bg-card-2 border-b">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-6 gap-y-1 px-5 py-3 text-center text-sm sm:px-8">
        {open.map((c) => (
          <span key={c.offerId} className="text-text-2">
            <span className="text-accent font-semibold">{c.remaining}</span> of {c.seatCap}{' '}
            {c.name.toLowerCase()} {c.remaining === 1 ? 'seat' : 'seats'} left
          </span>
        ))}
        <a
          href="/founding"
          className="text-accent font-semibold underline-offset-4 hover:underline"
        >
          Apply for one
        </a>
      </div>
    </div>
  );
}
