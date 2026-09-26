'use client';
import { VOICE_WORDS } from '@hfos/core';
import { Loader2, Mic, MicOff, Volume2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import type { VoicePhase, VoiceSession, VoiceSnapshot } from '@/lib/voice/session';
import { cn } from '@/lib/utils';

const PHASE_WORDS: Readonly<Record<Exclude<VoicePhase, 'off'>, string>> = {
  idle: VOICE_WORDS.paused,
  listening: VOICE_WORDS.listening,
  hearing: VOICE_WORDS.hearing,
  thinking: VOICE_WORDS.thinking,
  speaking: VOICE_WORDS.speaking,
};

/** The microphone's loudness as a ring that grows while they talk, drawn without re-rendering. */
function LevelRing({ session, active }: { session: VoiceSession; active: boolean }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(
    () =>
      session.onLevel((level) => {
        const el = ref.current;
        if (el) el.style.transform = `scale(${1 + level * 0.9})`;
      }),
    [session],
  );
  return (
    <span
      ref={ref}
      aria-hidden
      className={cn(
        'absolute inset-0 rounded-full bg-accent/25 transition-transform duration-75',
        !active && 'hidden',
      )}
    />
  );
}

/**
 * What talking out loud is doing now, under the chat: listening (with a ring that moves as they talk), getting
 * their words, thinking, or speaking, with Talk to speak now (over it, while it speaks), Done to send what
 * they've said, and Stop to turn it off.
 */
export function VoiceBar({
  session,
  snap,
  onTalk,
  className,
}: {
  session: VoiceSession;
  snap: VoiceSnapshot;
  /** Talk: listen now (cutting it off if it's speaking). */
  onTalk: () => void;
  className?: string;
}) {
  if (snap.phase === 'off') return null;
  const { phase } = snap;
  const Icon =
    phase === 'speaking'
      ? Volume2
      : phase === 'hearing' || phase === 'thinking'
        ? Loader2
        : phase === 'idle'
          ? MicOff
          : Mic;
  const words = phase === 'idle' && snap.error ? snap.error : PHASE_WORDS[phase];
  return (
    <div
      className={cn(
        'flex flex-none items-center gap-2.5 border-t border-border bg-accent-soft px-3 py-2',
        className,
      )}
      data-testid="voice-bar"
      data-phase={phase}
    >
      <span className="relative flex h-8 w-8 flex-none items-center justify-center">
        <LevelRing session={session} active={phase === 'listening'} />
        <span
          className={cn(
            'relative flex h-8 w-8 items-center justify-center rounded-full',
            phase === 'listening' || phase === 'speaking'
              ? 'bg-accent text-white'
              : 'bg-card text-text-2',
          )}
        >
          <Icon
            className={cn(
              'h-4 w-4',
              (phase === 'hearing' || phase === 'thinking') && 'animate-spin',
              phase === 'speaking' && 'animate-pulse',
            )}
            strokeWidth={1.75}
          />
        </span>
      </span>
      <span
        className="min-w-0 flex-1 text-[13px] font-medium text-accent-text"
        role="status"
        aria-live="polite"
        data-testid="voice-status"
      >
        {words}
      </span>
      {phase === 'listening' ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => session.finishTurn()}
          data-testid="voice-done"
        >
          Done
        </Button>
      ) : phase === 'idle' || phase === 'speaking' ? (
        <Button
          size="sm"
          onClick={onTalk}
          title={phase === 'speaking' ? VOICE_WORDS.interrupt : undefined}
          data-testid="voice-talk"
        >
          <Mic className="h-3.5 w-3.5" strokeWidth={1.75} />
          {VOICE_WORDS.talk}
        </Button>
      ) : null}
      <Button
        size="icon"
        variant="ghost"
        title={VOICE_WORDS.stopTalking}
        aria-label={VOICE_WORDS.stopTalking}
        onClick={() => session.stop()}
        data-testid="voice-stop"
      >
        <X className="h-4 w-4" strokeWidth={1.75} />
      </Button>
    </div>
  );
}

/** Why talking out loud couldn't start, when it couldn't (no microphone, not set up). */
export function VoiceError({ snap, className }: { snap: VoiceSnapshot; className?: string }) {
  if (snap.phase !== 'off' || !snap.error) return null;
  return (
    <p role="alert" className={cn('text-xs text-danger-text', className)} data-testid="voice-error">
      {snap.error}
    </p>
  );
}
