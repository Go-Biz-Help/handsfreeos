'use client';
import { clockOffWords } from '@hfos/core';
import { Clock, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { browserClockOffsetMs, onBrowserClockMeasured } from '@/lib/supabase/token';

/**
 * Says so while this computer's clock is off (measured from each sign-in renewal, lib/supabase/token): a clock an hour
 * fast once dropped a new customer's sign-in part way through setting up. The app copes either way; this is so the
 * person can set it right. Closing it hides it until the page loads again.
 */
export function ClockCheck() {
  const [offset, setOffset] = useState(0);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    setOffset(browserClockOffsetMs());
    return onBrowserClockMeasured(() => setOffset(browserClockOffsetMs()));
  }, []);
  const words = clockOffWords(offset);
  if (!words || closed) return null;
  return (
    <div
      role="status"
      data-testid="clock-check"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-[560px] items-start gap-2.5 rounded-[11px] bg-warning-soft px-3.5 py-3 text-[13px] leading-[1.45] text-warning-text shadow-lg"
    >
      <Clock className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
      <span className="min-w-0 flex-1">{words}</span>
      <button
        type="button"
        aria-label="Close"
        className="-m-1 flex-none rounded p-1 hover:bg-black/5"
        onClick={() => setClosed(true)}
      >
        <X className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}
