'use client';
import {
  SEARCH_MIN_CHARS,
  searchSettings,
  settingsSearchGroup,
  type SearchEverythingOutput,
  type SearchGroup,
} from '@hfos/core';
import { useCallback, useEffect, useState } from 'react';
import { useWorkspaceShell } from '@/components/shell/workspace-shell';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type { SearchBusiness } from './search-provider';

/**
 * Asking Search everything from the browser (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How it works, 1): what's
 * typed goes in the body of `search.everything`, never a path or a query string, after 2 characters and a pause, and
 * an answer that's been overtaken is dropped (the record picker's pattern). The last answer stays on screen while the
 * next loads. The Settings group is worked out here on the device from core's catalogue, first, and the server is told
 * whether a setting matched (`settingsMatched`), so a setting's name never brings up close matches.
 */

/** The refusals that pass: busy, too slow or too fast. Their words show with Try again, and one quiet retry follows. */
const RETRIED: ReadonlySet<string> = new Set([
  'search_busy',
  'search_took_too_long',
  'search_too_fast',
]);
const QUIET_RETRY_MS = 2000;

export interface SearchRefusal {
  readonly rule: string | null;
  readonly message: string;
}

/** Whether a failed request should be tried again quietly once. */
export function isRetried(e: unknown): boolean {
  return e instanceof ApiError && !!e.rule && RETRIED.has(e.rule);
}

/**
 * Whether Try again can help: a refusal that passes, or a failure with no rule (the network, a fault). Not one that
 * says the person may not look there, or that the kind is gone.
 */
export const canRetry = (r: SearchRefusal): boolean => r.rule === null || RETRIED.has(r.rule);

/** A failed search's words and rule, as the box and the page show them. */
export const refusalOf = (e: unknown): SearchRefusal => ({
  rule: e instanceof ApiError ? (e.rule ?? null) : null,
  message: errorMessage(e),
});

/**
 * The main search's Settings group for what's typed, gated as the Settings menu is for this person: core's
 * `searchSettings`, made a group by `settingsSearchGroup` with the business's own values ("9:00 PM to 8:00 AM").
 */
export function useSettingsGroup(
  business: Pick<SearchBusiness, 'workspaceId' | 'settings' | 'timeZone' | 'staff' | 'agency'>,
): (q: string) => SearchGroup | null {
  const { permissions, addons } = useWorkspaceShell();
  const { workspaceId, settings, timeZone, staff, agency } = business;
  return useCallback(
    (q: string) =>
      settingsSearchGroup(
        workspaceId,
        searchSettings(q, { permissions, addons, staff, agency, surface: 'web' }),
        { settings, timeZone },
      ),
    [workspaceId, settings, timeZone, staff, agency, permissions, addons],
  );
}

export interface SearchAsk {
  readonly q: string;
  /** The chips: one kind asked for on its own. */
  readonly kinds?: readonly string[];
  readonly perKind: number;
  readonly depth: 'quick' | 'full';
  readonly includeArchived?: boolean;
  readonly onlyMine?: boolean;
}

export interface SearchState {
  /** The answer on screen, kept while the next loads; null before the first, or when too little is typed. */
  readonly answer: SearchEverythingOutput | null;
  /** The device's Settings group for the answer's words. */
  readonly settings: SearchGroup | null;
  /** What the answer on screen was for. */
  readonly q: string;
  readonly loading: boolean;
  /** A refusal's words, shown with Try again. */
  readonly refusal: SearchRefusal | null;
  /** Try again: asks once more, now. */
  retry(): void;
}

interface Shown {
  readonly answer: SearchEverythingOutput | null;
  readonly settings: SearchGroup | null;
  readonly q: string;
  readonly loading: boolean;
  readonly refusal: SearchRefusal | null;
}

const NOTHING: Shown = { answer: null, settings: null, q: '', loading: false, refusal: null };

/** Search everything as the person types: 250 ms after they pause (the box's), or `debounceMs`. */
export function useSearch(
  workspaceId: string,
  ask: SearchAsk,
  settingsOf: (q: string) => SearchGroup | null,
  opts: { debounceMs?: number } = {},
): SearchState {
  const q = ask.q.trim();
  const debounceMs = opts.debounceMs ?? 250;
  const [shown, setShown] = useState<Shown>(NOTHING);
  const [nonce, setNonce] = useState(0);
  // One key for what's asked, so a new array of the same kinds doesn't ask again.
  const asked = JSON.stringify([
    q,
    ask.kinds ?? null,
    ask.perKind,
    ask.depth,
    !!ask.includeArchived,
    !!ask.onlyMine,
  ]);

  useEffect(() => {
    const [text, kinds, perKind, depth, includeArchived, onlyMine] = JSON.parse(asked) as [
      string,
      string[] | null,
      number,
      'quick' | 'full',
      boolean,
      boolean,
    ];
    if (text.length < SEARCH_MIN_CHARS) {
      setShown(NOTHING);
      return;
    }
    const controller = new AbortController();
    let quiet: number | undefined;
    const run = async (again: boolean) => {
      const settings = settingsOf(text);
      setShown((s) => ({ ...s, loading: true }));
      try {
        const answer = unwrap(
          await apiBrowser().POST('/v1/queries/search.everything', {
            body: {
              workspaceId,
              q: text,
              ...(kinds ? { kinds } : {}),
              perKind,
              depth,
              includeArchived,
              onlyMine,
              settingsMatched: !!settings,
            },
            signal: controller.signal,
          }),
        ) as SearchEverythingOutput;
        if (controller.signal.aborted) return;
        setShown({ answer, settings, q: text, loading: false, refusal: null });
      } catch (e) {
        if (controller.signal.aborted) return;
        setShown((s) => ({ ...s, loading: false, refusal: refusalOf(e) }));
        if (!again && isRetried(e)) quiet = window.setTimeout(() => void run(true), QUIET_RETRY_MS);
      }
    };
    const timer = window.setTimeout(() => void run(false), debounceMs);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.clearTimeout(quiet);
    };
  }, [asked, nonce, workspaceId, settingsOf, debounceMs]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { ...shown, retry };
}
