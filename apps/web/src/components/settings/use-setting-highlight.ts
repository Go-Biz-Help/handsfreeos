'use client';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

/** How long the ring stays, as on the Add-ons page. */
const RING_MS = 4000;
/** How long to look for a setting that isn't drawn yet: an Adjust sheet opening, a card waiting on its data. */
const LOOK_MS = 3000;

/** A card or section is ringed; a row inside a card is also filled, so it stands out from the rows around it. */
const CARD_RING = ['ring-2', 'ring-accent', 'transition-shadow'];
const ROW_RING = [
  'ring-2',
  'ring-accent',
  'rounded-[10px]',
  'bg-accent-soft',
  '-mx-3',
  'px-3',
  'transition-colors',
];

/** A setting on the page, by its id (`quiet-hours`) or its key (`texting.quiet_hours`). */
function findSetting(target: string): HTMLElement | null {
  return (
    document.getElementById(target) ??
    document.querySelector<HTMLElement>(`[data-setting="${CSS.escape(target)}"]`)
  );
}

/** What the address points at after `#`, or null. */
function hashTarget(): string | null {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw || raw.includes('=')) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Brings the setting the address names into view and rings it for a few seconds (`settings/texting#quiet-hours`),
 * when a settings page opens and whenever it's called. Settings search calls it itself when the setting is on the page
 * already, since a push to the same page fires no `hashchange`. It reads `window.location` rather than
 * `useSearchParams`, so no settings page needs a Suspense boundary for it (the Usage page's precedent).
 */
export function useSettingHighlight(): (target?: string) => void {
  const pathname = usePathname();
  const timers = useRef<number[]>([]);
  const ringed = useRef<{ el: HTMLElement; classes: string[] } | null>(null);

  // Stops looking, and takes the ring off whatever has it.
  const stop = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
    if (ringed.current) ringed.current.el.classList.remove(...ringed.current.classes);
    ringed.current = null;
  }, []);

  const highlight = useCallback(
    (target?: string) => {
      const id = target ?? hashTarget();
      if (!id) return;
      stop();
      const started = Date.now();
      const look = () => {
        const el = findSetting(id);
        if (!el) {
          if (Date.now() - started < LOOK_MS) timers.current.push(window.setTimeout(look, 100));
          return;
        }
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const classes = el.classList.contains('rounded-card') ? CARD_RING : ROW_RING;
        el.classList.add(...classes);
        ringed.current = { el, classes };
        timers.current.push(
          window.setTimeout(() => {
            el.classList.remove(...classes);
            ringed.current = null;
          }, RING_MS),
        );
      };
      look();
    },
    [stop],
  );

  useEffect(() => {
    highlight();
  }, [pathname, highlight]);

  useEffect(() => {
    const onHash = () => highlight();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [highlight]);

  useEffect(() => stop, [stop]);

  return highlight;
}
