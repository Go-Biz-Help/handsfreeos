import { useCallback, useRef } from 'react';

/** A request that never lands (the network went away under it) holds the next one back no longer than this. */
const LONGEST_WAIT_MS = 10_000;

/** Done when `landed` is, or after `ms`, whichever comes first. */
function noLongerThan(landed: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void landed.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * One request at a time for something live changes ask for again and again (the Inbox's list, the unread counts).
 * An ask starts when the one before it has landed, so a run of changes never has the same question on its way
 * twice. An ask for something else (another filter: a different `key`) starts at once.
 */
export function useInTurn(): (key: string, ask: () => Promise<void>) => void {
  const last = useRef<{ key: string; landed: Promise<void> }>({
    key: '',
    landed: Promise.resolve(),
  });
  return useCallback((key, ask) => {
    const before =
      last.current.key === key
        ? noLongerThan(last.current.landed, LONGEST_WAIT_MS)
        : Promise.resolve();
    last.current = { key, landed: before.then(ask).catch(() => undefined) };
  }, []);
}
