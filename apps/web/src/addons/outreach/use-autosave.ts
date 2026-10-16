'use client';
/**
 * A form that saves as each change is made (Social Outreach's Settings, Chris 2026-10-16: no Save buttons), shared
 * by the person's settings and the business's.
 *
 * - **One save at a time.** A change made while one runs goes in the next, built from the form's latest value.
 * - **A click saves at once** (`set`); **typing** waits for a short pause, or for the field to lose focus (`type`,
 *   `flush`). A change can ask to hear how its save went (`Settled`), as a network's switch does.
 * - **Saved,** the page's copy of what's kept moves on, and the page is drawn again. **Refused,** the form goes back
 *   to what's kept, and the status has the server's words.
 * - **Saved somewhere else** (another screen, an owner, the live channel): the form starts again from what's kept,
 *   but only while nothing of its own waits or saves. An older answer of its own coming back late is passed over.
 * - `hold` keeps a change from saving while the form isn't whole yet (Only these countries with none picked).
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/api/client';

/** Where a form's saving stands, for the page's status line. `at` says which form's news is newest. */
export type SaveStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'saving' }
  | { readonly state: 'saved'; readonly at: number }
  | { readonly state: 'failed'; readonly words: string; readonly at: number };

/** Told once the save a change went in is done: kept, or not with the server's words. */
export type Settled = (ok: boolean, words: string | null) => void;

/** How long typing waits before it saves. */
const PAUSE_MS = 700;

/** The same whatever order an object's keys came in: the server's copy and the form's are built apart. */
function key(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export interface Autosave<T> {
  /** The form as it is now. */
  readonly value: T;
  readonly status: SaveStatus;
  /** A click: the form changes, and it saves at once. */
  readonly set: (next: T | ((now: T) => T), settled?: Settled) => void;
  /** Typing: the form changes, and it saves after a short pause. */
  readonly type: (next: T | ((now: T) => T)) => void;
  /** Saves now what typing left waiting: on a field's blur. */
  readonly flush: () => void;
}

export function useAutosave<T>(
  /** What's kept, as the page was last drawn with it. */
  kept: T,
  /** Saves the form's value, giving back what's kept now. */
  save: (value: T) => Promise<T>,
  hold?: (value: T) => boolean,
): Autosave<T> {
  const router = useRouter();
  const [value, setValue] = useState(kept);
  const [status, setStatus] = useState<SaveStatus>({ state: 'idle' });
  const latest = useRef(kept);
  // What's kept as far as this form knows: the page's, or its own last save's answer, whichever is newer.
  const known = useRef(kept);
  // Its own saves' answers lately, to tell a late page drawn with an older one from a change made elsewhere.
  const ours = useRef<string[]>([]);
  const saving = useRef(false);
  const waiting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const told = useRef<Settled[]>([]);
  const saveRef = useRef(save);
  const holdRef = useRef(hold);
  useEffect(() => {
    saveRef.current = save;
    holdRef.current = hold;
  });

  const show = useCallback((next: T) => {
    latest.current = next;
    setValue(next);
  }, []);
  const stopTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const run = useCallback(async (): Promise<void> => {
    stopTimer();
    if (saving.current) return;
    saving.current = true;
    try {
      // Each change made while one saves goes in the next; typing that started meanwhile waits for its pause.
      while (waiting.current && !timer.current && !holdRef.current?.(latest.current)) {
        waiting.current = false;
        const sending = latest.current;
        const settled = told.current;
        told.current = [];
        setStatus({ state: 'saving' });
        try {
          const out = await saveRef.current(sending);
          known.current = out;
          ours.current = [...ours.current.slice(-4), key(out)];
          if (!waiting.current) show(out);
          for (const tell of settled) tell(true, null);
          setStatus({ state: 'saved', at: Date.now() });
          router.refresh();
        } catch (e) {
          const words = errorMessage(e);
          // Back to what's kept. A change made meanwhile was made on this one, so it goes too.
          waiting.current = false;
          stopTimer();
          show(known.current);
          for (const tell of [...settled, ...told.current]) tell(false, words);
          told.current = [];
          setStatus({ state: 'failed', words, at: Date.now() });
        }
      }
    } finally {
      saving.current = false;
    }
  }, [router, show]);

  const change = useCallback(
    (next: T | ((now: T) => T), typed: boolean, settled?: Settled) => {
      show(typeof next === 'function' ? (next as (now: T) => T)(latest.current) : next);
      waiting.current = true;
      if (settled) told.current.push(settled);
      stopTimer();
      if (typed)
        timer.current = setTimeout(() => {
          timer.current = null;
          void run();
        }, PAUSE_MS);
      else void run();
    },
    [run, show],
  );

  // What's kept changed: saved somewhere else, or the page drawn again after a save of its own.
  const keptKey = key(kept);
  useEffect(() => {
    if (keptKey !== key(known.current) && ours.current.includes(keptKey)) return;
    known.current = kept;
    if (saving.current || waiting.current || keptKey === key(latest.current)) return;
    show(kept);
    // Only a new `kept` matters, whatever object it came as.
  }, [keptKey]);

  // Leaving with typing not saved yet: it's saved anyway.
  useEffect(
    () => () => {
      stopTimer();
      if (waiting.current && !saving.current && !holdRef.current?.(latest.current))
        void saveRef.current(latest.current).catch(() => undefined);
    },
    [],
  );

  const set: Autosave<T>['set'] = useCallback(
    (next, settled) => change(next, false, settled),
    [change],
  );
  const type: Autosave<T>['type'] = useCallback((next) => change(next, true), [change]);
  const flush = useCallback(() => {
    if (timer.current) void run();
  }, [run]);
  return { value, status, set, type, flush };
}
