'use client';
import { searchPageHref } from '@hfos/core';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { isMac, isShortcut } from '@/lib/keys';

/**
 * Recent searches stay on the device and with the person who typed them (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md,
 * How it works, 7): in `localStorage`, under the person and the business, never sent anywhere. Every read and write
 * is in try/catch: a private window, or blocked site data, just has none.
 */
const RECENT_PREFIX = 'hfos.search.recent.';
const RECENT_MAX = 8;

const recentKey = (userId: string, workspaceId: string) =>
  `${RECENT_PREFIX}${userId}.${workspaceId}`;

export function readRecent(userId: string, workspaceId: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(recentKey(userId, workspaceId)) ?? '[]');
    return Array.isArray(raw)
      ? raw.filter((q): q is string => typeof q === 'string').slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

/** Puts a search first in the person's recent ones, once, keeping the newest 8. Answers the list as it now stands. */
export function rememberSearch(userId: string, workspaceId: string, q: string): string[] {
  const typed = q.trim().slice(0, 120);
  const was = readRecent(userId, workspaceId);
  if (typed.length < 2) return was;
  const next = [typed, ...was.filter((r) => r.toLowerCase() !== typed.toLowerCase())].slice(
    0,
    RECENT_MAX,
  );
  try {
    localStorage.setItem(recentKey(userId, workspaceId), JSON.stringify(next));
  } catch {
    // Not kept: the next search tries again.
  }
  return next;
}

export function clearRecent(userId: string, workspaceId: string): void {
  try {
    localStorage.removeItem(recentKey(userId, workspaceId));
  } catch {
    // Nothing kept to clear.
  }
}

/**
 * Removes every recent search that isn't this person's, so the next person on a shared office browser never sees the
 * last one's, however they left (signing out on the server, a session that ran out, switching accounts). With no one
 * signed in, every one goes: signing out clears them too, as a courtesy.
 */
export function forgetOthersSearches(userId: string | null): void {
  try {
    const mine = userId ? `${RECENT_PREFIX}${userId}.` : null;
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(RECENT_PREFIX) && (!mine || !key.startsWith(mine))) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // Site data blocked: nothing was kept either.
  }
}

/** What's known about the business for the Settings group: the catalogue's values read its settings. */
export interface SearchBusiness {
  readonly workspaceId: string;
  readonly userId: string;
  readonly name: string;
  readonly timeZone: string;
  readonly settings: Readonly<Record<string, unknown>> | null;
  /** They answer HandsFreeOS support: New support tickets is theirs to find. */
  readonly staff: boolean;
  /** They run an agency: Daily agency digest is theirs to find. */
  readonly agency: boolean;
}

export interface SearchContextValue extends SearchBusiness {
  /** The sidebar's box, for ⌘K. */
  readonly boxRef: RefObject<HTMLInputElement | null>;
  readonly recent: readonly string[];
  remember(q: string): void;
  clearRecent(): void;
  /** "⌘K" or "Ctrl K"; null until the browser says whether it's a Mac. */
  readonly shortcut: { readonly label: string; readonly aria: string } | null;
}

const SearchContext = createContext<SearchContextValue | null>(null);

/** Search everything's box and what it needs, or null outside a business (and until Search 9 mounts the provider). */
export const useSearchContext = (): SearchContextValue | null => useContext(SearchContext);

/** From `lg` the sidebar's box is there to focus; below it, ⌘K opens the Search page. */
const COMPUTER = '(min-width: 1024px)';

/**
 * Search everything around a business's pages: the box's ref for ⌘K (Ctrl K elsewhere), the business's settings for
 * the Settings group, and the person's recent searches. ⌘K copies the Assistant's ⌘J guard, and `preventDefault`
 * keeps Ctrl K from the browser's own search: on a computer it focuses and selects the sidebar's box, below `lg` it
 * opens the Search page with its box focused. ⌘J stays the Assistant's.
 */
export function SearchProvider({
  business,
  children,
}: {
  business: SearchBusiness;
  children: ReactNode;
}) {
  const router = useRouter();
  const boxRef = useRef<HTMLInputElement | null>(null);
  const { workspaceId, userId } = business;
  const [recent, setRecent] = useState<readonly string[]>([]);
  const [mac, setMac] = useState<boolean | null>(null);

  useEffect(() => {
    forgetOthersSearches(userId);
    setRecent(readRecent(userId, workspaceId));
  }, [userId, workspaceId]);

  useEffect(() => {
    const onMac = isMac();
    setMac(onMac);
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e, 'k', onMac)) return;
      e.preventDefault();
      const box = boxRef.current;
      if (box && window.matchMedia(COMPUTER).matches) {
        box.focus();
        box.select();
      } else router.push(searchPageHref(workspaceId, { q: '' }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, workspaceId]);

  const remember = useCallback(
    (q: string) => setRecent(rememberSearch(userId, workspaceId, q)),
    [userId, workspaceId],
  );
  const clear = useCallback(() => {
    clearRecent(userId, workspaceId);
    setRecent([]);
  }, [userId, workspaceId]);

  const value = useMemo<SearchContextValue>(
    () => ({
      ...business,
      boxRef,
      recent,
      remember,
      clearRecent: clear,
      shortcut:
        mac === null
          ? null
          : mac
            ? { label: '⌘K', aria: 'Meta+K' }
            : { label: 'Ctrl K', aria: 'Control+K' },
    }),
    [business, recent, remember, clear, mac],
  );
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}
