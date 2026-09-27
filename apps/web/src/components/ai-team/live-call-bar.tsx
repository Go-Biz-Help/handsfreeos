'use client';
import { Loader2, Mic, MicOff, PhoneCall, PhoneOff, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { LiveCallSnapshot } from '@/lib/ai-team/test-call';
import { cn } from '@/lib/utils';

/** "1:07": how long the call has been up. */
function sinceAnswered(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A live test call, under the chat: getting it going, ringing the business line, then who is talking (the
 * teammate, or the caller with what the listener hears of them so far), how long it's been up, mute, and hang up.
 */
export function LiveCallBar({
  snap,
  hearing,
  name,
  onMute,
  onHangUp,
}: {
  snap: LiveCallSnapshot;
  /** What the listener has heard of the caller so far, while they talk. */
  hearing: string;
  /** The teammate's name. */
  name: string;
  onMute: () => void;
  onHangUp: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (snap.phase !== 'live') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snap.phase]);
  if (snap.phase === 'ended') return null;
  const live = snap.phase === 'live';
  const words =
    snap.phase === 'connecting'
      ? snap.way === 'phone'
        ? 'Getting the call ready…'
        : 'Connecting…'
      : snap.phase === 'ringing'
        ? 'Calling your business line…'
        : snap.speaking
          ? `${name} is talking. Talk over it to cut in.`
          : hearing
            ? `“${hearing}”`
            : 'Listening…';
  const Icon = !live ? Loader2 : snap.speaking ? Volume2 : hearing ? Mic : PhoneCall;
  return (
    <div
      className="flex flex-none items-center gap-2.5 border-t border-border bg-accent-soft px-3 py-2"
      data-testid="live-call-bar"
      data-phase={snap.phase}
    >
      <span
        className={cn(
          'flex h-8 w-8 flex-none items-center justify-center rounded-full',
          live ? 'bg-accent text-white' : 'bg-card text-text-2',
        )}
      >
        <Icon
          className={cn(
            'h-4 w-4',
            !live && 'animate-spin',
            live && snap.speaking && 'animate-pulse',
          )}
          strokeWidth={1.75}
        />
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[13px] font-medium text-accent-text"
        role="status"
        aria-live="polite"
        data-testid="live-call-status"
      >
        {words}
      </span>
      {live && snap.answeredAt ? (
        <span className="flex-none text-xs tabular-nums text-text-3">
          {sinceAnswered(now - snap.answeredAt)}
        </span>
      ) : null}
      <Button
        size="icon"
        variant="ghost"
        aria-label={snap.muted ? 'Unmute' : 'Mute'}
        title={snap.muted ? 'Unmute' : 'Mute'}
        aria-pressed={snap.muted}
        disabled={!live}
        onClick={onMute}
        data-testid="live-call-mute"
      >
        {snap.muted ? (
          <MicOff className="h-4 w-4" strokeWidth={1.75} />
        ) : (
          <Mic className="h-4 w-4" strokeWidth={1.75} />
        )}
      </Button>
      <Button size="sm" variant="danger" onClick={onHangUp} data-testid="live-call-hang-up">
        <PhoneOff className="h-3.5 w-3.5" strokeWidth={1.75} />
        Hang up
      </Button>
    </div>
  );
}
