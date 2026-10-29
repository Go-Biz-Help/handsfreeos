'use client';
/**
 * Picking the AI teammate's phone voice from every provider (the owner's picks, 28 Oct 2026): one list grouped by
 * model (Deepgram, Rime Coda, Rime Mist), each voice with how it sounds, and Hear it, which says the greeting in
 * that voice. A Rime voice can't be picked until the worker has Rime's key (GET /v1/speech/voices says). AI
 * teammate → Phone → Its voice and the test console both use it; the phone app has its own
 * (apps/mobile/src/components/ai-team/voice-picker.tsx).
 */
import {
  isPhoneVoice,
  PHONE_VOICE_GROUPS,
  PHONE_VOICE_PICK_WORDS,
  phoneVoiceInfo,
  phoneVoiceLine,
  voiceReady,
  VOICES_ASSUMED,
  type PhoneVoice,
  type VoiceReadiness,
} from '@hfos/core';
import { Square, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { errorMessage } from '@/lib/api/client';
import { sayClip, speechStops, voiceReadiness } from '@/lib/voice/speech';

/** Asked once a page load: Rime's key only changes with a worker deploy. */
let asked: Promise<VoiceReadiness | null> | null = null;

/** Which providers can speak: assumed (Deepgram yes, Rime no) until the worker says, and `known` once it has. */
export function useVoiceReadiness(): { readonly ready: VoiceReadiness; readonly known: boolean } {
  const [ready, setReady] = useState<VoiceReadiness | null>(null);
  useEffect(() => {
    let live = true;
    asked ??= voiceReadiness().catch(() => {
      asked = null;
      return null;
    });
    void asked.then((r) => {
      if (live && r) setReady(r);
    });
    return () => {
      live = false;
    };
  }, []);
  return { ready: ready ?? VOICES_ASSUMED, known: ready !== null };
}

type AudioContextClass = typeof AudioContext;

/**
 * Hear it: one clip at a time, said by the worker in the voice picked. It plays through an AudioContext made in
 * the click, so Safari lets it play once the clip arrives. When a Rime voice couldn't speak and Deepgram's said it
 * instead, a note says so.
 */
export function useHearVoice(workspaceId: string): {
  readonly playing: PhoneVoice | null;
  readonly hear: (voice: PhoneVoice, text: string) => void;
  readonly stop: () => void;
} {
  const [playing, setPlaying] = useState<PhoneVoice | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const now = useRef<{ ctrl: AbortController; source: AudioBufferSourceNode | null } | null>(null);

  const stop = useCallback(() => {
    const n = now.current;
    now.current = null;
    if (n) {
      n.ctrl.abort();
      try {
        n.source?.stop();
      } catch {
        // Already finished.
      }
    }
    setPlaying(null);
  }, []);

  useEffect(
    () => () => {
      stop();
      void ctxRef.current?.close().catch(() => undefined);
      ctxRef.current = null;
    },
    [stop],
  );

  const hear = useCallback(
    (voice: PhoneVoice, text: string) => {
      stop();
      const Ctx: AudioContextClass | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;
      if (!Ctx) {
        toast.error('This browser can’t play sound. Try another browser.');
        return;
      }
      const ctx = (ctxRef.current ??= new Ctx());
      void ctx.resume().catch(() => undefined);
      const me = { ctrl: new AbortController(), source: null as AudioBufferSourceNode | null };
      now.current = me;
      setPlaying(voice);
      void (async () => {
        try {
          const clip = await sayClip({ workspaceId, text, voice, language: null }, me.ctrl.signal);
          const sound = await ctx.decodeAudioData(clip.audio);
          if (now.current !== me) return;
          const source = ctx.createBufferSource();
          source.buffer = sound;
          source.connect(ctx.destination);
          source.onended = () => {
            if (now.current === me) stop();
          };
          me.source = source;
          source.start();
          if (clip.voice && clip.voice !== voice)
            toast(
              PHONE_VOICE_PICK_WORDS.saidInstead(
                phoneVoiceInfo(voice).name,
                phoneVoiceInfo(clip.voice).name,
              ),
            );
        } catch (e) {
          if (me.ctrl.signal.aborted) return;
          if (now.current === me) stop();
          toast.error(speechStops(e) ?? errorMessage(e));
        }
      })();
    },
    [workspaceId, stop],
  );

  return { playing, hear, stop };
}

/** A Rime voice can't be picked while Rime isn't set up, unless it's the one already picked. */
const pickable = (v: PhoneVoice, value: PhoneVoice, ready: VoiceReadiness) =>
  v === value || phoneVoiceInfo(v).provider !== 'rime' || voiceReady(v, ready);

/** Every voice, grouped by model, as "Eyre: a woman, warm and calm". */
export function VoiceSelect({
  value,
  onChange,
  ready,
  className,
  testId,
  ariaLabel = 'Its voice',
  disabled,
}: {
  value: PhoneVoice;
  onChange: (v: PhoneVoice) => void;
  ready: VoiceReadiness;
  className?: string;
  testId: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      selectSize="sm"
      className={className}
      aria-label={ariaLabel}
      value={value}
      data-testid={testId}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value;
        if (isPhoneVoice(v)) onChange(v);
      }}
    >
      {PHONE_VOICE_GROUPS.map((g) => (
        <optgroup key={g.model} label={g.label}>
          {g.voices.map((v) => {
            const off = !pickable(v, value, ready);
            return (
              <option key={v} value={v} disabled={off}>
                {phoneVoiceLine(v)}
                {off ? ` (${PHONE_VOICE_PICK_WORDS.notReady})` : ''}
              </option>
            );
          })}
        </optgroup>
      ))}
    </Select>
  );
}

/** Hear it, or stop it while it plays. */
export function HearVoiceButton({
  voice,
  playing,
  onHear,
  onStop,
  testId,
}: {
  voice: PhoneVoice;
  playing: PhoneVoice | null;
  onHear: () => void;
  onStop: () => void;
  testId: string;
}) {
  const on = playing === voice;
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      data-testid={testId}
      aria-pressed={on}
      onClick={on ? onStop : onHear}
    >
      {on ? (
        <Square className="size-3.5" aria-hidden />
      ) : (
        <Volume2 className="size-4" aria-hidden />
      )}
      {on ? PHONE_VOICE_PICK_WORDS.hearing : PHONE_VOICE_PICK_WORDS.hear}
    </Button>
  );
}

/** Under a Rime voice while Rime isn't set up: calls use its Deepgram voice for now. */
export function VoiceNotReadyNote({
  voice,
  ready,
  known,
}: {
  voice: PhoneVoice;
  ready: VoiceReadiness;
  known: boolean;
}) {
  if (!known || phoneVoiceInfo(voice).provider !== 'rime' || ready.rime) return null;
  return (
    <span className="text-xs text-warning-text" data-testid="voice-not-ready">
      {PHONE_VOICE_PICK_WORDS.notReadyNote}
    </span>
  );
}
