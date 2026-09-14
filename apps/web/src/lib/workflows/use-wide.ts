'use client';
import { useSyncExternalStore } from 'react';

const QUERY = '(min-width: 1024px)';

function subscribe(onChange: () => void) {
  const list = window.matchMedia(QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/**
 * Whether the screen is wide enough for a side panel (1024px). Unlike `useMatches`, the server's answer is
 * yes, so a desktop page renders its side panel from the first paint (hidden by CSS below 1024px) instead of
 * popping it in once the page loads; on a phone the panel's content unmounts once the browser answers.
 */
export function useWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
