'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** A job is looked for at the screen's own pace for this long, then this seldom: by then it's a slow one, or stuck. */
const QUICK_FOR_MS = 3 * 60_000;
const SLOW_EVERY_MS = 15_000;

/**
 * Reads the page again while a background job works (the AI reading a contract, a file being built), for the jobs
 * that say nothing live when they're done.
 *
 * Nine screens each kept a timer of their own, which read the whole page every 2 to 4 seconds for as long as the job
 * said it was working: in a tab nobody was looking at too, and for ever when a job stopped without saying so (speed
 * audit, Nov 2026). Here a tab that isn't seen waits, and looks once when it's shown again; and after three minutes
 * the looks slow to one every 15 seconds.
 */
export function useLookAgain(working: boolean, everyMs: number): void {
  const router = useRouter();
  useEffect(() => {
    if (!working) return;
    const began = Date.now();
    const seen = () => document.visibilityState === 'visible';
    let timer: ReturnType<typeof setTimeout>;
    const look = () => {
      if (seen()) router.refresh();
      timer = setTimeout(look, Date.now() - began < QUICK_FOR_MS ? everyMs : SLOW_EVERY_MS);
    };
    timer = setTimeout(look, everyMs);
    const shown = () => {
      if (seen()) router.refresh();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [working, everyMs, router]);
}
