'use client';
import { useEffect, useState } from 'react';

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
