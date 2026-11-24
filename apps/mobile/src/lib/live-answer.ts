import * as React from 'react';
import { AppState } from 'react-native';

import { errorMessage } from '@/lib/api';
import { useInView } from '@/lib/in-view';
import { useNetwork } from '@/lib/network';

/**
 * One answer from HandsFreeOS for what the phone doesn't keep (a summary deal's documents, Social Outreach's live
 * view): asked when `key` changes, on `reload`, again when signal comes back, and, with `everySeconds`, again every so
 * often while the screen stays open. `load` null asks nothing. Real Estate's screens and Social Outreach's share it.
 *
 * Asking again every so often waits its turn (the speed audit, Nov 2026). A round is passed over while the one before
 * it is still out: starting another threw that answer away, so on a connection slower than the pace nothing ever
 * reached the screen and the requests piled up behind each other. And none is asked while the app is in the
 * background, or while the screen isn't the one in view (under another screen, or on a tab that isn't picked:
 * `@/lib/in-view`), where nobody reads the answer; it asks once on the way back if a round was passed over meanwhile.
 * Only the asking again waits: a new `key` and `reload` ask wherever the screen is.
 */
export interface LiveAnswer<T> {
  readonly data: T | null;
  readonly loading: boolean;
  /** What went wrong, or that it needs signal; null while it's fine. */
  readonly error: string | null;
  /** When the answer on screen came (ms), so a screen can say "As of 2:14 PM" once it can't ask again. */
  readonly at: number | null;
  reload(): void;
}

export interface LiveAnswerOptions {
  /** Ask again this often while the screen is open and there's signal; the last answer stays on screen meanwhile. */
  readonly everySeconds?: number;
  /**
   * What `key` is more of, when `key` also says how much (a list and how many of its pages): the answer to another
   * `key` with the same `moreOf` stays on screen while this one is asked for, so Show more adds rows under a list
   * that never left. Without it the screen is empty from the press until the longer list has come.
   */
  readonly moreOf?: string;
}

/** A round still out after this many of its turns (and this long at least) no longer holds the next one back. */
const STALLED_ROUNDS = 3;
const STALLED_MIN_MS = 30_000;

export function useLiveAnswer<T>(
  load: (() => Promise<T>) | null,
  key: string,
  offlineWords: string,
  options: LiveAnswerOptions = {},
): LiveAnswer<T> {
  const { online } = useNetwork();
  const [answer, setAnswer] = React.useState<{
    key: string;
    moreOf: string | undefined;
    value: T;
    at: number;
  } | null>(null);
  const [loading, setLoading] = React.useState(load !== null);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);
  const latest = React.useRef(load);
  latest.current = load;
  const asks = load !== null;
  const every = options.everySeconds;
  const moreOf = options.moreOf;
  /** The ask now out and when it began (ms), or null with none out. */
  const out = React.useRef<{ readonly began: number } | null>(null);
  /** When the newest ask began (ms), and whether the screen has been out of view since asking again last ran. */
  const asked = React.useRef(0);
  const away = React.useRef(false);
  const inView = useInView();

  React.useEffect(() => {
    if (!asks || !online || !every || every <= 0) return;
    if (!inView) {
      away.current = true;
      return;
    }
    let passedOver = false;
    const stalledMs = Math.max(every * 1000 * STALLED_ROUNDS, STALLED_MIN_MS);
    const waiting = () => out.current !== null && Date.now() - out.current.began < stalledMs;
    // Back in view with a round's time gone by since the last ask: asked now, not a round from now.
    if (away.current && Date.now() - asked.current >= every * 1000 && !waiting()) {
      setRound((r) => r + 1);
    }
    away.current = false;
    const t = setInterval(() => {
      if (AppState.currentState === 'background') passedOver = true;
      else if (!waiting()) setRound((r) => r + 1);
    }, every * 1000);
    const back = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !passedOver) return;
      passedOver = false;
      if (!waiting()) setRound((r) => r + 1);
    });
    return () => {
      clearInterval(t);
      back.remove();
    };
  }, [asks, online, every, inView]);

  React.useEffect(() => {
    const ask = latest.current;
    if (!ask) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const mine = { began: Date.now() };
    out.current = mine;
    asked.current = mine.began;
    setLoading(true);
    setError(null);
    ask()
      .then((value) => {
        if (!cancelled) setAnswer({ key, moreOf, value, at: Date.now() });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(online ? errorMessage(e) : offlineWords);
      })
      .finally(() => {
        // Only the newest ask says none is out: one that was replaced ends without a word.
        if (out.current === mine) out.current = null;
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [asks, key, moreOf, online, round, offlineWords]);

  const shown =
    asks &&
    answer !== null &&
    (answer.key === key || (moreOf !== undefined && answer.moreOf === moreOf))
      ? answer
      : null;
  const value = shown ? shown.value : null;
  return {
    data: value,
    loading: loading && value === null,
    error,
    at: shown && value !== null ? shown.at : null,
    reload: React.useCallback(() => setRound((r) => r + 1), []),
  };
}
