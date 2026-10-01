'use client';
import { useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';

/**
 * A value a page keeps in its address (`?plan=1`, `?home=<id>`), so a link can open a dialog: read when the page
 * opens, then held here. Changing it rewrites the address in place, without asking the server for the page again,
 * so a dialog closes at once even while the page is refreshing after what was just done.
 */
export function useQueryState(
  key: string,
  /** Other keys that belong to it and go when it does ("home" beside "plan"), comma-separated. */
  companions = '',
): readonly [string | null, (value: string | null) => void] {
  const params = useSearchParams();
  const [value, setValue] = useState<string | null>(() => params.get(key));
  const set = useCallback(
    (next: string | null) => {
      setValue(next);
      const q = new URLSearchParams(window.location.search);
      if (next === null) {
        q.delete(key);
        for (const c of companions.split(',').filter(Boolean)) q.delete(c);
      } else q.set(key, next);
      const s = q.toString();
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${s ? `?${s}` : ''}`,
      );
    },
    [key, companions],
  );
  return [value, set] as const;
}
