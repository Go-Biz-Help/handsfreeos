'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * A record page's tab, following the address: `?tab=` picks it (the inbox's "See their money", `?tab=money`), a
 * search result's note (`?activity=`) opens on the Timeline, and its file (`?file=`) on Files, where each is read.
 * It follows the address on the page already open too, as the search box offers results on every page: the router
 * keeps the page mounted when only its query changes, and a tab that isn't shown isn't mounted, so its note or file
 * would otherwise wait unseen. Each ask once, so a refresh never pulls the person back from a tab they picked.
 */
export function useRecordTab<T extends string>(
  tabs: readonly T[],
  fallback: T,
): readonly [T, (tab: T) => void] {
  const query = useSearchParams();
  const asked = tabAsked(query, tabs);
  const [tab, setTab] = useState<T>(asked ?? fallback);
  const key = `${query.get('tab') ?? ''}:${query.get('activity') ?? ''}:${query.get('file') ?? ''}`;
  const seen = useRef(key);
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    if (asked) setTab(asked);
  }, [key, asked]);
  return [tab, setTab] as const;
}

/** The tab the address asks for: a file's Files, a note's Timeline, or `?tab=`'s. */
function tabAsked<T extends string>(
  query: Pick<URLSearchParams, 'get'>,
  tabs: readonly T[],
): T | null {
  const wanted = query.get('file')
    ? 'files'
    : query.get('activity')
      ? 'timeline'
      : query.get('tab');
  return tabs.includes(wanted as T) ? (wanted as T) : null;
}
