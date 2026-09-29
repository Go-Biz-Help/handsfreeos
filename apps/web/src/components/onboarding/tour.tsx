'use client';
import { TOUR_STOPS, TOUR_WORDS, tourStopWords, type TourStop } from '@hfos/core';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAssistant } from '@/components/assistant/assistant-provider';
import { Button } from '@/components/ui/button';
import { apiBrowser } from '@/lib/api/client';
import { cn } from '@/lib/utils';

const TOUR_EVENT = 'hfos:tour';

/** Starts the tour from anywhere in the business: the Getting started card, or Get help. */
export function startTour(): void {
  window.dispatchEvent(new Event(TOUR_EVENT));
}

/** The place a stop points at, as drawn on this screen: the sidebar's row, or the phone's bottom bar. */
function anchorOf(stop: TourStop): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${stop}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

const phoneWidth = () => !window.matchMedia('(min-width: 768px)').matches;

/** Room between the spotlight and the popover, and between the popover and the window's edge. */
const GAP = 14;
const EDGE = 16;

/**
 * The tour (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, board 7): five stops in the menu, each lit up with a
 * popover beside it. It opens by itself once, when the setup wizard hands over to Home (`?tour=1`), and again
 * whenever the card or Get help starts it. Done, Skip tour or Escape records it as taken, so it doesn't open by
 * itself again. A stop whose place isn't on screen (taken out of the menu, or one this person can't open) is left
 * out, and so is Ask HandsFreeOS on a phone, whose bottom bar doesn't have it.
 */
export function Tour({ workspaceId, taken }: { workspaceId: string; taken: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const shortcut = useAssistant().shortcut?.label ?? null;
  const [stops, setStops] = useState<readonly TourStop[] | null>(null);
  const [at, setAt] = useState(0);
  const [spot, setSpot] = useState<DOMRect | null>(null);
  const [height, setHeight] = useState(0);
  const pop = useRef<HTMLDivElement>(null);

  const begin = useCallback(() => {
    const phone = phoneWidth();
    const shown = TOUR_STOPS.filter((s) => !(phone && s === 'ask') && anchorOf(s));
    if (!shown.length) return;
    setStops(shown);
    setAt(0);
  }, []);

  useEffect(() => {
    window.addEventListener(TOUR_EVENT, begin);
    return () => window.removeEventListener(TOUR_EVENT, begin);
  }, [begin]);

  // Handed over from the setup wizard: once, and never after it was taken.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tour') !== '1') return;
    router.replace(pathname, { scroll: false });
    if (!taken) begin();
    // Only on arriving: the address is cleaned straight away.
  }, []);

  const stop = stops?.[at] ?? null;

  useLayoutEffect(() => {
    if (!stop) return;
    const el = anchorOf(stop);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    const measure = () => setSpot(el.getBoundingClientRect());
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [stop]);

  useLayoutEffect(() => {
    if (!stop) return;
    setHeight(pop.current?.offsetHeight ?? 0);
    pop.current?.querySelector<HTMLButtonElement>('[data-tour-primary]')?.focus();
  }, [stop, spot]);

  const end = useCallback(() => {
    setStops(null);
    setSpot(null);
    // Taken, even if it didn't save: it opens by itself only once anyway, and the next page load asks again.
    void apiBrowser()
      .POST('/v1/commands/onboarding.set_view', { body: { workspaceId, tourDone: true } })
      .then(() => router.refresh())
      .catch(() => undefined);
  }, [router, workspaceId]);

  useEffect(() => {
    if (!stop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        end();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stop, end]);

  if (!stops || !stop || !spot) return null;
  const words = tourStopWords(stop, shortcut);
  const last = at === stops.length - 1;
  const below = phoneWidth();
  // Beside the row on a wide screen, above the bottom bar on a phone, and never off the window.
  const top = below
    ? Math.max(EDGE, spot.top - GAP - height)
    : Math.min(Math.max(EDGE, spot.top + spot.height / 2 - 30), window.innerHeight - EDGE - height);
  const left = below ? EDGE : spot.right + GAP;
  const arrow = below
    ? {
        left: Math.min(Math.max(spot.left + spot.width / 2 - EDGE - 7, 16), window.innerWidth - 60),
      }
    : {
        top: Math.min(
          Math.max(spot.top + spot.height / 2 - top - 7, 14),
          Math.max(height - 28, 14),
        ),
      };

  return createPortal(
    <>
      {/* The page stays where it is and can't be pressed; the lit place is a hole in the dimming. */}
      <div className="fixed inset-0 z-[70]" aria-hidden data-testid="tour-scrim" />
      <div
        aria-hidden
        className="pointer-events-none fixed z-[70] rounded-[10px] transition-all duration-200"
        style={{
          top: spot.top - 4,
          left: spot.left - 4,
          width: spot.width + 8,
          height: spot.height + 8,
          boxShadow: '0 0 0 2px var(--accent), 0 0 0 9999px var(--scrim)',
        }}
      />
      <div
        ref={pop}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        data-testid="tour"
        data-stop={stop}
        className={cn(
          'fixed z-[71] rounded-[14px] bg-card px-[18px] pb-3.5 pt-[18px] shadow-3',
          below ? 'right-4' : 'w-[340px]',
        )}
        style={{ top, left }}
      >
        <span
          aria-hidden
          className={cn(
            'absolute h-3.5 w-3.5 rotate-45 rounded-[2px] bg-card',
            below ? '-bottom-[7px]' : '-left-[7px]',
          )}
          style={arrow}
        />
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {TOUR_WORDS.position(at + 1, stops.length)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 -mt-1.5"
            onClick={end}
            data-testid="tour-skip"
          >
            {TOUR_WORDS.skip}
          </Button>
        </div>
        <h3 id="tour-title" className="mt-1 text-[17px] font-semibold">
          {words.title}
        </h3>
        <p id="tour-body" className="mt-1.5 text-[13px] text-text-2">
          {words.body}
        </p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex gap-[5px]" aria-hidden>
            {stops.map((s, j) => (
              <i
                key={s}
                className={cn(
                  'h-1.5 rounded-full',
                  j === at ? 'w-4 bg-accent' : 'w-1.5 bg-border-strong',
                )}
              />
            ))}
          </div>
          <div className="flex gap-1.5">
            {at > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAt(at - 1)}
                data-testid="tour-back"
              >
                {TOUR_WORDS.back}
              </Button>
            ) : null}
            <Button
              data-tour-primary
              size="sm"
              onClick={() => (last ? end() : setAt(at + 1))}
              data-testid={last ? 'tour-done' : 'tour-next'}
            >
              {last ? TOUR_WORDS.done : TOUR_WORDS.next}
            </Button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
