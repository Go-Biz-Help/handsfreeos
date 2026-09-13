'use client';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Whether a media query matches, known on the first render of anything mounted after the page loaded
 * (the Assistant panel opens that way, so it never flashes the wrong layout). False on the server.
 */
export function useMatches(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Whether a media query matches; null until the browser has answered (the server can't know). */
export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}
