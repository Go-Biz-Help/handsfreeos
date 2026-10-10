import * as React from 'react';

import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * One answer from HandsFreeOS for what the phone doesn't keep (a summary deal's documents, Social Outreach's live
 * view): asked when `key` changes, on `reload`, again when signal comes back, and, with `everySeconds`, again every so
 * often while the screen stays open. `load` null asks nothing. Real Estate's screens and Social Outreach's share it.
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
}

export function useLiveAnswer<T>(
  load: (() => Promise<T>) | null,
  key: string,
  offlineWords: string,
  options: LiveAnswerOptions = {},
): LiveAnswer<T> {
  const { online } = useNetwork();
  const [answer, setAnswer] = React.useState<{ key: string; value: T; at: number } | null>(null);
  const [loading, setLoading] = React.useState(load !== null);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);
  const latest = React.useRef(load);
  latest.current = load;
  const asks = load !== null;
  const every = options.everySeconds;

  React.useEffect(() => {
    if (!asks || !online || !every || every <= 0) return;
    const t = setInterval(() => setRound((r) => r + 1), every * 1000);
    return () => clearInterval(t);
  }, [asks, online, every]);

  React.useEffect(() => {
    const ask = latest.current;
    if (!ask) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    ask()
      .then((value) => {
        if (!cancelled) setAnswer({ key, value, at: Date.now() });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(online ? errorMessage(e) : offlineWords);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [asks, key, online, round, offlineWords]);

  const value = asks && answer && answer.key === key ? answer.value : null;
  return {
    data: value,
    loading: loading && value === null,
    error,
    at: value !== null && answer ? answer.at : null,
    reload: React.useCallback(() => setRound((r) => r + 1), []),
  };
}
