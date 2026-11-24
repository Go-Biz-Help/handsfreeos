/**
 * What the workspace's channel said lately, kept for a screen that was not there to hear it (./live-provider.tsx).
 *
 * A screen starts listening once it is on the page. The page it shows was read by the server a moment earlier,
 * while the move to it was still on its way, so a change saved in between was heard by nobody who wanted it: the
 * page arrived already old and stayed so until something else changed. The Inbox hid this for a long time, because
 * opening an unread conversation drew its page a second time.
 *
 * So what is heard is kept here for a minute, and a screen asks, as it starts to listen, when the newest change it
 * listens for was heard since the move that brought it began. Kept by the time it was heard, which is what the line
 * of redraws goes by (./redraws.ts): a page drawn again after that already has the change.
 */
export const HEARD_KEEP_MS = 60_000;
export const HEARD_KEEP = 200;

export interface HeardLog<T> {
  /** `change` was heard at `at`. */
  add(change: T, at: number): void;
  /** When the newest change `wanted` says yes to was heard, among those heard at `since` or later; null when none was. */
  newest(since: number, wanted: (change: T) => boolean, now?: number): number | null;
}

export function heardLog<T>(): HeardLog<T> {
  const kept: { at: number; change: T }[] = [];
  /** When the newest change dropped for room was heard. Nobody can say any more whether it was wanted, so it counts as wanted. */
  let dropped: number | null = null;
  return {
    add(change, at) {
      kept.push({ at, change });
      while (kept[0] && kept[0].at < at - HEARD_KEEP_MS) kept.shift();
      while (kept.length > HEARD_KEEP) dropped = kept.shift()!.at;
    },
    newest(since, wanted, now = Date.now()) {
      const from = Math.max(since, now - HEARD_KEEP_MS);
      for (let i = kept.length - 1; i >= 0; i--) {
        const heard = kept[i]!;
        if (heard.at < from) break;
        if (wanted(heard.change)) return heard.at;
      }
      return dropped !== null && dropped >= from ? dropped : null;
    },
  };
}
