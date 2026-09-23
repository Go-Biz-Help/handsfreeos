'use client';
/**
 * Saving a settings document the way Settings pages do: what's on screen changes at once, saves run one at a
 * time, the server's answer replaces what was sent, and a refused save puts it back. One hook per document
 * (the Action Center's, Automations' own, the AI teammate's).
 */
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api/client';

export interface QueuedSave<T> {
  readonly value: T;
  /** Applies `change`, saves it, and says `done` when it saved. Resolves to whether it did. */
  save(change: (current: T) => T, done?: string, onError?: (e: unknown) => void): Promise<boolean>;
}

export function useQueuedSave<T>(initial: T, send: (next: T) => Promise<T>): QueuedSave<T> {
  const [value, setValue] = useState<T>(initial);
  const latest = useRef(initial);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const sender = useRef(send);
  sender.current = send;

  function save(
    change: (current: T) => T,
    done?: string,
    onError?: (e: unknown) => void,
  ): Promise<boolean> {
    const before = latest.current;
    const next = change(before);
    latest.current = next;
    setValue(next);
    const run = queue.current.then(async () => {
      try {
        const out = await sender.current(next);
        if (latest.current === next) {
          latest.current = out;
          setValue(out);
        }
        if (done) toast.success(done);
        return true;
      } catch (e) {
        if (latest.current === next) {
          latest.current = before;
          setValue(before);
        }
        onError?.(e);
        toast.error(errorMessage(e));
        return false;
      }
    });
    queue.current = run;
    return run;
  }

  return { value, save };
}
