'use client';
import { Pause, Play } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useSignedUrl } from '@/components/inbox/bits';
import { clock } from '@/lib/calls/format';
import { cn } from '@/lib/utils';

/** One voicemail plays at a time across the page. */
let playing: HTMLAudioElement | null = null;

/** Bar heights (6–24 px) seeded by the call, so each voicemail keeps its own shape. */
function waveform(seed: string, count: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return Array.from({ length: count }, () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return 6 + (Math.abs(h) % 19);
  });
}

/** Play, a waveform that fills as it plays, and the length. The audio comes from our storage via a signed link. */
export function VoicemailPlayer({
  path,
  seconds,
  seed,
  surface = 'card-2',
  size = 30,
  bars = 36,
}: {
  path: string;
  seconds: number | null;
  seed: string;
  /** The timeline's well is card-2 already, so the player sits on card there. */
  surface?: 'card' | 'card-2';
  /** 36 on phones. */
  size?: 30 | 36;
  bars?: number;
}) {
  const url = useSignedUrl('telephony', path);
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [progress, setProgress] = useState(0);
  const heights = useMemo(() => waveform(seed, bars), [seed, bars]);
  const played = on ? Math.round(progress * bars) : 0;
  const label = on ? 'Pause voicemail' : 'Play voicemail';

  async function toggle() {
    const el = audio.current;
    if (!el) return;
    if (on) {
      el.pause();
      return;
    }
    if (playing && playing !== el) playing.pause();
    playing = el;
    try {
      await el.play();
    } catch {
      toast.error('The voicemail didn’t play. Try again in a moment.');
    }
  }

  return (
    <div
      data-testid="voicemail-player"
      className={cn(
        'flex items-center gap-2.5 rounded-[10px] py-[7px] pl-[7px] pr-2.5',
        surface === 'card' ? 'bg-card' : 'bg-card-2',
        size === 36 ? 'h-[50px]' : 'h-11',
      )}
    >
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={!url}
        aria-label={label}
        title={label}
        className={cn(
          'flex flex-none items-center justify-center rounded-full bg-accent text-white disabled:opacity-60',
          size === 36 ? 'h-9 w-9' : 'h-[30px] w-[30px]',
        )}
      >
        {on ? (
          <Pause className="h-3.5 w-3.5" strokeWidth={2.4} />
        ) : (
          <Play className="h-3.5 w-3.5 fill-current" strokeWidth={1.5} />
        )}
      </button>
      <div aria-hidden className="flex h-6 min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        {heights.map((h, i) => (
          <span
            key={i}
            className={cn(
              'w-[3px] flex-none rounded-[2px]',
              i < played ? 'bg-accent' : 'bg-border-strong',
            )}
            style={{ height: h }}
          />
        ))}
      </div>
      <span className="font-mono text-xs text-text-3">{clock(seconds)}</span>
      {url ? (
        <audio
          ref={audio}
          src={url}
          preload="none"
          onPlay={() => setOn(true)}
          onPause={() => setOn(false)}
          onEnded={() => {
            setOn(false);
            setProgress(0);
          }}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            setProgress(el.duration ? el.currentTime / el.duration : 0);
          }}
        />
      ) : null}
    </div>
  );
}
