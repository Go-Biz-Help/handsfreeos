'use client';
import { Mic, MicOff, PhoneIncoming, PhoneOff, RotateCw } from 'lucide-react';
import { useId, useState } from 'react';
import { useCalls } from '@/lib/calls/call-provider';
import { cn } from '@/lib/utils';

const ROW =
  'mb-2 flex min-h-[34px] w-full items-center gap-2 rounded-control px-2.5 text-left text-[12.5px] font-medium';

/** Whether this browser rings for the business number: "Turn on calls", then a green "ready". */
export function CallsPill() {
  const calls = useCalls();
  switch (calls.readiness) {
    case 'ready':
      return (
        <div className={cn(ROW, 'bg-success-soft text-success-text')} data-testid="calls-ready">
          <span aria-hidden className="h-2 w-2 flex-none rounded-full bg-success" />
          <span className="flex-1">Calls ring in this browser</span>
          <Mic className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
        </div>
      );
    case 'off':
    case 'starting':
      return (
        <button
          type="button"
          onClick={() => void calls.enable()}
          disabled={calls.readiness === 'starting'}
          data-testid="calls-enable"
          className={cn(
            ROW,
            'bg-card-2 text-text-2 hover:bg-card-3 hover:text-text disabled:opacity-70',
          )}
        >
          <PhoneIncoming className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
          <span className="flex-1">
            {calls.readiness === 'starting' ? 'Turning on calls…' : 'Turn on calls in this browser'}
          </span>
        </button>
      );
    case 'blocked':
      return (
        <div
          className={cn(ROW, 'bg-warning-soft py-1.5 text-warning-text')}
          data-testid="calls-blocked"
        >
          <MicOff className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
          <span className="flex-1">Microphone blocked. Allow it in the address bar.</span>
        </div>
      );
    case 'error':
      return <Unavailable problem={calls.problem} retry={calls.retry} />;
    default:
      return null;
  }
}

/**
 * The worker couldn't be asked whether calls work here (it is out of reach, or calls are still being set up):
 * the control stays, with the reason on hover and a retry on tap, which shows the reason again if it fails.
 */
function Unavailable({ problem, retry }: { problem: string | null; retry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  async function again() {
    setBusy(true);
    try {
      await retry();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={() => void again()}
      disabled={busy}
      title={problem ?? undefined}
      aria-describedby={reasonId}
      data-testid="calls-unavailable"
      className={cn(ROW, 'bg-warning-soft text-warning-text hover:opacity-90 disabled:opacity-70')}
    >
      <PhoneOff className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
      <span className="flex-1">Calls unavailable</span>
      <span id={reasonId} className="sr-only">
        {problem ? `${problem} ` : ''}Press to try again.
      </span>
      <RotateCw
        aria-hidden
        className={cn('h-3.5 w-3.5 flex-none', busy && 'animate-spin')}
        strokeWidth={1.5}
      />
    </button>
  );
}
